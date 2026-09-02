/**
 * Static per-pc stack-height analyzer (`stackHeights`).
 *
 * These specs pin the PURE-STATIC analyzer against a trace-derived VALIDATION
 * ORACLE: the static frame-relative heights it computes from solc artifacts
 * alone MUST reproduce what the recorded kontrol-node traces actually observed.
 *
 * `frameRelHeight(pc)` = net stack slots pushed since the enclosing function
 * body's entry instruction (0 at entry); `undefined` for pcs outside any
 * analyzed function body (dispatcher / metadata / compiler-generated helpers
 * that have no `FunctionDefinition` in source).
 *
 * ── The oracle (how correctness is defined here) ──────────────────────────────
 * For a recorded trace we:
 *   1. Keep only steps executing THIS contract's runtime code (`codeAddress`
 *      matches, non-init).
 *   2. ATTRIBUTE each step to a `FunctionDefinition` exactly the way the analyzer
 *      must: source-map entry at the step's pc → `findInnermostNode` over that
 *      file's AST → `closestFunction`. Steps whose innermost node is not inside a
 *      `FunctionDefinition` (dispatcher, ABI (de)coders, checked-arith helpers)
 *      attribute to no function and are excluded.
 *   3. For each function, the ENTRY step is the FIRST (lowest trace index) step
 *      attributed to it — for the internal `double` this is the JUMPDEST landing
 *      (`Stepper` step 180, pc 169, stack length 7); for `run`/`compute` it is
 *      the body-entry JUMPDEST (pc 86).
 *   4. observed `frameRelHeight(step) = stackLen(step) − stackLen(entryStep)`.
 *      Stack lengths are dialect-agnostic — kontrol op-name quirks (PUSHZERO for
 *      PUSH0, EVMOR for OR) never change stack DEPTH, so they do not matter here.
 * Building `pc → observed height` per function must be CONSISTENT: a pc reached
 * at two different observed heights would be a real CFG signal (a bug), so we
 * assert consistency. Then the analyzer must agree at EVERY attributed body pc.
 *
 * API under test: `stackHeights(cu, sourcePath,
 * contractName) -> { frameRelHeightAt(pc): number | undefined }`. The analyzer
 * needs the contract's runtime bytecode + source map AND the per-source AST
 * (reached via `cu.sourceById(fileId).ast()`), so it takes the CompilationUnit
 * plus the contract identity — mirroring `generateEthdebugProgram`.
 *
 * `stackHeights` is exported and its per-pc heights agree with the oracle.
 */
import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {
  closestFunction,
  findInnermostNode,
  loadBuildInfo,
  sourceMapEntryAtPc,
  type CompilationUnit,
  type Contract,
} from '@simbolik/solc';
import {parseJsonLossless} from '@simbolik/engine';
import {normalizeKontrolTrace, type Step} from '@simbolik/lifting';

import {stackHeights} from '../src/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function loadCu(name: string): CompilationUnit {
  const url = new URL(`../../solc/test/fixtures/${name}`, import.meta.url);
  return loadBuildInfo(JSON.parse(readFileSync(url, 'utf8')));
}

/** Parse a raw `debug_traceTransaction` JSON-RPC response into `Step[]`. */
function loadTrace(name: string): Step[] {
  const url = new URL(`../../debugger/test/fixtures/${name}`, import.meta.url);
  const parsed = parseJsonLossless(readFileSync(url, 'utf8')) as {
    result: unknown;
  };
  return normalizeKontrolTrace(parsed.result as never);
}

function loadCodeAddress(metaName: string): bigint {
  const url = new URL(`../../debugger/test/fixtures/${metaName}`, import.meta.url);
  const meta = JSON.parse(readFileSync(url, 'utf8')) as {contractAddress: string};
  return BigInt(meta.contractAddress);
}

// ---------------------------------------------------------------------------
// Oracle: attribute pcs to functions and derive observed frame-rel heights
// ---------------------------------------------------------------------------

