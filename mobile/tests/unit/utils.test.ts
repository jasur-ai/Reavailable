import { toHex } from '../../src/core/hex';
import { chunkRelativePath, extensionFor } from '../../src/core/sync/chunkFiles';
import { SYNTHESIS_FAILURE_CODES, describeError } from '../../src/core/messages';
import { DEFAULT_LANGUAGE, LANGUAGES, createTranslator, hasString, isLanguage } from '../../src/i18n';
import { STRINGS } from '../../src/i18n/strings';
import {
  MAX_TITLE_CHARS,
  MAX_TRANSCRIPT_CHARS,
  bookStatusView,
  containsCyrillic,
  formatCount,
  partStatus,
  playbackMessage,
  storedCount,
  totalParts,
  validateNewBook,
  voiceLabel,
  voiceMessage,
} from '../../src/ui/presentation';
import { makeBook, makeChunk } from './support/fakePlayer';

const en = createTranslator('en');
const uz = createTranslator('uz');

describe('toHex', () => {
  it('writes lower-case, zero-padded hexadecimal', () => {
    expect(toHex(new Uint8Array([0, 1, 15, 16, 255]))).toBe('00010f10ff');
  });

  it('encodes an empty array as an empty string', () => {
    expect(toHex(new Uint8Array())).toBe('');
  });
});

describe('chunk file naming', () => {
  it.each([
    ['audio/mpeg', 'mp3'],
    ['audio/mp3', 'mp3'],
    ['audio/ogg; codecs=opus', 'ogg'],
    ['audio/wav', 'wav'],
    ['AUDIO/X-WAV', 'wav'],
    ['application/octet-stream', 'mp3'],
    ['', 'mp3'],
  ])('uses the extension for %p', (contentType, extension) => {
    expect(extensionFor(contentType)).toBe(extension);
  });

  it('pads the part number so files sort in play order', () => {
    expect(chunkRelativePath('book-1', 3, 'audio/mpeg')).toBe('book-1/000003.mp3');
    expect(chunkRelativePath('book-1', 1234567, 'audio/mpeg')).toBe('book-1/1234567.mp3');
    expect(chunkRelativePath('book-1', 1234567, 'audio/wav')).toBe('book-1/1234567.wav');
  });
});

describe('languages', () => {
  it('defaults to Uzbek and offers both languages', () => {
    expect(DEFAULT_LANGUAGE).toBe('uz');
    expect(LANGUAGES).toEqual(['uz', 'en']);
  });

  it('recognises the two supported language codes only', () => {
    expect(isLanguage('uz')).toBe(true);
    expect(isLanguage('en')).toBe(true);
    expect(isLanguage('ru')).toBe(false);
    expect(isLanguage(undefined)).toBe(false);
  });
});

