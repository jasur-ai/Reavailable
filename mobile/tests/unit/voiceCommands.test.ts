import {
  UNKNOWN_TOKEN,
  VOICE_COMMANDS,
  VOICE_GRAMMAR,
  isVoiceCommand,
  parseCommand,
  readRecognizedText,
} from '../../src/core/voice/commands';

describe('voice grammar', () => {
  it('contains exactly the four commands (the three planned ones plus resume) and the unknown token', () => {
    expect(VOICE_COMMANDS).toEqual(['next', 'repeat', 'pause', 'resume']);
    expect(VOICE_GRAMMAR).toEqual([...VOICE_COMMANDS, UNKNOWN_TOKEN]);
  });

  it('recognizes only grammar words as commands', () => {
    expect(isVoiceCommand('next')).toBe(true);
    expect(isVoiceCommand('back')).toBe(false);
    expect(isVoiceCommand('faster')).toBe(false);
    expect(isVoiceCommand('[unk]')).toBe(false);
  });
});

describe('readRecognizedText', () => {
  it('trims plain text and reports no confidence', () => {
    expect(readRecognizedText('  next \n')).toEqual({ text: 'next', confidence: null });
  });

  it('reads the text and the lowest word confidence from Vosk JSON', () => {
    const raw = JSON.stringify({
      text: 'next repeat',
      result: [
        { word: 'next', conf: 0.92 },
        { word: 'repeat', conf: 0.61 },
      ],
    });
    expect(readRecognizedText(raw)).toEqual({ text: 'next repeat', confidence: 0.61 });
  });

  it('treats broken JSON as plain text', () => {
    expect(readRecognizedText('{not json')).toEqual({ text: '{not json', confidence: null });
  });

  it('returns empty text when the JSON has no text field', () => {
    expect(readRecognizedText('{"result": []}')).toEqual({ text: '', confidence: null });
  });

  it('ignores entries without a numeric confidence', () => {
    const raw = JSON.stringify({ text: 'pause', result: [{ word: 'pause' }, { word: 'x', conf: 'high' }] });
    expect(readRecognizedText(raw)).toEqual({ text: 'pause', confidence: null });
  });
});

describe('parseCommand', () => {
  const MIN = 0.5;

  it.each([
    ['next', 'next'],
    ['  Repeat  ', 'repeat'],
    ['PAUSE', 'pause'],
    ['resume.', 'resume'],
  ])('maps %p to %p', (raw, expected) => {
    expect(parseCommand(raw, MIN)).toBe(expected);
  });

  it.each([
    ['', 'empty result'],
    ['next time', 'a phrase, not a single word'],
    ['play', 'a word outside the grammar'],
    ['[unk]', 'the unknown token'],
    ['next [unk]', 'a command mixed with unknown speech'],
    ['123', 'digits only'],
  ])('rejects %p (%s)', (raw) => {
    expect(parseCommand(raw, MIN)).toBeNull();
  });

  it('accepts a command whose confidence meets the threshold', () => {
    const raw = JSON.stringify({ text: 'next', result: [{ word: 'next', conf: 0.5 }] });
    expect(parseCommand(raw, MIN)).toBe('next');
  });

  it('rejects a command recognized with low confidence', () => {
    const raw = JSON.stringify({ text: 'next', result: [{ word: 'next', conf: 0.31 }] });
    expect(parseCommand(raw, MIN)).toBeNull();
  });

  it('accepts a command when the engine does not report confidence', () => {
    expect(parseCommand('resume', 0.99)).toBe('resume');
  });
});
