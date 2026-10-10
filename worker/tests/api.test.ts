/**
 * HTTP-level tests of the whole API against a real (local) D1 database and R2 bucket.
 *
 * Synthesis is driven by calling `pump()` directly instead of relying on `ctx.waitUntil`, so the
 * tests stay deterministic; `tests/service.test.ts` covers the pass budget and failure paths.
 */

import { KvAudioStore } from '../src/audio';
import { SELF, applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createProvider, resolveSettings } from '../src/config';
import { sha256Hex } from '../src/security';
import { JobService } from '../src/service';
import type { Env } from '../src/types';

const testEnv = env as unknown as Env & { TEST_MIGRATIONS: unknown[] };
const ORIGIN = 'https://api.example.test';
const ACCESS_KEY = 'test-api-key';

interface CreatedJob {
  id: string;
  status: string;
  title: string;
  voice: string;
  total_chunks: number;
  warnings: string[];
  expires_at: string;
  access_token: string;
}

interface StatusBody {
  id: string;
  status: string;
  total_chunks: number;
  ready_chunks: number;
  acked_chunks: number;
  failed_chunks: number;
  error: { code: string; message: string } | null;
  warnings: string[];
  created_at: string;
  expires_at: string;
}

interface ManifestBody {
  job_id: string;
  title: string;
  total_chunks: number;
  chunks: { index: number; char_count: number; content_type: string; size_bytes: number; sha256: string; url: string }[];
}

function makeService(overrides: Partial<Env> = {}, tts = undefined): JobService {
  const merged = { ...testEnv, ...overrides } as Env;
  const settings = resolveSettings(merged);
  return new JobService({ env: merged, settings, tts: tts ?? createProvider(settings, merged) });
}

async function createJob(transcript: string, title = 'Test kitob'): Promise<CreatedJob> {
  const response = await SELF.fetch(`${ORIGIN}/api/v1/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': ACCESS_KEY },
    body: JSON.stringify({ title, transcript, sentences_per_chunk: 2 }),
  });
  expect(response.status).toBe(202);
  return (await response.json()) as CreatedJob;
}

async function getStatus(id: string, token: string): Promise<StatusBody> {
  const response = await SELF.fetch(`${ORIGIN}/api/v1/jobs/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as StatusBody;
}

async function getManifest(id: string, token: string): Promise<ManifestBody> {
  const response = await SELF.fetch(`${ORIGIN}/api/v1/jobs/${id}/manifest`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status).toBe(200);
  return (await response.json()) as ManifestBody;
}

/** Create a job and synthesize every part. */
async function readyJob(transcript = "Salom. Bu birinchi gap. Ikkinchi gap ham bor. Uchinchisi ham keldi."): Promise<CreatedJob> {
  const created = await createJob(transcript);
  await makeService().pump(created.id);
  const status = await getStatus(created.id, created.access_token);
  expect(status.status).toBe('ready');
  return created;
}

async function clearStorage(): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare('DELETE FROM chunks'),
    testEnv.DB.prepare('DELETE FROM jobs'),
  ]);
  for (;;) {
    const listed = await new KvAudioStore(testEnv.AUDIO).list({ limit: 1000 });
    if (listed.objects.length === 0) {
      return;
    }
    await new KvAudioStore(testEnv.AUDIO).delete(listed.objects.map((object) => object.key));
    if (!listed.truncated) {
      return;
    }
  }
}

async function storedKeys(): Promise<string[]> {
  const listed = await new KvAudioStore(testEnv.AUDIO).list({ limit: 1000 });
  return listed.objects.map((object) => object.key).sort();
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS as never);
});

beforeEach(async () => {
  await clearStorage();
});

