/**
 * Sub-feature 4b — ETCHED / UNIDENTIFIABLE frame handling.
 *
 * Kontrol's `vm.etch(addr, code)` installs runtime bytecode at an address that
 * was never deployed; a later CALL into that address runs the etched code as a
 * real depth++ frame. When the etched code IS an identifiable compiled contract
 * (CBOR-matched to a compilation unit in build-info), the debugger already
 * resolves the frame to its real source — that must keep working (regression).
 * When the etched code is NOT identifiable (raw bytecode, no CBOR, no matching
 * CU), the debugger currently FALLS BACK to the entry/launch contract's CU and
 * mis-maps the foreign PCs onto the wrong source. 4b must instead render that
 * frame as FOREIGN (EVM-only: no Solidity source; addressed by its code
 * address) WITHOUT corrupting the parent frame's stepping.
 *
 * ── CONFIRMED GROUND TRUTH (observed by running the real session against the
 *    frozen recordings; every step index below is deterministic) ─────────────
 *
 * Fixture 1 — KNOWN etch (regression; already works today):
 *   etch-run-trace.raw.json (kontrol, 761 steps), Etch.run().
 *   - launch() opens PAUSED at step 35, Etch.sol line 34 (`vm.etch(...)`).
 *   - vm.etch cheatcode CALL is atomic at depth 1 (~step 274).
 *   - CALL into 0x…beef is at step 396→397 (depth 1→2).
 *   - depth-2 region = steps 397–652. TODAY the top frame there already resolves
 *     correctly: at the dispatcher entry (~397) it is `Impl@Etch.sol:16`, and in
 *     the body it is `setStored@Etch.sol:19` (decl) / `:20` (the `stored=v*2;`
 *     body line). Breakpoint on line 20 + continue → step 506, top frame
 *     `setStored@Etch.sol:20`, parent `run@Etch.sol:35`. Impl and Etch live in
 *     the SAME file (Etch.sol), so source.name is "Etch.sol" for both frames.
 *
 * Fixture 2 — RAW etch (the FAILING case; drives implementation):
 *   etchraw-run-trace.raw.json (kontrol, 420 steps), EtchRaw.run().
 *   Etched code 0x600160005260206000f3 is raw bytecode — no CBOR, not a known CU.
 *   - launch() opens PAUSED at step 35, EtchRaw.sol line 23 (`vm.etch(...)`).
 *   - vm.etch cheatcode CALL is atomic at depth 1 (~step 191).
 *   - CALL into 0x…beef is at step 277→278 (depth 1→2).
 *   - depth-2 region = EXACTLY steps 278–283 (6 steps of raw code).
 *   - CURRENT BUGGY BEHAVIOR (confirmed): at steps 278–283 the top frame is
 *     `EtchRaw@EtchRaw.sol:14` — the entry CU mis-mapping the raw PCs onto the
 *     EtchRaw contract decl. Its `.source` is {name:'EtchRaw.sol', ...} and its
 *     `.name` is 'EtchRaw'. The parent `run@EtchRaw.sol:24` is preserved.
 *   - Parent `run` is shown at line 24 at steps 275–277 and 284–285.
 *
 * Navigation used below (frozen trace ⇒ stable):
 *   - Test 1: bp on Etch.sol line 20 + continue → step 506 (inside Impl body).
 *   - Test 2: bp on EtchRaw.sol line 24 + continue → step 202, then
 *     stepInstruction() until currentStepIndex ≥ 278 → lands on step 278 inside
 *     the raw depth-2 region (278–283).
 *   - Test 3: bp on EtchRaw.sol line 24 + continue → step 202 (`run@24`), then
 *     next() (source-level step-over) → step 325, `run@EtchRaw.sol:25` (the
 *     `require(ok, ...)` line — the next statement in run), single frame at
 *     depth 1. i.e. step-over runs the etched subcall to completion and neither
 *     descends into it nor gets stuck.
 *
 * WHICH TESTS FAIL TODAY:
 *   - Test 1 (known etch resolves): PASSES today — pure regression guard.
 *   - Test 2 (raw → FOREIGN frame): FAILS today for the RIGHT reason — the top
 *     frame is currently `EtchRaw@EtchRaw.sol:14` (entry-CU fallback), so its
 *     `.source` is DEFINED (not undefined) and its `.name` IS 'EtchRaw' and does
 *     NOT contain the code address 'beef'. Those three assertions fail today.
 *   - Test 3 (parent step-over not corrupted): PASSES today — guard against the
 *     combinedDepth-corruption class; kept green so 4b must not regress it.
 *
 * Foreign-frame name expectation (decided): the foreign frame is addressed by
 * its CODE ADDRESS (target 0x…beef). We assert its display name contains 'beef'
 * (case-insensitively) and does NOT contain 'EtchRaw'. The STABLE facts — the
 * frame carries NO Solidity `source`, and the parent frame is uncorrupted — are
 * pinned firmly; the display name is checked with substrings.
 */
