/**
 * Offline English keyword recognition with react-native-vosk.
 *
 * The native module is loaded lazily. In builds without the native code (for example Expo Go) the
 * import throws, and voice control reports itself as unavailable instead of crashing the app.
 *
 * NOTE: recognition quality, background-noise behaviour and the model bundle are not verified on a
 * device in this repository. See docs/TESTING.md.
 */

import { requestRecordingPermissionsAsync } from 'expo-audio';
import type { SpeechRecognizerPort } from '../../core/voice/voiceService';

export type VoskModule = typeof import('react-native-vosk');

/** Folder name of the model inside mobile/assets. The library requires the "model-" prefix. */
export const VOSK_MODEL_PATH = 'model-en-us';

export function loadVoskModule(): VoskModule | null {
  try {
    // Lazy require on purpose: the import throws when the native module is not in the build.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('react-native-vosk') as VoskModule;
  } catch {
    return null;
  }
}

function describe(error: unknown): string {
  if (typeof error === 'string') {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'Voice recognition failed.';
}

export function createVoskRecognizer(vosk: VoskModule): SpeechRecognizerPort {
  let modelLoading: Promise<void> | null = null;

  const ensureModel = (): Promise<void> => {
    if (!modelLoading) {
      modelLoading = vosk.loadModel(VOSK_MODEL_PATH).then(
        () => undefined,
        (error: unknown) => {
          modelLoading = null;
          throw new Error(`The offline English model could not be loaded: ${describe(error)}`);
        },
      );
    }
    return modelLoading;
  };

  return {
    async start(grammar: readonly string[]): Promise<void> {
      // On iOS react-native-vosk does not request the microphone itself, so request it here on both platforms.
      const permission = await requestRecordingPermissionsAsync();
      if (!permission.granted) {
        throw new Error('Microphone access is needed for voice commands. Allow it in the system settings.');
      }
      await ensureModel();
      await vosk.start({ grammar: [...grammar] });
    },

    async stop(): Promise<void> {
      vosk.stop();
    },

    onResult(listener: (raw: string) => void): () => void {
      const subscription = vosk.onResult((text: string) => {
        listener(text);
      });
      return () => {
        subscription.remove();
      };
    },

    onError(listener: (message: string) => void): () => void {
      const subscription = vosk.onError((error: unknown) => {
        listener(describe(error));
      });
      return () => {
        subscription.remove();
      };
    },

    onStopped(listener: () => void): () => void {
      const subscription = vosk.onTimeout(() => {
        listener();
      });
      return () => {
        subscription.remove();
      };
    },
  };
}
