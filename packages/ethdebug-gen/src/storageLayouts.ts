/**
 * Reference-type LAYOUTS of STORAGE (state) variables, derived from the solc
 * storage layout. All emitters are FAIL-CLOSED: they only attach layout for the
 * cases the shared render path decodes CORRECTLY (a value element/member
 * occupying its own full slot). Sub-word-PACKED elements/members and
 * reference-type elements/members are left as a scalar-slot gap rather than
 * silently mis-decoded — see the guards below.
 */
import type {Pointer} from '@ethdebug/pointers';
import type {Contract, StorageType} from '@simbolik/solc';
import {keccak256} from 'ethereum-cryptography/keccak';
import {bytesToHex, hexToBytes} from 'ethereum-cryptography/utils';

import type {
  ArrayLayout,
  BytesStorageLayout,
  MappingLayout,
  StructMember,
} from './layouts.js';

/** The reference layout attached to one storage variable (at most one field). */
export interface StorageReferenceLayout {
  array?: ArrayLayout;
  members?: StructMember[];
  bytesStorage?: BytesStorageLayout;
  mapping?: MappingLayout;
}

type StorageMember = NonNullable<StorageType['members']>[number];

/**
 * The reference layout of the storage variable of solc type id `typeId`
 * (resolved to `type`) at `slot`; `{}` for value types and unsupported shapes.
 */
export function storageReferenceLayout(
  contract: Contract,
  slot: number,
  typeId: string,
  type: StorageType
): StorageReferenceLayout {
  if (type.encoding === 'dynamic_array' && type.base !== undefined) {
    const array = storageArrayLayout(contract, slot, type.base);
    return array !== undefined ? {array} : {};
  }
  if (type.encoding === 'inplace' && type.base !== undefined) {
    // A FIXED-size storage array `T[N]`: inline at consecutive slots from the
    // declared slot (NO keccak, NO length word). Checked before the struct
    // branch (`members`), which shares the `inplace` encoding.
    const array = fixedStorageArrayLayout(
      contract,
      slot,
      type.base,
      type.numberOfBytes
    );
    return array !== undefined ? {array} : {};
  }
  if (type.encoding === 'inplace' && type.members !== undefined) {
    return unpackedValueStruct(type.members)
      ? {members: storageStructMembers(contract, slot, type.members)}
      : {};
  }
  if (type.encoding === 'bytes') {
    // A dynamic string/bytes storage var. Its runtime encoding (short
    // inline vs long keccak-based) is chosen by LENGTH — a fact ethdebug
    // expressions cannot branch on — so the producer supplies only the LAYOUT
    // facts (the flag word + the STATIC keccak base) and the session parity-
    // selects the decode. The keccak base is static (the slot is known at gen
    // time), so it is computed CONCRETELY here.
    return {bytesStorage: storageBytesLayout(slot, typeId)};
  }
  if (
    type.encoding === 'mapping' &&
    type.key !== undefined &&
    type.value !== undefined
  ) {
    // A mapping storage var. Keys are not statically enumerable, so
    // the producer records only the STATIC facts (base slot + key/value type
    // ids); the debugger recovers observed keys from the trace and computes
    // each entry slot as keccak256(key ‖ baseSlot).
    return {
      mapping: {baseSlot: slot, keyType: type.key, valueType: type.value},
    };
  }
  return {};
}

/**
 * The element facts of a storage array of `baseTypeId` elements, or `undefined`
 * unless each element is a VALUE type occupying its OWN full slot — the only
 * case the `slot + i`-style layouts below hold for. That excludes:
 *   - a sub-word-PACKED element (`numberOfBytes <= 16`, e.g. `uint8[]`/`uint128[]`/
 *     `bool[]`): solc packs several per slot, so `+i` would read the WRONG slot;
 *   - a REFERENCE-type element (`uint256[][]`, `struct[]`): the element slot would
 *     be decoded as a scalar. Both are deferred (scalar-slot gap, not mis-decoded).
 */
