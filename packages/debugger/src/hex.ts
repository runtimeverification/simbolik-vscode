/** Small hex/address formatting helpers shared across the debugger. */

/** Strip a leading `0x`, if present. */
export function strip0x(hex: string): string {
  return hex.startsWith('0x') ? hex.slice(2) : hex;
}

/**
 * Parse a machine WORD to a bigint. Kontrol emits MEMORY words WITHOUT a `0x`
 * prefix (`"0000…"`), so a bare `BigInt(word)` would parse them as DECIMAL —
 * silently wrong for any word (and throwing outright on one containing `a-f`).
 */
export function wordToBigInt(word: string): bigint {
  return BigInt(`0x${strip0x(word)}`);
}

/** Format a `bigint` EVM address as a lowercase, zero-padded hex string. */
export function addressHex(addr: bigint): string {
  return '0x' + addr.toString(16).padStart(40, '0');
}

/** Render raw `0x…` bytes as a Solidity `bytes` (hex) or `string` (quoted UTF-8). */
export function bytesDisplay(hex: string, isString: boolean): string {
  return isString
    ? `"${Buffer.from(strip0x(hex), 'hex').toString('utf8')}"`
    : `0x${strip0x(hex)}`;
}
