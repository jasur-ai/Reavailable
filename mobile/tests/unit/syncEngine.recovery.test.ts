import { ApiError, NetworkError } from '../../src/core/api/client';
import type { BookRecord } from '../../src/core/types';
import { createSyncHarness, disposeAllEngines, submitSample, yieldSleep, type SyncHarness } from './support/harness';
import { waitUntil } from './support/memory';

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

async function settleTurns(turns = 50): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) {
    await yieldSleep();
  }
}

describe('SyncEngine: access tokens', () => {
  it('fails synthesis tracking with token_missing when the device lost the token', async () => {
    const harness = createSyncHarness();
    harness.server.autoReady = false;
    const { id: bookId } = await submitSample(harness);
    await harness.tokens.remove(bookId);
    harness.server.finishSynthesis(bookId);

    await waitUntil(() => bookOf(harness, bookId).status === 'failed', 'failure recorded');
    expect(bookOf(harness, bookId)).toMatchObject({ failedStage: 'synthesis', errorCode: 'token_missing' });
  });

  it('refuses to retry a server-side failure when the token is missing', async () => {
    const harness = createSyncHarness();
    harness.server.autoReady = false;
    const { id: bookId } = await submitSample(harness);
    harness.server.failSynthesis(bookId, 'tts_unavailable');
    await waitUntil(() => bookOf(harness, bookId).status === 'failed', 'synthesis failed');

    await harness.tokens.remove(bookId);
    await harness.sync.retry(bookId);
    expect(bookOf(harness, bookId)).toMatchObject({ status: 'failed', errorCode: 'token_missing' });
  });

  it('fails a download with token_missing when resuming a book without its token', async () => {
    const harness = createSyncHarness();
    const { id: bookId } = await submitSample(harness);
    await waitUntil(() => bookOf(harness, bookId).status === 'ready', 'ready');
    harness.library.update(bookId, (draft) => {
      draft.status = 'downloading';
      draft.chunks = draft.chunks.map((chunk) => ({ ...chunk, state: 'pending', acked: false, file: undefined }));
    });
    await harness.tokens.remove(bookId);

    await harness.sync.download(bookId);
    expect(bookOf(harness, bookId)).toMatchObject({ status: 'failed', failedStage: 'download', errorCode: 'token_missing' });
  });
});

describe('SyncEngine: synthesis tracking', () => {
  it('keeps waiting through a connection problem while the server is still synthesizing', async () => {
    const harness = createSyncHarness();
    harness.server.autoReady = false;
    harness.server.injectFault('getJob', new NetworkError('offline'), 3);
    const { id: bookId } = await submitSample(harness);

    await waitUntil(() => bookOf(harness, bookId).syncNote !== undefined, 'connection note');
    expect(bookOf(harness, bookId).status).toBe('processing');

    harness.server.finishSynthesis(bookId);
    await waitUntil(() => bookOf(harness, bookId).status === 'ready', 'ready after reconnect');
    expect(bookOf(harness, bookId).failedStage).toBeUndefined();
  });

  it('stops watching after the poll timeout and picks the job up again on the next refresh', async () => {
    const harness = createSyncHarness({ pollTimeoutMs: 0 });
    harness.server.autoReady = false;
    const { id: bookId } = await submitSample(harness);
    await settleTurns();
    expect(bookOf(harness, bookId).status).toBe('processing');

    harness.server.finishSynthesis(bookId);
    harness.sync.resumeAll();
    await waitUntil(() => bookOf(harness, bookId).status === 'ready', 'ready after refresh');
  });

  it('reports a refused retry and keeps the failure visible', async () => {
    const harness = createSyncHarness();
    harness.server.autoReady = false;
    const { id: bookId } = await submitSample(harness);
    harness.server.failSynthesis(bookId, 'tts_bad_request');
    await waitUntil(() => bookOf(harness, bookId).status === 'failed', 'synthesis failed');

    // The job is no longer in the failed state on the server, so it refuses the retry.
    harness.server.clearFaults();
    harness.server.injectFault('retryJob', new ApiError(409, 'job_not_failed', 'Only failed jobs can be retried.'), 1);
    await harness.sync.retry(bookId);
    expect(bookOf(harness, bookId)).toMatchObject({ status: 'failed', failedStage: 'synthesis', errorCode: 'job_not_failed' });
  });

  it('keeps the failure and shows a connection note when the retry cannot reach the server', async () => {
    const harness = createSyncHarness();
    harness.server.autoReady = false;
    const { id: bookId } = await submitSample(harness);
    harness.server.failSynthesis(bookId, 'internal_error');
    await waitUntil(() => bookOf(harness, bookId).status === 'failed', 'synthesis failed');

    harness.server.injectFault('retryJob', new NetworkError('offline'), 1);
    await harness.sync.retry(bookId);
    expect(bookOf(harness, bookId)).toMatchObject({ status: 'failed', syncNote: expect.stringContaining('connection') });
  });
});

