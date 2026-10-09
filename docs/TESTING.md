# Testing

This document says what is tested, how to run it, what has been verified in the development sandbox, and
what has not. Read the "Not verified" section before relying on the product for anything real.

## 1. Suites and how to run them

| Suite | Command | What it covers | Result (last run) |
| --- | --- | --- | --- |
| Backend tests | `cd backend && .venv/bin/python -m pytest -q --cov=app` | Chunking, speech providers, API, auth, limits, processing, retries, retention, storage, config | 110 passed, coverage 96% |
| Backend lint and types | `.venv/bin/ruff check app tests && .venv/bin/ruff format --check app tests && .venv/bin/mypy` | Style, formatting, strict typing of `app` | clean |
| Mobile type check | `cd mobile && npx tsc --noEmit` | Strict TypeScript for `src`, `tests`, `App.tsx`, `index.ts` | exit 0 |
| Mobile lint | `npx eslint .` | Expo rules, `no-console` for app code | clean, no warnings |
| Mobile unit tests | `npm test` | Core logic: API client, library, sync engine, playback, voice | 8 suites, 200 tests; coverage thresholds 85% met |
| Mobile end-to-end | `E2E_API_BASE_URL=http://127.0.0.1:8000 npm run test:e2e` (backend running) | Real HTTP against the backend with the fake speech provider | 5 passed |
| Model script | `VOSK_MODEL_URL=file://<archive> scripts/fetch-vosk-model.sh` | Archive validation, checksum option, install, skip, missing URL | 6 cases checked (see §2) |
| All mobile checks | `npm run check` | Type check, lint and unit tests | passes |

The end-to-end suite skips itself when `E2E_API_BASE_URL` is not set, so `npm run check` never needs a
server.

### What the backend tests cover

- `test_chunking.py`: sentence splitting for Uzbek text (abbreviations, initials, decimals, URLs,
  apostrophes, Cyrillic detection), grouping of one or two sentences, the character limit, and hard splits
  of very long tokens.
- `test_tts_providers.py`: SSML building and escaping, the Azure request (URL, headers, body), HTTP status
  classification, that credentials never appear in error messages, the voice allow-list, and the fake
  provider's output.
- `test_jobs_api.py`: creation, manifest, chunk download and checksum header, acknowledgement (partial,
  full, wrong checksum, atomic batches, idempotence), deletion, bearer-token access control, error shapes,
  request limits (size, chunked bodies, transcript length, chunk count), the operator API key, and that
  error responses never echo the transcript.
- `test_processing.py`: retries for transient errors, no retries for permanent errors, authentication
  failures, the retry endpoint, recovery after a crash, concurrency mapping of results to positions, and
  removal of transcript text once a part is ready.
- `test_retention_and_storage.py`: TTL and the sweeper, orphan cleanup, blob path safety, token digests,
  constant-time comparison.
- `test_service_and_worker.py`: service behaviour, a tampered or missing audio file is never served,
  background worker and inline modes, and the retention sweeper's schedule.
- `test_config.py`: defaults, production rules, environment variable parsing, and out-of-range limits.

### What the mobile unit tests cover

- `apiClient.test.ts`: URL normalization, bearer and API-key headers, timeouts (including a stalled body),
  dropped connections, error body mapping, and validation of manifest entries.
- `library.test.ts`: loading and corrupt data, immutable updates, persistence order, failed writes, and write
  coalescing.
- `syncEngine.test.ts` and `syncEngine.recovery.test.ts`: download, verification, acknowledgement, retries,
  resume after restart, lost files, server-side expiry, checksum rejection limits, retry and removal.
- `playbackController.test.ts`: 32 tests for play, pause, resume, next, repeat, saved positions, waiting for
  parts still downloading, load failures and state changes.
- `voiceCommands.test.ts` and `voiceService.test.ts`: the closed grammar, parsing, confidence threshold,
  cooldown, lifecycle, restarts, and unavailability when the native module is missing.
- `utils.test.ts`: hex encoding, file naming, user-facing messages, presentation rules, validation.

The unit tests use in-memory fakes in `tests/unit/support/`: `FakeServer` implements the same contract as the
real API client, `FakePlayer` and `FakeRecognizer` replace the native modules, and `memory.ts` replaces the
storage adapters. The fakes are a source of risk. They must be kept in step with the real adapters, which is
why the end-to-end suite exists.

### What the end-to-end suite covers

Against a running backend with the fake speech provider:

1. The health endpoint answers.
2. A book is created, its parts are downloaded and verified, every part is acknowledged, the server copy
   is removed, and the book plays from the device files. After an offline restart the sync makes no server
   calls.
3. A socket reset on part 1 and a corrupted part 0 are retried, and no bytes that fail the checksum are
   stored.
4. An empty transcript is refused with a validation error, and no book is created.
5. A wrong access token gets `job_not_found`.

## 2. Verified in the sandbox

