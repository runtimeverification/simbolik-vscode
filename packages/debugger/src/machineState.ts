/**
 * Adapter from a `@simbolik/lifting` {@link MachineState} to the ethdebug
 * `Machine.State` interface, plus a generic single-region pointer reader.
 *
 * This is the bridge that lets `@ethdebug/pointers` dereference + read variable
 * pointers against a reconstructed EVM state. The interface is asymmetric and
 * easy to get wrong (see the per-region notes below), so it is factored out and
 * unit-tested directly.
 */
import {Data, dereference} from '@ethdebug/pointers';
import type {Machine, Pointer} from '@ethdebug/pointers';
import type {MachineState} from '@simbolik/lifting';

import {strip0x} from './hex.js';

/**
 * Pad an EVM word to a full 32-byte (64-hex) big-endian word (no `0x`).
 *
 * kontrol/lifting emit MINIMAL-hex stack + storage words (e.g. `'0x3e8'`), and
 * `Data.fromHex('0x3e8').asUint()` misparses odd-length hex (→ 15880, not 1000).
 * Left-padding to 64 hex is `asUint`-invariant for even words and corrects the
 * odd-length case, and it gives `readSlice` a full 32-byte word to slice from.
 */
function padWord(hex: string): string {
  return strip0x(hex).padStart(64, '0');
}

/**
 * Read `[offset, offset+length)` from a byte-hex string (no `0x`), right-padding
 * with zero bytes when the range runs past the end, and return it as `Data`.
 */
function readSlice(byteHex: string, offset: bigint, length: bigint): Data {
  const start = Number(offset) * 2;
  const size = Number(length) * 2;
  const slice = byteHex.slice(start, start + size).padEnd(size, '0');
  return Data.fromHex('0x' + slice);
}

/**
 * How far a read may run past the end of a byte region. Word-granular reads of
 * a region's tail legitimately overhang (and read as zeros, as in the EVM), but
 * no genuine value extends further: a string/bytes whose length word points far
 * beyond the region is a misdecoded pointer (e.g. a reused stack slot), and
 * materializing it would allocate up to gigabytes.
 */
const MAX_OVERHANG_BYTES = 1n << 16n;

/** Build a `Machine.State.Bytes` view over a fixed byte-hex string. */
function bytesRegion(byteHex: string): Machine.State.Bytes {
  const size = BigInt(byteHex.length / 2);
  return {
    length: Promise.resolve(size),
    read: async ({slice}: {slice: Machine.State.Slice}) => {
      if (slice.offset + slice.length > size + MAX_OVERHANG_BYTES) {
        throw new RangeError(
          `read of ${slice.length} bytes at ${slice.offset} exceeds the ` +
            `${size}-byte region`,
        );
      }
      return readSlice(byteHex, slice.offset, slice.length);
    },
  };
}

/**
 * Adapt a `MachineState` (from `StateCursor.at(i)`) to the ethdebug
 * `Machine.State` for `codeAddress`.
 *
 * CRITICAL interface asymmetry:
 * - `storage`/`transient` `read({slot})` take a `Data` slot → look up the
 *   account's storage word (minimal-hex keys like `"0x0"`), default `0x00`.
 * - `memory`/`calldata`/`returndata`/`code` `read({slice})` take a slice with
 *   **plain bigint** `offset`/`length` → slice the underlying byte-hex.
 * - `stack` top-of-stack is the LAST element of `stack[]`.
 */
export function machineStateFor(
  state: MachineState,
  codeAddress: string,
): Machine.State {
  // Account keys in the trace are lowercase (JSON-RPC emits lowercase
  // addresses); normalize the caller-supplied address so a checksummed
  // (mixed-case) `codeAddress` still resolves rather than silently reading 0.
  const account = state.accounts.get(codeAddress.toLowerCase());

  const words = (): Machine.State.Words => ({
    read: async ({slot}: {slot: Data}) => {
      const key = '0x' + slot.asUint().toString(16);
      // Pad to a full slot word: minimal-hex slot values (`'0x3e8'`) otherwise
      // misparse. Storage stays FULL-word — the session extracts packed fields.
      return Data.fromHex('0x' + padWord(account?.storage[key] ?? '0x00'));
    },
  });

  const memoryHex = state.memory.map(strip0x).join('');

  const adapter = {
    traceIndex: Promise.resolve(BigInt(state.index)),
    programCounter: Promise.resolve(BigInt(state.pc)),
    opcode: Promise.resolve(state.op),
    stack: {
      length: Promise.resolve(BigInt(state.stack.length)),
      // Top-of-stack is the LAST element. Pad the word to a full 32-byte word,
      // then HONOR the pointer slice (byte offset from the LEFT of the word):
      // value types read their low N bytes, `bytesN` its high N bytes. Without a
      // slice, return the whole padded word.
      peek: async ({
        depth,
        slice,
      }: {
        depth: bigint;
        slice?: Machine.State.Slice;
      }) => {
        const paddedHex = padWord(
          state.stack[state.stack.length - 1 - Number(depth)] ?? '0x00',
        );
        return slice !== undefined
          ? readSlice(paddedHex, slice.offset, slice.length)
          : Data.fromHex('0x' + paddedHex);
      },
    },
    memory: bytesRegion(memoryHex),
    storage: words(),
    transient: words(),
    calldata: bytesRegion(strip0x(state.calldata)),
    returndata: bytesRegion(strip0x(state.returnData)),
    code: bytesRegion(strip0x(state.bytecode)),
  };

  return adapter as unknown as Machine.State;
}