describe('system endpoints', () => {
  it('reports health', async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/v1/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', version: 'test' });
  });

  it('serves a short human readable page at the root', async () => {
    const response = await SELF.fetch(ORIGIN);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/html');
    expect(await response.text()).toContain('Reavailable');
  });

  it('describes the configuration and whether the access key is correct', async () => {
    const withoutKey = await SELF.fetch(`${ORIGIN}/api/v1/config`);
    expect(withoutKey.status).toBe(200);
    const open = (await withoutKey.json()) as Record<string, unknown>;
    expect(open.requires_api_key).toBe(true);
    expect(open.api_key_ok).toBe(false);
    expect(open.voices).toContain('uz-UZ-MadinaNeural');

    const withKey = await SELF.fetch(`${ORIGIN}/api/v1/config`, { headers: { 'X-API-Key': ACCESS_KEY } });
    expect(((await withKey.json()) as Record<string, unknown>).api_key_ok).toBe(true);

    const wrongKey = await SELF.fetch(`${ORIGIN}/api/v1/config`, { headers: { 'X-API-Key': 'nope' } });
    expect(((await wrongKey.json()) as Record<string, unknown>).api_key_ok).toBe(false);
  });

  it('answers preflight requests with CORS headers', async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/v1/jobs`, { method: 'OPTIONS' });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('X-API-Key');
  });

  it('returns a JSON 404 for an unknown endpoint and 405 for a wrong method', async () => {
    const missing = await SELF.fetch(`${ORIGIN}/api/v1/nope`);
    expect(missing.status).toBe(404);
    expect((await missing.json()) as { error: { code: string } }).toEqual({
      error: { code: 'not_found', message: 'Unknown endpoint.' },
    });

    const wrongMethod = await SELF.fetch(`${ORIGIN}/api/v1/jobs`, { method: 'GET' });
    expect(wrongMethod.status).toBe(405);
  });
});

describe('job creation', () => {
  it('refuses to create a job without the access key', async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/v1/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Kitob', transcript: 'Salom.' }),
    });
    expect(response.status).toBe(401);
    expect((await response.json()) as { error: { code: string } }).toEqual({
      error: { code: 'unauthorized', message: 'A valid API key is required to create jobs.' },
    });
  });

  it('refuses a wrong access key', async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/v1/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'wrong' },
      body: JSON.stringify({ title: 'Kitob', transcript: 'Salom.' }),
    });
    expect(response.status).toBe(401);
  });

  it('returns a job id, a one-time access token and the part count', async () => {
    const created = await createJob('Bir. Ikki. Uch. To\'rt.');
    expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(created.access_token.length).toBeGreaterThanOrEqual(40);
    expect(created.status).toBe('queued');
    expect(created.total_chunks).toBe(2);
    expect(created.voice).toBe('fake-uz');
    expect(created.warnings).toEqual([]);

    const rows = await testEnv.DB.prepare('SELECT COUNT(*) AS total FROM chunks WHERE job_id = ?1')
      .bind(created.id)
      .first<{ total: number }>();
    expect(rows?.total).toBe(2);
  });

  it('flags Cyrillic transcripts with a warning', async () => {
    const created = await createJob('Биринчи жумла. Иккинчи жумла.');
    expect(created.warnings).toEqual(['cyrillic_text']);
  });

  it('validates the request body', async () => {
    const post = async (body: unknown): Promise<Response> =>
      SELF.fetch(`${ORIGIN}/api/v1/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': ACCESS_KEY },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });

    expect((await post({ transcript: 'Salom.' })).status).toBe(422);
    expect((await post({ title: '   ', transcript: 'Salom.' })).status).toBe(422);
    expect((await post({ title: 'Kitob' })).status).toBe(422);
    expect((await post({ title: 'Kitob', transcript: '   ' })).status).toBe(422);
    expect((await post({ title: 'Kitob', transcript: 'Salom.', sentences_per_chunk: 3 })).status).toBe(422);
    expect((await post({ title: 'Kitob', transcript: 'Salom.', voice: 'not-a-voice' })).status).toBe(422);
    expect((await post('not json')).status).toBe(422);
    expect((await post([])).status).toBe(422);

    const codes = await post({ title: 'Kitob', transcript: 'Salom.', sentences_per_chunk: 3 });
    expect((await codes.json()) as { error: { code: string } }).toEqual({
      error: { code: 'invalid_sentences_per_chunk', message: 'sentences_per_chunk must be 1 or 2.' },
    });
  });

  it('accepts an explicit allowed voice', async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/v1/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': ACCESS_KEY },
      body: JSON.stringify({ title: 'Kitob', transcript: 'Salom.', voice: 'fake-uz' }),
    });
    expect(response.status).toBe(202);
    expect(((await response.json()) as CreatedJob).voice).toBe('fake-uz');
  });
});