describe('string catalogue', () => {
  const keys = Object.keys(STRINGS) as (keyof typeof STRINGS)[];

  it('has wording in both languages for every key', () => {
    expect(keys.length).toBeGreaterThan(100);
    for (const key of keys) {
      for (const language of ['uz', 'en'] as const) {
        const text = STRINGS[key][language];
        expect(typeof text).toBe('string');
        expect(text.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it('uses the same placeholders in both languages', () => {
    const placeholders = (text: string): string[] => (text.match(/\{\w+\}/g) ?? []).slice().sort();
    for (const key of keys) {
      expect(placeholders(STRINGS[key].uz)).toEqual(placeholders(STRINGS[key].en));
    }
  });

  it('fills placeholders and leaves unknown ones untouched', () => {
    expect(en('playback.playing', { index: 2, total: 4 })).toBe('Playing part 2 of 4.');
    expect(uz('playback.playing', { index: 2, total: 4 })).toBe('4 qismdan 2-si ijro etilmoqda.');
    expect(en('playback.playing', { index: 2 })).toBe('Playing part 2 of {total}.');
    expect(en('playback.playing')).toBe('Playing part {index} of {total}.');
  });

  it('reports its language and answers for every supported language', () => {
    expect(en.language).toBe('en');
    expect(uz.language).toBe('uz');
    expect(createTranslator().language).toBe(DEFAULT_LANGUAGE);
    for (const language of LANGUAGES) {
      expect(createTranslator(language)('common.save').length).toBeGreaterThan(0);
    }
  });

  it('tells known machine codes from unknown ones', () => {
    expect(hasString('error.network')).toBe(true);
    expect(hasString('error.not_a_real_code')).toBe(false);
    expect(hasString('toString')).toBe(false);
  });
});

describe('describeError', () => {
  it('returns the wording for a known code in the requested language', () => {
    expect(describeError('network', en)).toMatch(/No connection/);
    expect(describeError('network', uz)).toMatch(/aloqa yo'q/);
  });

  it('falls back to the given text, then to a generic message', () => {
    expect(describeError('unknown_code', en, 'Custom')).toBe('Custom');
    expect(describeError(undefined, en)).toBe('Something went wrong. Try again.');
    expect(describeError(undefined, uz)).toBe("Nimadir xato ketdi. Qayta urinib ko'ring.");
  });

  it('marks the server-side synthesis failures, including a misconfigured server', () => {
    expect(SYNTHESIS_FAILURE_CODES).toEqual([
      'tts_auth_failed',
      'tts_bad_request',
      'tts_unavailable',
      'internal_error',
      'server_misconfigured',
    ]);
    for (const code of SYNTHESIS_FAILURE_CODES) {
      expect(describeError(code, en)).not.toMatch(/Something went wrong/);
      expect(describeError(code, uz)).not.toMatch(/Something went wrong/);
    }
  });
});

describe('presentation: book status', () => {
  it('describes a book that is still being prepared on the server', () => {
    const view = bookStatusView(makeBook('b', [], { status: 'processing', totalChunks: 0 }), en);
    expect(view).toMatchObject({ label: 'Preparing on server', canOpen: false, canRetry: false, progress: null });
    expect(bookStatusView(makeBook('b', [], { status: 'processing', totalChunks: 0 }), uz).label).toBe(
      'Serverda tayyorlanmoqda',
    );
  });

  it('shows download progress and allows opening once a part is on the phone', () => {
    const view = bookStatusView(
      makeBook('b', ['stored', 'pending', 'pending'], { status: 'downloading', syncNote: 'Waiting for a connection' }),
      en,
    );
    expect(view.progress).toEqual({ value: 1, total: 3 });
    expect(view.detail).toBe('1 of 3 parts on this phone. Waiting for a connection');
    expect(view.canOpen).toBe(true);
  });

  it('does not allow opening before the first part is on the phone', () => {
    const view = bookStatusView(makeBook('b', ['pending', 'pending'], { status: 'downloading' }), en);
    expect(view.canOpen).toBe(false);
  });

  it('says a fully downloaded book is ready offline once every part is acknowledged', () => {
    const chunks = [makeChunk('b', 0, 'stored'), makeChunk('b', 1, 'stored')].map((chunk) => ({ ...chunk, acked: true }));
    const view = bookStatusView(makeBook('b', [], { status: 'ready', chunks, totalChunks: 2 }), en);
    expect(view).toMatchObject({ label: 'Ready offline', tone: 'success' });
    expect(bookStatusView(makeBook('b', [], { status: 'ready', chunks, totalChunks: 2 }), uz).label).toBe(
      'Oflayn tayyor',
    );
  });

  it('keeps a ready book open while the server copy is still being acknowledged', () => {
    const view = bookStatusView(makeBook('b', ['stored', 'stored'], { status: 'ready' }), en);
    expect(view.label).toBe('Ready, finishing sync');
    expect(view.canOpen).toBe(true);
  });

  it('explains that the server copy expired but the phone copy is complete', () => {
    const chunks = [makeChunk('b', 0, 'stored')].map((chunk) => ({ ...chunk, acked: true }));
    const view = bookStatusView(makeBook('b', [], { status: 'ready', chunks, totalChunks: 1, serverGone: true }), en);
    expect(view.detail).toMatch(/server copy had already expired/);
  });

  it('offers retry for a failed book only when the server copy still exists', () => {
    const failed = makeBook('b', ['stored', 'failed'], {
      status: 'failed',
      errorCode: 'tts_unavailable',
      errorMessage: 'Try later.',
    });
    // A known code is translated, so the wording follows the language switch.
    expect(bookStatusView(failed, en)).toMatchObject({ label: 'Failed', tone: 'danger', canRetry: true });
    expect(bookStatusView(failed, en).detail).not.toBe('Try later.');
    expect(bookStatusView(failed, uz).detail).toMatch(/Nutq xizmati/);

    expect(bookStatusView({ ...failed, serverGone: true }, en).canRetry).toBe(false);
    expect(bookStatusView({ ...failed, errorCode: 'file_missing' }, en).canRetry).toBe(false);
  });

  it('uses the server message only for a code this app does not know', () => {
    const failed = makeBook('b', [], { status: 'failed', errorCode: 'a_new_code', errorMessage: 'Try later.' });
    expect(bookStatusView(failed, en).detail).toBe('Try later.');
    expect(bookStatusView({ ...failed, errorCode: undefined, errorMessage: undefined }, en).detail).toBe(
      'Something went wrong. Try again.',
    );
  });
});

describe('presentation: parts and counts', () => {
  it('counts stored parts and uses the larger of the declared and actual totals', () => {
    const book = makeBook('b', ['stored', 'pending'], { totalChunks: 5 });
    expect(storedCount(book)).toBe(1);
    expect(totalParts(book)).toBe(5);
  });

  it.each([
    [{ state: 'stored' as const, acked: true }, 'On phone', 'success'],
    [{ state: 'stored' as const, acked: false }, 'On phone, syncing', 'info'],
    [{ state: 'downloading' as const, acked: false }, 'Downloading', 'info'],
    [{ state: 'pending' as const, acked: false }, 'Waiting', 'neutral'],
    [{ state: 'failed' as const, acked: false, lastError: 'checksum_mismatch' }, 'Retrying', 'danger'],
    [{ state: 'failed' as const, acked: false, lastError: 'file_missing' }, 'Lost', 'danger'],
  ])('labels a part in state %j', (change, label, tone) => {
    const chunk = { ...makeChunk('b', 0, 'pending'), ...change };
    expect(partStatus(chunk, en)).toEqual({ label, tone });
  });

  it('labels parts in Uzbek too', () => {
    const chunk = { ...makeChunk('b', 0, 'stored'), acked: true };
    expect(partStatus(chunk, uz)).toEqual({ label: 'Telefonda', tone: 'success' });
  });

  it('labels a part that is not known yet as waiting', () => {
    expect(partStatus(undefined, en)).toEqual({ label: 'Waiting', tone: 'neutral' });
  });
});

describe('presentation: playback and voice messages', () => {
  const base = { bookId: 'b', index: 1, totalChunks: 4, status: 'paused' as const, waitingReason: null, error: null };

  it('describes the current part in human terms (one-based)', () => {
    expect(playbackMessage({ ...base, status: 'playing' }, en)).toBe('Playing part 2 of 4.');
    expect(playbackMessage({ ...base, status: 'paused' }, en)).toBe('Paused at part 2 of 4.');
    expect(playbackMessage({ ...base, status: 'playing' }, uz)).toBe('4 qismdan 2-si ijro etilmoqda.');
  });

  it('explains each waiting reason', () => {
    expect(playbackMessage({ ...base, status: 'waiting', waitingReason: 'processing' }, en)).toMatch(/still preparing/);
    expect(playbackMessage({ ...base, status: 'waiting', waitingReason: 'missing' }, en)).toMatch(/Press Next to skip/);
    expect(playbackMessage({ ...base, status: 'waiting', waitingReason: 'downloading' }, en)).toMatch(
      /Playback starts automatically/,
    );
  });

  it('shows the playback error, with a fallback', () => {
    expect(playbackMessage({ ...base, status: 'error', error: 'Codec missing.' }, en)).toBe('Codec missing.');
    expect(playbackMessage({ ...base, status: 'error' }, en)).toBe('Playback failed. Try again.');
    expect(playbackMessage({ ...base, status: 'idle' }, en)).toMatch(/Choose a book/);
    expect(playbackMessage({ ...base, status: 'finished' }, en)).toMatch(/Finished/);
  });

  it('tells the user which commands to say while listening', () => {
    expect(voiceMessage({ status: 'listening', message: null, lastCommand: null }, en)).toBe(
      'Listening. Say "next", "repeat", "pause" or "resume".',
    );
    // The commands themselves stay English in every interface language.
    expect(voiceMessage({ status: 'listening', message: null, lastCommand: null }, uz)).toMatch(/next/);
    expect(voiceMessage({ status: 'off', message: null, lastCommand: null }, en)).toMatch(/off/);
    expect(voiceMessage({ status: 'error', message: 'Busy.', lastCommand: null }, en)).toBe(
      'Voice commands stopped: Busy.',
    );
    expect(voiceMessage({ status: 'error', message: null, lastCommand: null }, en)).toBe('Voice commands stopped.');
    expect(voiceMessage({ status: 'unavailable', message: null, lastCommand: null }, en)).toMatch(/not available/);
  });

  it('explains a build without the speech module in the interface language', () => {
    const snapshot = { status: 'unavailable' as const, message: 'internal build detail', lastCommand: null };
    expect(voiceMessage(snapshot, en)).toMatch(/development build/);
    expect(voiceMessage(snapshot, uz)).not.toMatch(/internal build detail/);
  });
});

describe('presentation: new book validation', () => {
  it('requires a title and a transcript', () => {
    expect(validateNewBook({ title: '   ', transcript: '' }, en)).toEqual({
      title: 'Enter a title.',
      transcript: 'Paste the text or load a file.',
    });
    expect(validateNewBook({ title: '   ', transcript: '' }, uz)).toEqual({
      title: 'Sarlavha kiriting.',
      transcript: 'Matn joylang yoki fayl yuklang.',
    });
  });

  it('accepts a title and text within the limits', () => {
    expect(validateNewBook({ title: 'Kitob', transcript: 'Salom dunyo.' }, en)).toEqual({});
  });

  it('limits the title and the transcript length', () => {
    expect(validateNewBook({ title: 'x'.repeat(MAX_TITLE_CHARS + 1), transcript: 'a' }, en)).toHaveProperty('title');
    expect(validateNewBook({ title: 'ok', transcript: 'a'.repeat(MAX_TRANSCRIPT_CHARS + 1) }, en)).toHaveProperty(
      'transcript',
    );
  });

  it('detects Cyrillic script', () => {
    expect(containsCyrillic('Salom')).toBe(false);
    expect(containsCyrillic('Салом')).toBe(true);
  });

  it('names the configured Uzbek voices and leaves others alone', () => {
    expect(voiceLabel('uz-UZ-MadinaNeural', en)).toBe('Madina (female)');
    expect(voiceLabel('uz-UZ-SardorNeural', uz)).toBe('Sardor (erkak)');
    expect(voiceLabel('fake-uz', en)).toBe('fake-uz');
  });

  it('formats counts with separators', () => {
    expect(formatCount(200000)).toBe('200,000');
  });
});
