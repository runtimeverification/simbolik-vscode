/**
 * A function whose body starts with a call gets its own stop before the callee.
 *
 * `CallFirst.run()` (test/fixtures/counter/src/CallFirst.sol):
 *
 *   12      n += 1;      // _bump
 *   16      _bump();     // run's first statement
 *   17      n += 2;
 *
 * Under viaIR, `run`'s code up to the `_bump` call maps to its header, so no
 * statement starts before `_bump`'s and a naive launch stop lands inside
 * `_bump` (two frames entered at once). It must be `run` at line 16, like
 * legacy.
 */
import {describe, expect, it} from 'vitest';

import {eachMode, launch, type Spec} from './support/harness.js';

const spec = (mode: 'viair' | 'legacy'): Spec => ({
  buildInfo: `callfirst-${mode}-build-info.json`,
  trace: `callfirst-${mode}-run-trace.raw.json`,
  meta: `callfirst-${mode}-run-meta.json`,
  sourcePath: 'src/CallFirst.sol',
  contractName: 'CallFirst',
  methodName: 'run',
});

type Session = Awaited<ReturnType<typeof launch>>;

const frames = (s: Session): string[] =>
  s.stackTrace().stackFrames.map(f => `${f.name}:${f.line}`);

describe('call-first function body — CallFirst.run', () => {
  eachMode({viair: spec('viair'), legacy: spec('legacy')}, (_mode, sp) => {
    it('launches on the first statement, then steps into the callee', async () => {
      const s = await launch(sp);
      expect(frames(s)).toEqual(['run:16']);
      s.stepIn();
      expect(frames(s)).toEqual(['_bump:12', 'run:16']);
      s.stepIn();
      expect(frames(s)).toEqual(['run:17']);
    });

    it('step-over from the first statement skips the callee', async () => {
      const s = await launch(sp);
      s.next();
      expect(frames(s)).toEqual(['run:17']);
    });

    it('a breakpoint on the first statement is hit', async () => {
      const s = await launch(sp);
      s.next();
      s.setBreakpoints({
        source: {path: sp.sourcePath},
        breakpoints: [{line: 16}],
      });
      s.reverseContinue();
      expect(frames(s)).toEqual(['run:16']);
    });
  });
});
