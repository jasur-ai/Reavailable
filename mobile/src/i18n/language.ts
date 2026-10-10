/**
 * Supported interface languages.
 *
 * Uzbek is the default because the app is built for Uzbek listeners; English stays available for
 * anyone else and for the voice commands, which are always spoken in English.
 */

export type Language = 'uz' | 'en';

export const DEFAULT_LANGUAGE: Language = 'uz';

export const LANGUAGES: readonly Language[] = ['uz', 'en'];

export function isLanguage(value: unknown): value is Language {
  return value === 'uz' || value === 'en';
}
