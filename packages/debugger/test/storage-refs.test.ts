/**
 * A dynamic storage array (`arr`) and a value-member storage struct (`pt`)
 * rendered as nested DAP variables, dereferenced through the real
 * `@ethdebug/pointers` storage path.
 *
 * The storage counterpart of arrays.test.ts / structs.test.ts.
 * `StorageRefs.populate()` sets, among others:
 *   `uint256[] public arr = [11, 22, 33];`  (slot 0 = length; elements at
 *                                            keccak256(slot0 word) + i)
 *   `Point public pt = {x: 5, y: 6};`        (slots 5, 6)
 * The producer (`generateEthdebugProgram`) emits their reference layout as storage
 * pointers ($keccak256/$sum for the array base, consecutive slots for the struct);
 * the session dereferences + renders them nested, reusing the memory path.
 *
 * ## Trace ground truth (storagerefs-populate-trace.raw.json)
 * From the recorded trace (folded account storage). The chosen clean body pc is
 * 1064 — the first own-contract step of line 35 (`emit Updated(7,100)`), the
 * last body statement, after every storage write (arr lines 25-27, pt.x line
 * 33, pt.y line 34) has folded into the account. At that step:
 *   slot 0                                                             = 3 (arr len)
 *   keccak256(0x00..00)=0x290decd9…e563       +0 = 0xb (11)
 *                                             +1 = 0x16 (22)
 *                                             +2 = 0x21 (33)
 *   slot 5 = 5 (pt.x), slot 6 = 6 (pt.y)
 * `arr = [11, 22, 33]`, `pt = {x: 5, y: 6}` — pinned below as the oracle.
 *
 * ## What this exercises
 *   1. `$keccak256` on a storage slot — the array `List` base slot is
 *      `{$sum:[{$keccak256:<slot0 word>}, i]}`; the real deref must hash slot0's
 *      32-byte word to 0x290decd9…e563 and add i.
 *   2. `machineStateFor` reading a big keccak-derived storage slot — the element
 *      slots (0x290decd9…563/564/565) must resolve against the account storage
 *      keyed by their full 32-byte hex.
 */
import {keccak256} from 'ethereum-cryptography/keccak';
import {bytesToHex, hexToBytes} from 'ethereum-cryptography/utils';
import {describe, expect, it} from 'vitest';

import type {Pointer} from '@ethdebug/pointers';
import {
  generateEthdebugProgram,
  type EthdebugStorageVariable,
} from '@simbolik/ethdebug-gen';
import {StateCursor, type Step} from '@simbolik/lifting';

import {readPointerRegions, readPointerValue} from '../src/machineState.js';
import {
  breakAt as breakAtSpec,
  children,
  cursorFor,
  launch,
  loadCu,
  loadSteps,
  machineStateAtPc,
  metaOf,
  normAddr,
  stateVars as stateMap,
  type Spec,
} from './support/harness.js';

// ## Fixtures

const CU = 'storagerefs-build-info.json';
const TRACE = 'storagerefs-populate-trace.raw.json';
const META = 'storagerefs-populate-meta.json';

const SRC = 'src/StorageRefs.sol';
const NAME = 'StorageRefs';

const spec: Spec = {
  buildInfo: CU,
  trace: TRACE,
  meta: META,
  sourcePath: SRC,
  contractName: NAME,
  methodName: 'populate',
  dialect: 'kontrol',
};
const breakAt = (line: number) => breakAtSpec(spec, line);

/** Clean body pc: first own-contract step of line 35, all storage writes folded. */
const CLEAN_PC = 1064;

/** keccak256 of slot 0's 32-byte word — the array element base slot. */
const ARR_BASE_SLOT =
  '0x290decd9548b62a8d60345a988386fc84ba6bc95484008f6362f93160ef3e563';

// ## Loose accessors for the storage producer fields

interface StorageArrayShape {
  pointer?: Pointer;
  elementSolcType: string;
  elementTypeLabel: string;
  elementNumberOfBytes: number;
}
function arrayOf(sv: EthdebugStorageVariable): StorageArrayShape | undefined {
  return (sv as unknown as {array?: StorageArrayShape}).array;
}
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

function storageVars(): EthdebugStorageVariable[] {
  return generateEthdebugProgram(loadCu(CU), SRC, NAME).storageVariables;
}
function byName(
  list: EthdebugStorageVariable[],
): Map<string, EthdebugStorageVariable> {
  return new Map(list.map((v) => [v.name, v]));
}

