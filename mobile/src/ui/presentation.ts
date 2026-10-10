/**
 * Pure presentation logic: turns core state into user-facing text and tones.
 * Kept free of React Native imports so it can be unit-tested under Node, and free of language
 * choices: every function takes a translator for the current interface language.
 */

import { describeError } from '../core/messages';
import type { PlaybackSnapshot } from '../core/playback/playbackController';
import type { BookRecord, ChunkRecord } from '../core/types';
import type { VoiceSnapshot } from '../core/voice/voiceService';
import type { Translate } from '../i18n';
import { describeVoice } from '../core/voices';

export type Tone = 'neutral' | 'info' | 'warning' | 'danger' | 'success';

/** Longest text accepted in one go. Longer texts are split into several books of PART_MAX_CHARS. */
export const MAX_TRANSCRIPT_CHARS = 1_000_000;
/**
 * Largest text one book may hold. At worst (short sentences, one per part) 80,000 characters make about
 * 2,000 parts, which is the per-book limit of the server as it is deployed today.
 */
export const PART_MAX_CHARS = 80_000;
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

export function bookStatusView(book: BookRecord, t: Translate): BookStatusView {
  const stored = storedCount(book);
  const total = totalParts(book);
  const partsLine = total > 0 ? t('status.partsOnPhone', { stored, total }) : '';

  switch (book.status) {
    case 'processing':
      return {
        label: t('status.processing'),
        tone: 'info',
        detail: t('status.processingDetail'),
        progress: null,
        canOpen: false,
        canRetry: false,
      };
    case 'downloading':
      return {
        label: t('status.downloading'),
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
          label: t('status.readyOffline'),
          tone: 'success',
          detail: book.serverGone ? t('status.readyExpired', { total }) : t('status.readyAllParts', { total }),
          progress: { value: stored, total },
          canOpen: true,
          canRetry: false,
        };
      }
      return {
        label: t('status.readyFinishing'),
        tone: 'info',
        detail: book.syncNote ?? t('status.readyFinishingDetail'),
        progress: { value: stored, total },
        canOpen: true,
        canRetry: false,
      };
    }
    case 'failed':
      return {
        label: t('status.failed'),
        tone: 'danger',
        // A known code is translated here, so switching the language refreshes the wording. The
        // server's own message is used only for a code this app does not know.
        detail: book.errorCode
          ? describeError(book.errorCode, t, book.errorMessage)
          : book.errorMessage ?? t('status.failedDetail'),
        progress: total > 0 ? { value: stored, total } : null,
        canOpen: stored > 0,
        canRetry: !book.serverGone && book.errorCode !== 'file_missing',
      };
  }
}

export function partStatus(chunk: ChunkRecord | undefined, t: Translate): { label: string; tone: Tone } {
  if (!chunk) {
    return { label: t('part.waiting'), tone: 'neutral' };
  }
  switch (chunk.state) {
    case 'stored':
      return chunk.acked
        ? { label: t('part.stored'), tone: 'success' }
        : { label: t('part.storedSyncing'), tone: 'info' };
    case 'downloading':
      return { label: t('part.downloading'), tone: 'info' };
    case 'failed':
      return { label: chunk.lastError === 'file_missing' ? t('part.lost') : t('part.retrying'), tone: 'danger' };
    case 'pending':
      return { label: t('part.waiting'), tone: 'neutral' };
  }
}

export function playbackMessage(snapshot: PlaybackSnapshot, t: Translate): string {
  const part = snapshot.index + 1;
  const total = snapshot.totalChunks;
  switch (snapshot.status) {
    case 'idle':
      return t('playback.idle');
    case 'playing':
      return t('playback.playing', { index: part, total });
    case 'paused':
      return t('playback.paused', { index: part, total });
    case 'finished':
      return t('playback.finished');
    case 'waiting':
      if (snapshot.waitingReason === 'processing') {
        return t('playback.waitingProcessing');
      }
      if (snapshot.waitingReason === 'missing') {
        return t('playback.waitingMissing', { index: part });
      }
      return t('playback.waitingDownload', { index: part });
    case 'error':
      return snapshot.error ?? t('playback.error');
  }
}

export function voiceMessage(snapshot: VoiceSnapshot, t: Translate): string {
  switch (snapshot.status) {
    case 'off':
      return t('voice.off');
    case 'starting':
      return t('voice.starting');
    case 'listening':
      return t('voice.listening');
    case 'unavailable':
      // The snapshot message is an internal build detail; the catalogue wording is what a user needs.
      return t('voice.unavailableBuild');
    case 'error':
      return snapshot.message ? t('voice.stoppedWith', { message: snapshot.message }) : t('voice.stopped');
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

export function validateNewBook(input: NewBookInput, t: Translate): NewBookErrors {
  const errors: NewBookErrors = {};
  const title = input.title.trim();
  if (title.length === 0) {
    errors.title = t('errors.titleRequired');
  } else if (title.length > MAX_TITLE_CHARS) {
    errors.title = t('errors.titleTooLong', { max: MAX_TITLE_CHARS });
  }
  const transcript = input.transcript.trim();
  if (transcript.length === 0) {
    errors.transcript = t('errors.transcriptRequired');
  } else if (transcript.length > MAX_TRANSCRIPT_CHARS) {
    errors.transcript = t('errors.transcriptTooLong', { max: formatCount(MAX_TRANSCRIPT_CHARS) });
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

/**
 * Human readable name of a voice without any personal name: gender and language only, for example
 * "Ayol ovozi · O'zbekcha". Unknown voices fall back to a generic label.
 */
export function voiceLabel(voice: string, t: Translate): string {
  const info = describeVoice(voice);
  if (!info) {
    return t('voice.unknown');
  }
  const gender = info.gender === 'female' ? t('voice.female') : t('voice.male');
  const language = info.language === 'uz' ? t('voice.langUz') : t('voice.langEn');
  return `${gender} · ${language}`;
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}
