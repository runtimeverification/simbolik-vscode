/**
 * Internal-FUNCTION frames as their own DAP stack frames (sub-feature 4a).
 *
 * Today a Solidity INTERNAL call (a constant-EVM-depth JUMP) collapses into its
 * caller: pausing inside an internal function yields a length-1 stack whose only
 * frame IS the internal function — there is no caller frame. After 4a, the
 * innermost EVM frame is expanded into its internal-function sub-frames, so
 * pausing inside an internal function shows a 2-level stack
 * `[internal function, caller]`, each with its OWN per-frame variable binding.
 *
 * Ground truth (existing fixtures, cross-checked against returns.test.ts /
 * parameters.test.ts / stepping.test.ts and the .sol sources):
 *   Returns.calc(5) → helper (internal) @ Returns.sol:17 has y=5, out=12,
 *     local=6; the `helper(x)` call site is Returns.sol:9 in `calc` (x=5).
 *   Stepper.run(10) → double (internal) @ Stepper.sol:14 has v=11 (step 182);
 *     the `double(a)` call site is Stepper.sol:9 in `run`.
 *   Counter.setNumber(42): a plain external call with NO internal frame at the
 *     paused step → the stack stays length 1 (`setNumber` only).
 *
 * These tests MUST FAIL before the implementation (tests 1, 2, 4): today the
 * stack is length 1 inside an internal function, so there is no `[1]` caller
 * frame. Test 3 (no-internal regression) MUST PASS already.
 */
import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {SolidityDebugSession, type LaunchInputs} from '../src/index.js';

// ---------------------------------------------------------------------------
// Fixture loaders (copied verbatim from returns.test.ts / parameters.test.ts)
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

interface DapVariable {
  name: string;
  value: string;
  type?: string;
}

// LaunchInputs — copied from the existing tests so the fixture/breakpoint
// pattern is identical.
function returnsInputs(): LaunchInputs {
  return {
    buildInfoJson: readBuildInfo('returns-build-info.json'),
    traceJson: readTrace('returns-calc-trace.raw.json'),
    sourcePath: 'src/Returns.sol',
    contractName: 'Returns',
    methodName: 'calc',
    dialect: 'kontrol',
    codeAddress: readAddress('returns-calc-meta.json'),
  };
}
function stepperInputs(): LaunchInputs {
  return {
    buildInfoJson: readBuildInfo('stepper-build-info.json'),
    traceJson: readTrace('stepper-run-trace.raw.json'),
    sourcePath: 'src/Stepper.sol',
    contractName: 'Stepper',
    methodName: 'run',
    codeAddress: readAddress('stepper-run-meta.json'),
  };
}
function counterInputs(): LaunchInputs {
  return {
    buildInfoJson: readBuildInfo('counter-build-info.json'),
    traceJson: readTrace('counter-setNumber-trace.raw.json'),
    sourcePath: 'src/Counter.sol',
    contractName: 'Counter',
    methodName: 'setNumber',
    codeAddress: readAddress('counter-setNumber-meta.json'),
  };
}
function nestedInputs(): LaunchInputs {
  return {
    buildInfoJson: readBuildInfo('nestedcalls-build-info.json'),
    traceJson: readTrace('nestedcalls-outer-trace.raw.json'),
    sourcePath: 'src/NestedCalls.sol',
    contractName: 'NestedCalls',
    methodName: 'outer',
    dialect: 'kontrol',
    codeAddress: readAddress('nestedcalls-outer-meta.json'),
  };
}

// ---------------------------------------------------------------------------
// Per-frame variable helper — the `Locals` scope holds a frame's own
// params+locals (session.scopes() emits 'State' | 'Locals' | 'EVM' | ...).
// ---------------------------------------------------------------------------

async function localsOf(
  session: SolidityDebugSession,
  frameId: number,
): Promise<Map<string, DapVariable>> {
  const {scopes} = session.scopes(frameId);
  const locals = scopes.find((s) => s.name === 'Locals');
  if (locals === undefined) {
    throw new Error(
      `no Locals scope for frame ${frameId}; scopes were: ${scopes
        .map((s) => s.name)
        .join(', ')}`,
    );
  }
  const {variables} = await session.variables(locals.variablesReference);
  return new Map((variables as DapVariable[]).map((v) => [v.name, v]));
}

// ---------------------------------------------------------------------------
// 1. Returns — internal `helper` frame with its own caller `calc` frame
// ---------------------------------------------------------------------------

