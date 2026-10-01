/**
 * A cheatcode frame shows its decoded dynamic args.
 *
 * A cheatcode CALL gets a synthetic top frame named `vm.${display}`. A dynamic
 * `bytes`/`string` arg is decoded into the label rather than rendered as a
 * `<type>` placeholder, so the frame at the `vm.etch` call reads
 * `vm.etch(0x…beef, 0x600160005260206000f3)`, not `vm.etch(0x…beef, <bytes>)`.
 *
 * Ground truth (etchraw-run-trace.raw.json, kontrol, 420 steps, EtchRaw.run();
 * every index below is deterministic):
 *   - launch() opens paused at step 35.
 *   - the vm.etch cheatcode CALL is step 191 (op=CALL), mapped to EtchRaw.sol
 *     line 23 (`vm.etch(TARGET, hex"600160005260206000f3");`), reached by
 *     stepInstruction() from launch.
 *   - at step 191 the stack is the cheatcode frame on top of the real `run`
 *     frame, both at line 23.
 *   - decoded args: address 0x…beef and bytes 0x600160005260206000f3
 *     (10 bytes).
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

describe('cheatcode frame — decoded bytes in the frame label', () => {
  it('lands exactly on the vm.etch CALL step (191)', async () => {
    const session = await sessionAtEtch();
    expect(session.currentStepIndex).toBe(ETCH_STEP);
  });

  it('the top frame shows the decoded etch bytes (not <bytes>)', async () => {
    const session = await sessionAtEtch();
    expect(session.currentStepIndex).toBe(ETCH_STEP);

    const {stackFrames} = session.stackTrace();

    // The synthetic cheatcode frame is additive: run is preserved beneath it.
    expect(stackFrames.length).toBeGreaterThanOrEqual(2);

    const top = stackFrames[0]!;
    expect(top.name).toContain('etch');
    expect(top.name).toContain('beef'); // the etch target address
    // The real decoded bytes appear in the label, not a placeholder.
    expect(top.name).toContain('600160005260206000f3');
    expect(top.name).not.toContain('<bytes>');
    expect(top.line).toBe(ETCH_LINE);
    expect(top.source?.name).toBe('EtchRaw.sol');

    // The frame below the cheatcode frame is the real `run` frame.
    const below = stackFrames[1]!;
    expect(below.name).toContain('run');
  });
});
