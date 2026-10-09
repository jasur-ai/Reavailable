/**
 * Composition root: wires the pure core to the platform adapters. Nothing outside this file knows
 * which concrete implementation is used.
 */

import { ApiClient, normalizeBaseUrl } from '../core/api/client';
import { Library } from '../core/library/library';
import { PlaybackController, type PlaybackSnapshot } from '../core/playback/playbackController';
import { SyncEngine } from '../core/sync/syncEngine';
import type { VoiceCommand } from '../core/voice/commands';
import { VoiceCommandService, type SpeechRecognizerPort, type VoiceSnapshot } from '../core/voice/voiceService';
import { ExpoAudioPlayer, configureAudioSession } from '../platform/audio/expoAudioPlayer';
import { sha256Hex } from '../platform/crypto/sha256';
import { createAudioStore, createLibraryPersistence } from '../platform/storage/fileStores';
import { createTokenVault, serverKeyStore } from '../platform/storage/secureStores';
import { createVoskRecognizer, loadVoskModule } from '../platform/speech/voskRecognizer';

const REQUEST_TIMEOUT_MS = 20_000;

const VOICE_UNAVAILABLE_MESSAGE =
  'Offline voice control is not available in this build. It needs a development build that includes the speech module (not Expo Go).';

/** Used when the native speech module is missing. Every start attempt fails with a clear message. */
const NO_RECOGNIZER: SpeechRecognizerPort = {
  start: () => Promise.reject(new Error(VOICE_UNAVAILABLE_MESSAGE)),
  stop: () => Promise.resolve(),
  onResult: () => () => undefined,
  onError: () => () => undefined,
  onStopped: () => () => undefined,
};

export interface ServerSettingsInput {
  apiBaseUrl: string;
  apiKey: string | null;
}

/** Minimal external-store contract used by React (useSyncExternalStore). */
export interface Store<T> {
  subscribe(listener: () => void): () => void;
  getSnapshot(): T;
}

export interface AppServices {
  readonly library: Library;
  readonly sync: SyncEngine;
  readonly playback: PlaybackController;
  readonly voice: VoiceCommandService;
  /** Change notifications for the UI. The library store's snapshot is its version counter. */
  readonly stores: {
    library: Store<number>;
    playback: Store<PlaybackSnapshot>;
    voice: Store<VoiceSnapshot>;
  };
  /** Loads persisted state, restores the audio session and resumes unfinished books. */
  start(): Promise<void>;
  /** Makes a book active in the player. */
  openBook(bookId: string): Promise<void>;
  /** The access key kept in memory for this session (empty when none is set). */
  getServerKey(): string;
  saveServerSettings(input: ServerSettingsInput): Promise<string>;
  checkServer(input: ServerSettingsInput): Promise<string>;
  setVoiceEnabled(enabled: boolean): Promise<void>;
  /** Restarts unfinished work (called on start, on foreground, and periodically while the app is open). */
  resumeSync(): void;
  dispose(): void;
}

export async function createAppServices(): Promise<AppServices> {
  const library = new Library(createLibraryPersistence());
  const audio = createAudioStore();
  const tokens = createTokenVault();
  const player = new ExpoAudioPlayer();
  const playback = new PlaybackController({ player, library, audio });

  // The server access key is loaded once at start-up and kept in memory for the session.
  let serverKey: string | null = null;

  const sync = new SyncEngine({
    library,
    audio,
    tokens,
    hash: sha256Hex,
    clientFor: (baseUrl) =>
      new ApiClient({
        baseUrl,
        apiKey: serverKey ?? undefined,
        timeoutMs: REQUEST_TIMEOUT_MS,
      }),
    sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  });

  const dispatchVoiceCommand = (command: VoiceCommand): void => {
    switch (command) {
      case 'next':
        void playback.next();
        break;
      case 'repeat':
        void playback.repeat();
        break;
      case 'pause':
        void playback.pause();
        break;
      case 'resume':
        void playback.play();
        break;
    }
  };

  const vosk = loadVoskModule();
  const voice = new VoiceCommandService(vosk ? createVoskRecognizer(vosk) : NO_RECOGNIZER, dispatchVoiceCommand);
  if (!vosk) {
    voice.markUnavailable(VOICE_UNAVAILABLE_MESSAGE);
  }

  let unsubscribeLibrary: (() => void) | null = null;

  return {
    library,
    sync,
    playback,
    voice,
    stores: {
      library: {
        subscribe: (listener) => library.subscribe(listener),
        getSnapshot: () => library.getVersion(),
      },
      playback: {
        subscribe: (listener) => playback.subscribe(listener),
        getSnapshot: () => playback.getSnapshot(),
      },
      voice: {
        subscribe: (listener) => voice.subscribe(listener),
        getSnapshot: () => voice.getSnapshot(),
      },
    },

    async start(): Promise<void> {
      await library.load();
      serverKey = await serverKeyStore.load();
      await configureAudioSession({ recording: false }).catch(() => undefined);
      unsubscribeLibrary = library.subscribe(() => {
        void playback.notifyLibraryChanged();
      });
      sync.resumeAll();
    },

    async openBook(bookId: string): Promise<void> {
      // Re-entering the book that is already active must not stop or rewind playback.
      if (playback.getSnapshot().bookId === bookId) {
        return;
      }
      const book = library.book(bookId);
      player.setTitle(book?.title ?? 'Audiobook');
      await playback.open(bookId);
    },

    getServerKey(): string {
      return serverKey ?? '';
    },

    async saveServerSettings({ apiBaseUrl, apiKey }: ServerSettingsInput): Promise<string> {
      const normalized = normalizeBaseUrl(apiBaseUrl);
      const trimmedKey = apiKey?.trim() ?? '';
      if (trimmedKey) {
        await serverKeyStore.save(trimmedKey);
        serverKey = trimmedKey;
      } else {
        await serverKeyStore.remove();
        serverKey = null;
      }
      library.setApiBaseUrl(normalized);
      await library.flush();
      return normalized;
    },

    async checkServer({ apiBaseUrl, apiKey }: ServerSettingsInput): Promise<string> {
      const client = new ApiClient({
        baseUrl: apiBaseUrl,
        apiKey: apiKey?.trim() || undefined,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      const health = await client.health();
      return health.version;
    },

    async setVoiceEnabled(enabled: boolean): Promise<void> {
      if (enabled) {
        if (voice.getSnapshot().status === 'unavailable') {
          // Do not switch the audio session to recording on builds without the speech module.
          return;
        }
        await configureAudioSession({ recording: true });
        await voice.start();
        return;
      }
      await voice.stop();
      await configureAudioSession({ recording: false }).catch(() => undefined);
    },

    resumeSync(): void {
      sync.resumeAll();
    },

    dispose(): void {
      unsubscribeLibrary?.();
      playback.dispose();
      voice.dispose();
      player.release();
    },
  };
}
