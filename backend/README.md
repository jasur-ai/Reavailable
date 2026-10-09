# Reavailable backend

FastAPI service that turns an Uzbek transcript into short audio parts for the offline audiobook
reader app. It is a temporary relay: audio is kept only until the phone has downloaded and
acknowledged each part, and then it is deleted. See [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)
for the full design.

## Requirements

- Python 3.11 or newer
- Network access to Azure AI Speech when `AUDIOBOOK_TTS_PROVIDER=azure`

## Quick start (development)

```bash
cd backend
python3 -m venv .venv
. .venv/bin/activate
pip install -e ".[dev]"

# Optional: copy the template and edit it
cp .env.example .env

uvicorn app.main:create_app --factory --host 0.0.0.0 --port 8000
```

Open `http://localhost:8000/docs` for the interactive API reference. The default provider is
`fake`, which produces deterministic audio without any external service. It is refused in
production.

## Container image

`Dockerfile` builds a slim image that runs as a non-root user (uid 10001). Build and run it from this
directory:

```bash
docker build -t reavailable-backend .
docker run --detach --publish 8000:8000 --volume reavailable-data:/data \
  --env AUDIOBOOK_API_KEY='choose-a-long-random-value' \
  --env AUDIOBOOK_TTS_PROVIDER=azure \
  --env AUDIOBOOK_AZURE_SPEECH_KEY='your-azure-speech-key' \
  --env AUDIOBOOK_AZURE_SPEECH_REGION='your-azure-region' \
  reavailable-backend
```

- The image starts in production mode. It exits at startup until `AUDIOBOOK_API_KEY` and the Azure settings
  are set. CI checks both the refusal and a start with the settings above.
- `/data` holds the database and temporary audio. Mount a volume there to keep them across restarts.
- `PORT` sets the listening port (default `8000`). Hosting platforms that pass the port in `PORT` work
  without changes.
- The health endpoint is `GET /api/v1/health`. The image's health check uses it.
- `.dockerignore` keeps `.env` files, keys and test data out of the image.

## Configuration

All settings come from environment variables with the `AUDIOBOOK_` prefix (or from `.env`). The
complete list with comments is in [`.env.example`](.env.example). The most important ones:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AUDIOBOOK_ENVIRONMENT` | `development` | `production` refuses the fake provider and requires `AUDIOBOOK_API_KEY`. |
| `AUDIOBOOK_API_KEY` | unset | Required to create books when set; sent as `X-API-Key`. |
| `AUDIOBOOK_TTS_PROVIDER` | `fake` | `azure` for real speech; `fake` for development and tests. |
| `AUDIOBOOK_AZURE_SPEECH_KEY` / `_REGION` | unset | Needed for `azure`. |
| `AUDIOBOOK_ALLOWED_VOICES` | Madina, Sardor (uz-UZ) | Voices clients may choose. The first is the default. |
| `AUDIOBOOK_JOB_TTL_HOURS` | `24` | Retention if the device never acknowledges a book. |
| `AUDIOBOOK_MAX_TRANSCRIPT_CHARS` | `200000` | Largest accepted transcript. |
| `AUDIOBOOK_MAX_CHUNKS_PER_JOB` | `3000` | Upper bound on parts per book. |
| `AUDIOBOOK_DATA_DIR` | `data` | Holds the SQLite database and temporary audio. |

## API

Base path: `/api/v1`. Every job endpoint needs `Authorization: Bearer <access_token>`. The token is
returned once, when the job is created, and only its SHA-256 digest is stored.

| Method and path | Purpose |
| --- | --- |
| `GET /health` | Liveness check and version. |
| `POST /jobs` | Create a book (202). Body: `title`, `transcript`, `sentences_per_chunk` (1 or 2), optional `voice`. |
| `GET /jobs/{id}` | Status and counters. |
| `GET /jobs/{id}/manifest` | Part list with SHA-256 and size. 409 `job_not_ready` until synthesis is done. |
| `GET /jobs/{id}/chunks/{position}` | Audio bytes. Response header `X-Content-SHA256`. Not cached. |
| `POST /jobs/{id}/ack` | Body `{"chunks": [{"index", "sha256"}]}`. Deletes a part only when the checksum matches. Idempotent. |
| `POST /jobs/{id}/retry` | Retry synthesis of a failed book (202). |
| `DELETE /jobs/{id}` | Delete the book and its audio now (204). |

Errors use one shape: `{"error": {"code": "...", "message": "..."}}`. Validation errors (422) add
`details`, without echoing the transcript. Unknown, expired and foreign books all return
`404 job_not_found`, so job identifiers cannot be probed.

Error codes: `job_not_found`, `job_not_ready`, `chunk_not_ready`, `chunk_not_found`,
`checksum_mismatch`, `unauthorized`, `tts_auth_failed`, `tts_bad_request`, `tts_unavailable`,
`internal_error`.

## Privacy and retention

- Transcript text is not written to logs. Logs carry identifiers, part positions and error codes.
- Audio is deleted when the device acknowledges it. Unacknowledged books are purged after
  `AUDIOBOOK_JOB_TTL_HOURS`. A sweep that runs every `AUDIOBOOK_PURGE_INTERVAL_SECONDS` also removes
  orphaned files.
- On restart, books that were still being synthesized are queued again.

## Deployment requirements

These are deliberately outside the application and must be set up by the operator:

1. **TLS.** Serve the API only over HTTPS. Access tokens travel in headers.
2. **Rate limiting.** Apply per-IP limits at the reverse proxy (for example nginx `limit_req`).
   The application enforces size and count limits, not request rates.
3. **API key.** Set `AUDIOBOOK_API_KEY` in production so strangers cannot create books at your cost.
4. **Single instance.** The database is SQLite in WAL mode with one process in mind. Run one worker
   process; scale out only after moving to a shared database.
5. **Persistent volume** for `AUDIOBOOK_DATA_DIR` if you want books to survive a container restart.
6. **Azure key handling.** Keep `AUDIOBOOK_AZURE_SPEECH_KEY` in a secret store, not in the image.

## Tests and quality checks

```bash
cd backend
. .venv/bin/activate
ruff check app tests
mypy
pytest -q --cov=app
```

The suite has 108 tests and runs without network access. Live Azure calls are not part of it. See
[`../docs/TESTING.md`](../docs/TESTING.md) for what is verified and what is not.

## Project layout

```
app/
  main.py          application factory and lifespan (recovery, purge schedule)
  api.py           HTTP routes and authentication
  services.py      job lifecycle: create, process, acknowledge, delete, purge
  chunking.py      Uzbek sentence splitting and part grouping
  tts/             speech providers: azure.py (REST + SSML), fake.py (tests), base.py (port)
  storage.py       atomic audio files under data/blobs/<job>/
  db.py, models.py SQLAlchemy engine, session and tables
  worker.py        background thread pool and retention sweeper
  security.py      token generation, digests, constant-time comparison
  config.py        settings (AUDIOBOOK_ environment variables)
tests/             pytest suite (chunking, providers, API, processing, retention, config)
Dockerfile        container image (production mode by default, non-root, /data volume)
pyproject.toml    package metadata, dependencies, tool settings
```
