/**
 * End-to-end check of the offline contract against a running backend.
 *
 * Opt-in: set E2E_API_BASE_URL (for example http://127.0.0.1:8000). Without it the suite is skipped,
 * so `npm test` never needs a server. The backend can use the fake speech provider.
 *
 * Covers the plan's roadmap step 5: sync, disconnect, verify.
 *  - sync: the book is downloaded, every part is checked against its SHA-256, acknowledged, and the
 *    server copy is removed only after that;
 *  - disconnect: the device restarts with no network at all and must not contact the server;
 *  - verify: playback runs through every part from the files on the device.
 */

import { createHash } from 'node:crypto';
import { ApiClient, ApiError, NetworkError, type FetchLike, type ResponseLike } from '../../src/core/api/client';
import { Library } from '../../src/core/library/library';
import { PlaybackController } from '../../src/core/playback/playbackController';
import { SyncEngine, type SyncApi } from '../../src/core/sync/syncEngine';
import type { BookRecord } from '../../src/core/types';
import { createTranslator } from '../../src/i18n';
import { FakePlayer, settle } from '../unit/support/fakePlayer';
import { MemoryAudioStore, MemoryPersistence, MemoryTokenVault, sha256 } from '../unit/support/memory';

const BASE_URL = process.env.E2E_API_BASE_URL?.trim() ?? '';
const describeLive = BASE_URL ? describe : describe.skip;

const TRANSCRIPT = [
  'Birinchi jumla. Bu oflayn test uchun qisqa matn.',
  'Ikkinchi jumla. Qurilmada ijro etiladi.',
  'Uchinchi jumla. Serverdagi nusxa tasdiqdan keyin o‘chiriladi.',
].join('\n\n');

