/**
 * Reference-type layouts: the shapes the producer attaches to a variable whose
 * value is not a single stack/storage word, plus the builders for the memory
 * layouts reached through a stack slot. Every layout carries concrete ethdebug
 * pointers; `@ethdebug/pointers` resolves their `$read`/`$sum`/`$product`
 * expressions against the machine state at dereference.
 */
import type {Pointer} from '@ethdebug/pointers';
import type {CompilationUnit} from '@simbolik/solc';

import {describeValueTypeString} from './valueTypes.js';

/**
 * One value-type member of a reference-type variable (a memory struct),
 * with a concrete ethdebug pointer that resolves the member's bytes at
 * dereference time (a `Group` whose value region reads the struct's runtime
 * memory offset out of the parent's stack slot).
 */
export interface StructMember {
  name: string;
  /** Solidity type string for display, e.g. `uint256`. */
  typeLabel: string;
  /** solc storage-style type id, e.g. `t_uint256` (empty for references). */
  solcType: string;
  numberOfBytes: number;
  /** Concrete member pointer, ready to dereference (value-type members only). */
  pointer?: Pointer;
}

/**
 * For a memory array variable, its element layout. The array's stack slot
 * holds the array's memory offset; `pointer` is a dereferenceable `List`
 * (wrapped in a `Group` that first names `base` = the stack slot and, for a
 * dynamic array, `len` = the memory word at `base` = the element count) whose
 * per-element regions are named `'element'` (index order). The consumer
 * collects the values via `regions.named('element')`. The variable itself stays
 * `isValueType:false` with no top-level pointer and no `members`.
 */
export interface ArrayLayout {
  /** Concrete pointer, ready to dereference (element regions = `'element'`). */
  pointer: Pointer;
  /** solc storage-style element type id, e.g. `t_uint256`. */
  elementSolcType: string;
  /** Solidity element type string for display, e.g. `uint256`. */
  elementTypeLabel: string;
  /** Element size in bytes (1..32). */
  elementNumberOfBytes: number;
  /**
   * For an array of dynamic-bytes elements (`bytes[]` / `string[]`), each
   * `'element'` region is not a value word but the element's memory offset; the
   * consumer dereferences it as a raw byte string via
   * {@link bytesLayoutAtMemoryOffset} (`isString` selects UTF-8 vs `0x…`).
   * Absent for value-type element arrays (the `'element'` word is the value).
   */
  elementBytes?: {isString: boolean};
}

/**
 * For a memory string / bytes variable, its raw-byte layout. The stack slot
 * holds the memory offset; `pointer` is a `Group` (named `base` = the stack
 * slot, `len` = the memory word at `base` = the byte length) whose final region
 * is the raw byte string (dynamic `length: {$read:'len'}` at `base+32`). The
 * consumer reads the final region as bytes and decodes it (string → UTF-8,
 * bytes → hex).
 */
export interface BytesLayout {
  /** Concrete `Group` pointer whose final region is the raw bytes. */
  pointer: Pointer;
  /** True for `string` (UTF-8 decode); false for `bytes` (hex). */
  isString: boolean;
}

/**
 * For a storage `string`/`bytes` variable, the layout facts a consumer needs to
 * pick the short or long encoding by parity. `flagPointer` addresses the base
 * slot's full 32-byte word (high bytes = inline short data, low byte =
 * length*2 with the parity bit); `longBaseSlot` is the `keccak256(pad32(slot))`
 * base of the long-form data words, computed statically (no runtime
 * `$keccak256`); `isString` selects UTF-8 vs `0x…` rendering.
 */
export interface BytesStorageLayout {
  /** Storage pointer at the base slot's full 32-byte word. */
  flagPointer: Pointer;
  /** keccak256(pad32(slot)): the base slot of the long-form data words. */
  longBaseSlot: string;
  /** True for `string` (UTF-8 decode); false for `bytes` (hex). */
  isString: boolean;
}

/** For a `mapping` storage variable, its static layout facts. */
export interface MappingLayout {
  baseSlot: number;
  keyType: string;
  valueType: string;
}

// ## Memory layouts behind a stack slot

/** The stack slot at `depth`, named `base`; its value is a memory offset. */
function stackBase(depth: number): Pointer.Region {
  return {name: 'base', location: 'stack', slot: depth, offset: 0, length: 32};
}

