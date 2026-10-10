import { ApiError, NetworkError } from '../../src/core/api/client';
import { Library } from '../../src/core/library/library';
import { createTranslator } from '../../src/i18n';
import { SyncEngine } from '../../src/core/sync/syncEngine';
import type { BookRecord } from '../../src/core/types';
import {
  createSyncHarness,
  disposeAllEngines,
  partPath,
  SAMPLE_TRANSCRIPT,
  submitSample,
  yieldSleep,
  type SyncHarness,
} from './support/harness';
import { MemoryTokenVault, sha256, waitUntil } from './support/memory';

afterEach(() => {
  disposeAllEngines();
});

function bookOf(harness: SyncHarness, bookId: string): BookRecord {
  const book = harness.library.book(bookId);
  if (!book) {
    throw new Error(`book ${bookId} is missing`);
  }
  return book;
}

async function submitAndWaitForReady(harness: SyncHarness, transcript?: string): Promise<string> {
  const book = await submitSample(harness, transcript);
  await waitUntil(() => bookOf(harness, book.id).status === 'ready', 'book ready');
  return book.id;
}

/** Restarts unfinished work in a fresh library and engine that share the same persisted file, audio and server. */
async function restartFrom(harness: SyncHarness): Promise<{ library: Library; engine: SyncEngine }> {
  await harness.library.flush();
  const library = new Library(harness.persistence);
  await library.load();
  const engine = new SyncEngine({
    library,
    audio: harness.audio,
    tokens: harness.tokens,
    hash: sha256,
    clientFor: () => harness.server,
    sleep: () => yieldSleep(),
    options: { retryBaseDelayMs: 1, pollIntervalMs: 1 },
  });
  return { library, engine };
}

describe('SyncEngine: happy path', () => {
  it('downloads every part, stores verified audio, acknowledges it and removes the server copy', async () => {
    const harness = createSyncHarness();
    const bookId = await submitAndWaitForReady(harness);

    const book = bookOf(harness, bookId);
    expect(book.totalChunks).toBe(3);
    expect(book.chunks.map((chunk) => chunk.state)).toEqual(['stored', 'stored', 'stored']);
    expect(book.chunks.every((chunk) => chunk.acked)).toBe(true);
    expect(book.serverReleased).toBe(true);
    expect(book.serverGone).toBe(false);
    expect(harness.server.hasJob(bookId)).toBe(false);
    expect(harness.audio.files.has(partPath(bookId, 0))).toBe(true);
    expect(harness.audio.files.has(partPath(bookId, 2))).toBe(true);
    expect(book.syncNote).toBeUndefined();
  });

  it('stores the access token in the vault, never in the library file', async () => {
    const harness = createSyncHarness();
    const bookId = await submitAndWaitForReady(harness);

    const token = await harness.tokens.load(bookId);
    expect(token).toEqual(expect.any(String));
    await harness.library.flush();
    expect(harness.persistence.text).not.toContain(token ?? '');
  });

  it('acknowledges a part only after its audio is written and its state is on disk', async () => {
    const harness = createSyncHarness();
    const violations: string[] = [];
    harness.server.onAcknowledge = (jobId, indexes) => {
      for (const index of indexes) {
        if (!harness.audio.files.has(partPath(jobId, index))) {
          violations.push(`audio missing for part ${index}`);
        }
      }
      const persisted = JSON.parse(harness.persistence.text ?? '{}') as {
        books?: { id: string; chunks: { index: number; state: string }[] }[];
      };
      const stored = persisted.books
        ?.find((book) => book.id === jobId)
        ?.chunks.filter((chunk) => chunk.state === 'stored');
      if ((stored?.length ?? 0) < indexes.length) {
        violations.push('stored state not persisted before acknowledgement');
      }
    };
    await submitAndWaitForReady(harness);
    expect(violations).toEqual([]);
  });

  it('keeps the library file consistent with the in-memory state after a flush', async () => {
    const harness = createSyncHarness();
    const bookId = await submitAndWaitForReady(harness);
    await harness.library.flush();

    const persisted = JSON.parse(harness.persistence.text ?? '{}') as { books: BookRecord[] };
    expect(persisted.books).toHaveLength(1);
    expect(persisted.books[0]?.id).toBe(bookId);
    expect(persisted.books[0]?.status).toBe('ready');
  });
});

