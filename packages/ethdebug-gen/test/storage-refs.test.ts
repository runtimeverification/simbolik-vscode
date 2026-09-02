/**
 * STORAGE reference structures on the ethdebug producer.
 *
 * The storage analog of the memory struct / array work. For the
 * `StorageRefs` fixture, `generateEthdebugProgram(...).storageVariables` must carry
 * reference LAYOUT on two storage vars, mirroring the memory `ResolvedVariable`
 * shapes so the session reuses one rendering path:
 *   - `uint256[] public arr` (slot 0) → an `array` structure: a dereferenceable
 *     storage `List` pointer whose element regions are `'element'`, plus the
 *     element type facts (`t_uint256` / `uint256` / 32).
 *   - `Point public pt` (`struct{uint256 x; uint256 y}`, slots 5/6) → a `members`
 *     structure: per-member descriptors, each with its own storage pointer at the
 *     consecutive absolute slot (base + member.slot).
 *
 * This spec pins the STATIC producer shape only; the pointers are dereferenced
 * through the real `@ethdebug/pointers` path in the debugger suite
 * (`storage-refs.test.ts`).
 *
 * It ALSO pins the NEW `@simbolik/solc` `StorageType` fields the producer needs
 * (parsed from the raw `storageLayout.types` entry): `base` (array element type),
 * `members` (struct member slots), and `key`/`value` (mapping). These are read
 * through loose casts, so a missing field surfaces as a failed assertion rather
 * than a type error.
 *
 * ── Fixture ground truth (storagerefs-build-info.json, deterministic layout) ────
 *   arr:  type `t_array(t_uint256)dyn_storage`, encoding `dynamic_array`,
 *         base `t_uint256`, slot 0.
 *   pt:   type `t_struct(Point)7_storage`, encoding `inplace`, members
 *         [{x,slot 0},{y,slot 1}] RELATIVE to the struct base slot 5.
 *   balances: type `t_mapping(t_uint256,t_uint256)`, key/value `t_uint256`, slot 4.
 */
import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import type {Pointer} from '@ethdebug/pointers';
import {
  loadBuildInfo,
  type CompilationUnit,
  type StorageType,
} from '@simbolik/solc';

