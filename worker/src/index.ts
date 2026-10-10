/**
 * Cloudflare Worker entry point: routing, request validation and background synthesis passes.
 *
 * The HTTP contract is the same as the self-hosted Python backend (`/api/v1`), so the mobile app
 * works against either server without changes.
 */

import { ConfigurationError, createProvider, resolveSettings } from './config';
import { HttpError, internal, misconfigured, notFound, payloadTooLarge, unauthorized, validationFailed } from './errors';
import { JobService } from './service';
import { constantTimeEquals } from './security';
import type { Env, JobView } from './types';

const JOB_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_ACK_ITEMS = 500;
const MAX_POSITION = 100_000;

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-API-Key',
  'Access-Control-Max-Age': '600',
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      return errorResponse(error);
    }
  },

  /** Daily retention sweep: drop expired jobs and audio left behind without a job row. */
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const settings = resolveSettings(env);
    const service = new JobService({ env, settings, tts: createProvider(settings, env) });
    const outcome = await service.purgeExpired();
    console.log('retention sweep', outcome);
  },
};

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const settings = resolveSettings(env);
  const url = new URL(request.url);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;

  if (path === '/' || path === '/health') {
    return html(indexPage(settings));
  }

  const service = new JobService({ env, settings, tts: createProvider(settings, env) });
  const pump = (jobId: string): void => {
    ctx?.waitUntil(service.pump(jobId));
  };

  if (path === '/api/v1/health') {
    return json({ status: 'ok', version: settings.version });
  }

  if (path === '/api/v1/config') {
    const presented = request.headers.get('X-API-Key');
    return json({
      status: 'ok',
      version: settings.version,
      provider: settings.providerName,
      voices: settings.allowedVoices,
      default_voice: settings.defaultVoice,
      requires_api_key: settings.apiKey !== null,
      api_key_ok: settings.apiKey === null || (!!presented && constantTimeEquals(settings.apiKey, presented)),
      max_transcript_chars: settings.maxTranscriptChars,
      sentences_per_chunk_options: [1, 2],
      job_ttl_hours: settings.jobTtlHours,
    });
  }

  if (path === '/api/v1/jobs') {
    if (request.method !== 'POST') {
      return methodNotAllowed();
    }
    requireApiKey(settings, request);
    const body = await readJsonObject(request, settings.maxRequestBytes);
    const input = parseCreateJob(body, settings);
    const { view, token } = await service.createJob(input);
    pump(view.id);
    return json(
      {
        id: view.id,
        status: view.status,
        title: view.title,
        voice: view.voice,
        total_chunks: view.total_chunks,
        warnings: view.warnings,
        expires_at: view.expires_at,
        access_token: token,
      },
      202,
    );
  }

  const statusMatch = path.match(new RegExp(`^/api/v1/jobs/(${JOB_ID})$`));
  if (statusMatch) {
    const jobId = statusMatch[1];
    if (request.method === 'GET') {
      const view = await service.getJob(jobId, bearer(request));
      if (view.status === 'queued' || view.status === 'processing') {
        pump(jobId);
      }
      return json(statusPayload(view));
    }
    if (request.method === 'DELETE') {
      await service.deleteJob(jobId, bearer(request));
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }
    return methodNotAllowed();
  }

  const manifestMatch = path.match(new RegExp(`^/api/v1/jobs/(${JOB_ID})/manifest$`));
  if (manifestMatch) {
    if (request.method !== 'GET') {
      return methodNotAllowed();
    }
    const jobId = manifestMatch[1];
    try {
      const manifest = await service.getManifest(jobId, bearer(request));
      return json({
        job_id: jobId,
        title: manifest.title,
        total_chunks: manifest.total_chunks,
        chunks: manifest.entries.map((entry) => ({
          index: entry.index,
          char_count: entry.char_count,
          content_type: entry.content_type,
          size_bytes: entry.size_bytes,
          sha256: entry.sha256,
          url: `/api/v1/jobs/${jobId}/chunks/${entry.index}`,
        })),
      });
    } catch (error) {
      if (error instanceof HttpError && error.code === 'job_not_ready') {
        pump(jobId);
      }
      throw error;
    }
  }

  const chunkMatch = path.match(new RegExp(`^/api/v1/jobs/(${JOB_ID})/chunks/(\\d+)$`));
  if (chunkMatch) {
    if (request.method !== 'GET') {
      return methodNotAllowed();
    }
    const position = Number.parseInt(chunkMatch[2], 10);
    if (position > MAX_POSITION) {
      throw notFound('Chunk not found.', 'chunk_not_found');
    }
    const chunk = await service.readChunk(chunkMatch[1], bearer(request), position);
    return new Response(chunk.body, {
      status: 200,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': chunk.contentType,
        'Content-Length': String(chunk.sizeBytes),
        'X-Content-SHA256': chunk.sha256,
        'Cache-Control': 'no-store',
      },
    });
  }

  const ackMatch = path.match(new RegExp(`^/api/v1/jobs/(${JOB_ID})/ack$`));
  if (ackMatch) {
    if (request.method !== 'POST') {
      return methodNotAllowed();
    }
    const body = await readJsonObject(request, settings.maxRequestBytes);
    const items = parseAck(body);
    const outcome = await service.acknowledge(ackMatch[1], bearer(request), items);
    return json({
      acknowledged: outcome.acknowledged,
      remaining: outcome.remaining,
      job_deleted: outcome.job_deleted,
    });
  }

  const retryMatch = path.match(new RegExp(`^/api/v1/jobs/(${JOB_ID})/retry$`));
  if (retryMatch) {
    if (request.method !== 'POST') {
      return methodNotAllowed();
    }
    const view = await service.retryJob(retryMatch[1], bearer(request));
    pump(view.id);
    return json(statusPayload(view), 202);
  }

  throw notFound('Unknown endpoint.', 'not_found');
}

