# Reavailable speech server on Cloudflare Workers

This is the hosted backend of the Reavailable offline audiobook reader. It turns Uzbek text into short
audio parts with Azure AI Speech, keeps them in R2 until a phone confirms it has them, and deletes them
after that confirmation or after the retention period.

It speaks the same HTTP contract as the self-hosted Python service in [`backend/`](../backend), so the
mobile app works against either server without changes. Use this Worker when you do not want to run a
machine yourself: it needs no server, no volume and no reverse proxy, and the free tiers of Workers, D1
and R2 are enough for personal use.

```
worker/
  src/index.ts      HTTP router, CORS, API key check, retention cron
  src/service.ts    JobService: create, pump synthesis, manifest, chunk read, acknowledge, retry, delete
  src/db.ts         JobStore: every SQL statement in the project (D1)
  src/chunking.ts   Text normalization and sentence grouping (port of backend/app/chunking.py)
  src/tts.ts        Azure Speech provider and the fake provider used by tests
  src/config.ts     Settings from environment variables, provider selection
  src/security.ts   Token generation, SHA-256, constant-time comparison
  src/errors.ts     HttpError and the error constructors
  src/types.ts      Env, row shapes, API view shapes
  migrations/       D1 schema (0001_init.sql)
  tests/            117 vitest tests, run inside workerd against a real local D1 and R2
  wrangler.toml     Bindings, non-secret variables, cron trigger
```

## How a book is produced

1. `POST /api/v1/jobs` stores the job and its parts in D1 and answers `202` with the job id and its
   one-time access token. The request also schedules a background synthesis pass with `ctx.waitUntil`,
   so the response does not wait for audio.
2. A pass claims the job with a lease (`claimLease` is a conditional `UPDATE`, so two requests never
   synthesize the same part), synthesizes up to `CHUNKS_PER_PASS` parts with limited concurrency and
   exponential backoff, and writes each part to R2 with its SHA-256.
3. The app polls `GET /api/v1/jobs/{id}`. Each poll of a job that is still `queued` or `processing`
   continues the work, so a long book finishes over several short requests instead of one long one.
4. When no part is left, the job becomes `ready`. `GET .../manifest` then lists the parts with their
   sizes and checksums. The app downloads each part, checks it, and acknowledges it.
5. `POST .../ack` deletes the acknowledged audio from R2 and drops the transcript text of those parts
   from D1. When nothing is left, the job itself is deleted.
6. A daily cron (`17 3 * * *`) removes jobs whose retention period ended and sweeps orphaned R2 objects.

A permanent synthesis failure marks the job `failed` and keeps the parts that were already produced; the
app can retry it with `POST .../retry`. A storage or platform error leaves the job `processing` so the
next request (or the lease expiry) resumes it.

## API

Base path `/api/v1`. Errors are always `{"error":{"code","message"}}`. A job is addressed with its id and
its access token: `Authorization: Bearer <token>`. An unknown, expired or foreign job always answers the
same `404 job_not_found`. Unknown fields in a request body are ignored.

| Method and path | Purpose | Notes |
| --- | --- | --- |
| `GET /` | HTML info page | Name, version, provider, voices |
| `GET /api/v1/health` | Liveness | `{status, version}` |
| `GET /api/v1/config` | Capabilities | Provider, voices, whether an API key is required and whether the presented key was accepted, limits. Sends `X-API-Key` to learn `api_key_ok` |
| `POST /api/v1/jobs` | Create a book | `{title, transcript, sentences_per_chunk, voice?}` → `202` with `access_token` (shown once). Needs `X-API-Key` when one is configured |
| `GET /api/v1/jobs/{id}` | Status | Counts of parts per state, plus `error` when failed. Continues the work in the background |
| `GET /api/v1/jobs/{id}/manifest` | Part list | `409 job_not_ready` until the job is `ready` |
| `GET /api/v1/jobs/{id}/chunks/{index}` | Audio bytes | `X-Content-SHA256` header, `Cache-Control: no-store`, streamed from R2 |
| `POST /api/v1/jobs/{id}/ack` | Confirm parts | `{chunks:[{index,sha256}]}`, 1–500 items. Validates every item before changing anything, then deletes |
| `POST /api/v1/jobs/{id}/retry` | Retry a failed job | `409 job_not_failed` unless the job is `failed` |
| `DELETE /api/v1/jobs/{id}` | Delete a job | `204`, removes the rows and the audio |

Creation errors: `invalid_title`, `invalid_sentences_per_chunk`, `empty_transcript`, `transcript_too_long`,
`too_many_chunks`, `unsupported_voice`, `body_too_large`, `unauthorized`.
Synthesis errors: `tts_auth_failed`, `tts_bad_request`, `tts_unavailable`, `internal_error`.
Configuration error: `server_misconfigured` (`503`) when the environment cannot produce audio at all, for
example a missing Azure key.
Request errors: `not_found`, `method_not_allowed`, `invalid_body`, `job_not_ready`, `chunk_not_ready`,
`checksum_mismatch`, `chunk_unavailable`, `token_missing`.