describe('SyncEngine: download passes', () => {
  it('runs one pass when two callers ask for the same book at the same time', async () => {
    const harness = createSyncHarness();
    // A server job that nobody on this device has downloaded yet.
    const created = await harness.server.createJob({
      title: 'Direct',
      transcript: 'Birinchi jumla.\nIkkinchi jumla.',
      sentencesPerChunk: 1,
    });
    await harness.tokens.save(created.id, created.access_token);
    harness.library.insert({
      id: created.id,
      apiBaseUrl: harness.server.baseUrl,
      title: 'Direct',
      voice: created.voice,
      status: 'downloading',
      warnings: [],
      totalChunks: 0,
      chunks: [],
      position: 0,
      serverReleased: false,
      serverGone: false,
      createdAt: '2026-10-09T05:00:00.000Z',
      updatedAt: '2026-10-09T05:00:00.000Z',
    });

    await Promise.all([harness.sync.download(created.id), harness.sync.download(created.id)]);

    expect([...harness.server.downloads.values()]).toEqual([1, 1]);
    expect(bookOf(harness, created.id)).toMatchObject({ status: 'ready' });
  });

  it('marks a book with no parts as still downloading, with a neutral note', async () => {
    const harness = createSyncHarness();
    const { id: bookId } = await submitSample(harness, '\n\n');
    await waitUntil(() => bookOf(harness, bookId).status !== 'processing', 'pass finished');

    expect(bookOf(harness, bookId)).toMatchObject({
      status: 'downloading',
      syncNote: 'Some parts are still missing. Downloads resume automatically.',
    });
  });

  it('stops a running download as soon as the book is removed', async () => {
    const harness = createSyncHarness({ maxAttemptsPerChunk: 4 });
    harness.server.injectFault('downloadChunk', new NetworkError('offline'), 100, 0);
    const { id: bookId } = await submitSample(harness);
    await waitUntil(() => bookOf(harness, bookId).chunks[0]?.attempts === 1, 'first attempt');

    const attempts = jest.spyOn(harness.server, 'downloadChunk');
    await harness.sync.removeBook(bookId);
    const atRemoval = attempts.mock.calls.length;
    await settleTurns();

    expect(attempts.mock.calls.length).toBe(atRemoval);
    expect(harness.library.book(bookId)).toBeUndefined();
    expect(harness.audio.files.size).toBe(0);
  });
});

describe('SyncEngine: repeated checksum rejections', () => {
  it('fails the book after the second rejection and stops re-downloading on later passes', async () => {
    const harness = createSyncHarness();
    harness.server.injectFault('acknowledge', new ApiError(409, 'checksum_mismatch', 'mismatch'), 10);
    const { id: bookId } = await submitSample(harness);
    await waitUntil(
      () => bookOf(harness, bookId).syncNote?.includes('failed verification') === true,
      'first rejection recorded',
    );
    await settleTurns();
    expect(bookOf(harness, bookId).status).toBe('downloading');

    // The second pass downloads the parts again; the server rejects them again.
    await harness.sync.download(bookId);
    const book = bookOf(harness, bookId);
    expect(book).toMatchObject({ status: 'failed', failedStage: 'download', errorCode: 'checksum_rejected' });
    expect(book.errorMessage).toContain('Retry');
    expect(book.chunks.every((chunk) => chunk.state === 'failed' && chunk.file === undefined)).toBe(true);
    // One original download and one re-download of every part.
    expect(harness.server.totalDownloads()).toBe(6);

    harness.sync.resumeAll();
    await settleTurns();
    expect(harness.server.totalDownloads()).toBe(6);
    // The server copy is kept, so a later retry can still finish the book.
    expect(harness.server.hasJob(bookId)).toBe(true);
  });

  it('starts a fresh attempt when the user retries after the server stops rejecting', async () => {
    const harness = createSyncHarness();
    harness.server.injectFault('acknowledge', new ApiError(409, 'checksum_mismatch', 'mismatch'), 2);
    const { id: bookId } = await submitSample(harness);
    await waitUntil(
      () => bookOf(harness, bookId).syncNote?.includes('failed verification') === true,
      'first rejection recorded',
    );
    await settleTurns();
    await harness.sync.download(bookId);
    expect(bookOf(harness, bookId)).toMatchObject({ status: 'failed', errorCode: 'checksum_rejected' });
    expect(harness.server.totalDownloads()).toBe(6);

    await harness.sync.retry(bookId);
    await waitUntil(() => bookOf(harness, bookId).status === 'ready', 'book ready after retry');
    expect(bookOf(harness, bookId).chunks.every((chunk) => chunk.acked && chunk.state === 'stored')).toBe(true);
    expect(bookOf(harness, bookId).chunks.every((chunk) => chunk.ackRejections === undefined)).toBe(true);
    expect(harness.server.hasJob(bookId)).toBe(false);
  });
});
