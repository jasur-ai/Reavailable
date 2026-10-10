/**
 * Core business logic: job lifecycle, speech synthesis, delete-after-acknowledgement and retention.
 *
 * The Worker has no long-lived process, so synthesis advances in *passes*. A pass takes a lease on
 * the job, synthesizes as many parts as its wall-clock budget allows, stores them in R2 and updates
 * D1. The app polls the job status every couple of seconds, and each poll schedules another pass, so
 * a book completes while the user watches the progress. If a pass is cut short by the platform, the
 * lease expires and the next pass continues where it stopped.
 *
 * Job lifecycle: queued -> processing -> ready -> removed (acknowledged or deleted).
 * Chunk lifecycle: pending -> ready -> acked. Failed chunks return to pending on retry.
 */

import { KvAudioStore } from './audio';
import type { Settings } from './config';
import { buildChunks, hasCyrillic } from './chunking';
import { JobStore } from './db';
import { conflict, internal, notFound, payloadTooLarge, validationFailed } from './errors';
import { newAccessToken, newJobId, sha256Hex, tokenMatches } from './security';
import { TtsError, type SynthesisResult, type TtsProvider } from './tts';
import type { AckOutcome, ChunkRow, Env, JobRow, JobView, ManifestEntry, ManifestView } from './types';

export const MAX_TITLE_CHARS = 200;

export const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  tts_auth_failed: 'The speech provider rejected the service credentials. Contact the operator.',
  tts_bad_request: 'The speech provider rejected part of the text. Fix the transcript and retry.',
  tts_unavailable: 'The speech provider is temporarily unavailable. Retry later.',
  internal_error: 'An unexpected error stopped synthesis. Retry later.',
};

export interface ServiceOptions {
  env: Env;
  settings: Settings;
  tts: TtsProvider;
  /** Epoch milliseconds, injectable for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
  newToken?: () => string;
}

export interface CreateJobInput {
  title: string;
  transcript: string;
  sentencesPerChunk: number;
  voice?: string | null;
}

export interface ReadChunkResult {
  body: ReadableStream;
  contentType: string;
  sha256: string;
  sizeBytes: number;
}

export interface PumpOptions {
  /** Wall-clock budget for this pass. */
  budgetMs?: number;
  /** Hard cap on parts synthesized in this pass. */
  maxChunks?: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function iso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/** R2 key of one part: "<job id>/<position>.<extension>". */
export function audioKey(jobId: string, position: number, extension: string): string {
  return `${jobId}/${String(position).padStart(6, '0')}.${extension}`;
}

export class JobService {
  private readonly store: JobStore;
  private readonly settings: Settings;
  private readonly tts: TtsProvider;
  private readonly audio: KvAudioStore;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly newId: () => string;
  private readonly newToken: () => string;

  constructor(options: ServiceOptions) {
    this.store = new JobStore(options.env.DB);
    this.audio = new KvAudioStore(options.env.AUDIO);
    this.settings = options.settings;
    this.tts = options.tts;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.newId = options.newId ?? newJobId;
    this.newToken = options.newToken ?? newAccessToken;
  }

  // ------------------------------------------------------------------ creation

