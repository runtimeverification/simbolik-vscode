/**
 * Value-type decoding.
 *
 * Given a raw `field` (a `bigint` already extracted from its packed storage slot
 * or read from a calldata word) and the solc type id + width, produce the
 * `{value, type}` strings a DAP `Variable` carries. Only value types are
 * handled (uintN, intN, bool, address, contract, bytesN, enum,
 * userDefinedValueType-as-underlying).
 */
import {addressHex} from './hex.js';

/** A decoded value: display string + Solidity type label. */
export interface DecodedValue {
  value: string;
  type: string;
}

/** Extra context a few types need (label from the solc type table + enum info). */
export interface DecodeContext {
  /** The solc type-table `label` (e.g. `uint8`, `int256`), when available. */
  label?: string;
  /** The enum's simple name (e.g. `Color`) — shown as the type for enums. */
  enumName?: string;
  /** The ordered enum member names, indexed by the field's integer value. */
  memberNames?: string[];
}

/**
 * Decode `field` as the solc type `typeId` of `numberOfBytes` bytes.
 *
 * `field` must already be the type's own bytes as an unsigned integer: for
 * packed storage this is the shifted/masked slot fragment; for a right-aligned
 * calldata word it is the whole 32-byte word value (the high bytes are zero for
 * unsigned/bool/address and are the sign extension for `intN`).
 */
export function decodeValue(
  field: bigint,
  typeId: string,
  numberOfBytes: number,
  ctx: DecodeContext = {},
): DecodedValue {
  if (typeId === 't_bool') {
    return {value: field === 1n ? 'true' : 'false', type: ctx.label ?? 'bool'};
  }

  if (typeId.startsWith('t_enum')) {
    const index = Number(field);
    const name = ctx.memberNames?.[index] ?? String(index);
    return {value: name, type: ctx.enumName ?? ctx.label ?? 'enum'};
  }

  if (typeId === 't_address' || typeId.startsWith('t_contract')) {
    return {
      value: addressHex(field),
      type: ctx.label ?? 'address',
    };
  }

  const bytesMatch = /^t_bytes(\d+)$/.exec(typeId);
  if (bytesMatch) {
    const n = numberOfBytes || Number(bytesMatch[1]);
    return {
      value: '0x' + field.toString(16).padStart(2 * n, '0'),
      type: ctx.label ?? `bytes${n}`,
    };
  }

  const intMatch = /^t_int(\d+)$/.exec(typeId);
  if (intMatch) {
    const bits = 8 * numberOfBytes;
    const signBit = 1n << BigInt(bits - 1);
    const signed = field >= signBit ? field - (1n << BigInt(bits)) : field;
    return {value: signed.toString(), type: ctx.label ?? `int${intMatch[1]}`};
  }

  const uintMatch = /^t_uint(\d+)$/.exec(typeId);
  if (uintMatch) {
    return {value: field.toString(), type: ctx.label ?? `uint${uintMatch[1]}`};
  }

  // t_userDefinedValueType(...) decodes as its underlying value type; absent a
  // resolved underlying id here we fall through to a plain decimal, matching an
  // unsigned integer underlying (the common case). Other unknown value types
  // degrade to the same decimal rendering rather than throwing.
  return {value: field.toString(), type: ctx.label ?? typeId.replace(/^t_/, '')};
}

/** Extract the trailing AST id from an enum type id (`t_enum(Color)5` → 5). */
export function enumAstId(typeId: string): number | undefined {
  const match = /(\d+)$/.exec(typeId);
  return match ? Number(match[1]) : undefined;
}

/**
 * Normalize a full 32-byte ABI word (as read from a calldata head slot) into the
 * `field` bigint {@link decodeValue} expects — the type's own bytes.
 *
 * The ABI packs a value type into a 32-byte word two different ways:
 * `bytesN` are left-aligned (high-order, zero right-padded), while everything
 * else (`uintN`, `intN`, `bool`, `address`, `enum`) is right-aligned (low-order,
 * sign- or zero-extended). Reducing the word to exactly the type's
 * `numberOfBytes` makes narrow types decode correctly: otherwise a negative
 * `int8` would keep the ABI sign-extension bits (decoding to a huge positive
 * number) and a `bytes4` would carry its zero padding into the hex string.
 */
export function fieldFromAbiWord(
  word: bigint,
  typeId: string,
  numberOfBytes: number,
): bigint {
  if (/^t_bytes\d+$/.test(typeId)) {
    // bytesN are left-aligned: drop the (32 - N) low-order padding bytes.
    return word >> BigInt(8 * (32 - numberOfBytes));
  }
  // Right-aligned: keep the low N bytes (drops any intN sign-extension bits so
  // the two's-complement decode runs over the type's true width).
  return word & ((1n << BigInt(8 * numberOfBytes)) - 1n);
}

/**
 * Describe a value-type solc `typeString` for calldata/stack decoding. Defined
 * in `@simbolik/ethdebug-gen` (shared with the static parameter inventory) and
 * re-exported here for the decode call sites.
 */
export {describeValueTypeString} from '@simbolik/ethdebug-gen';
