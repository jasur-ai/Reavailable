# Reavailable mobile app

React Native and Expo (SDK 57) app in TypeScript. It downloads audio parts from the Reavailable
backend, stores them on the phone, plays them offline, and listens for three English voice
commands: **next**, **repeat**, and **pause** (plus **resume**). The app never recognizes Uzbek
speech.

See [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md) for the design and
[`../docs/TESTING.md`](../docs/TESTING.md) for what has and has not been verified.

## Requirements

- Node.js `^20.19.4 || ^22.13.0 || ^24.3.0 || >=25.0.0` (CI uses Node 22)
- npm
- Voice control needs a **development build** (`npm run android` or `npm run ios`). Expo Go does
  not include the native speech module, so voice control reports itself as unavailable there.

## Setup

```bash
cd mobile
npm ci
npm run check        # type check, lint, unit tests with coverage thresholds
```

Do not run `npm audit fix --force`. It can break the pinned Expo versions. The `npm audit`
findings are explained in the limitations below.

## Offline English model (voice commands)

The voice model is not committed. Download it once before building a development build:

```bash
scripts/fetch-vosk-model.sh            # downloads about 40 MB into assets/model-en-us
scripts/fetch-vosk-model.sh --force    # replace an existing copy
VOSK_MODEL_URL=file:///path/to/model.zip scripts/fetch-vosk-model.sh   # use a local archive
VOSK_MODEL_SHA256=<hex> scripts/fetch-vosk-model.sh                    # refuse any other archive
```

The script prints the archive's SHA-256. No checksum is built in, because it could not be verified from the
development sandbox. Check the printed value against the official release once, then set `VOSK_MODEL_SHA256`
to it. Until then the script warns that the archive is unverified.

The script checks that the archive contains `am/final.mdl` before it installs the model. The
`react-native-vosk` plugin in `app.json` bundles `assets/model-en-us` into the build. If the model
is missing, the app still runs. Voice control then reports that the model could not be loaded.

### Configuration

The app reads one optional build-time variable:

| Variable | Default | Meaning |
| --- | --- | --- |
| `EXPO_PUBLIC_DEFAULT_SERVER_URL` | empty | Server address a new installation starts with. Read by `src/core/config.ts` |

Everything else is entered in **Settings**: the server address and the access key. The address is stored in
the library document; the key is stored in the device keystore and kept in memory for the session. There is
no `.env` file and no secret is compiled into the app.

The Android release workflow bakes the address in from the repository variable `DEFAULT_SERVER_URL`, so a
published APK can open with the server already filled in. Without it the app asks for the address on first
launch. The address is a public URL, not a credential.

## Interface languages

The interface is in **Uzbek by default**, with English available in **Settings → Interface language**. The
choice is stored in the library document, so it survives a restart, and it applies immediately: every screen
re-renders, including the status of each book.

- `src/i18n/strings.ts` is the whole catalogue: every key exists in both languages, and a test fails if a key
  is missing one of them or if the `{placeholders}` differ between the two.
- `src/i18n/translate.ts` produces a plain function `t(key, params)`. The presentation helpers take it as an
  argument, so they stay free of React and are unit-tested under Node.
- `src/ui/TranslateContext.tsx` provides it to the screens; `AppRoot` builds it from the stored language.
- Notes stored on a book (sync notes, error messages) are written in the language that was current at the
  time. Known error codes are re-translated on every render, so they follow a language switch; only an
  unknown server message stays in the language it arrived in.
- **Voice commands stay English in both languages** (`next`, `repeat`, `pause`, `resume`). The on-device
  recognizer uses a closed English grammar; the app never recognizes Uzbek speech.

## Android test build

