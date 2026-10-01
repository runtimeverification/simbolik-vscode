/**
 * Recover the observed keys of a storage mapping from an execution
 * trace, and compute each entry's value slot.
 *
 * Mapping keys are not enumerable from the storage layout (only the base slot is
 * static). Solidity computes a mapping entry slot as `keccak256(key32 ‖ slot32)`,
 * so every touched entry leaves a `KECCAK256`/`SHA3` op whose 64-byte memory
 * preimage is `key(32) ‖ baseSlot(32)`. Scanning those ops recovers the keys.
 */
import {keccak256} from 'ethereum-cryptography/keccak';
import {bytesToHex, hexToBytes} from 'ethereum-cryptography/utils';

import type {StateCursor, Step} from '@simbolik/lifting';

import {wordToBigInt} from './hex.js';

/** keccak op names across nodes: kontrol emits `SHA3`, geth/anvil `KECCAK256`. */
const KECCAK_OPS = new Set(['SHA3', 'KECCAK256']);

/** The size (in bytes) of a mapping-entry keccak preimage: `key32 ‖ slot32`. */
const PREIMAGE_SIZE = 0x40n;

/** Left-pad a bigint to a 32-byte (64-hex) big-endian word (no `0x`). */
function pad32(n: bigint): string {
  return n.toString(16).padStart(64, '0');
}

/**
 * The storage slot of `mapping[key]` at `baseSlot`:
 * `keccak256(pad32(key) ‖ pad32(baseSlot))` (key then slot, 64 bytes).
 */
export function mappingValueSlot(key: bigint, baseSlot: bigint): bigint {
  const preimage = hexToBytes(pad32(key) + pad32(baseSlot));
  return BigInt('0x' + bytesToHex(keccak256(preimage)));
}

/**
 * Enumerate the observed keys of the mapping at `baseSlot`, scanning every
 * `KECCAK256`/`SHA3` op at trace `index <= uptoStepIndex` whose 64-byte memory
 * preimage is `key ‖ baseSlot`. De-duplicated, in first-seen order.
 *
 * The op's operands come from the stack (top-of-stack last): `offset =
 * stack[len-1]`, `size = stack[len-2]`; only size `0x40` hashes are
 * mapping-entry preimages. The preimage's two words are read from the folded
 * memory at that step (`cursor.at(index).memory`, an array of 32-byte word hex
 * strings) — `word0` is the key, `word1` the slot. Bounded by `uptoStepIndex`
 * so a key first touched later never appears at an earlier step.
 */
export function enumerateMappingKeys(
  steps: Step[],
  cursor: StateCursor,
  baseSlot: number,
  uptoStepIndex: number,
): bigint[] {
  const base = BigInt(baseSlot);
  const keys: bigint[] = [];
  const seen = new Set<bigint>();
  const last = Math.min(uptoStepIndex, steps.length - 1);
  for (let index = 0; index <= last; index++) {
    const step = steps[index]!;
    if (!KECCAK_OPS.has(step.op)) continue;
    const len = step.stack.length;
    if (len < 2) continue;
    const size = BigInt(step.stack[len - 2]!);
    if (size !== PREIMAGE_SIZE) continue;
    const offset = Number(BigInt(step.stack[len - 1]!));
    // Memory is an array of 32-byte words. A non-32-aligned offset is not a
    // mapping-entry preimage layout.
    if (offset % 32 !== 0) continue;
    const memory = cursor.at(index).memory;
    const wordIndex = offset / 32;
    const word0 = memory[wordIndex];
    const word1 = memory[wordIndex + 1];
    if (word0 === undefined || word1 === undefined) continue;
    if (wordToBigInt(word1) !== base) continue;
    const key = wordToBigInt(word0);
    if (!seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  }
  return keys;
}
