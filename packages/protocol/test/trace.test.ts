import {describe, expect, expectTypeOf, it} from 'vitest';
import type {KontrolStructLog} from '../src/trace.js';

describe('trace types', () => {
  it('types kontrol address/256-bit fields as bigint (lossless-parse contract)', () => {
    // A real 160-bit address from the kontrol-node example trace; far beyond
    // Number.MAX_SAFE_INTEGER, so it must be a bigint, not a number.
    const codeAddress = 546584486846459126461364135121053344201067465379n;
    expect(codeAddress > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);

    expectTypeOf<KontrolStructLog['codeAddress']>().toEqualTypeOf<bigint>();
    expectTypeOf<KontrolStructLog['msgSender']>().toEqualTypeOf<bigint>();
    expectTypeOf<KontrolStructLog['msgValue']>().toEqualTypeOf<bigint>();
    expectTypeOf<KontrolStructLog['gasCost']>().toEqualTypeOf<bigint>();
  });

  it('models delta fields as nullable/empty-able (change-only semantics)', () => {
    // memoryChange is null when unchanged, [] when empty, words[] on change.
    expectTypeOf<KontrolStructLog['memoryChange']>().toEqualTypeOf<
      `0x${string}`[] | null
    >();
    expectTypeOf<KontrolStructLog['programChange']>().toEqualTypeOf<
      `0x${string}` | null
    >();
  });
});