The test APK is published as a pre-release on the [Releases page](https://github.com/jasur-ai/Reavailable/releases).
Pre-releases use the tag pattern `android-v*`; use the newest one. Each release carries one APK per CPU
architecture plus a `.sha256` file for each.

1. Download the APK for the phone: `app-arm64-v8a-release.apk` (phones from roughly 2017 onwards) or
   `app-armeabi-v7a-release.apk` (older 32-bit phones). If one refuses to install, use the other.
2. Check it: `sha256sum -c app-arm64-v8a-release.apk.sha256`.
3. Allow installs from the app you open the file with, then open the APK.
4. Open **Settings** and enter the HTTPS address of your server and its access key. The server is either the
   Cloudflare Worker ([worker/README.md](../worker/README.md)) or the container
   ([backend/README.md](../backend/README.md)).
5. Tap **Test connection**: it reports the server version, its provider and the available voices, and it
   tells you whether the access key was accepted.

The APKs are signed with the Expo debug keystore, so they are for testing and sideloading, not for the Play
Store. Their voice model is the one the build downloads from `alphacephei.com` (see the limitations).

The build splits per CPU architecture (`armeabi-v7a` and `arm64-v8a`), because the offline speech model plus
the native libraries of React Native, Hermes and Vosk make a single all-architecture APK about 148 MB, which
is a fragile download on a phone. A universal APK is built as a fallback but is not published. The build
checks every APK it produces: the model is inside, the native libraries match the architecture in the file
name and contain no other architecture, the package name is `uz.reavailable.app`, and the permissions are the
expected ones.

The build runs on GitHub Actions in [`.github/workflows/android-build.yml`](../.github/workflows/android-build.yml).
Pushing a tag named `android-v*` publishes a release ([`android-release.yml`](../.github/workflows/android-release.yml)).
Pushes that change `mobile/` also build the APK ([`android-apk.yml`](../.github/workflows/android-apk.yml)). The
build checks that the model is inside the APK, that the package name is `uz.reavailable.app`, that the app asks for
the microphone and internet permissions, and that it does not ask for the overlay, vibration or external-storage
permissions.

## Running

```bash
npm start              # Expo dev server
npm run android        # native build with the development client
npm run ios
```

The `android/` and `ios/` folders are generated by `expo prebuild` and are not committed. Run
`npm run prebuild` to regenerate them after a change to `app.json` or to a native plugin.

On first launch open **Settings** and enter the server address, for example `https://your-server.example`.
Enter the access key only if the server operator set one (`AUDIOBOOK_API_KEY`).

Use HTTPS. Access tokens are sent in request headers, and Android release builds block cleartext HTTP. A
plain `http://` address (for example `http://192.168.1.20:8000` on a local network) works only in development
builds started with `npm run android`.

## How a book reaches the phone

1. **Add book**: paste text or pick a UTF-8 `.txt` or `.md` file (1 MB limit). The title is
   required. The transcript is limited to 200,000 characters.
2. The app uploads the book. The server returns a per-book access token, which is stored in the
   device keychain (`expo-secure-store`, `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`).
3. The app polls until the parts are ready, then downloads each part. Every part is checked against
   its SHA-256 before it is written to app storage.
4. The app acknowledges the verified parts. The server deletes a part only after the checksum in
   the acknowledgement matches.
5. Playback works from the files on the phone. Restarting the app or losing the network does not
   touch the server.

The server copy is removed when every part is acknowledged, or after the server's retention period
(24 hours by default) if the phone never acknowledges it. The phone copy is removed only when you
remove the book.

## Scripts

| Script | What it does |
| --- | --- |
| `npm start` | Expo dev server |
| `npm run android` / `npm run ios` | Build and run a development client |
| `npm run prebuild` | Regenerate the native projects (`expo prebuild --clean`) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (Expo flat config, plus `no-console` for app code) |
| `npm test` | 220 unit tests with coverage thresholds (lines, statements, functions: 85%) |
| `npm run test:e2e` | End-to-end tests against a running backend (see below) |
| `npm run check` | `typecheck`, `lint`, and `test` |

### End-to-end tests

Start the backend with the fake speech provider, then point the tests at it:

```bash
# terminal 1, from the repository root
cd backend && AUDIOBOOK_TTS_PROVIDER=fake AUDIOBOOK_DATA_DIR=/tmp/audiobook-e2e \
  .venv/bin/uvicorn app.main:create_app --factory --host 127.0.0.1 --port 8000

# terminal 2
cd mobile && E2E_API_BASE_URL=http://127.0.0.1:8000 npm run test:e2e
```

The same suite runs against the Cloudflare Worker:

```bash
# terminal 1
cd worker && npx wrangler dev --port 8787 --var TTS_PROVIDER:fake --var ALLOW_FAKE_PROVIDER:true \
  --var ALLOWED_VOICES:fake-uz --var DEFAULT_VOICE:fake-uz --var VERSION:dev

# terminal 2
cd mobile && E2E_API_BASE_URL=http://127.0.0.1:8787 npm run test:e2e
```

The suite reads `/api/v1/config` when the server has it (the Worker does, the Python backend does not) and
accepts a `404` there, so it works against both implementations. CI runs it against both.

Without `E2E_API_BASE_URL` the suite is skipped, so `npm run check` stays offline.

## Project structure

```
App.tsx, index.ts          entry points
app.json                   Expo configuration and native plugin options
scripts/fetch-vosk-model.sh
src/
  core/                    pure TypeScript, no native imports (unit-tested)
    config.ts              build-time defaults (the optional baked-in server address)
    messages.ts            error codes to user-facing wording, in the current language
    api/client.ts          HTTP client: timeouts, bearer token, checksum checks, /config
    sync/syncEngine.ts     download, verify, acknowledge, resume, retry, removal
    sync/chunkFiles.ts     file layout and verification of stored parts
    library/library.ts     in-memory library with coalesced persistence
    playback/playbackController.ts   queue, auto-advance, saved position
    voice/commands.ts      closed grammar and command parsing
    voice/voiceService.ts  recognizer lifecycle, confidence, cooldown
  i18n/                    language list, the string catalogue (uz + en), the translator
  platform/                adapters to native modules
    audio/expoAudioPlayer.ts
    speech/voskRecognizer.ts       lazy-loads react-native-vosk
    storage/fileStores.ts, secureStores.ts
    documents/transcriptFile.ts    .txt / .md picker
    crypto/sha256.ts
  app/                     wiring: bootstrap, services, React context
  ui/                      screens, components, presentation helpers, TranslateContext
tests/
  unit/                    Jest suites and in-memory fakes (tests/unit/support)
  e2e/                     live backend contract tests
```

## Privacy and storage

- Audio is stored under the app's document directory (`Paths.document`). Uninstalling the app, or
  clearing its data, deletes it. The Settings screen says so.
- The app does not log transcript text. The source has no `console.*` calls, and ESLint enforces it.
- The server access token lives only in the keychain entry for that book.

## Known limitations

- Not verified on a device: on-device recognition quality, behaviour in noisy rooms, speaker echo,
  background audio playback with the screen locked, and installing and running the Android APK on a phone.
  The APK is built on a GitHub runner. The iOS app has not been built.
- Voice control depends on the bundled model. The build downloads it from `alphacephei.com`. The checksum is
  not pinned yet, so the download is not verified against a known value.
- Library data is stored as one JSON document. Writes are coalesced, but the whole document is
  still rewritten on each batch of changes. This is fine for a personal library, not for thousands
  of books.
- OS-level backups (iCloud, Android auto-backup) are not turned off in `app.json`, which is a
  deliberate decision. The access token is device-only, so a restored backup should keep its audio
  for offline playback but not sync. This has not been tested on a device.
- `npm audit` reports 54 findings. They come from four advisories, all in build, test and development tooling. `braces`, `node-forge` and `sprintf-js` have no fixed release yet. `uuid` is fixed only in a newer major version, and the old copy comes from Expo's iOS build tooling. `expo export` shows that none of them is in the app bundle. Do not run `npm audit fix --force`.
- `npm ci` warns that ESLint 9 is no longer supported. The ESLint plugins used by `eslint-config-expo` do not
  support ESLint 10 yet (see [PLAN_REVIEW](../docs/PLAN_REVIEW.md#4-open-items)).
- The app icon and splash screen are Expo defaults.