// ## 0. Fixture ground truth — read the folded storage directly

describe('fixture ground truth (folded account storage)', () => {
  it('slot0=3, keccak(0)+i = 11/22/33, slot5=5, slot6=6 at the clean body pc', () => {
    const {steps, cursor} = cursorFor(TRACE);
    const addr = normAddr(metaOf(META).contractAddress);
    let index = -1;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]!;
      if (s.isInitCode || s.codeAddress !== BigInt(addr)) continue;
      if (s.pc === CLEAN_PC) {
        index = i;
        break;
      }
    }
    expect(index, `no own-contract step at pc ${CLEAN_PC}`).toBeGreaterThanOrEqual(0);

    const account = cursor.at(index).accounts.get(addr.toLowerCase())!;
    const slot = (key: string): bigint => {
      const raw = account.storage[key] ?? '0x0';
      return BigInt(raw.startsWith('0x') ? raw : '0x' + raw);
    };
    // arr length + elements at keccak(slot0)+i (word-indexed).
    expect(slot('0x0')).toBe(3n);
    const base = BigInt(ARR_BASE_SLOT);
    expect(slot('0x' + base.toString(16))).toBe(11n);
    expect(slot('0x' + (base + 1n).toString(16))).toBe(22n);
    expect(slot('0x' + (base + 2n).toString(16))).toBe(33n);
    // pt members at consecutive slots.
    expect(slot('0x5')).toBe(5n);
    expect(slot('0x6')).toBe(6n);
  });
});

// ## 1. The storage array pointer dereferences to [11, 22, 33]

describe('arr storage pointer dereferences through @ethdebug/pointers', () => {
  it('arr resolves to elements [11n, 22n, 33n] via the real storage $keccak256 deref', async () => {
    const arr = byName(storageVars()).get('arr')!;
    const array = arrayOf(arr);
    expect(array, 'arr must carry an array structure to dereference').toBeDefined();
    expect(array!.pointer, 'the array needs a concrete storage List pointer').toBeDefined();

    const ms = machineStateAtPc(TRACE, META, CLEAN_PC);
    // readPointerRegions enumerates the `'element'` regions of the List — this
    // exercises $keccak256 on slot 0 + machineStateFor reading the big keccak slots.
    const values = await readPointerRegions(array!.pointer as Pointer, ms);
    expect(values).toEqual([11n, 22n, 33n]);
  });
});

// ## 2. The struct member pointers dereference to x=5, y=6

describe('pt storage member pointers dereference through @ethdebug/pointers', () => {
  it('pt.x reads 5 and pt.y reads 6 at consecutive slots (real deref path)', async () => {
    const pt = byName(storageVars()).get('pt')!;
    const members = membersOf(pt);
    expect(members, 'pt must carry member pointers to dereference').toBeDefined();
    const [x, y] = members!;
    expect(x!.name).toBe('x');
    expect(y!.name).toBe('y');
    expect(x!.pointer, 'member x needs a storage pointer').toBeDefined();
    expect(y!.pointer, 'member y needs a storage pointer').toBeDefined();

    const ms = machineStateAtPc(TRACE, META, CLEAN_PC);
    expect(await readPointerValue(x!.pointer as Pointer, ms)).toBe(5n);
    expect(await readPointerValue(y!.pointer as Pointer, ms)).toBe(6n);
  });
});

// ## 3. The session renders arr + pt as nested DAP variables (State scope)

describe('session renders arr as a nested storage DAP variable', () => {
  it('arr has a non-zero variablesReference; children 0=11, 1=22, 2=33 (uint256)', async () => {
    const session = await breakAt(35); // line 35 = emit; all writes folded
    expect(session.stackTrace().stackFrames[0]!.line).toBe(35);

    const arr = (await stateMap(session)).get('arr');
    expect(arr, 'arr should be surfaced as a State variable').toBeDefined();
    expect(arr!.variablesReference).not.toBe(0);

    const childVars = await children(session, arr!.variablesReference);
    const kids = childVars.map((v) => ({
      name: v.name,
      value: v.value,
    }));
    expect(kids).toEqual([
      {name: '0', value: '11'},
      {name: '1', value: '22'},
      {name: '2', value: '33'},
    ]);
    for (const child of childVars) {
      expect(child.type).toBe('uint256');
      expect(child.variablesReference).toBe(0);
    }
  });
});

