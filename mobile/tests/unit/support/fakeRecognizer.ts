import type { SpeechRecognizerPort } from '../../../src/core/voice/voiceService';

/** Stands in for the native recognizer. Tests push results, errors and stop events by hand. */
export class FakeRecognizer implements SpeechRecognizerPort {
  readonly starts: string[][] = [];
  stops = 0;
  /** When set, the next start() rejects with this message (and the flag is cleared). */
  failNextStart: string | null = null;
  /** When set, start() waits for this promise before it resolves. */
  gate: Promise<void> | null = null;
  private readonly resultListeners = new Set<(raw: string) => void>();
  private readonly errorListeners = new Set<(message: string) => void>();
  private readonly stoppedListeners = new Set<() => void>();

  async start(grammar: readonly string[]): Promise<void> {
    this.starts.push([...grammar]);
    if (this.gate) {
      await this.gate;
    }
    if (this.failNextStart) {
      const message = this.failNextStart;
      this.failNextStart = null;
      throw new Error(message);
    }
  }

  async stop(): Promise<void> {
    this.stops += 1;
  }

  onResult(listener: (raw: string) => void): () => void {
    return subscribe(this.resultListeners, listener);
  }

  onError(listener: (message: string) => void): () => void {
    return subscribe(this.errorListeners, listener);
  }

  onStopped(listener: () => void): () => void {
    return subscribe(this.stoppedListeners, listener);
  }

  emitResult(raw: string): void {
    for (const listener of [...this.resultListeners]) {
      listener(raw);
    }
  }

  emitError(message: string): void {
    for (const listener of [...this.errorListeners]) {
      listener(message);
    }
  }

  emitStopped(): void {
    for (const listener of [...this.stoppedListeners]) {
      listener();
    }
  }

  listenerCount(): number {
    return this.resultListeners.size + this.errorListeners.size + this.stoppedListeners.size;
  }
}

function subscribe<T>(set: Set<T>, listener: T): () => void {
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}
