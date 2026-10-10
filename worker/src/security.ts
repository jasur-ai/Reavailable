/**
 * Token and digest helpers.
 *
 * Job access tokens are random 256-bit values shown to the client once. Only their SHA-256 digest
 * is stored, so a leaked database does not expose working tokens. The format matches
 * `backend/app/security.py` (`secrets.token_urlsafe(32)`).
 */

export const TOKEN_BYTES = 32;

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** URL-safe base64 without padding, the same encoding Python's `token_urlsafe` uses. */
function toBase64Url(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      output += BASE64_ALPHABET[(value >>> bits) & 0x3f];
    }
  }
  if (bits > 0) {
    output += BASE64_ALPHABET[(value << (6 - bits)) & 0x3f];
  }
  return output.replace(/\+/g, '-').replace(/\//g, '_');
}

/** Generate a new URL-safe random access token. */
export function newAccessToken(bytes = TOKEN_BYTES): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return toBase64Url(buffer);
}

/** Generate a job identifier in the canonical UUID form the API validates. */
export function newJobId(): string {
  return crypto.randomUUID();
}

export function toBytes(value: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof value === 'string') {
    return new TextEncoder().encode(value);
  }
  if (value instanceof Uint8Array) {
    return value;
  }
  return new Uint8Array(value);
}

/** Lowercase hex SHA-256 digest of bytes or text. */
export async function sha256Hex(value: ArrayBuffer | Uint8Array | string): Promise<string> {
  // Passing the view itself keeps a slice of a larger buffer correct without copying.
  const digest = await crypto.subtle.digest('SHA-256', toBytes(value));
  return toHex(new Uint8Array(digest));
}

export function toHex(bytes: Uint8Array): string {
  let output = '';
  for (const byte of bytes) {
    output += byte.toString(16).padStart(2, '0');
  }
  return output;
}

/**
 * Compare two strings without short-circuiting on the first difference. Equal-length ASCII digests
 * and keys are the only values compared here.
 */
export function constantTimeEquals(left: string, right: string): boolean {
  const a = toBytes(left);
  const b = toBytes(right);
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a[index] ^ b[index];
  }
  return difference === 0;
}

/** Check a presented access token against the stored digest. */
export async function tokenMatches(storedHash: string, presentedToken: string): Promise<boolean> {
  return constantTimeEquals(storedHash, await sha256Hex(presentedToken));
}
