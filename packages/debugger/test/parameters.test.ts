/**
 * Reading function input parameters (value types) through the debugger,
 * for both externally-entered frames (params in calldata) and internally-entered
 * frames (params on the stack).
 *
 * The motivating case is `v` inside `Stepper.double`: `double` is called
 * internally from `run` via a Solidity JUMP (same EVM depth), so its parameter
 * `v` lives on the stack, not in calldata. A naive debugger that reads every
 * parameter from calldata would mis-read `v` inside `double` as `run`'s
 * calldata word (x = 10) instead of the true stack value (v = 11).
 *
 * Ground truth (from the fixtures):
 *   - Stepper.run(10): a=11, b=double(11)=22; the breakpoint on line 14 lands on
 *     step 182 inside `double`, where the stack holds v = 11.
 *   - Stepper.run entry: x = 10 (calldata).
 *   - Counter.setNumber(42): newNumber = 42 (calldata).
 *   - Vars.setAll(7,1000,true,0x..aa,-5,0x1122..,Blue): all 7 params (calldata).
 *
 * The parameter scope: the session exposes params in a scope named `Locals` or
 * `Parameters`. These tests locate the scope by accepting either name (see
 * {@link paramsScopeRef}) so they pin the read behavior, not the scope label.
 *
 * The internal `v = 11` case is the key check: the `double` frame's param scope
 * reads `v = 11` from the stack, not `v = 10` from `run`'s calldata.
 */
import {describe, expect, it} from 'vitest';

import {type SolidityDebugSession} from '../src/index.js';
import {
  breakAt as breakAtSpec,
  children,
  launch,
  type DapVariable,
  type Spec,
} from './support/harness.js';

// ## Fixtures

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

const varsSpec: Spec = {
  buildInfo: 'vars-build-info.json',
  trace: 'vars-setall-trace.raw.json',
  meta: 'vars-setall-meta.json',
  sourcePath: 'src/Vars.sol',
  contractName: 'Vars',
  methodName: 'setAll',
};

/**
 * The variablesReference of the current frame's parameter scope. Value-type
 * input params live in either a `Parameters` or a `Locals` scope; accept
 * whichever the session exposes so the test pins the read, not the
 * label. Uses the deepest (top) stack frame — the current frame.
 */
function paramsScopeRef(session: SolidityDebugSession): number {
  const frames = session.stackTrace().stackFrames;
  const frameId = frames[0]!.id; // top-first: deepest/current frame
  const {scopes} = session.scopes(frameId);
  const scope =
    scopes.find((s) => s.name === 'Parameters') ??
    scopes.find((s) => s.name === 'Locals');
  if (scope === undefined) {
    throw new Error(
      `no parameter scope found; scopes were: ${scopes
        .map((s) => s.name)
        .join(', ')}`,
    );
  }
  return scope.variablesReference;
}

/** Read the current frame's parameter variables. */
async function readParams(
  session: SolidityDebugSession,
): Promise<DapVariable[]> {
  return children(session, paramsScopeRef(session));
}

// ## 1. Stepper — internal stack param `v` inside double (the key case)

describe('Stepper internal frame — stack param v inside double', () => {
  /** Launch, break on line 14 (inside double), continue → step 182. */
  async function insideDouble(): Promise<SolidityDebugSession> {
    return breakAtSpec(stepperSpec, 14);
  }

  it('reaches line 14 inside double (step 182)', async () => {
    const session = await insideDouble();
    const top = session.stackTrace().stackFrames[0]!;
    expect(top.line).toBe(14);
    expect(top.name).toBe('double');
    expect(session.currentStepIndex).toBe(182);
  });

  it('the current frame parameter scope shows v = 11 (uint256), read from the stack', async () => {
    const session = await insideDouble();
    const params = await readParams(session);
    const v = params.find((p) => p.name === 'v');
    expect(v).toBeDefined();
    // The stack holds v = 11; a calldata read here would wrongly yield run's
    // x = 10 (the bug this test guards against).
    expect(v!.value).toBe('11');
    expect(v!.type).toBe('uint256');
  });

  it('does not leak run’s external param x into double’s parameter scope', async () => {
    const session = await insideDouble();
    const params = await readParams(session);
    expect(params.map((p) => p.name)).toEqual(['v']);
  });

  it('reads v = 11 at a deeper step inside double (dynamic stack depth)', async () => {
    // The stack pointer's depth-from-top must be recomputed per step from the
    // live stack length — v's absolute stack offset is fixed at frame entry
    // (entryStackHeight 7 − paramCount 1 = 6), but the depth is
    // `currentStackLength − 1 − absOffset`, which grows as `double`'s body pushes.
    //   step 182: len  8 → depth 1
    //   step 185: len 11 → depth 4  (still v = 11)
    // In the raw trace the value 11 stays at absolute stack index 6 at every
    // opcode of double's body (steps 180–188). Hardcoding depth 1 (correct only
    // at step 182) would mis-read v here.
    const session = await insideDouble();
    session.stepInstruction();
    session.stepInstruction();
    session.stepInstruction();
    expect(session.currentStepIndex).toBe(185);
    const top = session.stackTrace().stackFrames[0]!;
    expect(top.name).toBe('double');
    expect(top.line).toBe(14);
    const params = await readParams(session);
    const v = params.find((p) => p.name === 'v');
    expect(v).toBeDefined();
    expect(v!.value).toBe('11');
    expect(v!.type).toBe('uint256');
  });
});

// ## 2. Stepper — external calldata param `x` at run entry

describe('Stepper external frame — calldata param x at run entry', () => {
  it('parameter scope shows x = 10 (uint256)', async () => {
    const session = await launch(stepperSpec);
    const params = await readParams(session);
    const x = params.find((p) => p.name === 'x');
    expect(x).toMatchObject({value: '10', type: 'uint256'});
  });
});

// ## 3. Counter — external calldata param newNumber

describe('Counter external frame — calldata param newNumber', () => {
  it('parameter scope shows newNumber = 42 (uint256)', async () => {
    const session = await launch(counterSpec);
    const params = await readParams(session);
    const newNumber = params.find((p) => p.name === 'newNumber');
    expect(newNumber).toMatchObject({value: '42', type: 'uint256'});
  });
});

// ## 4. Vars — external calldata params (all 7 value types)

describe('Vars external frame — calldata params setAll (7 value types)', () => {
  async function setAllParams(): Promise<Map<string, DapVariable>> {
    const session = await launch(varsSpec);
    return new Map((await readParams(session)).map((p) => [p.name, p]));
  }

  it('decodes all 7 params (spot-check _a,_b,_flag,_owner,_delta,_color)', async () => {
    const byName = await setAllParams();
    expect(byName.get('_a')).toMatchObject({value: '7', type: 'uint8'});
    expect(byName.get('_b')).toMatchObject({value: '1000', type: 'uint16'});
    expect(byName.get('_flag')).toMatchObject({value: 'true', type: 'bool'});
    expect(byName.get('_owner')).toMatchObject({
      value: '0x00000000000000000000000000000000000000aa',
      type: 'address',
    });
    expect(byName.get('_delta')).toMatchObject({value: '-5', type: 'int256'});
    const color = byName.get('_color')!;
    expect(color.value).toBe('Blue');
    expect(color.type).toContain('Color');
  });
});