// ------------------------------------------------------------------ request helpers

function requireApiKey(settings: ReturnType<typeof resolveSettings>, request: Request): void {
  if (settings.apiKey === null) {
    return;
  }
  const presented = request.headers.get('X-API-Key');
  if (!presented || !constantTimeEquals(settings.apiKey, presented)) {
    throw unauthorized('A valid API key is required to create jobs.');
  }
}

function bearer(request: Request): string {
  const header = request.headers.get('Authorization');
  if (!header) {
    throw unauthorized();
  }
  const space = header.indexOf(' ');
  const scheme = space === -1 ? header : header.slice(0, space);
  const value = space === -1 ? '' : header.slice(space + 1).trim();
  if (scheme.toLowerCase() !== 'bearer' || !value) {
    throw unauthorized();
  }
  return value;
}

async function readJsonObject(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > maxBytes) {
    throw payloadTooLarge(`The request body is larger than ${maxBytes} bytes.`, 'body_too_large');
  }
  const text = await request.text();
  if (text.length > maxBytes) {
    throw payloadTooLarge(`The request body is larger than ${maxBytes} bytes.`, 'body_too_large');
  }
  if (!text.trim()) {
    throw validationFailed('A JSON body is required.', 'invalid_body');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw validationFailed('The body must be valid JSON.', 'invalid_body');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw validationFailed('The body must be a JSON object.', 'invalid_body');
  }
  return parsed as Record<string, unknown>;
}

