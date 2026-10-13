/**
 * Static variable-context producer (`variablesAt`).
 *
 * `variablesAt(cu, sourcePath, contractName, pc)` returns, from the pc alone,
 * the storage variables, the function's parameters and the in-scope locals,
 * each with a concrete ethdebug pointer (value types): stack pointers for
 * params/locals, storage pointers for state variables.
 *
 * ## The trace oracle
 * The producer is static, but its pointers are validated dynamically: for each
 * function we take the recorded kontrol-node trace, reconstruct the machine
 * state at a representative pc (via `StateCursor`), dereference each emitted
 * pointer, decode it by the variable's solc type, and compare against the
 * known value. A wrong slot/offset/length reads the wrong value, so the specs
 * check the pointers against real execution rather than a re-implementation of
 * the slot math.
 *
 * ## Why an inline oracle
 * The oracle is independent of the debugger's `machineStateFor` +
 * `@ethdebug/pointers` path. kontrol stores stack/storage words as minimal hex,
 * which `Data.fromHex` misparses when the length is odd
 * (`Data.fromHex('0x3e8').asUint()` is 15880n, not 1000n), so words must be
 * padded first; the inline oracle normalizes via `BigInt` and applies the
 * pointer's offset/length slice itself. Odd-length words such as
 * `_b` = 1000 = `0x3e8` are deliberately covered.
 *
 * {@link readPointerBytes} normalizes each word to a full 32-byte big-endian
 * hex string and slices it per location convention:
 *   - stack pointer `{slot, offset, length}`: word = `stack[len-1-slot]`;
 *     `offset` is measured from the high end (left) of the word; value types
 *     use `offset = 32 − numberOfBytes`, `bytesN` use `offset = 0`.
 *   - storage pointer `{slot, offset, length}`: word = the account's slot;
 *     `offset` is the solc storage offset, measured from the low-order byte
 *     (right).
 * {@link decodeValue} then turns the raw bytes into a display value using the
 * variable's `solcType` (signed int sign-extension, bool, address, bytesN,
 * enum).
 *
 * Known values in the recorded traces:
 *   Stepper.double v=11; Stepper.run x=10, a=11, b=22; Counter.setNumber
 *   newNumber=42, storage number=42; Vars.setAll _a=7 _b=1000 _flag=true
 *   _owner=0x..aa _delta=-5 _h=0x1122…1122 _color=Blue(2) + the 7 storage vars;
 *   Locals.compute a=11 small=7 signed=-5 flag=true who=0x..aa hash=0x..1122
 *   color=Blue(2) sum=0 tail=18, loop var i, loop-body step, nested-block inner=72.
 */
import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {loadBuildInfo, type CompilationUnit} from '@simbolik/solc';
import {parseJsonLossless} from '@simbolik/engine';
import {
  normalizeKontrolTrace,
  StateCursor,
  type MachineState,
  type Step,
} from '@simbolik/lifting';

import {variablesAt, type ResolvedVariable} from '../src/index.js';

// ## Fixtures

function loadCu(name: string): CompilationUnit {
  const url = new URL(`../../solc/test/fixtures/${name}`, import.meta.url);
  return loadBuildInfo(JSON.parse(readFileSync(url, 'utf8')));
}

function loadTrace(name: string): Step[] {
  const url = new URL(`../../debugger/test/fixtures/${name}`, import.meta.url);
  const parsed = parseJsonLossless(readFileSync(url, 'utf8')) as {result: unknown};
  return normalizeKontrolTrace(parsed.result as never);
}

function loadCodeAddress(metaName: string): string {
  const url = new URL(`../../debugger/test/fixtures/${metaName}`, import.meta.url);
  const meta = JSON.parse(readFileSync(url, 'utf8')) as {contractAddress: string};
  // Lowercase, 20-byte zero-padded: how accounts are keyed in the trace.
  return '0x' + BigInt(meta.contractAddress).toString(16).padStart(40, '0');
}

// ## The inline dereference oracle

/** The concrete pointer shape `variablesAt` emits for value types. */
interface ConcretePointer {
  location: 'stack' | 'storage';
  slot: number;
  offset: number;
  length: number;
}

/** Normalize a (possibly minimal) hex word to a 64-char big-endian hex string. */
function word32(hex: string): string {
  return BigInt(hex).toString(16).padStart(64, '0');
}

/**
 * Read the raw `length` bytes a pointer addresses, as a hex string (no `0x`),
 * against `state` (`codeAddr` = the contract account for storage reads).
 */