function fullSlotValueElement(
  contract: Contract,
  baseTypeId: string
): Omit<ArrayLayout, 'pointer'> | undefined {
  const baseType = contract.storageType(baseTypeId);
  const elementNumberOfBytes = baseType?.numberOfBytes ?? 32;
  if (!isValueTypeId(baseTypeId) || elementNumberOfBytes <= 16) {
    return undefined;
  }
  return {
    elementSolcType: baseTypeId,
    elementTypeLabel: baseType?.label ?? baseTypeId,
    elementNumberOfBytes,
  };
}

/** A `List` of `count` full-slot storage regions NAMED `'element'` at `slot`. */
function storageElements(
  count: Pointer.Expression,
  slot: Pointer.Expression
): Pointer {
  return {
    list: {
      count,
      each: 'i',
      is: {name: 'element', location: 'storage', slot, offset: 0, length: 32},
    },
  };
}

/**
 * The `List` layout of a DYNAMIC STORAGE array of VALUE-TYPE elements.
 * The length lives in the base slot `p`; element `i` lives at `keccak256(p) + i`
 * (storage is WORD-indexed → `+i`, NOT `+i*32`), each occupying one full slot.
 * The pointer is a `Group`:
 *   - `len` — the base slot word (the element count);
 *   - a `List` of `count:{$read:'len'}` regions NAMED `'element'`, each a full
 *     slot at `{$sum:[{$keccak256:[<p as a padded 32-byte hex word>]}, 'i']}`.
 * CRITICAL: the `$keccak256` operand MUST be the padded 32-byte-word hex string
 * (`"0x"+p.toString(16).padStart(64,"0")`) — a bare number / minimal hex hashes
 * to the wrong (zero) slot. See {@link fullSlotValueElement} for the scope guard.
 */
function storageArrayLayout(
  contract: Contract,
  slot: number,
  baseTypeId: string
): ArrayLayout | undefined {
  const element = fullSlotValueElement(contract, baseTypeId);
  if (element === undefined) return undefined;
  const paddedSlot = '0x' + slot.toString(16).padStart(64, '0');
  const pointer: Pointer = {
    group: [
      {name: 'len', location: 'storage', slot, offset: 0, length: 32},
      storageElements(
        {$read: 'len'},
        {$sum: [{$keccak256: [paddedSlot]}, 'i']}
      ),
    ],
  };
  return {pointer, ...element};
}

/**
 * The `List` layout of a FIXED-size STORAGE array of VALUE-TYPE elements
 * (`T[N]`, `encoding: 'inplace'`). Unlike a dynamic array, a fixed array is stored
 * INLINE at consecutive slots from the declared slot — NO length word, NO keccak.
 * Element `i` lives at `slot + i` (storage is WORD-indexed), each occupying one
 * full slot, and the count `N` is STATIC (`numberOfBytes / 32`). The pointer is a
 * `Group` with a single `List` of `count: N` regions NAMED `'element'`. Same scope
 * guard as the dynamic path ({@link fullSlotValueElement}).
 */
function fixedStorageArrayLayout(
  contract: Contract,
  slot: number,
  baseTypeId: string,
  numberOfBytes: number
): ArrayLayout | undefined {
  const element = fullSlotValueElement(contract, baseTypeId);
  if (element === undefined) return undefined;
  const count = Math.floor(Number(numberOfBytes) / 32);
  const pointer: Pointer = {
    group: [storageElements(count, {$sum: [slot, 'i']})],
  };
  return {pointer, ...element};
}

