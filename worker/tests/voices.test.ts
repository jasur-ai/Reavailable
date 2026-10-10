import { describe, expect, it } from 'vitest';
import { buildSsml, languageOfVoice } from '../src/tts';

describe('voice language', () => {
  it('takes the language from the voice name', () => {
    expect(languageOfVoice('uz-UZ-MadinaNeural')).toBe('uz-UZ');
    expect(languageOfVoice('en-US-GuyNeural')).toBe('en-US');
  });

  it('writes the matching xml:lang into the SSML document', () => {
    expect(buildSsml('Hello', 'en-US-JennyNeural')).toContain('xml:lang="en-US"');
    expect(buildSsml('Salom', 'uz-UZ-SardorNeural')).toContain('xml:lang="uz-UZ"');
  });
});
