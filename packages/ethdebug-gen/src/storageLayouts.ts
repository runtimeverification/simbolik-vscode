/**
 * Reference-type layouts of storage (state) variables, derived from the solc
 * storage layout. All emitters fail closed: they only attach a layout where the
 * consumer decodes it correctly (a value element/member occupying its own full
 * slot). Sub-word-packed and reference-type elements/members get no layout
 * rather than being mis-decoded; see the guards below.
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
    // A fixed-size storage array `T[N]`: inline at consecutive slots from the
    // declared slot (no keccak, no length word). Checked before the struct
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
    // A string/bytes storage variable. Its encoding (short inline vs long
    // keccak-based) depends on the runtime length, which ethdebug expressions
    // cannot branch on, so only the layout facts are supplied (the flag word
    // and the keccak base, computed here since the slot is static) and the
    // consumer selects the decode by parity.
    return {bytesStorage: storageBytesLayout(slot, typeId)};
  }
  if (
    type.encoding === 'mapping' &&
    type.key !== undefined &&
    type.value !== undefined
  ) {
    // Keys are not statically enumerable, so only the static facts are
    // recorded (base slot and key/value type ids); a consumer discovers keys at
    // runtime and computes each entry slot as keccak256(key ‖ baseSlot).
    return {
      mapping: {baseSlot: slot, keyType: type.key, valueType: type.value},
    };
  }
  return {};
}

/**
 * The element facts of a storage array of `baseTypeId` elements, or
 * `undefined` unless each element is a value type occupying its own full slot,
 * the only case the `slot + i`-style layouts below hold for. That excludes:
 *   - a sub-word-packed element (`numberOfBytes <= 16`, e.g. `uint8[]`,
 *     `uint128[]`, `bool[]`): solc packs several per slot, so `+i` would read
 *     the wrong slot;
 *   - a reference-type element (`uint256[][]`, `struct[]`): the element slot
 *     would be decoded as a scalar.
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

/** A `List` of `count` full-slot storage regions named `'element'` at `slot`. */
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
 * The `List` layout of a dynamic storage array of value-type elements. The
 * length lives in the base slot `p`; element `i` lives at `keccak256(p) + i`
 * (storage is word-indexed, so `+i`, not `+i*32`), each occupying one full
 * slot. The pointer is a `Group`:
 *   - `len`: the base slot word (the element count);
 *   - a `List` of `count:{$read:'len'}` regions named `'element'`, each a full
 *     slot at `{$sum:[{$keccak256:[<p as a padded 32-byte hex word>]}, 'i']}`.
 * The `$keccak256` operand must be the padded 32-byte-word hex string
 * (`"0x"+p.toString(16).padStart(64,"0")`); a bare number or minimal hex
 * hashes to the wrong slot. See {@link fullSlotValueElement} for the scope
 * guard.
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
 * The `List` layout of a fixed-size storage array of value-type elements
 * (`T[N]`, `encoding: 'inplace'`). A fixed array is stored inline at
 * consecutive slots from the declared slot, with no length word and no keccak.
 * Element `i` lives at `slot + i`, each occupying one full slot, and the count
 * `N` is static (`numberOfBytes / 32`). The pointer is a `Group` with a single
 * `List` of `count: N` regions named `'element'`. Same scope guard as the
 * dynamic path ({@link fullSlotValueElement}).
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
 * The layout of a `string`/`bytes` storage variable. Solidity stores it in a
 * length/parity-flagged base slot:
 *   - short (data < 32 bytes): the data is stored inline in the base slot's
 *     high bytes, with `length*2` in the low byte (even low byte);
 *   - long (data >= 32 bytes): the base slot holds `length*2+1` (odd low byte)
 *     and the data lives in consecutive words starting at
 *     `keccak256(pad32(slot))`.
 * Both the flag-word pointer and the long-data base slot (computed here, since
 * the slot is static) are emitted; the consumer selects by parity at read
 * time. `isString` selects UTF-8 vs `0x…` hex rendering.
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
 * True for the solc storage-style type ids that are value types (decoded as a
 * flat slot fragment). Close to `isValueSolcType` in `variables.ts`, but
 * storage-layout ids carry the contract name (`t_contract(Foo)12`), hence the
 * prefix match here.
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
 * Whether a storage struct's members are all value types that each occupy their
 * own full slot at offset 0, the only case the consumer decodes correctly (it
 * reads the full slot word and decodes by type width, applying no sub-word
 * slice). Returns false (no member layout) for:
 *   - a sub-word-packed member (`offset !== 0`, or two members sharing a slot):
 *     the full-word read cannot isolate it, since the storage read returns the
 *     whole slot word regardless of the pointer's offset/length;
 *   - a `bytesN` member with `N < 32`: stored left-aligned, so a full-word read
 *     decodes the value shifted into the high bytes (bytes32 fills the slot and
 *     decodes correctly);
 *   - a reference-type member (nested struct/array/string/bytes/mapping).
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
 * The per-member descriptors of a value-member storage struct. Each member
 * sits at the absolute slot `baseSlot + member.slot` (member slots are relative
 * to the struct base in the solc layout); its pointer is a scalar storage
 * pointer at that slot.
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
