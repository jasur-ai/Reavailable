/**
 * Typed HTTP client for the Offline Audiobook Reader backend (API v1).
 *
 * The transport is injected, so the client can be tested without a network and the app can
 * supply the platform fetch implementation.
 */

export interface ResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface RequestInitLike {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type FetchLike = (url: string, init: RequestInitLike) => Promise<ResponseLike>;

/** The server answered with an error status. `code` is the server's machine-readable code. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

/** The request never produced a usable answer: no connection, DNS failure or timeout. */
export class NetworkError extends Error {
  readonly timedOut: boolean;

  constructor(message: string, timedOut = false) {
    super(message);
    this.name = 'NetworkError';
    this.timedOut = timedOut;
  }
}

export interface JobCreatedDto {
  id: string;
  status: string;
  title: string;
  voice: string;
  total_chunks: number;
  warnings: string[];
  expires_at: string;
  access_token: string;
}

export interface JobStatusDto {
  id: string;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  title: string;
  voice: string;
  total_chunks: number;
  ready_chunks: number;
  acked_chunks: number;
  failed_chunks: number;
  error: { code: string; message: string } | null;
  warnings: string[];
  created_at: string;
  expires_at: string;
}

export interface ManifestChunkDto {
  index: number;
  /** Size of the part's text only. The server never sends the transcript text. */
  char_count: number;
  content_type: string;
  size_bytes: number;
  sha256: string;
  url: string;
}

export interface ManifestDto {
  job_id: string;
  title: string;
  total_chunks: number;
  chunks: ManifestChunkDto[];
}

export interface AckResultDto {
  acknowledged: number[];
  remaining: number;
  job_deleted: boolean;
}

export interface DownloadedChunk {
  bytes: Uint8Array;
  /** Value of the X-Content-SHA256 header, if the server sent one. */
  sha256Header: string | null;
  contentType: string | null;
}

export interface CreateJobInput {
  title: string;
  transcript: string;
  sentencesPerChunk: 1 | 2;
  voice?: string;
}

/** What a server reports about itself on GET /api/v1/config. The Worker backend serves it. */
export interface ServerConfigDto {
  status: string;
  version: string;
  provider: string;
  voices: string[];
  default_voice: string;
  requires_api_key: boolean;
  /** True when the server accepted the access key sent with this request. */
  api_key_ok: boolean;
  max_transcript_chars: number;
  sentences_per_chunk_options: number[];
  job_ttl_hours: number;
}

export interface ApiClientOptions {
  baseUrl: string;
  apiKey?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('The server address must be a full URL, for example http://192.168.1.20:8000');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('The server address must start with http:// or https://');
  }
  if (url.search || url.hash) {
    throw new Error('The server address must not contain a query string or a fragment.');
  }
  return trimmed;
}

interface RequestOptions {
  token?: string;
  body?: unknown;
  headers?: Record<string, string>;
  accept?: string;
}

/** Reads a response body. Runs inside the request timeout, so a stalled body is cut off too. */
type BodyReader<T> = (response: ResponseLike) => Promise<T>;

export class ApiClient {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: ApiClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetch ?? defaultFetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  health(): Promise<{ status: string; version: string }> {
    return this.exchange('GET', '/health', {}, readJson<{ status: string; version: string }>());
  }

  /**
   * Reads the server configuration: provider, voices, and whether the access key was accepted.
   * A backend without this endpoint answers 404, which callers treat as "older server".
   */
  config(): Promise<ServerConfigDto> {
    // The key travels with this request so the server can tell the app whether it was accepted.
    return this.exchange('GET', '/config', { headers: this.keyHeaders() }, readJson<unknown>()).then(parseServerConfig);
  }

  /** The access key header, when one is configured. */
  private keyHeaders(): Record<string, string> {
    return this.apiKey ? { 'X-API-Key': this.apiKey } : {};
  }

  createJob(input: CreateJobInput): Promise<JobCreatedDto> {
    const body: Record<string, unknown> = {
      title: input.title,
      transcript: input.transcript,
      sentences_per_chunk: input.sentencesPerChunk,
    };
    if (input.voice) {
      body.voice = input.voice;
    }
    return this.exchange('POST', '/jobs', { body, headers: this.keyHeaders() }, readJson<unknown>()).then(parseJobCreated);
  }

  getJob(jobId: string, token: string): Promise<JobStatusDto> {
    return this.exchange('GET', `/jobs/${jobId}`, { token }, readJson<unknown>()).then(parseJobStatus);
  }

  getManifest(jobId: string, token: string): Promise<ManifestDto> {
    return this.exchange('GET', `/jobs/${jobId}/manifest`, { token }, readJson<unknown>()).then(parseManifest);
  }

