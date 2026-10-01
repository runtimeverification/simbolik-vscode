/**
 * Parent EVM frames keep their internal call chain.
 *
 * `Forwarder.go(callee, 21)` (test/fixtures/counter/src/Forwarder.sol) makes its
 * external call from inside the internal function `_forward`:
 *
 *   14  uint256 r = _forward(callee, x);
 *   20  uint256 r = ICallee(callee).compute(x);   // → Callee.compute (Callee.sol:8)
 *
 * While the callee runs, the caller's EVM frame must still show `go → _forward`.
 * If only the innermost EVM frame were expanded into internal frames, the
 * caller would collapse to one frame during the call and re-expand on return,
 * so stepping out of the callee would look like entering two frames at once.
 */
import {describe, expect, it} from 'vitest';

import {eachMode, launch, type Spec} from './support/harness.js';

const spec = (mode: 'viair' | 'legacy'): Spec => ({
  buildInfo: `forwarder-${mode}-build-info.json`,
  trace: `forwarder-${mode}-run-trace.raw.json`,
  meta: `forwarder-${mode}-run-meta.json`,
  sourcePath: 'src/Forwarder.sol',
  contractName: 'Forwarder',
  methodName: 'go',
});

type Session = Awaited<ReturnType<typeof launch>>;

/** Bottom-first `name@path` of every frame. */
const stack = (s: Session): string[] =>
  s
    .stackTrace()
    .stackFrames.map(f => `${f.name}@${f.source?.path ?? ''}`)
    .reverse();

describe('parent EVM frames — Forwarder.go → _forward → Callee.compute', () => {
  eachMode({viair: spec('viair'), legacy: spec('legacy')}, (_mode, sp) => {
    it('shows the caller chain go → _forward beneath the callee', async () => {
      const s = await launch(sp);
      for (let i = 0; i < 50; i++) {
        if (s.stackTrace().stackFrames[0]?.name === 'compute') break;
        s.stepIn();
      }
      expect(s.stackTrace().stackFrames.map(f => f.name)).toEqual([
        'compute',
        '_forward',
        'go',
      ]);
    });

    it('every step-in pushes at most one frame', async () => {
      const s = await launch(sp);
      let prev = stack(s);
      let reachedCallee = false;
      for (let i = 0; i < 50; i++) {
        const at = s.currentStepIndex;
        s.stepIn();
        if (s.currentStepIndex === at) break;
        const cur = stack(s);
        if (cur.length === 0) break;
        reachedCallee ||= cur[cur.length - 1]!.startsWith('compute@');
        let common = 0;
        while (
          common < prev.length &&
          common < cur.length &&
          prev[common] === cur[common]
        ) {
          common++;
        }
        expect(
          cur.length - common,
          `${prev.join(' > ')} → ${cur.join(' > ')}`
        ).toBeLessThanOrEqual(1);
        prev = cur;
      }
      expect(reachedCallee).toBe(true);
    });
  });
});
