# Architecture

Reavailable is an offline audiobook reader. A user pastes or uploads an Uzbek text. A server turns it
into short audio parts with a cloud text-to-speech service. The phone downloads each part, checks it,
stores it, acknowledges it, and then plays it offline. The server deletes a part only after the phone
has confirmed it. Playback is controlled with three English voice commands that are recognized on the
device. The app never recognizes Uzbek speech.

The product plan is the source of the requirements. The deviations and the review fixes are recorded in
[PLAN_REVIEW.md](PLAN_REVIEW.md).

## 1. Components

```
 Phone (Expo / React Native)                         Server (FastAPI, Python 3.11+)
 +-----------------------------------+   HTTPS      +-------------------------------------+
 | UI: Add book, Library, Player,    |   JSON +     | /api/v1                             |
 |     Settings                      |   audio      |  POST /jobs     -> validate, split  |
 | SyncEngine                        |------------->|  GET  manifest / chunks             |
 |   download -> verify SHA-256 ->   |<-------------|  POST /ack      -> delete on match  |
 |   store -> acknowledge            |              |  DELETE /jobs/{id}                  |
 | PlaybackController -> audio player|              |                                     |
 | VoiceService -> Vosk (English     |              | JobService (business rules)         |
 |   grammar, on device)             |              | JobRunner (bounded thread pool)     |
 | Library (JSON in app storage)     |              |   -> SpeechProvider                 |
 | SecureStore: per-book token       |              |        Azure neural TTS  | fake     |
 +-----------------------------------+              | SQLite (WAL): jobs, chunks          |
                                                    | data/blobs/<job>/NNNNNN.<ext>       |
                                                    | RetentionSweeper (TTL fallback)     |
                                                    +-------------------------------------+
```

The server exists in **two implementations of the same contract**: the FastAPI service in `backend/`
(SQLite plus a local blob directory, for self-hosting) and the Cloudflare Worker in `worker/` (D1 plus R2,
for hosting without a machine). The mobile app does not know which one it talks to; the Worker adds one
endpoint, `GET /api/v1/config`, which the app treats as optional.

Repository layout:

| Path | Role |
| --- | --- |
| `worker/src/` | Cloudflare Worker: HTTP router, job service, D1 store, R2 audio, Azure speech, retention cron |
| `worker/tests/` | vitest suite that runs inside workerd against a real local D1 and R2 |
| `backend/app/` | FastAPI service: API, business rules, storage, providers, worker, retention |
| `backend/tests/` | pytest suite that runs without network access |
| `mobile/src/core/` | Pure TypeScript domain: API client, sync engine, library, playback, voice logic |
| `mobile/src/platform/` | Adapters to native modules (audio, speech, files, keychain, crypto, picker) |
| `mobile/src/app/` | Composition root: wires the core to the platform adapters, React context |
| `mobile/src/i18n/` | Language list, the uz/en string catalogue, and the translator |
| `mobile/src/ui/` | Screens, components, presentation helpers (validation messages, labels), translate context |
| `mobile/tests/unit/` | Jest suites with in-memory fakes of the server, the player and the recognizer |
| `mobile/tests/e2e/` | Contract tests against a running backend |
| `docs/` | This document, the plan review, and the testing report |

## 2. Lifecycle of a book

```
 phone: POST /jobs (title, transcript, sentences_per_chunk, voice)
   server: validate -> split into parts -> store job (queued) -> 202 + access_token (shown once)
   worker: queued -> processing -> synthesize each part (bounded concurrency, retries)
                                -> ready            (or failed, with code and message)
 phone: poll GET /jobs/{id} until ready
        GET /manifest  (part index, size, SHA-256; never the transcript text)
        GET /chunks/{i} for each part, verify SHA-256 and size, write to app storage
        POST /ack      {index, sha256} for verified parts; server deletes the part when it matches
        all parts acknowledged -> server deletes the job
 phone: plays from its own files; no server contact is needed after the download
```

Failure handling:

- A synthesis failure stops the job. The job becomes `failed` with a code (`tts_auth_failed`,
  `tts_bad_request`, `tts_unavailable`, `internal_error`). The phone shows the reason. The failed
  parts keep their text, so `POST /retry` can synthesize them again. Silent audio is never produced.
- A download failure is retried with backoff on the phone. A checksum mismatch causes the part to be
  downloaded again. After two rejections of the same part by the server, the book fails with
  `checksum_rejected` and waits for an explicit retry or removal.
- If the server deletes a book (retention expired), the phone keeps the parts it already has. If all
  parts are on the phone, the book stays playable. Otherwise it is marked as failed with
  `job_not_found`.

