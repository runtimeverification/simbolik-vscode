/**
 * Solidity MODIFIER frames as their own DAP stack frames (sub-feature 4b).
 *
 * A modifier body should appear as its OWN DAP stack frame, on TOP of the
 * function it decorates. Paused inside the modifier body (pre-placeholder) the
 * stack should be `[onlyPositive, bump]`; paused inside the function body (after
 * the `_;` placeholder) the modifier is SUSPENDED and the stack is just `[bump]`.
 *
 * Scope of this cycle: frame NAME + source line only. Modifier params/locals
 * (x, doubled) are DEFERRED — the modifier frame shows storage-only Locals — so
 * these tests deliberately do NOT assert on modifier-frame Locals contents.
 *
 * Ground truth (recorded fixture Modifiers.bump(5), 326 steps, kontrol —
 * observed by running the session, cross-checked against src/Modifiers.sol):
 *   - Launch opens PAUSED at step 110, line 12 (inside the modifier body,
 *     `uint256 doubled = x * 2;`). Verified via session.currentStepIndex.
 *   - Modifier decl: line 11; body lines 12–13; placeholder `_;`: line 14.
 *   - Function `bump` decl (with `onlyPositive(x)` applied): line 17; body
 *     lines 18–19.
 *   - Breakpoint on line 18 + continue → step 197, function body (modifier
 *     suspended).
 *
 * These tests MUST FAIL before implementation. Today at step 110 the stack is
 * length 1 and the single frame is named "Modifiers" (the CONTRACT — because
 * closestFunction returns undefined for a ModifierDefinition, so no modifier
 * frame is pushed and #buildFrame falls back to the contract name). So test 1
 * fails for the right reason. Test 2 (function body → [bump@18]) already passes
 * today — 4a yields it — and 4b must not regress it.
 */
import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {SolidityDebugSession, type LaunchInputs} from '../src/index.js';

// ---------------------------------------------------------------------------
// Fixture loaders (copied verbatim from internalframes.test.ts)
// ---------------------------------------------------------------------------

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

// LaunchInputs — mirrors internalframes.test.ts, pointed at the Modifiers
// fixture.
function modifiersInputs(): LaunchInputs {
  return {
    buildInfoJson: readBuildInfo('modifiers-build-info.json'),
    traceJson: readTrace('modifiers-bump-trace.raw.json'),
    sourcePath: 'src/Modifiers.sol',
    contractName: 'Modifiers',
    methodName: 'bump',
    dialect: 'kontrol',
    codeAddress: readAddress('modifiers-bump-meta.json'),
  };
}

// ---------------------------------------------------------------------------
// 1. Modifier frame at launch — paused inside the modifier body.
// ---------------------------------------------------------------------------

describe('Modifiers modifier frame — [onlyPositive, bump] inside the modifier body', () => {
  it('launch opens paused inside the modifier body (step 110, line 12)', async () => {
    const session = new SolidityDebugSession();
    await session.launch(modifiersInputs());

    // FIRST confirm WHERE we paused (observed by running the session): the
    // launch opens inside the modifier body, not the function body.
    expect(session.currentStepIndex).toBe(110);
    const {stackFrames} = session.stackTrace();
    // The innermost/top frame sits at the paused source line — line 12, which
    // is within the modifier body (lines 12–13).
    expect(stackFrames[0]!.line).toBe(12);
    expect(stackFrames[0]!.line).toBeGreaterThanOrEqual(12);
    expect(stackFrames[0]!.line).toBeLessThanOrEqual(13);
  });

  it('pausing inside the modifier shows a 2-frame stack [onlyPositive@12, bump@17]', async () => {
    const session = new SolidityDebugSession();
    await session.launch(modifiersInputs());
    const {stackFrames} = session.stackTrace();

    expect(stackFrames).toHaveLength(2);
    // [0] top = the MODIFIER body at the paused line (entry line 12, observed).
    expect(stackFrames[0]!.name).toBe('onlyPositive');
    expect(stackFrames[0]!.line).toBe(12);
    expect(stackFrames[0]!.source?.name).toBe('Modifiers.sol');
    // [1] = the decorated FUNCTION, positioned at its decl / the
    // `onlyPositive(x)` application call site (line 17) — the parent-at-call-site
    // convention 4a already uses.
    expect(stackFrames[1]!.name).toBe('bump');
    expect(stackFrames[1]!.line).toBe(17);
    expect(stackFrames[1]!.source?.name).toBe('Modifiers.sol');
  });
});

// ---------------------------------------------------------------------------
// 2. Function body SUSPENDS the modifier — [bump@18] (length 1).
//    4a already yields this; 4b must NOT regress it.
// ---------------------------------------------------------------------------