function readPointerBytes(
  pointer: ConcretePointer,
  state: MachineState,
  codeAddr: string,
): string {
  if (pointer.location === 'stack') {
    const raw = state.stack[state.stack.length - 1 - pointer.slot] ?? '0x0';
    const w = word32(raw);
    // Stack offset is from the high end (left) of the 32-byte word.
    return w.slice(pointer.offset * 2, (pointer.offset + pointer.length) * 2);
  }
  // Storage: offset is from the low-order byte (right) of the slot word.
  const account = state.accounts.get(codeAddr.toLowerCase());
  const key = '0x' + BigInt(pointer.slot).toString(16);
  const raw = account?.storage[key] ?? '0x0';
  const w = word32(raw);
  const start = (32 - pointer.offset - pointer.length) * 2;
  return w.slice(start, start + pointer.length * 2);
}

type Decoded = bigint | boolean | string;

/** How to interpret a variable's bytes, keyed off its solc storage-style type. */
function typeKind(solcType: string): 'uint' | 'int' | 'bool' | 'address' | 'bytes' | 'enum' {
  if (solcType === 't_bool') return 'bool';
  if (solcType === 't_address' || solcType === 't_contract') return 'address';
  if (/^t_int\d+$/.test(solcType)) return 'int';
  if (/^t_bytes\d+$/.test(solcType)) return 'bytes'; // fixed bytesN only
  if (solcType.startsWith('t_enum')) return 'enum';
  return 'uint';
}

/** Decode raw `hexSlice` (the pointer's `length` bytes) to a display value. */
function decodeValue(hexSlice: string, solcType: string, numberOfBytes: number): Decoded {
  const u = hexSlice === '' ? 0n : BigInt('0x' + hexSlice);
  switch (typeKind(solcType)) {
    case 'uint':
    case 'enum':
      return u;
    case 'bool':
      return u === 1n;
    case 'address':
      return '0x' + u.toString(16).padStart(40, '0');
    case 'bytes':
      return '0x' + hexSlice.padEnd(numberOfBytes * 2, '0');
    case 'int': {
      const bits = BigInt(numberOfBytes * 8);
      const signBit = 1n << (bits - 1n);
      return u >= signBit ? u - (1n << bits) : u;
    }
  }
}

/**
 * The oracle: dereference a ResolvedVariable's pointer against `state` and
 * decode it. Fails if the variable carries no pointer.
 */
function readVariable(v: ResolvedVariable, state: MachineState, codeAddr: string): Decoded {
  expect(v.pointer, `variable ${v.name} has no pointer to dereference`).toBeDefined();
  return decodeValue(
    readPointerBytes(v.pointer as unknown as ConcretePointer, state, codeAddr),
    v.solcType,
    v.numberOfBytes,
  );
}

// ## Per-scenario harness

interface Scenario {
  buildInfo: string;
  sourcePath: string;
  contractName: string;
  trace: string;
  meta: string;
}

interface Prepared {
  cu: CompilationUnit;
  sourcePath: string;
  contractName: string;
  steps: Step[];
  cursor: StateCursor;
  codeAddr: string;
}

function prepare(s: Scenario): Prepared {
  const cu = loadCu(s.buildInfo);
  const steps = loadTrace(s.trace);
  return {
    cu,
    sourcePath: s.sourcePath,
    contractName: s.contractName,
    steps,
    cursor: new StateCursor(steps),
    codeAddr: loadCodeAddress(s.meta),
  };
}

/** MachineState at the `occurrence`-th own-contract step whose pc is `pc`. */
function stateAtPc(p: Prepared, pc: number, occurrence = 0): MachineState {
  let seen = 0;
  for (let i = 0; i < p.steps.length; i++) {
    const step = p.steps[i]!;
    if (step.isInitCode || step.codeAddress !== BigInt(p.codeAddr)) continue;
    if (step.pc === pc) {
      if (seen === occurrence) return p.cursor.at(i);
      seen++;
    }
  }
  throw new Error(`no own-contract step at pc ${pc} occurrence ${occurrence}`);
}

/** The final state (all SSTOREs applied), for storage value checks. */
function finalState(p: Prepared): MachineState {
  return p.cursor.at(p.steps.length - 1);
}

function vars(p: Prepared, pc: number): ResolvedVariable[] {
  return variablesAt(p.cu, p.sourcePath, p.contractName, pc);
}

function byName(list: ResolvedVariable[]): Map<string, ResolvedVariable> {
  return new Map(list.map((v) => [v.name, v]));
}