describe('authorization', () => {
  it('requires a bearer token', async () => {
    const created = await createJob('Salom. Dunyo.');
    const response = await SELF.fetch(`${ORIGIN}/api/v1/jobs/${created.id}`);
    expect(response.status).toBe(401);
    expect((await response.json()) as { error: { code: string } }).toEqual({
      error: { code: 'unauthorized', message: 'A bearer token is required.' },
    });
  });

  it('makes an unknown job, a foreign token and an expired job look identical', async () => {
    const created = await createJob('Salom. Dunyo.');
    const foreign = await SELF.fetch(`${ORIGIN}/api/v1/jobs/${created.id}`, {
      headers: { Authorization: 'Bearer somebody-elses-token' },
    });
    expect(foreign.status).toBe(404);
    expect((await foreign.json()) as { error: { code: string } }).toEqual({
      error: { code: 'job_not_found', message: 'Job not found.' },
    });

    const unknownId = '00000000-0000-4000-8000-000000000000';
    const missing = await SELF.fetch(`${ORIGIN}/api/v1/jobs/${unknownId}`, {
      headers: { Authorization: `Bearer ${created.access_token}` },
    });
    expect(missing.status).toBe(404);

    await testEnv.DB.prepare('UPDATE jobs SET expires_at = ?1 WHERE id = ?2')
      .bind('2000-01-01T00:00:00.000Z', created.id)
      .run();
    const expired = await SELF.fetch(`${ORIGIN}/api/v1/jobs/${created.id}`, {
      headers: { Authorization: `Bearer ${created.access_token}` },
    });
    expect(expired.status).toBe(404);
  });
});

