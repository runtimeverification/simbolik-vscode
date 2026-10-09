/**
 * A cheatcode call gets a labelled synthetic frame.
 *
 * When the current step is a cheatcode CALL (a CALL to the cheatcode address
 * 0x7109709E…), `session.stackTrace()` prepends a synthetic top frame with a
 * decoded name (e.g. `vm.startPrank(0xdead…beef)`) positioned at the cheatcode
 * call site's source line. The frame is additive (the underlying contract frame
 * `run` is preserved beneath it) and non-descendable (no Solidity locals of its
 * own; not asserted here).
 *
 * Ground truth (prank-run-trace.raw.json, kontrol, 933 steps,
 * Prank.run(deadbeef…); every index/step-count below is deterministic):
 *   - launch() opens paused at step 128, source line 33 (`Target target = new
 *     Target();`), single frame `run`.
 *   - startPrank cheatcode CALL is step 574 (op=CALL, depth 1), mapped to
 *     Prank.sol line 37 (`vm.startPrank(who);`), reached by a breakpoint on
 *     line 37 + continue() → step 479, then stepInstruction() until
 *     currentStepIndex === 574 (95 instruction steps).
 *   - stopPrank cheatcode CALL is step 917 (line 39) — not exercised here.
 */
import {describe, expect, it} from 'vitest';

import type {SolidityDebugSession} from '../src/index.js';

import {launch, type Spec} from './support/harness.js';

const spec: Spec = {
  buildInfo: 'prank-build-info.json',
  trace: 'prank-run-trace.raw.json',
  meta: 'prank-run-meta.json',
  sourcePath: 'src/Prank.sol',
  contractName: 'Prank',
  methodName: 'run',
};

const START_PRANK_STEP = 574;
const START_PRANK_LINE = 37;

/** Navigate a freshly launched session exactly onto the startPrank CALL step. */
async function sessionAtStartPrank(): Promise<SolidityDebugSession> {
  const session = await launch(spec);
  session.setBreakpoints({
    source: {path: spec.sourcePath},
    breakpoints: [{line: START_PRANK_LINE}],
  });
  session.continue(); // → step 479, line 37
  // Instruction-step onto the exact cheatcode CALL step (frozen trace).
  let guard = 0;
  while (session.currentStepIndex < START_PRANK_STEP && guard++ < 2000) {
    session.stepInstruction();
  }
  return session;
}

describe('cheatcode frame — synthetic top frame at the cheatcode CALL', () => {
  it('lands exactly on the startPrank CALL step (574)', async () => {
    const session = await sessionAtStartPrank();
    expect(session.currentStepIndex).toBe(START_PRANK_STEP);
  });

  it('prepends a startPrank frame on top of the real run frame, at line 37', async () => {
    const session = await sessionAtStartPrank();
    expect(session.currentStepIndex).toBe(START_PRANK_STEP);

    const {stackFrames} = session.stackTrace();

    // The synthetic cheatcode frame is additive: run is preserved beneath it.
    expect(stackFrames.length).toBeGreaterThanOrEqual(2);

    // [0] = the cheatcode frame (e.g. `vm.startPrank(0xdead…beef)`); assert on
    // robust substrings only.
    const top = stackFrames[0]!;
    expect(top.name).toContain('startPrank');
    expect(top.name).toContain('0xdead'); // the pranked address prefix
    expect(top.line).toBe(START_PRANK_LINE);
    expect(top.source?.name).toBe('Prank.sol');

    // The frame below the cheatcode frame is the real `run` frame.
    const below = stackFrames[1]!;
    expect(below.name).toContain('run');
  });

  it('adds no cheatcode frame at a non-cheatcode step (right after launch)', async () => {
    const session = await launch(spec);
    // Launch pauses at step 128 (line 33) — an ordinary statement, not a
    // cheatcode CALL. The top frame must be the real `run` frame.
    expect(session.currentStepIndex).toBe(128);

    const {stackFrames} = session.stackTrace();
    const top = stackFrames[0]!;
    expect(top.name).not.toContain('startPrank');
    expect(top.name).not.toContain('vm.');
    expect(top.name).toContain('run');
  });
});