const STEPPER: Scenario = {
  buildInfo: 'stepper-build-info.json',
  sourcePath: 'src/Stepper.sol',
  contractName: 'Stepper',
  trace: 'stepper-run-trace.raw.json',
  meta: 'stepper-run-meta.json',
};
const COUNTER: Scenario = {
  buildInfo: 'counter-build-info.json',
  sourcePath: 'src/Counter.sol',
  contractName: 'Counter',
  trace: 'counter-setNumber-trace.raw.json',
  meta: 'counter-setNumber-meta.json',
};
const VARS: Scenario = {
  buildInfo: 'vars-build-info.json',
  sourcePath: 'src/Vars.sol',
  contractName: 'Vars',
  trace: 'vars-setall-trace.raw.json',
  meta: 'vars-setall-meta.json',
};
const LOCALS: Scenario = {
  buildInfo: 'locals-build-info.json',
  sourcePath: 'src/Locals.sol',
  contractName: 'Locals',
  trace: 'locals-compute-trace.raw.json',
  meta: 'locals-compute-meta.json',
};
const RETURNS: Scenario = {
  buildInfo: 'returns-build-info.json',
  sourcePath: 'src/Returns.sol',
  contractName: 'Returns',
  trace: 'returns-calc-trace.raw.json',
  meta: 'returns-calc-meta.json',
};

/** `kind` as a plain string, for loose comparisons. */
function kindOf(v: ResolvedVariable): string {
  return v.kind as string;
}

// ## Parameters dereference to their recorded values

describe('variablesAt — parameters resolve to correct dereferenced values', () => {
  it('Stepper.double: v (parameter) reads 11 in the body', () => {
    const p = prepare(STEPPER);
    const list = vars(p, 171); // double body, line 14
    const v = byName(list).get('v')!;
    expect(v).toMatchObject({kind: 'parameter', isValueType: true});
    expect(readVariable(v, stateAtPc(p, 171), p.codeAddr)).toBe(11n);
  });

  it('Stepper.run: x (parameter) reads 10 at every body statement', () => {
    const p = prepare(STEPPER);
    for (const pc of [120, 136, 148]) {
      // line 8 / 9 / 10
      const x = byName(vars(p, pc)).get('x')!;
      expect(x).toMatchObject({kind: 'parameter', isValueType: true});
      expect(readVariable(x, stateAtPc(p, pc), p.codeAddr)).toBe(10n);
    }
  });

  it('Counter.setNumber: newNumber (parameter) reads 42', () => {
    const p = prepare(COUNTER);
    const nn = byName(vars(p, 136)).get('newNumber')!;
    expect(nn).toMatchObject({kind: 'parameter', isValueType: true});
    expect(readVariable(nn, stateAtPc(p, 136), p.codeAddr)).toBe(42n);
  });

  it('Locals.compute: seed (parameter) reads 10 despite the reserved return slot', () => {
    // `compute` is public and `returns (uint256)`, so the prologue reserves a
    // stack slot for the return value between the params and the locals. If
    // that slot is not accounted for, `seed` (param rank 0) reads the
    // zero-initialised return slot instead of 10. The locals stay correct
    // either way (the frame base absorbs the offset), so only a param read
    // catches this.
    const p = prepare(LOCALS);
    const seed = byName(vars(p, 436)).get('seed')!;
    expect(seed).toMatchObject({kind: 'parameter', isValueType: true});
    expect(readVariable(seed, stateAtPc(p, 436), p.codeAddr)).toBe(10n);
  });

  it('Vars.setAll: all 7 value params read their recorded values', () => {
    const p = prepare(VARS);
    const state = stateAtPc(p, 474); // line 24, params still live
    const m = byName(vars(p, 474));
    expect(readVariable(m.get('_a')!, state, p.codeAddr)).toBe(7n);
    expect(readVariable(m.get('_b')!, state, p.codeAddr)).toBe(1000n);
    expect(readVariable(m.get('_flag')!, state, p.codeAddr)).toBe(true);
    expect(readVariable(m.get('_owner')!, state, p.codeAddr)).toBe(
      '0x00000000000000000000000000000000000000aa',
    );
    expect(readVariable(m.get('_delta')!, state, p.codeAddr)).toBe(-5n);
    expect(readVariable(m.get('_h')!, state, p.codeAddr)).toBe(
      '0x1122334455667788990011223344556677889900112233445566778899001122',
    );
    expect(readVariable(m.get('_color')!, state, p.codeAddr)).toBe(2n); // Blue
    // Every param carries kind 'parameter'.
    for (const name of ['_a', '_b', '_flag', '_owner', '_delta', '_h', '_color']) {
      expect(m.get(name)!.kind).toBe('parameter');
    }
  });
});

// ## Locals dereference correctly, including scope + rank accounting

