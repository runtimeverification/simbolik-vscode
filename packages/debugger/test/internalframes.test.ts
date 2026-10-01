/**
 * Internal-function frames as their own DAP stack frames.
 *
 * A Solidity internal call (a constant-EVM-depth JUMP) does not create an EVM
 * frame, so the innermost EVM frame is expanded into its internal-function
 * sub-frames: pausing inside an internal function shows a stack
 * `[internal function, caller]`, each with its own per-frame variable binding.
 *
 * Ground truth (from the .sol sources and fixtures):
 *   Returns.calc(5) → helper (internal) @ Returns.sol:17 has y=5, out=12,
 *     local=6; the `helper(x)` call site is Returns.sol:9 in `calc` (x=5).
 *   Stepper.run(10) → double (internal) @ Stepper.sol:14 has v=11 (step 182);
 *     the `double(a)` call site is Stepper.sol:9 in `run`.
 *   Counter.setNumber(42): a plain external call with no internal frame at the
 *     paused step → the stack stays length 1 (`setNumber` only).
 */
import {describe, expect, it} from 'vitest';

import type {SolidityDebugSession} from '../src/index.js';
import {
  breakAt,
  children,
  launch,
  scopeRef,
  type DapVariable,
  type Spec,
} from './support/harness.js';

// ## Fixture specs (per contract)

const returnsSpec: Spec = {
  buildInfo: 'returns-build-info.json',
  trace: 'returns-calc-trace.raw.json',
  meta: 'returns-calc-meta.json',
  sourcePath: 'src/Returns.sol',
  contractName: 'Returns',
  methodName: 'calc',
  dialect: 'kontrol',
};
const stepperSpec: Spec = {
  buildInfo: 'stepper-build-info.json',
  trace: 'stepper-run-trace.raw.json',
  meta: 'stepper-run-meta.json',
  sourcePath: 'src/Stepper.sol',
  contractName: 'Stepper',
  methodName: 'run',
};
const counterSpec: Spec = {
  buildInfo: 'counter-build-info.json',
  trace: 'counter-setNumber-trace.raw.json',
  meta: 'counter-setNumber-meta.json',
  sourcePath: 'src/Counter.sol',
  contractName: 'Counter',
  methodName: 'setNumber',
};
const nestedSpec: Spec = {
  buildInfo: 'nestedcalls-build-info.json',
  trace: 'nestedcalls-outer-trace.raw.json',
  meta: 'nestedcalls-outer-meta.json',
  sourcePath: 'src/NestedCalls.sol',
  contractName: 'NestedCalls',
  methodName: 'outer',
  dialect: 'kontrol',
};

// ## Per-frame variable helper — the `Locals` scope holds a frame's own
// params+locals (session.scopes() emits 'State' | 'Locals' | 'EVM' | ...).

async function localsOf(
  session: SolidityDebugSession,
  frameId: number,
): Promise<Map<string, DapVariable>> {
  const vars = await children(session, scopeRef(session, 'Locals', frameId));
  return new Map(vars.map((v) => [v.name, v]));
}

// ## 1. Returns — internal `helper` frame with its own caller `calc` frame

describe('Returns internal frame — [helper, calc] with per-frame variables', () => {
  async function insideHelper(): Promise<SolidityDebugSession> {
    return breakAt(returnsSpec, 17);
  }

  it('pausing inside helper shows a 2-frame stack [helper@17, calc@9]', async () => {
    const session = await insideHelper();
    const {stackFrames} = session.stackTrace();

    expect(stackFrames).toHaveLength(2);
    // [0] top = the internal function at the paused line.
    expect(stackFrames[0]!.name).toBe('helper');
    expect(stackFrames[0]!.line).toBe(17);
    expect(stackFrames[0]!.source?.name).toBe('Returns.sol');
    // [1] caller = calc, positioned at the `helper(x)` call site (line 9).
    expect(stackFrames[1]!.name).toBe('calc');
    expect(stackFrames[1]!.line).toBe(9);
    expect(stackFrames[1]!.source?.name).toBe('Returns.sol');
  });

  it('helper frame Locals are helper’s own vars (y=5, out=12, local=6)', async () => {
    const session = await insideHelper();
    const {stackFrames} = session.stackTrace();
    const vars = await localsOf(session, stackFrames[0]!.id);

    expect(vars.get('y')).toMatchObject({value: '5', type: 'uint256'});
    expect(vars.get('out')).toMatchObject({value: '12', type: 'uint256'});
    expect(vars.get('local')).toMatchObject({value: '6', type: 'uint256'});
  });

  it('calc frame Locals are calc’s own vars, not helper’s (per-frame binding)', async () => {
    const session = await insideHelper();
    const {stackFrames} = session.stackTrace();
    const vars = await localsOf(session, stackFrames[1]!.id);

    // calc's own param is present...
    expect(vars.get('x')).toMatchObject({value: '5', type: 'uint256'});
    // ...and helper's own names must not leak into calc's frame.
    expect(vars.has('out')).toBe(false);
    expect(vars.has('local')).toBe(false);
    expect(vars.has('y')).toBe(false);
  });
});