  downloadChunk(jobId: string, token: string, index: number): Promise<DownloadedChunk> {
    return this.exchange('GET', `/jobs/${jobId}/chunks/${index}`, { token, accept: 'audio/*' }, async (response) => {
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        bytes,
        sha256Header: response.headers.get('X-Content-SHA256'),
        contentType: response.headers.get('Content-Type'),
      };
    });
  }

  acknowledge(
    jobId: string,
    token: string,
    items: readonly { index: number; sha256: string }[],
  ): Promise<AckResultDto> {
    const body = { chunks: items.map((item) => ({ index: item.index, sha256: item.sha256 })) };
    return this.exchange('POST', `/jobs/${jobId}/ack`, { token, body }, readJson<unknown>()).then(parseAck);
  }

  retryJob(jobId: string, token: string): Promise<JobStatusDto> {
    return this.exchange('POST', `/jobs/${jobId}/retry`, { token }, readJson<unknown>()).then(parseJobStatus);
  }

  async deleteJob(jobId: string, token: string): Promise<void> {
    await this.exchange('DELETE', `/jobs/${jobId}`, { token }, async () => undefined);
  }

  /**
   * Sends one request and reads its body, all under one timeout. Errors are normalized to
   * ApiError (the server answered with a problem) or NetworkError (no usable answer).
   */
  private async exchange<T>(method: string, path: string, options: RequestOptions, read: BodyReader<T>): Promise<T> {
    const headers: Record<string, string> = { Accept: options.accept ?? 'application/json', ...options.headers };
    if (options.token) {
      headers.Authorization = `Bearer ${options.token}`;
    }
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      let response: ResponseLike;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/api/v1${path}`, {
          method,
          headers,
          body,
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted) {
          throw new NetworkError('The request timed out.', true);
        }
        const reason = error instanceof Error ? error.message : 'unknown error';
        throw new NetworkError(`The request could not reach the server (${reason}).`);
      }

      if (!response.ok) {
        throw await toApiError(response);
      }
      return await read(response);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new NetworkError('The request timed out.', true);
      }
      if (error instanceof ApiError || error instanceof NetworkError) {
        throw error;
      }
      throw new NetworkError('The connection was interrupted while reading the response.');
    } finally {
      clearTimeout(timer);
    }
  }
}

function readJson<T>(): BodyReader<T> {
  return async (response) => {
    try {
      return (await response.json()) as T;
    } catch {
      throw new ApiError(response.status, 'invalid_response', 'The server returned an unexpected response.');
    }
  };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function numberList(value: unknown): number[] {
  return Array.isArray(value) ? value.filter((item): item is number => typeof item === 'number') : [];
}

/** Accepts a configuration with missing fields instead of failing: the caller decides what matters. */
function parseServerConfig(value: unknown): ServerConfigDto {
  if (!isRecord(value) || typeof value.status !== 'string') {
    throw invalid('configuration');
  }
  const voices = stringList(value.voices);
  const options = numberList(value.sentences_per_chunk_options);
  return {
    status: value.status,
    version: typeof value.version === 'string' ? value.version : 'unknown',
    provider: typeof value.provider === 'string' ? value.provider : 'unknown',
    voices,
    default_voice: typeof value.default_voice === 'string' ? value.default_voice : (voices[0] ?? ''),
    requires_api_key: value.requires_api_key === true,
    api_key_ok: value.api_key_ok === true,
    max_transcript_chars: typeof value.max_transcript_chars === 'number' ? value.max_transcript_chars : 0,
    sentences_per_chunk_options: options.length > 0 ? options : [1, 2],
    job_ttl_hours: typeof value.job_ttl_hours === 'number' ? value.job_ttl_hours : 0,
  };
}

async function toApiError(response: ResponseLike): Promise<ApiError> {
  let code = `http_${response.status}`;
  let message = `The server answered with HTTP ${response.status}.`;
  try {
    const payload = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
    if (typeof payload.error?.code === 'string') {
      code = payload.error.code;
    }
    if (typeof payload.error?.message === 'string') {
      message = payload.error.message;
    }
  } catch {
    // Non-JSON error bodies keep the generic code and message.
  }
  return new ApiError(response.status, code, message);
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

function invalid(what: string): ApiError {
  return new ApiError(502, 'invalid_response', `The server returned an unexpected ${what}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseJobCreated(raw: unknown): JobCreatedDto {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.access_token !== 'string') {
    throw invalid('job response');
  }
  return raw as unknown as JobCreatedDto;
}

function parseJobStatus(raw: unknown): JobStatusDto {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.status !== 'string') {
    throw invalid('job status');
  }
  return raw as unknown as JobStatusDto;
}

function parseAck(raw: unknown): AckResultDto {
  if (!isRecord(raw) || typeof raw.job_deleted !== 'boolean') {
    throw invalid('acknowledgement');
  }
  return raw as unknown as AckResultDto;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function parseManifest(raw: unknown): ManifestDto {
  if (!isRecord(raw) || !Array.isArray(raw.chunks) || typeof raw.total_chunks !== 'number') {
    throw invalid('manifest');
  }
  for (const chunk of raw.chunks as unknown[]) {
    if (
      !isRecord(chunk) ||
      typeof chunk.index !== 'number' ||
      typeof chunk.sha256 !== 'string' ||
      !SHA256_HEX.test(chunk.sha256) ||
      typeof chunk.size_bytes !== 'number' ||
      typeof chunk.content_type !== 'string'
    ) {
      throw invalid('manifest entry');
    }
  }
  return raw as unknown as ManifestDto;
}
