import { describeVoice, voiceFor, VOICE_CATALOG } from '../../src/core/voices';

describe('voice catalogue', () => {
  it('offers a female and a male voice for each book language', () => {
    for (const language of ['uz', 'en'] as const) {
      expect(voiceFor(language, 'female')).not.toBeNull();
      expect(voiceFor(language, 'male')).not.toBeNull();
      expect(voiceFor(language, 'female')).not.toBe(voiceFor(language, 'male'));
    }
  });

  it('describes a known voice by language and gender', () => {
    expect(describeVoice('en-US-GuyNeural')).toEqual({ language: 'en', gender: 'male' });
    expect(describeVoice('uz-UZ-MadinaNeural')).toEqual({ language: 'uz', gender: 'female' });
  });

  it('returns null for a voice it does not know', () => {
    expect(describeVoice('fr-FR-DeniseNeural')).toBeNull();
  });

  it('matches the voices the server allows by default', () => {
    expect(VOICE_CATALOG.map((voice) => voice.id)).toEqual([
      'uz-UZ-MadinaNeural',
      'uz-UZ-SardorNeural',
      'en-US-JennyNeural',
      'en-US-GuyNeural',
    ]);
  });
});
