/**
 * Sync engine: uploads transcripts, waits for synthesis, downloads and verifies every audio chunk,
 * stores it on the device, and only then acknowledges it so the server can delete its copy.
 *
 * Guarantees:
 * - A chunk is acknowledged only after its bytes were verified and written to the device.
 * - Every downloaded chunk must match the SHA-256 the server announced, or it is downloaded again.
 * - Transient failures (no connection, timeouts, 5xx) pause the pass; `resumeAll()` continues it.
 * - If the server copy disappears (TTL expiry), audio already on the device is kept.
 */

import {
  ApiClient,
  ApiError,
  NetworkError,
  type CreateJobInput,
  type DownloadedChunk,
  type JobCreatedDto,
} from '../api/client';
import { describeError } from '../messages';
import type { Library } from '../library/library';
import type { AudioStore, Hasher, TokenVault } from '../library/ports';
import type { BookRecord, BookStatus, ChunkRecord, FailureStage } from '../types';
import { chunkRelativePath } from './chunkFiles';

/** The part of the API the engine needs. Tests supply a fake; the app supplies ApiClient. */
export type SyncApi = Pick<
  ApiClient,
  'createJob' | 'getJob' | 'getManifest' | 'downloadChunk' | 'acknowledge' | 'retryJob' | 'deleteJob'
> & { readonly baseUrl: string };

export interface SyncOptions {
  /** Download attempts per part within one pass. */
  maxAttemptsPerChunk: number;
  retryBaseDelayMs: number;
  pollIntervalMs: number;
  /** After this long a single tracking loop stops; it resumes on the next app start or refresh. */
  pollTimeoutMs: number;
  /** Parts acknowledged per request while a download is still running. */
  progressiveAckBatchSize: number;
  /** Largest acknowledgement request the server accepts. */
  maxAckBatchSize: number;
}

/** Checksum rejections for one part before the book fails instead of downloading the part again. */
const MAX_ACK_REJECTIONS = 2;

export const DEFAULT_SYNC_OPTIONS: SyncOptions = {
  maxAttemptsPerChunk: 4,
  retryBaseDelayMs: 1_000,
  pollIntervalMs: 2_000,
  pollTimeoutMs: 30 * 60_000,
  progressiveAckBatchSize: 20,
  maxAckBatchSize: 500,
};

export interface SyncDependencies {
  library: Library;
  audio: AudioStore;
  tokens: TokenVault;
  hash: Hasher;
  clientFor: (baseUrl: string) => SyncApi;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
  options?: Partial<SyncOptions>;
}

export interface SubmitInput extends CreateJobInput {
  apiBaseUrl: string;
}

/** A failure that retrying will not fix. Ends the pass and marks the book as failed. */
class PermanentFailure extends Error {
  readonly code: string;
  readonly gone: boolean;

  constructor(code: string, message: string | undefined, gone = false) {
    super(message ?? code);
    this.name = 'PermanentFailure';
    this.code = code;
    this.gone = gone;
  }
}

/** Downloaded bytes did not match the announced checksum or size. Retried like a network error. */
class IntegrityFailure extends Error {
  readonly code = 'checksum_mismatch';

  constructor() {
    super('checksum_mismatch');
    this.name = 'IntegrityFailure';
  }
}

type PartOutcome = { stored: true } | { stored: false; code: string };

const CONNECTION_NOTE = 'Waiting for a connection. Downloads resume automatically.';
const PARTS_MISSING_NOTE = 'Some parts are still missing. Downloads resume automatically.';

function isApiError(error: unknown, code: string): error is ApiError {
  return error instanceof ApiError && error.code === code;
}

function isGone(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404 && error.code === 'job_not_found';
}

function isTransient(error: unknown): boolean {
  if (error instanceof NetworkError || error instanceof IntegrityFailure) {
    return true;
  }
  if (error instanceof ApiError) {
    // 409 is a conflict in general (for example, a retry of a job that is not failed). Only the
    // "still being prepared" answers are temporary.
    const preparing = error.status === 409 && (error.code === 'chunk_not_ready' || error.code === 'job_not_ready');
    return preparing || error.status === 408 || error.status === 425 || error.status === 429 || error.status >= 500;
  }
  return false;
}

function codeOf(error: unknown): string {
  if (error instanceof ApiError) {
    return error.code;
  }
  if (error instanceof NetworkError) {
    return error.timedOut ? 'timeout' : 'network';
  }
  if (error instanceof PermanentFailure || error instanceof IntegrityFailure) {
    return error.code;
  }
  return 'internal_error';
}

