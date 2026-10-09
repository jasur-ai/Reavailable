import { createHash, randomUUID } from 'node:crypto';
import {
  ApiError,
  type AckResultDto,
  type CreateJobInput,
  type DownloadedChunk,
  type JobCreatedDto,
  type JobStatusDto,
  type ManifestDto,
} from '../../../src/core/api/client';
import type { SyncApi } from '../../../src/core/sync/syncEngine';

type Op = 'createJob' | 'getJob' | 'getManifest' | 'downloadChunk' | 'acknowledge' | 'retryJob' | 'deleteJob';

interface Fault {
  op: Op;
  index?: number;
  error: Error;
  times: number;
}

interface FakeChunk {
  index: number;
  bytes: Uint8Array;
  sha256: string;
  status: 'ready' | 'acked' | 'failed';
}

interface FakeJob {
  id: string;
  token: string;
  title: string;
  voice: string;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  error: { code: string; message: string } | null;
  chunks: FakeChunk[];
}

/**
 * In-memory stand-in for the backend. It follows the same rules as the real service:
 * the manifest lists only ready, unacknowledged chunks; acknowledgements are validated before any
 * change and are idempotent; the job is deleted when every chunk is acknowledged; unknown or
 * foreign jobs answer job_not_found.
 */
export class FakeServer implements SyncApi {
  readonly baseUrl = 'https://server.test';
  /** Jobs become ready as soon as they are created (set false to control synthesis manually). */
  autoReady = true;
  /** Successful chunk downloads per index. */
  readonly downloads = new Map<number, number>();
  /** Indexes for which the server returns corrupted bytes (the announced checksum stays correct). */
  readonly corruptIndexes = new Set<number>();
  /** Called right before an acknowledgement changes server state. */
  onAcknowledge: ((jobId: string, indexes: number[]) => void) | null = null;
  private readonly faults: Fault[] = [];
  private readonly jobs = new Map<string, FakeJob>();

  /** Makes the next `times` calls to `op` (optionally for one chunk) fail with `error`. */
  injectFault(op: Op, error: Error, times = 1, index?: number): void {
    this.faults.push({ op, error, times, index });
  }

  clearFaults(): void {
    this.faults.length = 0;
  }

  finishSynthesis(jobId: string): void {
    const job = this.requireJob(jobId);
    job.status = 'ready';
  }

  failSynthesis(jobId: string, code: string, message = 'The speech service failed.'): void {
    const job = this.requireJob(jobId);
    job.status = 'failed';
    job.error = { code, message };
  }

  /** Simulates the TTL purge: the job disappears without warning. */
  expire(jobId: string): void {
    this.jobs.delete(jobId);
  }

  hasJob(jobId: string): boolean {
    return this.jobs.has(jobId);
  }

  jobChunkStatuses(jobId: string): string[] {
    return this.requireJob(jobId).chunks.map((chunk) => chunk.status);
  }

  totalDownloads(): number {
    return [...this.downloads.values()].reduce((sum, count) => sum + count, 0);
  }

  async createJob(input: CreateJobInput): Promise<JobCreatedDto> {
    this.takeFault('createJob');
    const id = randomUUID();
    const token = randomUUID().replace(/-/g, '') + randomUUID().replace(/-/g, '');
    const lines = input.transcript
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const chunks: FakeChunk[] = lines.map((line, index) => {
      const bytes = new TextEncoder().encode(`mp3:${id}:${index}:${line}`.padEnd(120, '.'));
      return { index, bytes, sha256: sha256Hex(bytes), status: 'ready' };
    });
    const job: FakeJob = {
      id,
      token,
      title: input.title,
      voice: input.voice ?? 'uz-UZ-MadinaNeural',
      status: this.autoReady ? 'ready' : 'processing',
      error: null,
      chunks,
    };
    this.jobs.set(id, job);
    return {
      id,
      status: job.status,
      title: job.title,
      voice: job.voice,
      total_chunks: chunks.length,
      warnings: [],
      expires_at: '2099-01-01T00:00:00Z',
      access_token: token,
    };
  }

  async getJob(jobId: string, token: string): Promise<JobStatusDto> {
    this.takeFault('getJob');
    const job = this.authorize(jobId, token);
    return {
      id: job.id,
      status: job.status,
      title: job.title,
      voice: job.voice,
      total_chunks: job.chunks.length,
      ready_chunks: job.chunks.filter((chunk) => chunk.status === 'ready').length,
      acked_chunks: job.chunks.filter((chunk) => chunk.status === 'acked').length,
      failed_chunks: job.chunks.filter((chunk) => chunk.status === 'failed').length,
      error: job.error,
      warnings: [],
      created_at: '2026-10-09T00:00:00Z',
      expires_at: '2099-01-01T00:00:00Z',
    };
  }

