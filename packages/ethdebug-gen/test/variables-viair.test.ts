/**
 * End-to-end SOUNDNESS of value-type LOCAL **and PARAMETER** stack pointers
 * under **viaIR** (plus a legacy no-regression / legacy-param guard).
 *
 * These specs pin the CORRECTNESS of the stack pointer that
 * `variablesAt(cu, sourcePath, contractName, pc)` emits for a value-type local
 * or parameter — validated the way the debugger actually consumes it: dereference
 * the pointer against the recorded runtime machine state at that step and assert
 * the value it DISPLAYS.
 *
 * ── Scope ─────────────────────────────────────────────────────────────────────
 * The SAME "height − rank" fixed-frame-slot model (below) locates value-type
 * PARAMETERS too (params rank before locals in the uniform stack region), so the
 * viaIR reorder/reuse bug corrupts value-param reads exactly as it does locals.
 * This file covers BOTH:
 *   - viaIR local:  VarMove.run, `amount == 7`.
 *   - viaIR params: VarMoveParams.probe(3, 5) — params `p == 3`, `q == 5`, and
 *     the derived local `s == 8`.
 *   - legacy local no-regression: Stepper.run, locals `a == 11`, `b == 22`.
 *   - legacy PARAM: Stepper.run(10), param `x == 10` — a pre-existing
 *     parameter-slot bug the fix must ALSO repair (currently misread at some
 *     steps), so this legacy-param spec FAILS now, unlike the legacy-local one.
 *
 * ── The bug (root cause) ──────────────────────────────────────────────────────
 * `variablesAt` models every value-type local as PERMANENTLY occupying a fixed
 * frame slot in declaration order: it emits a stack pointer whose depth-from-top
 * is `slot = frameRelHeightAt(pc) − 1 − (frameBase + declarationRank)` (see
 * variables.ts / `stackVariables`). That "height − rank" identity is a LEGACY
 * (viaIR:false) codegen assumption: with the classic pipeline a local really does
 * live at one stable frame depth for the life of its scope.
 *
 * Contracts compiled with **viaIR: true** (the Yul/IR pipeline — the default for
 * uniswap-v4-core and most modern Foundry projects) break that assumption. The
 * Yul stack scheduler aggressively REORDERS and REUSES stack slots per
 * instruction, so a local's real depth is a PER-PC property, not `height − rank`.
 * On viaIR bytecode the current model points at the wrong slot at essentially
 * every pc: the read returns a stray word (or an out-of-bounds slot), never the
 * local's value.
 *
 * ── The oracle (how correctness is defined here) ──────────────────────────────
 * Ground-truth fixture: `test/fixtures/counter/src/VarMove.sol`, contract
 * `VarMove`, function `run()`, first local `uint256 amount = 7;` (a value type),
 * compiled with viaIR (settings.viaIR === true) and executed on kontrol-node.
 * For the recorded trace we, exactly like stackHeights.test.ts:
 *   1. parse the raw `debug_traceTransaction` losslessly and normalize it to
 *      `Step[]`, and build a `StateCursor` for per-step machine state;
 *   2. keep only steps executing VarMove's runtime code (`codeAddress` matches,
 *      non-init);
 *   3. at each such step ask `variablesAt(cu,'src/VarMove.sol','VarMove',pc)` for
 *      the local `amount`; if it carries a `.pointer`, DEREFERENCE it via
 *      `readPointerValue(pointer, machineStateFor(cursor.at(step), address))`.
 *
 * The correctness contract encoded below:
 *   1. SOUNDNESS (currently FAILING): whenever `amount` is returned WITH a
 *      pointer, that pointer MUST read `7n`. A wrong value (or an OOB/throwing
 *      read) is a bug. An OMITTED `amount` (no pointer / not returned) at a step
 *      is ACCEPTABLE — the ethdebug per-instruction-context model legitimately
 *      reports a local as unavailable where its value is not on the stack.
 *      (Measured: the current buggy code emits a pointer at 120 steps and reads
 *      `7` at 0 of them — all 120 read `0`.)
 *   2. COMPLETENESS spot-check (currently FAILING): the fix must not "fix"
 *      soundness by simply never emitting `amount`. There must be a substantial
 *      number of steps (≥ 60; measured 97 steps where a correct answer exists on
 *      the stack) where `amount` reads `7`, AND the FIRST step at which `amount`
 *      becomes available must already read `7` (its value right after the
 *      `amount = 7` declaration).
 *   3. "WHEN to read" (unavailable): it is CORRECT for `amount` to be omitted /
 *      pointer-less where its value is not on the stack — this is the same
 *      statement as soundness (never a wrong value), asserted as such rather than
 *      via a brittle exact unavailable-count.
 *   4. LEGACY NO-REGRESSION (currently PASSING): the identical soundness property
 *      on an EXISTING legacy (viaIR:false) fixture with known value-type locals
 *      (`Stepper.run`: `a == 11`, `b == 22`) must keep holding, proving the fix
 *      does not disturb the classic pipeline.
 *
 * Evaluation of a stack pointer (`machineStateFor` + `readPointerValue`, the real
 * `@ethdebug/pointers` path) is itself CORRECT and is exercised in
 * debugger/session.test.ts — here it is used only as the trusted oracle that
 * turns a `variablesAt` pointer into the value the debugger would show.
 */