describe('session renders pt as a nested storage DAP variable', () => {
  it('pt has a non-zero variablesReference; children x=5, y=6 (uint256)', async () => {
    const session = await breakAt(35);

    const pt = (await stateMap(session)).get('pt');
    expect(pt, 'pt should be surfaced as a State variable').toBeDefined();
    expect(pt!.variablesReference).not.toBe(0);
    // Summarized by its source-level name, not the storage type id
    // (`t_struct(Point)…_storage`).
    expect(pt!.value).toBe('Point {…}');

    const childVars = await children(session, pt!.variablesReference);
    const kids = childVars.map((v) => ({
      name: v.name,
      value: v.value,
    }));
    expect(kids).toEqual([
      {name: 'x', value: '5'},
      {name: 'y', value: '6'},
    ]);
    for (const child of childVars) {
      expect(child.type).toBe('uint256');
      expect(child.variablesReference).toBe(0);
    }
  });
});

// 3b. The session renders the three dynamic string/bytes storage vars as
//     scalar DAP variables, choosing the short/long encoding by the low bit.
//
// Ground truth (folded account storage in storagerefs-populate-trace.raw.json,
// contract 0x5fbdb231…80aa3; hashes via ethereum-cryptography/keccak):
//   slot 1 = 0x68656c6c6f…0a   → low byte 0x0a even (short); len 5; high 5 bytes
//                                 0x68656c6c6f = "hello".
//   slot 2 = 0x49              → low byte 0x49 odd (long); len (0x49−1)/2 = 36;
//            data at keccak256(pad32(2)) = 0x405787fa…5ace and slot+1, first 36
//            bytes = "abcdefghijklmnopqrstuvwxyz0123456789".
//   slot 3 = 0xdeadbeef…08     → low byte 0x08 even (short bytes); len 4; high 4
//                                 bytes 0xdeadbeef.
//
// Rendered scalar (variablesReference 0). Strings are quoted ('"hello"'), like
// the memory `label` in arrays.test.ts (`label!.value === '"hi"'`, type contains
// 'string'); bytes render as a bare `0x…` hex string, type 'bytes'.
//
// Not covered by this fixture: the zero-length case `b = 0` (even → short,
// len 0) → empty bytes → `""` for a string / `0x` for bytes. The decode must
// not read a high-byte slice past the word or do a 0-word long read for it.

describe('session renders string/bytes storage as scalar DAP variables', () => {
  it('shortStr → the quoted UTF-8 string "hello" (short/inline), scalar, type string', async () => {
    const session = await breakAt(35); // all storage writes folded
    const shortStr = (await stateMap(session)).get('shortStr');
    expect(shortStr, 'shortStr should be surfaced as a State variable').toBeDefined();
    expect(shortStr!.value).toBe('"hello"');
    expect(shortStr!.variablesReference).toBe(0);
    expect(shortStr!.type).toContain('string');
  });

  it('longStr → the full 36-byte UTF-8 string (long/keccak, multi-word), scalar', async () => {
    const session = await breakAt(35);
    const longStr = (await stateMap(session)).get('longStr');
    expect(longStr, 'longStr should be surfaced as a State variable').toBeDefined();
    expect(longStr!.value).toBe('"abcdefghijklmnopqrstuvwxyz0123456789"');
    expect(longStr!.variablesReference).toBe(0);
    expect(longStr!.type).toContain('string');
  });

  it('blob → 0xdeadbeef (short bytes), bare hex, scalar, type bytes', async () => {
    const session = await breakAt(35);
    const blob = (await stateMap(session)).get('blob');
    expect(blob, 'blob should be surfaced as a State variable').toBeDefined();
    expect(blob!.value).toBe('0xdeadbeef');
    expect(blob!.variablesReference).toBe(0);
    expect(blob!.type).toContain('bytes');
  });
});

// ## 3c. arr/pt keep their nested structure; the mapping is decoded in its own
//     describe below.