describe('SyncEngine: submission', () => {
  it('reports server errors to the caller and creates no book', async () => {
    const harness = createSyncHarness();
    harness.server.injectFault('createJob', new ApiError(413, 'transcript_too_large', 'Too long.'));

    await expect(submitSample(harness)).rejects.toThrow('Too long.');
    expect(harness.library.books()).toHaveLength(0);
    expect(harness.tokens.tokens.size).toBe(0);
  });

  it('marks a book failed with a readable message when synthesis fails on the server', async () => {
    const harness = createSyncHarness();
    harness.server.autoReady = false;
    const book = await submitSample(harness);
    harness.server.failSynthesis(book.id, 'tts_auth_failed');

    await waitUntil(() => bookOf(harness, book.id).status === 'failed', 'book failed');
    const failed = bookOf(harness, book.id);
    expect(failed.failedStage).toBe('synthesis');
    expect(failed.errorCode).toBe('tts_auth_failed');
    expect(failed.errorMessage).toContain('credentials');
  });

  it('waits for synthesis to finish before downloading', async () => {
    const harness = createSyncHarness();
    harness.server.autoReady = false;
    const book = await submitSample(harness);
    await waitUntil(() => harness.sleeps.length >= 2, 'polling');
    expect(bookOf(harness, book.id).status).toBe('processing');
    expect(harness.server.totalDownloads()).toBe(0);

    harness.server.finishSynthesis(book.id);
    await waitUntil(() => bookOf(harness, book.id).status === 'ready', 'book ready');
    expect(harness.server.totalDownloads()).toBe(3);
  });

  it('marks a book failed when there is no access token on this device', async () => {
    const harness = createSyncHarness();
    harness.server.autoReady = false;
    const book = await submitSample(harness);
    await harness.tokens.remove(book.id);

    await waitUntil(() => bookOf(harness, book.id).status === 'failed', 'token failure');
    expect(bookOf(harness, book.id).errorCode).toBe('token_missing');
  });
});

describe('SyncEngine: transient failures', () => {
  it('retries a part after network errors and then completes', async () => {
    const harness = createSyncHarness();
    harness.server.injectFault('downloadChunk', new NetworkError('offline'), 2, 1);
    const bookId = await submitAndWaitForReady(harness);

    expect(harness.server.downloads.get(1)).toBe(1);
    expect(bookOf(harness, bookId).chunks[1]?.attempts).toBe(3);
    expect(harness.sleeps).toEqual([1, 2]);
  });

  it('retries corrupted downloads and does not store bytes that fail the announced checksum', async () => {
    const harness = createSyncHarness();
    harness.server.corruptIndexes.add(0);
    const { id: bookId } = await submitSample(harness);
    await waitUntil(() => bookOf(harness, bookId).syncNote !== undefined, 'paused on checksum');
    await harness.sync.download(bookId);

    const book = bookOf(harness, bookId);
    expect(book.chunks[0]?.state).toBe('failed');
    expect(book.chunks[0]?.lastError).toBe('checksum_mismatch');
    expect(book.chunks[0]?.attempts).toBe(4);
    expect(book.syncNote).toContain('failed verification');
    expect(harness.audio.files.has(partPath(bookId, 0))).toBe(false);
    // The server still holds the part, so nothing is acknowledged or deleted.
    expect(harness.server.jobChunkStatuses(bookId)[0]).toBe('ready');
    expect(harness.server.hasJob(bookId)).toBe(true);

    harness.server.corruptIndexes.clear();
    await harness.sync.download(bookId);
    expect(bookOf(harness, bookId).status).toBe('ready');
    expect(harness.server.hasJob(bookId)).toBe(false);
  });

  it('pauses after the attempts run out and resumes later without re-downloading stored parts', async () => {
    const harness = createSyncHarness();
    harness.server.injectFault('downloadChunk', new NetworkError('offline'), 100, 2);
    const { id: bookId } = await submitSample(harness);
    await waitUntil(() => bookOf(harness, bookId).syncNote !== undefined, 'paused with a note');
    await harness.sync.download(bookId);

    const paused = bookOf(harness, bookId);
    expect(paused.status).toBe('downloading');
    expect(paused.syncNote).toContain('Waiting for a connection');
    expect(paused.chunks.map((chunk) => chunk.state)).toEqual(['stored', 'stored', 'failed']);
    expect(harness.server.downloads.get(0)).toBe(1);

    harness.server.clearFaults();
    await harness.sync.download(bookId);

    const done = bookOf(harness, bookId);
    expect(done.status).toBe('ready');
    expect(harness.server.downloads.get(0)).toBe(1);
    expect(harness.server.downloads.get(2)).toBe(1);
    expect(harness.server.hasJob(bookId)).toBe(false);
  });

  it('keeps the server copy until the acknowledgement succeeds, then finishes on the next pass', async () => {
    const harness = createSyncHarness();
    harness.server.injectFault('acknowledge', new NetworkError('offline'), 1);
    const bookId = await submitAndWaitForReady(harness);

    // The book is playable, but the server still holds it.
    expect(bookOf(harness, bookId).chunks.every((chunk) => chunk.state === 'stored')).toBe(true);
    expect(bookOf(harness, bookId).chunks.some((chunk) => !chunk.acked)).toBe(true);
    expect(harness.server.hasJob(bookId)).toBe(true);

    harness.sync.resumeAll();
    await waitUntil(() => bookOf(harness, bookId).chunks.every((chunk) => chunk.acked), 'acknowledged on resume');
    expect(harness.server.hasJob(bookId)).toBe(false);
  });

  it('shows a connection note while the server is unreachable and resumes automatically', async () => {
    const harness = createSyncHarness();
    harness.server.autoReady = false;
    const book = await submitSample(harness);
    harness.server.injectFault('getJob', new NetworkError('offline'), 3);
    harness.server.finishSynthesis(book.id);

    await waitUntil(() => bookOf(harness, book.id).status === 'ready', 'ready after outage');
    expect(bookOf(harness, book.id).syncNote).toBeUndefined();
  });
});

