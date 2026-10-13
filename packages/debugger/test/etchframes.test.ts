/**
 * Etched and unidentifiable frames.
 *
 * Kontrol's `vm.etch(addr, code)` installs runtime bytecode at an address that
 * was never deployed; a later CALL into that address runs the etched code as a
 * real depth++ frame. When the etched code is an identifiable compiled contract
 * (CBOR-matched to a compilation unit in build-info), the frame resolves to its
 * real source. When it is not identifiable (raw bytecode, no CBOR, no matching
 * CU), the frame is rendered as foreign (EVM-only: no Solidity source; addressed
 * by its code address) rather than falling back to the entry contract's CU and
 * mis-mapping the foreign PCs onto the wrong source — and the parent frame's
 * stepping is not corrupted.
 *
 * Ground truth (every step index below is deterministic):
 *
 * Fixture 1 — known etch:
 *   etch-run-trace.raw.json (kontrol, 761 steps), Etch.run().
 *   - launch() opens paused at step 35, Etch.sol line 34 (`vm.etch(...)`).
 *   - vm.etch cheatcode CALL is atomic at depth 1 (~step 274).
 *   - CALL into 0x…beef is at step 396→397 (depth 1→2).
 *   - depth-2 region = steps 397–652: at the dispatcher entry (~397) the top
 *     frame is `Impl@Etch.sol:16`, and in the body it is `setStored@Etch.sol:19`
 *     (decl) / `:20` (the `stored=v*2;` body line). Breakpoint on line 20 +
 *     continue → step 506, top frame `setStored@Etch.sol:20`, parent
 *     `run@Etch.sol:35`. Impl and Etch live in the same file (Etch.sol), so
 *     source.name is "Etch.sol" for both frames.
 *
 * Fixture 2 — raw etch:
 *   etchraw-run-trace.raw.json (kontrol, 420 steps), EtchRaw.run().
 *   Etched code 0x600160005260206000f3 is raw bytecode — no CBOR, not a known CU.
 *   - launch() opens paused at step 35, EtchRaw.sol line 23 (`vm.etch(...)`).
 *   - vm.etch cheatcode CALL is atomic at depth 1 (~step 191).
 *   - CALL into 0x…beef is at step 277→278 (depth 1→2).
 *   - depth-2 region = exactly steps 278–283 (6 steps of raw code).
 *   - With an entry-CU fallback, the top frame there would be
 *     `EtchRaw@EtchRaw.sol:14` (the raw PCs mis-mapped onto the EtchRaw
 *     contract decl).
 *   - Parent `run` is shown at line 24 at steps 275–277 and 284–285.
 *
 * Navigation used below:
 *   - Test 1: bp on Etch.sol line 20 + continue → step 506 (inside Impl body).
 *   - Test 2: bp on EtchRaw.sol line 24 + continue → step 202, then
 *     stepInstruction() until currentStepIndex ≥ 278 → lands on step 278 inside
 *     the raw depth-2 region (278–283).
 *   - Test 3: bp on EtchRaw.sol line 24 + continue → step 202 (`run@24`), then
 *     next() (source-level step-over) → step 325, `run@EtchRaw.sol:25` (the
 *     `require(ok, ...)` line — the next statement in run), single frame at
 *     depth 1, i.e. step-over runs the etched subcall to completion and neither
 *     descends into it nor gets stuck.
 *
 * The foreign frame's display name is checked with substrings only: it
 * contains the code address 'beef' (case-insensitively) and not 'EtchRaw'. The
 * firm facts are that it carries no Solidity `source` and that the parent frame
 * is uncorrupted.
 */
import {describe, expect, it} from 'vitest';

import type {SolidityDebugSession} from '../src/index.js';

import {breakAt, launch, type Spec} from './support/harness.js';

const etchSpec: Spec = {
  buildInfo: 'etch-build-info.json',
  trace: 'etch-run-trace.raw.json',
  meta: 'etch-run-meta.json',
  sourcePath: 'src/Etch.sol',
  contractName: 'Etch',
  methodName: 'run',
};

const etchRawSpec: Spec = {
  buildInfo: 'etchraw-build-info.json',
  trace: 'etchraw-run-trace.raw.json',
  meta: 'etchraw-run-meta.json',
  sourcePath: 'src/EtchRaw.sol',
  contractName: 'EtchRaw',
  methodName: 'run',
};

// ## 1. A known etch resolves to the etched contract's source.