describe('variablesAt — Locals.compute locals resolve correctly', () => {
  it('value locals read their live values at an in-scope pc (line 37)', () => {
    const p = prepare(LOCALS);
    const state = stateAtPc(p, 436);
    const m = byName(vars(p, 436));
    expect(readVariable(m.get('a')!, state, p.codeAddr)).toBe(11n);
    expect(readVariable(m.get('small')!, state, p.codeAddr)).toBe(7n);
    expect(readVariable(m.get('signed')!, state, p.codeAddr)).toBe(-5n);
    expect(readVariable(m.get('flag')!, state, p.codeAddr)).toBe(true);
    expect(readVariable(m.get('who')!, state, p.codeAddr)).toBe(
      '0x00000000000000000000000000000000000000aa',
    );
    expect(readVariable(m.get('hash')!, state, p.codeAddr)).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000001122',
    );
    expect(readVariable(m.get('color')!, state, p.codeAddr)).toBe(2n); // Blue
    expect(readVariable(m.get('sum')!, state, p.codeAddr)).toBe(0n);
    for (const name of ['a', 'small', 'signed', 'flag', 'who', 'hash', 'color', 'sum']) {
      expect(m.get(name)!.kind).toBe('local');
    }
  });

  it('a value local declared AFTER reference locals reads correctly (rank accounting)', () => {
    // `tail` follows nums/label/pt (reference types). Reading it as 18 shows the
    // reference locals' stack slots were counted when ranking `tail`.
    const p = prepare(LOCALS);
    const m = byName(vars(p, 436));
    const tail = m.get('tail')!;
    expect(tail).toMatchObject({kind: 'local', isValueType: true});
    expect(readVariable(tail, stateAtPc(p, 436), p.codeAddr)).toBe(18n);
  });

  it('reference-type locals are listed as isValueType:false with no pointer', () => {
    const p = prepare(LOCALS);
    const m = byName(vars(p, 436));
    for (const name of ['nums', 'label', 'pt']) {
      const ref = m.get(name)!;
      expect(ref.kind).toBe('local');
      expect(ref.isValueType).toBe(false);
      expect(ref.pointer).toBeUndefined();
    }
  });

  it('the loop var + loop-body local are live inside the loop (2nd iteration)', () => {
    const p = prepare(LOCALS);
    // pc 573 = `sum = sum + step;` body; occurrence 1 = 2nd iteration (i=1).
    const state = stateAtPc(p, 573, 1);
    const m = byName(vars(p, 573));
    expect(readVariable(m.get('i')!, state, p.codeAddr)).toBe(1n);
    expect(readVariable(m.get('step')!, state, p.codeAddr)).toBe(12n); // i + a = 1 + 11
    expect(m.get('i')!.kind).toBe('local');
    expect(m.get('step')!.kind).toBe('local');
  });

  it('the nested-block local reads its value in scope (line 48)', () => {
    const p = prepare(LOCALS);
    const inner = byName(vars(p, 625)).get('inner')!;
    expect(inner).toMatchObject({kind: 'local', isValueType: true});
    expect(readVariable(inner, stateAtPc(p, 625), p.codeAddr)).toBe(72n);
  });

  it('locals are ABSENT once their scope has closed', () => {
    const p = prepare(LOCALS);
    // pc 640 = line 51, after the for-loop and the nested block have both closed.
    const names = new Set(vars(p, 640).map((v) => v.name));
    for (const gone of ['i', 'step', 'inner']) {
      expect(names.has(gone), `${gone} should be out of scope`).toBe(false);
    }
    // A function-body local declared earlier is still live here.
    const tail = byName(vars(p, 640)).get('tail')!;
    expect(readVariable(tail, stateAtPc(p, 640), p.codeAddr)).toBe(18n);
  });
});

// ## Storage variables are always present and resolve to their values

describe('variablesAt — storage variables', () => {
  it('Counter.setNumber: storage `number` present and reads 42 after the write', () => {
    const p = prepare(COUNTER);
    const number = byName(vars(p, 136)).get('number')!;
    expect(number).toMatchObject({kind: 'storage'});
    expect(number.pointer).toMatchObject({location: 'storage', slot: 0});
    expect(readVariable(number, finalState(p), p.codeAddr)).toBe(42n);
  });

  it('Vars.setAll: all 7 storage vars present and resolve to their values', () => {
    const p = prepare(VARS);
    const list = vars(p, 474);
    const m = byName(list);
    for (const name of ['a', 'b', 'flag', 'owner', 'delta', 'h', 'color']) {
      const sv = m.get(name)!;
      expect(sv.kind, `${name} kind`).toBe('storage');
      expect((sv.pointer as unknown as ConcretePointer).location).toBe('storage');
    }
    const state = finalState(p);
    expect(readVariable(m.get('a')!, state, p.codeAddr)).toBe(7n);
    expect(readVariable(m.get('b')!, state, p.codeAddr)).toBe(1000n);
    expect(readVariable(m.get('flag')!, state, p.codeAddr)).toBe(true);
    expect(readVariable(m.get('owner')!, state, p.codeAddr)).toBe(
      '0x00000000000000000000000000000000000000aa',
    );
    expect(readVariable(m.get('delta')!, state, p.codeAddr)).toBe(-5n);
    expect(readVariable(m.get('h')!, state, p.codeAddr)).toBe(
      '0x1122334455667788990011223344556677889900112233445566778899001122',
    );
    expect(readVariable(m.get('color')!, state, p.codeAddr)).toBe(2n); // Blue
  });
});

