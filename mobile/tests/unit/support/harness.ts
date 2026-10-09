import { Library } from '../../../src/core/library/library';
import { SyncEngine, type SyncOptions } from '../../../src/core/sync/syncEngine';
import { FakeServer } from './fakeServer';
import { MemoryAudioStore, MemoryPersistence, MemoryTokenVault, sha256 } from './memory';

export const SAMPLE_TRANSCRIPT = ['Birinchi jumla.', 'Ikkinchi jumla.', 'Uchinchi jumla.'].join('\n');

/**
 * Sleeps for one macrotask. Background loops must yield to the event loop, otherwise the test's own
 * waits (which are macrotasks) would never run.
 */
export function yieldSleep(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

const activeEngines: SyncEngine[] = [];

/** Stops background polling of every engine created by these harnesses. Call after each test. */
export function disposeAllEngines(): void {
  for (const engine of activeEngines.splice(0)) {
    engine.dispose();
  }
}

export function createSyncHarness(options: Partial<SyncOptions> = {}) {
  const server = new FakeServer();
  const persistence = new MemoryPersistence();
  const library = new Library(persistence, () => new Date('2026-10-09T05:00:00.000Z'));
  const audio = new MemoryAudioStore();
  const tokens = new MemoryTokenVault();
  const sleeps: number[] = [];
  const sync = new SyncEngine({
    library,
    audio,
    tokens,
    hash: sha256,
    clientFor: () => server,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      if (sleeps.length > 5_000) {
        throw new Error('too many sleeps: the engine is looping');
      }
      await yieldSleep();
    },
    now: () => Date.parse('2026-10-09T05:00:00.000Z'),
    options: { retryBaseDelayMs: 1, pollIntervalMs: 1, pollTimeoutMs: 60_000, ...options },
  });
  activeEngines.push(sync);
  return { server, persistence, library, audio, tokens, sync, sleeps };
}

export type SyncHarness = ReturnType<typeof createSyncHarness>;

export function submitSample(harness: SyncHarness, transcript = SAMPLE_TRANSCRIPT) {
  return harness.sync.submit({
    apiBaseUrl: harness.server.baseUrl,
    title: 'Test book',
    transcript,
    sentencesPerChunk: 1,
  });
}

/** The audio file name the engine uses for a part of a book. */
export function partPath(bookId: string, index: number): string {
  return `${bookId}/${String(index).padStart(6, '0')}.mp3`;
}