function messageOf(error: unknown): string | undefined {
  return error instanceof ApiError ? error.message : undefined;
}

export class SyncEngine {
  private readonly options: SyncOptions;
  private readonly tracking = new Set<string>();
  /** The download pass running for each book. A second request joins it instead of starting another. */
  private readonly passes = new Map<string, Promise<void>>();
  private readonly cancelled = new Set<string>();
  private disposed = false;

  constructor(private readonly deps: SyncDependencies) {
    this.options = { ...DEFAULT_SYNC_OPTIONS, ...deps.options };
  }

  /** Uploads a transcript as a new server job, stores the access token, and starts tracking it. */
  async submit(input: SubmitInput): Promise<BookRecord> {
    const client = this.deps.clientFor(input.apiBaseUrl);
    const created: JobCreatedDto = await client.createJob({
      title: input.title,
      transcript: input.transcript,
      sentencesPerChunk: input.sentencesPerChunk,
      voice: input.voice,
    });
    const now = new Date(this.now()).toISOString();
    const book: BookRecord = {
      id: created.id,
      apiBaseUrl: client.baseUrl,
      title: created.title,
      voice: created.voice,
      status: 'processing',
      warnings: created.warnings,
      totalChunks: created.total_chunks,
      chunks: [],
      position: 0,
      serverReleased: false,
      serverGone: false,
      createdAt: now,
      updatedAt: now,
    };
    await this.deps.tokens.save(book.id, created.access_token);
    this.deps.library.insert(book);
    await this.deps.library.flush();
    void this.track(book.id);
    return book;
  }

  /** Stops every background loop at its next step. Used when the app shuts down and in tests. */
  dispose(): void {
    this.disposed = true;
  }

  /** Waits for server synthesis to finish, then downloads. Calling it twice for one book is a no-op. */
  track(bookId: string): Promise<void> {
    if (this.tracking.has(bookId)) {
      return Promise.resolve();
    }
    this.tracking.add(bookId);
    return this.trackLoop(bookId)
      .catch((error: unknown) => {
        this.fail(bookId, 'synthesis', codeOf(error), messageOf(error));
      })
      .finally(() => {
        this.tracking.delete(bookId);
      });
  }

  /** Downloads missing parts and acknowledges stored ones. Passes for one book never overlap. */
  download(bookId: string): Promise<void> {
    const running = this.passes.get(bookId);
    if (running) {
      return running;
    }
    const pass = this.runDownload(bookId)
      .catch((error: unknown) => {
        this.fail(bookId, 'download', codeOf(error), messageOf(error));
      })
      .finally(() => {
        this.passes.delete(bookId);
      });
    this.passes.set(bookId, pass);
    return pass;
  }

  /** Restarts unfinished work for every book (app start, pull-to-refresh, connectivity regained). */
  resumeAll(): void {
    for (const book of this.deps.library.books()) {
      if (book.status === 'processing') {
        void this.track(book.id);
      } else if (this.needsWork(book)) {
        void this.download(book.id).catch(() => undefined);
      }
    }
  }

  /** Retries a failed book: re-queues synthesis on the server, or downloads again on the device. */
  async retry(bookId: string): Promise<void> {
    const book = this.deps.library.book(bookId);
    if (!book || book.serverGone) {
      return;
    }
    if (book.failedStage === 'synthesis') {
      const token = await this.deps.tokens.load(bookId);
      if (token === null) {
        this.fail(bookId, 'synthesis', 'token_missing');
        return;
      }
      try {
        await this.deps.clientFor(book.apiBaseUrl).retryJob(bookId, token);
      } catch (error) {
        this.handleTrackingError(bookId, 'synthesis', error);
        return;
      }
      this.deps.library.update(bookId, (draft) => {
        draft.status = 'processing';
        clearFailure(draft);
      });
      void this.track(bookId);
      return;
    }
    this.deps.library.update(bookId, (draft) => {
      draft.status = 'downloading';
      clearFailure(draft);
      draft.syncNote = undefined;
      for (const chunk of draft.chunks) {
        // A manual retry is a new attempt, so the rejection count starts again.
        chunk.ackRejections = undefined;
      }
    });
    await this.download(bookId);
  }

