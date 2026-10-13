/**
 * Step-into a `new` whose constructor body lies in a base constructor.
 *
 * `Factory.make()` (test/fixtures/counter/src/Factory.sol):
 *
 *   12      v = x;                                // Base's constructor
 *   17  constructor(uint256 x) Base(x + 1) {}     // Derived: invocation only
 *   24      d = new Derived(4);
 *
 * The new frame's first statement is Base's, nested in Derived's constructor,
 * so a naive step-into pushes both at once (each named `Derived.constructor`).
 * It must enter Derived.constructor (at the `Base(x + 1)` invocation), then
 * Base.constructor, one frame at a time.
 */
import {describe, expect, it} from 'vitest';

import {
  buildInfoOf,
  eachMode,
  launch,
  metaOf,
  type Spec,
} from './support/harness.js';

const spec = (mode: 'viair' | 'legacy'): Spec => ({
  // The CREATEd contract's address → its build-info, as the live resolver
  // supplies it (the init code is identified by address).
  contractsByAddress: {
    [String(metaOf(`factory-${mode}-run-meta.json`).derivedAddress)]: {
      buildInfoJson: buildInfoOf(`factory-${mode}-build-info.json`),
      contractName: 'Derived',
    },
  },
  buildInfo: `factory-${mode}-build-info.json`,
  trace: `factory-${mode}-run-trace.raw.json`,
  meta: `factory-${mode}-run-meta.json`,
  sourcePath: 'src/Factory.sol',
  contractName: 'Factory',
  methodName: 'make',
});

type Session = Awaited<ReturnType<typeof launch>>;

const frames = (s: Session): string[] =>
  s.stackTrace().stackFrames.map(f => `${f.name}:${f.line}`);

describe('base-constructor body — Factory.make', () => {
  eachMode({viair: spec('viair'), legacy: spec('legacy')}, (_mode, sp) => {
    it('enters the derived, then the base constructor', async () => {
      const s = await launch(sp);
      expect(frames(s)).toEqual(['make:24']);
      s.stepIn();
      expect(frames(s)).toEqual(['Derived.constructor:17', 'make:24']);
      s.stepIn();
      expect(frames(s)).toEqual([
        'Base.constructor:12',
        'Derived.constructor:17',
        'make:24',
      ]);
    });
  });
});
