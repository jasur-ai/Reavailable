# Plan review

This document checks the project against the source plan, "Offline Audiobook Reader App — Project
Plan" (Google Drive). It records four things:

1. how each requirement of the plan is implemented, and what evidence supports it;
2. the weaknesses found while reviewing the plan and the first implementation, and the fixes applied;
3. where the implementation deliberately differs from the plan, and why;
4. what is still open. Some of it cannot be closed in the development sandbox.

Evidence references point to test names in the repository. Items marked **not verified** were not
tested in the sandbox and must not be treated as verified. See [TESTING.md](TESTING.md).

## 1. Requirements and their status

| Plan requirement | Status | Where | Evidence |
| --- | --- | --- | --- |
| Uzbek transcript is split into sequential 1–2 sentence chunks | Implemented | `backend/app/chunking.py` | `test_chunking.py` (19 tests), including abbreviations, decimals, URLs and Uzbek apostrophes |
| Chunks are synthesized with cloud Uzbek TTS | Implemented (Azure, uz-UZ voices). Live Azure **not verified** | `backend/app/tts/azure.py`, `fake.py` | `test_tts_providers.py` (SSML escaping, status mapping, no credentials in errors) |
| Chunks stay on the server until the device downloads and acknowledges them, then the server deletes them | Implemented | `services.py` (`acknowledge`), `api.py` | `test_acknowledging_every_chunk_deletes_the_job_and_its_audio`; e2e `syncs a book, verifies every part, removes the server copy…` |
| Offline playback is controlled only by English voice commands (next, repeat, pause) | Implemented, with `resume` added (see §2.1). Device recognition **not verified** | `mobile/src/core/voice/` | `voiceCommands.test.ts`, `voiceService.test.ts` |
| The app never recognizes Uzbek speech | Implemented: the grammar is closed and English only | `commands.ts` (`VOICE_GRAMMAR`) | `contains exactly the four commands…` |
| Roadmap 1: backend pipeline (TTS, chunking, storage) | Done | `backend/` | 110 backend tests |
| Roadmap 2: app upload, download, ack-based deletion | Done | `mobile/src/core/sync/`, `mobile/src/core/api/` | `syncEngine.test.ts`, `syncEngine.recovery.test.ts`, `apiClient.test.ts` |
| Roadmap 3: local playback | Done in the logic layer. Background audio **not verified** | `playbackController.ts`, `expoAudioPlayer.ts` | 32 playback tests, including waiting for parts and load failures |
| Roadmap 4: offline English recognizer | Done in code. On-device recognition, noise and echo **not verified** | `voskRecognizer.ts`, `scripts/fetch-vosk-model.sh` | voice tests with fakes; model script tested with local archives only |
| Roadmap 5: end-to-end offline test | Done against the live backend. The fake speech provider is used | `mobile/tests/e2e/offline.e2e.test.ts` | 5 tests pass; after an offline restart the sync makes zero server calls |
| Quality: resume interrupted downloads before acknowledgement | Implemented | `syncEngine.ts` | `pauses after the attempts run out and resumes later without re-downloading stored parts`; `keeps the server copy until the acknowledgement succeeds…` |
| Quality: per-part offline status | Implemented | `presentation.ts`, `PlayerScreen.tsx` | `counts stored parts…`; `labels a part that is not known yet as waiting` |
| Quality: fewer false positives | Partly. Grammar, confidence, cooldown and headphone advice are implemented. Noise **not verified** | `voiceService.ts`, `commands.ts`, Settings | `blocks a second command inside the cooldown…`; `rejects low-confidence results…` |
| Quality: report synthesis failures, never silent audio | Implemented | `services.py` (fail-fast), `messages.ts`, `presentation.ts` | `test_permanent_failure_is_not_retried`; `marks a book failed with a readable message when synthesis fails on the server` |
| Privacy: no server persistence beyond the upload-to-download window | Implemented with a timer fallback (see §3). Text is dropped once a part is synthesized | `services.py`, `worker.py` (RetentionSweeper) | `test_transcript_text_is_dropped_once_a_part_is_synthesized`; `test_sweep_deletes_expired_jobs_and_their_audio` |
| Privacy: acknowledgement before deletion | Implemented | `services.py` (`acknowledge`) | `test_acknowledgement_with_wrong_checksum_is_rejected_and_nothing_is_deleted` |
| Privacy: analytics kept separate from transcripts | No analytics exist, so nothing needs separating. Any future analytics must not carry transcript text | — | — |
| Open question: voice choice | Decided: `uz-UZ-MadinaNeural` (default) and `uz-UZ-SardorNeural`. Quality **not verified** | `config.py` | `test_voice_selection_is_honoured` |
| Open question: recognition library | Decided: `react-native-vosk` 2.1.7 with the small English model | `voskRecognizer.ts` | — |
| Open question: extra commands (back, faster, slower) | **Not implemented.** Only next, repeat, pause and resume | — | — |
| Future: multiple books | Already supported by the library | `library.ts` | `stores inserted books and persists them` |
| Future: bookmarks | Only the saved position per book exists | `playbackController.ts` | `opens a book at its saved part, paused` |
| Future: adjustable chunk size | Partly: 1 or 2 sentences per part, chosen at creation | `schemas.py`, `chunking.py` | `test_single_sentence_mode`; `test_chunks_group_two_sentences_by_default` |
| Future: offline Uzbek TTS | Out of scope | — | — |