## 3. Backend

### 3.1 Request handling

Every route is under `/api/v1`. Job routes need `Authorization: Bearer <access_token>`. Job creation also
needs `X-API-Key` when the operator configured one.

- Middleware refuses chunked request bodies with `411`, because their size cannot be checked before they
  are read. Bodies that declare a `Content-Length` above `AUDIOBOOK_MAX_REQUEST_BYTES` get `413`.
- Pydantic models validate the input. Validation errors return `422` and echo field names and messages
  only, never the submitted values.
- Domain errors have one JSON shape: `{"error": {"code", "message"}}`.
- Unknown, expired and foreign jobs all return `404 job_not_found`, so identifiers cannot be probed.

### 3.2 Creating a job

1. Check the API key (constant-time comparison) when one is configured.
2. Split the transcript into parts (`chunking.py`). Parts hold one or two sentences and never exceed
   `AUDIOBOOK_MAX_CHUNK_CHARS` (600). The splitter keeps abbreviations, initials, decimals and URLs
   together. Blank lines are boundaries. Cyrillic text is accepted with a `cyrillic_text` warning. The voices'
   sample text is in Latin script, and Cyrillic output has not been verified against Azure.
3. Enforce `AUDIOBOOK_MAX_TRANSCRIPT_CHARS` (200,000) and `AUDIOBOOK_MAX_CHUNKS_PER_JOB` (3,000).
4. Generate the job identifier and a 256-bit access token (`secrets.token_urlsafe(32)`). Only the
   SHA-256 digest of the token is stored. Lookups compare digests in constant time.
5. Store the job and its parts as `pending` and set `expires_at = now + AUDIOBOOK_JOB_TTL_HOURS`.
6. Hand the job to the worker and return `202`. The response is the only time the token is shown.

### 3.3 Synthesis

- The job is claimed with a conditional update (`queued` to `processing`). A second worker cannot claim
  the same job.
- Pending parts are synthesized in a thread pool bounded by `AUDIOBOOK_TTS_CONCURRENCY`.
- Transient provider errors (timeouts, 429, 5xx) are retried with exponential backoff, up to
  `AUDIOBOOK_TTS_MAX_ATTEMPTS`. Permanent errors (bad request) are not retried.
- The first failure sets a shared stop flag. Parts that have not started are not sent to the provider.
- Each finished part is written atomically (temporary file, then rename). The database row records the
  content type, size and SHA-256, and the transcript text is cleared. The text is needed only to
  synthesize the part.
- When every part is `ready`, the job becomes `ready`.
- On restart, `recover_interrupted` queues jobs that were `queued` or `processing`. Finished parts are
  kept.

### 3.4 Acknowledgement and deletion

- `POST /jobs/{id}/ack` validates the whole batch before changing anything. An unknown or not-ready part,
  or a checksum mismatch, rejects the batch and nothing is deleted.
- Acknowledged parts lose their file and text. When no part is left unacknowledged, the job row and its
  directory are deleted. Deleting the rows cascades to the parts.
- Repeating an acknowledgement with the same checksum is a successful no-op.

### 3.5 Retention

- Every job expires `AUDIOBOOK_JOB_TTL_HOURS` (default 24) after creation. A sweeper runs every
  `AUDIOBOOK_PURGE_INTERVAL_SECONDS` (default 900) and deletes expired jobs and orphaned files.
- The acknowledgement is the normal way data leaves the server. The timer is only a fallback for a phone
  that never acknowledges. This is a deliberate deviation from the plan wording (see PLAN_REVIEW).

### 3.6 Data model

SQLite in WAL mode with foreign keys on.

- `jobs`: id, token_hash, title, voice, sentences_per_chunk, status (`queued`, `processing`, `ready`,
  `failed`), error_code, error_message, warnings, created_at, updated_at, expires_at.
- `chunks`: id, job_id (cascade), position, status (`pending`, `ready`, `failed`, `acked`), text (kept
  while the part is pending or failed, cleared when it becomes ready), char_count, attempts, last_error,
  audio_path, content_type, size_bytes, sha256.
- Audio files: `data/blobs/<job_id>/NNNNNN.<ext>`. Writes are atomic.

### 3.7 Speech providers

`app/tts/base.py` defines the port: `allowed_voices`, `synthesize(text, voice) -> SynthesisResult`, and
the error types `TTSAuthError`, `TransientTTSError` and `PermanentTTSError`.

