/** Internationalisation entry point: languages, the string catalogue and the translator. */

export { DEFAULT_LANGUAGE, LANGUAGES, isLanguage, type Language } from './language';
export { STRINGS, type StringKey } from './strings';
export { createTranslator, hasString, type Translate, type TranslateParams } from './translate';
