/**
 * LEGACY stepping guard: the viaIR straight-line-setup artifact heuristics
 * (`#persists` / `#isBackwardSetupArtifact` in stepping.ts) must NOT misfire on
 * classic codegen.
 *
 * `StepStress.run()` (compiled LEGACY) has the exact shapes those heuristics key
 * on under viaIR — sequential declarations, a `for` loop with a back-edge, and a
 * multi-argument internal call built from earlier locals:
 *   22 uint256 x = 1;   23 y = 2;   24 z = 3;   25 sum = 0;
 *   26 for (…)          27   sum += i;
 *   29 uint256 r = combine(x, y, z);
 *   30 out = sum + r;   31 return out;   (combine: 17 first line, 18 return)
 *
 * On legacy codegen the statements map in source order, so step-over must walk
 * them in order (never jumping forward to 30/31 before the loop + call have run)
 * and step-into must land on combine's FIRST line (17). If a future change lets
 * the backward-fall-through heuristic fire on legacy, this goes red.
 */
import {describe, expect, it} from 'vitest';

import {launch, line, stepToLine, type Spec} from './support/harness.js';

const spec: Spec = {
  buildInfo: 'newfixtures-legacy-build-info.json',
  trace: 'stepstress-legacy-run-trace.raw.json',
  meta: 'stepstress-legacy-run-meta.json',
  sourcePath: 'src/StepStress.sol',
  contractName: 'StepStress',
  methodName: 'run',
};

describe('legacy stepping is not disturbed by the viaIR artifact heuristics', () => {
  it('step-over walks statements in source order (no forward skip)', async () => {
    const s = await launch(spec);
    const seen: number[] = [];
    const push = (): void => {
      const l = line(s);
      if (l !== undefined && seen[seen.length - 1] !== l) seen.push(l);
    };
    push();
    for (let k = 0; k < 40 && line(s) !== 31; k++) {
      s.next();
      push();
    }

    // Reached the final return, and visited the loop body + the call site.
    expect(seen, `saw lines: ${seen.join(',')}`).toContain(31);
    const idx = (l: number): number => seen.indexOf(l);
    expect(idx(27), 'loop body visited').toBeGreaterThan(-1);
    expect(idx(29), 'combine call visited').toBeGreaterThan(-1);

    // Ordering: loop body (27) → call (29) → out= (30) → return (31).
    expect(idx(27)).toBeLessThan(idx(29));
    expect(idx(29)).toBeLessThan(idx(30));
    expect(idx(30)).toBeLessThan(idx(31));

    // The reported viaIR bug shape was a forward jump to a LATER statement before
    // the earlier ones ran — assert we never landed on 30/31 before the call.
    expect(seen.slice(0, idx(29))).not.toContain(30);
    expect(seen.slice(0, idx(29))).not.toContain(31);
  });

  it('step-into combine lands on its first line (17), not a later line', async () => {
    const s = await launch(spec);
    stepToLine(s, 29, 30); // reach the `combine(x, y, z)` call
    s.stepIn();
    expect(line(s)).toBe(17);
  });
});
