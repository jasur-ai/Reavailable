/**
 * Playback controller for the active book.
 *
 * - Every command runs on one serial queue, so a voice command, a button press and the automatic
 *   advance at the end of a part can never interleave on the player.
 * - A part that is not on the device yet puts the controller in "waiting"; it starts as soon as the
 *   library reports the part as stored.
 * - The current part index is saved with the book, so the listener resumes where they stopped.
 *   Resuming starts from the beginning of the saved part (parts are short, a few seconds to a minute).
 */

import type { Library } from '../library/library';
import type { AudioStore } from '../library/ports';
import type { BookRecord, ChunkRecord } from '../types';

export interface PlayerPort {
  /** Replaces the current source. Starts from the beginning when `autoplay` is true. */
  load(uri: string, autoplay: boolean): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  /** Moves the current source back to its start without changing whether it plays. */
  seekToStart(): Promise<void>;
  /** Fires when the current source reaches its end. Returns an unsubscribe function. */
  onFinished(listener: () => void): () => void;
}

export type WaitingReason = 'processing' | 'downloading' | 'missing';

export type PlaybackStatus = 'idle' | 'paused' | 'playing' | 'waiting' | 'finished' | 'error';

export interface PlaybackSnapshot {
  bookId: string | null;
  index: number;
  totalChunks: number;
  status: PlaybackStatus;
  waitingReason: WaitingReason | null;
  error: string | null;
}

export type PlaybackLibrary = Pick<Library, 'book' | 'update'>;

export interface PlaybackDeps {
  player: PlayerPort;
  library: PlaybackLibrary;
  audio: Pick<AudioStore, 'uri'>;
  /** A "finished" event that arrives this soon after a load belongs to the previous source and is ignored. */
  finishedGuardMs?: number;
  now?: () => number;
}

const IDLE: PlaybackSnapshot = {
  bookId: null,
  index: 0,
  totalChunks: 0,
  status: 'idle',
  waitingReason: null,
  error: null,
};

const PLAYBACK_ERROR = 'This part could not be played. Try again, or skip to the next part.';

function waitingReasonFor(book: BookRecord, part: ChunkRecord | undefined): WaitingReason {
  if (book.status === 'failed' || part?.state === 'failed') {
    return 'missing';
  }
  if (!part) {
    return book.status === 'processing' ? 'processing' : 'downloading';
  }
  return 'downloading';
}

export class PlaybackController {
  private snapshot: PlaybackSnapshot = IDLE;
  /** What the listener wants: keep playing through parts, or stay paused. */
  private intent: 'play' | 'pause' = 'pause';
  private queue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private loadedIndex: number | null = null;
  private loadedAt = 0;
  private readonly finishedGuardMs: number;
  private readonly now: () => number;
  private readonly unsubscribeFinished: () => void;

  constructor(private readonly deps: PlaybackDeps) {
    this.finishedGuardMs = deps.finishedGuardMs ?? 400;
    this.now = deps.now ?? Date.now;
    this.unsubscribeFinished = deps.player.onFinished(() => {
      const arrivedAt = this.now();
      void this.enqueue(() => this.handleFinished(arrivedAt));
    });
  }

  getSnapshot(): PlaybackSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Makes a book the active one and loads its saved part (paused). */
  open(bookId: string): Promise<void> {
    return this.enqueue(async () => {
      const book = this.deps.library.book(bookId);
      await this.stopPlayer();
      if (!book) {
        this.set(IDLE);
        return;
      }
      this.intent = 'pause';
      const last = Math.max(0, book.totalChunks - 1);
      this.set({
        bookId,
        index: Math.min(Math.max(book.position, 0), last),
        totalChunks: book.totalChunks,
        status: 'paused',
        waitingReason: null,
        error: null,
      });
      await this.loadCurrent();
    });
  }

  /** Starts or resumes playback. From a finished book it starts again from the first part. */
  play(): Promise<void> {
    return this.enqueue(async () => {
      const current = this.snapshot;
      if (current.bookId === null) {
        return;
      }
      this.intent = 'play';
      switch (current.status) {
        case 'playing':
          return;
        case 'finished':
          await this.jumpTo(0);
          return;
        case 'paused':
        case 'error':
          if (this.loadedIndex === current.index) {
            await this.deps.player.play();
            this.set({ status: 'playing', error: null });
          } else {
            await this.loadCurrent();
          }
          return;
        case 'waiting':
          await this.loadCurrent();
          return;
        case 'idle':
          return;
      }
    });
  }

  pause(): Promise<void> {
    return this.enqueue(async () => {
      this.intent = 'pause';
      if (this.snapshot.status === 'playing') {
        await this.deps.player.pause();
        this.set({ status: 'paused' });
      }
    });
  }

  /** Moves to the next part. On the last part, playback ends. */
  next(): Promise<void> {
    return this.enqueue(() => this.moveTo(this.snapshot.index + 1));
  }

