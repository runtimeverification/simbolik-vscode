/**
 * Regressions distilled from the viaIR-vs-legacy differential campaign over
 * uniswap-v4-core (every test stepped on both pipelines; the two sessions run the
 * same inputs, so they must agree with the ground truth). `CampaignRegress.run(3, 5)`
 * (test/fixtures/counter/src/CampaignRegress.sol) packs one construct per bug class:
 *
 *   40  (uint256 lo, uint256 hi) = pair(n);   // tuple locals   → lo = 3, hi = 4
 *   41  bool z = isZero(lo);                  // one-statement helper (line 19)
 *   42  int256 acc = 0;
 *   44      acc -= step;                      // reassigned in a loop → -15
 *   46  int256 picked = z ? int256(hi) : acc; // ternary assign    → -15
 *   48  uint256 d = f(hi);                    // function-pointer call → 8
 *   49  guarded(d);                           // modifier (13) + body (35)
 *
 * Bugs pinned: viaIR tuple-destructured locals never located; viaIR step-into
 * skipping a function's first statement; viaIR step-over from a modifier
 * skipping the modified function's body; a stale copy of a reassigned variable's
 * old value (the initializer 0) shown as its value; an indirect internal call
 * skewing legacy frame heights. The invariant checked everywhere: a value the
 * debugger SHOWS is the variable's true value (absent is acceptable, wrong is not).
 */
import {describe, expect, it} from 'vitest';

import {
  eachMode,
  launch,
  line,
  locals,
  stepToLine,
  type Spec,
} from './support/harness.js';

const spec = (mode: 'viair' | 'legacy'): Spec => ({
  buildInfo: `campaignregress-${mode}-build-info.json`,
  trace: `campaignregress-${mode}-run-trace.raw.json`,
  meta: `campaignregress-${mode}-run-meta.json`,
  sourcePath: 'src/CampaignRegress.sol',
  contractName: 'CampaignRegress',
  methodName: 'run',
});

const bare = (v: string): string => v.replace(/ \(last known\)$/, '');
const topName = (s: Awaited<ReturnType<typeof launch>>): string =>
  s.stackTrace().stackFrames[0]?.name ?? '';

describe('campaign regressions — CampaignRegress.run(3, 5)', () => {
  eachMode({viair: spec('viair'), legacy: spec('legacy')}, (_mode, sp) => {
    it('locates tuple-destructured locals (lo = 3, hi = 4)', async () => {
      const s = await launch(sp);
      stepToLine(s, 41, 20);
      const vars = await locals(s);
      expect(bare(vars.get('lo')?.value ?? '')).toBe('3');
      expect(bare(vars.get('hi')?.value ?? '')).toBe('4');
    });

    it("step-into a one-statement helper stops on its statement (isZero:19)", async () => {
      const s = await launch(sp);
      stepToLine(s, 41, 20);
      s.stepIn();
      expect(topName(s)).toContain('isZero');
      expect(line(s)).toBe(19);
    });

    it('never shows a wrong value for acc / picked / d while stepping over run()', async () => {
      const s = await launch(sp);
      const seen: string[] = [];
      for (let k = 0; k < 60 && topName(s).includes('run'); k++) {
        const ln = line(s)!;
        const vars = await locals(s);
        const acc = vars.get('acc');
        const picked = vars.get('picked');
        const d = vars.get('d');
        // After the loop acc is -15 (the initializer 0 must never resurface).
        if (acc !== undefined && ln >= 46) expect(bare(acc.value)).toBe('-15');
        if (picked !== undefined && ln >= 47) expect(bare(picked.value)).toBe('-15');
        if (d !== undefined && ln >= 49) expect(bare(d.value)).toBe('8');
        seen.push(`${ln}`);
        s.next();
      }
      // The walk reached the body's end (the checks above actually ran there).
      expect(seen).toContain('49');
    });

    it('step-over from the modifier enters the modified body (guarded: stored = x)', async () => {
      const s = await launch(sp);
      stepToLine(s, 49, 30);
      for (let k = 0; k < 6 && !/guarded|whenUnlocked/.test(topName(s)); k++) s.stepIn();
      expect(topName(s)).toMatch(/guarded|whenUnlocked/);
      const lines: number[] = [];
      for (let k = 0; k < 8 && /guarded|whenUnlocked/.test(topName(s)); k++) {
        lines.push(line(s)!);
        s.next();
      }
      expect(lines).toContain(35);
    });
  });
});
