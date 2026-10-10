/**
 * Rules of the job service: failures, retries, the synthesis lease, limits and retention.
 *
 * These run against the real local D1 and R2, with speech providers injected so failure paths are
 * deterministic.
 */

import { KvAudioStore } from '../src/audio';
import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolveSettings } from '../src/config';
import { JobStore } from '../src/db';
import { HttpError } from '../src/errors';
import { ERROR_MESSAGES, JobService } from '../src/service';
import { TtsError, createFakeProvider, type SynthesisResult, type TtsProvider } from '../src/tts';
import type { Env } from '../src/types';

const testEnv = env as unknown as Env & { TEST_MIGRATIONS: unknown[] };

function serviceWith(tts: TtsProvider, overrides: Partial<Env> = {}, now?: () => number): JobService {
  const merged = { ...testEnv, ...overrides } as Env;
  const settings = resolveSettings(merged);
  return new JobService({ env: merged, settings, tts, now });
}

function provider(synthesize: (text: string, voice: string) => Promise<SynthesisResult>): TtsProvider {
  return { name: 'test', allowedVoices: ['fake-uz', 'uz-UZ-MadinaNeural'], synthesize };
}

const okProvider = createFakeProvider();

async function newJob(service: JobService, transcript: string, title = 'Test kitob') {
  return service.createJob({ title, transcript, sentencesPerChunk: 2 });
}

async function storedKeys(): Promise<string[]> {
  const listed = await new KvAudioStore(testEnv.AUDIO).list({ limit: 1000 });
  return listed.objects.map((object) => object.key).sort();
}

beforeAll(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS as never);
});

beforeEach(async () => {
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
});

describe('validation', () => {
  it('rejects a blank or over-long title', async () => {
    const service = serviceWith(okProvider);
    await expect(newJob(service, 'Salom.', '   ')).rejects.toMatchObject({ code: 'invalid_title' });
    await expect(newJob(service, 'Salom.', '')).rejects.toBeInstanceOf(HttpError);

    const long = await newJob(service, 'Salom.', `Kitob ${'u'.repeat(400)}`);
    const row = await testEnv.DB.prepare('SELECT title FROM jobs WHERE id = ?1')
      .bind(long.view.id)
      .first<{ title: string }>();
    expect(row?.title).toHaveLength(200);
  });

  it('rejects an empty transcript', async () => {
    const service = serviceWith(okProvider);
    await expect(newJob(service, '   \n\n ')).rejects.toMatchObject({
      code: 'empty_transcript',
      status: 422,
    });
  });

  it('rejects a transcript longer than the configured limit', async () => {
    const service = serviceWith(okProvider, { MAX_TRANSCRIPT_CHARS: '20' });
    await expect(newJob(service, 'a'.repeat(21))).rejects.toMatchObject({
      code: 'transcript_too_long',
      status: 413,
    });
  });

  it('rejects a transcript that would produce too many parts', async () => {
    const service = serviceWith(okProvider, { MAX_CHUNKS_PER_JOB: '2' });
    await expect(newJob(service, 'Bir. Ikki. Uch. Tort. Besh.')).rejects.toMatchObject({
      code: 'too_many_chunks',
      status: 422,
    });
  });

  it('rejects a voice the server does not offer', async () => {
    const service = serviceWith(okProvider);
    await expect(
      service.createJob({ title: 'Kitob', transcript: 'Salom.', sentencesPerChunk: 2, voice: 'en-US-Jenny' }),
    ).rejects.toMatchObject({ code: 'unsupported_voice' });
  });

  it('uses the configured default voice', async () => {
    const madina = provider((text) => okProvider.synthesize(text, 'fake-uz'));
    const service = serviceWith(madina, { DEFAULT_VOICE: 'uz-UZ-MadinaNeural' });
    const { view } = await newJob(service, 'Salom.');
    expect(view.voice).toBe('uz-UZ-MadinaNeural');
  });
});