  /**
   * Removes a book from this device. If the server still holds the audio, it is deleted there too
   * (best effort: the server expires the job anyway).
   */
  async removeBook(bookId: string): Promise<{ serverDeleted: boolean }> {
    const book = this.deps.library.book(bookId);
    if (!book) {
      return { serverDeleted: false };
    }
    this.cancelled.add(bookId);
    try {
      // Wait for a running pass to notice the cancellation before deleting files under it.
      await this.passes.get(bookId);
      let serverDeleted = false;
      if (!book.serverReleased && !book.serverGone) {
        const token = await this.deps.tokens.load(bookId);
        if (token !== null) {
          try {
            await this.deps.clientFor(book.apiBaseUrl).deleteJob(bookId, token);
            serverDeleted = true;
          } catch {
            // The server removes unacknowledged jobs when their TTL expires.
          }
        }
      }
      // Remove the record first so no tracking loop can act on a half-deleted book.
      this.deps.library.remove(bookId);
      await this.deps.library.flush();
      await this.deps.audio.removeBook(bookId);
      await this.deps.tokens.remove(bookId);
      return { serverDeleted };
    } finally {
      this.cancelled.delete(bookId);
    }
  }

  // ------------------------------------------------------------------ tracking

  private async trackLoop(bookId: string): Promise<void> {
    const startedAt = this.now();
    for (;;) {
      const book = this.deps.library.book(bookId);
      if (this.disposed || !book || book.status !== 'processing') {
        return;
      }
      try {
        const token = await this.deps.tokens.load(bookId);
        if (token === null) {
          this.fail(bookId, 'synthesis', 'token_missing');
          return;
        }
        const job = await this.deps.clientFor(book.apiBaseUrl).getJob(bookId, token);
        if (job.status === 'ready') {
          this.deps.library.update(bookId, (draft) => {
            draft.status = 'downloading';
            draft.totalChunks = job.total_chunks;
            clearFailure(draft);
          });
          await this.download(bookId);
          return;
        }
        if (job.status === 'failed') {
          this.fail(bookId, 'synthesis', job.error?.code ?? 'internal_error', job.error?.message);
          return;
        }
      } catch (error) {
        this.handleTrackingError(bookId, 'synthesis', error);
        if (this.deps.library.book(bookId)?.status !== 'processing') {
          return;
        }
      }
      if (this.now() - startedAt > this.options.pollTimeoutMs) {
        return;
      }
      await this.deps.sleep(this.options.pollIntervalMs);
    }
  }

  private handleTrackingError(bookId: string, stage: FailureStage, error: unknown): void {
    if (isGone(error)) {
      this.fail(bookId, stage, 'job_not_found', undefined, true);
    } else if (isTransient(error)) {
      this.note(bookId, CONNECTION_NOTE);
    } else {
      this.fail(bookId, stage, codeOf(error), messageOf(error));
    }
  }

  // ------------------------------------------------------------------ download pass

  private async runDownload(bookId: string): Promise<void> {
    const initial = this.deps.library.book(bookId);
    if (!initial || initial.status === 'processing' || initial.status === 'failed') {
      return;
    }
    try {
      const token = await this.deps.tokens.load(bookId);
      if (token === null) {
        this.fail(bookId, 'download', 'token_missing');
        return;
      }
      await this.transfer(bookId, this.deps.clientFor(initial.apiBaseUrl), token);
    } catch (error) {
      this.handleDownloadError(bookId, error);
    }
  }

  private async transfer(bookId: string, client: SyncApi, token: string): Promise<void> {
    await this.verifyStoredFiles(bookId);
    const current = this.deps.library.book(bookId);
    if (!current) {
      return;
    }
    if (current.chunks.some((chunk) => chunk.state === 'failed' && chunk.lastError === 'file_missing')) {
      // The server deleted this part after acknowledgement, so the book cannot be completed.
      this.fail(bookId, 'download', 'file_missing');
      return;
    }
    if (current.chunks.length === 0 || this.pendingIndexes(bookId).length > 0) {
      await this.refreshManifest(bookId, client, token);
    }
    if (this.pendingIndexes(bookId).length > 0) {
      this.setStatus(bookId, 'downloading');
      for (const index of this.pendingIndexes(bookId)) {
        if (this.isStopped(bookId)) {
          return;
        }
        const outcome = await this.downloadPart(bookId, client, token, index);
        if (!outcome.stored) {
          if (this.isStopped(bookId)) {
            return;
          }
          const network = outcome.code === 'network' || outcome.code === 'timeout';
          this.note(bookId, network ? CONNECTION_NOTE : describeError(outcome.code));
          return;
        }
        if (this.unackedCount(bookId) >= this.options.progressiveAckBatchSize) {
          await this.acknowledgePending(bookId, client, token, {
            batchSize: this.options.progressiveAckBatchSize,
            untilDone: false,
          });
        }
      }
    }
    if (this.isStopped(bookId)) {
      return;
    }
    await this.acknowledgePending(bookId, client, token, {
      batchSize: this.options.maxAckBatchSize,
      untilDone: true,
    });
    this.deps.library.update(bookId, (draft) => {
      if (draft.status === 'failed') {
        // A failure recorded during this pass (for example, the server copy expired) must stay visible.
        return;
      }
      const complete = draft.chunks.length > 0 && draft.chunks.every((chunk) => chunk.state === 'stored');
      draft.status = complete ? 'ready' : 'downloading';
      if (!complete) {
        draft.syncNote = draft.syncNote ?? PARTS_MISSING_NOTE;
      } else if (draft.serverReleased || draft.chunks.every((chunk) => chunk.acked)) {
        draft.syncNote = undefined;
      }
    });
  }

