/**
 * User-facing wording for machine error codes returned by the server or raised by the device.
 * Transcript text and credentials never appear in these messages.
 */

const MESSAGES: Readonly<Record<string, string>> = {
  tts_auth_failed: 'The speech service rejected its credentials. The server operator must fix the configuration.',
  tts_bad_request: 'The speech service rejected part of this text. Edit the book and create it again.',
  tts_unavailable: 'The speech service is temporarily unavailable. Retry in a few minutes.',
  internal_error: 'The server hit an unexpected error. Retry later.',
  job_not_found:
    'The server copy has expired or was removed before this device had every part. Parts already on this device are kept.',
  chunk_unavailable: 'A part is no longer available on the server. Parts already on this device are kept.',
  chunk_not_found: 'A part is no longer available on the server. Parts already on this device are kept.',
  chunk_not_ready: 'The server is still finishing this part. Downloads resume automatically.',
  unauthorized: 'The server rejected the access token for this book.',
  checksum_mismatch: 'A downloaded part failed verification and will be downloaded again.',
  checksum_rejected:
    'The server keeps rejecting a part because its checksum does not match. Retry to download it again, or remove the book.',
  network: 'No connection to the server. Downloads resume automatically.',
  timeout: 'The server took too long to respond. Downloads resume automatically.',
  invalid_response: 'The server returned an unexpected response.',
  job_not_ready: 'The book is not ready on the server yet.',
  token_missing: 'The access token for this book is missing on this device.',
  storage_failed: 'The audio could not be saved on this device. Free up storage space, then retry.',
  file_missing:
    'Some parts were removed from this device and cannot be recovered. Remove the book and add it again.',
};

export function describeError(code: string | undefined, fallback?: string): string {
  if (code && MESSAGES[code]) {
    return MESSAGES[code];
  }
  return fallback ?? 'Something went wrong. Try again.';
}

/** Error codes that mean the server finished this book with a failure (not a transient problem). */
export const SYNTHESIS_FAILURE_CODES: readonly string[] = [
  'tts_auth_failed',
  'tts_bad_request',
  'tts_unavailable',
  'internal_error',
];
