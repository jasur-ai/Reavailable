import { createHash } from 'node:crypto';
import type { AudioStore, LibraryPersistence, TokenVault } from '../../../src/core/library/ports';
import type { LibraryData } from '../../../src/core/types';

/** In-memory audio files. `failWrites` simulates a full disk. */
export class MemoryAudioStore implements AudioStore {
  readonly files = new Map<string, Uint8Array>();
  failWrites = false;

  async write(relativePath: string, data: Uint8Array): Promise<void> {
    if (this.failWrites) {
      throw new Error('disk full');
    }
    this.files.set(relativePath, new Uint8Array(data));
  }

  async exists(relativePath: string): Promise<boolean> {
    return this.files.has(relativePath);
  }

  uri(relativePath: string): string {
    return `file:///audio/${relativePath}`;
  }

  async removeBook(bookId: string): Promise<void> {
    for (const key of [...this.files.keys()]) {
      if (key.startsWith(`${bookId}/`)) {
        this.files.delete(key);
      }
    }
  }
}

export class MemoryTokenVault implements TokenVault {
  readonly tokens = new Map<string, string>();

  async save(bookId: string, token: string): Promise<void> {
    this.tokens.set(bookId, token);
  }

  async load(bookId: string): Promise<string | null> {
    return this.tokens.get(bookId) ?? null;
  }

  async remove(bookId: string): Promise<void> {
    this.tokens.delete(bookId);
  }
}

/** Persists the library as JSON text, like the real file store, so tests can inspect the exact bytes. */
export class MemoryPersistence implements LibraryPersistence {
  text: string | null = null;
  writes = 0;
  failNextWrite = false;

  async read(): Promise<unknown> {
    return this.text === null ? null : (JSON.parse(this.text) as unknown);
  }

  async write(data: LibraryData): Promise<void> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('write failed');
    }
    this.text = JSON.stringify(data);
    this.writes += 1;
  }
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Lets pending promise callbacks run; enough for the in-memory adapters. */
export function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Polls until the predicate holds. Fails the test instead of hanging. */
export async function waitUntil(predicate: () => boolean, label: string, maxTurns = 5_000): Promise<void> {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (predicate()) {
      return;
    }
    await flushPromises();
  }
  throw new Error(`Timed out waiting for: ${label}`);
}
