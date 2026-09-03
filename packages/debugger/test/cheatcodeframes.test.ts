/**
 * Sub-feature 4a — Cheatcode LABELED FRAME (behavioral).
 *
 * When the CURRENT step is a cheatcode CALL (a CALL to the cheatcode address
 * 0x7109709E…), `session.stackTrace()` should PREPEND a synthetic TOP frame with
 * a decoded name (e.g. `vm.startPrank(0xdead…beef)`) positioned at the cheatcode
 * call site's source line. The frame is ADDITIVE — the underlying contract frame
 * (`run`) is preserved beneath it — and non-descendable (no Solidity locals of
 * its own; not asserted here).
 *
 * ── CONFIRMED GROUND TRUTH (observed by running the real session; the trace is a
 *    frozen recording so every index/step-count below is deterministic) ───────
 *   Fixture: prank-run-trace.raw.json (kontrol, 933 steps), Prank.run(deadbeef…).
 *   - launch() opens PAUSED at step 128, source line 33 (`Target target = new
 *     Target();`), single frame `run`.
 *   - startPrank cheatcode CALL is step 574 (op=CALL, depth 1), mapped to
 *     Prank.sol line 37 (`vm.startPrank(who);`). REACHED deterministically:
 *     breakpoint on line 37 + continue() → step 479, then stepInstruction() until
 *     currentStepIndex === 574 (95 instruction steps).
 *   - stopPrank cheatcode CALL is step 917 (line 39) — not exercised here.
 *
 * These tests MUST FAIL today: at step 574 the current stackTrace() is a SINGLE
 * frame `[run@37]` (no cheatcode frame is synthesized yet), so the "top frame
 * contains startPrank" and "length ≥ 2" assertions fail for the RIGHT reason.
 * The negative/regression test (no cheatcode frame at a non-cheatcode step)
 * already passes today and must NOT regress.
 */
import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {SolidityDebugSession, type LaunchInputs} from '../src/index.js';

// ── fixture loaders (mirrors modifierframes.test.ts) ────────────────────────
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

function prankInputs(): LaunchInputs {
  return {
    buildInfoJson: readBuildInfo('prank-build-info.json'),
    traceJson: readTrace('prank-run-trace.raw.json'),
    sourcePath: 'src/Prank.sol',
    contractName: 'Prank',
    methodName: 'run',
    dialect: 'kontrol',
    codeAddress: readAddress('prank-run-meta.json'),
  };
}

const START_PRANK_STEP = 574;
const START_PRANK_LINE = 37;

/** Navigate a freshly launched session exactly onto the startPrank CALL step. */
async function sessionAtStartPrank(): Promise<SolidityDebugSession> {
  const session = new SolidityDebugSession();
  await session.launch(prankInputs());
  session.setBreakpoints({
    source: {path: 'src/Prank.sol'},
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

    // The synthetic cheatcode frame is ADDITIVE: run is preserved beneath it.
    expect(stackFrames.length).toBeGreaterThanOrEqual(2);

    // [0] = the cheatcode frame. Display format is the implementer's to finalize
    // (e.g. `vm.startPrank(0xdead…beef)`) — assert on robust substrings only.
    const top = stackFrames[0]!;
    expect(top.name).toContain('startPrank');
    expect(top.name).toContain('0xdead'); // the pranked address prefix
    expect(top.line).toBe(START_PRANK_LINE);
    expect(top.source?.name).toBe('Prank.sol');

    // The frame BELOW the cheatcode frame is the real `run` frame.
    const below = stackFrames[1]!;
    expect(below.name).toContain('run');
  });

  it('NEGATIVE: no cheatcode frame at a non-cheatcode step (right after launch)', async () => {
    const session = new SolidityDebugSession();
    await session.launch(prankInputs());
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