// ## Kind, ordering, and reference handling

describe('variablesAt — kind, ordering & structure', () => {
  it('parameters precede locals, each in declaration order', () => {
    const p = prepare(LOCALS);
    const list = vars(p, 436);
    const params = list.filter((v) => v.kind === 'parameter').map((v) => v.name);
    const locals = list.filter((v) => v.kind === 'local').map((v) => v.name);

    expect(params).toEqual(['seed']);
    // Locals appear in declaration order, reference locals included (rank slots).
    expect(locals).toEqual([
      'a', 'small', 'signed', 'flag', 'who', 'hash', 'color', 'sum',
      'nums', 'label', 'pt', 'tail',
    ]);

    // Every parameter comes before every local in the returned array.
    const firstLocal = list.findIndex((v) => v.kind === 'local');
    const lastParam = list.map((v) => v.kind).lastIndexOf('parameter');
    expect(lastParam).toBeLessThan(firstLocal);
  });

  it('storage entries carry storage pointers; stack vars carry stack pointers', () => {
    const p = prepare(VARS);
    for (const v of vars(p, 474)) {
      const loc = (v.pointer as unknown as ConcretePointer | undefined)?.location;
      if (v.kind === 'storage') expect(loc).toBe('storage');
      if (v.kind === 'parameter') expect(loc).toBe('stack');
    }
  });
});

// ## Purely static signature

describe('variablesAt — pure static signature (zero runtime facts)', () => {
  it('takes exactly (cu, sourcePath, contractName, pc) — no trace/height input', () => {
    expect(typeof variablesAt).toBe('function');
    expect(variablesAt).toHaveLength(4);
  });
});

// ## A pc with no enclosing function returns storage-only, never throws

describe('variablesAt — dispatcher / helper pc', () => {
  it('pc 0 (dispatcher, no enclosing function) returns storage-only', () => {
    const p = prepare(COUNTER);
    let list: ResolvedVariable[] = [];
    expect(() => {
      list = vars(p, 0);
    }).not.toThrow();
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((v) => v.kind === 'storage')).toBe(true);
    expect(byName(list).get('number')).toBeDefined();
  });
});

// Return parameters (value types), external and internal entry
//
// `Returns.calc(5)` → doubled=10, tmp=helper(5)=12, tripled=17, stored=27;
// internally `helper(5)` → y=5, local=6, out=12. solc lays a function's stack
// variables out as [ params ][ return params ][ locals ]: the return params are
// zero-initialised slots reserved at entry, between the input params and the
// body locals. The producer emits those return params as `kind:'return'`
// variables in that order, for both external (`calc`) and internal (`helper`)
// entry.
//
// Clean body statement pcs (first pc of each statement, no expression
// temporaries live), from the recorded trace:
//   calc:   pc 153 = line 9  `uint256 tmp = helper(x);` START (tmp not yet live;
//                             tripled reserved=0; doubled=10; x=5)
//           pc 165 = line 10 `tripled = tmp + x;`      START (tripled reserved=0;
//                             tmp=12; doubled=10; x=5)
//           pc 179 = line 11 `stored = doubled+tripled;` START (all assigned:
//                             x=5, doubled=10, tripled=17, tmp=12; stored not yet)
//   helper: pc 224 = line 16 `out = local * 2;`  START (out reserved=0; local=6;
//                             y=5)
//           pc 239 = line 17 `return out;`       START (y=5, out=12, local=6)
// The stack layout at pc 179 (top→bottom) is
//   [tmp=12, tripled=17, doubled=10, x=5, …]  ⇒ order [x, doubled, tripled, tmp];
// at pc 239 (top→bottom) [local=6, out=12, y=5, retAddr, …] ⇒ [y, out, local].

