/**
 * `machineStateFor`/`readPointerValue`: stack and storage dereference through
 * the real `@ethdebug/pointers` path.
 *
 * Two pitfalls pinned here:
 *
 *   1. `Data.fromHex` misparses odd-length minimal-hex words: kontrol/lifting
 *      emit minimal-hex stack + storage words like `'0x3e8'`, and
 *      `Data.fromHex('0x3e8').asUint()` === 15880n, not 1000n. EVM words are
 *      therefore padded to a full 32-byte (64-hex) big-endian word before
 *      `Data.fromHex` (`'0x' + '3e8'.padStart(64,'0')` → asUint 1000n).
 *   2. The ethdebug reader (`read.ts`, `case "stack"`) always calls
 *      `peek({depth, slice:{offset,length}})`, so `stack.peek` must honour the
 *      slice: a value-type stack var (offset `32−N`, length N) reads its low N
 *      bytes and a `bytesN` (offset 0) its high N bytes — both taken as a byte
 *      slice from the left of the padded 32-byte word.
 */
import type {MachineState} from '@simbolik/lifting';
import {describe, expect, it} from 'vitest';

import {
  machineStateFor,
  readPointerBytes,
  readPointerRegions,
  readPointerValue,
} from '../src/machineState.js';

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

// ## 1. Odd-length stack word + slice

describe('machineStateFor — odd-length stack word read through a value-type slice', () => {
  it('reads 1000n from stack word 0x3e8 via {offset:30,length:2}', async () => {
    // Stack top is the last element; place the target word 0x3e8 at depth 2.
    //   index:  0        1      2
    //   value:  0x3e8    0x1    0x2   ← top
    //   depth:  2        1      0
    const state = makeState({stack: ['0x3e8', '0x1', '0x2']});
    const value = await readPointerValue(
      // A uint16 sits in the low 2 bytes of the word: offset 32−2 = 30, length 2.
      {location: 'stack', slot: 2, offset: 30, length: 2},
      machineStateFor(state, ADDR),
    );
    // Padded: '0x' + '3e8'.padStart(64,'0'); low 2 bytes = 0x03e8 = 1000.
    // (An unpadded Data.fromHex('0x3e8') with the slice ignored gives 15880n.)
    expect(value).toBe(1000n);
  });
});

// ## 2. Full-word stack value

describe('machineStateFor — full-word stack read', () => {
  it('reads the whole padded word from 0xabc via {offset:0,length:32}', async () => {
    const state = makeState({stack: ['0xabc']}); // single element → depth 0
    const value = await readPointerValue(
      {location: 'stack', slot: 0, offset: 0, length: 32},
      machineStateFor(state, ADDR),
    );
    // Padded: '0x' + 'abc'.padStart(64,'0') → asUint 2748.
    // (An unpadded Data.fromHex('0xabc') gives 43788n.)
    expect(value).toBe(2748n);
  });
});

// ## 3. Left-aligned bytesN stack value (high bytes)

describe('machineStateFor — left-aligned bytesN stack read', () => {
  it('reads the high 4 bytes (0x11223344) from a left-aligned word via {offset:0,length:4}', async () => {
    // bytes4 0x11223344 left-aligned in a full 32-byte word (already even-length,
    // so no padding is needed here — this case isolates slice handling).
    const word = ('0x11223344' + '0'.repeat(56)) as MachineState['stack'][number];
    const state = makeState({stack: [word]}); // depth 0
    const value = await readPointerValue(
      {location: 'stack', slot: 0, offset: 0, length: 4},
      machineStateFor(state, ADDR),
    );
    // High 4 bytes = 0x11223344 = 287454020. A peek that ignored the slice would
    // return the whole word, i.e. 0x1122334400…00.
    expect(value).toBe(0x11223344n);
  });
});

// ## 4. Odd-length storage word (padding applies to storage too)

describe('machineStateFor — odd-length storage word read', () => {
  it('reads 1000n from an odd-length storage slot value 0x3e8', async () => {
    // Pointer slot 0 → storage key '0x0' (machineStateFor: '0x' + slot.toString(16)).
    const state = storageState('0x0', '0x3e8');
    const value = await readPointerValue(
      {location: 'storage', slot: 0, offset: 0, length: 32},
      machineStateFor(state, ADDR),
    );
    // Padded slot word → asUint 1000 (unpadded: 15880n).
    expect(value).toBe(1000n);
  });
});

// ## 5. Even-length values read 42n

describe('machineStateFor — even-length words (padding is a no-op)', () => {
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

// ## Bounded reads: a misdecoded (garbage) length must fail fast, not allocate GBs

describe('machineStateFor — reads far past the end of a region are rejected', () => {
  // 64 bytes of memory: two words.
  const ms = () =>
    machineStateFor(
      makeState({memory: ['00'.repeat(32), '11'.repeat(32)]}),
      ADDR,
    );

  it('a string whose length word is garbage throws a RangeError (no huge allocation)', async () => {
    // A memory string whose length word is 100_000_000 (the handle came from a
    // reused stack slot): an unbounded reader would materialize a 200 MB string
    // per such read (and OOM on real traces), so it must be rejected.
    const big = machineStateFor(
      makeState({memory: ['00'.repeat(32), (100_000_000).toString(16).padStart(64, '0')]}),
      ADDR,
    );
    const pointer = {
      group: [
        {name: 'len', location: 'memory', offset: 32, length: 32},
        {name: 'data', location: 'memory', offset: 64, length: {$read: 'len'}},
      ],
    } as never;
    await expect(readPointerBytes(pointer, big)).rejects.toThrow(RangeError);
  });

  it('a small overhang past the end still reads as zeros (EVM semantics)', async () => {
    const pointer = {location: 'memory', offset: 32, length: 64} as never;
    const hex = await readPointerBytes(pointer, ms());
    expect(hex).toBe('0x' + '11'.repeat(32) + '00'.repeat(32));
  });

  it('an array whose length word cannot fit memory is rejected before enumerating elements', async () => {
    // A dynamic memory array handle (0x20) whose length word (memory[0x20..]) is
    // 0x1111… — ~2^252 elements, which dereferencing would try to enumerate.
    const state = machineStateFor(
      makeState({stack: ['0x20'], memory: ['00'.repeat(32), '11'.repeat(32)]}),
      ADDR,
    );
    const pointer = {
      group: [
        {name: 'base', location: 'stack', slot: 0, offset: 0, length: 32},
        {name: 'len', location: 'memory', offset: {$read: 'base'}, length: 32},
        {
          list: {
            count: {$read: 'len'},
            each: 'i',
            is: {
              name: 'element',
              location: 'memory',
              offset: {$sum: [{$read: 'base'}, 32, {$product: ['i', 32]}]},
              length: 32,
            },
          },
        },
      ],
    } as never;
    await expect(readPointerRegions(pointer, state)).rejects.toThrow(RangeError);
  });
});