describe('synthesis and download', () => {
  it('synthesizes part by part and only then calls the job ready', async () => {
    // Service-level, so no background pass can finish the job between assertions.
    const svc = makeService();
    const { view, token } = await svc.createJob({
      title: 'Test kitob',
      transcript: 'Bir. Ikki. Uch. Tort. Besh. Olti.',
      sentencesPerChunk: 2,
    });
    expect(view.status).toBe('queued');
    expect(view.total_chunks).toBe(3);
    await expect(svc.getManifest(view.id, token)).rejects.toMatchObject({ code: 'job_not_ready' });

    // A pass with a hard cap of one part leaves the job in progress.
    await svc.pump(view.id, { maxChunks: 1 });
    const partial = await svc.getJob(view.id, token);
    expect(partial.status).toBe('processing');
    expect(partial.ready_chunks).toBe(1);
    expect(partial.error).toBeNull();
    await expect(svc.getManifest(view.id, token)).rejects.toMatchObject({ code: 'job_not_ready' });

    // A pass with an exhausted budget stops too, and the next one continues where it left off.
    await svc.pump(view.id, { budgetMs: 0 });
    expect((await svc.getJob(view.id, token)).ready_chunks).toBe(1);

    await svc.pump(view.id);
    const done = await svc.getJob(view.id, token);
    expect(done.status).toBe('ready');
    expect(done.ready_chunks).toBe(3);
    const manifest = await svc.getManifest(view.id, token);
    expect(manifest.entries.map((entry) => entry.index)).toEqual([0, 1, 2]);
  });

  it('answers a manifest request for an unfinished job with 409', async () => {
    const { view, token } = await makeService().createJob({
      title: 'Test kitob',
      transcript: 'Bir. Ikki. Uch.',
      sentencesPerChunk: 2,
    });
    const response = await SELF.fetch(`${ORIGIN}/api/v1/jobs/${view.id}/manifest`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(409);
    expect((await response.json()) as { error: { code: string } }).toEqual({
      error: { code: 'job_not_ready', message: 'The job is not ready yet.' },
    });
  });

  it('reports job status over HTTP', async () => {
    const created = await readyJob();
    const status = await getStatus(created.id, created.access_token);
    expect(status.status).toBe('ready');
    expect(status.total_chunks).toBe(created.total_chunks);
    expect(status.acked_chunks).toBe(0);
    expect(status.failed_chunks).toBe(0);
    expect(status.warnings).toEqual([]);
    expect(status.expires_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it('serves audio with the checksum the device must verify', async () => {
    const created = await readyJob();
    const manifest = await getManifest(created.id, created.access_token);
    expect(manifest.job_id).toBe(created.id);
    expect(manifest.total_chunks).toBe(created.total_chunks);
    expect(manifest.chunks).toHaveLength(created.total_chunks);

    for (const [index, entry] of manifest.chunks.entries()) {
      expect(entry.index).toBe(index);
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.size_bytes).toBeGreaterThan(0);
      expect(entry.char_count).toBeGreaterThan(0);
      expect(entry.content_type).toBe('audio/wav');
      expect(entry.url).toBe(`/api/v1/jobs/${created.id}/chunks/${index}`);

      const response = await SELF.fetch(`${ORIGIN}${entry.url}`, {
        headers: { Authorization: `Bearer ${created.access_token}` },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('X-Content-SHA256')).toBe(entry.sha256);
      expect(response.headers.get('Content-Type')).toBe('audio/wav');
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes.byteLength).toBe(entry.size_bytes);
      expect(await sha256Hex(bytes)).toBe(entry.sha256);
    }

    // The transcript text is gone from the database as soon as audio exists.
    const textRow = await testEnv.DB.prepare('SELECT COUNT(*) AS total FROM chunks WHERE text IS NOT NULL')
      .first<{ total: number }>();
    expect(textRow?.total).toBe(0);
  });

  it('never sends transcript text in the manifest', async () => {
    const created = await readyJob('Maxfiy so\'z bor. Ikkinchi gap.');
    const response = await SELF.fetch(`${ORIGIN}/api/v1/jobs/${created.id}/manifest`, {
      headers: { Authorization: `Bearer ${created.access_token}` },
    });
    const raw = await response.text();
    expect(raw).not.toContain('Maxfiy');
  });

  it('reports an unknown part as missing', async () => {
    const created = await readyJob();
    const response = await SELF.fetch(`${ORIGIN}/api/v1/jobs/${created.id}/chunks/99`, {
      headers: { Authorization: `Bearer ${created.access_token}` },
    });
    expect(response.status).toBe(404);
    expect((await response.json()) as { error: { code: string } }).toEqual({
      error: { code: 'chunk_not_found', message: 'Chunk not found.' },
    });
  });
});

describe('acknowledgement deletes server audio', () => {
  it('rejects a wrong checksum and changes nothing', async () => {
    const created = await readyJob();
    const manifest = await getManifest(created.id, created.access_token);
    const response = await SELF.fetch(`${ORIGIN}/api/v1/jobs/${created.id}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${created.access_token}` },
      body: JSON.stringify({ chunks: [{ index: 0, sha256: 'a'.repeat(64) }] }),
    });
    expect(response.status).toBe(409);
    expect((await response.json()) as { error: { code: string } }).toEqual({
      error: { code: 'checksum_mismatch', message: 'Checksum mismatch for chunk 0.' },
    });

    // Nothing was released: the first part still downloads and the manifest is unchanged.
    const again = await SELF.fetch(`${ORIGIN}/api/v1/jobs/${created.id}/chunks/0`, {
      headers: { Authorization: `Bearer ${created.access_token}` },
    });
    expect(again.status).toBe(200);
    const unchanged = await getManifest(created.id, created.access_token);
    expect(unchanged.chunks).toHaveLength(manifest.chunks.length);
  });

  it('deletes audio part by part and the whole job once everything is confirmed', async () => {
    const created = await readyJob('Bir. Ikki. Uch. Tort.');
    const manifest = await getManifest(created.id, created.access_token);
    expect(manifest.chunks).toHaveLength(2);
    const keysBefore = await storedKeys();
    expect(keysBefore).toHaveLength(2);

    const first = await SELF.fetch(`${ORIGIN}/api/v1/jobs/${created.id}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${created.access_token}` },
      body: JSON.stringify({ chunks: [{ index: 0, sha256: manifest.chunks[0].sha256 }] }),
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ acknowledged: [0], remaining: 1, job_deleted: false });

    expect(await storedKeys()).toEqual(keysBefore.slice(1));
    const gone = await SELF.fetch(`${ORIGIN}/api/v1/jobs/${created.id}/chunks/0`, {
      headers: { Authorization: `Bearer ${created.access_token}` },
    });
    expect(gone.status).toBe(404);
    expect((await gone.json()) as { error: { code: string } }).toEqual({
      error: { code: 'chunk_unavailable', message: 'The chunk is not available for download.' },
    });

    // The manifest lists only what is still downloadable.
    const partial = await getManifest(created.id, created.access_token);
    expect(partial.chunks.map((chunk) => chunk.index)).toEqual([1]);
    expect(partial.total_chunks).toBe(2);

    // Repeating the same acknowledgement is harmless.
    const repeat = await SELF.fetch(`${ORIGIN}/api/v1/jobs/${created.id}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${created.access_token}` },
      body: JSON.stringify({ chunks: [{ index: 0, sha256: manifest.chunks[0].sha256 }] }),
    });
    expect(repeat.status).toBe(200);
    expect(((await repeat.json()) as { remaining: number }).remaining).toBe(1);

    const rest = await SELF.fetch(`${ORIGIN}/api/v1/jobs/${created.id}/ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${created.access_token}` },
      body: JSON.stringify({
        chunks: [
          { index: 0, sha256: manifest.chunks[0].sha256 },
          { index: 1, sha256: manifest.chunks[1].sha256 },
        ],
      }),
    });
    expect(rest.status).toBe(200);
    expect(await rest.json()).toEqual({ acknowledged: [0, 1], remaining: 0, job_deleted: true });

    expect(await storedKeys()).toEqual([]);
    const afterDelete = await SELF.fetch(`${ORIGIN}/api/v1/jobs/${created.id}`, {
      headers: { Authorization: `Bearer ${created.access_token}` },
    });
    expect(afterDelete.status).toBe(404);
    const jobs = await testEnv.DB.prepare('SELECT COUNT(*) AS total FROM jobs').first<{ total: number }>();
    expect(jobs?.total).toBe(0);
  });

  it('validates acknowledgement bodies', async () => {
    const created = await readyJob();
    const post = async (body: unknown): Promise<Response> =>
      SELF.fetch(`${ORIGIN}/api/v1/jobs/${created.id}/ack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${created.access_token}` },
        body: JSON.stringify(body),
      });

    expect((await post({})).status).toBe(422);
    expect((await post({ chunks: [] })).status).toBe(422);
    expect((await post({ chunks: [{ index: 0 }] })).status).toBe(422);
    expect((await post({ chunks: [{ index: -1, sha256: 'a'.repeat(64) }] })).status).toBe(422);
    expect((await post({ chunks: [{ index: 0, sha256: 'A'.repeat(64) }] })).status).toBe(422);
    expect((await post({ chunks: Array.from({ length: 501 }, (_, index) => ({ index, sha256: 'a'.repeat(64) })) })).status).toBe(422);
  });
});

describe('owner deletion', () => {
  it('removes the job and all of its audio', async () => {
    const created = await readyJob();
    expect((await storedKeys()).length).toBeGreaterThan(0);

    const response = await SELF.fetch(`${ORIGIN}/api/v1/jobs/${created.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${created.access_token}` },
    });
    expect(response.status).toBe(204);
    expect(await storedKeys()).toEqual([]);

    const status = await SELF.fetch(`${ORIGIN}/api/v1/jobs/${created.id}`, {
      headers: { Authorization: `Bearer ${created.access_token}` },
    });
    expect(status.status).toBe(404);
  });
});
