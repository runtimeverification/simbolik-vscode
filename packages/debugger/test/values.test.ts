/**
 * Decoder unit tests for the cases the single recorded trace cannot
 * express. The `Vars.setAll` fixture pins only full-width value types
 * (`int256`, `bytes32`) and an all-value-type signature, so these tests cover
 * the narrow widths and the calldata-word normalization directly:
 *   - two's complement across int8/int16/int128/int256 incl. boundaries;
 *   - reducing a 32-byte ABI word to the type's own bytes (fieldFromAbiWord),
 *     which is where a narrow signed / bytesN calldata param would otherwise
 *     mis-decode.
 */
import {describe, expect, it} from 'vitest';

import {decodeValue, fieldFromAbiWord} from '../src/values.js';

/** Two's complement of `value` (already masked to `bytes` low-order bytes). */
function twos(value: bigint, bytes: number): string {
  return decodeValue(value, `t_int${8 * bytes}`, bytes).value;
}

describe('decodeValue — two’s complement across widths', () => {
  it('decodes positive intN as-is', () => {
    expect(twos(5n, 1)).toBe('5'); // int8 = 5
    expect(twos(127n, 1)).toBe('127'); // int8 max
    expect(twos(1000n, 2)).toBe('1000'); // int16
  });

  it('decodes negative intN at the boundaries', () => {
    expect(twos(0x80n, 1)).toBe('-128'); // int8 min
    expect(twos(0xffn, 1)).toBe('-1'); // int8 = -1
    expect(twos(0xfffbn, 2)).toBe('-5'); // int16 = -5
    // int128 = -1 → all-ones over 16 bytes.
    expect(twos((1n << 128n) - 1n, 16)).toBe('-1');
    // int256 = -5 (the fixture's `delta`).
    expect(twos((1n << 256n) - 5n, 32)).toBe('-5');
  });

  it('carries the solc type label through', () => {
    expect(decodeValue(7n, 't_uint8', 1, {label: 'uint8'})).toEqual({
      value: '7',
      type: 'uint8',
    });
  });

  it('renders enum out-of-range gracefully (numeric fallback)', () => {
    // index 9 with only 3 member names → no crash, falls back to the index.
    expect(
      decodeValue(9n, 't_enum(Color)5', 1, {
        memberNames: ['Red', 'Green', 'Blue'],
        enumName: 'Color',
      }),
    ).toEqual({value: '9', type: 'Color'});
  });
});

describe('fieldFromAbiWord — reduce a 32-byte ABI word to the type bytes', () => {
  /** ABI right-aligns + sign-extends intN; here int8 = -5 over 32 bytes. */
  it('strips sign-extension from a narrow signed int', () => {
    const word = (1n << 256n) - 5n; // ...ff ff fb
    const field = fieldFromAbiWord(word, 't_int8', 1);
    expect(field).toBe(0xfbn);
    expect(decodeValue(field, 't_int8', 1, {label: 'int8'})).toEqual({
      value: '-5',
      type: 'int8',
    });
  });

  it('keeps a narrow unsigned int correct', () => {
    const word = 1000n; // uint16 right-aligned, high bytes zero
    expect(fieldFromAbiWord(word, 't_uint16', 2)).toBe(1000n);
  });

  it('right-shifts a left-aligned bytesN out of its zero padding', () => {
    // bytes4 = 0x11223344, ABI left-aligned in the 32-byte word.
    const word = 0x11223344n << BigInt(8 * 28);
    const field = fieldFromAbiWord(word, 't_bytes4', 4);
    expect(field).toBe(0x11223344n);
    expect(decodeValue(field, 't_bytes4', 4, {label: 'bytes4'})).toEqual({
      value: '0x11223344',
      type: 'bytes4',
    });
  });

  it('masks an address to its low 20 bytes', () => {
    // Address right-aligned; high 12 bytes are zero per the ABI.
    const word = 0xaan;
    const field = fieldFromAbiWord(word, 't_address', 20);
    expect(decodeValue(field, 't_address', 20, {label: 'address'})).toEqual({
      value: '0x00000000000000000000000000000000000000aa',
      type: 'address',
    });
  });

  it('leaves a full-width word unchanged (int256 / bytes32)', () => {
    const w = (1n << 256n) - 5n;
    expect(fieldFromAbiWord(w, 't_int256', 32)).toBe(w);
    const h = 0x1122334455667788990011223344556677889900112233445566778899001122n;
    expect(fieldFromAbiWord(h, 't_bytes32', 32)).toBe(h);
  });
});
