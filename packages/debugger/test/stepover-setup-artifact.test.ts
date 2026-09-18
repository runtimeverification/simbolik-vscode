/**
 * Regression: step-into / step-over must not stop on a viaIR straight-line SETUP
 * artifact — a later statement's source position emitted OUT OF SOURCE ORDER for
 * stack-setup instructions that physically precede an earlier statement's real
 * execution.
 *
 * Real trace of `TwoCalls.run()` (820 steps, compiled `--via-ir`), which mirrors
 * uniswap-v4-core `Deployers.deployMintAndApprove2Currencies`:
 *   line 29  uint256 a = mk(3);            (first call → local a)
 *   line 30  uint256 b = mk(5);            (second call → local b)
 *   line 31  (out0, out1) = order(a, b);   (tuple assign from a multi-arg call)
 *
 * Under viaIR the function's argument/return-slot setup is one contiguous
 * straight-line block; solc attributes the tuple statement's source position
 * (line 31) to bare-`PUSH` setup steps that run BEFORE line 29 and again between
 * lines 29 and 30, each a multi-step run that the one-step persistence guard does
 * not catch. Pre-fix, `entry()` landed on line 31 (the tuple) instead of line 29,
 * and step-over from line 29 skipped line 30 to land on line 31. The per-run
 * SETUP-artifact guard (a flat run that falls through — no taken jump — to an
 * EARLIER statement is not a real stop) restores source-order stepping.
 *
 * Ground truth (fixed model): entry = line 29; step-over 29 → 30 → 31; step-into
 * line 29 descends into `mk` at line 20 (`out0 += seed;`).
 */
import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {SolidityDebugSession, type LaunchInputs} from '../src/index.js';

const BUILD_INFO_JSON: unknown = JSON.parse(
  readFileSync(
    new URL(
      '../../solc/test/fixtures/twocalls-viair-build-info.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const TRACE_RAW = readFileSync(
  new URL('./fixtures/twocalls-viair-run-trace.raw.json', import.meta.url),
  'utf8',
);
const META = JSON.parse(
  readFileSync(
    new URL('./fixtures/twocalls-viair-run-meta.json', import.meta.url),
    'utf8',
  ),
) as {contractAddress: string};

function inputs(): LaunchInputs {
  return {
    buildInfoJson: BUILD_INFO_JSON,
    traceJson: TRACE_RAW,
    sourcePath: 'src/TwoCalls.sol',
    contractName: 'TwoCalls',
    methodName: 'run',
    codeAddress: META.contractAddress,
    dialect: 'kontrol',
  };
}

async function launched(): Promise<SolidityDebugSession> {
  const s = new SolidityDebugSession();
  await s.launch(inputs());
  return s;
}

const line = (s: SolidityDebugSession): number | undefined =>
  s.stackTrace().stackFrames[0]?.line;

describe('viaIR straight-line SETUP artifact (out-of-order statement position)', () => {
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