describe('Returns internal frame — [helper, calc] with per-frame variables', () => {
  async function insideHelper(): Promise<SolidityDebugSession> {
    const session = new SolidityDebugSession();
    await session.launch(returnsInputs());
    session.setBreakpoints({
      source: {path: 'src/Returns.sol'},
      breakpoints: [{line: 17}],
    });
    await session.continue();
    return session;
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

  it('calc frame Locals are calc’s own vars, NOT helper’s (per-frame binding)', async () => {
    const session = await insideHelper();
    const {stackFrames} = session.stackTrace();
    const vars = await localsOf(session, stackFrames[1]!.id);

    // calc's own param is present...
    expect(vars.get('x')).toMatchObject({value: '5', type: 'uint256'});
    // ...and helper's own names must NOT leak into calc's frame.
    expect(vars.has('out')).toBe(false);
    expect(vars.has('local')).toBe(false);
    expect(vars.has('y')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. Stepper — internal `double` frame with its own caller `run` frame
// ---------------------------------------------------------------------------

describe('Stepper internal frame — [double, run] with stack param v', () => {
  // Reach INSIDE double the way parameters.test.ts / stepping.test.ts do:
  // breakpoint on line 14 + continue lands on step 182, inside double.
  async function insideDouble(): Promise<SolidityDebugSession> {
    const session = new SolidityDebugSession();
    await session.launch(stepperInputs());
    session.setBreakpoints({
      source: {path: 'src/Stepper.sol'},
      breakpoints: [{line: 14}],
    });
    await session.continue();
    return session;
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

// ---------------------------------------------------------------------------
// 3. No-internal regression — a plain external call is unchanged (length 1)
// ---------------------------------------------------------------------------

describe('No-internal regression — Counter.setNumber is a single frame', () => {
  it('at entry the stack is length 1 and the top frame is setNumber', async () => {
    const session = new SolidityDebugSession();
    await session.launch(counterInputs());
    const {stackFrames} = session.stackTrace();

    expect(stackFrames).toHaveLength(1);
    expect(stackFrames[0]!.name).toBe('setNumber');
  });
});

// ---------------------------------------------------------------------------
// 4. stepOut consistency — the rendered stack tracks stepping
// ---------------------------------------------------------------------------

describe('stepOut consistency — internal frame collapses back to the caller', () => {
  it('inside double the stack is 2 deep; stepOut returns to run (length 1)', async () => {
    const session = new SolidityDebugSession();
    await session.launch(stepperInputs());

    // Drive INSIDE double exactly as stepping.test.ts does:
    //   next (entry line 8 → line 9), stepIn (line 9 → line 14 inside double).
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

// ---------------------------------------------------------------------------
// 5. NestedCalls — MULTI-LEVEL internal calls (the pop/re-push core path).
//    outer(5): NESTED outer→level1→level2, then SEQUENTIAL outer→leaf.
//    (New live fixture recorded from kontrol-node; single EVM depth.)
// ---------------------------------------------------------------------------

describe('NestedCalls — nested + sequential internal frames', () => {
  it('inside level2 shows a 3-frame stack [level2@23, level1@18, outer@11]', async () => {
    const session = new SolidityDebugSession();
    await session.launch(nestedInputs());
    session.setBreakpoints({
      source: {path: 'src/NestedCalls.sol'},
      breakpoints: [{line: 23}], // `return z * 2;` inside level2 (deepest)
    });
    await session.continue();

    const {stackFrames} = session.stackTrace();
    expect(stackFrames).toHaveLength(3);
    // Top-first: innermost at the paused line, each parent at its call site.
    expect(stackFrames[0]!.name).toBe('level2');
    expect(stackFrames[0]!.line).toBe(23);
    expect(stackFrames[1]!.name).toBe('level1');
    expect(stackFrames[1]!.line).toBe(18); // `level2(y)` call site
    expect(stackFrames[2]!.name).toBe('outer');
    expect(stackFrames[2]!.line).toBe(11); // `level1(x)` call site

    // Per-frame variable binding: each frame reads its OWN param (all = 5).
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
    const session = new SolidityDebugSession();
    await session.launch(nestedInputs());
    session.setBreakpoints({
      source: {path: 'src/NestedCalls.sol'},
      breakpoints: [{line: 27}], // `return w + 100;` inside leaf
    });
    await session.continue();

    const {stackFrames} = session.stackTrace();
    // level1 + level2 have returned before leaf is called → NOT on the stack.
    expect(stackFrames).toHaveLength(2);
    expect(stackFrames[0]!.name).toBe('leaf');
    expect(stackFrames[0]!.line).toBe(27);
    expect(stackFrames[1]!.name).toBe('outer');
    expect(stackFrames[1]!.line).toBe(12); // `leaf(x)` call site
    expect(stackFrames.map((f) => f.name)).not.toContain('level1');
    expect(stackFrames.map((f) => f.name)).not.toContain('level2');
  });
});
