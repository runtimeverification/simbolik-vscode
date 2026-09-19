/**
 * Sub-feature 4c — Cheatcode frame shows DECODED dynamic args (behavioral).
 *
 * 4a already prepends a synthetic TOP frame for a cheatcode CALL, named
 * `vm.${display}`. 4a decodes value-type args but renders a dynamic `bytes`/
 * `string` arg as a `<type>` placeholder, so today the frame at the `vm.etch`
 * call reads `vm.etch(0x…beef, <bytes>)`. 4c must decode the dynamic `bytes`
 * arg so the real value appears in the frame label.
 *
 * ── CONFIRMED GROUND TRUTH (observed by running the real session against the
 *    frozen trace — every index below is deterministic) ─────────────────────
 *   Fixture: etchraw-run-trace.raw.json (kontrol, 420 steps), EtchRaw.run().
 *   - launch() opens PAUSED at step 35.
 *   - the vm.etch cheatcode CALL is step 191 (op=CALL), mapped to EtchRaw.sol
 *     line 23 (`vm.etch(TARGET, hex"600160005260206000f3");`). REACHED by
 *     stepInstruction() from launch until currentStepIndex === 191.
 *   - at step 191 the stack is [ 'vm.etch(0x00000000…0000beef, <bytes>)@23',
 *     'run@23' ] — a 4a cheatcode frame on top of the real `run` frame.
 *   - decoded args (verified via decodeCheatcodeCall): address 0x…beef and bytes
 *     0x600160005260206000f3 (10 bytes).
 *
 * These MUST FAIL today: the top frame's name contains the `<bytes>` placeholder,
 * not the decoded `600160005260206000f3`, so the "contains the real bytes"
 * assertion fails for the RIGHT reason. The "frame beneath is run" assertion
 * already holds and must NOT regress.
 */
import {describe, expect, it} from 'vitest';

import type {SolidityDebugSession} from '../src/index.js';

import {launch, type Spec} from './support/harness.js';

const spec: Spec = {
  buildInfo: 'etchraw-build-info.json',
  trace: 'etchraw-run-trace.raw.json',
  meta: 'etchraw-run-meta.json',
  sourcePath: 'src/EtchRaw.sol',
  contractName: 'EtchRaw',
  methodName: 'run',
};

const ETCH_STEP = 191;
const ETCH_LINE = 23;

/** Instruction-step a freshly launched session onto the vm.etch CALL step. */
async function sessionAtEtch(): Promise<SolidityDebugSession> {
  const session = await launch(spec);
  let guard = 0;
  while (session.currentStepIndex < ETCH_STEP && guard++ < 3000) {
    session.stepInstruction();
  }
  return session;
}

describe('cheatcode frame (4c) — decoded bytes in the frame label', () => {
  it('lands exactly on the vm.etch CALL step (191)', async () => {
    const session = await sessionAtEtch();
    expect(session.currentStepIndex).toBe(ETCH_STEP);
  });

  it('the top frame shows the DECODED etch bytes (not <bytes>)', async () => {
    const session = await sessionAtEtch();
    expect(session.currentStepIndex).toBe(ETCH_STEP);

    const {stackFrames} = session.stackTrace();

    // The synthetic cheatcode frame is ADDITIVE: run is preserved beneath it.
    expect(stackFrames.length).toBeGreaterThanOrEqual(2);

    const top = stackFrames[0]!;
    expect(top.name).toContain('etch');
    expect(top.name).toContain('beef'); // the etch target address
    // The real decoded bytes appear in the label (today: the '<bytes>'
    // placeholder → this fails for the right reason).
    expect(top.name).toContain('600160005260206000f3');
    expect(top.name).not.toContain('<bytes>');
    expect(top.line).toBe(ETCH_LINE);
    expect(top.source?.name).toBe('EtchRaw.sol');

    // The frame BELOW the cheatcode frame is the real `run` frame.
    const below = stackFrames[1]!;
    expect(below.name).toContain('run');
  });
});