- **Azure** (`app/tts/azure.py`): REST request to
  `https://{region}.tts.speech.microsoft.com/cognitiveservices/v1` with an SSML body (`xml:lang="uz-UZ"`).
  The text and the voice name are XML-escaped. HTTP 401 and 403 are authentication failures. 429 and 5xx
  are transient. Other non-200 responses are permanent. Empty audio is transient.
  Voices: `uz-UZ-MadinaNeural` (default) and `uz-UZ-SardorNeural`.
- **Fake** (`app/tts/fake.py`): returns `AUDIO|<voice>|<text>` bytes. It is deterministic and used by
  the tests and the offline end-to-end run. Production refuses to start with it.

### 3.8 Logging and configuration

- The logger `audiobook.service` records identifiers, part positions, counts, and error codes. Transcript
  text, titles and tokens are never logged.
- Settings come from `AUDIOBOOK_*` environment variables or `.env`. Production (`AUDIOBOOK_ENVIRONMENT=production`)
  requires an API key and a real provider. `backend/.env.example` lists every setting.

### 3.9 The Cloudflare Worker implementation

`worker/` is a TypeScript port of the same rules, written for a platform with no long-running process:

- **Storage.** D1 holds `jobs` and `chunks`; R2 holds audio under `<jobId>/<position>.<ext>`. All SQL lives
  in one module (`src/db.ts`), so the statements are reviewable in one place.
- **No background worker.** A request cannot run for minutes, so synthesis happens in *passes*: a pass claims
  the job with a lease (a conditional `UPDATE`, so two requests never take the same job), synthesizes up to
  `CHUNKS_PER_PASS` parts with bounded concurrency and exponential backoff, and stops at `PASS_BUDGET_MS`.
  Passes are scheduled with `ctx.waitUntil` on job creation, on every status poll of an unfinished job, on a
  `409 job_not_ready` manifest request, and on retry. The app's polling therefore drives the work forward.
- **Crash safety.** A part is written to R2 and marked `ready` with its SHA-256 in one step. If a pass dies,
  the lease expires and the next pass resumes; parts already stored are never synthesized twice.
- **Failure classes.** A permanent speech failure marks the job `failed` and keeps the stored parts, so
  `POST /retry` can finish it. Storage and platform errors leave the job `processing` for the lease to expire.
- **Retention.** A daily cron (`17 3 * * *`) deletes jobs past `JOB_TTL_HOURS` and sweeps orphaned R2
  objects, bounded per run so one invocation cannot exceed its CPU budget.
- **Configuration errors.** A missing Azure key or an unallowed fake provider answers `503
  server_misconfigured` instead of failing every job one by one.
- **Chunking** is a faithful port of `backend/app/chunking.py`, verified against a golden fixture of 25 cases
  generated by the Python implementation. CI fails if the two drift apart.

## 4. Mobile app

### 4.1 Layers

- **core** has no native imports. It holds the API client, the sync engine, the library, the playback
  controller, the voice command logic, and the shared types. Every rule that matters for correctness is
  here and is covered by unit tests.
- **platform** implements the ports that core needs. It uses `expo-audio`, `expo-file-system`,
  `expo-secure-store`, `expo-crypto`, `expo-document-picker` and `react-native-vosk`.
- **app** builds the object graph (`services.ts`) and provides it to React (`AppContext`).
- **ui** renders the screens. It does not call the network or the native modules directly.

### 4.2 Library

`Library` keeps an immutable snapshot of books and settings in memory. Every change creates a new
snapshot and increments a version counter that React reads with `useSyncExternalStore`. The snapshot is
persisted as one JSON document through the `LibraryPersistence` port. Writes are queued and coalesced, so
a burst of chunk updates produces one write. A write that starts after a change includes that change.

### 4.3 Sync engine

Per book, the engine tracks a status: `processing` (the server is still synthesizing), `downloading`,
`ready`, or `failed`. Per part it tracks a state (`pending`, `stored`, `acked`, and the failure details).

A download pass does the following:

1. Refresh the manifest. Existing stored parts are kept, along with their rejection counts.
2. Re-check each stored file. A part that is acknowledged but whose file is missing is reported as
   `file_missing`, not skipped silently.
3. Download the pending parts with bounded concurrency and retry transient failures with backoff.
4. Verify each part's size and SHA-256 against the manifest, and against the `X-Content-SHA256` header,
   before writing it.
5. Acknowledge verified parts in batches (default 20). Only stored parts that are not yet acknowledged
   are sent.
6. Handle acknowledgement errors. `checksum_mismatch` discards the rejected parts and downloads them
   again. After two rejections, the book fails with `checksum_rejected`.

Passes are deduplicated. `download()` returns the running pass when one exists. Restarting the app
resumes unfinished books without any change to parts that are already stored.

### 4.4 Playback

