-- Reavailable Worker schema.
--
-- A job is one transcript. Its parts live in `chunks`: the transcript text of a part is kept only
-- until the device confirms it has the verified audio, then it is cleared. Audio bytes live in R2
-- under "<job id>/<position>.<ext>" and are deleted at the same moment.
--
-- Timestamps are ISO-8601 UTC strings, so plain string comparison orders them correctly.

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  voice TEXT NOT NULL,
  sentences_per_chunk INTEGER NOT NULL,
  status TEXT NOT NULL,
  error_code TEXT,
  error_message TEXT,
  warnings TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  lease_until TEXT,
  total_chunks INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs (status);
CREATE INDEX IF NOT EXISTS idx_jobs_expires_at ON jobs (expires_at);

CREATE TABLE IF NOT EXISTS chunks (
  job_id TEXT NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  status TEXT NOT NULL,
  text TEXT,
  char_count INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  content_type TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  PRIMARY KEY (job_id, position)
);

CREATE INDEX IF NOT EXISTS idx_chunks_job_status ON chunks (job_id, status);