describe('synthesis failures', () => {
  it('fails the job on a permanent error and keeps the text for a retry', async () => {
    const failing = provider(async () => {
      throw new TtsError('tts_bad_request', 'rejected', false);
    });
    const service = serviceWith(failing);
    const { view, token } = await newJob(service, 'Bir. Ikki. Uch. Tort.');

    await service.pump(view.id);
    const after = await service.getJob(view.id, token);
    expect(after.status).toBe('failed');
    expect(after.error).toEqual({ code: 'tts_bad_request', message: ERROR_MESSAGES.tts_bad_request });
    expect(after.failed_chunks).toBeGreaterThan(0);

    // The transcript of a failed part survives so a retry can synthesize it again.
    const kept = await testEnv.DB.prepare('SELECT COUNT(*) AS total FROM chunks WHERE text IS NOT NULL')
      .first<{ total: number }>();
    expect(kept?.total).toBe(2);

    await expect(service.retryJob(view.id, token)).resolves.toMatchObject({ status: 'queued' });
    const requeued = await testEnv.DB.prepare("SELECT COUNT(*) AS total FROM chunks WHERE status = 'pending'")
      .first<{ total: number }>();
    expect(requeued?.total).toBe(2);

    // With a working provider the retry finishes the job, reusing the stored text.
    const healthy = serviceWith(okProvider);
    await healthy.pump(view.id);
    const done = await healthy.getJob(view.id, token);
    expect(done.status).toBe('ready');
    expect(done.error).toBeNull();
    expect(done.ready_chunks).toBe(2);
    expect((await storedKeys()).length).toBe(2);
  });

  it('retries a transient error and then succeeds', async () => {
    let calls = 0;
    const flaky = provider(async (text) => {
      calls += 1;
      if (calls === 1) {
        throw new TtsError('tts_unavailable', 'throttled', true);
      }
      return okProvider.synthesize(text, 'fake-uz');
    });
    const service = serviceWith(flaky, { TTS_RETRY_BASE_DELAY_MS: '0' });
    const { view, token } = await newJob(service, 'Salom.');
    await service.pump(view.id);
    const done = await service.getJob(view.id, token);
    expect(done.status).toBe('ready');
    expect(calls).toBe(2);

    const attempts = await testEnv.DB.prepare('SELECT attempts FROM chunks WHERE job_id = ?1 AND position = 0')
      .bind(view.id)
      .first<{ attempts: number }>();
    expect(attempts?.attempts).toBe(2);
  });

  it('gives up after the configured number of attempts', async () => {
    let calls = 0;
    const alwaysBusy = provider(async () => {
      calls += 1;
      throw new TtsError('tts_unavailable', 'throttled', true);
    });
    const service = serviceWith(alwaysBusy, { TTS_RETRY_BASE_DELAY_MS: '0', TTS_MAX_ATTEMPTS: '3' });
    const { view, token } = await newJob(service, 'Salom.');
    await service.pump(view.id);
    expect((await service.getJob(view.id, token)).status).toBe('failed');
    expect((await service.getJob(view.id, token)).error?.code).toBe('tts_unavailable');
    expect(calls).toBe(3);
  });

  it('maps an unexpected provider error to internal_error', async () => {
    const broken = provider(async () => {
      throw new Error('boom');
    });
    const service = serviceWith(broken);
    const { view, token } = await newJob(service, 'Salom.');
    await service.pump(view.id);
    const failed = await service.getJob(view.id, token);
    expect(failed.status).toBe('failed');
    expect(failed.error).toEqual({ code: 'internal_error', message: ERROR_MESSAGES.internal_error });
  });

  it('refuses to retry a job that did not fail', async () => {
    const service = serviceWith(okProvider);
    const { view, token } = await newJob(service, 'Salom.');
    await service.pump(view.id);
    await expect(service.retryJob(view.id, token)).rejects.toMatchObject({ code: 'job_not_failed' });
  });

  it('treats empty audio as a transient failure', async () => {
    let calls = 0;
    const empty = provider(async () => {
      calls += 1;
      return { audio: new Uint8Array(0), contentType: 'audio/wav', extension: 'wav' };
    });
    const service = serviceWith(empty, { TTS_RETRY_BASE_DELAY_MS: '0', TTS_MAX_ATTEMPTS: '2' });
    const { view, token } = await newJob(service, 'Salom.');
    await service.pump(view.id);
    expect((await service.getJob(view.id, token)).status).toBe('failed');
    expect(calls).toBe(2);
  });
});

