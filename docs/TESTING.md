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
| Mobile unit tests | `npm test` | Core logic: API client, library, sync engine, playback, voice, string catalogue, presentation, build-time server address | 8 suites, 223 tests; coverage thresholds 85% met (96% statements) |
| Mobile end-to-end (Python backend) | `E2E_API_BASE_URL=http://127.0.0.1:8000 npm run test:e2e` (backend running) | Real HTTP against the backend with the fake speech provider | 5 passed |
| Worker tests | `cd worker && npm test` | Chunking (golden fixture), service state machine, D1 store, R2 audio, HTTP contract, TTS mapping, config, security. Runs inside workerd against a real local D1 and R2 | 6 suites, 117 passed |
| Worker type check | `cd worker && npm run typecheck` | Strict TypeScript for `src` and `tests` | exit 0 |
| Worker bundle | `cd worker && npx wrangler deploy --dry-run --outdir /tmp/dist` | The Worker compiles and bundles for the platform | 51.09 KiB, 14.38 KiB gzipped |
| Mobile end-to-end (Worker) | `E2E_API_BASE_URL=http://127.0.0.1:8787 npm run test:e2e` (`wrangler dev` running) | The same contract suite against the Worker, including `GET /config` | 5 passed |
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
- `utils.test.ts`: hex encoding, file naming, presentation rules, validation, error wording, and the string
  catalogue (both languages present and non-empty for every key, matching `{placeholders}`, translator
  parameter filling, language detection).
- Language handling is also covered where it is used: `library.test.ts` (the language is stored, restored and
  falls back to Uzbek), `syncEngine.test.ts` (notes are written in Uzbek by default and follow a switch to
  English during a download; without a translator they stay English), and `apiClient.test.ts` (`GET /config`
  parsing, defaults for missing fields, the API key header, and a `404` for a server without the endpoint).

The unit tests use in-memory fakes in `tests/unit/support/`: `FakeServer` implements the same contract as the
real API client, `FakePlayer` and `FakeRecognizer` replace the native modules, and `memory.ts` replaces the
storage adapters. The fakes are a source of risk. They must be kept in step with the real adapters, which is
why the end-to-end suite exists.

### What the end-to-end suite covers

Against a running backend with the fake speech provider. The suite runs against both implementations: the
Python service and the Cloudflare Worker (CI has a job for each).

1. The health endpoint answers, and `GET /api/v1/config` is read when the server has it (the Worker does; a
   `404` from the Python backend is accepted).
2. A book is created, its parts are downloaded and verified, every part is acknowledged, the server copy
   is removed, and the book plays from the device files. After an offline restart the sync makes no server
   calls.
3. A socket reset on part 1 and a corrupted part 0 are retried, and no bytes that fail the checksum are
   stored.
4. An empty transcript is refused with a validation error, and no book is created.
5. A wrong access token gets `job_not_found`.

## 2. Verified

### In the sandbox

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

- **The Cloudflare Worker was run locally** with `wrangler dev` (fake provider) and taken through the whole
  contract by hand: `GET /api/v1/health`, `GET /api/v1/config`, `POST /api/v1/jobs` (`202` with a token),
  status polling until `ready` with 2 of 2 parts, `GET .../manifest` (sizes and SHA-256 for both parts), and
  `GET .../chunks/0` and `/chunks/1`. Both downloads matched the manifest checksum and the `X-Content-SHA256`
  header byte for byte, and both started with the `RIFF` magic of the WAV the fake provider emits. Synthesis
  ran in a background pass scheduled with `ctx.waitUntil`, and the local D1 and R2 stores were the real
  implementations in `workerd`.
- The mobile end-to-end suite passed 5 of 5 against that running Worker, and again after the interface
  languages were added.
- `npm ci` in `worker/` resolves from `package-lock.json` without extra flags.
- Both new and changed workflow files parse as YAML, and every `run:` block in them passes `bash -n`
  (47 blocks).
- The npm audit findings are not in the Android JS bundle. `expo export --platform android --no-bytecode`
  produced one bundle with none of `node-forge`, `braces`, `micromatch`, `sprintf`, `argparse`, `js-yaml` or
  `xcode`. The string `uuid` appears only as Expo's own module.

### On GitHub-hosted runners

- **CI** (`.github/workflows/ci.yml`) passed on commit `315572c` (run `38035940968`) with six jobs: backend,
  mobile, worker (type check, 117 tests in workerd, bundle dry-run, and the chunking fixture compared against
  the Python reference), container, end-to-end against the Python backend, and end-to-end against a live
  Worker started with `wrangler dev` in the job. The same six jobs passed on `f14d245` (run `38035706095`).
  Earlier runs on `1320a8c` (run `37965656119`) covered the four jobs that existed then.
- **Android APK** (`android-build.yml`) builds release APKs on an Ubuntu runner (runs `37964171967` and
  `37965656458` for the single-APK build). The build checks the APK itself: the Vosk model is inside it,
  `classes.dex` and the signature are present, the package name is `uz.reavailable.app`, the app requests
  `RECORD_AUDIO` and `INTERNET`, and it does not request `SYSTEM_ALERT_WINDOW`, `VIBRATE` or the
  external-storage permissions. The build now splits per CPU architecture and additionally checks that each
  split APK carries the native libraries of its own architecture and none of the other three; that change is
  verified by the release run recorded below.
