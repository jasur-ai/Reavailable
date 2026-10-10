import { EMPTY_LIBRARY, Library, normalizeLibraryData } from '../../src/core/library/library';
import type { LibraryPersistence } from '../../src/core/library/ports';
import type { LibraryData } from '../../src/core/types';
import { makeBook } from './support/fakePlayer';
import { flushPromises, MemoryPersistence } from './support/memory';

const FIXED = new Date('2026-10-09T06:30:00.000Z');

function parsedLast(persistence: MemoryPersistence): LibraryData {
  if (persistence.text === null) {
    throw new Error('nothing was written');
  }
  return JSON.parse(persistence.text) as LibraryData;
}

describe('build-time server address', () => {
  const original = process.env.EXPO_PUBLIC_DEFAULT_SERVER_URL;

  const loadConfig = async () => {
    jest.resetModules();
    return import('../../src/core/config');
  };

  afterEach(() => {
    if (original === undefined) {
      delete process.env.EXPO_PUBLIC_DEFAULT_SERVER_URL;
    } else {
      process.env.EXPO_PUBLIC_DEFAULT_SERVER_URL = original;
    }
    jest.resetModules();
  });

  it('uses the build variable, trimmed, when one is set', async () => {
    process.env.EXPO_PUBLIC_DEFAULT_SERVER_URL = '  https://from-build.workers.dev  ';
    expect((await loadConfig()).DEFAULT_SERVER_URL).toBe('https://from-build.workers.dev');
  });

  it('falls back to the address committed by the deploy workflow', async () => {
    delete process.env.EXPO_PUBLIC_DEFAULT_SERVER_URL;
    // Empty until a server has been deployed; then the deploy workflow commits the address here.
    expect((await loadConfig()).DEFAULT_SERVER_URL).toBe('');
  });

  it('never lets an empty build variable override the committed address', async () => {
    process.env.EXPO_PUBLIC_DEFAULT_SERVER_URL = '   ';
    expect((await loadConfig()).DEFAULT_SERVER_URL).toBe('');
  });
});

describe('Library: loading', () => {
  it('starts empty when nothing was stored yet', async () => {
    const library = new Library(new MemoryPersistence(), () => FIXED);
    await library.load();
    expect(library.books()).toEqual([]);
    expect(library.settings()).toEqual({ apiBaseUrl: null, language: 'uz' });
  });

  it('restores books and settings from storage', async () => {
    const persistence = new MemoryPersistence();
    persistence.text = JSON.stringify({
      version: 1,
      settings: { apiBaseUrl: 'http://server.test:8000', language: 'en' },
      books: [makeBook('b1', ['stored'])],
    });
    const library = new Library(persistence);
    await library.load();
    expect(library.book('b1')?.title).toBe('Book b1');
    expect(library.settings().apiBaseUrl).toBe('http://server.test:8000');
    expect(library.settings().language).toBe('en');
  });

  it('falls back to Uzbek for a language it does not know', () => {
    expect(normalizeLibraryData({ settings: { language: 'klingon' } }).settings.language).toBe('uz');
    expect(normalizeLibraryData({ settings: {} }).settings.language).toBe('uz');
  });

  it('drops corrupt entries instead of failing', () => {
    const valid = makeBook('ok', ['stored']);
    const normalized = normalizeLibraryData({
      settings: { apiBaseUrl: 42 },
      books: [
        valid,
        null,
        'text',
        { id: 'no-chunks', apiBaseUrl: 'x', title: 'x', status: 'ready', chunks: 'nope' },
        { ...valid, id: 'bad-status', status: 'exploded' },
        { ...valid, id: 'bad-chunk', chunks: [{ index: 0, state: 'mystery' }] },
      ],
    });
    expect(normalized.books.map((book) => book.id)).toEqual(['ok']);
    expect(normalized.settings.apiBaseUrl).toBeNull();
    expect(normalized.settings.language).toBe('uz');
  });

  it('treats a non-object document as an empty library', () => {
    expect(normalizeLibraryData(null)).toEqual(EMPTY_LIBRARY);
    expect(normalizeLibraryData('garbage')).toEqual(EMPTY_LIBRARY);
    expect(normalizeLibraryData(12)).toEqual(EMPTY_LIBRARY);
  });

  it('returns a fresh copy of the empty library each time', () => {
    const first = normalizeLibraryData(null);
    first.books.push(makeBook('x', []));
    expect(normalizeLibraryData(null).books).toEqual([]);
    expect(EMPTY_LIBRARY.books).toEqual([]);
  });
});