describe('the synthesis lease', () => {
  it('lets only one pass work on a job at a time', async () => {
    const service = serviceWith(okProvider);
    const { view } = await newJob(service, 'Bir. Ikki. Uch. Tort.');
    const store = new JobStore(testEnv.DB);
    const now = new Date().toISOString();
    const later = new Date(Date.now() + 60_000).toISOString();

    expect(await store.claimLease(view.id, later, now)).toBe(true);
    expect(await store.claimLease(view.id, later, now)).toBe(false);

    // A pass cannot start while the lease is held, so no audio appears.
    await service.pump(view.id);
    expect(await storedKeys()).toEqual([]);

    // Once the lease expires, the next pass takes over.
    const past = new Date(Date.now() - 1_000).toISOString();
    await testEnv.DB.prepare('UPDATE jobs SET lease_until = ?1 WHERE id = ?2').bind(past, view.id).run();
    await service.pump(view.id);
    expect((await storedKeys()).length).toBe(2);
  });

  it('does not touch a job that is already finished', async () => {
    const service = serviceWith(okProvider);
    const { view, token } = await newJob(service, 'Salom.');
    await service.pump(view.id);
    expect((await service.getJob(view.id, token)).status).toBe('ready');

    const keys = await storedKeys();
    await service.pump(view.id);
    expect(await storedKeys()).toEqual(keys);
    expect((await service.getJob(view.id, token)).status).toBe('ready');
  });

  it('pumping an unknown job is a no-op', async () => {
    const service = serviceWith(okProvider);
    await expect(service.pump('00000000-0000-4000-8000-000000000000')).resolves.toBeUndefined();
  });
});

describe('acknowledgement rules', () => {
  it('rejects a part that was never synthesized', async () => {
    const service = serviceWith(okProvider);
    const { view, token } = await newJob(service, 'Bir. Ikki. Uch. Tort.');
    await service.pump(view.id);
    await expect(
      service.acknowledge(view.id, token, [{ index: 42, sha256: 'a'.repeat(64) }]),
    ).rejects.toMatchObject({ code: 'chunk_not_found' });
  });

  it('rejects a part that is not ready', async () => {
    const service = serviceWith(okProvider);
    const { view, token } = await newJob(service, 'Bir. Ikki. Uch. Tort.');
    await service.pump(view.id);
    // A part that fell back to pending (for example after an interrupted migration) must not be
    // acknowledged, because there is no audio the device could have verified.
    await testEnv.DB.prepare("UPDATE chunks SET status = 'pending' WHERE job_id = ?1 AND position = 1")
      .bind(view.id)
      .run();
    const manifest = await service.getManifest(view.id, token);
    const first = manifest.entries[0];
    await expect(
      service.acknowledge(view.id, token, [{ index: 1, sha256: first.sha256 }]),
    ).rejects.toMatchObject({ code: 'chunk_not_ready' });
  });

  it('refuses acknowledgement while the job is still in progress', async () => {
    const service = serviceWith(okProvider);
    const { view, token } = await newJob(service, 'Bir. Ikki. Uch. Tort.');
    await service.pump(view.id, { maxChunks: 1 });
    await expect(
      service.acknowledge(view.id, token, [{ index: 0, sha256: 'a'.repeat(64) }]),
    ).rejects.toMatchObject({ code: 'job_not_ready' });
  });
});

describe('retention', () => {
  it('removes expired jobs and audio left behind without a job row', async () => {
    let current = Date.parse('2026-05-01T00:00:00.000Z');
    const service = serviceWith(okProvider, {}, () => current);
    const { view, token } = await newJob(service, 'Bir. Ikki. Uch. Tort.');
    await service.pump(view.id);
    expect((await storedKeys()).length).toBe(2);

    // An object whose job row is gone (for example a pass that outlived a deletion).
    await new KvAudioStore(testEnv.AUDIO).put('11111111-1111-4111-8111-111111111111/000000.wav', new Uint8Array([1, 2, 3]));

    // Still inside the TTL.
    expect(await service.purgeExpired()).toEqual({ expired: 0, orphaned: 1 });
    expect(await service.getJob(view.id, token)).toMatchObject({ status: 'ready' });

    // Past the TTL.
    current = Date.parse('2026-06-01T00:00:00.000Z');
    expect(await service.purgeExpired()).toEqual({ expired: 1, orphaned: 0 });
    expect(await storedKeys()).toEqual([]);
    const jobs = await testEnv.DB.prepare('SELECT COUNT(*) AS total FROM jobs').first<{ total: number }>();
    expect(jobs?.total).toBe(0);
  });

  it('hides an expired job from its owner even before the sweep runs', async () => {
    let current = Date.parse('2026-05-01T00:00:00.000Z');
    const service = serviceWith(okProvider, { JOB_TTL_HOURS: '1' }, () => current);
    const { view, token } = await newJob(service, 'Salom.');
    await service.pump(view.id);
    current = Date.parse('2026-05-01T02:00:00.000Z');
    await expect(service.getJob(view.id, token)).rejects.toMatchObject({ code: 'job_not_found' });
  });
});