  /** Jumps to a part (for example, one tapped in the part list). Out-of-range indexes are ignored. */
  goTo(index: number): Promise<void> {
    return this.enqueue(async () => {
      const current = this.snapshot;
      if (current.bookId === null || index < 0 || index >= current.totalChunks || index === current.index) {
        return;
      }
      await this.jumpTo(index);
    });
  }

  /** Plays the current part again from its beginning. */
  repeat(): Promise<void> {
    return this.enqueue(async () => {
      const current = this.snapshot;
      if (current.bookId === null) {
        return;
      }
      this.intent = 'play';
      if (this.loadedIndex !== current.index) {
        await this.loadCurrent();
        return;
      }
      await this.deps.player.seekToStart();
      await this.deps.player.play();
      this.set({ status: 'playing', error: null });
    });
  }

  /** Called after every library change. Starts a waiting part as soon as it is stored. */
  notifyLibraryChanged(): Promise<void> {
    return this.enqueue(async () => {
      const current = this.snapshot;
      if (current.bookId === null) {
        return;
      }
      const book = this.deps.library.book(current.bookId);
      if (!book) {
        await this.stopPlayer();
        this.set(IDLE);
        return;
      }
      if (current.totalChunks !== book.totalChunks) {
        this.set({ totalChunks: book.totalChunks });
      }
      if (current.status !== 'waiting') {
        return;
      }
      const part = book.chunks.find((chunk) => chunk.index === current.index);
      if (part?.state === 'stored' && part.file) {
        await this.loadCurrent();
        return;
      }
      const reason = waitingReasonFor(book, part);
      if (reason !== current.waitingReason) {
        this.set({ waitingReason: reason });
      }
    });
  }

  /** Stops playback and forgets the active book (for example, when it was deleted). */
  close(): Promise<void> {
    return this.enqueue(async () => {
      this.intent = 'pause';
      await this.stopPlayer();
      this.set(IDLE);
    });
  }

  dispose(): void {
    this.unsubscribeFinished();
    this.listeners.clear();
  }

  // ------------------------------------------------------------------ internals

  private async handleFinished(arrivedAt: number): Promise<void> {
    const current = this.snapshot;
    if (current.status !== 'playing' || current.bookId === null) {
      return;
    }
    if (arrivedAt - this.loadedAt < this.finishedGuardMs) {
      return;
    }
    await this.moveTo(current.index + 1);
  }

  private async moveTo(target: number): Promise<void> {
    const current = this.snapshot;
    if (current.bookId === null || current.totalChunks === 0) {
      return;
    }
    if (target >= current.totalChunks) {
      await this.finish();
      return;
    }
    await this.jumpTo(Math.max(0, target));
  }

  private async jumpTo(index: number): Promise<void> {
    const bookId = this.snapshot.bookId;
    if (bookId === null) {
      return;
    }
    this.set({ index });
    this.savePosition(bookId, index);
    await this.loadCurrent();
  }

  private async finish(): Promise<void> {
    const current = this.snapshot;
    if (current.bookId === null) {
      return;
    }
    this.intent = 'pause';
    const last = Math.max(0, current.totalChunks - 1);
    await this.deps.player.pause();
    this.set({ index: last, status: 'finished', waitingReason: null, error: null });
    this.savePosition(current.bookId, last);
  }

  /** Loads the current part, or waits if it is not on the device yet. */
  private async loadCurrent(): Promise<void> {
    const current = this.snapshot;
    if (current.bookId === null) {
      return;
    }
    const book = this.deps.library.book(current.bookId);
    if (!book) {
      await this.stopPlayer();
      this.set(IDLE);
      return;
    }
    const part = book.chunks.find((chunk) => chunk.index === current.index);
    if (!part || part.state !== 'stored' || !part.file) {
      await this.stopPlayer();
      this.set({
        status: 'waiting',
        waitingReason: waitingReasonFor(book, part),
        totalChunks: book.totalChunks,
        error: null,
      });
      return;
    }
    const autoplay = this.intent === 'play';
    try {
      await this.deps.player.load(this.deps.audio.uri(part.file), autoplay);
    } catch {
      this.loadedIndex = null;
      this.set({ status: 'error', error: PLAYBACK_ERROR, totalChunks: book.totalChunks });
      return;
    }
    this.loadedIndex = current.index;
    this.loadedAt = this.now();
    this.savePosition(current.bookId, current.index);
    this.set({
      status: autoplay ? 'playing' : 'paused',
      waitingReason: null,
      error: null,
      totalChunks: book.totalChunks,
    });
  }

  private async stopPlayer(): Promise<void> {
    this.loadedIndex = null;
    await this.deps.player.pause();
  }

  private savePosition(bookId: string, index: number): void {
    if (this.deps.library.book(bookId)?.position === index) {
      return;
    }
    this.deps.library.update(bookId, (draft) => {
      draft.position = index;
    });
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.queue.then(task).catch(() => {
      this.set({ status: 'error', error: PLAYBACK_ERROR });
    });
    this.queue = next;
    return next;
  }

  private set(change: Partial<PlaybackSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) {
      listener();
    }
  }
}
