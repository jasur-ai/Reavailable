const HEX_TABLE: readonly string[] = Array.from({ length: 256 }, (_, value) =>
  value.toString(16).padStart(2, '0'),
);

/** Lower-case hexadecimal representation of a byte array. */
export function toHex(bytes: Uint8Array): string {
  let output = '';
  for (const byte of bytes) {
    output += HEX_TABLE[byte];
  }
  return output;
}
