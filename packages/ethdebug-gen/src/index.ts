/**
 * @simbolik/ethdebug-gen — generate ethdebug-format debug info from an
 * UNOPTIMIZED solc standard-json compilation. Scope: program
 * instruction→source mapping + storage (state) variable pointers.
 */

import type {Pointer} from '@ethdebug/pointers';
import {
  buildInstructionIndex,
  type CompilationUnit,
  type Contract,
} from '@simbolik/solc';
import {keccak256} from 'ethereum-cryptography/keccak';
import {bytesToHex, hexToBytes} from 'ethereum-cryptography/utils';

import type {ArrayLayout, BytesStorageLayout, StructMember} from './variables.js';

export {
  describeValueTypeString,
  functionParameters,
  type ParamDescriptor,
} from './functionParameters.js';
export {functionLocals, type LocalDescriptor} from './functionLocals.js';
export {stackHeights, type StackHeights} from './stackHeights.js';
export {
  variablesAt,
  bytesLayoutAtMemoryOffset,
  type ResolvedVariable,
  type StructMember,
  type ArrayLayout,
  type BytesLayout,
  type BytesStorageLayout,
} from './variables.js';

/** One runtime instruction with its resolved source range (from the source map). */
export interface EthdebugInstruction {
  /** Program counter of the instruction start. */
  pc: number;
  /** Index into the source map / instruction stream. */
  instructionIndex: number;
  /** Opcode byte. */
  op: number;
  /** Absent when the source-map fileId is -1 or the file is not in the output. */
  source?: {
    fileId: number;
    start: number;
    length: number;
    line: number;
    column: number;
  };
}

/** A state (storage) variable with an ethdebug pointer to its bytes. */
export interface EthdebugStorageVariable {
  name: string;
  astId: number;
  solcType: string;
  slot: number;
  offset: number;
  length: number;
  pointer: Pointer;
  /**
   * For a dynamic-array storage var, its element layout + a
   * dereferenceable storage `List` pointer (element regions named `'element'`),
   * mirroring the memory {@link ArrayLayout} so the session reuses one path.
   */
  array?: ArrayLayout;
  /**
   * For a value-struct storage var, its per-member descriptors, each
   * with a concrete storage pointer at the consecutive absolute slot — mirroring
   * the memory {@link StructMember} shape.
   */
  members?: StructMember[];
  /**
   * For a dynamic-`bytes`-encoded (`string`/`bytes`) storage var, the
   * layout facts the session parity-selects on — the inline/flag word pointer, the
   * STATIC keccak base slot for long-form data words, and string-vs-bytes decode.
   * The session owns the encoding RULES (parity, high-byte slice, multi-word trim).
   */
  bytesStorage?: BytesStorageLayout;
  /**
   * For a `mapping`-encoded storage var, the STATIC layout facts —
   * the base slot and the solc key/value type ids. Mapping keys are NOT
   * enumerable from the layout (only the base slot is fixed); the debugger
   * enumerates observed keys from the trace's `keccak256(key‖slot)` preimages
   * and computes each entry slot as `keccak256(key32 ‖ baseSlot32)`.
   */
  mapping?: {baseSlot: number; keyType: string; valueType: string};
}

/** An ethdebug program for one contract's runtime (or init) code. */
export interface EthdebugProgram {
  contract: string;
  kind: 'runtime' | 'init';
  instructions: EthdebugInstruction[];
  storageVariables: EthdebugStorageVariable[];
}

/** Read the opcode byte at `pc` from a `0x`-prefixed bytecode hex string. */
function opAt(bytecode: string, pc: number): number {
  return parseInt(bytecode.slice(2 + pc * 2, 2 + pc * 2 + 2), 16);
}

