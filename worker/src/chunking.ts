/**
 * Transcript segmentation for text-to-speech.
 *
 * This is a line-by-line port of `backend/app/chunking.py`, so the Cloudflare Worker and the
 * self-hosted Python backend split the same transcript into the same parts. A golden test in
 * `tests/chunking.test.ts` compares both implementations on Uzbek prose.
 *
 * Pipeline: normalize whitespace -> paragraphs -> sentences -> split over-long sentences at word
 * boundaries -> group into chunks of one or two sentences that respect a character limit.
 */

/** Abbreviations that must not end a sentence. Mirrors the Python table. */
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  // English titles and units (transcripts often mix languages)
  'dr',
  'mr',
  'mrs',
  'ms',
  'prof',
  'st',
  'jr',
  'sr',
  'vs',
  'etc',
  'no',
  'fig',
  // Uzbek titles and units
  'akad',
  'dots',
  'fil',
  'kand',
  'mln',
  'mlrd',
  'km',
  'kg',
  'sm',
]);

// A sentence terminator, optional closing quotes or brackets, then whitespace before the next token.
const TERMINATOR = /([.!?\u2026]+)(["'\u2019\u201d»)\]]*)(\s+)(?=\S)/g;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const PARAGRAPH_BREAK = /\n\s*\n+/;
const HORIZONTAL_SPACE = /[ \t]+/g;
const CYRILLIC = /[\u0400-\u04ff]/;
const LETTER = /\p{L}/u;

/** True when the text contains Cyrillic letters. */
export function hasCyrillic(text: string): boolean {
  return CYRILLIC.test(text);
}

/** Normalize line endings, invisible characters and horizontal whitespace. */
export function normalizeText(text: string): string {
  let cleaned = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  cleaned = cleaned.replace(/\ufeff/g, '').replace(/\u200b/g, '').replace(/\u00a0/g, ' ');
  cleaned = cleaned.replace(CONTROL_CHARS, '');
  return cleaned
    .split('\n')
    .map((line) => line.replace(HORIZONTAL_SPACE, ' ').trim())
    .join('\n');
}

function isLower(character: string): boolean {
  return character !== character.toUpperCase() && character === character.toLowerCase();
}

function isDigit(character: string): boolean {
  return character >= '0' && character <= '9';
}

/** The alphabetic word that ends immediately before `index`, or '' when there is none. */
function wordBefore(text: string, index: number): string {
  let start = index;
  while (start > 0 && LETTER.test(text[start - 1])) {
    start -= 1;
  }
  return text.slice(start, index);
}

interface TerminatorMatch {
  /** Index of the first terminator character. */
  termStart: number;
  /** Index just after the terminator characters. */
  termEnd: number;
  /** Index just after any closing quotes or brackets. */
  closeEnd: number;
  /** Index just after the whitespace that follows the sentence. */
  end: number;
  term: string;
}

function isSentenceBoundary(text: string, match: TerminatorMatch): boolean {
  const following = text[match.end]; // the lookahead guarantees a character here
  if (following === undefined || isLower(following) || isDigit(following)) {
    return false;
  }
  if (match.term === '.') {
    const word = wordBefore(text, match.termStart);
    if (ABBREVIATIONS.has(word.toLowerCase())) {
      return false;
    }
    if (word.length === 1 && LETTER.test(word)) {
      // A single letter initial, for example "A. Navoiy".
      return false;
    }
  }
  return true;
}

function splitParagraph(paragraph: string): string[] {
  const sentences: string[] = [];
  let start = 0;
  TERMINATOR.lastIndex = 0;
  let raw: RegExpExecArray | null;
  while ((raw = TERMINATOR.exec(paragraph)) !== null) {
    const match: TerminatorMatch = {
      term: raw[1],
      termStart: raw.index,
      termEnd: raw.index + raw[1].length,
      closeEnd: raw.index + raw[1].length + raw[2].length,
      end: raw.index + raw[0].length,
    };
    if (!isSentenceBoundary(paragraph, match)) {
      continue;
    }
    const sentence = paragraph.slice(start, match.closeEnd).trim();
    if (sentence) {
      sentences.push(sentence);
    }
    start = match.end;
  }
  const tail = paragraph.slice(start).trim();
  if (tail) {
    sentences.push(tail);
  }
  return sentences;
}

/** Split text into sentences. Blank lines always end a sentence. */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  for (const block of normalizeText(text).split(PARAGRAPH_BREAK)) {
    const flat = block
      .split('\n')
      .filter((line) => line.length > 0)
      .join(' ');
    if (flat) {
      sentences.push(...splitParagraph(flat));
    }
  }
  return sentences;
}

/** Break a sentence longer than `limit` into pieces at word boundaries. */
function breakLong(sentence: string, limit: number): string[] {
  if (sentence.length <= limit) {
    return [sentence];
  }
  const pieces: string[] = [];
  let current = '';
  for (let word of sentence.split(/\s+/).filter((part) => part.length > 0)) {
    while (word.length > limit) {
      // A pathological token longer than the limit is cut mid-word.
      if (current) {
        pieces.push(current);
        current = '';
      }
      pieces.push(word.slice(0, limit));
      word = word.slice(limit);
    }
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= limit) {
      current = candidate;
    } else {
      pieces.push(current);
      current = word;
    }
  }
  if (current) {
    pieces.push(current);
  }
  return pieces;
}

export interface BuildChunksOptions {
  sentencesPerChunk?: number;
  maxChunkChars?: number;
}

/**
 * Build TTS chunks of up to `sentencesPerChunk` sentences, each at most `maxChunkChars` long.
 * Returns an empty list when the text contains nothing readable.
 */
export function buildChunks(text: string, options: BuildChunksOptions = {}): string[] {
  const sentencesPerChunk = options.sentencesPerChunk ?? 2;
  const maxChunkChars = options.maxChunkChars ?? 600;
  if (sentencesPerChunk < 1) {
    throw new Error('sentencesPerChunk must be at least 1');
  }
  if (maxChunkChars < 1) {
    throw new Error('maxChunkChars must be at least 1');
  }

  const units: string[] = [];
  for (const sentence of splitSentences(text)) {
    units.push(...breakLong(sentence, maxChunkChars));
  }

  const chunks: string[] = [];
  let group: string[] = [];
  for (const unit of units) {
    const full = group.length >= sentencesPerChunk;
    const tooLong = group.length > 0 && [...group, unit].join(' ').length > maxChunkChars;
    if (group.length > 0 && (full || tooLong)) {
      chunks.push(group.join(' '));
      group = [];
    }
    group.push(unit);
  }
  if (group.length > 0) {
    chunks.push(group.join(' '));
  }
  return chunks;
}
