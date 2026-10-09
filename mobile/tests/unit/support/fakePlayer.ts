import type { PlayerPort } from '../../../src/core/playback/playbackController';
import type { BookRecord, ChunkRecord, ChunkState } from '../../../src/core/types';

/** Records every command so tests can assert the exact sequence sent to the audio engine. */
export class FakePlayer implements PlayerPort {
  readonly events: string[] = [];
  playing = false;
  failLoad = false;
  private readonly listeners = new Set<() => void>();

  async load(uri: string, autoplay: boolean): Promise<void> {
    if (this.failLoad) {
      throw new Error('unsupported codec');
    }
    this.events.push(`load ${uri} ${autoplay ? 'play' : 'paused'}`);
    this.playing = autoplay;
  }

  async play(): Promise<void> {
    this.events.push('play');
    this.playing = true;
  }

  async pause(): Promise<void> {
    this.events.push('pause');
    this.playing = false;
  }

  async seekToStart(): Promise<void> {
    this.events.push('seek 0');
  }

  onFinished(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Simulates the audio engine reporting that the current source reached its end. */
  finish(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }

  loadedUris(): string[] {
    return this.events
      .filter((event) => event.startsWith('load '))
      .map((event) => event.split(' ')[1] ?? '');
  }
}

export function makeChunk(bookId: string, index: number, state: ChunkState): ChunkRecord {
  const padded = String(index).padStart(6, '0');
  return {
    index,
    state,
    sha256: 'a'.repeat(64),
    sizeBytes: 10,
    contentType: 'audio/mpeg',
    file: state === 'stored' ? `${bookId}/${padded}.mp3` : undefined,
    acked: false,
    attempts: 0,
  };
}

export function makeBook(id: string, states: ChunkState[], overrides: Partial<BookRecord> = {}): BookRecord {
  const now = '2026-10-09T05:00:00.000Z';
  return {
    id,
    apiBaseUrl: 'https://server.test',
    title: `Book ${id}`,
    voice: 'uz-UZ-MadinaNeural',
    status: states.every((state) => state === 'stored') ? 'ready' : 'downloading',
    warnings: [],
    totalChunks: states.length,
    chunks: states.map((state, index) => makeChunk(id, index, state)),
    position: 0,
    serverReleased: false,
    serverGone: false,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

export const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
