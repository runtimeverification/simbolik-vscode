/**
 * A modifier that calls a function stays on the stack beneath the callee.
 *
 * `ModCall.run(5)` (test/fixtures/counter/src/ModCall.sol):
 *
 *   11      return x > 0;                 // _check
 *   15      require(_check(x), "zero");   // modifier `checked`
 *   19  function run(uint256 x) external checked(x) guard returns (uint256) {
 *   20      stored = x;
 *   27      _guard();                     // modifier `guard`: a bare first call
 *   32      require(stored < …);          // _guard
 *
 * While `_check` runs the stack is [_check, checked, run]. Materializing only a
 * modifier active at the current step would drop the modifier frame there
 * ([_check, run]), so step-into would swap the modifier for its callee.
 *
 * Under viaIR, `guard`'s code up to its `_guard()` call maps to the modifier
 * header, so its first statement stop is already inside `_guard`: step-into
 * from the invocation must stop in `guard` itself before entering `_guard`.
 */
import {describe, expect, it} from 'vitest';

import {eachMode, launch, type Spec} from './support/harness.js';

const spec = (mode: 'viair' | 'legacy'): Spec => ({
  buildInfo: `modcall-${mode}-build-info.json`,
  trace: `modcall-${mode}-run-trace.raw.json`,
  meta: `modcall-${mode}-run-meta.json`,
  sourcePath: 'src/ModCall.sol',
  contractName: 'ModCall',
  methodName: 'run',
});

type Session = Awaited<ReturnType<typeof launch>>;

const frames = (s: Session): string[] =>
  s.stackTrace().stackFrames.map(f => `${f.name}:${f.line}`);

describe('modifier calling a function — ModCall.run', () => {
  eachMode({viair: spec('viair'), legacy: spec('legacy')}, (_mode, sp) => {
    it('keeps the calling modifier beneath the callee', async () => {
      const s = await launch(sp);
      for (let i = 0; i < 10 && !frames(s)[0]!.startsWith('_check'); i++) {
        s.stepIn();
      }
      expect(frames(s)).toEqual(['_check:11', 'checked:15', 'run:19']);
    });

    it('step-in enters at most one frame at a time', async () => {
      const s = await launch(sp);
      const seen: string[][] = [frames(s)];
      for (let i = 0; i < 20; i++) {
        s.stepIn();
        const cur = frames(s);
        if (cur.join() === seen[seen.length - 1]!.join()) break;
        seen.push(cur);
        if (cur[0] === 'run:20') break; // the body — past every modifier
      }
      const names = seen.map(f => f.map(x => x.split(':')[0]).reverse());
      for (let i = 1; i < names.length; i++) {
        const [a, b] = [names[i - 1]!, names[i]!];
        let common = 0;
        while (
          common < a.length &&
          common < b.length &&
          a[common] === b[common]
        ) {
          common++;
        }
        expect(
          b.length - common,
          `${a.join(' > ')} → ${b.join(' > ')}`
        ).toBeLessThanOrEqual(1);
      }
      expect(seen.some(f => f[0] === 'run:20')).toBe(true);
      expect(seen.some(f => f[0] === '_guard:32')).toBe(true);
      expect(seen.some(f => f.join() === 'guard:27,run:19')).toBe(true);
    });
  });
});