describe('arr/pt stay nested', () => {
  it('arr → [11,22,33] and pt → {x:5,y:6} are nested', async () => {
    const session = await breakAt(35);
    const m = await stateMap(session);

    const arr = m.get('arr');
    expect(arr, 'arr still surfaced').toBeDefined();
    expect(arr!.variablesReference, 'arr stays nested').not.toBe(0);
    const arrKids = await children(session, arr!.variablesReference);
    expect(
      arrKids.map((v) => ({name: v.name, value: v.value})),
    ).toEqual([
      {name: '0', value: '11'},
      {name: '1', value: '22'},
      {name: '2', value: '33'},
    ]);

    const pt = m.get('pt');
    expect(pt, 'pt still surfaced').toBeDefined();
    expect(pt!.variablesReference, 'pt stays nested').not.toBe(0);
    const ptKids = await children(session, pt!.variablesReference);
    expect(
      ptKids.map((v) => ({name: v.name, value: v.value})),
    ).toEqual([
      {name: 'x', value: '5'},
      {name: 'y', value: '6'},
    ]);

    // The mapping is decoded in its own describe below; this test only pins
    // that arr/pt keep their nested structure.
    const balances = m.get('balances');
    expect(balances, 'balances still listed').toBeDefined();
  });
});

// ## 4. Value-type storage decodes (Counter.number); string/bytes storage vars
//    stay scalar

describe('value-type storage decode', () => {
  it('Counter.setNumber: storage `number` decodes to 42 (scalar, ref 0)', async () => {
    const session = await launch({
      buildInfo: 'counter-build-info.json',
      trace: 'counter-setNumber-trace.raw.json',
      meta: 'counter-setNumber-meta.json',
      sourcePath: 'src/Counter.sol',
      contractName: 'Counter',
      methodName: 'setNumber',
      dialect: 'kontrol',
    });
    session.continue();
    const number = (await stateMap(session)).get('number');
    expect(number).toMatchObject({value: '42', variablesReference: 0});
  });

  it('the string/bytes reference storage vars stay scalar', async () => {
    // shortStr / longStr / blob are decoded scalars — they must not gain
    // a nested handle (stay listed, variablesReference 0). `balances` is not
    // in this list: the mapping is a nested var (asserted below).
    const session = await breakAt(35);
    const m = await stateMap(session);
    for (const name of ['shortStr', 'longStr', 'blob']) {
      const sv = m.get(name);
      expect(sv, `${name} still listed`).toBeDefined();
      expect(sv!.variablesReference, `${name} stays scalar`).toBe(0);
    }
  });
});

// The storage mapping `balances` (mapping(uint256=>uint256)) rendered
// as a nested DAP variable listing the observed entries {7: 100, 9: 250}, via
// keccak-preimage enumeration of the trace + keccak256(key‖slot) value slots.
//
// ## Trace ground truth (storagerefs-populate-trace.raw.json)
// Mapping keys are not enumerable from the storage layout — only the base slot
// (4) is static. Solidity computes a mapping entry slot as keccak256(key32‖slot32),
// so every touched entry leaves a SHA3/KECCAK256 op whose 64-byte memory preimage
// is key(32)‖baseSlot(32). Scanning size-0x40 hashes recovers the observed keys.
// 974 steps; hashes via ethereum-cryptography/keccak:
//   • idx 834: SHA3 size 0x40, offset 0 → folded mem word0=7 (key), word1=4 (slot)
//   • idx 853: SHA3 size 0x40, offset 0 → folded mem word0=9 (key), word1=4 (slot)
//   • keccak256(pad32(7)‖pad32(4)) = 0xbeb3bad7…e551 → storage 0x64 = 100
//   • keccak256(pad32(9)‖pad32(4)) = 0x4ad5a04d…b933 → storage 0xfa = 250
// The clean body pc 1064 (line 35) is own-contract step idx 874 — after both
// mapping SHA3s (834/853) — so both keys are observable there.
//
// The dereference oracle recomputes the keccak and reads storage independently
// of the decoder under test.

/** Left-pad a bigint to a 32-byte (64-hex) big-endian word (no `0x`). */
function pad32(n: bigint): string {
  return n.toString(16).padStart(64, '0');
}

/** The storage slot of `balances[key]`: keccak256(pad32(key) ‖ pad32(baseSlot)). */
function mappingValueSlot(key: bigint, baseSlot: bigint): bigint {
  const preimage = hexToBytes(pad32(key) + pad32(baseSlot));
  return BigInt('0x' + bytesToHex(keccak256(preimage)));
}

/** Own-contract (non-init) step index whose pc is `pc`, or -1. */
function ownStepIndexAtPc(pc: number): number {
  const steps = loadSteps(TRACE);
  const addr = BigInt(normAddr(metaOf(META).contractAddress));
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    if (s.isInitCode || s.codeAddress !== addr) continue;
    if (s.pc === pc) return i;
  }
  return -1;
}

