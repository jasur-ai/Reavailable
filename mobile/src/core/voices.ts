/**
 * Voices offered to the user. Each language has one female and one male voice. The app shows only
 * the gender and language, never a voice name, so the list can change on the server without UI text.
 */

export type BookLanguage = 'uz' | 'en';
export type VoiceGender = 'female' | 'male';

export interface VoiceInfo {
  id: string;
  language: BookLanguage;
  gender: VoiceGender;
}

export const VOICE_CATALOG: readonly VoiceInfo[] = [
  { id: 'uz-UZ-MadinaNeural', language: 'uz', gender: 'female' },
  { id: 'uz-UZ-SardorNeural', language: 'uz', gender: 'male' },
  { id: 'en-US-JennyNeural', language: 'en', gender: 'female' },
  { id: 'en-US-GuyNeural', language: 'en', gender: 'male' },
];

export const BOOK_LANGUAGES: readonly BookLanguage[] = ['uz', 'en'];
export const VOICE_GENDERS: readonly VoiceGender[] = ['female', 'male'];

/** The voice id for a language and gender, or null when the catalogue has none. */
export function voiceFor(language: BookLanguage, gender: VoiceGender): string | null {
  return VOICE_CATALOG.find((voice) => voice.language === language && voice.gender === gender)?.id ?? null;
}

/** Language and gender of a voice id, or null for a voice this app does not know. */
export function describeVoice(id: string): Pick<VoiceInfo, 'language' | 'gender'> | null {
  const known = VOICE_CATALOG.find((voice) => voice.id === id);
  return known ? { language: known.language, gender: known.gender } : null;
}