## 2. Review findings and fixes

Each finding is a weakness in the plan, in the first implementation, or in the way it was tested. The
fix is in the repository.

### 2.1 Pause alone cannot resume hands-free
- **Finding.** With only `pause`, the user could stop playback by voice but had no voice command to
  continue.
- **Fix.** Added `resume`. `resume` calls play. `next` moves to the following part. `repeat` restarts
  the current part from the beginning.
- **Evidence.** `contains exactly the four commands…`; `plays, pauses and resumes without reloading the part`; `repeats the current part from its beginning`.

### 2.2 Access to a book
- **Finding.** The plan does not say how a phone proves that it owns a book. Without that, anyone who
  learns an identifier could read or delete its audio.
- **Fix.** Each book gets its own 256-bit bearer token (`secrets.token_urlsafe(32)`). The server stores
  only its SHA-256 digest and compares digests in constant time. Unknown, expired and foreign books all
  return `404 job_not_found`, so identifiers cannot be probed. Job creation can require an operator API
  key (`X-API-Key`). Production refuses to start without the key and with the fake provider. The phone
  stores the token in the keychain (`expo-secure-store`), never in the library file.
- **Evidence.** `test_access_token_is_stored_only_as_a_digest`; `test_wrong_token_and_unknown_job_are_indistinguishable`; `test_one_jobs_token_cannot_access_another_job`; `test_operator_api_key_protects_job_creation`; `test_production_refuses_the_fake_provider_and_requires_an_api_key`; `stores the access token in the vault, never in the library file`.

### 2.3 Retention relied only on the acknowledgement
- **Finding.** If a phone never acknowledges a book (lost, uninstalled, offline for good), its audio and
  its transcript text would stay on the server indefinitely.
- **Fix.** Every book expires after `AUDIOBOOK_JOB_TTL_HOURS` (default 24). A sweeper runs every 15
  minutes and removes expired books and orphaned files. The timer is only a fallback. See §3.
- **Evidence.** `test_expired_jobs_are_invisible_before_the_sweep_runs`; `test_sweep_deletes_expired_jobs_and_their_audio`; `test_sweep_removes_audio_directories_without_a_job`.

### 2.4 One long audio file would need slicing
- **Finding.** Synthesizing one long file and cutting it into parts would make the boundaries depend on
  the audio, and a failed slice would damage the whole file.
- **Fix.** Each 1–2 sentence part is synthesized separately, and its index is kept with it.
- **Evidence.** `test_chunk_results_are_mapped_to_the_right_positions_under_concurrency` (40 parts, checked
  one by one).

### 2.5 Acknowledgement had no integrity check
- **Finding.** The server could delete a part that the phone had stored damaged, or a retried request could
  delete the wrong part.
- **Fix.** The acknowledgement carries the SHA-256 of each part. The server validates the whole batch
  before it changes anything. A mismatch rejects the batch and nothing is deleted. Repeating an
  acknowledgement is a successful no-op. The phone checks the size and the SHA-256 of every download
  before it writes the file, and also checks the `X-Content-SHA256` header.