/** Attribute a runtime pc to its enclosing `FunctionDefinition`, if any. */
function attributeFunction(
  cu: CompilationUnit,
  contract: Contract,
  pc: number,
): {id: number; name: string} | undefined {
  const entry = sourceMapEntryAtPc(contract, pc, 'runtime');
  if (entry === undefined || entry.fileId < 0) {
    return undefined;
  }
  const source = cu.sourceById(entry.fileId);
  if (source === undefined) {
    return undefined;
  }
  const node = findInnermostNode(source.ast(), entry.start, entry.length);
  if (node === undefined) {
    return undefined;
  }
  const fn = closestFunction(node);
  if (fn === undefined) {
    return undefined;
  }
  return {id: fn.id, name: fn.name ?? ''};
}

interface FnOracle {
  /** FunctionDefinition AST id. */
  id: number;
  name: string;
  /** First-executed (entry) step's pc and stack length. */
  entryPc: number;
  entryStackLen: number;
  /** pc → observed frameRelHeight (net growth since entry). */
  heights: Map<number, number>;
  /** pc → number of times a step at that pc was observed (loop detection). */
  visits: Map<number, number>;
  /** Any pc seen at two different heights (must stay empty). */
  conflicts: Array<{pc: number; had: number; got: number; step: number}>;
}

/**
 * Build a per-function oracle from a trace: group own-contract steps by their
 * attributed function, take the first step as the entry, and record
 * `pc → stackLen − entryStackLen`, flagging any inconsistent pc.
 */