  private handleDownloadError(bookId: string, error: unknown): void {
    if (error instanceof PermanentFailure && error.gone) {
      this.markServerGone(bookId);
    } else if (error instanceof PermanentFailure) {
      this.fail(bookId, 'download', error.code, error.message);
    } else if (isGone(error)) {
      this.markServerGone(bookId);
    } else if (isTransient(error)) {
      this.note(bookId, CONNECTION_NOTE);
    } else {
      this.fail(bookId, 'download', codeOf(error), messageOf(error));
    }
  }

  /**
   * The server deleted the job (TTL expired). Audio already on the device is kept: if every part is
   * stored, the book becomes ready; otherwise it fails with an explanation.
   */
  private markServerGone(bookId: string): void {
    const book = this.deps.library.book(bookId);
    if (!book) {
      return;
    }
    const complete = book.chunks.length > 0 && book.chunks.every((chunk) => chunk.state === 'stored');
    this.deps.library.update(bookId, (draft) => {
      draft.serverGone = true;
      draft.serverReleased = true;
      draft.syncNote = undefined;
      if (complete) {
        draft.status = 'ready';
        clearFailure(draft);
      } else {
        draft.status = 'failed';
        draft.failedStage = 'download';
        draft.errorCode = 'job_not_found';
        draft.errorMessage = describeError('job_not_found');
      }
    });
  }

  /** Fetches (or re-fetches) the manifest and merges part metadata. Stored parts are never touched. */
  private async refreshManifest(bookId: string, client: SyncApi, token: string): Promise<void> {
    const manifest = await client.getManifest(bookId, token);
    this.deps.library.update(bookId, (draft) => {
      draft.totalChunks = manifest.total_chunks;
      const byIndex = new Map<number, ChunkRecord>(draft.chunks.map((chunk) => [chunk.index, chunk]));
      for (const entry of manifest.chunks) {
        const existing = byIndex.get(entry.index);
        if (existing?.state === 'stored') {
          continue;
        }
        byIndex.set(entry.index, {
          index: entry.index,
          state: 'pending',
          sha256: entry.sha256,
          sizeBytes: entry.size_bytes,
          contentType: entry.content_type,
          acked: false,
          attempts: existing?.attempts ?? 0,
          // Kept across manifest refreshes, otherwise the rejection limit would never be reached.
          ackRejections: existing?.ackRejections,
        });
      }
      draft.chunks = [...byIndex.values()].sort((left, right) => left.index - right.index);
    });
  }