/**
 * Dereference `pointer` against `machineState` and decode its single region as
 * an unsigned integer.
 *
 * The machine state is passed to `dereference` (not just to `view`): STACK
 * pointers carry a `slot` = depth-from-top that the region generator adjusts by
 * `currentStackLength - initialStackLength`. Passing the state makes
 * `initialStackLength === currentStackLength` (change 0), so the caller-computed
 * `slot` is used verbatim. Storage/memory/calldata pointers ignore the stack
 * length entirely, so this is a no-op for them.
 */
export async function readPointerValue(
  pointer: Pointer,
  machineState: Machine.State,
): Promise<bigint> {
  const cursor = await dereference(pointer, {state: machineState});
  const view = await cursor.view(machineState);
  // Read the LAST region: a single-region pointer (every value-type stack/
  // storage/calldata pointer) has exactly one, so last === [0]. A `Group` that
  // computes a member's location from a named base region (a memory struct
  // member: `{$read: 'base'}` reads the struct's memory offset out of its stack
  // slot) yields the named base region(s) FIRST and the addressed value region
  // LAST — so the value we want is always the final region.
  const region = view.regions[view.regions.length - 1]!;
  const data = await view.read(region);
  return data.asUint();
}

/**
 * Dereference `pointer` (a `List`) against `machineState` and read every
 * element region NAMED `'element'`, in order, as an unsigned integer.
 *
 * A dynamic memory ARRAY is emitted as a `Group` wrapping a `List` whose
 * per-element regions are named `'element'` (see `arrayLayout` in
 * `@simbolik/ethdebug-gen`): the count is read from memory at dereference, so the
 * returned array has one value per element. Unlike {@link readPointerValue} (a
 * single last-region read), this collects the whole collection.
 */
export async function readPointerRegions(
  pointer: Pointer,
  machineState: Machine.State,
): Promise<bigint[]> {
  await assertListCountsFit(pointer, machineState);
  const cursor = await dereference(pointer, {state: machineState});
  const view = await cursor.view(machineState);
  const values: bigint[] = [];
  for (const region of view.regions.named('element')) {
    values.push((await view.read(region)).asUint());
  }
  return values;
}

/**
 * Reject a `Group` whose `List` count is read from state (`count: {$read: n}`,
 * e.g. a dynamic memory array's length word) when that count cannot fit the
 * element region's byte area. Dereferencing enumerates EVERY element region
 * eagerly, so a misdecoded length (a reused stack slot pointing at arbitrary
 * memory) would otherwise try to build ~2^255 regions and exhaust the heap.
 */
async function assertListCountsFit(
  pointer: Pointer,
  machineState: Machine.State,
): Promise<void> {
  if (typeof pointer !== 'object' || pointer === null || !('group' in pointer)) {
    return;
  }
  const members = pointer.group as unknown[];
  const isList = (p: unknown): p is {list: {count: unknown; is: unknown}} =>
    typeof p === 'object' && p !== null && 'list' in p;
  const lists = members.filter(isList).filter((p) => {
    const c = p.list.count;
    return typeof c === 'object' && c !== null && '$read' in c;
  });
  if (lists.length === 0) return;
  const head = {group: members.filter((p) => !isList(p))} as Pointer;
  const view = await (await dereference(head, {state: machineState})).view(
    machineState,
  );
  for (const {list} of lists) {
    const name = (list.count as {$read: string}).$read;
    const region = view.regions.named(name)[0];
    if (region === undefined) continue;
    const count = (await view.read(region)).asUint();
    const is = list.is as {location?: string; length?: unknown};
    const regionKey = is.location as keyof Machine.State | undefined;
    const target = regionKey === undefined ? undefined : machineState[regionKey];
    if (
      target === undefined ||
      typeof target !== 'object' ||
      !('length' in target) ||
      typeof is.length !== 'number'
    ) {
      continue;
    }
    const size = await (target as Machine.State.Bytes).length;
    if (count * BigInt(is.length) > size + MAX_OVERHANG_BYTES) {
      throw new RangeError(
        `collection length ${count} exceeds the ${size}-byte ${String(regionKey)} region`,
      );
    }
  }
}

/**
 * Read `count` consecutive FULL storage words starting at `baseSlot` (word `i` at
 * `baseSlot + i`), each as a big-endian `bigint`. Reuses the same
 * full-word storage-read path as {@link readPointerValue} (via a scalar storage
 * pointer per word), so kontrol/lifting's minimal-hex slot words are padded/parsed
 * identically. Used to gather the long-form data words of a dynamic storage
 * string/bytes, whose base slot is the producer's static `keccak256(pad32(slot))`.
 */
export async function readStorageWords(
  baseSlot: bigint,
  count: number,
  machineState: Machine.State,
): Promise<bigint[]> {
  const words: bigint[] = [];
  for (let i = 0; i < count; i++) {
    const region = await machineState.storage.read({
      slot: Data.fromUint(baseSlot + BigInt(i)),
    });
    words.push(region.asUint());
  }
  return words;
}

/**
 * Dereference `pointer` (a memory string/bytes `Group`) and read its
 * FINAL region as raw bytes, returned as a `0x`-prefixed hex string.
 *
 * The string/bytes layout (see `bytesLayout` in `@simbolik/ethdebug-gen`) puts
 * the raw byte string LAST, with a dynamic length read from memory. This does NOT
 * route through {@link readPointerValue} (an `asUint` read would mangle the byte
 * order); the caller decodes the hex (UTF-8 for strings, `0x…` for bytes).
 */
export async function readPointerBytes(
  pointer: Pointer,
  machineState: Machine.State,
): Promise<string> {
  const cursor = await dereference(pointer, {state: machineState});
  const view = await cursor.view(machineState);
  const region = view.regions[view.regions.length - 1]!;
  return (await view.read(region)).toHex();
}