describe('variablesAt — return parameters (external: Returns.calc)', () => {
  it('emits doubled & tripled as kind "return" between the param and the local', () => {
    // pc 179 (line 11): every stack variable is assigned its final value.
    const p = prepare(RETURNS);
    const state = stateAtPc(p, 179);
    const m = byName(vars(p, 179));

    const x = m.get('x')!;
    const doubled = m.get('doubled')!;
    const tripled = m.get('tripled')!;
    const tmp = m.get('tmp')!;

    // Kinds: the param is 'parameter', the two return values are 'return',
    // the body variable is 'local'.
    expect(kindOf(x)).toBe('parameter');
    expect(kindOf(doubled)).toBe('return');
    expect(kindOf(tripled)).toBe('return');
    expect(kindOf(tmp)).toBe('local');

    // Return params are value types with a concrete stack pointer.
    expect(doubled.isValueType).toBe(true);
    expect(tripled.isValueType).toBe(true);
    expect(doubled.solcType).toBe('t_uint256');
    expect(tripled.solcType).toBe('t_uint256');

    // The oracle dereferences each emitted pointer to its recorded value.
    expect(readVariable(x, state, p.codeAddr)).toBe(5n);
    expect(readVariable(doubled, state, p.codeAddr)).toBe(10n);
    expect(readVariable(tripled, state, p.codeAddr)).toBe(17n);
    expect(readVariable(tmp, state, p.codeAddr)).toBe(12n);
  });

  it('orders the stack vars [param → returns → local] in decl order', () => {
    // The emitted order (params, then return params, then locals) matches
    // solc's stack layout and the slot assignment.
    const p = prepare(RETURNS);
    const stackVars = vars(p, 179).filter((v) => kindOf(v) !== 'storage');
    expect(stackVars.map((v) => v.name)).toEqual(['x', 'doubled', 'tripled', 'tmp']);
    expect(stackVars.map((v) => kindOf(v))).toEqual([
      'parameter',
      'return',
      'return',
      'local',
    ]);
    // Every return sits after every parameter and before every local.
    const kinds = stackVars.map((v) => kindOf(v));
    const lastParam = kinds.lastIndexOf('parameter');
    const firstReturn = kinds.indexOf('return');
    const lastReturn = kinds.lastIndexOf('return');
    const firstLocal = kinds.indexOf('local');
    expect(lastParam).toBeLessThan(firstReturn);
    expect(lastReturn).toBeLessThan(firstLocal);
  });

  it('a return param reads its reserved 0 before its assignment (pc 165, line 10)', () => {
    // At line 10 `tripled` has not been assigned yet (its reserved slot holds
    // 0), while `doubled` (line 8) and `tmp` (line 9) are live and assigned.
    const p = prepare(RETURNS);
    const state = stateAtPc(p, 165);
    const m = byName(vars(p, 165));
    const tripled = m.get('tripled')!;
    expect(kindOf(tripled)).toBe('return');
    expect(readVariable(tripled, state, p.codeAddr)).toBe(0n); // reserved, unassigned
    expect(readVariable(m.get('doubled')!, state, p.codeAddr)).toBe(10n);
    expect(readVariable(m.get('tmp')!, state, p.codeAddr)).toBe(12n);
    expect(readVariable(m.get('x')!, state, p.codeAddr)).toBe(5n);
  });

  it('return params are present before the local is declared (pc 153, line 9)', () => {
    // At line 9 `tmp` is not yet declared (absent), but both return slots are
    // already reserved: doubled=10 (line 8 done), tripled=0 (not yet assigned).
    const p = prepare(RETURNS);
    const state = stateAtPc(p, 153);
    const m = byName(vars(p, 153));
    expect(m.has('tmp')).toBe(false); // local not yet live
    expect(kindOf(m.get('doubled')!)).toBe('return');
    expect(kindOf(m.get('tripled')!)).toBe('return');
    expect(readVariable(m.get('doubled')!, state, p.codeAddr)).toBe(10n);
    expect(readVariable(m.get('tripled')!, state, p.codeAddr)).toBe(0n);
    expect(readVariable(m.get('x')!, state, p.codeAddr)).toBe(5n);
  });

  it('storage `stored` is present (kind storage) and reads 27 at the end', () => {
    const p = prepare(RETURNS);
    const stored = byName(vars(p, 179)).get('stored')!;
    expect(stored.kind).toBe('storage');
    expect((stored.pointer as unknown as ConcretePointer).location).toBe('storage');
    expect(readVariable(stored, finalState(p), p.codeAddr)).toBe(27n);
  });
});

describe('variablesAt — internal return slot (Returns.helper)', () => {
  it('helper (INTERNAL) resolves y, out (return) AND local — all correct (pc 239)', () => {
    // An internal function that reserves a return slot: if the reserved `out`
    // slot is not accounted for, `local` reads `out`'s word (12) instead of 6.
    // All three dereference through the [y][out][local] layout
    // ([params][returns][locals] holds for internal entry too).
    const p = prepare(RETURNS);
    const state = stateAtPc(p, 239);
    const m = byName(vars(p, 239));

    const y = m.get('y')!;
    const out = m.get('out')!;
    const local = m.get('local')!;

    expect(kindOf(y)).toBe('parameter');
    expect(kindOf(out)).toBe('return');
    expect(kindOf(local)).toBe('local');

    expect(readVariable(y, state, p.codeAddr)).toBe(5n);
    expect(readVariable(out, state, p.codeAddr)).toBe(12n);
    expect(readVariable(local, state, p.codeAddr)).toBe(6n); // not 12 (the out slot)
  });

  it('internal helper ordering is [y(param), out(return), local(local)]', () => {
    const p = prepare(RETURNS);
    const stackVars = vars(p, 239).filter((v) => kindOf(v) !== 'storage');
    expect(stackVars.map((v) => v.name)).toEqual(['y', 'out', 'local']);
    expect(stackVars.map((v) => kindOf(v))).toEqual(['parameter', 'return', 'local']);
  });

  it('internal return slot reads its reserved 0 before assignment (pc 224, line 16)', () => {
    // At line 16 `out` is not yet assigned; `local` (line 15) is already 6, so
    // `local` is read from its own slot, not the reserved return slot.
    const p = prepare(RETURNS);
    const state = stateAtPc(p, 224);
    const m = byName(vars(p, 224));
    expect(kindOf(m.get('out')!)).toBe('return');
    expect(readVariable(m.get('out')!, state, p.codeAddr)).toBe(0n); // reserved
    expect(readVariable(m.get('local')!, state, p.codeAddr)).toBe(6n);
    expect(readVariable(m.get('y')!, state, p.codeAddr)).toBe(5n);
  });
});