describe('SyncEngine: acknowledgement and server state', () => {
  it('treats chunk_not_found on acknowledgement as already acknowledged', async () => {
    const harness = createSyncHarness();
    harness.server.injectFault('acknowledge', new ApiError(404, 'chunk_not_found', 'gone'), 1);
    const bookId = await submitAndWaitForReady(harness);
    expect(bookOf(harness, bookId).chunks.every((chunk) => chunk.acked)).toBe(true);
  });

  it('downloads the parts again when the server rejects the stored checksum', async () => {
    const harness = createSyncHarness();
    harness.server.injectFault('acknowledge', new ApiError(409, 'checksum_mismatch', 'mismatch'), 1);
    const { id: bookId } = await submitSample(harness);
    await waitUntil(() => {
      const chunks = bookOf(harness, bookId).chunks;
      return chunks.length === 3 && chunks.every((chunk) => chunk.state === 'pending');
    }, 'parts discarded');
    expect(bookOf(harness, bookId).syncNote).toContain('failed verification');

    await harness.sync.download(bookId);
    expect(bookOf(harness, bookId).status).toBe('ready');
    expect(harness.server.totalDownloads()).toBe(6);
    expect(harness.server.hasJob(bookId)).toBe(false);
  });

  it('keeps audio on the device and marks the book ready when the server copy expires after every part was stored', async () => {
    const harness = createSyncHarness();
    harness.server.injectFault('acknowledge', new ApiError(404, 'job_not_found', 'gone'), 1);
    const bookId = await submitAndWaitForReady(harness);

    const book = bookOf(harness, bookId);
    expect(book.serverGone).toBe(true);
    expect(book.serverReleased).toBe(true);
    expect(book.chunks.every((chunk) => chunk.state === 'stored')).toBe(true);
    expect(harness.audio.files.has(partPath(bookId, 1))).toBe(true);
  });

  it('fails the book with job_not_found but keeps the parts already on the device when the server copy expires mid-download', async () => {
    const harness = createSyncHarness();
    harness.server.autoReady = false;
    const book = await submitSample(harness);
    harness.server.finishSynthesis(book.id);
    harness.server.injectFault('downloadChunk', new ApiError(404, 'job_not_found', 'gone'), 1, 1);

    await waitUntil(() => bookOf(harness, book.id).status === 'failed', 'failed after expiry');
    const failed = bookOf(harness, book.id);
    expect(failed.serverGone).toBe(true);
    expect(failed.errorCode).toBe('job_not_found');
    expect(failed.chunks[0]?.state).toBe('stored');
    expect(harness.audio.files.has(partPath(book.id, 0))).toBe(true);
    expect(harness.audio.files.has(partPath(book.id, 1))).toBe(false);
  });

  it('removes a book whose server copy has expired without calling the server', async () => {
    const harness = createSyncHarness();
    harness.server.autoReady = false;
    const book = await submitSample(harness);
    harness.server.finishSynthesis(book.id);
    harness.server.injectFault('downloadChunk', new ApiError(404, 'job_not_found', 'gone'), 1, 2);
    await waitUntil(() => bookOf(harness, book.id).status === 'failed', 'failed');

    const result = await harness.sync.removeBook(book.id);
    expect(result.serverDeleted).toBe(false);
    expect(harness.library.book(book.id)).toBeUndefined();
    expect(harness.audio.files.size).toBe(0);
  });

  it('fails a part the server no longer has and reports it', async () => {
    const harness = createSyncHarness();
    harness.server.autoReady = false;
    const book = await submitSample(harness);
    harness.server.finishSynthesis(book.id);
    harness.server.injectFault('downloadChunk', new ApiError(404, 'chunk_unavailable', 'gone'), 1, 0);

    await waitUntil(() => bookOf(harness, book.id).status === 'failed', 'failed');
    const failed = bookOf(harness, book.id);
    expect(failed.errorCode).toBe('chunk_unavailable');
    expect(failed.errorMessage).toContain('no longer available');
  });

  it('explains a chunk that is still being finished on the server, instead of blaming the connection', async () => {
    const harness = createSyncHarness();
    harness.server.injectFault('acknowledge', new ApiError(409, 'chunk_not_ready', 'not ready'), 1);
    const bookId = await submitAndWaitForReady(harness);
    expect(bookOf(harness, bookId).syncNote).toContain('still finishing');
  });
});

