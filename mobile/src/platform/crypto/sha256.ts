import * as Crypto from 'expo-crypto';
import { toHex } from '../../core/hex';

/** SHA-256 of the bytes as lower-case hex. Used to verify every downloaded audio chunk. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh buffer so the digest input has a concrete ArrayBuffer type.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, copy);
  return toHex(new Uint8Array(digest));
}