// A value-type memory struct local as a nested variable
//
// `Locals.compute(10)` has `struct Point { uint256 x; uint256 y; }` and the
// local `Point memory pt = Point(a, small)` = `Point(11, 7)`. `variablesAt`
// carries `pt`'s member layout: a `members` array of per-member descriptors
// (`{name, typeLabel, solcType, numberOfBytes, pointer}`), each with a concrete
// ethdebug pointer built from the struct's memory offset (read from pt's stack
// slot) plus the member's 32-byte word offset. The pointers are dereferenced
// through `@ethdebug/pointers` in the debugger suite (`structs.test.ts`); here
// we pin the static producer shape only.
//
// `nums` (uint256[]) and `label` (string) are listed (they consume a stack
// rank) but with no members and no pointer.
//
// From the trace (locals-compute-trace.raw.json, pc 436 = line 37 `require`,
// the first clean body statement after pt is assigned): pt's stack slot holds
// memory offset 0x120 (=288); memory[288..320]=11 (x), memory[320..352]=7 (y).

/** The per-member descriptor under `ResolvedVariable.members`. */
interface StructMemberShape {
  name: string;
  typeLabel: string;
  solcType: string;
  numberOfBytes: number;
  pointer?: unknown;
}

/** Loose accessor for the `members` field. */
function membersOf(v: ResolvedVariable): StructMemberShape[] | undefined {
  return (v as unknown as {members?: StructMemberShape[]}).members;
}

describe('variablesAt — value-type memory struct (nested members)', () => {
  it('pt exposes members x and y (uint256) with per-member pointers', () => {
    const p = prepare(LOCALS);
    const pt = byName(vars(p, 436)).get('pt')!;

    // The struct stays a nested variable: no scalar pointer of its own.
    expect(pt.kind).toBe('local');
    expect(pt.isValueType).toBe(false);
    expect(pt.pointer).toBeUndefined();
    expect(pt.typeLabel).toContain('Point');

    const members = membersOf(pt);
    expect(members, 'pt must carry a members array').toBeDefined();
    expect(members!.map((m) => m.name)).toEqual(['x', 'y']);
    for (const m of members!) {
      expect(m.solcType).toBe('t_uint256');
      expect(m.typeLabel).toContain('uint256');
      expect(m.numberOfBytes).toBe(32);
      expect(m.pointer, `member ${m.name} needs a concrete pointer`).toBeDefined();
    }
  });

  it('nums and label are NOT structs: no `members` field (decoded via array/bytes)', () => {
    // nums/label are decoded via array/bytes (see below), not via the
    // struct-only `members` field.
    const p = prepare(LOCALS);
    const m = byName(vars(p, 436));
    for (const name of ['nums', 'label']) {
      const ref = m.get(name)!;
      expect(ref.kind).toBe('local');
      expect(ref.isValueType).toBe(false);
      expect(ref.pointer).toBeUndefined();
      expect(membersOf(ref), `${name} is not a struct`).toBeUndefined();
    }
  });
});

// Dynamic memory array (nums) and memory string (label) as producer
// structures
//
// `Locals.compute(10)`:
//   `uint256[] memory nums = new uint256[](2); nums[0] = a;`  → [11, 0]
//   `string  memory label = "hi";`                            → "hi" (0x6869)
//
// Both are memory reference locals whose stack slot holds a memory offset. At
// pc 436 (line 37, the first `require`, a clean body stmt after both are set),
// from the recorded trace (locals-compute-trace.raw.json):
//   nums:  stack depth 3 → memory offset 0x80 (=128); mem[128]=len 2;
//          mem[160]=nums[0]=11; mem[192]=nums[1]=0.
//   label: stack depth 2 → memory offset 0xe0 (=224); mem[224]=len 2;
//          mem[256]=bytes 0x6869 ("hi").
//
// Producer shape (dereferenced through `@ethdebug/pointers` in the debugger
// suite, `arrays.test.ts`):
//   - A dynamic array carries an `array` field: `{pointer, elementSolcType,
//     elementTypeLabel, elementNumberOfBytes}`. `pointer` is a dereferenceable
//     `Group` that defines named regions `base` (the stack slot = the memory
//     offset) and `len` (the memory word at `base` = the count), then a `List`
//     whose element region is named `'element'`, so the consumer collects the
//     elements via `regions.named('element')`. The variable itself stays
//     `isValueType:false` with no top-level pointer and no `members`.
//   - A memory string/bytes carries a `bytes` field: `{pointer, isString}`.
//     `pointer` is a `Group` (`base`/`len` named regions, then the raw byte
//     region of dynamic `length: {$read:'len'}` at `base+32`); its final region
//     is the raw bytes. `isString` is true for `string`, false for `bytes`.