  /**
   * Downloads one part with retries. A transient failure that outlasts the attempts returns
   * `stored: false` and the pass pauses. A permanent failure throws PermanentFailure.
   */
  private async downloadPart(bookId: string, client: SyncApi, token: string, index: number): Promise<PartOutcome> {
    let lastCode = 'network';
    for (let attempt = 1; attempt <= this.options.maxAttemptsPerChunk; attempt += 1) {
      if (this.isStopped(bookId)) {
        // Removed or cancelled while waiting: stop before another request or write.
        return { stored: false, code: 'cancelled' };
      }
      this.patchPart(bookId, index, (part) => {
        part.state = 'downloading';
        part.attempts = attempt;
      });
      try {
        const part = this.partOf(bookId, index);
        const downloaded = await client.downloadChunk(bookId, token, index);
        await this.verifyBytes(downloaded, part);
        const relative = chunkRelativePath(bookId, index, part.contentType);
        try {
          await this.deps.audio.write(relative, downloaded.bytes);
        } catch {
          throw new PermanentFailure('storage_failed', undefined);
        }
        this.patchPart(bookId, index, (stored) => {
          stored.state = 'stored';
          stored.file = relative;
          stored.lastError = undefined;
        });
        // The stored state must be on disk before any acknowledgement can be sent.
        try {
          await this.deps.library.flush();
        } catch {
          throw new PermanentFailure('storage_failed', undefined);
        }
        return { stored: true };
      } catch (error) {
        lastCode = codeOf(error);
        this.patchPart(bookId, index, (part) => {
          part.state = 'failed';
          part.lastError = lastCode;
        });
        if (error instanceof PermanentFailure) {
          throw error;
        }
        if (!isTransient(error)) {
          throw new PermanentFailure(lastCode, messageOf(error), isGone(error));
        }
        if (attempt < this.options.maxAttemptsPerChunk) {
          await this.deps.sleep(this.options.retryBaseDelayMs * 2 ** (attempt - 1));
        }
      }
    }
    return { stored: false, code: lastCode };
  }

  private async verifyBytes(downloaded: DownloadedChunk, part: ChunkRecord): Promise<void> {
    if (part.sizeBytes > 0 && downloaded.bytes.byteLength !== part.sizeBytes) {
      throw new IntegrityFailure();
    }
    const digest = await this.deps.hash(downloaded.bytes);
    if (digest !== part.sha256) {
      throw new IntegrityFailure();
    }
    if (downloaded.sha256Header !== null && downloaded.sha256Header.toLowerCase() !== digest) {
      throw new IntegrityFailure();
    }
  }

  /** Checks that stored audio still exists. Lost audio is downloaded again unless it was already acknowledged. */
  private async verifyStoredFiles(bookId: string): Promise<void> {
    const book = this.deps.library.book(bookId);
    if (!book) {
      return;
    }
    const lost: number[] = [];
    for (const chunk of book.chunks) {
      if (chunk.state === 'stored' && chunk.file && !(await this.deps.audio.exists(chunk.file))) {
        lost.push(chunk.index);
      }
    }
    if (lost.length === 0) {
      return;
    }
    this.deps.library.update(bookId, (draft) => {
      for (const chunk of draft.chunks) {
        if (!lost.includes(chunk.index)) {
          continue;
        }
        chunk.file = undefined;
        if (chunk.acked) {
          // The server deleted this part after acknowledgement, so it cannot be fetched again.
          chunk.state = 'failed';
          chunk.lastError = 'file_missing';
          draft.syncNote = 'Some parts were removed from this device and cannot be recovered.';
        } else {
          chunk.state = 'pending';
        }
      }
    });
  }

  // ------------------------------------------------------------------ acknowledgement

  /**
   * Acknowledges stored parts so the server can delete them. Only parts that are on the device
   * are sent. A failed request leaves them unacknowledged for the next pass.
   */
  private async acknowledgePending(
    bookId: string,
    client: SyncApi,
    token: string,
    options: { batchSize: number; untilDone: boolean },
  ): Promise<void> {
    for (;;) {
      const book = this.deps.library.book(bookId);
      if (!book || book.serverGone || book.serverReleased) {
        return;
      }
      const batch = book.chunks
        .filter((chunk) => chunk.state === 'stored' && !chunk.acked && chunk.file !== undefined)
        .slice(0, options.batchSize);
      if (batch.length === 0) {
        return;
      }
      try {
        const result = await client.acknowledge(
          bookId,
          token,
          batch.map((chunk) => ({ index: chunk.index, sha256: chunk.sha256 })),
        );
        const indexes = new Set(batch.map((chunk) => chunk.index));
        this.deps.library.update(bookId, (draft) => {
          for (const chunk of draft.chunks) {
            if (indexes.has(chunk.index)) {
              chunk.acked = true;
            }
          }
          if (result.job_deleted) {
            draft.serverReleased = true;
          }
        });
        if (result.job_deleted || !options.untilDone) {
          return;
        }
      } catch (error) {
        this.handleAckError(bookId, batch.map((chunk) => chunk.index), error);
        return;
      }
    }
  }