CORS is open (`Access-Control-Allow-Origin: *`) because the only secrets in a request are the job token and
the operator API key, and the app talks to the server directly from the phone.

## Configuration

Non-secret settings live in `wrangler.toml` under `[vars]` and can be overridden per deploy with
`wrangler deploy --var NAME:value`. Secrets are set with `wrangler secret put NAME` and never appear in the
repository.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TTS_PROVIDER` | `azure` | `azure` or `fake`. `fake` produces a quiet tone and is refused unless `ALLOW_FAKE_PROVIDER` is true |
| `ALLOW_FAKE_PROVIDER` | unset | Must be `true` to run the fake provider |
| `AZURE_SPEECH_REGION` | `eastus` | Region of the Azure Speech resource |
| `AZURE_OUTPUT_FORMAT` | `audio-24khz-48kbitrate-mono-mp3` | Any Azure REST output format; the content type and file extension follow it |
| `ALLOWED_VOICES` | `uz-UZ-MadinaNeural,uz-UZ-SardorNeural` | Comma-separated list the app may choose from |
| `DEFAULT_VOICE` | first allowed voice | Used when a request does not name a voice |
| `VERSION` | `0.2.0` | Reported by `/health` and `/config` |
| `MAX_REQUEST_BYTES` | `2000000` | Largest accepted request body (1 KB–20 MB) |
| `MAX_TRANSCRIPT_CHARS` | `200000` | Longest accepted transcript |
| `MAX_CHUNK_CHARS` | `600` | A longer sentence is split at word boundaries |
| `MAX_CHUNKS_PER_JOB` | `3000` | Refuses a book that would need more parts |
| `JOB_TTL_HOURS` | `24` | Retention period, capped at 720 hours |
| `CHUNKS_PER_PASS` | `8` | Parts synthesized per background pass, capped at 200 |
| `TTS_CONCURRENCY` | `3` | Parallel synthesis requests per pass |
| `TTS_MAX_ATTEMPTS` | `3` | Attempts per part before the failure is permanent |
| `TTS_RETRY_BASE_DELAY_MS` | `1000` | Base of the exponential backoff |
| `TTS_TIMEOUT_MS` | `30000` | Per-request speech timeout |
| `PASS_BUDGET_MS` | `20000` | A pass stops early when this wall-clock budget runs out |
| `LEASE_MS` | `30000` | How long one pass owns a job before another may take over |

| Secret | Meaning |
| --- | --- |
| `AZURE_SPEECH_KEY` | Key 1 or Key 2 of the Azure AI Speech resource |
| `API_KEY` | Operator access key. When set, `POST /jobs` requires it in `X-API-Key`, and the same value is typed into the app's Settings |

## Local development

`wrangler dev` runs the Worker in `workerd` with a local D1 database and a local R2 bucket under
`.wrangler/state/`, so no Cloudflare account or network access is needed.

```bash
cd worker
npm ci
npx wrangler d1 migrations apply reavailable-audiobooks --local   # once

# Fake provider: a quiet tone instead of speech, no Azure key needed.
npx wrangler dev --port 8787 --ip 0.0.0.0 \
  --var TTS_PROVIDER:fake --var ALLOW_FAKE_PROVIDER:true \
  --var ALLOWED_VOICES:fake-uz --var DEFAULT_VOICE:fake-uz --var VERSION:dev
```

```bash
curl http://127.0.0.1:8787/api/v1/health
curl http://127.0.0.1:8787/api/v1/config

TOKEN_JSON=$(curl -s -X POST http://127.0.0.1:8787/api/v1/jobs \
  -H 'Content-Type: application/json' \
  -d '{"title":"Sinov","transcript":"Salom dunyo. Bu birinchi jumla.","sentences_per_chunk":1,"voice":"fake-uz"}')
JOB=$(echo "$TOKEN_JSON" | jq -r .id)
ACCESS=$(echo "$TOKEN_JSON" | jq -r .access_token)

curl -s -H "Authorization: Bearer $ACCESS" "http://127.0.0.1:8787/api/v1/jobs/$JOB" | jq .status
curl -s -H "Authorization: Bearer $ACCESS" "http://127.0.0.1:8787/api/v1/jobs/$JOB/manifest" | jq .
curl -s -D- -o part.mp3 -H "Authorization: Bearer $ACCESS" \
  "http://127.0.0.1:8787/api/v1/jobs/$JOB/chunks/0" | grep -i x-content-sha256