function parseCreateJob(body: Record<string, unknown>, settings: ReturnType<typeof resolveSettings>) {
  const title = body.title;
  if (typeof title !== 'string' || title.trim().length === 0) {
    throw validationFailed('Title must be a non-empty string.', 'invalid_title');
  }
  if (title.trim().length > 200) {
    throw validationFailed('Keep the title under 200 characters.', 'invalid_title');
  }
  const transcript = body.transcript;
  if (typeof transcript !== 'string' || transcript.trim().length === 0) {
    throw validationFailed('Transcript must be a non-empty string.', 'empty_transcript');
  }
  if (transcript.length > settings.maxTranscriptChars) {
    throw payloadTooLarge(
      `Transcript exceeds the limit of ${settings.maxTranscriptChars} characters.`,
      'transcript_too_long',
    );
  }
  const sentences = body.sentences_per_chunk ?? 2;
  if (sentences !== 1 && sentences !== 2) {
    throw validationFailed('sentences_per_chunk must be 1 or 2.', 'invalid_sentences_per_chunk');
  }
  const voice = body.voice;
  if (voice !== undefined && voice !== null && typeof voice !== 'string') {
    throw validationFailed('voice must be a string.', 'unsupported_voice');
  }
  if (typeof voice === 'string' && voice.length > 100) {
    throw validationFailed('voice must be at most 100 characters.', 'unsupported_voice');
  }
  return {
    title,
    transcript,
    sentencesPerChunk: sentences,
    voice: typeof voice === 'string' ? voice : null,
  };
}

function parseAck(body: Record<string, unknown>): { index: number; sha256: string }[] {
  const chunks = body.chunks;
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw validationFailed('chunks must be a non-empty list.', 'invalid_ack');
  }
  if (chunks.length > MAX_ACK_ITEMS) {
    throw validationFailed(`At most ${MAX_ACK_ITEMS} chunks can be acknowledged at once.`, 'invalid_ack');
  }
  return chunks.map((item) => {
    if (typeof item !== 'object' || item === null) {
      throw validationFailed('Each acknowledged chunk must be an object.', 'invalid_ack');
    }
    const record = item as Record<string, unknown>;
    const index = record.index;
    const sha256 = record.sha256;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index > MAX_POSITION) {
      throw validationFailed('Each chunk needs a non-negative integer index.', 'invalid_ack');
    }
    if (typeof sha256 !== 'string' || !SHA256_HEX.test(sha256)) {
      throw validationFailed('Each chunk needs a lowercase hex sha256.', 'invalid_ack');
    }
    return { index, sha256 };
  });
}

// ------------------------------------------------------------------ responses

function statusPayload(view: JobView) {
  return {
    id: view.id,
    status: view.status,
    title: view.title,
    voice: view.voice,
    total_chunks: view.total_chunks,
    ready_chunks: view.ready_chunks,
    acked_chunks: view.acked_chunks,
    failed_chunks: view.failed_chunks,
    error: view.error,
    warnings: view.warnings,
    created_at: view.created_at,
    expires_at: view.expires_at,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function html(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { ...CORS_HEADERS, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function methodNotAllowed(): Response {
  return json({ error: { code: 'method_not_allowed', message: 'This endpoint does not accept that method.' } }, 405);
}

function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json(error.toJSON(), error.status);
  }
  if (error instanceof ConfigurationError) {
    console.error('configuration error', error.message);
    return json(misconfigured(error.message).toJSON(), 503);
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error('unhandled error', message);
  return json(internal().toJSON(), 500);
}

function indexPage(settings: ReturnType<typeof resolveSettings>): string {
  const voices = settings.allowedVoices.join(', ');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Reavailable API</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0 auto; max-width: 42rem; padding: 2rem 1.25rem; line-height: 1.55; color: #14231f; }
      code { background: #eef3f1; padding: 0.1rem 0.3rem; border-radius: 4px; }
      h1 { font-size: 1.4rem; }
      .ok { color: #1f6f5c; font-weight: 600; }
    </style>
  </head>
  <body>
    <h1>Reavailable speech server</h1>
    <p class="ok">Running. Version ${settings.version}, provider <code>${settings.providerName}</code>.</p>
    <p>This server turns an Uzbek transcript into audio parts for the Reavailable Android app and
       deletes each part again once the phone confirms it has a verified copy.</p>
    <p>Health check: <a href="/api/v1/health"><code>/api/v1/health</code></a></p>
    <p>Voices: <code>${voices}</code> (default <code>${settings.defaultVoice}</code>)</p>
    <p>Enter this address in the app under <strong>Settings &rarr; Server address</strong>.</p>
  </body>
</html>
`;
}