// ## 2. Stepper — internal `double` frame with its own caller `run` frame

describe('Stepper internal frame — [double, run] with stack param v', () => {
  // Breakpoint on line 14 + continue lands on step 182, inside double.
  async function insideDouble(): Promise<SolidityDebugSession> {
    return breakAt(stepperSpec, 14);
  }

  it('pausing inside double shows a 2-frame stack [double@14, run@9]', async () => {
    const session = await insideDouble();
    expect(session.currentStepIndex).toBe(182); // confirms we are inside double
    const {stackFrames} = session.stackTrace();

    expect(stackFrames).toHaveLength(2);
    expect(stackFrames[0]!.name).toBe('double');
    expect(stackFrames[0]!.line).toBe(14);
    expect(stackFrames[0]!.source?.name).toBe('Stepper.sol');
    expect(stackFrames[1]!.name).toBe('run');
    expect(stackFrames[1]!.line).toBe(9);
    expect(stackFrames[1]!.source?.name).toBe('Stepper.sol');
  });

  it('double frame Locals read v=11 from the stack (its own param)', async () => {
    const session = await insideDouble();
    const {stackFrames} = session.stackTrace();
    const vars = await localsOf(session, stackFrames[0]!.id);

    expect(vars.get('v')).toMatchObject({value: '11', type: 'uint256'});
  });
});

// ## 3. No internal call — a plain external call stays a single frame

describe('No internal call — Counter.setNumber is a single frame', () => {
  it('at entry the stack is length 1 and the top frame is setNumber', async () => {
    const session = await launch(counterSpec);
    const {stackFrames} = session.stackTrace();

    expect(stackFrames).toHaveLength(1);
    expect(stackFrames[0]!.name).toBe('setNumber');
  });
});

// ## 4. stepOut consistency — the rendered stack tracks stepping

describe('stepOut consistency — internal frame collapses back to the caller', () => {
  it('inside double the stack is 2 deep; stepOut returns to run (length 1)', async () => {
    const session = await launch(stepperSpec);

    // next (entry line 8 → line 9), stepIn (line 9 → line 14 inside double).
    await session.next();
    await session.stepIn();
    expect(session.stackTrace().stackFrames[0]!.line).toBe(14); // inside double

    // While inside double the stack is [double, run].
    expect(session.stackTrace().stackFrames).toHaveLength(2);

    // stepOut returns to run at the call site (line 9) → the internal frame is
    // gone, so the stack shrinks back to the single caller frame.
    await session.stepOut();
    const {stackFrames} = session.stackTrace();
    expect(stackFrames).toHaveLength(1);
    expect(stackFrames[0]!.name).toBe('run');
    expect(stackFrames[0]!.line).toBe(9);
  });
});

// ## 5. NestedCalls — multi-level internal calls (the pop/re-push path).
//    outer(5): nested outer→level1→level2, then sequential outer→leaf
//    (single EVM depth).

describe('NestedCalls — nested + sequential internal frames', () => {
  it('inside level2 shows a 3-frame stack [level2@23, level1@18, outer@11]', async () => {
    // Breakpoint on line 23 (`return z * 2;` inside level2, the deepest).
    const session = await breakAt(nestedSpec, 23);

    const {stackFrames} = session.stackTrace();
    expect(stackFrames).toHaveLength(3);
    // Top-first: innermost at the paused line, each parent at its call site.
    expect(stackFrames[0]!.name).toBe('level2');
    expect(stackFrames[0]!.line).toBe(23);
    expect(stackFrames[1]!.name).toBe('level1');
    expect(stackFrames[1]!.line).toBe(18); // `level2(y)` call site
    expect(stackFrames[2]!.name).toBe('outer');
    expect(stackFrames[2]!.line).toBe(11); // `level1(x)` call site

    // Per-frame variable binding: each frame reads its own param (all = 5).
    expect((await localsOf(session, stackFrames[0]!.id)).get('z')).toMatchObject({
      value: '5',
    });
    expect((await localsOf(session, stackFrames[1]!.id)).get('y')).toMatchObject({
      value: '5',
    });
    expect((await localsOf(session, stackFrames[2]!.id)).get('x')).toMatchObject({
      value: '5',
    });
  });

  it('inside leaf shows [leaf@27, outer@12] — level1/level2 popped (sequential)', async () => {
    // Breakpoint on line 27 (`return w + 100;` inside leaf).
    const session = await breakAt(nestedSpec, 27);

    const {stackFrames} = session.stackTrace();
    // level1 + level2 have returned before leaf is called → not on the stack.
    expect(stackFrames).toHaveLength(2);
    expect(stackFrames[0]!.name).toBe('leaf');
    expect(stackFrames[0]!.line).toBe(27);
    expect(stackFrames[1]!.name).toBe('outer');
    expect(stackFrames[1]!.line).toBe(12); // `leaf(x)` call site
    expect(stackFrames.map((f) => f.name)).not.toContain('level1');
    expect(stackFrames.map((f) => f.name)).not.toContain('level2');
  });
});
