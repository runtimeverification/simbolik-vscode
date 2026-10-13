/**
 * A call to a function that never returns keeps its caller on the stack.
 *
 * `NoReturn.run(5)` (test/fixtures/counter/src/NoReturn.sol) reverts inside
 * `_fail`, which `check` calls on line 16. `_fail` always reverts, so viaIR
 * calls it with a plain JUMP (no source-map `jump:'i'`). The landing must still
 * count as a call: treated as a jump within `check`, `_fail` would replace
 * `check` on the stack.
 */
import {describe, expect, it} from 'vitest';

import {eachMode, launch, type Spec} from './support/harness.js';

const spec = (mode: 'viair' | 'legacy'): Spec => ({
  buildInfo: `noreturn-${mode}-build-info.json`,
  trace: `noreturn-${mode}-run-trace.raw.json`,
  meta: `noreturn-${mode}-run-meta.json`,
  sourcePath: 'src/NoReturn.sol',
  contractName: 'NoReturn',
  methodName: 'run',
});

describe('non-returning callee — NoReturn.run(5)', () => {
  eachMode({viair: spec('viair'), legacy: spec('legacy')}, (_mode, sp) => {
    it('shows [_fail, check, run] inside the reverting callee', async () => {
      const s = await launch(sp);
      const names = (): string[] =>
        s.stackTrace().stackFrames.map(f => `${f.name}:${f.line}`);
      for (let i = 0; i < 10 && !names()[0]!.startsWith('_fail'); i++) {
        s.stepIn();
      }
      expect(names().map(n => n.split(':')[0])).toEqual([
        '_fail',
        'check',
        'run',
      ]);
      expect(names().slice(1)).toEqual(['check:16', 'run:21']);
    });
  });
});
