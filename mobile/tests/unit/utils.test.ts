import { toHex } from '../../src/core/hex';
import { chunkRelativePath, extensionFor } from '../../src/core/sync/chunkFiles';
import { SYNTHESIS_FAILURE_CODES, describeError } from '../../src/core/messages';
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
  voiceMessage,
} from '../../src/ui/presentation';
import { makeBook, makeChunk } from './support/fakePlayer';

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
    expect(chunkRelativePath('book-1', 1234567, 'audio/wav')).toBe('book-1/1234567.wav');
  });
});

describe('describeError', () => {
  it('returns the wording for a known code', () => {
    expect(describeError('network')).toMatch(/No connection/);
  });

  it('falls back to the given text, then to a generic message', () => {
    expect(describeError('unknown_code', 'Custom')).toBe('Custom');
    expect(describeError(undefined)).toBe('Something went wrong. Try again.');
  });

  it('marks the four server-side synthesis failures', () => {
    expect(SYNTHESIS_FAILURE_CODES).toEqual(['tts_auth_failed', 'tts_bad_request', 'tts_unavailable', 'internal_error']);
    for (const code of SYNTHESIS_FAILURE_CODES) {
      expect(describeError(code)).not.toMatch(/Something went wrong/);
    }
  });
});

describe('presentation: book status', () => {
  it('describes a book that is still being prepared on the server', () => {
    const view = bookStatusView(makeBook('b', [], { status: 'processing', totalChunks: 0 }));
    expect(view).toMatchObject({ label: 'Preparing on server', canOpen: false, canRetry: false, progress: null });
  });

  it('shows download progress and allows opening once a part is on the phone', () => {
    const view = bookStatusView(makeBook('b', ['stored', 'pending', 'pending'], { status: 'downloading', syncNote: 'Waiting for a connection' }));
    expect(view.progress).toEqual({ value: 1, total: 3 });
    expect(view.detail).toBe('1 of 3 parts on this phone. Waiting for a connection');
    expect(view.canOpen).toBe(true);
  });

  it('does not allow opening before the first part is on the phone', () => {
    const view = bookStatusView(makeBook('b', ['pending', 'pending'], { status: 'downloading' }));
    expect(view.canOpen).toBe(false);
  });

  it('says a fully downloaded book is ready offline once every part is acknowledged', () => {
    const chunks = [makeChunk('b', 0, 'stored'), makeChunk('b', 1, 'stored')].map((chunk) => ({ ...chunk, acked: true }));
    const view = bookStatusView(makeBook('b', [], { status: 'ready', chunks, totalChunks: 2 }));
    expect(view).toMatchObject({ label: 'Ready offline', tone: 'success' });
  });

  it('keeps a ready book open while the server copy is still being acknowledged', () => {
    const view = bookStatusView(makeBook('b', ['stored', 'stored'], { status: 'ready' }));
    expect(view.label).toBe('Ready, finishing sync');
    expect(view.canOpen).toBe(true);
  });

  it('explains that the server copy expired but the phone copy is complete', () => {
    const chunks = [makeChunk('b', 0, 'stored')].map((chunk) => ({ ...chunk, acked: true }));
    const view = bookStatusView(makeBook('b', [], { status: 'ready', chunks, totalChunks: 1, serverGone: true }));
    expect(view.detail).toMatch(/server copy had already expired/);
  });

  it('offers retry for a failed book only when the server copy still exists', () => {
    const failed = makeBook('b', ['stored', 'failed'], { status: 'failed', errorCode: 'tts_unavailable', errorMessage: 'Try later.' });
    expect(bookStatusView(failed)).toMatchObject({ label: 'Failed', tone: 'danger', canRetry: true, detail: 'Try later.' });

    expect(bookStatusView({ ...failed, serverGone: true }).canRetry).toBe(false);
    expect(bookStatusView({ ...failed, errorCode: 'file_missing' }).canRetry).toBe(false);
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
    expect(partStatus(chunk)).toEqual({ label, tone });
  });

  it('labels a part that is not known yet as waiting', () => {
    expect(partStatus(undefined)).toEqual({ label: 'Waiting', tone: 'neutral' });
  });
});

describe('presentation: playback and voice messages', () => {
  const base = { bookId: 'b', index: 1, totalChunks: 4, status: 'paused' as const, waitingReason: null, error: null };

  it('describes the current part in human terms (one-based)', () => {
    expect(playbackMessage({ ...base, status: 'playing' })).toBe('Playing part 2 of 4.');
    expect(playbackMessage({ ...base, status: 'paused' })).toBe('Paused at part 2 of 4.');
  });

  it('explains each waiting reason', () => {
    expect(playbackMessage({ ...base, status: 'waiting', waitingReason: 'processing' })).toMatch(/still preparing/);
    expect(playbackMessage({ ...base, status: 'waiting', waitingReason: 'missing' })).toMatch(/Press Next to skip/);
    expect(playbackMessage({ ...base, status: 'waiting', waitingReason: 'downloading' })).toMatch(/Playback starts automatically/);
  });

  it('shows the playback error, with a fallback', () => {
    expect(playbackMessage({ ...base, status: 'error', error: 'Codec missing.' })).toBe('Codec missing.');
    expect(playbackMessage({ ...base, status: 'error' })).toBe('Playback failed. Try again.');
    expect(playbackMessage({ ...base, status: 'idle' })).toMatch(/Choose a book/);
    expect(playbackMessage({ ...base, status: 'finished' })).toMatch(/Finished/);
  });

  it('tells the user which commands to say while listening', () => {
    expect(voiceMessage({ status: 'listening', message: null, lastCommand: null })).toBe(
      'Listening. Say "next", "repeat", "pause" or "resume".',
    );
    expect(voiceMessage({ status: 'off', message: null, lastCommand: null })).toMatch(/off/);
    expect(voiceMessage({ status: 'error', message: 'Busy.', lastCommand: null })).toBe('Voice commands stopped: Busy.');
    expect(voiceMessage({ status: 'error', message: null, lastCommand: null })).toBe('Voice commands stopped.');
    expect(voiceMessage({ status: 'unavailable', message: null, lastCommand: null })).toMatch(/not available/);
  });
});

describe('presentation: new book validation', () => {
  it('requires a title and a transcript', () => {
    expect(validateNewBook({ title: '   ', transcript: '' })).toEqual({
      title: 'Enter a title.',
      transcript: 'Paste the text or load a file.',
    });
  });

  it('accepts a title and text within the limits', () => {
    expect(validateNewBook({ title: 'Kitob', transcript: 'Salom dunyo.' })).toEqual({});
  });

  it('limits the title and the transcript length', () => {
    expect(validateNewBook({ title: 'x'.repeat(MAX_TITLE_CHARS + 1), transcript: 'a' })).toHaveProperty('title');
    expect(validateNewBook({ title: 'ok', transcript: 'a'.repeat(MAX_TRANSCRIPT_CHARS + 1) })).toHaveProperty('transcript');
  });

  it('detects Cyrillic script', () => {
    expect(containsCyrillic('Salom')).toBe(false);
    expect(containsCyrillic('Салом')).toBe(true);
  });

  it('formats counts with separators', () => {
    expect(formatCount(200000)).toBe('200,000');
  });
});