function buildOracle(
  cu: CompilationUnit,
  contract: Contract,
  steps: Step[],
  codeAddress: bigint,
): Map<string, FnOracle> {
  const byName = new Map<string, FnOracle>();
  for (const step of steps) {
    if (step.isInitCode || step.codeAddress !== codeAddress) {
      continue;
    }
    const fn = attributeFunction(cu, contract, step.pc);
    if (fn === undefined || fn.name === '') {
      continue;
    }
    const len = step.stack.length;
    let oracle = byName.get(fn.name);
    if (oracle === undefined) {
      oracle = {
        id: fn.id,
        name: fn.name,
        entryPc: step.pc,
        entryStackLen: len,
        heights: new Map(),
        visits: new Map(),
        conflicts: [],
      };
      byName.set(fn.name, oracle);
    }
    const height = len - oracle.entryStackLen;
    oracle.visits.set(step.pc, (oracle.visits.get(step.pc) ?? 0) + 1);
    const prior = oracle.heights.get(step.pc);
    if (prior === undefined) {
      oracle.heights.set(step.pc, height);
    } else if (prior !== height) {
      oracle.conflicts.push({pc: step.pc, had: prior, got: height, step: step.index});
    }
  }
  return byName;
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

interface Scenario {
  label: string;
  buildInfo: string;
  sourcePath: string;
  contractName: string;
  trace: string;
  meta: string;
  /** Function bodies to assert the analyzer against. */
  functions: string[];
}

const STEPPER: Scenario = {
  label: 'Stepper.run / Stepper.double',
  buildInfo: 'stepper-build-info.json',
  sourcePath: 'src/Stepper.sol',
  contractName: 'Stepper',
  trace: 'stepper-run-trace.raw.json',
  meta: 'stepper-run-meta.json',
  functions: ['run', 'double'],
};

const LOCALS: Scenario = {
  label: 'Locals.compute (for-loop + nested block)',
  buildInfo: 'locals-build-info.json',
  sourcePath: 'src/Locals.sol',
  contractName: 'Locals',
  trace: 'locals-compute-trace.raw.json',
  meta: 'locals-compute-meta.json',
  functions: ['compute'],
};

/** Assemble everything a scenario's specs need, once. */
function prepare(s: Scenario) {
  const cu = loadCu(s.buildInfo);
  const contract = cu.contract(s.sourcePath, s.contractName)!;
  const steps = loadTrace(s.trace);
  const codeAddress = loadCodeAddress(s.meta);
  const oracle = buildOracle(cu, contract, steps, codeAddress);
  return {cu, contract, steps, codeAddress, oracle};
}

// ---------------------------------------------------------------------------
// 1. The oracle itself is well-formed (sanity: the spec is trustworthy)
// ---------------------------------------------------------------------------

describe('trace-derived oracle (spec sanity)', () => {
  for (const s of [STEPPER, LOCALS]) {
    describe(s.label, () => {
      const {oracle} = prepare(s);

      for (const fnName of s.functions) {
        it(`attributes body pcs to ${fnName} with a consistent per-pc height`, () => {
          const fn = oracle.get(fnName);
          expect(fn, `no trace steps attributed to ${fnName}`).toBeDefined();
          // A pc reached at two heights would be a real CFG bug in the oracle.
          expect(fn!.conflicts, JSON.stringify(fn!.conflicts.slice(0, 3))).toEqual([]);
          expect(fn!.heights.get(fn!.entryPc)).toBe(0); // entry ⇒ height 0
          expect(fn!.heights.size).toBeGreaterThan(5);
        });
      }
    });
  }

  it('Stepper.double entry is the JUMPDEST landing (step 180, pc 169, len 7)', () => {
    const {oracle} = prepare(STEPPER);
    const dbl = oracle.get('double')!;
    expect(dbl.entryPc).toBe(169);
    expect(dbl.entryStackLen).toBe(7);
  });

  it('Locals.compute revisits loop-body pcs at a consistent height (CFG merge)', () => {
    const {oracle} = prepare(LOCALS);
    const compute = oracle.get('compute')!;
    const multi = [...compute.visits.entries()].filter(([, n]) => n > 1);
    // The for-loop body pcs are observed on multiple iterations, all at one height.
    expect(multi.length).toBeGreaterThan(10);
    for (const [pc] of multi) {
      expect(compute.heights.has(pc)).toBe(true); // consistent ⇒ recorded, no conflict
    }
    // A concrete loop-body pc visited on 4 iterations, always at height 16.
    expect(compute.visits.get(548)).toBe(4);
    expect(compute.heights.get(548)).toBe(16);
  });
});

// ---------------------------------------------------------------------------
// 2. The analyzer reproduces the oracle at EVERY body pc
// ---------------------------------------------------------------------------

describe('stackHeights — static analyzer matches recorded traces', () => {
  for (const s of [STEPPER, LOCALS]) {
    describe(s.label, () => {
      const {cu, oracle} = prepare(s);

      for (const fnName of s.functions) {
        it(`frameRelHeightAt reproduces every ${fnName} body pc`, () => {
          const fn = oracle.get(fnName)!;
          const sh = stackHeights(cu, s.sourcePath, s.contractName);

          const mismatches: Array<{pc: number; expected: number; got: number | undefined}> = [];
          for (const [pc, expected] of [...fn.heights.entries()].sort((a, b) => a[0] - b[0])) {
            const got = sh.frameRelHeightAt(pc);
            if (got !== expected) {
              mismatches.push({pc, expected, got});
            }
          }
          expect(
            mismatches,
            mismatches.length
              ? `first mismatch in ${fnName}: pc=${mismatches[0]!.pc} ` +
                  `expected=${mismatches[0]!.expected} got=${mismatches[0]!.got} ` +
                  `(${mismatches.length}/${fn.heights.size} pcs disagree)`
              : 'all pcs agree',
          ).toEqual([]);
        });
      }
    });
  }

  it('agrees across the double() call site and after the return', () => {
    const {cu, oracle} = prepare(STEPPER);
    const sh = stackHeights(cu, STEPPER.sourcePath, STEPPER.contractName);
    const run = oracle.get('run')!;
    // pc 144 = the JUMP into double (still run's frame); pc 145 = the return
    // JUMPDEST after double returns its single value net of the pushed args.
    expect(sh.frameRelHeightAt(144)).toBe(run.heights.get(144)); // 7
    expect(sh.frameRelHeightAt(145)).toBe(run.heights.get(145)); // 5
    expect(run.heights.get(144)).toBe(7);
    expect(run.heights.get(145)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 3. Hard-coded spot-checks — a broken impl fails obviously
// ---------------------------------------------------------------------------

describe('stackHeights — ground-truth spot-checks', () => {
  it('Stepper.double: entry pc 169 → 0, and grows to 1 by the time v is live', () => {
    const cu = loadCu(STEPPER.buildInfo);
    const sh = stackHeights(cu, STEPPER.sourcePath, STEPPER.contractName);
    expect(sh.frameRelHeightAt(169)).toBe(0); // body-entry JUMPDEST
    expect(sh.frameRelHeightAt(171)).toBe(1); // v pushed: depth 0→1 (steps 180→182)
  });

  it('Stepper.run: entry pc 86 → 0', () => {
    const cu = loadCu(STEPPER.buildInfo);
    const sh = stackHeights(cu, STEPPER.sourcePath, STEPPER.contractName);
    expect(sh.frameRelHeightAt(86)).toBe(0);
  });

  it('Locals.compute: entry pc 86 → 0, loop-body pc 548 → 16', () => {
    const cu = loadCu(LOCALS.buildInfo);
    const sh = stackHeights(cu, LOCALS.sourcePath, LOCALS.contractName);
    expect(sh.frameRelHeightAt(86)).toBe(0);
    expect(sh.frameRelHeightAt(548)).toBe(16);
  });
});

// ---------------------------------------------------------------------------
// 4. Edge: pcs outside any analyzed function body → undefined
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 5. Graceful degradation: a pc reached at two static heights must not crash
//    the whole analysis. Valid unoptimized solc never does this, but optimizer
//    block-sharing / modifiers / try-catch / inline-assembly can, and a debug
//    session must survive an odd contract. We hand-craft such bytecode.
// ---------------------------------------------------------------------------

describe('stackHeights — conflicting merge height degrades gracefully', () => {
  // JUMPDEST at pc 15 is reached at height 0 (via the JUMPI-taken block, which
  // pushes nothing extra) and height 1 (via the fall-through, which pushes one
  // extra slot) — a genuine frame-relative-height conflict.
  const RUNTIME =
    '0x' +
    '5b' + // 0  JUMPDEST (entry)
    '6001' + // 1  PUSH1 1  (cond)
    '600b' + // 3  PUSH1 11 (taken target)
    '57' + // 5  JUMPI
    '6000' + // 6  PUSH1 0  (fall-through: extra slot)
    '600f' + // 8  PUSH1 15 (L)
    '56' + // 10 JUMP
    '5b' + // 11 JUMPDEST (taken block)
    '600f' + // 12 PUSH1 15 (L)
    '56' + // 14 JUMP
    '5b' + // 15 JUMPDEST (merge point -> conflict)
    '00'; // 16 STOP
  const sourceMap = Array.from({length: 12}, () => '0:1:0').join(';');
  const ast = {
    nodeType: 'SourceUnit',
    id: 1,
    src: '0:100:0',
    nodes: [
      {
        nodeType: 'ContractDefinition',
        id: 2,
        name: 'T',
        src: '0:100:0',
        nodes: [
          {
            nodeType: 'FunctionDefinition',
            id: 3,
            name: 'f',
            src: '0:100:0',
            body: {nodeType: 'Block', id: 4, src: '50:40:0'},
          },
        ],
      },
    ],
  };
  const buildInfo = {
    solcVersion: '0.8.35',
    input: {sources: {'src/T.sol': {content: ''}}},
    output: {
      sources: {'src/T.sol': {id: 0, ast}},
      contracts: {
        'src/T.sol': {
          T: {evm: {deployedBytecode: {object: RUNTIME.slice(2), sourceMap}}},
        },
      },
    },
  };

  it('does not throw, reports the ambiguous pc as undefined, keeps the rest', () => {
    const cu = loadBuildInfo(buildInfo);
    let sh: ReturnType<typeof stackHeights> | undefined;
    expect(() => {
      sh = stackHeights(cu, 'src/T.sol', 'T');
    }).not.toThrow();
    // The genuinely-ambiguous merge pc is reported as unknown, never a wrong height.
    expect(sh!.frameRelHeightAt(15)).toBeUndefined();
    // Unambiguous pcs before the conflict keep their best-effort heights.
    expect(sh!.frameRelHeightAt(0)).toBe(0); // entry
    expect(sh!.frameRelHeightAt(3)).toBe(1); // after PUSH1 cond
    expect(sh!.frameRelHeightAt(5)).toBe(2); // after PUSH1 taken-target
  });
});

describe('stackHeights — pcs outside any function body', () => {
  it('returns undefined for the dispatcher entry (pc 0), both contracts', () => {
    const stepper = stackHeights(
      loadCu(STEPPER.buildInfo),
      STEPPER.sourcePath,
      STEPPER.contractName,
    );
    const locals = stackHeights(
      loadCu(LOCALS.buildInfo),
      LOCALS.sourcePath,
      LOCALS.contractName,
    );
    // pc 0 maps to the whole ContractDefinition range — no enclosing function.
    expect(stepper.frameRelHeightAt(0)).toBeUndefined();
    expect(locals.frameRelHeightAt(0)).toBeUndefined();
  });
});
