/** Token, digest and comparison helpers. */

import { describe, expect, it } from 'vitest';
import {
  constantTimeEquals,
  newAccessToken,
  newJobId,
  sha256Hex,
  toHex,
  tokenMatches,
} from '../src/security';

describe('access tokens', () => {
  it('are URL-safe, 43 characters long and unique', () => {
    const tokens = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
      const token = newAccessToken();
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      tokens.add(token);
    }
    expect(tokens.size).toBe(50);
  });

  it('honours a requested length', () => {
    expect(newAccessToken(16)).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe('job identifiers', () => {
  it('use the UUID form the API validates', () => {
    expect(newJobId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('sha256Hex', () => {
  it('matches a known digest for text', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('digests bytes, including views that do not start at offset zero', async () => {
    const whole = new Uint8Array([1, 2, 3, 4]);
    expect(await sha256Hex(whole)).toBe(await sha256Hex(whole.buffer));
    const view = whole.subarray(1);
    expect(await sha256Hex(view)).toBe(await sha256Hex(new Uint8Array([2, 3, 4])));
  });

  it('produces lowercase hex', () => {
    expect(toHex(new Uint8Array([0, 15, 255]))).toBe('000fff');
  });
});

describe('constantTimeEquals', () => {
  it('compares equal and unequal strings', () => {
    expect(constantTimeEquals('secret', 'secret')).toBe(true);
    expect(constantTimeEquals('secret', 'Secret')).toBe(false);
    expect(constantTimeEquals('secret', 'short')).toBe(false);
    expect(constantTimeEquals('', '')).toBe(true);
  });

  it('handles non-ASCII keys', () => {
    expect(constantTimeEquals('kalit-öä', 'kalit-öä')).toBe(true);
    expect(constantTimeEquals('kalit-öä', 'kalit-oa')).toBe(false);
  });
});

describe('tokenMatches', () => {
  it('accepts the token whose digest is stored and nothing else', async () => {
    const token = newAccessToken();
    const stored = await sha256Hex(token);
    expect(await tokenMatches(stored, token)).toBe(true);
    expect(await tokenMatches(stored, `${token}x`)).toBe(false);
    expect(await tokenMatches(stored, '')).toBe(false);
  });
});
