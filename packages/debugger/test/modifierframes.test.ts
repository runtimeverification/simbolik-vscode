/**
 * Solidity modifier frames as their own DAP stack frames.
 *
 * A modifier body appears as its own DAP stack frame, on top of the function
 * it decorates. Paused inside the modifier body (pre-placeholder) the stack is
 * `[onlyPositive, bump]`; paused inside the function body (after the `_;`
 * placeholder) the modifier is suspended and the stack is just `[bump]`.
 *
 * This suite pins frame names + source lines only; it does not assert on
 * modifier-frame Locals contents (modifier params/locals such as x, doubled).
 *
 * Ground truth (fixture Modifiers.bump(5), 326 steps, kontrol; see
 * src/Modifiers.sol):
 *   - Launch opens paused just before step 110, on `bump`'s header at the
 *     `onlyPositive(x)` invocation (line 17); one step-in enters the modifier at
 *     step 110, line 12 (`uint256 doubled = x * 2;`).
 *   - Modifier decl: line 11; body lines 12–13; placeholder `_;`: line 14.
 *   - Function `bump` decl (with `onlyPositive(x)` applied): line 17; body
 *     lines 18–19.
 *   - Breakpoint on line 18 + continue → step 197, function body (modifier
 *     suspended).
 *
 * `closestFunction` returns undefined for a ModifierDefinition, so without
 * explicit modifier frames the single frame at step 110 falls back to the
 * contract name ("Modifiers").
 */
import {describe, expect, it} from 'vitest';

import {breakAt, launch, type Spec} from './support/harness.js';

// ## Fixture spec

const modifiersSpec: Spec = {
  buildInfo: 'modifiers-build-info.json',
  trace: 'modifiers-bump-trace.raw.json',
  meta: 'modifiers-bump-meta.json',
  sourcePath: 'src/Modifiers.sol',
  contractName: 'Modifiers',
  methodName: 'bump',
  dialect: 'kontrol',
};

// ## 1. Modifier frame at launch — paused inside the modifier body.

describe('Modifiers modifier frame — [onlyPositive, bump] inside the modifier body', () => {
  it('launch opens on the modifier invocation, before the modifier frame', async () => {
    const session = await launch(modifiersSpec);
    const {stackFrames} = session.stackTrace();
    expect(session.currentStepIndex).toBe(110);
    expect(stackFrames).toHaveLength(1);
    expect(stackFrames[0]!.name).toBe('bump');
    expect(stackFrames[0]!.line).toBe(17);
    // `onlyPositive(x)` in `function bump(uint256 x) public onlyPositive(x) …`.
    expect(stackFrames[0]!.column).toBe(37);
  });

  it('one step-in enters the modifier body (step 110, line 12)', async () => {
    const session = await launch(modifiersSpec);
    session.stepIn();

    // First confirm where we paused: inside the modifier body, not the
    // function body.
    expect(session.currentStepIndex).toBe(110);
    const {stackFrames} = session.stackTrace();
    // The innermost/top frame sits at the paused source line — line 12, which
    // is within the modifier body (lines 12–13).
    expect(stackFrames[0]!.line).toBe(12);
    expect(stackFrames[0]!.line).toBeGreaterThanOrEqual(12);
    expect(stackFrames[0]!.line).toBeLessThanOrEqual(13);
  });

  it('pausing inside the modifier shows a 2-frame stack [onlyPositive@12, bump@17]', async () => {
    const session = await launch(modifiersSpec);
    session.stepIn();
    const {stackFrames} = session.stackTrace();

    expect(stackFrames).toHaveLength(2);
    // [0] top = the modifier body at the paused line (line 12).
    expect(stackFrames[0]!.name).toBe('onlyPositive');
    expect(stackFrames[0]!.line).toBe(12);
    expect(stackFrames[0]!.source?.name).toBe('Modifiers.sol');
    // [1] = the decorated function, positioned at its decl / the
    // `onlyPositive(x)` application call site (line 17) — the same
    // parent-at-call-site convention as internal-function frames.
    expect(stackFrames[1]!.name).toBe('bump');
    expect(stackFrames[1]!.line).toBe(17);
    expect(stackFrames[1]!.source?.name).toBe('Modifiers.sol');
  });
});

// ## 2. The function body suspends the modifier — [bump@18] (length 1).

describe('Modifiers function body — modifier suspended → [bump@18]', () => {
  it('breakpoint on line 18 + continue → length-1 stack [bump@18]', async () => {
    const session = await breakAt(modifiersSpec, 18);

    expect(session.currentStepIndex).toBe(197); // inside the function body
    const {stackFrames} = session.stackTrace();

    // The modifier is suspended across the `_;` — not [onlyPositive, bump].
    expect(stackFrames).toHaveLength(1);
    expect(stackFrames[0]!.name).toBe('bump');
    expect(stackFrames[0]!.line).toBe(18);
    expect(stackFrames[0]!.source?.name).toBe('Modifiers.sol');
  });
});

// ## 3. The modifier frame is addressable — scopes() resolves it to a valid scope
//    list (State + EVM present). Locals contents are not asserted.

describe('Modifiers modifier frame is addressable via scopes()', () => {
  it('scopes(modifierFrame.id) returns a scope list including State and EVM', async () => {
    const session = await launch(modifiersSpec);
    session.stepIn(); // into the modifier body
    const {stackFrames} = session.stackTrace();

    // The modifier frame is [0] (top). Its id must resolve to a real scope list.
    const {scopes} = session.scopes(stackFrames[0]!.id);
    const names = scopes.map((s) => s.name);
    expect(names).toContain('State');
    expect(names).toContain('EVM');
  });
});

// ## 4. Resume — the modifier reappears on top after the function body returns.
//    This is the modifierDepth-decrease branch (1→0), a distinct code path from
//    the suspend (increase) branch that test 2 guards. The resume region (line
//    11, the modifier closing block, ~step 264) is not reachable via a source
//    breakpoint (line 11 has no stoppable statement) nor via source-level next()
//    (which skips it), but is reachable deterministically from the line-19 stop
//    (step 258) by 6 instruction steps.

describe('Modifiers resume — onlyPositive reappears after the function body', () => {
  it('modifier frame is re-emitted on resume (step 264, line 11)', async () => {
    // Breakpoint on line 19 (`stored = r;` — function body, step 258).
    const session = await breakAt(modifiersSpec, 19);
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

// ## 5. Unmapped-helper region inside the modifier body.
//    The modifier computes `x * 2` via a jump into an unmapped compiler
//    checked-mul helper (steps ~118-187 — 70 steps, the bulk of the body).
//    Those steps have no source mapping, so a naive "is cur's def a modifier?"
//    check (evaluated only at cur) would drop both frames and show a single
//    contract-named frame. The stack must stay [onlyPositive, bump] there.

describe('Modifiers — stack holds across the modifier’s unmapped helper region', () => {
  it('mid checked-mul helper (step 150) still shows [onlyPositive@12, bump@17]', async () => {
    const session = await launch(modifiersSpec); // entry = step 110 (line 12)
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