import {
  generateEthdebugProgram,
  type EthdebugStorageVariable,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function loadCu(): CompilationUnit {
  const url = new URL(
    '../../solc/test/fixtures/storagerefs-build-info.json',
    import.meta.url,
  );
  return loadBuildInfo(JSON.parse(readFileSync(url, 'utf8')));
}

const SRC = 'src/StorageRefs.sol';
const NAME = 'StorageRefs';

function storageVars(): EthdebugStorageVariable[] {
  return generateEthdebugProgram(loadCu(), SRC, NAME).storageVariables;
}
function byName(
  list: EthdebugStorageVariable[],
): Map<string, EthdebugStorageVariable> {
  return new Map(list.map((v) => [v.name, v]));
}

// ── Loose accessors for the producer fields ───────────────────────────────────

/** The `array` structure under a storage `arr` var. */
interface StorageArrayShape {
  pointer?: Pointer;
  elementSolcType: string;
  elementTypeLabel: string;
  elementNumberOfBytes: number;
}
function arrayOf(sv: EthdebugStorageVariable): StorageArrayShape | undefined {
  return (sv as unknown as {array?: StorageArrayShape}).array;
}

/** One member descriptor under a storage `pt` var. */
interface StorageMemberShape {
  name: string;
  typeLabel: string;
  solcType: string;
  numberOfBytes: number;
  pointer?: Pointer;
}
function membersOf(
  sv: EthdebugStorageVariable,
): StorageMemberShape[] | undefined {
  return (sv as unknown as {members?: StorageMemberShape[]}).members;
}

// ── Loose accessor for the `bytesStorage` descriptor ──────────────────────────

/**
 * The `bytesStorage` descriptor on a `encoding:'bytes'` storage
 * var. `flagPointer` addresses the inline/flag word (a 32-byte storage word at the
 * base slot); `longBaseSlot` is the CONCRETE keccak256(pad32(slot)) base for the
 * long-form data words; `isString` selects UTF-8 vs `0x…` rendering. Pointer
 * internals are kept loose (location/slot only) to avoid over-specifying.
 */
interface BytesStorageShape {
  flagPointer?: {
    location?: string;
    slot?: number;
    offset?: number;
    length?: number;
  };
  longBaseSlot?: string;
  isString?: boolean;
}
function bytesStorageOf(
  sv: EthdebugStorageVariable,
): BytesStorageShape | undefined {
  return (sv as unknown as {bytesStorage?: BytesStorageShape}).bytesStorage;
}

// ── Loose accessor for the `mapping` descriptor ───────────────────────────────

/**
 * The `mapping` descriptor on an `encoding:'mapping'` storage
 * var. Mapping keys are NOT enumerable statically (only the base slot is fixed);
 * the descriptor records the base slot + key/value solc types so the debugger can
 * enumerate observed keys from the trace and compute each entry slot as
 * `keccak256(key32 ‖ baseSlot32)`. Read loosely so a missing field surfaces as a
 * failed assertion, not a type error.
 */
interface MappingShape {
  baseSlot?: number;
  keyType?: string;
  valueType?: string;
}
function mappingOf(sv: EthdebugStorageVariable): MappingShape | undefined {
  return (sv as unknown as {mapping?: MappingShape}).mapping;
}

/** The `StorageType` reference-layout fields (read loosely). */
interface StorageTypeExtra {
  base?: string;
  members?: {label: string; slot: number; offset: number; type: string}[];
  key?: string;
  value?: string;
}
function extra(t: StorageType | undefined): StorageTypeExtra {
  return t as unknown as StorageTypeExtra;
}

// ---------------------------------------------------------------------------
// 1. The producer emits reference structures on storage vars
// ---------------------------------------------------------------------------

describe('generateEthdebugProgram emits storage reference structures', () => {
  it('arr carries an `array` structure (uint256 elements) with a storage pointer', () => {
    const arr = byName(storageVars()).get('arr')!;
    expect(arr, 'arr must be listed as a storage variable').toBeDefined();
    expect(arr.solcType).toBe('t_array(t_uint256)dyn_storage');
    expect(arr.slot).toBe(0);

    const array = arrayOf(arr);
    expect(array, 'arr must carry an array structure').toBeDefined();
    expect(array!.pointer, 'the array needs a concrete storage List pointer').toBeDefined();
    expect(array!.elementSolcType).toBe('t_uint256');
    expect(array!.elementTypeLabel).toContain('uint256');
    expect(array!.elementNumberOfBytes).toBe(32);
    // Not a struct.
    expect(membersOf(arr)).toBeUndefined();
  });

  it('pt carries a `members` structure (x, y uint256) with per-member storage pointers', () => {
    const pt = byName(storageVars()).get('pt')!;
    expect(pt, 'pt must be listed as a storage variable').toBeDefined();
    expect(pt.solcType).toBe('t_struct(Point)7_storage');
    expect(pt.slot).toBe(5);

    const members = membersOf(pt);
    expect(members, 'pt must carry a members array').toBeDefined();
    expect(members!.map((m) => m.name)).toEqual(['x', 'y']);
    for (const m of members!) {
      expect(m.solcType).toBe('t_uint256');
      expect(m.typeLabel).toContain('uint256');
      expect(m.numberOfBytes).toBe(32);
      expect(
        m.pointer,
        `member ${m.name} needs a concrete storage pointer`,
      ).toBeDefined();
    }
    // Not an array.
    expect(arrayOf(pt)).toBeUndefined();
  });

  it('value-slot storage vars are unchanged — arr/pt still expose their scalar slot pointer', () => {
    // The reference vars keep their existing scalar `pointer` (a storage pointer at
    // the base slot); the reference structure is ADDITIVE. Out-of-scope reference
    // vars (string/bytes/mapping) carry no array/members.
    const m = byName(storageVars());
    for (const name of ['shortStr', 'longStr', 'blob', 'balances']) {
      const sv = m.get(name)!;
      expect(sv, `${name} still listed`).toBeDefined();
      expect(arrayOf(sv), `${name} is not an array`).toBeUndefined();
      expect(membersOf(sv), `${name} is not a struct`).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 1b. The producer emits a `bytesStorage` descriptor on the three
//     dynamic string/bytes storage vars (shortStr / longStr / blob).
//
// Layout facts (slots + the STATIC keccak base) come from the producer; the
// session owns the encoding RULES (parity-select). This spec pins the descriptor
// SHAPE + the static long base slot only. Ground truth (re-derived from the
// folded trace + verified with ethereum-cryptography/keccak):
//   shortStr @slot 1, t_string_storage, isString true
//   longStr  @slot 2, t_string_storage, isString true,
//            longBaseSlot = keccak256(pad32(2)) = 0x405787fa…5ace
//   blob     @slot 3, t_bytes_storage,  isString false
// ---------------------------------------------------------------------------

describe('generateEthdebugProgram emits a bytesStorage descriptor', () => {
  it('shortStr carries a string bytesStorage with a storage flag pointer @slot 1', () => {
    const shortStr = byName(storageVars()).get('shortStr')!;
    expect(shortStr, 'shortStr must be listed as a storage variable').toBeDefined();
    expect(shortStr.solcType).toBe('t_string_storage');
    expect(shortStr.slot).toBe(1);

    const bs = bytesStorageOf(shortStr);
    expect(bs, 'shortStr must carry a bytesStorage descriptor').toBeDefined();
    expect(bs!.isString, 'shortStr is a string').toBe(true);
    expect(bs!.flagPointer, 'the flag word needs a storage pointer').toBeDefined();
    expect(bs!.flagPointer!.location).toBe('storage');
    expect(bs!.flagPointer!.slot).toBe(1);
    // Not a value-struct / value-array.
    expect(arrayOf(shortStr)).toBeUndefined();
    expect(membersOf(shortStr)).toBeUndefined();
  });

  it('longStr carries a string bytesStorage with the STATIC keccak long base slot', () => {
    const longStr = byName(storageVars()).get('longStr')!;
    expect(longStr, 'longStr must be listed as a storage variable').toBeDefined();
    expect(longStr.solcType).toBe('t_string_storage');
    expect(longStr.slot).toBe(2);

    const bs = bytesStorageOf(longStr);
    expect(bs, 'longStr must carry a bytesStorage descriptor').toBeDefined();
    expect(bs!.isString, 'longStr is a string').toBe(true);
    expect(bs!.flagPointer, 'the flag word needs a storage pointer').toBeDefined();
    expect(bs!.flagPointer!.location).toBe('storage');
    expect(bs!.flagPointer!.slot).toBe(2);
    // The concrete keccak256(pad32(2)) — computed statically at gen time.
    expect(bs!.longBaseSlot).toBe(
      '0x405787fa12a823e0f2b7631cc41b3ba8828b3321ca811111fa75cd3aa3bb5ace',
    );
  });

  it('blob carries a NON-string (bytes) bytesStorage with a storage flag pointer @slot 3', () => {
    const blob = byName(storageVars()).get('blob')!;
    expect(blob, 'blob must be listed as a storage variable').toBeDefined();
    expect(blob.solcType).toBe('t_bytes_storage');
    expect(blob.slot).toBe(3);

    const bs = bytesStorageOf(blob);
    expect(bs, 'blob must carry a bytesStorage descriptor').toBeDefined();
    expect(bs!.isString, 'blob is bytes, not a string').toBe(false);
    expect(bs!.flagPointer, 'the flag word needs a storage pointer').toBeDefined();
    expect(bs!.flagPointer!.location).toBe('storage');
    expect(bs!.flagPointer!.slot).toBe(3);
  });

  it('the mapping `balances` has no bytesStorage', () => {
    // Mappings must NOT gain a bytesStorage descriptor.
    const balances = byName(storageVars()).get('balances')!;
    expect(balances, 'balances still listed').toBeDefined();
    expect(bytesStorageOf(balances), 'balances is not a bytes/string var').toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 1c. The producer marks the mapping `balances` with a `mapping`
//     descriptor (base slot + key/value types + the keccak entry-slot rule).
//
// Mapping keys are NOT enumerable from the storage layout — only the base slot is
// static. The producer records the STATIC facts (base slot 4, key/value
// t_uint256); the debugger enumerates observed keys from the trace's SHA3
// preimages and computes each entry slot as keccak256(key ‖ baseSlot). So the
// mapping var carries NEITHER an array/members pointer NOR a bytesStorage — it
// gets its own `mapping` descriptor.
// ---------------------------------------------------------------------------

describe('generateEthdebugProgram marks the mapping storage var', () => {
  it('balances carries a mapping descriptor (baseSlot 4, uint256 key/value)', () => {
    const balances = byName(storageVars()).get('balances')!;
    expect(balances, 'balances must be listed as a storage variable').toBeDefined();
    expect(balances.solcType).toBe('t_mapping(t_uint256,t_uint256)');
    expect(balances.slot).toBe(4);

    const mapping = mappingOf(balances);
    expect(mapping, 'balances must carry a mapping descriptor').toBeDefined();
    expect(mapping!.baseSlot).toBe(4);
    expect(mapping!.keyType).toBe('t_uint256');
    expect(mapping!.valueType).toBe('t_uint256');

    // A mapping is not an array / value-struct / bytes var.
    expect(arrayOf(balances)).toBeUndefined();
    expect(membersOf(balances)).toBeUndefined();
    expect(bytesStorageOf(balances)).toBeUndefined();
  });

  it('arr / pt / strings / bytes do NOT carry a mapping descriptor', () => {
    const m = byName(storageVars());
    for (const name of ['arr', 'pt', 'shortStr', 'longStr', 'blob']) {
      const sv = m.get(name)!;
      expect(sv, `${name} still listed`).toBeDefined();
      expect(mappingOf(sv), `${name} is not a mapping`).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The solc StorageType now exposes base / members / key-value
// ---------------------------------------------------------------------------

describe('@simbolik/solc StorageType exposes reference-layout fields', () => {
  it('the dynamic-array type carries its element base type', () => {
    const cu = loadCu();
    const contract = cu.contract(SRC, NAME)!;
    const t = extra(contract.storageType('t_array(t_uint256)dyn_storage'));
    expect(t.base, 'array StorageType must expose `base`').toBe('t_uint256');
  });

  it('the struct type carries its member slots (relative to the base)', () => {
    const cu = loadCu();
    const contract = cu.contract(SRC, NAME)!;
    const t = extra(contract.storageType('t_struct(Point)7_storage'));
    expect(t.members, 'struct StorageType must expose `members`').toBeDefined();
    expect(t.members).toEqual([
      {label: 'x', slot: 0, offset: 0, type: 't_uint256'},
      {label: 'y', slot: 1, offset: 0, type: 't_uint256'},
    ]);
  });

  it('the mapping type carries its key and value types', () => {
    const cu = loadCu();
    const contract = cu.contract(SRC, NAME)!;
    const t = extra(contract.storageType('t_mapping(t_uint256,t_uint256)'));
    expect(t.key, 'mapping StorageType must expose `key`').toBe('t_uint256');
    expect(t.value, 'mapping StorageType must expose `value`').toBe('t_uint256');
  });
});