- **Backend container** (`container` job in CI): the image builds, refuses to start in production without
  credentials, starts with the documented production settings and passes the health check. In development mode it
  runs as uid 10001 and accepts a job with `202`.
- **Release** (`android-release.yml`): the tag `android-v0.2.0-test1` (commit `315572c`) built the APK and
  published it as a pre-release with `app-release.apk.sha256` (run `38035941766`, `app-release.apk`
  154,978,882 bytes). The build's own checks passed: the Vosk model is inside the APK, the package name is
  `uz.reavailable.app`, and the permissions are the expected ones. The same checks passed for
  `android-v0.1.0-test1` (commit `1320a8c`, run `37966899132`). The sandbox cannot download release assets,
  so the published file itself was not re-checked here.
- **Model download**: the CI runner downloads the Vosk archive from `alphacephei.com`. The step succeeds. The
  checksum is not pinned, so the download is not checked against a known value.
- **Production settings, locally**: with the documented production settings, `POST /api/v1/jobs` returns `401`
  without the API key and `202` with it.

## 3. Not verified

These were **not** tested in the sandbox. Do not report them as working.

| Area | Why not | What would verify it |
| --- | --- | --- |
| On-device voice recognition (react-native-vosk, the four commands) | Needs a phone and a microphone | Manual checklist, §4, step 6 |
| Recognition in noise and speaker echo | Needs a real room and speaker | Manual checklist, §4, step 6 |
| Background playback and lock-screen controls | Needs a phone | Manual checklist, §4, step 5 |
| Installing and running the Android APK on a phone | The APK is built on a GitHub runner, but no phone was used | Manual checklist, §4, steps 1 to 4 |
| Live Azure calls (Uzbek quality, Cyrillic output, quotas, errors with a real key) | No credentials and no network access to Azure in the sandbox | Manual checklist, §4, step 3 |
| iOS build | Needs a Mac with Xcode and an Apple developer account for signing | `npm run ios` on a Mac |
| Vosk model checksum | The CI runner downloads the model, but the checksum is not pinned, so the download is not checked against a known value | Record the archive SHA-256 from the official release and set `VOSK_MODEL_SHA256` |
| Hosted backend (HTTPS, persistent volume, rate limit) | No hosting account and no public address from the sandbox | Deploy `backend/Dockerfile`, check `https://<host>/api/v1/health`, then run §4 against it |
| Deploying the Worker to a real Cloudflare account | `api.cloudflare.com` is not reachable from the sandbox, so `wrangler deploy` could only run as `--dry-run` | Run the `Deploy speech server (Cloudflare Workers)` workflow; it verifies `/health` and `/config` on the live address |
| Live Azure speech from the Worker | No network access to `*.tts.speech.microsoft.com` and no key in the sandbox | Deploy with a real `AZURE_SPEECH_KEY`, then add a book and listen (manual checklist §4, step 3) |
| The Uzbek and English wording as rendered on a device | The catalogue and the presentation rules are unit-tested, but no screen was rendered | Manual checklist §4: switch the language in Settings and read every screen |
| Release signing | The APK uses the debug keystore, which is fine for testing only | Create a release keystore and configure signing before wider distribution |
| File picker (`transcriptFile.ts`) | Native picker, not unit-tested | Manual checklist, §4, step 4 |
| Restore from OS backups | Needs devices and a backup | Manual, if the backup policy is kept |
| `npx expo install --check` | Needs access to Expo's API, which the sandbox blocks (the attempt failed with a socket error). The versions were compared by hand instead (§2) | Run it once on a machine with network access |
| Behaviour under real rate limits | Rate limiting belongs to the reverse proxy, which is not part of this repository | Load test in the deployment environment |

## 4. Manual checklist for a device

Run these on a development build with a backend that uses the real provider, unless a step says otherwise.
Record the results in the pull request.

1. **Model.** Run `scripts/fetch-vosk-model.sh` with the default URL. Record the printed SHA-256, check it
   against the official release, then set `VOSK_MODEL_SHA256` to that value for later runs.
2. **Build.** Install the Android test APK from the Releases page (check its SHA-256 first), or run
   `npm run android`. For iOS, run `npm run ios` on a Mac. Grant the microphone permission on first use.
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
10. **Languages.** In **Settings**, switch the interface language to English and back to Uzbek. Check every
    screen: the library list, a book's status line and progress, the player (status, part list, voice card),
    the add-book form including its validation messages, and Settings itself. Kill the app and reopen it: the
    choice must survive. Add a book that fails (for example stop the server) and check that the failure text
    follows the current language.

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

# End-to-end against the Python backend
# (new terminal: backend running on port 8000 with AUDIOBOOK_TTS_PROVIDER=fake)
cd mobile && E2E_API_BASE_URL=http://127.0.0.1:8000 npm run test:e2e

# Worker
cd ../worker
npm ci
npm run typecheck && npm test
npx wrangler d1 migrations apply reavailable-audiobooks --local
npx wrangler deploy --dry-run --outdir /tmp/worker-dist

# End-to-end against the Worker
# (new terminal: wrangler dev on port 8787 with the fake provider, see worker/README.md)
cd ../mobile && E2E_API_BASE_URL=http://127.0.0.1:8787 npm run test:e2e
```

Use a separate `AUDIOBOOK_DATA_DIR` for the end-to-end backend, so that test data does not mix with development
data.
