# Reavailable: Offline Audiobook Reader

Reavailable reads an Uzbek text aloud on a phone without a network connection after the book has been
downloaded. A server turns the text into short audio parts with cloud Uzbek speech voices. The phone
downloads each part, checks it, stores it, and confirms it to the server. Only then does the server delete
its copy. Playback is controlled with four English voice commands, recognized on the device. The app never
recognizes Uzbek speech.

The interface is in **Uzbek by default**, with an English switch in Settings. The server can be hosted on
Cloudflare Workers (recommended, [`worker/`](worker)) or run as a container on your own machine
([`backend/`](backend)).

## How it works

1. **Add a book.** Paste the text or pick a UTF-8 `.txt` or `.md` file.
2. **The server prepares it.** The text is split into parts of one or two sentences. Each part is
   synthesized separately with a neural Uzbek voice (Azure: `uz-UZ-MadinaNeural` or `uz-UZ-SardorNeural`).
3. **The phone downloads it.** Each part is checked against its SHA-256 checksum, stored on the device, and
   acknowledged. The server deletes a part only after the checksum in the acknowledgement matches. Books that
   are never acknowledged expire after 24 hours by default.
4. **Listen offline.** Say **next**, **repeat**, **pause**, or **resume**. Recognition runs on the device
   with a closed English grammar, so nothing is sent to a server to be recognized.

## Get the app

