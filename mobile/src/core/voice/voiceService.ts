/**
 * Voice command service: owns the recognizer lifecycle and turns recognizer results into commands.
 *
 * Protections against false triggers:
 * - closed grammar (see commands.ts), single-word results only, [unk] rejected;
 * - minimum confidence when the engine reports one;
 * - cooldown: after a command is accepted, further results are ignored for `cooldownMs`, so one
 *   utterance cannot fire twice and speaker echo has less chance to repeat a command.
 *
 * Resilience: an engine error or an engine that stops by itself is retried a few times with a short
 * delay. A single hiccup (for example, the microphone being taken for a moment while playback
 * starts) must not silently disable voice control until the user switches it off and on again.
 */

import { type VoiceCommand, VOICE_GRAMMAR, parseCommand } from './commands';

export interface SpeechRecognizerPort {
  /** Starts listening with the given grammar. Resolves once listening has started. */
  start(grammar: readonly string[]): Promise<void>;
  stop(): Promise<void>;
  /** Final results only; each call receives the raw result text. Fires after a pause in speech. */
  onResult(listener: (raw: string) => void): () => void;
  /**
   * Partial results, while the user is still speaking. Optional: a recognizer without it still works,
   * just more slowly, because final results need a pause in speech.
   */
  onPartial?(listener: (raw: string) => void): () => void;
  onError(listener: (message: string) => void): () => void;
  /** Fires when the engine stops by itself (for example, a timeout). */
  onStopped(listener: () => void): () => void;
}

export type VoiceStatus = 'off' | 'starting' | 'listening' | 'unavailable' | 'error';

/** The last command word the recognizer heard, and whether it was carried out. */
export interface LastHeard {
  command: VoiceCommand;
  at: number;
  accepted: boolean;
}

export interface VoiceServiceOptions {
  cooldownMs: number;
  minConfidence: number;
  now: () => number;
  /** How many engine failures in a row are retried before voice control gives up. */
  maxRetries: number;
  /** Delay before a retry; it grows with each failure in a row. */
  retryDelayMs: number;
}

export interface VoiceSnapshot {
  status: VoiceStatus;
  message: string | null;
  lastCommand: VoiceCommand | null;
  /** Epoch milliseconds of the last accepted command, so the UI can flash each one. */
  lastCommandAt: number | null;
  /** Set whenever a command word is heard, accepted or not. Drives the on-screen indicator. */
  lastHeard?: LastHeard | null;
}

const DEFAULT_OPTIONS: VoiceServiceOptions = {
  cooldownMs: 1_500,
  minConfidence: 0.5,
  now: () => Date.now(),
  maxRetries: 3,
  retryDelayMs: 1_000,
};

export class VoiceCommandService {
  private readonly options: VoiceServiceOptions;
  private snapshot: VoiceSnapshot = { status: 'off', message: null, lastCommand: null, lastCommandAt: null, lastHeard: null };
  private wanted = false;
  private lastAcceptedAt = Number.NEGATIVE_INFINITY;
  private failuresInRow = 0;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribes: (() => void)[];

  constructor(
    private readonly recognizer: SpeechRecognizerPort,
    private readonly dispatch: (command: VoiceCommand) => void,
    options: Partial<VoiceServiceOptions> = {},
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.unsubscribes = [
      recognizer.onResult((raw) => {
        this.handleResult(raw);
      }),
      ...(recognizer.onPartial
        ? [
            recognizer.onPartial((raw) => {
              this.handleResult(raw);
            }),
          ]
        : []),
      recognizer.onError((message) => {
        this.recover(message);
      }),
      recognizer.onStopped(() => {
        if (this.wanted) {
          // The engine stopped on its own (for example, a timeout). Keep listening.
          void this.restart();
        }
      }),
    ];
  }

  getSnapshot(): VoiceSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Marks voice control as unavailable on this build (for example, the native module is missing). */
  markUnavailable(message: string): void {
    this.wanted = false;
    this.set({ status: 'unavailable', message });
  }

  async start(): Promise<void> {
    if (this.snapshot.status === 'unavailable') {
      // Nothing to start on this build; the status message already explains why.
      return;
    }
    this.wanted = true;
    this.failuresInRow = 0;
    if (this.snapshot.status === 'listening' || this.snapshot.status === 'starting') {
      return;
    }
    this.set({ status: 'starting', message: null });
    try {
      await this.recognizer.start(VOICE_GRAMMAR);
      if (this.wanted) {
        this.set({ status: 'listening', message: null });
      }
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'Voice control could not start.');
    }
  }

  async stop(): Promise<void> {
    this.wanted = false;
    if (this.snapshot.status === 'off' || this.snapshot.status === 'unavailable') {
      return;
    }
    try {
      await this.recognizer.stop();
    } finally {
      this.set({ status: 'off', message: null });
    }
  }

  /**
   * Handles one recognizer result (partial or final). Returns the accepted command, or null when the
   * result is not a command or was ignored.
   */
  handleResult(raw: string): VoiceCommand | null {
    if (this.snapshot.status !== 'listening') {
      return null;
    }
    // The recognizer is clearly working, so earlier failures no longer count against it.
    this.failuresInRow = 0;
    const command = parseCommand(raw, this.options.minConfidence);
    if (command === null) {
      return null;
    }
    const now = this.options.now();
    if (now - this.lastAcceptedAt < this.options.cooldownMs) {
      // The same utterance seen again (partial, then final). Do not flash it twice.
      if (this.snapshot.lastHeard?.command !== command) {
        this.set({ lastHeard: { command, at: now, accepted: false } });
      }
      return null;
    }
    this.lastAcceptedAt = now;
    this.set({ lastCommand: command, lastCommandAt: now, lastHeard: { command, at: now, accepted: true } });
    this.dispatch(command);
    return command;
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribes) {
      unsubscribe();
    }
    this.listeners.clear();
  }

  private async restart(): Promise<void> {
    if (!this.wanted) {
      return;
    }
    try {
      // Stop first: the engine refuses to start while its previous session is still open.
      await this.recognizer.stop().catch(() => undefined);
      await this.recognizer.start(VOICE_GRAMMAR);
      if (this.wanted) {
        this.set({ status: 'listening', message: null });
      }
    } catch (error) {
      this.recover(error instanceof Error ? error.message : 'Voice control stopped.');
    }
  }

  /** An engine error: retry a few times with a growing delay, then report it. */
  private recover(message: string): void {
    if (!this.wanted) {
      return;
    }
    this.failuresInRow += 1;
    if (this.failuresInRow > this.options.maxRetries) {
      this.fail(message);
      return;
    }
    this.set({ status: 'starting', message: null });
    const delay = this.options.retryDelayMs * this.failuresInRow;
    setTimeout(() => {
      void this.restart();
    }, delay);
  }

  private fail(message: string): void {
    this.wanted = false;
    this.set({ status: 'error', message });
  }

  private set(change: Partial<VoiceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) {
      listener();
    }
  }
}