// ## 5. Dereference oracle — independently recompute the value slots + read storage.

describe('dereference oracle: mapping value slots read 100/250', () => {
  it('keccak256(key‖slot4) reproduces the entry slots and reads 100 (key7) / 250 (key9)', () => {
    const index = ownStepIndexAtPc(CLEAN_PC);
    expect(index, `no own-contract step at pc ${CLEAN_PC}`).toBeGreaterThanOrEqual(0);

    const {cursor} = cursorFor(TRACE);
    const addr = normAddr(metaOf(META).contractAddress);
    const account = cursor.at(index).accounts.get(addr.toLowerCase())!;
    const readSlot = (slot: bigint): bigint => {
      const raw = account.storage['0x' + slot.toString(16)] ?? '0x0';
      return BigInt(raw.startsWith('0x') ? raw : '0x' + raw);
    };

    const slot7 = mappingValueSlot(7n, 4n);
    const slot9 = mappingValueSlot(9n, 4n);
    // The recomputed entry slots match the pinned ground truth.
    expect('0x' + slot7.toString(16)).toBe(
      '0xbeb3bad75134cb432e5707980e3245c52c5998a1125ee30f2f0dbf3925b1e551',
    );
    expect('0x' + slot9.toString(16)).toBe(
      '0x4ad5a04d53b5856f318545bb721f67d3f6d0a5a999f25eec7e20eaeb4c47b933',
    );
    // And storage at those slots holds the decoded values.
    expect(readSlot(slot7)).toBe(100n);
    expect(readSlot(slot9)).toBe(250n);
  });
});

// ## 6. Enumeration helper — recover the observed keys {7, 9} from the trace SHA3s.
//
// The helper is loaded via a runtime (non-literal) dynamic import over candidate
// modules (debugger or lifting), falling back to `undefined`, so the test stays
// type-clean wherever it is exported; the "must be defined" assertion guards
// that the export exists. The signature is
// `enumerateMappingKeys(steps, cursor, baseSlot, uptoStepIndex, storageAddress): bigint[]`.

type EnumerateFn = (
  steps: Step[],
  cursor: StateCursor,
  baseSlot: number,
  uptoStepIndex: number,
  storageAddress: bigint,
) => bigint[];

/** Find `enumerateMappingKeys` among the candidate modules. */
async function loadEnumerateMappingKeys(): Promise<EnumerateFn | undefined> {
  const candidates = [
    '../src/mappings.js',
    '../src/index.js',
    '../src/machineState.js',
    '@simbolik/lifting',
  ];
  for (const spec of candidates) {
    try {
      const mod = (await import(spec)) as Record<string, unknown>;
      const fn = mod['enumerateMappingKeys'];
      if (typeof fn === 'function') return fn as unknown as EnumerateFn;
    } catch {
      // Not exported from this candidate module — try the next.
    }
  }
  return undefined;
}

