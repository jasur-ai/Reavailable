/**
 * The translator: a pure function from a string key (plus optional parameters) to text.
 *
 * It is created once per language and passed into the presentation helpers, so those stay free of
 * React and can be unit-tested under Node.
 */

import { DEFAULT_LANGUAGE, type Language } from './language';
import { STRINGS, type StringKey } from './strings';

export type TranslateParams = Record<string, string | number>;

export interface Translate {
  (key: StringKey, params?: TranslateParams): string;
  /** The language this translator renders. */
  readonly language: Language;
}

function fill(template: string, params?: TranslateParams): string {
  if (!params) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
    name in params ? String(params[name]) : placeholder,
  );
}

export function createTranslator(language: Language = DEFAULT_LANGUAGE): Translate {
  const translate = ((key: StringKey, params?: TranslateParams): string => {
    const entry = STRINGS[key];
    if (!entry) {
      // An unknown key is a programming error; showing it beats showing nothing.
      return String(key);
    }
    return fill(entry[language] ?? entry.en, params);
  }) as Translate;
  Object.defineProperty(translate, 'language', { value: language, enumerable: true });
  return translate;
}

/** True when a machine code has wording in the catalogue, for example a server error code. */
export function hasString(key: string): key is StringKey {
  return Object.prototype.hasOwnProperty.call(STRINGS, key);
}