interface Device {
  library: Library;
  audio: MemoryAudioStore;
  tokens: MemoryTokenVault;
  persistence: MemoryPersistence;
  sync: SyncEngine;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, label: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for: ${label}`);
    }
    await sleep(50);
  }
}

function createDevice(clientFor: (baseUrl: string) => SyncApi): Device {
  const persistence = new MemoryPersistence();
  const library = new Library(persistence);
  const audio = new MemoryAudioStore();
  const tokens = new MemoryTokenVault();
  const sync = new SyncEngine({
    library,
    audio,
    tokens,
    hash: sha256,
    clientFor,
    sleep,
    options: { retryBaseDelayMs: 50, pollIntervalMs: 200, pollTimeoutMs: 120_000 },
    // The same wiring the app uses: notes follow the interface language (Uzbek by default).
    translate: () => createTranslator(library.settings().language),
  });
  return { library, audio, tokens, persistence, sync };
}

function bookOf(device: Device, bookId: string): BookRecord {
  const book = device.library.book(bookId);
  if (!book) {
    throw new Error(`book ${bookId} is missing on the device`);
  }
  return book;
}

/** A device with no connection: every server call fails and is recorded. */
function offlineClient(calls: string[]): SyncApi {
  const unreachable =
    (name: string) =>
    async (): Promise<never> => {
      calls.push(name);
      throw new NetworkError('The request could not reach the server (offline).');
    };
  return {
    baseUrl: BASE_URL,
    createJob: unreachable('createJob'),
    getJob: unreachable('getJob'),
    getManifest: unreachable('getManifest'),
    downloadChunk: unreachable('downloadChunk'),
    acknowledge: unreachable('acknowledge'),
    retryJob: unreachable('retryJob'),
    deleteJob: unreachable('deleteJob'),
  };
}

describeLive('offline audiobook contract (live backend)', () => {
  it('reports a healthy server, and its configuration when the server has one', async () => {
    const client = new ApiClient({ baseUrl: BASE_URL });
    const health = await client.health();
    expect(health.status).toBe('ok');

    try {
      const config = await client.config();
      expect(config.status).toBe('ok');
      expect(config.voices.length).toBeGreaterThan(0);
      expect(config.default_voice.length).toBeGreaterThan(0);
      expect(config.max_transcript_chars).toBeGreaterThan(0);
    } catch (error) {
      // The reference Python backend has no /config endpoint; a 404 is the expected answer there.
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).status).toBe(404);
    }
  });

  it('syncs a book, verifies every part, removes the server copy, and plays it offline', async () => {
    const api = new ApiClient({ baseUrl: BASE_URL });
    const device = createDevice(() => api);

    // 1. Sync: upload, wait for synthesis, download, verify, store, acknowledge.
    const created = await device.sync.submit({
      apiBaseUrl: BASE_URL,
      title: 'Offline e2e',
      transcript: TRANSCRIPT,
      sentencesPerChunk: 1,
    });
    const bookId = created.id;
    await waitFor(() => {
      const book = device.library.book(bookId);
      return book?.status === 'ready' && book.serverReleased;
    }, 'book ready and server copy released');

    const synced = bookOf(device, bookId);
    expect(synced.chunks.length).toBeGreaterThan(0);
    expect(synced.chunks.length).toBe(synced.totalChunks);
    for (const chunk of synced.chunks) {
      expect(chunk).toMatchObject({ state: 'stored', acked: true });
      const bytes = device.audio.files.get(chunk.file ?? '');
      expect(bytes).toBeDefined();
      expect(createHash('sha256').update(bytes ?? new Uint8Array()).digest('hex')).toBe(chunk.sha256);
    }
    expect(device.audio.files.size).toBe(synced.chunks.length);

    // The server deleted the job only after every part was acknowledged.
    const token = await device.tokens.load(bookId);
    expect(token).not.toBeNull();
    await expect(api.getJob(bookId, token ?? '')).rejects.toMatchObject({ status: 404, code: 'job_not_found' });

    // 2. Disconnect: restart the app with the saved library and no connection.
    const calls: string[] = [];
    const reopened = new Library(device.persistence);
    await reopened.load();
    const offline = new SyncEngine({
      library: reopened,
      audio: device.audio,
      tokens: device.tokens,
      hash: sha256,
      clientFor: () => offlineClient(calls),
      sleep,
      options: { retryBaseDelayMs: 50, pollIntervalMs: 200 },
    });
    offline.resumeAll();
    await sleep(100);
    expect(calls).toEqual([]);

    // 3. Verify: playback runs through every part, in order, from the device's own files.
    const player = new FakePlayer();
    const playback = new PlaybackController({
      player,
      library: reopened,
      audio: device.audio,
      finishedGuardMs: 0,
    });
    await playback.open(bookId);
    await playback.play();
    const total = synced.chunks.length;
    // Each part ends once; the end of the last part finishes the book.
    for (let part = 0; part < total; part += 1) {
      player.finish();
      await settle();
    }
    expect(playback.getSnapshot()).toMatchObject({ status: 'finished', index: total - 1 });
    const expectedUris = [...synced.chunks]
      .sort((left, right) => left.index - right.index)
      .map((chunk) => device.audio.uri(chunk.file ?? ''));
    expect(player.loadedUris()).toEqual(expectedUris);
    expect(calls).toEqual([]);
    playback.dispose();
    offline.dispose();
  });

  it('retries an interrupted download and never stores bytes that fail the checksum', async () => {
    const real = new ApiClient({ baseUrl: BASE_URL });
    const seen = { dropped: false, corrupted: false };

    // The first request for part 1 loses its connection; the first answer for part 0 is corrupted.
    const unreliableFetch: FetchLike = async (url, init) => {
      if (url.endsWith('/chunks/1') && !seen.dropped) {
        seen.dropped = true;
        throw new TypeError('socket reset by peer');
      }
      const response = await fetch(url, init as RequestInit);
      if (url.includes('/chunks/0') && !seen.corrupted) {
        seen.corrupted = true;
        const bytes = new Uint8Array(await response.arrayBuffer());
        bytes[0] = (bytes[0] ?? 0) ^ 0xff;
        return new Response(bytes, { status: 200, headers: response.headers }) as unknown as ResponseLike;
      }
      return response as unknown as ResponseLike;
    };
    const flaky = new ApiClient({ baseUrl: BASE_URL, fetch: unreliableFetch });
    const device = createDevice(() => flaky);

    const created = await device.sync.submit({
      apiBaseUrl: BASE_URL,
      title: 'Flaky network e2e',
      transcript: TRANSCRIPT,
      sentencesPerChunk: 1,
    });
    await waitFor(() => device.library.book(created.id)?.serverReleased === true, 'sync completed after retries');

    expect(seen).toEqual({ dropped: true, corrupted: true });
    const book = bookOf(device, created.id);
    expect(book.status).toBe('ready');
    for (const chunk of book.chunks) {
      const bytes = device.audio.files.get(chunk.file ?? '') ?? new Uint8Array();
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(chunk.sha256);
    }
    expect(real.baseUrl).toBe(BASE_URL);
  });

  it('refuses an empty transcript with a validation error and creates no book', async () => {
    const api = new ApiClient({ baseUrl: BASE_URL });
    const device = createDevice(() => api);
    const error = await device.sync
      .submit({ apiBaseUrl: BASE_URL, title: 'Empty', transcript: '   ', sentencesPerChunk: 1 })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(422);
    expect(device.library.books()).toEqual([]);
  });

  it('answers job_not_found for a wrong access token', async () => {
    const api = new ApiClient({ baseUrl: BASE_URL });
    const created = await api.createJob({ title: 'Auth check', transcript: 'Salom dunyo.', sentencesPerChunk: 1 });
    await expect(api.getJob(created.id, 'not-the-token')).rejects.toMatchObject({
      status: 404,
      code: 'job_not_found',
    });
    await api.deleteJob(created.id, created.access_token);
  });
});