describe('SyncEngine: local storage', () => {
  it('reports a full disk as storage_failed and does not acknowledge the part', async () => {
    const harness = createSyncHarness();
    harness.server.autoReady = false;
    const book = await submitSample(harness);
    harness.audio.failWrites = true;
    harness.server.finishSynthesis(book.id);

    await waitUntil(() => bookOf(harness, book.id).status === 'failed', 'failed on disk error');
    expect(bookOf(harness, book.id).errorCode).toBe('storage_failed');
    expect(harness.server.hasJob(book.id)).toBe(true);
    expect(harness.server.jobChunkStatuses(book.id)[0]).toBe('ready');
  });

  it('marks an acknowledged part as lost when its file is gone, without asking the server again', async () => {
    const harness = createSyncHarness();
    const bookId = await submitAndWaitForReady(harness);
    const callsBefore = harness.server.totalDownloads();
    harness.audio.files.delete(partPath(bookId, 1));

    await harness.sync.download(bookId);
    const book = bookOf(harness, bookId);
    expect(book.status).toBe('failed');
    expect(book.errorCode).toBe('file_missing');
    expect(book.errorMessage).toContain('cannot be recovered');
    expect(book.chunks[1]?.state).toBe('failed');
    expect(book.chunks[1]?.lastError).toBe('file_missing');
    expect(book.chunks[0]?.state).toBe('stored');
    expect(harness.server.totalDownloads()).toBe(callsBefore);
  });

  it('downloads a stored-but-unacknowledged part again when its file is missing', async () => {
    const harness = createSyncHarness();
    harness.server.injectFault('acknowledge', new NetworkError('offline'), 100);
    const book = await submitSample(harness);
    await waitUntil(() => bookOf(harness, book.id).status === 'ready', 'ready');
    expect(bookOf(harness, book.id).chunks.every((chunk) => chunk.state === 'stored')).toBe(true);

    harness.audio.files.delete(partPath(book.id, 0));
    harness.server.clearFaults();
    await harness.sync.download(book.id);

    expect(harness.server.downloads.get(0)).toBe(2);
    expect(harness.audio.files.has(partPath(book.id, 0))).toBe(true);
    expect(harness.server.hasJob(book.id)).toBe(false);
  });
});