- **Evidence.** `test_acknowledgement_with_wrong_checksum_is_rejected_and_nothing_is_deleted`; `test_failed_batch_is_atomic`; `test_repeating_an_acknowledgement_is_idempotent`; `retries corrupted downloads and does not store bytes that fail the announced checksum`.

### 2.6 Playback position
- **Finding.** The plan does not say where playback resumes after the app is closed.
- **Fix.** The saved position is the part index, stored per book. It is clamped if the book shrinks, and
  it is not written again when it has not changed.
- **Evidence.** `opens a book at its saved part, paused`; `clamps a saved position that is beyond the last part`; `does not write the same saved position again`.

### 2.7 False triggers and speaker echo
- **Finding.** Free-form recognition would match many words in ordinary speech and in the speaker's own
  output.
- **Fix.** Closed grammar of four commands plus `[unk]`. Only single-word final results count. `[unk]` is
  rejected. Results below a confidence of 0.5 are rejected when the engine reports one. After a command is
  accepted, results are ignored for 1.5 s. Settings advises headphones.
- **Evidence.** `rejects low-confidence results from the engine`; `blocks a second command inside the cooldown and accepts it after the cooldown`; `does not start the cooldown for results that were rejected`.
- **Not verified:** recognition in noisy rooms, and echo from the speaker. These need a device test.

### 2.8 Single on-device copy and data loss
- **Finding.** Audio exists only on the phone once the server copy is deleted. Uninstalling the app loses it.
- **Fix.** Settings warns that uninstalling or clearing the app's data deletes the audio. Audio is stored
  under the app's document directory. OS backup behaviour is left at the platform default, which is a
  documented decision (see §4).
- **Evidence.** Settings text (reviewed, not unit-tested). **Not verified** on a device.

### 2.9 Cost and abuse
- **Finding.** A single request could create a very large synthesis job, and a chunked upload has no declared
  size that the server can check before reading it.
- **Fix.** Transcript limit 200,000 characters. Maximum 3,000 parts per book. Request body limit 2 MB, with
  `Content-Length` required. **Found during this review:** the body limit was checked only when the
  `Content-Length` header was present, so a chunked body bypassed it. Chunked bodies are now refused with
  `411 length_required`. Rate limiting is not in the application. It must be configured at the reverse proxy,
  and the README lists it as a deployment requirement.
- **Evidence.** `test_creation_rejects_transcripts_over_the_length_limit`; `test_creation_rejects_jobs_that_produce_too_many_chunks`; `test_request_bodies_over_the_byte_limit_are_refused`; `test_chunked_request_bodies_are_refused_because_their_size_cannot_be_checked`.

### 2.10 Input methods
- **Finding.** The plan does not say how text gets into the app. Pasting long text on a phone is awkward.
- **Fix.** The user can paste text or pick a UTF-8 `.txt` or `.md` file of at most 1 MB. A byte-order mark is
  removed. Cyrillic text shows a warning.
- **Evidence.** `requires a title and a transcript`; `limits the title and the transcript length`; `detects Cyrillic script`; `test_cyrillic_transcripts_carry_a_warning`. The file picker itself (`transcriptFile.ts`) is **not unit-tested** and needs a device check.

### 2.11 Logs and transcript text
- **Finding.** Logs are the most common place where private text leaks.
- **Fix.** The backend logs identifiers, part positions, counts and error codes. A review of every logger call
  found no title, token or transcript. The mobile app has no `console` calls, and ESLint enforces it for
  `App.tsx`, `index.ts` and `src/**`. Error responses never echo submitted values.
- **Evidence.** `test_error_responses_never_echo_the_transcript` (responses). The logger check is a manual review, not an automated test.

### 2.12 A stored part could go missing
- **Finding.** If the device lost a stored file, the book could show as complete while playback fails.
- **Fix.** Each download pass checks that stored files still exist. A part that was acknowledged but whose file is
  gone is reported as lost. The app does not ask the server again, because the server copy is already deleted.
  A stored but unacknowledged part is downloaded again.
- **Evidence.** `marks an acknowledged part as lost when its file is gone, without asking the server again`; `downloads a stored-but-unacknowledged part again when its file is missing`.

