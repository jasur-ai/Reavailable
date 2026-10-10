import { describe, expect, it } from 'vitest';
import golden from './fixtures/chunking-golden.json';
import { buildChunks, hasCyrillic, normalizeText, splitSentences } from '../src/chunking';

interface GoldenCase {
  text: string;
  sentences_per_chunk: number;
  max_chunk_chars: number;
  sentences: string[];
  chunks: string[];
  has_cyrillic: boolean;
}

const cases = (golden as { cases: GoldenCase[] }).cases;

describe('chunking: identical to the Python reference implementation', () => {
  it.each(cases.map((item, index) => [index, item] as const))(
    'case %i matches the committed fixture',
    (_index, item) => {
      expect(splitSentences(item.text)).toEqual(item.sentences);
      expect(
        buildChunks(item.text, {
          sentencesPerChunk: item.sentences_per_chunk,
          maxChunkChars: item.max_chunk_chars,
        }),
      ).toEqual(item.chunks);
      expect(hasCyrillic(item.text)).toBe(item.has_cyrillic);
    },
  );

  it('covers a meaningful number of cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(20);
  });
});

describe('chunking: rules', () => {
  it('normalizes line endings, invisible characters and repeated spaces', () => {
    expect(normalizeText('a\r\nb\rc\u00a0d\u200b  e')).toBe('a\nb\nc d e');
  });

  it('keeps abbreviations and initials inside a sentence', () => {
    expect(splitSentences('Dr. Karimov keldi. A. Navoiy ham bor.')).toEqual([
      'Dr. Karimov keldi.',
      'A. Navoiy ham bor.',
    ]);
  });

  it('does not split a decimal number or before a digit', () => {
    // "3.5" is one number, and a sentence may start with a digit ("3. yil"), so neither period
    // ends a sentence. This mirrors the reference implementation exactly.
    expect(splitSentences("Narx 3.5 so'm. 3. yil boshlandi.")).toEqual(["Narx 3.5 so'm. 3. yil boshlandi."]);
  });

  it('does not split before a lowercase continuation', () => {
    expect(splitSentences('Bir gap. ikkinchi qismi. Yangi gap.')).toEqual([
      'Bir gap. ikkinchi qismi.',
      'Yangi gap.',
    ]);
  });

  it('treats a blank line as a hard boundary', () => {
    expect(splitSentences('Bir gap\n\nikki gap')).toEqual(['Bir gap', 'ikki gap']);
  });

  it('breaks over-long sentences at word boundaries and never exceeds the limit', () => {
    const text = `${'uzun '.repeat(200)}gap.`;
    const chunks = buildChunks(text, { sentencesPerChunk: 1, maxChunkChars: 120 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(120);
    }
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '));
  });

  it('cuts a single token longer than the limit', () => {
    const chunks = buildChunks('x'.repeat(700), { sentencesPerChunk: 1, maxChunkChars: 600 });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(600);
    expect(chunks[1]).toHaveLength(100);
  });

  it('groups the requested number of sentences per part', () => {
    expect(buildChunks('Bir. Ikki. Uch.', { sentencesPerChunk: 2 })).toEqual(['Bir. Ikki.', 'Uch.']);
    expect(buildChunks('Bir. Ikki. Uch.', { sentencesPerChunk: 1 })).toEqual(['Bir.', 'Ikki.', 'Uch.']);
  });

  it('returns nothing for text without readable content', () => {
    expect(buildChunks('   \n\n  ')).toEqual([]);
    expect(buildChunks('')).toEqual([]);
  });

  it('rejects nonsensical limits', () => {
    expect(() => buildChunks('a.', { sentencesPerChunk: 0 })).toThrow(/at least 1/);
    expect(() => buildChunks('a.', { maxChunkChars: 0 })).toThrow(/at least 1/);
  });

  it('detects Cyrillic text', () => {
    expect(hasCyrillic('Биринчи жумла.')).toBe(true);
    expect(hasCyrillic('Birinchi jumla.')).toBe(false);
  });

  it('keeps closing quotes with their sentence', () => {
    expect(splitSentences('U "kelaman" dedi. Keyin ketdi.')).toEqual(['U "kelaman" dedi.', 'Keyin ketdi.']);
  });
});