describe('SyncEngine: restart and resume', () => {
  it('resumes after a restart: only the missing parts are downloaded again', async () => {
    const harness = createSyncHarness();
    harness.server.injectFault('downloadChunk', new NetworkError('offline'), 100, 2);
    const book = await submitSample(harness);
    await waitUntil(() => bookOf(harness, book.id).syncNote !== undefined, 'paused');
    await harness.sync.download(book.id);
    harness.sync.dispose();

    const { library, engine } = await restartFrom(harness);
    harness.server.clearFaults();
    engine.resumeAll();
    await waitUntil(() => library.book(book.id)?.status === 'ready', 'ready after restart');

    expect(harness.server.downloads.get(0)).toBe(1);
    expect(harness.server.downloads.get(1)).toBe(1);
    expect(harness.server.downloads.get(2)).toBe(1);
    expect(harness.server.hasJob(book.id)).toBe(false);
    engine.dispose();
  });

  it('recovers a book whose synthesis was still running when the app closed', async () => {
    const harness = createSyncHarness();
    harness.server.autoReady = false;
    const book = await submitSample(harness);
    harness.sync.dispose();

    const { library, engine } = await restartFrom(harness);
    harness.server.finishSynthesis(book.id);
    engine.resumeAll();
    await waitUntil(() => library.book(book.id)?.status === 'ready', 'ready');
    expect(harness.server.hasJob(book.id)).toBe(false);
    engine.dispose();
  });
});

describe('SyncEngine: retry and removal', () => {
  it('re-queues synthesis on the server when the failure happened there', async () => {
    const harness = createSyncHarness();
    harness.server.autoReady = false;
    const book = await submitSample(harness);
    harness.server.failSynthesis(book.id, 'tts_unavailable');
    await waitUntil(() => bookOf(harness, book.id).status === 'failed', 'failed');

    await harness.sync.retry(book.id);
    expect(bookOf(harness, book.id).status).toBe('processing');
    harness.server.finishSynthesis(book.id);
    await waitUntil(() => bookOf(harness, book.id).status === 'ready', 'ready after retry');
  });

  it('downloads again on the device when the failure happened during download', async () => {
    const harness = createSyncHarness();
    harness.server.injectFault('downloadChunk', new ApiError(404, 'chunk_unavailable', 'gone'), 1, 1);
    const book = await submitSample(harness);
    await waitUntil(() => bookOf(harness, book.id).status === 'failed', 'failed');
    expect(bookOf(harness, book.id).failedStage).toBe('download');

    harness.server.clearFaults();
    await harness.sync.retry(book.id);
    expect(bookOf(harness, book.id).status).toBe('ready');
  });

  it('does not retry a book whose server copy is gone', async () => {
    const harness = createSyncHarness();
    harness.server.autoReady = false;
    const book = await submitSample(harness);
    harness.server.expire(book.id);
    await waitUntil(() => bookOf(harness, book.id).status === 'failed', 'failed');
    expect(bookOf(harness, book.id).serverGone).toBe(true);

    await harness.sync.retry(book.id);
    expect(bookOf(harness, book.id).status).toBe('failed');
  });

  it('removes a book from the device and deletes the server copy', async () => {
    const harness = createSyncHarness();
    harness.server.autoReady = false;
    const book = await submitSample(harness);
    harness.server.finishSynthesis(book.id);
    harness.server.injectFault('downloadChunk', new NetworkError('offline'), 100, 2);
    await waitUntil(() => bookOf(harness, book.id).syncNote !== undefined, 'paused');
    await harness.sync.download(book.id);
    expect(harness.audio.files.size).toBeGreaterThan(0);

    const result = await harness.sync.removeBook(book.id);
    expect(result.serverDeleted).toBe(true);
    expect(harness.library.book(book.id)).toBeUndefined();
    expect(harness.audio.files.size).toBe(0);
    expect(harness.tokens.tokens.has(book.id)).toBe(false);
    expect(harness.server.hasJob(book.id)).toBe(false);
  });

  it('removes a book from the device even when the server cannot be reached', async () => {
    const harness = createSyncHarness();
    const bookId = await submitAndWaitForReady(harness);
    harness.server.injectFault('deleteJob', new NetworkError('offline'), 1);

    const result = await harness.sync.removeBook(bookId);
    expect(result.serverDeleted).toBe(false);
    expect(harness.library.book(bookId)).toBeUndefined();
    expect(harness.audio.files.size).toBe(0);
  });

  it('does nothing for an unknown book', async () => {
    const harness = createSyncHarness();
    await expect(harness.sync.removeBook('missing')).resolves.toEqual({ serverDeleted: false });
  });
});