**Android (test build).** Open the newest pre-release on the
[releases page](https://github.com/jasur-ai/Reavailable/releases) and download **one** APK:
`app-arm64-v8a-release.apk` for phones from roughly 2017 onwards (almost every phone), or
`app-armeabi-v7a-release.apk` for older 32-bit phones. Each is about 70 MB, because the build is split per
CPU architecture; a single APK with all four architectures would be about 148 MB. Each APK has a matching
`.sha256` file (`sha256sum -c <file>.sha256`). Allow installs from the app you open the file with, and
install it. The APKs are debug-signed, so they are for testing and sideloading, not for the Play Store.
They need a running Reavailable server (see below). They have not been installed and tested on a phone yet.

Step-by-step instructions in Uzbek, from installing the APK to hearing the first book, are in
[docs/UZ_INSTALL.md](docs/UZ_INSTALL.md).

**iOS.** Not built. Building for iPhone needs an Apple developer account for signing.

## Run a server

The app needs a Reavailable backend that is reachable over HTTPS. There are two implementations of the same
API; pick one.

### Option A: Cloudflare Workers (recommended)

No machine to run, no volume, no reverse proxy, and an HTTPS address from `workers.dev`. The Worker keeps
job state in D1 and audio in R2, and deletes each part as soon as the phone confirms it.

1. Add three repository secrets (Settings → Secrets and variables → Actions): `CLOUDFLARE_API_TOKEN`,
   `AZURE_SPEECH_KEY`, `AUDIOBOOK_API_KEY`.
2. Run the workflow **Deploy speech server (Cloudflare Workers)** (Actions tab → Run workflow).
3. Install the APK the workflow publishes for you: it writes the address into the app, commits it and
   pushes a release tag, so the newest pre-release opens with the server already filled in. You only enter
   the value of `AUDIOBOOK_API_KEY` under **Access key**. Older builds need the address typed in by hand.

The workflow provisions the database and the bucket, deploys, verifies the live endpoint, and only then
publishes. Its input `require_access_key: false` deploys without an operator key, which is not
recommended: this repository is public, so the address is public and anyone could create books and spend
your Azure free quota. Details, all settings and tuning notes: [worker/README.md](worker/README.md).

### Option B: your own container

The backend is in `backend/` and builds into a container image. Run it on any host that runs containers (a VPS, or a platform such as Render or
Railway that can build from a Dockerfile):

```bash
docker build -t reavailable-backend backend
docker run --detach --publish 8000:8000 --volume reavailable-data:/data \
  --env AUDIOBOOK_API_KEY='choose-a-long-random-value' \
  --env AUDIOBOOK_TTS_PROVIDER=azure \
  --env AUDIOBOOK_AZURE_SPEECH_KEY='your-azure-speech-key' \
  --env AUDIOBOOK_AZURE_SPEECH_REGION='your-azure-region' \
  reavailable-backend
```

The image runs in production mode. It refuses to start until the API key and the Azure settings are set.
The `fake` speech provider is for tests only and is refused in production mode. Put the container behind
HTTPS and a rate limit. Then open **Settings** in the app, enter the HTTPS address and the API key, and
test the connection. [backend/README.md](backend/README.md) lists every setting and the deployment
requirements.

## Status

| Part | State | How it was checked |
| --- | --- | --- |
| Backend API, chunking, synthesis pipeline, acknowledgement, retention | Complete | 110 pytest tests, ruff, mypy, live end-to-end run |
| Backend container image | Built and smoke-tested in CI | Build, production guard, health check, non-root user, job creation |
| Cloudflare Worker backend (`worker/`) | Complete | 117 vitest tests inside workerd against real local D1 and R2, strict type check, bundle dry-run, live `wrangler dev` run through the whole download flow |
| Worker and mobile app together | Verified locally | The mobile end-to-end suite (5 tests) run against a live Worker |
| Interface languages (Uzbek default, English switch) | Complete | Catalogue completeness test: every key has both languages and matching placeholders |
| Deployment to a real Cloudflare account | **Not verified** | `api.cloudflare.com` is unreachable from the build sandbox; the deploy workflow checks the live endpoint itself |
| Mobile sync (download, verify, acknowledge, resume, retry) | Complete | 220 unit tests, live end-to-end runs against both backends |
| Mobile playback logic | Complete | 32 playback tests |
| Voice commands (logic) | Complete | Unit tests with fakes |
| Android test APK | Published as a pre-release, built on a GitHub runner | Model included, package name and permissions checked in the build |
| Voice recognition on a phone | **Not verified** | Needs a device; see [docs/TESTING.md](docs/TESTING.md) |
| Background playback and lock-screen controls | **Not verified** | Needs a device |
| Installing and running the APK on a phone | **Not verified** | Needs a device |
| Live Azure speech calls | **Not verified** | Needs an Azure key and network access |
| iOS build | **Not built** | Needs an Apple developer account |

Continuous integration (`.github/workflows/ci.yml`) runs six jobs: `backend`, `mobile`, `worker`,
`end-to-end` (mobile suite against the Python backend), `container`, and `worker-end-to-end` (mobile suite
against a live Worker). The open items and their reasons are in [docs/PLAN_REVIEW.md](docs/PLAN_REVIEW.md#4-open-items).

## Repository layout

```
worker/       Cloudflare Worker backend (TypeScript): API, chunking, Azure speech, D1 + R2, tests
backend/      FastAPI service (Python 3.11+) and its container image: the same API, for self-hosting
mobile/       Expo SDK 57 app (React Native, TypeScript): sync, playback, voice, UI, i18n, tests
docs/         Architecture, plan review, testing report, Uzbek installation guide
.github/      CI, Cloudflare deploy, and the Android build and release workflows
```

## Quick start (development)

### Worker backend

```bash
cd worker
npm ci
npx wrangler d1 migrations apply reavailable-audiobooks --local
npm run dev -- --port 8787 --var TTS_PROVIDER:fake --var ALLOW_FAKE_PROVIDER:true \
  --var ALLOWED_VOICES:fake-uz --var DEFAULT_VOICE:fake-uz
npm test          # 117 tests inside workerd with a real local D1 and R2
```

Then point the end-to-end suite at it:

```bash
cd ../mobile && E2E_API_BASE_URL=http://127.0.0.1:8787 npm run test:e2e
```

See [worker/README.md](worker/README.md) for configuration, deployment and tuning.

### Python backend

```bash
cd backend
python3 -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:create_app --factory --host 0.0.0.0 --port 8000
```

Open http://localhost:8000/docs. The default speech provider is `fake`, which produces a quiet test tone
instead of speech, so the whole pipeline runs without cloud credentials. See
[backend/README.md](backend/README.md) for configuration, the API, and deployment requirements.

### Mobile app

```bash
cd mobile
npm ci
npm run check        # type check, lint, unit tests
npm start            # Expo dev server
```

Voice control needs a development build and the offline English model:

```bash
scripts/fetch-vosk-model.sh
npm run android      # or: npm run ios
```

On first launch, enter the server address in **Settings**. See [mobile/README.md](mobile/README.md) for details.

### End-to-end tests

With the backend running on port 8000 (fake provider, separate data directory):

```bash
cd mobile && E2E_API_BASE_URL=http://127.0.0.1:8000 npm run test:e2e
```

## Privacy and security

- Audio and transcript text stay on the server only until the phone acknowledges each part, or until the
  retention period (24 hours by default) ends.
- Every book has its own 256-bit access token. The server stores only its digest. Unknown, expired and
  foreign books return the same `404`.
- An operator API key can be required to create books. Production refuses to start without it, and with the
  fake speech provider.
- Logs contain identifiers, part positions and error codes, never transcript text.
- The phone keeps the book's token in the device keychain and its audio in the app's own storage.
- The Android app requests only the permissions it uses: internet, microphone (for voice commands), audio
  playback, and the media playback service.

Deployment must add HTTPS and per-IP rate limiting at a reverse proxy. Both are described in
[backend/README.md](backend/README.md#deployment-requirements). To report a vulnerability, see
[SECURITY.md](SECURITY.md).

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): components, data lifecycle, backend and mobile design, key decisions
- [docs/PLAN_REVIEW.md](docs/PLAN_REVIEW.md): plan requirements, review findings and fixes, deviations, open items
- [docs/TESTING.md](docs/TESTING.md): what is tested, what is verified, what is not, a manual device checklist
- [docs/UZ_INSTALL.md](docs/UZ_INSTALL.md): o'rnatish va sozlash bo'yicha o'zbekcha yo'riqnoma
- [worker/README.md](worker/README.md): hosted backend, configuration, deployment, limits, troubleshooting
- [backend/README.md](backend/README.md): backend setup, configuration, API, container, deployment
- [mobile/README.md](mobile/README.md): app setup, Android test build, scripts, voice model, storage, limitations

## Known limitations

- Voice recognition, background playback, installation on a phone and live Azure output have not been verified.
- The Android APK is debug-signed. A Play Store release needs a release keystore.
- The Python backend is a single instance backed by SQLite. A hosted deployment needs a persistent volume;
  the Cloudflare Worker in `worker/` has no such limit.
- The app library is stored as one JSON document, which suits a personal library.
- On a Workers Free plan a long book is produced over several background passes (8 parts per pass), so the
  first minutes after adding a book are spent synthesizing. Raise `CHUNKS_PER_PASS` on a paid plan.
- The Vosk model checksum is not pinned, so the model download is not verified against a known value.
- `npm audit` reports 54 findings. They come from four advisories, all in build, test and development tooling. `braces`, `node-forge` and `sprintf-js` have no fixed release yet. `uuid` is fixed only in a newer major version, and the old copy comes from Expo's iOS build tooling. `expo export` shows that none of them is in the app bundle. Do not run `npm audit fix --force`.

## License

No license has been chosen yet. This is an owner decision. Until a license file is added, default copyright
rules apply.