/** The `array` field under `ResolvedVariable` (read loosely). */
interface ArrayShape {
  pointer?: unknown;
  elementSolcType: string;
  elementTypeLabel: string;
  elementNumberOfBytes: number;
}
function arrayOf(v: ResolvedVariable): ArrayShape | undefined {
  return (v as unknown as {array?: ArrayShape}).array;
}

/** The `bytes` field under `ResolvedVariable` (read loosely). */
interface BytesShape {
  pointer?: unknown;
  isString: boolean;
}
function bytesOf(v: ResolvedVariable): BytesShape | undefined {
  return (v as unknown as {bytes?: BytesShape}).bytes;
}

describe('variablesAt — dynamic memory array + string (producer shape)', () => {
  it('nums carries an `array` structure (uint256 elements) with a deref pointer', () => {
    const p = prepare(LOCALS);
    const nums = byName(vars(p, 436)).get('nums')!;

    // The array stays a nested variable: no scalar pointer, no members.
    expect(nums.kind).toBe('local');
    expect(nums.isValueType).toBe(false);
    expect(nums.pointer).toBeUndefined();
    expect(membersOf(nums)).toBeUndefined();
    expect(nums.typeLabel).toContain('uint256');
    expect(nums.typeLabel).toContain('[');

    const arr = arrayOf(nums);
    expect(arr, 'nums must carry an array structure').toBeDefined();
    expect(arr!.pointer, 'the array needs a concrete List pointer').toBeDefined();
    expect(arr!.elementSolcType).toBe('t_uint256');
    expect(arr!.elementTypeLabel).toContain('uint256');
    expect(arr!.elementNumberOfBytes).toBe(32);
    // Not a string.
    expect(bytesOf(nums)).toBeUndefined();
  });

  it('label carries a `bytes` structure flagged as a string, with a deref pointer', () => {
    const p = prepare(LOCALS);
    const label = byName(vars(p, 436)).get('label')!;

    expect(label.kind).toBe('local');
    expect(label.isValueType).toBe(false);
    expect(label.pointer).toBeUndefined();
    expect(membersOf(label)).toBeUndefined();
    expect(label.typeLabel).toContain('string');

    const b = bytesOf(label);
    expect(b, 'label must carry a bytes structure').toBeDefined();
    expect(b!.pointer, 'the string needs a concrete byte pointer').toBeDefined();
    expect(b!.isString).toBe(true);
    // Not an array.
    expect(arrayOf(label)).toBeUndefined();
  });

  it('pt carries struct members, no array/bytes', () => {
    const p = prepare(LOCALS);
    const pt = byName(vars(p, 436)).get('pt')!;
    const members = membersOf(pt);
    expect(members, 'pt must still carry struct members').toBeDefined();
    expect(members!.map((m) => m.name)).toEqual(['x', 'y']);
    expect(arrayOf(pt)).toBeUndefined();
    expect(bytesOf(pt)).toBeUndefined();
  });

  it('value locals are unaffected by array/string decoding (tail still 18)', () => {
    const p = prepare(LOCALS);
    const m = byName(vars(p, 436));
    const tail = m.get('tail')!;
    expect(tail.isValueType).toBe(true);
    expect(readVariable(tail, stateAtPc(p, 436), p.codeAddr)).toBe(18n);
    expect(arrayOf(tail)).toBeUndefined();
    expect(bytesOf(tail)).toBeUndefined();
  });
});

describe('variablesAt — unnamed returns reserve a slot but emit no var', () => {
  it('Stepper.double (returns (uint256), unnamed): v reads 11, no "return" var', () => {
    // An unnamed return reserves a stack slot (so params/locals still rank past
    // it) but is not a named variable: nothing of kind 'return' is emitted, and
    // the param `v` still dereferences to 11.
    const p = prepare(STEPPER);
    const list = vars(p, 171); // double body, line 14
    const v = byName(list).get('v')!;
    expect(v).toMatchObject({kind: 'parameter', isValueType: true});
    expect(readVariable(v, stateAtPc(p, 171), p.codeAddr)).toBe(11n);
    // No spurious unnamed-return variable.
    expect(list.filter((r) => kindOf(r) === 'return')).toEqual([]);
  });
});
