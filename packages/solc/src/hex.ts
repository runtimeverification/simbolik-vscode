import type {Hex} from '@simbolik/protocol';

/** Decode a `0x`-prefixed (or bare) hex string to bytes. */
export function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(body.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Encode bytes as a `0x`-prefixed lowercase hex string. */
export function bytesToHex(bytes: Uint8Array): Hex {
  let body = '';
  for (const b of bytes) {
    body += b.toString(16).padStart(2, '0');
  }
  return `0x${body}`;
}

/** Ensure a hex string carries the `0x` prefix (raw solc `.object` fields omit it). */
export function ensureHexPrefix(hex: string): Hex {
  return (hex.startsWith('0x') ? hex : `0x${hex}`) as Hex;
}
