/**
 * D1 data access. All SQL lives here, so the service layer stays about rules rather than queries.
 *
 * Timestamps are ISO-8601 UTC strings (`2026-10-10T06:30:47.245Z`). Because every value uses the
 * same fixed format and the same zone, plain string comparison orders them correctly, which keeps
 * TTL and lease checks inside SQL.
 */

import type { ChunkRow, ChunkStatus, JobRow, JobStatus } from './types';

export interface NewJob {
  id: string;
  tokenHash: string;
  title: string;
  voice: string;
  sentencesPerChunk: number;
  status: JobStatus;
  warnings: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  totalChunks: number;
}

export interface NewChunk {
  position: number;
  text: string;
}

export interface ChunkCounts {
  pending: number;
  ready: number;
  failed: number;
  acked: number;
  total: number;
}

/** Rows inserted per statement and statements per D1 batch, kept small to respect D1 limits. */
const ROWS_PER_INSERT = 10;
const STATEMENTS_PER_BATCH = 10;

export class JobStore {
  constructor(private readonly db: D1Database) {}

  /** Insert a job and every one of its chunk rows. Chunk text is stored until it is acknowledged. */
  async insertJob(job: NewJob, chunks: readonly NewChunk[]): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO jobs (id, token_hash, title, voice, sentences_per_chunk, status, error_code, error_message,
                            warnings, created_at, updated_at, expires_at, lease_until, total_chunks)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, ?7, ?8, ?9, ?10, NULL, ?11)`,
      )
      .bind(
        job.id,
        job.tokenHash,
        job.title,
        job.voice,
        job.sentencesPerChunk,
        job.status,
        job.warnings,
        job.createdAt,
        job.updatedAt,
        job.expiresAt,
        job.totalChunks,
      )
      .run();

    for (let start = 0; start < chunks.length; start += ROWS_PER_INSERT * STATEMENTS_PER_BATCH) {
      const group = chunks.slice(start, start + ROWS_PER_INSERT * STATEMENTS_PER_BATCH);
      const statements: D1PreparedStatement[] = [];
      for (let offset = 0; offset < group.length; offset += ROWS_PER_INSERT) {
        const rows = group.slice(offset, offset + ROWS_PER_INSERT);
        const placeholders = rows.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
        const values: (string | number)[] = [];
        for (const row of rows) {
          values.push(job.id, row.position, row.text, row.text.length, 'pending', 0);
        }
        statements.push(
          this.db
            .prepare(
              `INSERT INTO chunks (job_id, position, text, char_count, status, attempts) VALUES ${placeholders}`,
            )
            .bind(...values),
        );
      }
      await this.db.batch(statements);
    }
  }

  async getJob(id: string): Promise<JobRow | null> {
    return this.db.prepare('SELECT * FROM jobs WHERE id = ?1').bind(id).first<JobRow>();
  }

  async counts(id: string): Promise<ChunkCounts> {
    const rows = await this.db
      .prepare('SELECT status, COUNT(*) AS total FROM chunks WHERE job_id = ?1 GROUP BY status')
      .bind(id)
      .all<{ status: ChunkStatus; total: number }>();
    const counts: ChunkCounts = { pending: 0, ready: 0, failed: 0, acked: 0, total: 0 };
    for (const row of rows.results ?? []) {
      counts[row.status] = row.total;
      counts.total += row.total;
    }
    return counts;
  }

  /**
   * Take exclusive ownership of a job that still needs synthesis. Returns false when another pass
   * holds the lease, or when the job is already finished. An expired lease can be taken over, so a
   * pass that was cut short by the platform never blocks a job for good.
   */
  async claimLease(id: string, leaseUntil: string, now: string): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE jobs SET status = 'processing', lease_until = ?1, updated_at = ?2,
                         error_code = NULL, error_message = NULL
         WHERE id = ?3 AND status IN ('queued', 'processing')
           AND (lease_until IS NULL OR lease_until < ?4)`,
      )
      .bind(leaseUntil, now, id, now)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  /** Set the job status and always drop the lease, so the next pass can continue. */
  async setStatus(
    id: string,
    status: JobStatus,
    error: { code: string; message: string } | null,
    now: string,
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE jobs SET status = ?1, error_code = ?2, error_message = ?3, lease_until = NULL, updated_at = ?4
         WHERE id = ?5`,
      )
      .bind(status, error?.code ?? null, error?.message?.slice(0, 300) ?? null, now, id)
      .run();
  }

  async pendingChunks(id: string, limit: number): Promise<ChunkRow[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM chunks WHERE job_id = ?1 AND status = 'pending' AND text IS NOT NULL
         ORDER BY position LIMIT ?2`,
      )
      .bind(id, limit)
      .all<ChunkRow>();
    return rows.results ?? [];
  }

  async countPending(id: string): Promise<number> {
    const row = await this.db
      .prepare("SELECT COUNT(*) AS total FROM chunks WHERE job_id = ?1 AND status = 'pending'")
      .bind(id)
      .first<{ total: number }>();
    return row?.total ?? 0;
  }

  async chunks(id: string): Promise<ChunkRow[]> {
    const rows = await this.db
      .prepare('SELECT * FROM chunks WHERE job_id = ?1 ORDER BY position')
      .bind(id)
      .all<ChunkRow>();
    return rows.results ?? [];
  }

  async chunk(id: string, position: number): Promise<ChunkRow | null> {
    return this.db
      .prepare('SELECT * FROM chunks WHERE job_id = ?1 AND position = ?2')
      .bind(id, position)
      .first<ChunkRow>();
  }

  /** Record finished audio. The transcript text is dropped because it is no longer needed. */
  async markChunkReady(
    id: string,
    position: number,
    ready: { contentType: string; sizeBytes: number; sha256: string; attempts: number },
  ): Promise<void> {
    await this.db
      .prepare(
        `UPDATE chunks SET status = 'ready', content_type = ?1, size_bytes = ?2, sha256 = ?3, attempts = ?4,
                           text = NULL, last_error = NULL
         WHERE job_id = ?5 AND position = ?6`,
      )
      .bind(ready.contentType, ready.sizeBytes, ready.sha256, ready.attempts, id, position)
      .run();
  }

  /**
   * Record a failed part. The text is kept so a retry can synthesize the same part again; it is
   * dropped when the part is acknowledged or the job is deleted.
   */
  async markChunkFailed(id: string, position: number, code: string, attempts: number): Promise<void> {
    await this.db
      .prepare(`UPDATE chunks SET status = 'failed', last_error = ?1, attempts = ?2 WHERE job_id = ?3 AND position = ?4`)
      .bind(code.slice(0, 50), attempts, id, position)
      .run();
  }

  /**
   * Mark chunks acknowledged and forget their transcript text. The checksum is kept, so a device
   * that repeats an acknowledgement (a lost response, a retried batch) is accepted again.
   */
  async ackChunks(id: string, positions: readonly number[]): Promise<void> {
    for (let start = 0; start < positions.length; start += STATEMENTS_PER_BATCH) {
      const statements = positions
        .slice(start, start + STATEMENTS_PER_BATCH)
        .map((position) =>
          this.db
            .prepare(
              `UPDATE chunks SET status = 'acked', text = NULL, content_type = NULL, size_bytes = NULL
               WHERE job_id = ?1 AND position = ?2`,
            )
            .bind(id, position),
        );
      await this.db.batch(statements);
    }
  }

  /** Put failed chunks back in the queue for another attempt. */
  async requeueFailed(id: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE chunks SET status = 'pending', attempts = 0, last_error = NULL
         WHERE job_id = ?1 AND status = 'failed'`,
      )
      .bind(id)
      .run();
  }

  async deleteJobRows(id: string): Promise<void> {
    await this.db.batch([
      this.db.prepare('DELETE FROM chunks WHERE job_id = ?1').bind(id),
      this.db.prepare('DELETE FROM jobs WHERE id = ?1').bind(id),
    ]);
  }

  async expiredJobIds(now: string): Promise<string[]> {
    const rows = await this.db
      .prepare('SELECT id FROM jobs WHERE expires_at <= ?1 ORDER BY created_at LIMIT 500')
      .bind(now)
      .all<{ id: string }>();
    return (rows.results ?? []).map((row) => row.id);
  }

  async knownJobIds(limit: number): Promise<Set<string>> {
    const rows = await this.db.prepare('SELECT id FROM jobs LIMIT ?1').bind(limit).all<{ id: string }>();
    return new Set((rows.results ?? []).map((row) => row.id));
  }
}