  async getManifest(jobId: string, token: string): Promise<ManifestDto> {
    this.takeFault('getManifest');
    const job = this.authorize(jobId, token);
    this.requireReady(job);
    return {
      job_id: job.id,
      title: job.title,
      total_chunks: job.chunks.length,
      chunks: job.chunks
        .filter((chunk) => chunk.status === 'ready')
        .map((chunk) => ({
          index: chunk.index,
          char_count: 0,
          content_type: 'audio/mpeg',
          size_bytes: chunk.bytes.byteLength,
          sha256: chunk.sha256,
          url: `/api/v1/jobs/${job.id}/chunks/${chunk.index}`,
        })),
    };
  }

  async downloadChunk(jobId: string, token: string, index: number): Promise<DownloadedChunk> {
    this.takeFault('downloadChunk', index);
    const job = this.authorize(jobId, token);
    this.requireReady(job);
    const chunk = job.chunks.find((candidate) => candidate.index === index);
    if (!chunk || chunk.status !== 'ready') {
      throw new ApiError(404, 'chunk_unavailable', 'The chunk is not available for download.');
    }
    this.downloads.set(index, (this.downloads.get(index) ?? 0) + 1);
    const bytes = this.corruptIndexes.has(index) ? flipFirstByte(chunk.bytes) : chunk.bytes;
    return { bytes, sha256Header: chunk.sha256, contentType: 'audio/mpeg' };
  }

  async acknowledge(
    jobId: string,
    token: string,
    items: readonly { index: number; sha256: string }[],
  ): Promise<AckResultDto> {
    this.takeFault('acknowledge');
    const job = this.authorize(jobId, token);
    this.requireReady(job);
    for (const item of items) {
      const chunk = job.chunks.find((candidate) => candidate.index === item.index);
      if (!chunk) {
        throw new ApiError(404, 'chunk_not_found', `Chunk ${item.index} does not exist.`);
      }
      if (chunk.status !== 'ready' && chunk.status !== 'acked') {
        throw new ApiError(409, 'chunk_not_ready', `Chunk ${item.index} is not ready.`);
      }
      if (chunk.sha256 !== item.sha256) {
        throw new ApiError(409, 'checksum_mismatch', `Checksum mismatch for chunk ${item.index}.`);
      }
    }
    const indexes = [...new Set(items.map((item) => item.index))].sort((left, right) => left - right);
    this.onAcknowledge?.(jobId, indexes);
    for (const item of items) {
      const chunk = job.chunks.find((candidate) => candidate.index === item.index);
      if (chunk) {
        chunk.status = 'acked';
      }
    }
    const remaining = job.chunks.filter((chunk) => chunk.status !== 'acked').length;
    if (remaining === 0) {
      this.jobs.delete(jobId);
    }
    return { acknowledged: indexes, remaining, job_deleted: remaining === 0 };
  }

  async retryJob(jobId: string, token: string): Promise<JobStatusDto> {
    this.takeFault('retryJob');
    const job = this.authorize(jobId, token);
    if (job.status !== 'failed') {
      throw new ApiError(409, 'job_not_failed', 'Only failed jobs can be retried.');
    }
    job.status = 'queued';
    job.error = null;
    if (this.autoReady) {
      job.status = 'ready';
    }
    return this.getJob(jobId, token);
  }

  async deleteJob(jobId: string, token: string): Promise<void> {
    this.takeFault('deleteJob');
    this.authorize(jobId, token);
    this.jobs.delete(jobId);
  }

  private authorize(jobId: string, token: string): FakeJob {
    const job = this.jobs.get(jobId);
    if (!job || job.token !== token) {
      throw new ApiError(404, 'job_not_found', 'The job does not exist.');
    }
    return job;
  }

  private requireReady(job: FakeJob): void {
    if (job.status !== 'ready') {
      throw new ApiError(409, 'job_not_ready', 'The job is not ready yet.');
    }
  }

  private requireJob(jobId: string): FakeJob {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`no such job ${jobId}`);
    }
    return job;
  }

  private takeFault(op: Op, index?: number): void {
    const fault = this.faults.find(
      (candidate) => candidate.op === op && candidate.times > 0 && (candidate.index === undefined || candidate.index === index),
    );
    if (fault) {
      fault.times -= 1;
      throw fault.error;
    }
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function flipFirstByte(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes);
  copy[0] = (copy[0] ?? 0) ^ 0xff;
  return copy;
}