/** The memory word at `base`, named `len` (a length / element count). */
function lenAtBase(): Pointer.Region {
  return {name: 'len', location: 'memory', offset: {$read: 'base'}, length: 32};
}

/**
 * The reference-type layout of a memory variable of structural type `solcType`
 * whose memory offset sits in the stack slot at `depth` (a memory struct →
 * `members`; a memory array → `array`; a memory string/bytes → `bytes`), or
 * `{}` when the type has no supported layout. Only memory types (the solc
 * typeIdentifier carries the data location, e.g.
 * `t_struct$_Point_$10_memory_ptr`) are expanded: a storage or calldata
 * reference holds a storage slot / calldata offset in its stack slot, not a
 * memory offset, so it is left without a layout rather than mis-decoded.
 */
export function memoryReferenceLayout(
  cu: CompilationUnit,
  solcType: string,
  typeLabel: string,
  depth: number
): {members?: StructMember[]; array?: ArrayLayout; bytes?: BytesLayout} {
  if (!solcType.includes('_memory')) return {};
  if (solcType.startsWith('t_struct')) {
    const members = structMemberPointers(cu, solcType, depth);
    return members.length > 0 ? {members} : {};
  }
  if (solcType.startsWith('t_array')) {
    const array = arrayLayout(solcType, typeLabel, depth);
    return array !== undefined ? {array} : {};
  }
  if (solcType.startsWith('t_string') || solcType.startsWith('t_bytes_')) {
    return {bytes: bytesLayout(solcType.startsWith('t_string'), depth)};
  }
  return {};
}

/**
 * The value-type members of a memory struct, each with a concrete ethdebug
 * pointer. The struct's memory offset lives in the local's stack slot at
 * `depth`; member k (a value type of `N` bytes) sits at memory word k of the
 * struct. Each member pointer is a `Group`:
 *   - a `base` region over the stack slot, whose value is the struct's memory
 *     offset;
 *   - a memory value region at `{$sum:[{$read:'base'}, k*32 + inWord]}` of
 *     length `N`, where `inWord` right-aligns non-`bytesN` value types within
 *     the word (`32 − N`; `bytesN` are left-aligned so `inWord = 0`).
 * Reference-type members are listed without a pointer.
 */
function structMemberPointers(
  cu: CompilationUnit,
  structSolcType: string,
  depth: number
): StructMember[] {
  return cu.structMembers(structSolcType).map((m, k) => {
    const desc = describeValueTypeString(m.typeString);
    if (desc === undefined) {
      // Reference-type member (nested struct / array / string): unsupported.
      return {
        name: m.name,
        typeLabel: m.typeString,
        solcType: '',
        numberOfBytes: 0,
      };
    }
    const n = desc.numberOfBytes;
    const inWord = desc.typeId.startsWith('t_bytes') ? 0 : 32 - n;
    return {
      name: m.name,
      typeLabel: m.typeString,
      solcType: desc.typeId,
      numberOfBytes: n,
      pointer: {
        group: [
          stackBase(depth),
          {
            location: 'memory',
            offset: {$sum: [{$read: 'base'}, k * 32 + inWord]},
            length: n,
          },
        ],
      },
    };
  });
}

/**
 * The `List` layout of a memory array of value-type elements. The array's
 * memory offset lives in the local's stack slot at `depth`. For a dynamic
 * array the element count is the memory word at that offset, and element `i`
 * sits at `offset + 32 + i*32`. The pointer is a `Group`:
 *   - `base`: the stack slot (its value is the array's memory offset);
 *   - `len`: the memory word at `base` (the element count);
 *   - a `List` of `count:{$read:'len'}` regions named `'element'`, each a
 *     32-byte memory word at `{$sum:[{$read:'base'}, 32, {$product:['i', 32]}]}`.
 * Returns `undefined` for a non-value-type element, except dynamic-bytes
 * elements (`bytes[]`/`string[]`), whose element words are memory offsets (see
 * {@link ArrayLayout.elementBytes}).
 *
 * A fixed-size memory `T[N]` (`t_array$_…_$<N>_memory_ptr`) has no length
 * word: the stack slot points directly at element 0, so element `i` sits at
 * `base + i*32` and the count is the static `N`. Its pointer drops the `len`
 * region and the leading `+32`.
 */
