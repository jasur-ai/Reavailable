/**
 * Composition root: wires the pure core to the platform adapters. Nothing outside this file knows
 * which concrete implementation is used.
 */

import { ApiClient, ApiError, NetworkError, normalizeBaseUrl } from '../core/api/client';
import { Library } from '../core/library/library';
import { describeError } from '../core/messages';
import { PlaybackController, type PlaybackSnapshot } from '../core/playback/playbackController';
import { SyncEngine } from '../core/sync/syncEngine';
import type { VoiceCommand } from '../core/voice/commands';
import { VoiceCommandService, type SpeechRecognizerPort, type VoiceSnapshot } from '../core/voice/voiceService';
import { ExpoAudioPlayer, configureAudioSession } from '../platform/audio/expoAudioPlayer';
import { sha256Hex } from '../platform/crypto/sha256';
import { createAudioStore, createLibraryPersistence } from '../platform/storage/fileStores';
import { createTokenVault, serverKeyStore } from '../platform/storage/secureStores';
import { createVoskRecognizer, loadVoskModule } from '../platform/speech/voskRecognizer';
import { createTranslator, type Language, type Translate } from '../i18n';

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

/** Turns a connection failure into wording for the current interface language. */
function translateFailure(error: unknown, t: Translate): Error {
  if (error instanceof NetworkError) {
    return new Error(t(error.timedOut ? 'error.timeout' : 'error.network'));
  }
  if (error instanceof ApiError) {
    return new Error(describeError(error.code, t, error.message));
  }
  return error instanceof Error ? error : new Error(t('error.fallback'));
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
  /** Voice ids the configured server offers, or null when the server cannot be reached or is older. */
  serverVoices(): Promise<string[] | null>;
  /** Saves the address and the key, then answers with a line to show the user. */
  saveServerSettings(input: ServerSettingsInput): Promise<string>;
  /** Contacts the server and answers with a line to show the user. Rejects with translated wording. */
  checkServer(input: ServerSettingsInput): Promise<string>;
  getLanguage(): Language;
  /** Switches the interface language. Notes already stored on a book keep the language they were written in. */
  setLanguage(language: Language): Promise<void>;
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
    // A thunk, so notes written later in a long download follow a language change.
    translate: () => createTranslator(library.settings().language),
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

    async serverVoices(): Promise<string[] | null> {
      const baseUrl = library.settings().apiBaseUrl;
      if (!baseUrl) {
        return null;
      }
      try {
        const client = new ApiClient({ baseUrl, apiKey: serverKey ?? undefined, timeoutMs: REQUEST_TIMEOUT_MS });
        const config = await client.config();
        return config.voices.length > 0 ? config.voices : null;
      } catch {
        return null;
      }
    },

    async saveServerSettings({ apiBaseUrl, apiKey }: ServerSettingsInput): Promise<string> {
      const t = createTranslator(library.settings().language);
      let normalized: string;
      try {
        normalized = normalizeBaseUrl(apiBaseUrl);
      } catch {
        throw new Error(t('settings.invalidUrl'));
      }
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
      return t('settings.saved', { url: normalized });
    },

    async checkServer({ apiBaseUrl, apiKey }: ServerSettingsInput): Promise<string> {
      const t = createTranslator(library.settings().language);
      let client: ApiClient;
      try {
        client = new ApiClient({
          baseUrl: apiBaseUrl,
          apiKey: apiKey?.trim() || undefined,
          timeoutMs: REQUEST_TIMEOUT_MS,
        });
      } catch {
        throw new Error(t('settings.invalidUrl'));
      }

      let config;
      try {
        config = await client.config();
      } catch (error) {
        // The reference Python backend has no /config: fall back to the plain health check.
        if (error instanceof ApiError && error.status === 404) {
          try {
            const health = await client.health();
            return t('settings.connectedOld', { version: health.version || '?' });
          } catch (fallbackError) {
            throw translateFailure(fallbackError, t);
          }
        }
        throw translateFailure(error, t);
      }

      const key = apiKey?.trim() ?? '';
      if (config.requires_api_key && !config.api_key_ok) {
        throw new Error(key ? t('settings.keyRejected') : t('settings.keyMissing'));
      }

      const lines = [
        config.requires_api_key
          ? t('settings.connected', { version: config.version })
          : t('settings.connectedNoKey', { version: config.version }),
      ];
      if (config.provider !== 'azure') {
        lines.push(t('settings.providerWarning', { provider: config.provider }));
      }
      if (config.voices.length > 0) {
        lines.push(t('settings.voicesLine', { count: String(config.voices.length) }));
      }
      return lines.join(' ');
    },

    getLanguage(): Language {
      return library.settings().language;
    },

    async setLanguage(language: Language): Promise<void> {
      library.setLanguage(language);
      await library.flush();
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