- Every command in §1 was run. The results are in §1.
- The final backend build was run with uvicorn on `0.0.0.0:8000`, and the end-to-end suite passed against it
  (5 of 5). The backend log for that run has no errors or tracebacks. Its lines carry identifiers, part positions
  and status codes only.
- The same build was checked by hand: the manifest has no transcript text, and a request with a chunked body is
  refused with `411 length_required`.
- The sync engine's checksum handling was checked with a trace of the calls. That trace found a bug (the
  rejection counter reset when the manifest was refreshed). It is fixed and covered by a test.
- Expo configuration resolves: `npx expo config --type public` exits 0, reports SDK 57.0.0, and merges the plugin
  permissions (microphone, foreground media playback) into the Android manifest.
- The Expo-managed native module versions in `mobile/package.json` (11 modules) match the `bundledNativeModules.json`
  shipped in `expo@57.0.27`. Every version is identical. `react-native-vosk` is pinned to 2.1.7, which was checked
  against its published package.
- The model script was checked with six cases: a good archive without a checksum, a wrong checksum (the
  existing model is kept), the right checksum, a bad archive (the existing model is kept), a skip when a model
  exists, and a missing file (curl exit 37, nothing left behind).

## 3. Not verified

These were **not** tested in the sandbox. Do not report them as working.

| Area | Why not | What would verify it |
| --- | --- | --- |
| On-device voice recognition (react-native-vosk, the four commands) | Needs a native build and a microphone | Manual checklist, §4, step 6 |
| Recognition in noise and speaker echo | Needs a real room and speaker | Manual checklist, §4, step 6 |
| Background playback and lock-screen controls | Needs a device | Manual checklist, §4, step 5 |
| Live Azure calls (Uzbek quality, Cyrillic output, quotas, errors with a real key) | No credentials and no network access in the sandbox | Manual checklist, §4, step 3 |
| Native builds for iOS and Android, including the `react-native-vosk` plugin | Needs Xcode or Android SDK | `npm run android` / `npm run ios` on a machine with the SDK |
| Vosk model download from `alphacephei.com` | The host was not reachable from the sandbox | Run the script with the official URL and record its SHA-256 |
| File picker (`transcriptFile.ts`) | Native picker, not unit-tested | Manual checklist, §4, step 4 |
| Restore from OS backups | Needs devices and a backup | Manual, if the backup policy is kept |
| `npx expo install --check` | Needs access to Expo's API, which the sandbox blocks (the attempt failed with a socket error). The versions were compared by hand instead (§2) | Run it once on a machine with network access |
| GitHub Actions workflow | Not run on GitHub from the sandbox. Each job's commands were run locally | First CI run on the pull request |
| Docker image | Docker is not available in the sandbox, and no Dockerfile is provided | Not planned in this iteration |
| Behaviour under real rate limits | Rate limiting belongs to the reverse proxy, which is not part of this repository | Load test in the deployment environment |

## 4. Manual checklist for a device

Run these on a development build with a backend that uses the real provider, unless a step says otherwise.
Record the results in the pull request.

1. **Model.** Run `scripts/fetch-vosk-model.sh` with the default URL. Record the printed SHA-256, check it
   against the official release, then set `VOSK_MODEL_SHA256` to that value for later runs.
2. **Build.** `npm run android` and `npm run ios`. Grant the microphone permission on first use.
3. **Live Azure.** Start the backend with `AUDIOBOOK_TTS_PROVIDER=azure`, a real key and region. Create a
   short Uzbek book. Listen to both voices. Note any Cyrillic text and any wrong pronunciation.
4. **Sync.** Add a book by pasting text and by picking a `.txt` file. Check that the parts download and that
   the server copy is gone after the book is ready (`GET /api/v1/jobs/{id}` returns 404).
5. **Background.** Start playback, lock the screen, and check that audio continues and that the lock-screen
   controls work. Then switch to another app.
6. **Voice.** In a quiet room, with headphones and then with the speaker, say `next`, `repeat`, `pause` and
   `resume` ten times each. Count the correct recognitions and the false triggers. Repeat with music or a
   video playing nearby.
7. **Resume.** Kill the app during a download and reopen it. Stored parts must not be downloaded again.
8. **Expiry.** On a test backend with `AUDIOBOOK_JOB_TTL_HOURS` set to a small value, let a book expire before
   the phone downloads it. Check the message shown and that already-stored parts still play.
9. **Airplane mode.** Put the phone in airplane mode after the download. The book must play and every command
   must still work, with no server contact.

## 5. Reproducing the run

```bash
# Backend
cd backend
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
ruff check app tests && ruff format --check app tests && mypy
pytest -q --cov=app

# Mobile
cd ../mobile
npm ci
npm run check

# End-to-end (new terminal, backend running on port 8000 with AUDIOBOOK_TTS_PROVIDER=fake)
cd mobile && E2E_API_BASE_URL=http://127.0.0.1:8000 npm run test:e2e
```

Use a separate `AUDIOBOOK_DATA_DIR` for the end-to-end backend, so that test data does not mix with development
data.