function arrayLayout(
  arraySolcType: string,
  arrayTypeLabel: string,
  depth: number
): ArrayLayout | undefined {
  // Dynamic or fixed memory arrays: `t_array$_<elemId>_$(dyn|<N>)_memory_ptr`.
  const m = /^t_array\$_(.+)_\$(dyn|\d+)_memory_ptr$/.exec(arraySolcType);
  if (m === null) return undefined;
  const elementId = m[1]!;
  const sizeToken = m[2]!;
  // Element type/size from the array's display label (`uint256[]` → `uint256`),
  // reusing the value-type describer so `elementSolcType` matches the
  // value-decode path.
  const elementTypeLabel = arrayTypeLabel
    .replace(/\[\d*\]\s*(memory|calldata|storage)?\s*$/, '')
    .trim();
  const desc = describeValueTypeString(elementTypeLabel);
  // A dynamic-bytes element (`bytes[]` / `string[]`): each element slot holds a
  // memory offset to the element's bytes, so the value describer returns
  // nothing. Other reference-type elements (nested structs/arrays) are
  // unsupported.
  const bytesElement = /^t_(bytes|string)_memory_ptr$/.exec(elementId);
  if (desc === undefined && bytesElement === null) return undefined;

  // The element `List` reads each element's 32-byte word. For value-type
  // elements that word is the value; for bytes/string elements it is the memory
  // offset the consumer dereferences.
  const elements = (
    count: Pointer.Expression,
    offset: Pointer.Expression
  ): Pointer => ({
    list: {
      count,
      each: 'i',
      is: {name: 'element', location: 'memory', offset, length: 32},
    },
  });
  const pointer: Pointer =
    sizeToken === 'dyn'
      ? {
          group: [
            stackBase(depth),
            lenAtBase(),
            elements(
              {$read: 'len'},
              {$sum: [{$read: 'base'}, 32, {$product: ['i', 32]}]}
            ),
          ],
        }
      : {
          // Fixed `T[N]`: no `len` region, static count, element i at base + i*32.
          group: [
            stackBase(depth),
            elements(Number(sizeToken), {
              $sum: [{$read: 'base'}, {$product: ['i', 32]}],
            }),
          ],
        };
  if (desc === undefined) {
    // bytes/string element array: element regions are memory offsets.
    return {
      pointer,
      elementSolcType: elementId,
      elementTypeLabel,
      elementNumberOfBytes: 32,
      elementBytes: {isString: bytesElement![1] === 'string'},
    };
  }
  return {
    pointer,
    elementSolcType: desc.typeId,
    elementTypeLabel,
    elementNumberOfBytes: desc.numberOfBytes,
  };
}

/**
 * The raw-byte layout of a memory string/bytes. The memory offset lives
 * in the local's stack slot at `depth`; the byte length is the memory word at
 * that offset, and the raw bytes follow at `offset + 32`. The pointer is a
 * `Group`:
 *   - `base`: the stack slot (the memory offset);
 *   - `len`: the memory word at `base` (the byte length);
 *   - a raw byte region of dynamic `length:{$read:'len'}` at `{$sum:[{$read:
 *     'base'}, 32]}`: the final region, which the consumer reads as bytes.
 */
function bytesLayout(isString: boolean, depth: number): BytesLayout {
  const pointer: Pointer = {
    group: [
      stackBase(depth),
      lenAtBase(),
      {
        location: 'memory',
        offset: {$sum: [{$read: 'base'}, 32]},
        length: {$read: 'len'},
      },
    ],
  };
  return {pointer, isString};
}

/**
 * The raw-byte layout of a memory string/bytes whose data lives at a known
 * absolute memory offset (rather than behind a stack slot). Used for each
 * element of a `bytes[]`/`string[]`: the array's element word is the element's
 * memory offset, resolved at render time, so this takes the concrete offset
 * directly. The byte length is the memory word at `memOffset`; the raw bytes
 * follow at `memOffset + 32` (the final region, read as bytes).
 */
export function bytesLayoutAtMemoryOffset(
  memOffset: number,
  isString: boolean
): BytesLayout {
  const pointer: Pointer = {
    group: [
      {name: 'len', location: 'memory', offset: memOffset, length: 32},
      {
        location: 'memory',
        offset: memOffset + 32,
        length: {$read: 'len'},
      },
    ],
  };
  return {pointer, isString};
}