describe('Library: changes', () => {
  it('stores inserted books and persists them', async () => {
    const persistence = new MemoryPersistence();
    const library = new Library(persistence, () => FIXED);
    library.insert(makeBook('b1', ['pending']));
    await library.flush();
    expect(parsedLast(persistence).books.map((book) => book.id)).toEqual(['b1']);
  });

  it('keeps a private copy of an inserted book', () => {
    const library = new Library(new MemoryPersistence(), () => FIXED);
    const book = makeBook('b1', ['pending']);
    library.insert(book);
    book.title = 'changed outside the library';
    expect(library.book('b1')?.title).toBe('Book b1');
  });

  it('refuses to insert a book twice', () => {
    const library = new Library(new MemoryPersistence(), () => FIXED);
    library.insert(makeBook('b1', []));
    expect(() => library.insert(makeBook('b1', []))).toThrow('already exists');
  });

  it('updates a book immutably and stamps the update time', () => {
    const library = new Library(new MemoryPersistence(), () => FIXED);
    library.insert(makeBook('b1', ['pending']));
    const before = library.book('b1');

    const updated = library.update('b1', (draft) => {
      draft.title = 'Renamed';
      draft.position = 2;
    });

    expect(updated).toMatchObject({ title: 'Renamed', position: 2, updatedAt: FIXED.toISOString() });
    expect(before?.title).toBe('Book b1');
    expect(library.book('b1')).toBe(updated);
  });

  it('returns undefined and changes nothing when updating an unknown book', () => {
    const library = new Library(new MemoryPersistence(), () => FIXED);
    const version = library.getVersion();
    expect(library.update('missing', () => undefined)).toBeUndefined();
    expect(library.getVersion()).toBe(version);
  });

  it('keeps the other books unchanged when one is updated', () => {
    const library = new Library(new MemoryPersistence(), () => FIXED);
    library.insert(makeBook('a', []));
    library.insert(makeBook('b', []));
    const other = library.book('a');
    library.update('b', (draft) => {
      draft.title = 'B2';
    });
    expect(library.book('a')).toBe(other);
  });

  it('removes a book', async () => {
    const persistence = new MemoryPersistence();
    const library = new Library(persistence, () => FIXED);
    library.insert(makeBook('b1', []));
    library.insert(makeBook('b2', []));
    library.remove('b1');
    await library.flush();
    expect(library.books().map((book) => book.id)).toEqual(['b2']);
    expect(parsedLast(persistence).books.map((book) => book.id)).toEqual(['b2']);
  });

  it('stores the server address in the settings', async () => {
    const persistence = new MemoryPersistence();
    const library = new Library(persistence, () => FIXED);
    library.setApiBaseUrl('https://books.example.org');
    await library.flush();
    expect(library.settings().apiBaseUrl).toBe('https://books.example.org');
    expect(parsedLast(persistence).settings.apiBaseUrl).toBe('https://books.example.org');
  });

  it('stores the interface language in the settings', async () => {
    const persistence = new MemoryPersistence();
    const library = new Library(persistence, () => FIXED);
    library.setLanguage('en');
    await library.flush();
    expect(library.settings().language).toBe('en');
    expect(parsedLast(persistence).settings.language).toBe('en');

    // Choosing the language again writes nothing, so the store stays quiet.
    const version = library.getVersion();
    library.setLanguage('en');
    expect(library.getVersion()).toBe(version);
  });

  it('bumps the version and notifies subscribers on every change', () => {
    const library = new Library(new MemoryPersistence(), () => FIXED);
    let notified = 0;
    const unsubscribe = library.subscribe(() => {
      notified += 1;
    });
    const start = library.getVersion();
    library.insert(makeBook('b1', []));
    library.update('b1', (draft) => {
      draft.title = 'x';
    });
    expect(library.getVersion()).toBe(start + 2);
    expect(notified).toBe(2);

    unsubscribe();
    library.remove('b1');
    expect(notified).toBe(2);
  });
});