/**
 * The layout of a dynamic-`bytes`-encoded (`string`/`bytes`) STORAGE var.
 * Solidity stores such a var in a length/parity-flagged base slot:
 *   - SHORT (data < 32 bytes): the data is stored INLINE in the base slot's HIGH
 *     bytes, with `length*2` in the LOW byte (even low byte);
 *   - LONG (data >= 32 bytes): the base slot holds `length*2+1` (odd low byte) and
 *     the data lives in consecutive words starting at `keccak256(pad32(slot))`.
 * The producer emits both the flag-word pointer AND the CONCRETE long-data base
 * slot (the slot is static, so its keccak is computed here — no runtime `$keccak256`
 * needed); the session parity-selects at read time. `isString` selects UTF-8 vs
 * `0x…` hex rendering.
 */
function storageBytesLayout(
  slot: number,
  solcType: string
): BytesStorageLayout {
  const preimage = hexToBytes(slot.toString(16).padStart(64, '0'));
  const longBaseSlot = '0x' + bytesToHex(keccak256(preimage));
  return {
    flagPointer: {location: 'storage', slot, offset: 0, length: 32},
    longBaseSlot,
    isString: solcType.startsWith('t_string'),
  };
}

/**
 * True for the solc storage-style type ids that are VALUE types (decoded as a flat
 * slot fragment). Close to `isValueSolcType` in `variables.ts`, but that one
 * matches only the bare `t_contract` id, while storage-layout ids carry the
 * contract name (`t_contract(Foo)12`) — hence the prefix match here.
 */
function isValueTypeId(typeId: string): boolean {
  return (
    typeId === 't_bool' ||
    typeId === 't_address' ||
    typeId.startsWith('t_contract') ||
    /^t_u?int\d+$/.test(typeId) ||
    /^t_bytes\d+$/.test(typeId) ||
    typeId.startsWith('t_enum')
  );
}

/**
 * Whether a storage struct's members are ALL value types that each occupy their
 * OWN full slot at offset 0 — the only case the shared render path decodes
 * correctly (it reads the FULL slot word and decodes by type width, applying no
 * sub-word slice). Returns false (→ scalar-slot gap, no nested render) for:
 *   - a sub-word-PACKED member (`offset !== 0`, or two members sharing a slot):
 *     the full-word read cannot isolate it (confirmed: the machineState storage
 *     adapter returns the whole slot word, ignoring the pointer's offset/length);
 *   - a `bytesN` member with `N < 32`: stored LEFT-aligned, so a full-word read
 *     decodes to the value shifted into the high bytes (bytes32 is exempt — it
 *     fills the slot and decodes correctly);
 *   - a REFERENCE-type member (nested struct/array/string/bytes/mapping): out of
 *     this cycle's value-member scope. All deferred to a later cycle.
 */
function unpackedValueStruct(members: StorageMember[]): boolean {
  const slots = new Set<number>();
  for (const m of members) {
    if (!isValueTypeId(m.type)) return false; // reference-type member.
    if (m.offset !== 0 || slots.has(m.slot)) return false; // packed sub-word.
    const bytesN = /^t_bytes(\d+)$/.exec(m.type);
    if (bytesN !== null && Number(bytesN[1]) < 32) return false; // left-aligned.
    slots.add(m.slot);
  }
  return members.length > 0;
}

/**
 * The per-member descriptors of a value-member STORAGE struct. Each
 * member `k` sits at the consecutive absolute slot `baseSlot + member.slot`; its
 * pointer is a scalar storage pointer at that slot (member slots are RELATIVE to
 * the struct base in the solc layout).
 */
function storageStructMembers(
  contract: Contract,
  baseSlot: number,
  members: StorageMember[]
): StructMember[] {
  return members.map(m => {
    const memberType = contract.storageType(m.type);
    const numberOfBytes = memberType?.numberOfBytes ?? 32;
    return {
      name: m.label,
      typeLabel: memberType?.label ?? m.type,
      solcType: m.type,
      numberOfBytes,
      pointer: {
        location: 'storage',
        slot: baseSlot + m.slot,
        offset: m.offset,
        length: numberOfBytes,
      },
    };
  });
}
