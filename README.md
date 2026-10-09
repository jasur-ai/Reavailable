# Reavailable: Offline Audiobook Reader

Reavailable reads an Uzbek text aloud on a phone without a network connection after the book has been
downloaded. A server turns the text into short audio parts with cloud Uzbek speech voices. The phone
downloads each part, checks it, stores it, and confirms it to the server. Only then does the server delete
its copy. Playback is controlled with four English voice commands, recognized on the device. The app never
recognizes Uzbek speech.

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

**Android (test build).** Download `app-release.apk` and `app-release.apk.sha256` from the
[Releases page](https://github.com/jasur-ai/Reavailable/releases). Check the download with
`sha256sum -c app-release.apk.sha256`, allow installs from the app you open the file with, and install it.
The APK is debug-signed, so it is for testing and sideloading, not for the Play Store. It needs a running
Reavailable server (see below). It has not been installed and tested on a phone yet.

**iOS.** Not built. Building for iPhone needs an Apple developer account for signing.

## Run your own server

The app needs a Reavailable backend that is reachable over HTTPS. The backend is in `backend/` and builds
into a container image. Run it on any host that runs containers (a VPS, or a platform such as Render or
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
| Mobile sync (download, verify, acknowledge, resume, retry) | Complete | Unit tests, live end-to-end run |
| Mobile playback logic | Complete | 32 playback tests |
| Voice commands (logic) | Complete | Unit tests with fakes |
| Android release APK | Built on a GitHub runner | Model included, package name and permissions checked in the workflow |
| Voice recognition on a phone | **Not verified** | Needs a device; see [docs/TESTING.md](docs/TESTING.md) |
| Background playback and lock-screen controls | **Not verified** | Needs a device |
| Installing and running the APK on a phone | **Not verified** | Needs a device |
| Live Azure speech calls | **Not verified** | Needs an Azure key and network access |
| iOS build | **Not built** | Needs an Apple developer account |

Continuous integration (`.github/workflows/ci.yml`) passed for the backend, mobile, end-to-end and container jobs on
commit `1320a8c`. The open items and their reasons are in [docs/PLAN_REVIEW.md](docs/PLAN_REVIEW.md#4-open-items).

## Repository layout

```
backend/      FastAPI service (Python 3.11+) and its container image: API, chunking, speech providers, storage, tests
mobile/       Expo SDK 57 app (React Native, TypeScript): sync, playback, voice, UI, tests
docs/         Architecture, plan review, testing report
.github/      CI workflow and the Android build and release workflows
```

## Quick start (development)

### Backend

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
- [backend/README.md](backend/README.md): backend setup, configuration, API, container, deployment
- [mobile/README.md](mobile/README.md): app setup, Android test build, scripts, voice model, storage, limitations

## Known limitations

- Voice recognition, background playback, installation on a phone and live Azure output have not been verified.
- The Android APK is debug-signed. A Play Store release needs a release keystore.
- The backend is a single instance backed by SQLite. A hosted deployment needs a persistent volume.
- The app library is stored as one JSON document, which suits a personal library.
- The Vosk model checksum is not pinned, so the model download is not verified against a known value.
- `npm audit` reports 54 findings. They come from four advisories, all in build, test and development tooling. `braces`, `node-forge` and `sprintf-js` have no fixed release yet. `uuid` is fixed only in a newer major version, and the old copy comes from Expo's iOS build tooling. `expo export` shows that none of them is in the app bundle. Do not run `npm audit fix --force`.

## License

No license has been chosen yet. This is an owner decision. Until a license file is added, default copyright
rules apply.