describe('Library: persistence order and failures', () => {
  it('writes changes in order, so the last change is the one on disk', async () => {
    class SlowFirstWrite implements LibraryPersistence {
      text: string | null = null;
      private writes = 0;
      async read(): Promise<unknown> {
        return null;
      }
      async write(data: LibraryData): Promise<void> {
        this.writes += 1;
        // The first write is the slowest. Out-of-order writes would leave stale data on disk.
        await new Promise((resolve) => setTimeout(resolve, this.writes === 1 ? 25 : 0));
        this.text = JSON.stringify(data);
      }
    }
    const persistence = new SlowFirstWrite();
    const library = new Library(persistence, () => FIXED);
    library.insert(makeBook('a', []));
    library.insert(makeBook('b', []));
    await library.flush();
    expect((JSON.parse(persistence.text ?? '{}') as LibraryData).books.map((book) => book.id)).toEqual(['a', 'b']);
  });

  it('reports a failed write through flush and recovers on the next change', async () => {
    const persistence = new MemoryPersistence();
    const library = new Library(persistence, () => FIXED);
    persistence.failNextWrite = true;
    library.insert(makeBook('b1', []));

    await expect(library.flush()).rejects.toThrow('write failed');

    library.insert(makeBook('b2', []));
    await expect(library.flush()).resolves.toBeUndefined();
    expect(parsedLast(persistence).books.map((book) => book.id)).toEqual(['b1', 'b2']);
  });

  it('never leaves an unhandled rejection when a write fails', async () => {
    const persistence = new MemoryPersistence();
    persistence.failNextWrite = true;
    const library = new Library(persistence, () => FIXED);
    library.insert(makeBook('b1', []));
    // Give the runtime a chance to report an unhandled rejection before the test ends.
    await new Promise((resolve) => setImmediate(resolve));
    await expect(library.flush()).rejects.toThrow();
  });

  it('resolves flush immediately when nothing is pending', async () => {
    const library = new Library(new MemoryPersistence(), () => FIXED);
    await expect(library.flush()).resolves.toBeUndefined();
  });
});

describe('Library: write batching', () => {
  /** Records the book ids of every write, and holds each write until the test releases it. */
  class GatedPersistence implements LibraryPersistence {
    readonly snapshots: string[][] = [];
    private readonly releases: (() => void)[] = [];
    private holding = true;

    async read(): Promise<unknown> {
      return null;
    }

    async write(data: LibraryData): Promise<void> {
      this.snapshots.push(data.books.map((book) => book.id));
      if (this.holding) {
        await new Promise<void>((resolve) => this.releases.push(resolve));
      }
    }

    releaseAll(): void {
      this.holding = false;
      for (const release of this.releases.splice(0)) {
        release();
      }
    }
  }

  it('writes once for a burst of changes, and that write contains the last change', async () => {
    const persistence = new MemoryPersistence();
    const library = new Library(persistence, () => FIXED);
    library.insert(makeBook('a', []));
    library.insert(makeBook('b', []));
    library.update('a', (draft) => {
      draft.position = 2;
    });
    await library.flush();

    expect(persistence.writes).toBe(1);
    const stored = parsedLast(persistence);
    expect(stored.books.map((book) => book.id)).toEqual(['a', 'b']);
    expect(stored.books[0]?.position).toBe(2);
  });

  it('writes a change again when it was made after the previous write had started', async () => {
    const persistence = new GatedPersistence();
    const library = new Library(persistence, () => FIXED);
    library.insert(makeBook('a', []));
    await flushPromises();
    library.insert(makeBook('b', []));
    persistence.releaseAll();
    await library.flush();

    expect(persistence.snapshots).toEqual([['a'], ['a', 'b']]);
  });

  it('keeps flush pending until a change made while a write is queued is on disk', async () => {
    const persistence = new GatedPersistence();
    const library = new Library(persistence, () => FIXED);
    library.insert(makeBook('a', []));
    library.insert(makeBook('b', []));
    const done = jest.fn();
    const pending = library.flush().then(done);
    await flushPromises();
    expect(done).not.toHaveBeenCalled();

    persistence.releaseAll();
    await pending;
    expect(persistence.snapshots).toEqual([['a', 'b']]);
  });
});
