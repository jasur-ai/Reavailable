/**
 * Gives every screen the translator for the current interface language without passing it through
 * each component's props. AppRoot provides it; the value changes when the language changes.
 */

import { createContext, useContext } from 'react';
import { DEFAULT_LANGUAGE, createTranslator, type Translate } from '../i18n';

const TranslateContext = createContext<Translate>(createTranslator(DEFAULT_LANGUAGE));

export const TranslateProvider = TranslateContext.Provider;

export function useTranslate(): Translate {
  return useContext(TranslateContext);
}
