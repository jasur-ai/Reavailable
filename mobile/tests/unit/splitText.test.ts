import { splitTranscript } from '../../src/core/documents/splitText';

describe('splitTranscript', () => {
  it('returns a short text unchanged as one part', () => {
    expect(splitTranscript('Salom. Dunyo.', 100)).toEqual(['Salom. Dunyo.']);
  });

  it('returns nothing for blank input', () => {
    expect(splitTranscript('   \n  ', 100)).toEqual([]);
  });

  it('keeps every part within the limit and loses no words', () => {
    const sentence = 'Bu gap ancha uzun bo‘lishi uchun yozilgan. ';
    const text = sentence.repeat(60).trim();
    const parts = splitTranscript(text, 300);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(300);
    }
    expect(parts.join(' ').split(/\s+/).length).toBe(text.split(/\s+/).length);
  });

  it('breaks between sentences, not inside them', () => {
    const parts = splitTranscript('Birinchi gap. Ikkinchi gap. Uchinchi gap. To‘rtinchi gap.', 30);
    expect(parts).toEqual(['Birinchi gap. Ikkinchi gap.', 'Uchinchi gap. To‘rtinchi gap.']);
  });

  it('prefers paragraph boundaries', () => {
    const text = 'Birinchi bob matni.\n\nIkkinchi bob matni.';
    expect(splitTranscript(text, 25)).toEqual(['Birinchi bob matni.', 'Ikkinchi bob matni.']);
  });

  it('cuts a sentence longer than the limit at a space', () => {
    const long = Array.from({ length: 40 }, (_, i) => `so'z${i}`).join(' ');
    const parts = splitTranscript(long, 50);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.length <= 50)).toBe(true);
  });
});
