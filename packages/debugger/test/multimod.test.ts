/**
 * Step-into a modified function enters one frame at a time.
 *
 * `MultiMod.run(7)` (test/fixtures/counter/src/MultiMod.sol) calls
 *
 *   27  function guarded(uint256 x) public whenUnlocked atLeast(x, 1) returns …
 *
 * internally (line 22) and through `this.guarded` (line 23). Step-into from the
 * call stops on the function's header at each modifier invocation before entering
 * that modifier — `guarded` (at `whenUnlocked`) → `whenUnlocked` → `guarded` (at
 * `atLeast`) → `atLeast` → the body — instead of pushing the function and its
 * first modifier together.
 */
import {describe, expect, it} from 'vitest';

import {eachMode, launch, stepToLine, type Spec} from './support/harness.js';

const spec = (mode: 'viair' | 'legacy'): Spec => ({
  buildInfo: `multimod-${mode}-build-info.json`,
  trace: `multimod-${mode}-run-trace.raw.json`,
  meta: `multimod-${mode}-run-meta.json`,
  sourcePath: 'src/MultiMod.sol',
  contractName: 'MultiMod',
  methodName: 'run',
});

type Session = Awaited<ReturnType<typeof launch>>;

/** Line 27 columns (1-based) of the two invocations. */
const WHEN_UNLOCKED = 40;
const AT_LEAST = 53;

/** Top-first `name:line[:column]` frames (column only for the header line). */
const frames = (s: Session): string[] =>
  s
    .stackTrace()
    .stackFrames.map(f =>
      f.line === 27 ? `${f.name}:27:${f.column}` : `${f.name}:${f.line}`
    );

/** The top frame's `name:line[:column]`. */
const top = (s: Session): string => frames(s)[0] ?? '';

describe('modifier invocations — MultiMod.guarded', () => {
  eachMode({viair: spec('viair'), legacy: spec('legacy')}, (_mode, sp) => {
    for (const callLine of [22, 23]) {
      it(`step-into from line ${callLine} stops at each modifier invocation`, async () => {
        const s = await launch(sp);
        stepToLine(s, callLine, 20);
        s.stepIn();
        expect(frames(s)).toEqual([
          `guarded:27:${WHEN_UNLOCKED}`,
          `run:${callLine}`,
        ]);
        s.stepIn();
        expect(top(s)).toBe('whenUnlocked:12');
        expect(frames(s)).toHaveLength(3);
        for (let i = 0; i < 5 && top(s).startsWith('whenUnlocked'); i++) {
          s.stepIn();
        }
        expect(frames(s)).toEqual([
          `guarded:27:${AT_LEAST}`,
          `run:${callLine}`,
        ]);
        s.stepIn();
        expect(top(s)).toBe('atLeast:17');
        for (let i = 0; i < 5 && top(s).startsWith('atLeast'); i++) {
          s.stepIn();
        }
        expect(frames(s)).toEqual(['guarded:28', `run:${callLine}`]);
      });
    }

    it('step-over from an invocation steps over that modifier', async () => {
      const s = await launch(sp);
      stepToLine(s, 22, 20);
      s.stepIn();
      expect(top(s)).toBe(`guarded:27:${WHEN_UNLOCKED}`);
      s.next();
      expect(top(s)).toBe(`guarded:27:${AT_LEAST}`);
      s.next();
      expect(top(s)).toBe('guarded:28');
    });

    it("step-back from a modifier's first statement returns to its invocation", async () => {
      const s = await launch(sp);
      stepToLine(s, 22, 20);
      s.stepIn();
      s.stepIn();
      expect(top(s)).toBe('whenUnlocked:12');
      s.stepBack();
      expect(top(s)).toBe(`guarded:27:${WHEN_UNLOCKED}`);
    });

    it('every step-in pushes at most one frame', async () => {
      const s = await launch(sp);
      let prev = frames(s).reverse();
      for (let i = 0; i < 60; i++) {
        s.stepIn();
        const cur = frames(s).reverse();
        if (cur.join() === prev.join()) break;
        let common = 0;
        while (
          common < prev.length &&
          common < cur.length &&
          prev[common]!.split(':')[0] === cur[common]!.split(':')[0]
        ) {
          common++;
        }
        expect(
          cur.length - common,
          `${prev.join(' > ')} → ${cur.join(' > ')}`
        ).toBeLessThanOrEqual(1);
        prev = cur;
      }
    });
  });
});