### 2.13 Repeated checksum rejections retried forever
- **Finding.** If the server kept rejecting a part's checksum, the app downloaded that part again on every
  pass, forever.
- **Fix.** A part may be rejected twice. After the second rejection the book fails with `checksum_rejected`
  and waits for an explicit retry or removal. A manual retry resets the count.
- **Found during this review:** the counter was dropped whenever the manifest was refreshed, so the limit was
  never reached. The counter is now kept across refreshes.
- **Evidence.** `fails the book after the second rejection and stops re-downloading on later passes`; `starts a fresh attempt when the user retries after the server stops rejecting`.

### 2.14 Further fixes made during the final review
- **Library writes were coalesced.** Every chunk update used to rewrite the whole library file. Changes that
  arrive while a write is queued now share one write. A write that starts after a change includes it.
  Evidence: `writes once for a burst of changes…`; `keeps flush pending until a change made while a write is queued is on disk`.
- **Transcript text is no longer sent to the device.** The manifest used to carry each part's text. The device
  discarded it. It is removed from the API and from the client types. Evidence: `manifest…never the transcript text`.
- **Text is dropped once a part is synthesized.** It is kept only while the part is pending or failed (a failed
  part needs it for a retry). Evidence: `test_transcript_text_is_dropped_once_a_part_is_synthesized`.
- **Model download is checked when a checksum is given.** `scripts/fetch-vosk-model.sh` accepts
  `VOSK_MODEL_SHA256`. A mismatch stops the install and keeps the existing model. No checksum is built in,
  because it could not be verified from the sandbox. Checked with a local archive in six cases: good archive,
  wrong checksum, right checksum, bad archive, skip on an existing model, and a missing file.
- **Test names and fixtures were brought in line with the code.** One test still said "three commands" after
  `resume` was added. Stale `text` fields were removed from the test fixtures.
- **Node version is declared.** `package.json` has an `engines` field that matches Expo SDK 57.

## 3. Deviations from the plan

| Plan | Implementation | Reason |
| --- | --- | --- |
| "Chunks stay on the server until acknowledged… rather than relying on a timer" | Acknowledgement is the normal path. A 24-hour timer is a fallback | A phone that never acknowledges would otherwise keep audio and text forever. The timer bounds the damage. |
| Commands: next, repeat, pause | Adds `resume` | Without it, playback cannot be restarted by voice (§2.1) |
| Not specified: how a phone authenticates to a book | Per-book bearer token; optional API key for creation | §2.2 |
| Roadmap "app upload" | The user can paste text or pick a `.txt` or `.md` file | Pasting alone is awkward for long text on a phone |

## 4. Open items

These are not done. Each one says why.

**Needs a device or a live service (cannot be done in the sandbox):**
- Voice recognition on a device: accuracy of the four commands, noise, and echo (§2.7).
- Background playback and lock-screen controls on iOS and Android.
- Native builds for iOS and Android with `react-native-vosk`. Expo Go cannot run voice control.
- Live Azure calls: Uzbek pronunciation, Cyrillic output, quotas, cost, and region choice.
- The Vosk model download from `alphacephei.com`, which the sandbox cannot reach. The checksum is not pinned.

**Deployment decisions for the operator:**
- Rate limiting at the reverse proxy. The configuration is not provided.
- HTTPS. Access tokens are sent in headers. The app accepts `http://` for local development, and Android
  release builds block cleartext HTTP by default.
- OS backup policy. Backups are left at the platform default. The token is device-only, so a restored backup
  should not sync. This is untested.
- The backend is a single instance with SQLite. Moving to several instances needs a shared database and a queue.
- No Dockerfile. Docker is not available in the sandbox, so an image could not be built or tested.

**Product and code follow-ups:**
- Extra voice commands from the plan's open questions (back, faster, slower). Not implemented.
- Library persistence rewrites one JSON document. Fine for a personal library, not for thousands of books.
- `npm audit` reports 54 findings (12 moderate, 42 high) in the dependency tree. They are not triaged.
  `npm audit fix --force` must not be used, because it can break the Expo pins.
- No license has been chosen. The repository has no license file, which is an owner decision.
