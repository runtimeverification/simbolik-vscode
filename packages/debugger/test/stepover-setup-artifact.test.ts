/**
 * Step-into / step-over do not stop on a viaIR straight-line setup artifact —
 * a later statement's source position emitted out of source order for
 * stack-setup instructions that physically precede an earlier statement's real
 * execution.
 *
 * Real trace of `TwoCalls.run()` (820 steps, compiled `--via-ir`), modelled on
 * uniswap-v4-core `Deployers.deployMintAndApprove2Currencies`:
 *   line 29  uint256 a = mk(3);            (first call → local a)
 *   line 30  uint256 b = mk(5);            (second call → local b)
 *   line 31  (out0, out1) = order(a, b);   (tuple assign from a multi-arg call)
 *
 * Under viaIR the function's argument/return-slot setup is one contiguous
 * straight-line block; solc attributes the tuple statement's source position
 * (line 31) to bare-`PUSH` setup steps that run before line 29 and again between
 * lines 29 and 30, each a multi-step run that the one-step persistence guard does
 * not catch. Without the per-run setup-artifact guard (a flat run that falls
 * through — no taken jump — to an earlier statement is not a real stop),
 * `entry()` would land on line 31 instead of line 29, and step-over from line 29
 * would skip line 30.
 *
 * Ground truth: entry = line 29; step-over 29 → 30 → 31; step-into line 29
 * descends into `mk` at line 20 (`out0 += seed;`).
 */
import {describe, expect, it} from 'vitest';

import type {SolidityDebugSession} from '../src/index.js';
import {launch, line, type Spec} from './support/harness.js';

const spec: Spec = {
  buildInfo: 'twocalls-viair-build-info.json',
  trace: 'twocalls-viair-run-trace.raw.json',
  meta: 'twocalls-viair-run-meta.json',
  sourcePath: 'src/TwoCalls.sol',
  contractName: 'TwoCalls',
  methodName: 'run',
  dialect: 'kontrol',
};

async function launched(): Promise<SolidityDebugSession> {
  return launch(spec);
}

describe('viaIR straight-line setup artifact (out-of-order statement position)', () => {
  it('enters on the first statement (line 29), not the tuple-assign line', async () => {
    const s = await launched();
    expect(line(s)).toBe(29);
  });

  it('steps over to the second statement (line 30), not past it to line 31', async () => {
    const s = await launched();
    s.next();
    expect(line(s)).toBe(30);
  });

  it('steps over the whole function in source order (29 → 30 → 31)', async () => {
    const s = await launched();
    s.next();
    s.next();
    expect(line(s)).toBe(31);
  });

  it('steps into the first call, landing on the callee first line (line 20)', async () => {
    const s = await launched();
    s.stepIn();
    expect(line(s)).toBe(20);
  });
});