  /** Validate and store a new transcript. Returns the job view and its one-time access token. */
  async createJob(input: CreateJobInput): Promise<{ view: JobView; token: string }> {
    const title = collapseSpaces(input.title).slice(0, MAX_TITLE_CHARS);
    if (!title) {
      throw validationFailed('Title must not be blank.', 'invalid_title');
    }
    if (input.transcript.length > this.settings.maxTranscriptChars) {
      throw payloadTooLarge(
        `Transcript exceeds the limit of ${this.settings.maxTranscriptChars} characters.`,
        'transcript_too_long',
      );
    }
    const voice = input.voice?.trim() ? input.voice.trim() : this.settings.defaultVoice;
    if (!this.tts.allowedVoices.includes(voice)) {
      throw validationFailed('The requested voice is not available.', 'unsupported_voice');
    }

    const segments = buildChunks(input.transcript, {
      sentencesPerChunk: input.sentencesPerChunk,
      maxChunkChars: this.settings.maxChunkChars,
    });
    if (segments.length === 0) {
      throw validationFailed('The transcript contains no readable text.', 'empty_transcript');
    }
    if (segments.length > this.settings.maxChunksPerJob) {
      throw validationFailed(
        `The transcript would produce ${segments.length} chunks; the limit is ${this.settings.maxChunksPerJob}.`,
        'too_many_chunks',
      );
    }

    const warnings = hasCyrillic(input.transcript) ? ['cyrillic_text'] : [];
    const token = this.newToken();
    const createdAt = this.now();
    const id = this.newId();
    await this.store.insertJob(
      {
        id,
        tokenHash: await sha256Hex(token),
        title,
        voice,
        sentencesPerChunk: input.sentencesPerChunk,
        status: 'queued',
        warnings: JSON.stringify(warnings),
        createdAt: iso(createdAt),
        updatedAt: iso(createdAt),
        expiresAt: iso(createdAt + this.settings.jobTtlHours * 3_600_000),
        totalChunks: segments.length,
      },
      segments.map((text, position) => ({ position, text })),
    );

    const job = await this.store.getJob(id);
    if (!job) {
      throw internal('The job could not be stored.');
    }
    return { view: await this.view(job), token };
  }

  // ------------------------------------------------------------------ queries

  async getJob(jobId: string, token: string): Promise<JobView> {
    return this.view(await this.authorize(jobId, token));
  }

  /** List the parts that are ready to download and not yet acknowledged. */
  async getManifest(jobId: string, token: string): Promise<ManifestView> {
    const job = await this.authorize(jobId, token);
    if (job.status !== 'ready') {
      throw conflict('The job is not ready yet.', 'job_not_ready');
    }
    const chunks = await this.store.chunks(jobId);
    const entries: ManifestEntry[] = chunks.filter((chunk) => chunk.status === 'ready').map(toEntry);
    return { title: job.title, total_chunks: chunks.length, entries };
  }

  /** Stream one part's audio. The stored checksum is returned so the device can verify the bytes. */
  async readChunk(jobId: string, token: string, position: number): Promise<ReadChunkResult> {
    const job = await this.authorize(jobId, token);
    if (job.status !== 'ready') {
      throw conflict('The job is not ready yet.', 'job_not_ready');
    }
    const chunk = await this.store.chunk(jobId, position);
    if (!chunk) {
      throw notFound('Chunk not found.', 'chunk_not_found');
    }
    if (chunk.status !== 'ready' || !chunk.sha256) {
      throw notFound('The chunk is not available for download.', 'chunk_unavailable');
    }
    const stored = await this.audio.get(r2KeyForChunk(jobId, chunk));
    if (!stored) {
      throw notFound('The chunk is not available for download.', 'chunk_unavailable');
    }
    return {
      body: stored.body,
      contentType: chunk.content_type ?? stored.httpMetadata?.contentType ?? 'application/octet-stream',
      sha256: chunk.sha256,
      sizeBytes: chunk.size_bytes ?? stored.size,
    };
  }

  // ------------------------------------------------------------------ mutations

  /**
   * Delete the audio of parts the device has stored and verified. Every item is validated before
   * anything changes, so a bad checksum never deletes partial data. Repeating an acknowledgement
   * with the same checksum is harmless.
   */
  async acknowledge(
    jobId: string,
    token: string,
    items: readonly { index: number; sha256: string }[],
  ): Promise<AckOutcome> {
    const job = await this.authorize(jobId, token);
    if (job.status !== 'ready') {
      throw conflict('The job is not ready for acknowledgement.', 'job_not_ready');
    }
    const chunks = await this.store.chunks(jobId);
    const byPosition = new Map(chunks.map((chunk) => [chunk.position, chunk]));

    const toRelease: ChunkRow[] = [];
    for (const item of items) {
      const chunk = byPosition.get(item.index);
      if (!chunk) {
        throw notFound('Chunk not found.', 'chunk_not_found');
      }
      if (chunk.status !== 'ready' && chunk.status !== 'acked') {
        throw conflict(`Chunk ${item.index} is not ready.`, 'chunk_not_ready');
      }
      if (!chunk.sha256 || chunk.sha256 !== item.sha256) {
        throw conflict(`Checksum mismatch for chunk ${item.index}.`, 'checksum_mismatch');
      }
      if (chunk.status === 'ready') {
        toRelease.push(chunk);
      }
    }

    const keys = toRelease.map((chunk) => r2KeyForChunk(jobId, chunk));
    await this.store.ackChunks(
      jobId,
      toRelease.map((chunk) => chunk.position),
    );
    if (keys.length > 0) {
      await this.audio.delete(keys);
    }

    const remaining = chunks.filter((chunk) => chunk.status !== 'acked').length - toRelease.length;
    const jobDeleted = remaining <= 0;
    if (jobDeleted) {
      await this.store.deleteJobRows(jobId);
      await this.deleteAudio(jobId);
    }
    return {
      acknowledged: [...new Set(items.map((item) => item.index))].sort((a, b) => a - b),
      remaining: Math.max(remaining, 0),
      job_deleted: jobDeleted,
    };
  }

