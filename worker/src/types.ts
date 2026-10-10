/**
 * Bindings and shared record types of the Worker.
 *
 * `Env` is what Cloudflare injects: a D1 database for job and chunk state, a KV namespace for audio
 * bytes, and the operator settings (secrets arrive as strings).
 */

export interface Env {
  /** Job and chunk metadata. */
  DB: D1Database;
  /** Synthesized audio (Workers KV), deleted again once the device confirms it has the bytes. */
  AUDIO: KVNamespace;

  /** Azure AI Speech subscription key. Required unless the fake provider is explicitly allowed. */
  AZURE_SPEECH_KEY?: string;
  /** Azure region of the speech resource, for example `eastus`. */
  AZURE_SPEECH_REGION?: string;
  /** Azure output format name. */
  AZURE_OUTPUT_FORMAT?: string;
  /** Comma-separated list of voices the server is willing to use. */
  ALLOWED_VOICES?: string;
  /** Voice used when the client does not choose one. Defaults to the first allowed voice. */
  DEFAULT_VOICE?: string;
  /** Shared key required on job creation. When empty, job creation is open. */
  API_KEY?: string;

  MAX_REQUEST_BYTES?: string;
  MAX_TRANSCRIPT_CHARS?: string;
  MAX_CHUNK_CHARS?: string;
  MAX_CHUNKS_PER_JOB?: string;
  JOB_TTL_HOURS?: string;
  /** How many parts one background pass synthesizes at most. */
  CHUNKS_PER_PASS?: string;
  TTS_CONCURRENCY?: string;
  TTS_MAX_ATTEMPTS?: string;
  TTS_RETRY_BASE_DELAY_MS?: string;
  TTS_TIMEOUT_MS?: string;
  /** Wall-clock budget of one background synthesis pass. */
  PASS_BUDGET_MS?: string;
  /** How long a pass holds a job before another pass may take over. */
  LEASE_MS?: string;
  /** `azure` or `fake`. The fake provider needs ALLOW_FAKE_PROVIDER=true. */
  TTS_PROVIDER?: string;
  ALLOW_FAKE_PROVIDER?: string;
  VERSION?: string;
}

export type JobStatus = 'queued' | 'processing' | 'ready' | 'failed';
export type ChunkStatus = 'pending' | 'ready' | 'failed' | 'acked';

export interface JobRow {
  id: string;
  token_hash: string;
  title: string;
  voice: string;
  sentences_per_chunk: number;
  status: JobStatus;
  error_code: string | null;
  error_message: string | null;
  warnings: string;
  created_at: string;
  updated_at: string;
  expires_at: string;
  lease_until: string | null;
  total_chunks: number;
}

export interface ChunkRow {
  job_id: string;
  position: number;
  status: ChunkStatus;
  text: string | null;
  char_count: number;
  attempts: number;
  last_error: string | null;
  content_type: string | null;
  size_bytes: number | null;
  sha256: string | null;
}

/** Public job state, mirroring `JobStatusResponse` of the Python backend. */
export interface JobView {
  id: string;
  status: JobStatus;
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

export interface ManifestEntry {
  index: number;
  char_count: number;
  content_type: string;
  size_bytes: number;
  sha256: string;
}

export interface ManifestView {
  title: string;
  total_chunks: number;
  entries: ManifestEntry[];
}

export interface AckOutcome {
  acknowledged: number[];
  remaining: number;
  job_deleted: boolean;
}
