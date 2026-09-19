/**
 * Regression: step-over must not DRIFT to the terminal step across a sub-call
 * that unbalances the source-map jump fold.
 *
 * Real trace of `RevertStep.run(reverter)` (313 steps): three statements —
 *   line 25  a = 1;                              (origin)
 *   line 26  try Reverter(r).boom() {} catch {}  (reverting EXTERNAL call)
 *   line 27  b = 2;                              (must be reachable)
 *
 * The reverting external call is entered via a source-map `jump:'i'` but exits
 * via REVERT, skipping the balancing `jump:'o'`. With a single GLOBAL jump-fold
 * accumulator that leak inflated every later statement's combinedDepth, so
 * step-over from line 26 (which stops at the first statement whose combinedDepth
 * is <= the origin's) skipped line 27 and ran to the terminal step. The
 * per-EVM-frame fold discards the reverted callee's imbalance on return, so
 * combinedDepth returns to the caller's level and stepping stays correct.
 *
 * Ground truth (fixed model): statement-start steps are 133 (line 25) → 139
 * (line 26) → 303 (line 27); terminal step = 312. Pre-fix, the second step-over
 * landed on 312 (line 24, the function's closing) instead of 303.
 */
import {describe, expect, it} from 'vitest';

import type {SolidityDebugSession} from '../src/index.js';
import {launch, line, metaOf, type Spec} from './support/harness.js';

const spec: Spec = {
  buildInfo: 'revertstep-build-info.json',
  trace: 'revertstep-run-trace.raw.json',
  meta: 'revertstep-run-meta.json',
  sourcePath: 'src/RevertStep.sol',
  contractName: 'RevertStep',
  methodName: 'run',
};

const META = metaOf('revertstep-run-meta.json') as {
  contractAddress: string;
  traceStepCount: number;
};

async function launched(): Promise<SolidityDebugSession> {
  return launch(spec);
}

describe('step-over across a reverting external call (combinedDepth drift)', () => {
  it('enters at statement 1 (line 25, a = 1)', async () => {
    const s = await launched();
    expect(line(s)).toBe(25);
  });

  it('steps over to statement 2 (line 26, the reverting call)', async () => {
    const s = await launched();
    s.next();
    expect(line(s)).toBe(26);
  });

  it('steps over the reverting call to statement 3 (line 27), not the end', async () => {
    const s = await launched();
    s.next(); // 25 -> 26
    s.next(); // 26 -> 27  (pre-fix: drifted to the terminal step)
    expect(line(s)).toBe(27);
    expect(s.currentStepIndex).toBeLessThan(META.traceStepCount - 1);
  });

  it('does not land on the terminal step after stepping over line 26', async () => {
    const s = await launched();
    s.next();
    s.next();
    expect(s.currentStepIndex).not.toBe(META.traceStepCount - 1);
  });
});