describe('Modifiers function body — modifier suspended → [bump@18]', () => {
  it('breakpoint on line 18 + continue → length-1 stack [bump@18]', async () => {
    const session = new SolidityDebugSession();
    await session.launch(modifiersInputs());
    session.setBreakpoints({
      source: {path: 'src/Modifiers.sol'},
      breakpoints: [{line: 18}],
    });
    await session.continue();

    expect(session.currentStepIndex).toBe(197); // inside the function body
    const {stackFrames} = session.stackTrace();

    // The modifier is SUSPENDED across the `_;` — NOT [onlyPositive, bump].
    expect(stackFrames).toHaveLength(1);
    expect(stackFrames[0]!.name).toBe('bump');
    expect(stackFrames[0]!.line).toBe(18);
    expect(stackFrames[0]!.source?.name).toBe('Modifiers.sol');
  });
});

// ---------------------------------------------------------------------------
// 3. The modifier frame is ADDRESSABLE — scopes() resolves it.
//    Params/locals are DEFERRED, so we only assert the frame resolves to a
//    valid scope list (State + EVM present); we do NOT assert Locals contents.
// ---------------------------------------------------------------------------

describe('Modifiers modifier frame is addressable via scopes()', () => {
  it('scopes(modifierFrame.id) returns a scope list including State and EVM', async () => {
    const session = new SolidityDebugSession();
    await session.launch(modifiersInputs());
    const {stackFrames} = session.stackTrace();

    // The modifier frame is [0] (top). Its id must resolve to a real scope list.
    const {scopes} = session.scopes(stackFrames[0]!.id);
    const names = scopes.map((s) => s.name);
    expect(names).toContain('State');
    expect(names).toContain('EVM');
  });
});

// ---------------------------------------------------------------------------
// 4. Resume — the modifier reappears on top after the function body returns.
//    This is the modifierDepth-DECREASE branch (1→0), a DISTINCT code path from
//    the suspend (increase) branch that test 3 guards. The resume region (line
//    11, the modifier closing block, ~step 264) is not reachable via a source
//    breakpoint (line 11 has no stoppable statement) nor via source-level next()
//    (which skips it), but IS reachable deterministically from the line-19 stop
//    (step 258) by 6 instruction steps — the trace is a frozen recording, so the
//    count is stable (same as the suite's existing exact-step pins).
// ---------------------------------------------------------------------------

describe('Modifiers resume — onlyPositive reappears after the function body', () => {
  it('modifier frame is re-emitted on resume (step 264, line 11)', async () => {
    const session = new SolidityDebugSession();
    await session.launch(modifiersInputs());
    session.setBreakpoints({
      source: {path: 'src/Modifiers.sol'},
      breakpoints: [{line: 19}], // `stored = r;` — function body, step 258
    });
    await session.continue();
    // Instruction-step into the modifier's closing block (resume: modDepth 1→0).
    for (let i = 0; i < 6; i++) session.stepInstruction();
    expect(session.currentStepIndex).toBe(264);

    const {stackFrames} = session.stackTrace();
    expect(stackFrames).toHaveLength(2);
    expect(stackFrames[0]!.name).toBe('onlyPositive');
    expect(stackFrames[0]!.line).toBe(11); // modifier closing block
    expect(stackFrames[1]!.name).toBe('bump');
    expect(stackFrames[1]!.line).toBe(17);
  });
});

// ---------------------------------------------------------------------------
// 5. Unmapped-helper region inside the modifier body (regression guard).
//    The modifier computes `x * 2` via a jump into an UNMAPPED compiler
//    checked-mul helper (steps ~118-187 — 70 steps, the bulk of the body).
//    Those steps have no source mapping, so a naive "is cur's def a modifier?"
//    check (evaluated only at cur) would drop BOTH frames and show a single
//    contract-named frame. The stack must stay [onlyPositive, bump] there.
// ---------------------------------------------------------------------------

describe('Modifiers — stack holds across the modifier’s unmapped helper region', () => {
  it('mid checked-mul helper (step 150) still shows [onlyPositive@12, bump@17]', async () => {
    const session = new SolidityDebugSession();
    await session.launch(modifiersInputs()); // entry = step 110 (line 12)
    for (let i = 0; i < 40; i++) session.stepInstruction();
    expect(session.currentStepIndex).toBe(150); // deep in the unmapped helper

    const {stackFrames} = session.stackTrace();
    expect(stackFrames).toHaveLength(2);
    expect(stackFrames[0]!.name).toBe('onlyPositive');
    expect(stackFrames[0]!.line).toBe(12); // walked back to the mapped modifier line
    expect(stackFrames[1]!.name).toBe('bump');
    expect(stackFrames[1]!.line).toBe(17);
  });
});