import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {SolidityDebugSession, type LaunchInputs} from '../src/index.js';

// ── fixture loaders (mirrors modifierframes.test.ts / cheatcodeframes.test.ts) ─
function readTrace(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}
function readBuildInfo(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../../solc/test/fixtures/${name}`, import.meta.url),
      'utf8',
    ),
  );
}
function readAddress(metaName: string): string {
  const meta = JSON.parse(
    readFileSync(new URL(`./fixtures/${metaName}`, import.meta.url), 'utf8'),
  ) as {contractAddress: string};
  return meta.contractAddress;
}

function etchInputs(): LaunchInputs {
  return {
    buildInfoJson: readBuildInfo('etch-build-info.json'),
    traceJson: readTrace('etch-run-trace.raw.json'),
    sourcePath: 'src/Etch.sol',
    contractName: 'Etch',
    methodName: 'run',
    dialect: 'kontrol',
    codeAddress: readAddress('etch-run-meta.json'),
  };
}

function etchRawInputs(): LaunchInputs {
  return {
    buildInfoJson: readBuildInfo('etchraw-build-info.json'),
    traceJson: readTrace('etchraw-run-trace.raw.json'),
    sourcePath: 'src/EtchRaw.sol',
    contractName: 'EtchRaw',
    methodName: 'run',
    dialect: 'kontrol',
    codeAddress: readAddress('etchraw-run-meta.json'),
  };
}

// ---------------------------------------------------------------------------
// 1. KNOWN etch resolves to the etched contract's source (regression).
//    PASSES today — 4b must keep it green.
// ---------------------------------------------------------------------------

describe('Etch known-etch frame — resolves to Impl.setStored source (regression)', () => {
  it('bp on Impl body (line 20) + continue → [setStored@Etch.sol:20, run@Etch.sol:35]', async () => {
    const session = new SolidityDebugSession();
    await session.launch(etchInputs());
    session.setBreakpoints({
      source: {path: 'src/Etch.sol'},
      breakpoints: [{line: 20}], // `stored = v * 2;` — inside Impl.setStored
    });
    await session.continue();

    // Landed inside the depth-2 etched region (region = steps 397–652).
    expect(session.currentStepIndex).toBe(506);

    const {stackFrames} = session.stackTrace();

    // The etched frame is on TOP of the real `run` frame.
    expect(stackFrames.length).toBeGreaterThanOrEqual(2);

    // [0] top = the etched code, resolved against Impl's source (Impl and Etch
    // share the same compilation unit / file Etch.sol).
    const top = stackFrames[0]!;
    expect(top.name).toContain('setStored');
    expect(top.source?.name).toBe('Etch.sol');
    // The paused line sits within Impl.setStored's body (decl 19, `stored=v*2;`
    // 20, `return` 21).
    expect(top.line).toBeGreaterThanOrEqual(19);
    expect(top.line).toBeLessThanOrEqual(21);

    // [1] = the real parent `run` frame, preserved and uncorrupted at its
    // call site (line 35, `result = Impl(TARGET).setStored(21);`).
    const below = stackFrames[1]!;
    expect(below.name).toContain('run');
    expect(below.source?.name).toBe('Etch.sol');
    expect(below.line).toBe(35);
  });
});

// ---------------------------------------------------------------------------
// 2. RAW etch degrades to a FOREIGN frame (drives implementation).
//    FAILS today: the top frame is `EtchRaw@EtchRaw.sol:14` (entry-CU fallback).
// ---------------------------------------------------------------------------

const RAW_CALL_LINE = 24; // `(bool ok, bytes memory ret) = TARGET.call("");`
const RAW_REGION_LO = 278; // first step of the raw depth-2 region
const RAW_REGION_HI = 283; // last step of the raw depth-2 region

/** Navigate a fresh EtchRaw session into the raw depth-2 region (278–283). */
async function sessionInRawRegion(): Promise<SolidityDebugSession> {
  const session = new SolidityDebugSession();
  await session.launch(etchRawInputs());
  session.setBreakpoints({
    source: {path: 'src/EtchRaw.sol'},
    breakpoints: [{line: RAW_CALL_LINE}],
  });
  session.continue(); // → step 202, run@EtchRaw.sol:24
  // Instruction-step onto the first raw depth-2 step (frozen trace).
  let guard = 0;
  while (session.currentStepIndex < RAW_REGION_LO && guard++ < 2000) {
    session.stepInstruction();
  }
  return session;
}

describe('EtchRaw unidentifiable-etch frame — FOREIGN, no source, parent intact', () => {
  it('lands inside the raw depth-2 region (steps 278–283)', async () => {
    const session = await sessionInRawRegion();
    expect(session.currentStepIndex).toBeGreaterThanOrEqual(RAW_REGION_LO);
    expect(session.currentStepIndex).toBeLessThanOrEqual(RAW_REGION_HI);
  });

  it('top frame is FOREIGN (no Solidity source, address-derived name) with an uncorrupted run parent', async () => {
    const session = await sessionInRawRegion();
    expect(session.currentStepIndex).toBeGreaterThanOrEqual(RAW_REGION_LO);
    expect(session.currentStepIndex).toBeLessThanOrEqual(RAW_REGION_HI);

    const {stackFrames} = session.stackTrace();

    // Two frames: the foreign etched frame on top of the real `run` frame.
    expect(stackFrames).toHaveLength(2);

    const top = stackFrames[0]!;
    // STABLE FACT: the foreign frame is NOT attributed to any Solidity source.
    // (Today it wrongly carries source {name:'EtchRaw.sol', ...} → this FAILS.)
    expect(top.source).toBeUndefined();
    // The frame is addressed by its CODE ADDRESS (target 0x…beef), not the
    // entry contract. (Today name === 'EtchRaw' → both of these FAIL.)
    expect(top.name.toLowerCase()).toContain('beef');
    expect(top.name).not.toContain('EtchRaw');

    // STABLE FACT: the parent `run` frame is preserved and uncorrupted.
    const below = stackFrames[1]!;
    expect(below.name).toContain('run');
    expect(below.source?.name).toBe('EtchRaw.sol');
    expect(below.line).toBe(RAW_CALL_LINE); // 24 — the call site

    // Gap 1: VSCode calls scopes() on the TOP frame whenever it pauses there. A
    // foreign frame has no contract/CU, so it must NOT attempt any Solidity
    // (Locals/State/Globals/Events) decoding — expose only the address-driven EVM
    // scope, and every scope's variables() must resolve without throwing.
    let scopes!: import('@vscode/debugprotocol').DebugProtocol.Scope[];
    expect(() => {
      ({scopes} = session.scopes(top.id));
    }).not.toThrow();
    // No Locals scope on a foreign frame (locals assume a real function).
    expect(scopes.some((s) => s.name === 'Locals')).toBe(false);
    // The EVM scope IS present (raw machine state is address-driven, not
    // contract-driven) — a foreign frame is still inspectable at the EVM level.
    expect(scopes.some((s) => s.name === 'EVM')).toBe(true);
    // Every advertised scope reads without throwing.
    for (const scope of scopes) {
      await expect(
        session.variables(scope.variablesReference),
      ).resolves.toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Parent stepping across the etched subcall is not corrupted (step-over).
//    PASSES today — guard against the combinedDepth-corruption class. Step-over
//    from the raw-call line must run the etched depth-2 subcall to completion
//    and advance to the next statement in `run` at depth 1 (NOT descend / stall).
// ---------------------------------------------------------------------------

describe('EtchRaw parent step-over — advances past the etched subcall at depth 1', () => {
  it('bp on line 24 + continue, then next() → run@EtchRaw.sol:25 (single frame)', async () => {
    const session = new SolidityDebugSession();
    await session.launch(etchRawInputs());
    session.setBreakpoints({
      source: {path: 'src/EtchRaw.sol'},
      breakpoints: [{line: RAW_CALL_LINE}],
    });
    await session.continue();
    expect(session.currentStepIndex).toBe(202);
    expect(session.stackTrace().stackFrames[0]!.line).toBe(RAW_CALL_LINE);

    // Source-level step-over: runs the etched CALL to completion and lands on
    // the NEXT statement in `run` (line 25, `require(ok, "raw call failed");`).
    session.next();
    expect(session.currentStepIndex).toBe(325);

    const {stackFrames} = session.stackTrace();
    // Back at depth 1 — did NOT get stuck inside / descend into the etched frame.
    expect(stackFrames).toHaveLength(1);
    const top = stackFrames[0]!;
    expect(top.name).toContain('run');
    expect(top.source?.name).toBe('EtchRaw.sol');
    expect(top.line).toBe(25);
  });
});