describe('SyncEngine: failure handling', () => {
  it('turns unexpected local errors into a failed book instead of an unhandled rejection', async () => {
    const harness = createSyncHarness();
    const brokenTokens = new MemoryTokenVault();
    brokenTokens.load = () => Promise.reject(new Error('keystore locked'));
    const engine = new SyncEngine({
      library: harness.library,
      audio: harness.audio,
      tokens: brokenTokens,
      hash: sha256,
      clientFor: () => harness.server,
      sleep: () => yieldSleep(),
      options: { retryBaseDelayMs: 1, pollIntervalMs: 1 },
    });
    const book = await engine.submit({
      apiBaseUrl: harness.server.baseUrl,
      title: 'Broken keystore',
      transcript: SAMPLE_TRANSCRIPT,
      sentencesPerChunk: 1,
    });
    await waitUntil(() => bookOf(harness, book.id).status === 'failed', 'failed');
    expect(bookOf(harness, book.id).errorCode).toBe('internal_error');
    engine.dispose();
  });

  it('sends the transcript and the chosen part length to the server', async () => {
    const harness = createSyncHarness();
    const seen: { transcript: string; sentences: number }[] = [];
    const original = harness.server.createJob.bind(harness.server);
    harness.server.createJob = async (input) => {
      seen.push({ transcript: input.transcript, sentences: input.sentencesPerChunk });
      return original(input);
    };
    await submitAndWaitForReady(harness, SAMPLE_TRANSCRIPT);
    expect(seen).toEqual([{ transcript: SAMPLE_TRANSCRIPT, sentences: 1 }]);
  });

  it('reports a failed library write and writes the change on the next attempt', async () => {
    const harness = createSyncHarness();
    harness.persistence.failNextWrite = true;
    harness.library.setApiBaseUrl('https://another.test');
    await expect(harness.library.flush()).rejects.toThrow('write failed');

    harness.library.setApiBaseUrl('https://another.test');
    await harness.library.flush();
    expect(JSON.parse(harness.persistence.text ?? '{}').settings.apiBaseUrl).toBe('https://another.test');
  });
});

describe('SyncEngine: interface language', () => {
  it('writes notes in Uzbek by default and follows a later switch to English', async () => {
    const harness = createSyncHarness();
    const engine = new SyncEngine({
      library: harness.library,
      audio: harness.audio,
      tokens: harness.tokens,
      hash: sha256,
      clientFor: () => harness.server,
      sleep: () => yieldSleep(),
      options: { retryBaseDelayMs: 1, pollIntervalMs: 1 },
      // The app passes a thunk, exactly like services.ts does.
      translate: () => createTranslator(harness.library.settings().language),
    });
    harness.server.injectFault('downloadChunk', new NetworkError('offline'), 100);
    const book = await engine.submit({
      apiBaseUrl: harness.server.baseUrl,
      title: 'Kitob',
      transcript: SAMPLE_TRANSCRIPT,
      sentencesPerChunk: 1,
    });
    await waitUntil(() => bookOf(harness, book.id).syncNote !== undefined, 'paused with a note');
    // Uzbek is the default language of a new installation.
    expect(bookOf(harness, book.id).syncNote).toContain('Ulanish kutilmoqda');

    harness.library.setLanguage('en');
    await engine.download(book.id);
    await waitUntil(
      () => bookOf(harness, book.id).syncNote?.includes('Waiting for a connection') === true,
      'english note',
    );
  });

  it('falls back to English when no translator is supplied', async () => {
    const harness = createSyncHarness();
    harness.library.setLanguage('uz');
    harness.server.injectFault('downloadChunk', new NetworkError('offline'), 100);
    const book = await submitSample(harness);
    await waitUntil(() => bookOf(harness, book.id).syncNote !== undefined, 'paused with a note');
    expect(bookOf(harness, book.id).syncNote).toContain('Waiting for a connection');
  });
});