  /** Re-queue a failed job. Only the parts that failed are synthesized again. */
  async retryJob(jobId: string, token: string): Promise<JobView> {
    const job = await this.authorize(jobId, token);
    if (job.status !== 'failed') {
      throw conflict('Only failed jobs can be retried.', 'job_not_failed');
    }
    await this.store.requeueFailed(jobId);
    await this.store.setStatus(jobId, 'queued', null, iso(this.now()));
    return this.getJob(jobId, token);
  }

  async deleteJob(jobId: string, token: string): Promise<void> {
    await this.authorize(jobId, token);
    await this.store.deleteJobRows(jobId);
    await this.deleteAudio(jobId);
  }

  // ------------------------------------------------------------------ background work

  /**
   * Synthesize as many pending parts as the budget allows. Never throws: a failure is recorded on
   * the job so the device can see and retry it.
   */
  async pump(jobId: string, options: PumpOptions = {}): Promise<void> {
    const startedAt = this.now();
    const budgetMs = options.budgetMs ?? this.settings.passBudgetMs;
    const maxChunks = options.maxChunks ?? this.settings.chunksPerPass;
    const claimed = await this.store.claimLease(jobId, iso(startedAt + this.settings.leaseMs), iso(startedAt));
    if (!claimed) {
      return;
    }
    try {
      const job = await this.store.getJob(jobId);
      if (!job) {
        return;
      }
      const pending = await this.store.pendingChunks(jobId, maxChunks);
      if (pending.length === 0) {
        await this.store.setStatus(jobId, 'ready', null, iso(this.now()));
        return;
      }

      const queue = [...pending];
      let failure: { code: string; message: string } | null = null;
      const concurrency = Math.min(this.settings.ttsConcurrency, queue.length);
      const worker = async (): Promise<void> => {
        for (;;) {
          if (failure || queue.length === 0 || this.now() - startedAt >= budgetMs) {
            return;
          }
          const chunk = queue.shift();
          if (!chunk) {
            return;
          }
          try {
            const { result, attempts } = await this.synthesizeWithRetry(chunk.text ?? '', job.voice);
            const digest = await sha256Hex(result.audio);
            await this.audio.put(audioKey(jobId, chunk.position, result.extension), result.audio, {
              httpMetadata: { contentType: result.contentType },
            });
            await this.store.markChunkReady(jobId, chunk.position, {
              contentType: result.contentType,
              sizeBytes: result.audio.byteLength,
              sha256: digest,
              attempts,
            });
          } catch (error) {
            const { code, message } = classify(error);
            await this.store.markChunkFailed(jobId, chunk.position, code, (chunk.attempts ?? 0) + 1);
            failure = failure ?? { code, message };
          }
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => worker()));

      if (failure) {
        await this.store.setStatus(jobId, 'failed', failure, iso(this.now()));
        return;
      }
      const left = await this.store.countPending(jobId);
      await this.store.setStatus(jobId, left === 0 ? 'ready' : 'processing', null, iso(this.now()));
    } catch (error) {
      // Storage or platform trouble: leave the job in `processing`. The lease expires and the next
      // pass picks it up again, so no part is lost and the device keeps polling.
      await this.store
        .setStatus(jobId, 'processing', null, iso(this.now()))
        .catch(() => undefined);
      console.error('pump failed', { jobId, message: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Delete jobs past their TTL and any audio left behind without a job row. */
  async purgeExpired(): Promise<{ expired: number; orphaned: number }> {
    const now = iso(this.now());
    const expired = await this.store.expiredJobIds(now);
    for (const jobId of expired) {
      await this.store.deleteJobRows(jobId);
      await this.deleteAudio(jobId);
    }

    const live = await this.store.knownJobIds(5_000);
    let orphaned = 0;
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const listed = await this.audio.list({ prefix: '', cursor, limit: 1000 });
      const stale = listed.objects
        .filter((object) => !live.has(object.key.split('/')[0]))
        .map((object) => object.key);
      for (let start = 0; start < stale.length; start += 500) {
        await this.audio.delete(stale.slice(start, start + 500));
      }
      orphaned += stale.length;
      if (!listed.truncated) {
        break;
      }
      cursor = listed.cursor;
    }
    return { expired: expired.length, orphaned };
  }

  // ------------------------------------------------------------------ internals

  private async synthesizeWithRetry(text: string, voice: string): Promise<{ result: SynthesisResult; attempts: number }> {
    let attempts = 0;
    for (;;) {
      attempts += 1;
      try {
        const result = await this.tts.synthesize(text, voice);
        if (result.audio.byteLength === 0) {
          throw new TtsError('tts_unavailable', 'Speech provider returned empty audio.', true);
        }
        return { result, attempts };
      } catch (error) {
        if (error instanceof TtsError && error.transient && attempts < this.settings.ttsMaxAttempts) {
          await this.sleep(this.settings.ttsRetryBaseDelayMs * 2 ** (attempts - 1));
          continue;
        }
        throw error;
      }
    }
  }

  /** Load a job the caller may access. Unknown, expired and foreign jobs all look identical. */
  private async authorize(jobId: string, token: string): Promise<JobRow> {
    const job = await this.store.getJob(jobId);
    if (!job || job.expires_at <= iso(this.now()) || !(await tokenMatches(job.token_hash, token))) {
      throw notFound('Job not found.', 'job_not_found');
    }
    return job;
  }

  private async view(job: JobRow): Promise<JobView> {
    const counts = await this.store.counts(job.id);
    return {
      id: job.id,
      status: job.status,
      title: job.title,
      voice: job.voice,
      total_chunks: job.total_chunks || counts.total,
      ready_chunks: counts.ready,
      acked_chunks: counts.acked,
      failed_chunks: counts.failed,
      error: job.error_code ? { code: job.error_code, message: job.error_message ?? '' } : null,
      warnings: parseWarnings(job.warnings),
      created_at: job.created_at,
      expires_at: job.expires_at,
    };
  }

  /** Remove every object stored for a job. */
  private async deleteAudio(jobId: string): Promise<void> {
    let cursor: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const listed = await this.audio.list({ prefix: `${jobId}/`, cursor, limit: 1000 });
      const keys = listed.objects.map((object) => object.key);
      for (let start = 0; start < keys.length; start += 500) {
        await this.audio.delete(keys.slice(start, start + 500));
      }
      if (!listed.truncated) {
        return;
      }
      cursor = listed.cursor;
    }
  }
}

/** The stored extension is not in D1; it is part of the object key. */
function r2KeyForChunk(jobId: string, chunk: ChunkRow): string {
  const contentType = chunk.content_type ?? '';
  const extension =
    contentType === 'audio/mpeg' ? 'mp3' : contentType === 'audio/ogg' ? 'ogg' : contentType === 'audio/wav' ? 'wav' : 'bin';
  return audioKey(jobId, chunk.position, extension);
}

function toEntry(chunk: ChunkRow): ManifestEntry {
  return {
    index: chunk.position,
    char_count: chunk.char_count,
    content_type: chunk.content_type ?? 'application/octet-stream',
    size_bytes: chunk.size_bytes ?? 0,
    sha256: chunk.sha256 ?? '',
  };
}

function classify(error: unknown): { code: string; message: string } {
  if (error instanceof TtsError) {
    return { code: error.code, message: ERROR_MESSAGES[error.code] ?? ERROR_MESSAGES.internal_error };
  }
  return { code: 'internal_error', message: ERROR_MESSAGES.internal_error };
}

function parseWarnings(raw: string | null): string[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

export function collapseSpaces(value: string): string {
  return value.split(/\s+/).filter((part) => part.length > 0).join(' ');
}