describe('Etch known-etch frame — resolves to Impl.setStored source', () => {
  it('bp on Impl body (line 20) + continue → [setStored@Etch.sol:20, run@Etch.sol:35]', async () => {
    // line 20 = `stored = v * 2;` — inside Impl.setStored.
    const session = await breakAt(etchSpec, 20);

    // Landed inside the depth-2 etched region (region = steps 397–652).
    expect(session.currentStepIndex).toBe(506);

    const {stackFrames} = session.stackTrace();

    // The etched frame is on top of the real `run` frame.
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

// ## 2. A raw etch degrades to a foreign frame.

const RAW_CALL_LINE = 24; // `(bool ok, bytes memory ret) = TARGET.call("");`
const RAW_REGION_LO = 278; // first step of the raw depth-2 region
const RAW_REGION_HI = 283; // last step of the raw depth-2 region

/** Navigate a fresh EtchRaw session into the raw depth-2 region (278–283). */
async function sessionInRawRegion(): Promise<SolidityDebugSession> {
  const session = await breakAt(etchRawSpec, RAW_CALL_LINE); // → step 202, run@EtchRaw.sol:24
  // Instruction-step onto the first raw depth-2 step (frozen trace).
  let guard = 0;
  while (session.currentStepIndex < RAW_REGION_LO && guard++ < 2000) {
    session.stepInstruction();
  }
  return session;
}

describe('EtchRaw unidentifiable-etch frame — foreign, no source, parent intact', () => {
  it('lands inside the raw depth-2 region (steps 278–283)', async () => {
    const session = await sessionInRawRegion();
    expect(session.currentStepIndex).toBeGreaterThanOrEqual(RAW_REGION_LO);
    expect(session.currentStepIndex).toBeLessThanOrEqual(RAW_REGION_HI);
  });

  it('top frame is foreign (no Solidity source, address-derived name) with an uncorrupted run parent', async () => {
    const session = await sessionInRawRegion();
    expect(session.currentStepIndex).toBeGreaterThanOrEqual(RAW_REGION_LO);
    expect(session.currentStepIndex).toBeLessThanOrEqual(RAW_REGION_HI);

    const {stackFrames} = session.stackTrace();

    // Two frames: the foreign etched frame on top of the real `run` frame.
    expect(stackFrames).toHaveLength(2);

    const top = stackFrames[0]!;
    // The foreign frame is not attributed to any Solidity source.
    expect(top.source).toBeUndefined();
    // The frame is addressed by its code address (target 0x…beef), not the
    // entry contract.
    expect(top.name.toLowerCase()).toContain('beef');
    expect(top.name).not.toContain('EtchRaw');

    // The parent `run` frame is preserved and uncorrupted.
    const below = stackFrames[1]!;
    expect(below.name).toContain('run');
    expect(below.source?.name).toBe('EtchRaw.sol');
    expect(below.line).toBe(RAW_CALL_LINE); // 24 — the call site

    // VSCode calls scopes() on the top frame whenever it pauses there. A
    // foreign frame has no contract/CU, so it must not attempt any Solidity
    // (Locals/State/Globals/Events) decoding — expose only the address-driven EVM
    // scope, and every scope's variables() must resolve without throwing.
    let scopes!: import('@vscode/debugprotocol').DebugProtocol.Scope[];
    expect(() => {
      ({scopes} = session.scopes(top.id));
    }).not.toThrow();
    // No Locals scope on a foreign frame (locals assume a real function).
    expect(scopes.some((s) => s.name === 'Locals')).toBe(false);
    // The EVM scope is present (raw machine state is address-driven, not
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

// ## 3. Parent stepping across the etched subcall is not corrupted (step-over).
//    Guards against combinedDepth corruption: step-over from the raw-call line
//    runs the etched depth-2 subcall to completion and advances to the next
//    statement in `run` at depth 1 (no descending, no stalling).

describe('EtchRaw parent step-over — advances past the etched subcall at depth 1', () => {
  it('bp on line 24 + continue, then next() → run@EtchRaw.sol:25 (single frame)', async () => {
    const session = await breakAt(etchRawSpec, RAW_CALL_LINE);
    expect(session.currentStepIndex).toBe(202);
    expect(session.stackTrace().stackFrames[0]!.line).toBe(RAW_CALL_LINE);

    // Source-level step-over: runs the etched CALL to completion and lands on
    // the next statement in `run` (line 25, `require(ok, "raw call failed");`).
    session.next();
    expect(session.currentStepIndex).toBe(325);

    const {stackFrames} = session.stackTrace();
    // Back at depth 1 — did not get stuck inside / descend into the etched frame.
    expect(stackFrames).toHaveLength(1);
    const top = stackFrames[0]!;
    expect(top.name).toContain('run');
    expect(top.source?.name).toBe('EtchRaw.sol');
    expect(top.line).toBe(25);
  });
});
