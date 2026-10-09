/**
 * Voice command service: owns the recognizer lifecycle and turns final results into commands.
 *
 * Protections against false triggers:
 * - closed grammar (see commands.ts), single-word results only, [unk] rejected;
 * - minimum confidence when the engine reports one;
 * - cooldown: after a command is accepted, further results are ignored for `cooldownMs`, so one
 *   utterance cannot fire twice and speaker echo has less chance to repeat a command.
 */

import { type VoiceCommand, VOICE_GRAMMAR, parseCommand } from './commands';

export interface SpeechRecognizerPort {
  /** Starts listening with the given grammar. Resolves once listening has started. */
  start(grammar: readonly string[]): Promise<void>;
  stop(): Promise<void>;
  /** Final results only; each call receives the raw result text. */
  onResult(listener: (raw: string) => void): () => void;
  onError(listener: (message: string) => void): () => void;
  /** Fires when the engine stops by itself (for example, a timeout). */
  onStopped(listener: () => void): () => void;
}

export type VoiceStatus = 'off' | 'starting' | 'listening' | 'unavailable' | 'error';

export interface VoiceServiceOptions {
  cooldownMs: number;
  minConfidence: number;
  now: () => number;
}

export interface VoiceSnapshot {
  status: VoiceStatus;
  message: string | null;
  lastCommand: VoiceCommand | null;
}

const DEFAULT_OPTIONS: VoiceServiceOptions = {
  cooldownMs: 1_500,
  minConfidence: 0.5,
  now: () => Date.now(),
};

export class VoiceCommandService {
  private readonly options: VoiceServiceOptions;
  private snapshot: VoiceSnapshot = { status: 'off', message: null, lastCommand: null };
  private wanted = false;
  private lastAcceptedAt = Number.NEGATIVE_INFINITY;
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
      recognizer.onError((message) => {
        this.fail(message);
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

  /** Handles one final recognizer result. Returns the accepted command, or null if it was ignored. */
  handleResult(raw: string): VoiceCommand | null {
    if (this.snapshot.status !== 'listening') {
      return null;
    }
    const command = parseCommand(raw, this.options.minConfidence);
    if (command === null) {
      return null;
    }
    const now = this.options.now();
    if (now - this.lastAcceptedAt < this.options.cooldownMs) {
      return null;
    }
    this.lastAcceptedAt = now;
    this.set({ lastCommand: command });
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
      await this.recognizer.start(VOICE_GRAMMAR);
      this.set({ status: 'listening', message: null });
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'Voice control stopped.');
    }
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