```

The scheduled retention sweep does not run by itself in local development. Trigger it with:

```bash
curl -X POST 'http://127.0.0.1:8787/cdn-cgi/local/scheduled'
```

To run against real Azure speech locally, use `--var TTS_PROVIDER:azure` and
`AZURE_SPEECH_KEY=$(...) npx wrangler dev --var ...` is not enough: secrets are read with
`npx wrangler secret put AZURE_SPEECH_KEY --local`, which stores them in `.wrangler/state/`.

## Tests

```bash
npm test          # 117 tests
npm run typecheck # tsc --noEmit, strict
```

The tests run through `@cloudflare/vitest-plugin` inside `workerd` with a real local D1 database (migrations
are loaded from `migrations/`) and a real local R2 bucket, so SQL, streaming and `crypto.subtle` are the
production implementations rather than mocks. `tests/chunking.test.ts` compares the chunker against
`tests/fixtures/chunking-golden.json`, which `backend/scripts/dump_chunking_golden.py` generates from the
Python implementation; CI fails if the two implementations drift apart.

Note for anyone extending the tests: `ctx.waitUntil` runs to completion during these tests, so an HTTP
request that schedules a pass finishes the whole job before the next assertion. Assert intermediate states
through `JobService` directly, not through HTTP.

## Deploy

### From GitHub Actions (recommended)

Add three repository secrets (Settings → Secrets and variables → Actions), then run the workflow
**Deploy speech server (Cloudflare Workers)** from the Actions tab:

| Secret | Where to get it |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | dash.cloudflare.com → My Profile → API Tokens. Needs *Workers Scripts: Edit*, *D1: Edit*, *R2: Edit* and *Account Settings: Read* for the account |
| `AZURE_SPEECH_KEY` | Azure portal → your Speech resource → Keys and Endpoint → KEY 1 |
| `AUDIOBOOK_API_KEY` | Any long random string you choose. The same value is typed into the app's Settings |

The workflow ([`.github/workflows/deploy-cloudflare.yml`](../.github/workflows/deploy-cloudflare.yml))
creates the R2 bucket and the D1 database if they are missing, writes the database id into
`wrangler.toml`, applies the migrations remotely, deploys, stores both secrets, deploys again, and then
checks the live address: `/api/v1/health` must answer `ok` and `/api/v1/config` must report
`provider: azure`, `requires_api_key: true` and `api_key_ok: true`. The address is printed in the job
summary; enter it in the app under **Settings → Server address**.

The account id is in `wrangler.toml` (`ebcc9b4f989feea5bbdee1181f20b61c`). Change it there if you deploy to
a different Cloudflare account.

### By hand

```bash
cd worker
npx wrangler login
npx wrangler r2 bucket create reavailable-audiobooks            # once
npx wrangler d1 create reavailable-audiobooks                   # once: paste the id into wrangler.toml
npx wrangler d1 migrations apply reavailable-audiobooks --remote
npx wrangler secret put AZURE_SPEECH_KEY
npx wrangler secret put API_KEY
npx wrangler deploy
```

## Limits and tuning

- **Workers Free** gives about 10 ms of CPU per request. A synthesis pass therefore does only
  `CHUNKS_PER_PASS = 8` parts, and the app's next poll continues the work. A long book finishes over
  several polls; that is by design and needs no configuration.
- On **Workers Paid** (30 s CPU per request) set `chunks_per_pass` to `40` in the deploy workflow, or
  `--var CHUNKS_PER_PASS:40`, so a book finishes in one or two passes.
- `PASS_BUDGET_MS` is a wall-clock guard: a pass stops before the platform limit and leaves the rest for
  the next request.
- **Azure F0 (free)** allows about 500,000 neural characters per month. A 200,000-character book uses most
  of that. Exceeding the free tier returns `tts_unavailable` or `tts_auth_failed`; it does not create a bill
  unless the resource is moved to a paid tier.
- Audio is stored only until it is acknowledged, and jobs expire after `JOB_TTL_HOURS`, so R2 usage stays
  close to zero for a single user.
- D1 and R2 have no per-request cost on the free tier beyond the documented daily limits.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `503 server_misconfigured` | `AZURE_SPEECH_KEY` is missing, or `TTS_PROVIDER` is `fake` without `ALLOW_FAKE_PROVIDER`. Set the secret and redeploy |
| `422 unsupported_voice` | The requested voice is not in `ALLOWED_VOICES` |
| `401 unauthorized` on `POST /jobs` | `X-API-Key` is missing or wrong. `GET /api/v1/config` reports `api_key_ok` |
| `404 job_not_found` | Wrong job id, wrong token, or the job expired and was deleted |
| `409 job_not_ready` on the manifest | The book is still being produced. Keep polling the status endpoint; each poll advances it |
| `409 checksum_mismatch` on ack | The acknowledged checksum does not match the stored part. Re-download the part |
| Job stays `processing` for a long time | The pass ran out of budget or the lease is held. The next status poll resumes it; `LEASE_MS` bounds the wait |
| `tts_auth_failed` | Azure rejected the key or the region does not match the resource |

## Status

Verified: 117 tests inside `workerd` against real local D1 and R2; `tsc --noEmit`; `wrangler deploy
--dry-run` (51.09 KiB, 14.38 KiB gzipped); a live `wrangler dev` run through health, config, job creation,
status, manifest, and part download with matching SHA-256 in the body and the header; the mobile app's
end-to-end suite (5 tests) against a running Worker.

Not verified: a deployment to a real Cloudflare account (the sandbox that produced this code cannot reach
`api.cloudflare.com`), and live Azure speech output. The deploy workflow performs its own health and
configuration checks, so the first real run is what confirms those.