describe('enumerateMappingKeys recovers observed keys from the trace', () => {
  it('returns [7n, 9n] at the clean body pc, and is bounded by the current step', async () => {
    const enumerate = await loadEnumerateMappingKeys();
    expect(
      enumerate,
      'enumerateMappingKeys must be exported (debugger or lifting util)',
    ).toBeDefined();

    const {steps, cursor} = cursorFor(TRACE);
    const endIndex = ownStepIndexAtPc(CLEAN_PC);
    expect(endIndex, `no own-contract step at pc ${CLEAN_PC}`).toBeGreaterThanOrEqual(0);
    const own = steps[endIndex]!.targetAddress;

    // At the clean body pc both mapping SHA3s (idx 834, 853) have run → keys 7, 9
    // in first-seen order.
    expect(enumerate!(steps, cursor, 4, endIndex, own)).toEqual([7n, 9n]);

    // Bounded by the current step: before the first mapping SHA3 (idx 834) no key
    // is observable yet.
    expect(enumerate!(steps, cursor, 4, 833, own)).toEqual([]);

    // After the first SHA3 (idx 834) but before the second (idx 853): only key 7.
    expect(enumerate!(steps, cursor, 4, 840, own)).toEqual([7n]);
  });

  it('recovers an address key whose preimage word contains a-f (no-0x kontrol memory)', async () => {
    // Kontrol memory words carry no `0x` prefix, so `BigInt(word)` would parse
    // them as decimal — passing for all-digit keys (7, 9) but throwing on a key
    // with hex letters (an address). Synthesize the mapping SHA3 for
    // `balanceOf[alice]` (base slot 1) directly, with unprefixed memory words.
    const enumerate = await loadEnumerateMappingKeys();
    const alice = 0x10c6e9530f1c1af873a391030a1d9e8ed0630d26n;
    const pad = (n: bigint) => n.toString(16).padStart(64, '0'); // no `0x`
    const step: Step = {
      index: 0,
      pc: 0,
      op: 'SHA3',
      depth: 1,
      gas: 0,
      isInitCode: false,
      codeAddress: 0n,
      targetAddress: 0n,
      msgSender: 0n,
      msgValue: 0n,
      txOrigin: 0n,
      statusCode: 'ok',
      stack: ['0x40', '0x0'], // size @ len-2 = 0x40, offset @ len-1 = 0x0
      memoryChange: [pad(alice), pad(1n)] as Step['memoryChange'], // key ‖ slot
      programChange: null,
      callDataChange: null,
      returnDataChange: null,
      storageChanges: {},
      balanceChanges: {},
      nonceChanges: {},
      deployedCodeChanges: {},
      initCodeChanges: {},
    };
    const cursor = new StateCursor([step]);
    expect(enumerate!([step], cursor, 1, 0, 0n)).toEqual([alice]);
  });

  it('only lists keys hashed against the requested storage account', async () => {
    // Contracts A and B both keep a mapping at slot 4; key 7 is touched in A,
    // key 9 in B. B is reached by DELEGATECALL from A for key 11, so that hash
    // runs B's code against A's storage and belongs to A.
    const enumerate = await loadEnumerateMappingKeys();
    const A = 0xaan;
    const B = 0xbbn;
    const pad = (n: bigint) => n.toString(16).padStart(64, '0');
    const sha3 = (index: number, code: bigint, target: bigint, key: bigint): Step => ({
      index,
      pc: 0,
      op: 'SHA3',
      depth: 1,
      gas: 0,
      isInitCode: false,
      codeAddress: code,
      targetAddress: target,
      msgSender: 0n,
      msgValue: 0n,
      txOrigin: 0n,
      statusCode: 'ok',
      stack: ['0x40', '0x0'],
      memoryChange: [pad(key), pad(4n)] as Step['memoryChange'],
      programChange: null,
      callDataChange: null,
      returnDataChange: null,
      storageChanges: {},
      balanceChanges: {},
      nonceChanges: {},
      deployedCodeChanges: {},
      initCodeChanges: {},
    });
    const steps = [sha3(0, A, A, 7n), sha3(1, B, B, 9n), sha3(2, B, A, 11n)];
    const cursor = new StateCursor(steps);
    expect(enumerate!(steps, cursor, 4, 2, A)).toEqual([7n, 11n]);
    expect(enumerate!(steps, cursor, 4, 2, B)).toEqual([9n]);
  });
});

// ## 7. Session render — `balances` is a nested mapping DAP variable {7:100, 9:250}.

describe('session renders balances as a nested mapping DAP variable', () => {
  it('balances has a non-zero variablesReference; children 7=100, 9=250 (uint256)', async () => {
    const session = await breakAt(35); // line 35 = emit; both mapping SHA3s done
    expect(session.stackTrace().stackFrames[0]!.line).toBe(35);

    const balances = (await stateMap(session)).get('balances');
    expect(balances, 'balances should be surfaced as a State variable').toBeDefined();
    expect(
      balances!.variablesReference,
      'balances must be a nested mapping handle',
    ).not.toBe(0);
    // Parent summary — asserted loosely (don't over-specify the format): it should
    // surface the observed entries.
    expect(balances!.value).toContain('7');
    expect(balances!.value).toContain('100');

    const childVars = await children(session, balances!.variablesReference);
    const kids = childVars.map((v) => ({
      name: v.name,
      value: v.value,
    }));
    // First-seen order: key 7 (idx 834) then key 9 (idx 853).
    expect(kids).toEqual([
      {name: '7', value: '100'},
      {name: '9', value: '250'},
    ]);
    for (const child of childVars) {
      expect(child.type).toBe('uint256');
      expect(child.variablesReference).toBe(0);
    }
  });
});
