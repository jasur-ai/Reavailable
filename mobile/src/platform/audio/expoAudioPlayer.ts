/**
 * PlayerPort implementation on top of expo-audio.
 *
 * Background playback: the audio mode keeps playback alive when the app is in the background
 * (iOS needs the audio background mode, added by the expo-audio config plugin). On Android the
 * lock-screen media session is activated so playback is not stopped after a few minutes.
 *
 * NOTE: background playback and lock-screen controls are not verified on a device in this repository.
 */

import {
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
  type AudioStatus,
} from 'expo-audio';
import type { PlayerPort } from '../../core/playback/playbackController';

export interface AudioSessionOptions {
  /** Microphone input is needed for voice commands. Requires the iOS play-and-record category. */
  recording: boolean;
}

/** Applies the app-wide audio session. Called at start-up and whenever voice control changes. */
export async function configureAudioSession(options: AudioSessionOptions): Promise<void> {
  await setAudioModeAsync({
    playsInSilentMode: true,
    // Required by the lock-screen controls. Other apps pause while a book plays.
    interruptionMode: 'doNotMix',
    allowsRecording: options.recording,
    shouldPlayInBackground: true,
    shouldRouteThroughEarpiece: false,
  });
}

export class ExpoAudioPlayer implements PlayerPort {
  private readonly player: AudioPlayer;
  private readonly finishedListeners = new Set<() => void>();
  private readonly subscription: { remove(): void };
  private title = 'Audiobook';

  constructor() {
    this.player = createAudioPlayer(null);
    this.subscription = this.player.addListener('playbackStatusUpdate', (status: AudioStatus) => {
      if (status.didJustFinish) {
        for (const listener of this.finishedListeners) {
          listener();
        }
      }
    });
  }

  /** Title shown on the lock screen and in media notifications. */
  setTitle(title: string): void {
    this.title = title;
  }

  async load(uri: string, autoplay: boolean): Promise<void> {
    this.player.replace({ uri });
    this.player.setActiveForLockScreen(true, { title: this.title, artist: 'Reavailable' });
    if (autoplay) {
      this.player.play();
    } else {
      this.player.pause();
    }
  }

  async play(): Promise<void> {
    this.player.play();
  }

  async pause(): Promise<void> {
    this.player.pause();
  }

  async seekToStart(): Promise<void> {
    await this.player.seekTo(0);
  }

  onFinished(listener: () => void): () => void {
    this.finishedListeners.add(listener);
    return () => {
      this.finishedListeners.delete(listener);
    };
  }

  release(): void {
    this.subscription.remove();
    this.finishedListeners.clear();
    this.player.setActiveForLockScreen(false);
    this.player.remove();
  }
}
