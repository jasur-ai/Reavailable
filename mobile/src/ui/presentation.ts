/**
 * Pure presentation logic: turns core state into user-facing text and tones.
 * Kept free of React Native imports so it can be unit-tested under Node.
 */

import type { PlaybackSnapshot } from '../core/playback/playbackController';
import type { BookRecord, ChunkRecord } from '../core/types';
import type { VoiceSnapshot } from '../core/voice/voiceService';

export type Tone = 'neutral' | 'info' | 'warning' | 'danger' | 'success';

export const MAX_TRANSCRIPT_CHARS = 200_000;
export const MAX_TITLE_CHARS = 120;

export function storedCount(book: BookRecord): number {
  return book.chunks.filter((chunk) => chunk.state === 'stored').length;
}

export function totalParts(book: BookRecord): number {
  return Math.max(book.totalChunks, book.chunks.length);
}

export interface BookStatusView {
  label: string;
  tone: Tone;
  detail: string;
  progress: { value: number; total: number } | null;
  canOpen: boolean;
  canRetry: boolean;
}

export function bookStatusView(book: BookRecord): BookStatusView {
  const stored = storedCount(book);
  const total = totalParts(book);
  const partsLine = total > 0 ? `${stored} of ${total} parts on this phone.` : '';

  switch (book.status) {
    case 'processing':
      return {
        label: 'Preparing on server',
        tone: 'info',
        detail: 'The server is generating the audio. It will download here when it is ready.',
        progress: null,
        canOpen: false,
        canRetry: false,
      };
    case 'downloading':
      return {
        label: 'Downloading',
        tone: 'info',
        detail: [partsLine, book.syncNote].filter(Boolean).join(' '),
        progress: { value: stored, total },
        canOpen: stored > 0,
        canRetry: false,
      };
    case 'ready': {
      const allAcknowledged = book.chunks.every((chunk) => chunk.acked);
      if (allAcknowledged || book.serverReleased) {
        return {
          label: 'Ready offline',
          tone: 'success',
          detail: book.serverGone
            ? `All ${total} parts are on this phone. The server copy had already expired.`
            : `All ${total} parts are on this phone and do not need a connection.`,
          progress: { value: stored, total },
          canOpen: true,
          canRetry: false,
        };
      }
      return {
        label: 'Ready, finishing sync',
        tone: 'info',
        detail: book.syncNote ?? 'Finishing the sync with the server. Audio plays normally meanwhile.',
        progress: { value: stored, total },
        canOpen: true,
        canRetry: false,
      };
    }
    case 'failed':
      return {
        label: 'Failed',
        tone: 'danger',
        detail: book.errorMessage ?? 'Something went wrong. Try again.',
        progress: total > 0 ? { value: stored, total } : null,
        canOpen: stored > 0,
        canRetry: !book.serverGone && book.errorCode !== 'file_missing',
      };
  }
}

export function partStatus(chunk: ChunkRecord | undefined): { label: string; tone: Tone } {
  if (!chunk) {
    return { label: 'Waiting', tone: 'neutral' };
  }
  switch (chunk.state) {
    case 'stored':
      return chunk.acked ? { label: 'On phone', tone: 'success' } : { label: 'On phone, syncing', tone: 'info' };
    case 'downloading':
      return { label: 'Downloading', tone: 'info' };
    case 'failed':
      return { label: chunk.lastError === 'file_missing' ? 'Lost' : 'Retrying', tone: 'danger' };
    case 'pending':
      return { label: 'Waiting', tone: 'neutral' };
  }
}

export function playbackMessage(snapshot: PlaybackSnapshot): string {
  const part = snapshot.index + 1;
  const total = snapshot.totalChunks;
  switch (snapshot.status) {
    case 'idle':
      return 'Choose a book in the library to start listening.';
    case 'playing':
      return `Playing part ${part} of ${total}.`;
    case 'paused':
      return `Paused at part ${part} of ${total}.`;
    case 'finished':
      return 'Finished. Press Play or say "repeat" to listen again.';
    case 'waiting':
      if (snapshot.waitingReason === 'processing') {
        return 'The server is still preparing this book. Playback starts when the first part is on this phone.';
      }
      if (snapshot.waitingReason === 'missing') {
        return `Part ${part} could not be downloaded. Press Next to skip it, or retry from the library.`;
      }
      return `Part ${part} is still downloading. Playback starts automatically.`;
    case 'error':
      return snapshot.error ?? 'Playback failed. Try again.';
  }
}

export function voiceMessage(snapshot: VoiceSnapshot): string {
  switch (snapshot.status) {
    case 'off':
      return 'Voice commands are off. Turn them on in Settings.';
    case 'starting':
      return 'Starting voice commands…';
    case 'listening':
      return 'Listening. Say "next", "repeat", "pause" or "resume".';
    case 'unavailable':
      return snapshot.message ?? 'Voice commands are not available in this build.';
    case 'error':
      return snapshot.message ? `Voice commands stopped: ${snapshot.message}` : 'Voice commands stopped.';
  }
}

export interface NewBookInput {
  title: string;
  transcript: string;
}

export interface NewBookErrors {
  title?: string;
  transcript?: string;
}

export function validateNewBook(input: NewBookInput): NewBookErrors {
  const errors: NewBookErrors = {};
  const title = input.title.trim();
  if (title.length === 0) {
    errors.title = 'Enter a title.';
  } else if (title.length > MAX_TITLE_CHARS) {
    errors.title = `Keep the title under ${MAX_TITLE_CHARS} characters.`;
  }
  const transcript = input.transcript.trim();
  if (transcript.length === 0) {
    errors.transcript = 'Paste the text or load a file.';
  } else if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    errors.transcript = `The text is too long. The limit is ${MAX_TRANSCRIPT_CHARS.toLocaleString('en-US')} characters.`;
  }
  return errors;
}

/**
 * The Azure uz-UZ voices are configured for Latin-script Uzbek. Cyrillic input is accepted by the
 * server but may be mispronounced (not verified against the live service).
 */
export function containsCyrillic(text: string): boolean {
  return /[\u0400-\u04FF]/.test(text);
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}