  private handleAckError(bookId: string, indexes: number[], error: unknown): void {
    if (isGone(error)) {
      // The server copy no longer exists. Audio already on this device is kept.
      this.markServerGone(bookId);
      return;
    }
    if (isApiError(error, 'chunk_not_found')) {
      // The server already deleted these parts (for example, an earlier acknowledgement was lost).
      this.deps.library.update(bookId, (draft) => {
        for (const chunk of draft.chunks) {
          if (indexes.includes(chunk.index)) {
            chunk.acked = true;
          }
        }
      });
      return;
    }
    if (isApiError(error, 'chunk_not_ready')) {
      this.note(bookId, describeError('chunk_not_ready'));
      return;
    }
    if (isApiError(error, 'checksum_mismatch')) {
      // The server disagrees with the checksum we stored. Discard those parts and download them again,
      // but only a limited number of times: a server that keeps rejecting them makes the book fail, so
      // the user decides (retry or remove) instead of the app re-downloading on every pass.
      this.deps.library.update(bookId, (draft) => {
        let exhausted = false;
        for (const chunk of draft.chunks) {
          if (indexes.includes(chunk.index)) {
            chunk.ackRejections = (chunk.ackRejections ?? 0) + 1;
            exhausted = exhausted || chunk.ackRejections >= MAX_ACK_REJECTIONS;
          }
        }
        for (const chunk of draft.chunks) {
          if (indexes.includes(chunk.index)) {
            chunk.state = exhausted ? 'failed' : 'pending';
            chunk.file = undefined;
            chunk.lastError = 'checksum_mismatch';
          }
        }
        if (exhausted) {
          draft.status = 'failed';
          draft.failedStage = 'download';
          draft.errorCode = 'checksum_rejected';
          draft.errorMessage = describeError('checksum_rejected');
          draft.syncNote = undefined;
          return;
        }
        draft.status = 'downloading';
        draft.syncNote = describeError('checksum_mismatch');
      });
      return;
    }
    if (isTransient(error)) {
      this.note(bookId, CONNECTION_NOTE);
      return;
    }
    this.note(bookId, describeError(codeOf(error), messageOf(error)));
  }

  // ------------------------------------------------------------------ helpers

  /** True when a pass must stop: the book was removed, cancelled, or the server copy is gone. */
  private isStopped(bookId: string): boolean {
    const book = this.deps.library.book(bookId);
    return this.disposed || !book || this.cancelled.has(bookId) || book.serverGone;
  }

  private needsWork(book: BookRecord): boolean {
    if (book.status === 'downloading') {
      return true;
    }
    if (book.status !== 'ready' || book.serverGone || book.serverReleased) {
      return false;
    }
    return book.chunks.some((chunk) => chunk.state === 'stored' && !chunk.acked);
  }

  private pendingIndexes(bookId: string): number[] {
    const book = this.deps.library.book(bookId);
    return book
      ? book.chunks
          .filter((chunk) => chunk.state !== 'stored')
          .map((chunk) => chunk.index)
          .sort((left, right) => left - right)
      : [];
  }

  private unackedCount(bookId: string): number {
    const book = this.deps.library.book(bookId);
    return book ? book.chunks.filter((chunk) => chunk.state === 'stored' && !chunk.acked).length : 0;
  }

  private partOf(bookId: string, index: number): ChunkRecord {
    const part = this.deps.library.book(bookId)?.chunks.find((chunk) => chunk.index === index);
    if (!part) {
      throw new PermanentFailure('invalid_state', 'Part metadata is missing.');
    }
    return part;
  }

  private patchPart(bookId: string, index: number, change: (part: ChunkRecord) => void): void {
    this.deps.library.update(bookId, (draft) => {
      const part = draft.chunks.find((chunk) => chunk.index === index);
      if (part) {
        change(part);
      }
    });
  }

  private setStatus(bookId: string, status: BookStatus): void {
    const book = this.deps.library.book(bookId);
    if (book && book.status !== status) {
      this.deps.library.update(bookId, (draft) => {
        draft.status = status;
      });
    }
  }

  private note(bookId: string, text: string): void {
    this.deps.library.update(bookId, (draft) => {
      draft.syncNote = text;
    });
  }

  private fail(bookId: string, stage: FailureStage, code: string, message?: string, gone = false): void {
    this.deps.library.update(bookId, (draft) => {
      draft.status = 'failed';
      draft.failedStage = stage;
      draft.errorCode = code;
      draft.errorMessage = describeError(code, message);
      draft.syncNote = undefined;
      if (gone) {
        draft.serverGone = true;
      }
    });
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
}

function clearFailure(book: BookRecord): void {
  book.failedStage = undefined;
  book.errorCode = undefined;
  book.errorMessage = undefined;
}