/** Generate an ethdebug program for one contract's runtime (or init) code. */
export function generateEthdebugProgram(
  cu: CompilationUnit,
  sourcePath: string,
  contractName: string,
  kind: 'runtime' | 'init' = 'runtime',
): EthdebugProgram {
  const contract = cu.contract(sourcePath, contractName);
  if (contract === undefined) {
    throw new Error(`contract not found: ${sourcePath}:${contractName}`);
  }

  const bytecode =
    kind === 'init' ? contract.initBytecode() : contract.runtimeBytecode();
  const sourceMap =
    kind === 'init' ? contract.initSourceMap() : contract.runtimeSourceMap();
  const {instructionToPc} = buildInstructionIndex(bytecode);

  // The instruction stream aligns 1:1 with the source map, NOT with the raw
  // disassembly (which runs past the source map into the CBOR metadata trailer).
  const instructions: EthdebugInstruction[] = [];
  for (let i = 0; i < sourceMap.length; i++) {
    const pc = instructionToPc[i]!;
    const entry = sourceMap[i]!;
    const instruction: EthdebugInstruction = {
      pc,
      instructionIndex: i,
      op: opAt(bytecode, pc),
    };
    // Omit `source` when fileId is -1 (no source) or when the file is not part
    // of the output (e.g. a solc-internal source absent from output.sources).
    const file =
      entry.fileId >= 0 ? cu.sourceById(entry.fileId) : undefined;
    if (file !== undefined) {
      const {line, column} = file.offsetToPosition(entry.start);
      instruction.source = {
        fileId: entry.fileId,
        start: entry.start,
        length: entry.length,
        line,
        column,
      };
    }
    instructions.push(instruction);
  }

  const storageVariables: EthdebugStorageVariable[] = [];
  for (const entry of contract.storageLayout()) {
    const type = contract.storageType(entry.type);
    if (type === undefined) {
      continue;
    }
    const slot = Number(entry.slot);
    const offset = entry.offset;
    const length = type.numberOfBytes;
    const sv: EthdebugStorageVariable = {
      name: entry.label,
      astId: entry.astId,
      solcType: entry.type,
      slot,
      offset,
      length,
      // The scalar slot pointer stays UNCHANGED; the reference layout is additive.
      pointer: {location: 'storage', slot, offset, length},
    };

    // Emit reference layout for the two in-scope storage reference kinds.
    // Value types (and out-of-scope bytes/string/mapping) keep only the scalar
    // pointer above. Both emitters are FAIL-CLOSED: they only attach layout for
    // the cases the shared render path decodes CORRECTLY (a value element/member
    // occupying its own full slot). Sub-word-PACKED elements/members and
    // reference-type elements/members are left as a scalar-slot gap rather than
    // silently mis-decoded — see the guards in the helpers below.
    if (type.encoding === 'dynamic_array' && type.base !== undefined) {
      const array = storageArrayLayout(contract, slot, type.base);
      if (array !== undefined) sv.array = array;
    } else if (type.encoding === 'inplace' && type.base !== undefined) {
      // A FIXED-size storage array `T[N]`: inline at consecutive slots from the
      // declared slot (NO keccak, NO length word). Guarded by `base !== undefined`
      // so it does not collide with the struct branch below (`members`).
      const array = fixedStorageArrayLayout(
        contract,
        slot,
        type.base,
        type.numberOfBytes,
      );
      if (array !== undefined) sv.array = array;
    } else if (type.encoding === 'inplace' && type.members !== undefined) {
      if (unpackedValueStruct(type.members)) {
        sv.members = storageStructMembers(contract, slot, type.members);
      }
    } else if (type.encoding === 'bytes') {
      // A dynamic string/bytes storage var. Its runtime encoding (short
      // inline vs long keccak-based) is chosen by LENGTH — a fact ethdebug
      // expressions cannot branch on — so the producer supplies only the LAYOUT
      // facts (the flag word + the STATIC keccak base) and the session parity-
      // selects the decode. The keccak base is static (the slot is known at gen
      // time), so it is computed CONCRETELY here.
      sv.bytesStorage = storageBytesLayout(slot, entry.type);
    } else if (
      type.encoding === 'mapping' &&
      type.key !== undefined &&
      type.value !== undefined
    ) {
      // A mapping storage var. Keys are not statically enumerable, so
      // the producer records only the STATIC facts (base slot + key/value type
      // ids); the debugger recovers observed keys from the trace and computes
      // each entry slot as keccak256(key ‖ baseSlot).
      sv.mapping = {baseSlot: slot, keyType: type.key, valueType: type.value};
    }

    storageVariables.push(sv);
  }

  return {
    contract: `${sourcePath}:${contractName}`,
    kind,
    instructions,
    storageVariables,
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
 * to the wrong (zero) slot. `@ethdebug/pointers` resolves the ops at dereference.
 *
 * SCOPE GUARD: this `keccak(p)+i` layout assumes each element occupies
 * its OWN full slot. That holds only for a VALUE-type element larger than half a
 * slot (`numberOfBytes > 16` → one element per slot). Returns `undefined` for:
 *   - a sub-word-PACKED element (`numberOfBytes <= 16`, e.g. `uint8[]`/`uint128[]`/
 *     `bool[]`): solc packs several per slot, so `+i` would read the WRONG slot;
 *   - a REFERENCE-type element (`uint256[][]`, `struct[]`): the element slot would
 *     be decoded as a scalar. Both are deferred (scalar-slot gap, not mis-decoded).
 */
function storageArrayLayout(
  contract: Contract,
  slot: number,
  baseTypeId: string,
): ArrayLayout | undefined {
  const baseType = contract.storageType(baseTypeId);
  const elementNumberOfBytes = baseType?.numberOfBytes ?? 32;
  // Fail closed: only value-type elements that occupy one full slot each.
  if (!isValueTypeId(baseTypeId) || elementNumberOfBytes <= 16) {
    return undefined;
  }
  const paddedSlot = '0x' + slot.toString(16).padStart(64, '0');
  const pointer: Pointer = {
    group: [
      {name: 'len', location: 'storage', slot, offset: 0, length: 32},
      {
        list: {
          count: {$read: 'len'},
          each: 'i',
          is: {
            name: 'element',
            location: 'storage',
            slot: {$sum: [{$keccak256: [paddedSlot]}, 'i']},
            offset: 0,
            length: 32,
          },
        },
      },
    ],
  };
  return {
    pointer,
    elementSolcType: baseTypeId,
    elementTypeLabel: baseType?.label ?? baseTypeId,
    elementNumberOfBytes,
  };
}

/**
 * The `List` layout of a FIXED-size STORAGE array of VALUE-TYPE elements
 * (`T[N]`, `encoding: 'inplace'`). Unlike a dynamic array, a fixed array is stored
 * INLINE at consecutive slots from the declared slot — NO length word, NO keccak.
 * Element `i` lives at `slot + i` (storage is WORD-indexed), each occupying one
 * full slot, and the count `N` is STATIC (`numberOfBytes / 32`). The pointer is a
 * `Group` with a single `List` of `count: N` regions NAMED `'element'`.
 *
 * SCOPE GUARD (same contract as the dynamic path): this `slot + i` layout assumes
 * each element occupies its OWN full slot. Returns `undefined` for a
 * sub-word-PACKED element (`numberOfBytes <= 16`, e.g. `uint8[N]`) or a
 * REFERENCE-type element (`T[][N]`, `struct[N]`) — a scalar-slot gap, not
 * mis-decoded.
 */
function fixedStorageArrayLayout(
  contract: Contract,
  slot: number,
  baseTypeId: string,
  numberOfBytes: number,
): ArrayLayout | undefined {
  const baseType = contract.storageType(baseTypeId);
  const elementNumberOfBytes = baseType?.numberOfBytes ?? 32;
  // Fail closed: only value-type elements that occupy one full slot each.
  if (!isValueTypeId(baseTypeId) || elementNumberOfBytes <= 16) {
    return undefined;
  }
  const count = Math.floor(Number(numberOfBytes) / 32);
  const pointer: Pointer = {
    group: [
      {
        list: {
          count,
          each: 'i',
          is: {
            name: 'element',
            location: 'storage',
            slot: {$sum: [slot, 'i']},
            offset: 0,
            length: 32,
          },
        },
      },
    ],
  };
  return {
    pointer,
    elementSolcType: baseTypeId,
    elementTypeLabel: baseType?.label ?? baseTypeId,
    elementNumberOfBytes,
  };
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
function storageBytesLayout(slot: number, solcType: string): BytesStorageLayout {
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
 * slot fragment). Mirrors `isValueSolcType` in `variables.ts`; kept local so the
 * producer's scope guards do not depend on the consumer module.
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
function unpackedValueStruct(
  members: {label: string; slot: number; offset: number; type: string}[],
): boolean {
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
 * the struct base in the solc layout). Reference-type members are out of scope
 * this cycle.
 */
function storageStructMembers(
  contract: Contract,
  baseSlot: number,
  members: {label: string; slot: number; offset: number; type: string}[],
): StructMember[] {
  return members.map((m) => {
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