import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {loadBuildInfo, type CompilationUnit} from '@simbolik/solc';
import {parseJsonLossless} from '@simbolik/engine';
import {normalizeKontrolTrace, StateCursor, type Step} from '@simbolik/lifting';

import {variablesAt, type ResolvedVariable} from '../src/index.js';
// ethdebug-gen does not depend on the debugger package; reach its evaluation
// path (the trusted oracle) directly from source, as the cross-package fixtures
// above are reached (matching stackHeights.test.ts's source-relative imports).
import {machineStateFor, readPointerValue} from '../../debugger/src/index.js';

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

/** The running contract's address, both as the string the state adapter needs
 *  and as the bigint the per-step `codeAddress` filter compares against. */
function loadAddress(metaName: string): {str: string; big: bigint} {
  const url = new URL(`../../debugger/test/fixtures/${metaName}`, import.meta.url);
  const meta = JSON.parse(readFileSync(url, 'utf8')) as {contractAddress: string};
  return {str: meta.contractAddress, big: BigInt(meta.contractAddress)};
}

// ---------------------------------------------------------------------------
// Oracle: read every returned value-local pointer at every own-contract step
// ---------------------------------------------------------------------------

interface LocalReading {
  step: number;
  pc: number;
  value: bigint | 'THREW';
}

/**
 * Walk the trace; at each step executing THIS contract's runtime code, resolve
 * `variablesAt` and dereference every returned value-type STACK variable (a
 * parameter, return, or local — anything but a storage var) named in `names`
 * that carries a pointer. Returns, per name, the ordered list of readings.
 *
 * Names must be unique across kinds in the fixture (no local/param collision),
 * which holds for every fixture here, so matching by name + `kind !== 'storage'`
 * covers value-type params AND locals with one oracle.
 */