`PlaybackController` plays the stored parts in index order. It saves the current part index per book, so
playback resumes at the same part after a restart.

- `play`, `pause`, `next`, and `repeat` (replays the current part). Playback continues to the next part
  when a part finishes.
- A part that is not stored yet puts playback in a waiting state. Playback resumes when the part arrives.
- A part that finishes within 400 ms of loading is treated as a load glitch and not as finished.
- The player adapter (`expoAudioPlayer.ts`) sets the audio mode with `doNotMix` and enables the lock
  screen controls. Background playback is enabled in `app.json`. This has not been verified on a device.

### 4.5 Voice commands

- **Grammar**: `next`, `repeat`, `pause`, `resume`, and `[unk]`. The recognizer only returns words from
  this closed list. The app ignores any other result.
- **Filtering**: only final results are used. A result must be a single command word. `[unk]` is rejected.
  If the engine reports a confidence, results below 0.5 are rejected.
- **Cooldown**: after a command is accepted, further results are ignored for 1.5 s. This prevents one
  utterance from firing twice and reduces the effect of the speaker's own voice.
- **Lifecycle**: the microphone permission is requested before listening starts. The Vosk module is loaded
  lazily. If the native module is missing (for example in Expo Go), voice control reports itself as
  unavailable and the rest of the app works. A missing model is reported when listening starts.
- **Limits**: noise, echo and recognition quality have not been measured on a device. Headphones are
  recommended in Settings.

### 4.6 Storage and secrets

- Audio files are stored under `Paths.document`. Uninstalling the app deletes them. Settings says so.
- Each book's access token is stored in the keychain through `expo-secure-store`, with
  `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`.
- The app has no analytics or telemetry. If analytics are added, they must stay separate from transcript
  content, as the plan requires.

### 4.7 Interface languages

Uzbek is the default language; English is a switch in Settings, stored in the library document.

- `src/i18n/strings.ts` is a flat catalogue of dotted keys, each with `{uz, en}` wording and `as const`, so a
  key missing one language is a type error. A unit test additionally requires both strings to be non-empty
  and to use the same `{placeholders}`.
- `createTranslator(language)` returns `t(key, params)`. The presentation helpers (`bookStatusView`,
  `partStatus`, `playbackMessage`, `voiceMessage`, `validateNewBook`) take `t` as an argument, which keeps
  them free of React and testable under Node.
- Screens read the translator from `TranslateContext` instead of receiving it through props.
- The sync engine receives a *thunk* (`translate?: () => Translate`), so notes written during a long download
  follow a language change made while it runs. Tests omit it and get English.
- A stored error code is re-translated on every render, so switching the language updates the wording of an
  old failure. Only a message from an unknown code stays as the server sent it.
- Voice commands remain English in both languages: the on-device recognizer uses a closed English grammar.

## 5. Key decisions

| Decision | Reason | Trade-off |
| --- | --- | --- |
| Azure Neural TTS behind a provider port | Uzbek neural voices (Madina, Sardor) | Cost and an external dependency. The fake provider keeps tests offline. |
| One synthesis request per part | Each part can be verified, retried and deleted on its own | More requests than one long file |
| Acknowledgement carries SHA-256 | The server deletes only verified data | One extra value per part |
| Per-book bearer token | Books cannot be read or deleted by someone who only knows the id | The phone must store the token safely |
| TTL fallback in addition to acknowledgement | Data does not stay forever if the phone disappears | The timer can delete data before a slow phone downloads it |
| SQLite and a thread pool | Simple to deploy for one instance | One instance only. Moving to several instances needs a shared database and a queue |
| Closed English grammar | Fewer false triggers than free-form recognition | Only the four commands can be spoken |
| Library as one JSON document | Simple and easy to inspect | Rewrites the whole document. Acceptable for a personal library |
| Expo SDK 57 | Current SDK with the native modules used | Requires a development build for voice |
| Two server implementations of one contract | Self-hosting stays possible, and hosting on Workers needs no machine | The chunking rules exist twice, so CI compares both against one golden fixture |
| Synthesis in leased passes instead of a queue | Works inside a request-based platform with no long-running process | A long book finishes over several polls; `CHUNKS_PER_PASS` bounds each pass |
| String catalogue with both languages per key | The interface is Uzbek-first and English stays available | Every new sentence needs two wordings; a test enforces it |
| Uzbek by default, English commands | The listeners are Uzbek; the offline recognizer model is English | Commands are spoken in English even in the Uzbek interface |

## 6. Open items

Open items and their status are listed in [PLAN_REVIEW.md](PLAN_REVIEW.md#4-open-items) and in
[TESTING.md](TESTING.md#3-not-verified).
