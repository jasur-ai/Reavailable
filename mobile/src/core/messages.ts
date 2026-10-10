/**
 * User-facing wording for machine error codes returned by the server or raised by the device.
 *
 * The wording lives in the string catalogue, so it follows the interface language. Transcript text
 * and credentials never appear in these messages.
 */

import { hasString, type StringKey, type Translate } from '../i18n';

/** Translate a machine code. Unknown codes use `fallback`, or the generic wording. */
export function describeError(code: string | undefined, t: Translate, fallback?: string): string {
  if (code) {
    const key = `error.${code}`;
    if (hasString(key)) {
      return t(key as StringKey);
    }
  }
  return fallback ?? t('error.fallback');
}

/** Error codes that mean the server finished this book with a failure (not a transient problem). */
export const SYNTHESIS_FAILURE_CODES: readonly string[] = [
  'tts_auth_failed',
  'tts_bad_request',
  'tts_unavailable',
  'internal_error',
  'server_misconfigured',
];