async function readStackVarsOverTrace(
  cu: CompilationUnit,
  sourcePath: string,
  contractName: string,
  trace: string,
  meta: string,
  names: readonly string[],
): Promise<Map<string, LocalReading[]>> {
  const steps = loadTrace(trace);
  const address = loadAddress(meta);
  const cursor = new StateCursor(steps);
  const out = new Map<string, LocalReading[]>(names.map((n) => [n, []]));

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (step.isInitCode || step.codeAddress !== address.big) continue;

    const vars = variablesAt(cu, sourcePath, contractName, step.pc);
    for (const name of names) {
      const v: ResolvedVariable | undefined = vars.find(
        (x) => x.name === name && x.kind !== 'storage',
      );
      if (v === undefined || v.pointer === undefined) continue; // omitted ⇒ OK.

      const ms = machineStateFor(cursor.at(i), address.str);
      let value: bigint | 'THREW';
      try {
        value = await readPointerValue(v.pointer, ms);
      } catch {
        value = 'THREW'; // an OOB / undereferenceable pointer is also unsound.
      }
      out.get(name)!.push({step: i, pc: step.pc, value});
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1-3. viaIR — VarMove.run, first local `uint256 amount = 7`
// ---------------------------------------------------------------------------

const VIAIR = {
  buildInfo: 'varmove-viair-build-info.json',
  sourcePath: 'src/VarMove.sol',
  contractName: 'VarMove',
  trace: 'varmove-viair-run-trace.raw.json',
  meta: 'varmove-viair-run-meta.json',
} as const;

describe('variablesAt — viaIR value-local stack pointer (VarMove.amount)', () => {
  async function amountReadings(): Promise<LocalReading[]> {
    const cu = loadCu(VIAIR.buildInfo);
    const m = await readStackVarsOverTrace(
      cu,
      VIAIR.sourcePath,
      VIAIR.contractName,
      VIAIR.trace,
      VIAIR.meta,
      ['amount'],
    );
    return m.get('amount')!;
  }

  it('SOUNDNESS: every returned `amount` pointer reads 7 (never a stray/OOB value)', async () => {
    const readings = await amountReadings();
    // Sanity: the fixture actually reaches the function (amount is emitted with a
    // pointer at many steps) — so this assertion is not vacuous.
    expect(
      readings.length,
      'no step returned `amount` with a pointer — fixture/attribution broken',
    ).toBeGreaterThan(0);

    const wrong = readings.filter((r) => r.value !== 7n);
    expect(
      wrong.length,
      wrong.length
        ? `unsound reads: ${wrong.length}/${readings.length} steps returned ` +
            `\`amount\` with a pointer that did NOT read 7 — e.g. ` +
            wrong
              .slice(0, 3)
              .map((r) => `step ${r.step} (pc ${r.pc}) → ${r.value}`)
              .join(', ')
        : 'all returned `amount` pointers read 7',
    ).toBe(0);
  });

  it('COMPLETENESS: `amount` reads 7 at a substantial number of steps (≥ 60)', async () => {
    const readings = await amountReadings();
    const correct = readings.filter((r) => r.value === 7n).length;
    // Guards against a fix that "achieves" soundness by never emitting `amount`.
    // Measured: 97 steps where 7 is genuinely on the stack; ≥ 60 is conservative.
    expect(
      correct,
      `only ${correct} steps read \`amount\` == 7 (expected ≥ 60); a fix must ` +
        `emit a correct pointer where the value is live, not suppress the local`,
    ).toBeGreaterThanOrEqual(60);
  });

  it('COMPLETENESS: the FIRST step where `amount` is available already reads 7', async () => {
    const readings = await amountReadings();
    expect(readings.length).toBeGreaterThan(0);
    const first = readings[0]!;
    // Right after `uint256 amount = 7;` the local is live and holds 7; the first
    // step that surfaces it must therefore read 7, not a stray value.
    expect(
      first.value,
      `first available step for \`amount\` is step ${first.step} (pc ${first.pc}) ` +
        `and read ${first.value}, expected 7`,
    ).toBe(7n);
  });
});

// ---------------------------------------------------------------------------
// 4-5. viaIR — VarMoveParams.probe(3, 5): value PARAMETERS p, q + local s
// ---------------------------------------------------------------------------

const VIAIR_PARAMS = {
  buildInfo: 'varmoveparams-viair-build-info.json',
  sourcePath: 'src/VarMoveParams.sol',
  contractName: 'VarMoveParams',
  trace: 'varmoveparams-viair-run-trace.raw.json',
  meta: 'varmoveparams-viair-run-meta.json',
  // probe(3, 5): params p==3, q==5; derived local `uint256 s = p + q` ⇒ 8.
  known: {p: 3n, q: 5n, s: 8n} as Record<string, bigint>,
  // Conservative completeness floors. Measured steps where the true value is on
  // the stack (a correct pointer CAN exist): p=94, q=94, s=76.
  floor: {p: 60, q: 60, s: 45} as Record<string, number>,
} as const;

describe('variablesAt — viaIR value-PARAMETER stack pointers (VarMoveParams)', () => {
  async function readings(): Promise<Map<string, LocalReading[]>> {
    const cu = loadCu(VIAIR_PARAMS.buildInfo);
    return readStackVarsOverTrace(
      cu,
      VIAIR_PARAMS.sourcePath,
      VIAIR_PARAMS.contractName,
      VIAIR_PARAMS.trace,
      VIAIR_PARAMS.meta,
      Object.keys(VIAIR_PARAMS.known),
    );
  }

  for (const name of Object.keys(VIAIR_PARAMS.known)) {
    const want = VIAIR_PARAMS.known[name]!;
    const kind = name === 's' ? 'local' : 'parameter';

    it(`SOUNDNESS: every returned \`${name}\` (${kind}) pointer reads ${want}`, async () => {
      const rs = (await readings()).get(name)!;
      // Not vacuous: the function is reached and `name` is emitted with a pointer.
      expect(
        rs.length,
        `no step returned \`${name}\` with a pointer — fixture/attribution broken`,
      ).toBeGreaterThan(0);

      const wrong = rs.filter((r) => r.value !== want);
      expect(
        wrong.length,
        wrong.length
          ? `unsound reads: ${wrong.length}/${rs.length} steps returned ` +
              `\`${name}\` with a pointer that did NOT read ${want} — e.g. ` +
              wrong
                .slice(0, 3)
                .map((r) => `step ${r.step} (pc ${r.pc}) → ${r.value}`)
                .join(', ')
          : `all returned \`${name}\` pointers read ${want}`,
      ).toBe(0);
    });

    it(`COMPLETENESS: \`${name}\` reads ${want} at ≥ ${VIAIR_PARAMS.floor[name]} steps`, async () => {
      const rs = (await readings()).get(name)!;
      const correct = rs.filter((r) => r.value === want).length;
      // Guards against a fix that "achieves" soundness by never emitting `name`.
      expect(
        correct,
        `only ${correct} steps read \`${name}\` == ${want} (expected ≥ ` +
          `${VIAIR_PARAMS.floor[name]}); a fix must emit a correct pointer where ` +
          `the value is live, not suppress the variable`,
      ).toBeGreaterThanOrEqual(VIAIR_PARAMS.floor[name]!);
    });
  }
});

// ---------------------------------------------------------------------------
// 6. LEGACY (viaIR:false) NO-REGRESSION — Stepper.run value-locals a, b
// ---------------------------------------------------------------------------

const LEGACY = {
  buildInfo: 'stepper-build-info.json',
  sourcePath: 'src/Stepper.sol',
  contractName: 'Stepper',
  trace: 'stepper-run-trace.raw.json',
  meta: 'stepper-run-meta.json',
  // Stepper.run(10): `uint256 a = x + 1` ⇒ 11; `uint256 b = double(a)` ⇒ 22.
  // Both are value-type LOCALS with a stable known value once declared.
  known: {a: 11n, b: 22n} as Record<string, bigint>,
} as const;

describe('variablesAt — legacy value-local stack pointers stay sound (Stepper)', () => {
  it('SOUNDNESS: every returned `a`/`b` pointer reads its known value', async () => {
    const cu = loadCu(LEGACY.buildInfo);
    const names = Object.keys(LEGACY.known);
    const readings = await readStackVarsOverTrace(
      cu,
      LEGACY.sourcePath,
      LEGACY.contractName,
      LEGACY.trace,
      LEGACY.meta,
      names,
    );

    let totalCorrect = 0;
    for (const name of names) {
      const rs = readings.get(name)!;
      const wrong = rs.filter((r) => r.value !== LEGACY.known[name]);
      expect(
        wrong.length,
        wrong.length
          ? `legacy regression on \`${name}\`: ${wrong.length}/${rs.length} ` +
              `reads != ${LEGACY.known[name]} — e.g. ` +
              wrong
                .slice(0, 3)
                .map((r) => `step ${r.step} (pc ${r.pc}) → ${r.value}`)
                .join(', ')
          : `all \`${name}\` pointers read ${LEGACY.known[name]}`,
      ).toBe(0);
      totalCorrect += rs.length;
    }

    // Not vacuous: the legacy pipeline emits these locals with correct pointers
    // at many steps, and the fix must keep doing so. (Measured: a=21, b=13.)
    expect(
      totalCorrect,
      `expected legacy locals to be emitted with pointers at many steps, got ${totalCorrect}`,
    ).toBeGreaterThanOrEqual(20);
  });
});

// ---------------------------------------------------------------------------
// 7. LEGACY (viaIR:false) PARAMETER soundness — Stepper.run(uint256 x), x == 10
// ---------------------------------------------------------------------------
//
// Unlike the legacy-LOCAL guard above (which passes today), the value-type
// PARAMETER `x` is misread at some steps even on legacy bytecode — a pre-existing
// parameter-slot bug now IN scope. This spec therefore FAILS now and the fix must
// make it pass. (Measured: `x` emitted with a pointer at 50 steps, read 10 at 39,
// WRONG at 11.)

describe('variablesAt — legacy value-PARAMETER soundness (Stepper.run x)', () => {
  it('SOUNDNESS: every returned `x` (parameter) pointer reads 10', async () => {
    const cu = loadCu(LEGACY.buildInfo);
    const rs = (
      await readStackVarsOverTrace(
        cu,
        LEGACY.sourcePath,
        LEGACY.contractName,
        LEGACY.trace,
        LEGACY.meta,
        ['x'],
      )
    ).get('x')!;
    // Not vacuous: `x` is emitted with a pointer at many steps.
    expect(
      rs.length,
      'no step returned `x` with a pointer — fixture/attribution broken',
    ).toBeGreaterThan(0);

    const wrong = rs.filter((r) => r.value !== 10n);
    expect(
      wrong.length,
      wrong.length
        ? `unsound reads: ${wrong.length}/${rs.length} steps returned ` +
            `\`x\` with a pointer that did NOT read 10 — e.g. ` +
            wrong
              .slice(0, 3)
              .map((r) => `step ${r.step} (pc ${r.pc}) → ${r.value}`)
              .join(', ')
        : 'all returned `x` pointers read 10',
    ).toBe(0);
  });
});
