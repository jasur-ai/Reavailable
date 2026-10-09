/**
 * The library: the single source of truth for books and their on-device state.
 *
 * Updates are immutable (each change replaces the affected book), so React can detect them.
 * Writes are persisted in order, and `flush()` resolves once everything so far is on disk.
 */

import type { AppSettings, BookRecord, ChunkRecord, LibraryData } from '../types';
import type { LibraryPersistence } from './ports';

export const EMPTY_LIBRARY: LibraryData = {
  version: 1,
  settings: { apiBaseUrl: null },
  books: [],
};

const CHUNK_STATES = new Set(['pending', 'downloading', 'stored', 'failed']);
const BOOK_STATUSES = new Set(['processing', 'downloading', 'ready', 'failed']);

/** Validates data read from disk. Corrupt entries are dropped rather than crashing the app. */
export function normalizeLibraryData(raw: unknown): LibraryData {
  if (typeof raw !== 'object' || raw === null) {
    return structuredCopy(EMPTY_LIBRARY);
  }
  const candidate = raw as Partial<LibraryData>;
  const settings: AppSettings = {
    apiBaseUrl: typeof candidate.settings?.apiBaseUrl === 'string' ? candidate.settings.apiBaseUrl : null,
  };
  const books = Array.isArray(candidate.books) ? candidate.books.filter(isValidBook) : [];
  return { version: 1, settings, books };
}

function isValidBook(value: unknown): value is BookRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const book = value as Partial<BookRecord>;
  return (
    typeof book.id === 'string' &&
    typeof book.apiBaseUrl === 'string' &&
    typeof book.title === 'string' &&
    typeof book.status === 'string' &&
    BOOK_STATUSES.has(book.status) &&
    Array.isArray(book.chunks) &&
    book.chunks.every(isValidChunk)
  );
}

function isValidChunk(value: unknown): value is ChunkRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const chunk = value as Partial<ChunkRecord>;
  return typeof chunk.index === 'number' && typeof chunk.state === 'string' && CHUNK_STATES.has(chunk.state);
}

export type Listener = () => void;

export class Library {
  private data: LibraryData = structuredCopy(EMPTY_LIBRARY);
  private version = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private writeQueued = false;
  private readonly listeners = new Set<Listener>();

  constructor(
    private readonly persistence: LibraryPersistence,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async load(): Promise<void> {
    this.data = normalizeLibraryData(await this.persistence.read());
    this.emit();
  }

  /** Monotonic counter, used by React's useSyncExternalStore to detect changes. */
  getVersion(): number {
    return this.version;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  books(): readonly BookRecord[] {
    return this.data.books;
  }

  book(id: string): BookRecord | undefined {
    return this.data.books.find((candidate) => candidate.id === id);
  }

  settings(): AppSettings {
    return this.data.settings;
  }

  setApiBaseUrl(url: string | null): void {
    this.data = { ...this.data, settings: { ...this.data.settings, apiBaseUrl: url } };
    this.commit();
  }

  insert(book: BookRecord): void {
    if (this.book(book.id)) {
      throw new Error(`Book ${book.id} already exists`);
    }
    // Store a copy, so later changes to the caller's object cannot leak into the library.
    this.data = { ...this.data, books: [...this.data.books, structuredCopy(book)] };
    this.commit();
  }

  /** Applies a change to a copy of the book, then stores the copy. Returns undefined if the book is gone. */
  update(id: string, change: (draft: BookRecord) => void): BookRecord | undefined {
    const current = this.book(id);
    if (!current) {
      return undefined;
    }
    const draft = structuredCopy(current);
    change(draft);
    draft.updatedAt = this.clock().toISOString();
    this.data = {
      ...this.data,
      books: this.data.books.map((candidate) => (candidate.id === id ? draft : candidate)),
    };
    this.commit();
    return draft;
  }

  remove(id: string): void {
    this.data = { ...this.data, books: this.data.books.filter((candidate) => candidate.id !== id) };
    this.commit();
  }

  /** Resolves once every change made so far has been written. Rejects if a write failed. */
  flush(): Promise<void> {
    return this.writeChain;
  }

  private commit(): void {
    this.version += 1;
    this.schedulePersist();
    this.emit();
  }

  /**
   * Queues one write of the whole library. Changes made while a write is still waiting in the queue
   * are part of that write, because it stores the latest data when it starts. This keeps a long
   * download from writing the whole file once per chunk update.
   */
  private schedulePersist(): void {
    if (this.writeQueued) {
      return;
    }
    this.writeQueued = true;
    const next = this.writeChain.catch(() => undefined).then(() => {
      this.writeQueued = false;
      return this.persistence.write(this.data);
    });
    // Keep a handled branch so a failed write is not reported as an unhandled rejection.
    next.catch(() => undefined);
    this.writeChain = next;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function structuredCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
