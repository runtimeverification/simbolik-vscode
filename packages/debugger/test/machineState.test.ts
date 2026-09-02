/**
 * `machineStateFor`/`readPointerValue` STACK + storage dereference fix.
 *
 * These tests drive out two production bugs that block routing stack pointers
 * through the real `@ethdebug/pointers` path:
 *
 *   1. `Data.fromHex` MISPARSES odd-length minimal-hex words: kontrol/lifting
 *      emit minimal-hex stack + storage words like `'0x3e8'`, and
 *      `Data.fromHex('0x3e8').asUint()` === 15880n, NOT 1000n. The fix pads EVM
 *      words to a full 32-byte (64-hex) big-endian word before `Data.fromHex`
 *      (`'0x' + '3e8'.padStart(64,'0')` → asUint 1000n).
 *   2. `stack.peek({depth, slice})` currently IGNORES the pointer's `slice` and
 *      returns the whole word. The ethdebug reader (`read.ts`, `case "stack"`)
 *      ALWAYS calls `peek({depth, slice:{offset,length}})`, so a value-type stack
 *      var (offset `32−N`, length N) must read its LOW N bytes and a `bytesN`
 *      (offset 0) its HIGH N bytes — both taken as a byte slice from the LEFT of
 *      the padded 32-byte word.
 *
 * Each case verifies the fix reads the correct value:
 *   - odd-length + slice reads 1000n (the pre-fix bug read 15880n)
 *   - full word `'0xabc'` reads 2748n (pre-fix 43788n)
 *   - left-aligned bytes4 reads the high 4 bytes (pre-fix the whole word)
 *   - odd-length storage word reads 1000n (pre-fix 15880n)
 * The even-length regression cases (42n) stay green.
 */
import type {MachineState} from '@simbolik/lifting';
import {describe, expect, it} from 'vitest';

import {machineStateFor, readPointerValue} from '../src/machineState.js';

// The code address the reconstructed state is read for. Account keys in a real
// trace are lowercase; `machineStateFor` lowercases the lookup, so this resolves.
const ADDR = '0x00000000000000000000000000000000000000aa';

/**
 * Build a `MachineState` with only the fields `machineStateFor` reads; the rest
 * are filled with inert defaults so the object satisfies the full interface.
 */
function makeState(overrides: Partial<MachineState>): MachineState {
  return {
    index: 0,
    pc: 0,
    op: 'STOP',
    depth: 0,
    gas: 0,
    stack: [],
    memory: [],
    bytecode: '0x',
    calldata: '0x',
    returnData: '0x',
    accounts: new Map(),
    isTerminal: false,
    ...overrides,
  } as MachineState;
}

/** A state whose account at {@link ADDR} has `storage[slotKey] === value`. */
function storageState(slotKey: string, value: string): MachineState {
  return makeState({
    accounts: new Map([
      [ADDR, {address: ADDR, storage: {[slotKey]: value}}],
    ]) as MachineState['accounts'],
  });
}

// ---------------------------------------------------------------------------
// 1. Odd-length stack word + slice — THE discriminator
// ---------------------------------------------------------------------------

describe('machineStateFor — odd-length stack word read through a value-type slice', () => {
  it('reads 1000n from stack word 0x3e8 via {offset:30,length:2}', async () => {
    // Stack top is the LAST element; place the target word 0x3e8 at depth 2.
    //   index:  0        1      2
    //   value:  0x3e8    0x1    0x2   ← top
    //   depth:  2        1      0
    const state = makeState({stack: ['0x3e8', '0x1', '0x2']});
    const value = await readPointerValue(
      // A uint16 sits in the LOW 2 bytes of the word: offset 32−2 = 30, length 2.
      {location: 'stack', slot: 2, offset: 30, length: 2},
      machineStateFor(state, ADDR),
    );
    // Padded: '0x' + '3e8'.padStart(64,'0'); low 2 bytes = 0x03e8 = 1000.
    // Pre-fix this is 15880n (Data.fromHex('0x3e8') misparse + ignored slice).
    expect(value).toBe(1000n);
  });
});

// ---------------------------------------------------------------------------
// 2. Full-word stack value
// ---------------------------------------------------------------------------

describe('machineStateFor — full-word stack read', () => {
  it('reads the whole padded word from 0xabc via {offset:0,length:32}', async () => {
    const state = makeState({stack: ['0xabc']}); // single element → depth 0
    const value = await readPointerValue(
      {location: 'stack', slot: 0, offset: 0, length: 32},
      machineStateFor(state, ADDR),
    );
    // Padded: '0x' + 'abc'.padStart(64,'0') → asUint 2748.
    // Pre-fix this is 43788n (Data.fromHex('0xabc') misparse).
    expect(value).toBe(2748n);
  });
});

// ---------------------------------------------------------------------------
// 3. Left-aligned bytesN stack value (high bytes)
// ---------------------------------------------------------------------------

describe('machineStateFor — left-aligned bytesN stack read', () => {
  it('reads the HIGH 4 bytes (0x11223344) from a left-aligned word via {offset:0,length:4}', async () => {
    // bytes4 0x11223344 left-aligned in a full 32-byte word (already even-length,
    // so no padding is needed here — this case isolates the ignored-slice bug).
    const word = ('0x11223344' + '0'.repeat(56)) as MachineState['stack'][number];
    const state = makeState({stack: [word]}); // depth 0
    const value = await readPointerValue(
      {location: 'stack', slot: 0, offset: 0, length: 4},
      machineStateFor(state, ADDR),
    );
    // High 4 bytes = 0x11223344 = 287454020.
    // Pre-fix: peek ignores the slice and returns the WHOLE word, so asUint is
    // the enormous 0x1122334400…00 instead of 0x11223344.
    expect(value).toBe(0x11223344n);
  });
});

// ---------------------------------------------------------------------------
// 4. Odd-length storage word (padding fix applies to storage too)
// ---------------------------------------------------------------------------

describe('machineStateFor — odd-length storage word read', () => {
  it('reads 1000n from an odd-length storage slot value 0x3e8', async () => {
    // Pointer slot 0 → storage key '0x0' (machineStateFor: '0x' + slot.toString(16)).
    const state = storageState('0x0', '0x3e8');
    const value = await readPointerValue(
      {location: 'storage', slot: 0, offset: 0, length: 32},
      machineStateFor(state, ADDR),
    );
    // Padded slot word → asUint 1000. Pre-fix: 15880n (odd-length misparse).
    expect(value).toBe(1000n);
  });
});

// ---------------------------------------------------------------------------
// 5. Regression — even-length values still read 42n (green today AND post-fix)
// ---------------------------------------------------------------------------

describe('machineStateFor — even-length regression (padding is a no-op)', () => {
  it('reads 42n from an even-length stack word 0x2a', async () => {
    const state = makeState({stack: ['0x2a']}); // depth 0
    const value = await readPointerValue(
      {location: 'stack', slot: 0, offset: 30, length: 2},
      machineStateFor(state, ADDR),
    );
    expect(value).toBe(42n);
  });

  it('reads 42n from an even-length storage word 0x2a', async () => {
    const state = storageState('0x0', '0x2a');
    const value = await readPointerValue(
      {location: 'storage', slot: 0, offset: 0, length: 32},
      machineStateFor(state, ADDR),
    );
    expect(value).toBe(42n);
  });
});
