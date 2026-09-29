/**
 * Params/locals of constructor frames, which execute INIT code.
 *
 * `CtorFactory.run()` (test/fixtures/counter/src/Ctor.sol) does `new Ctor(5, 7)`:
 *
 *   17      uint256 doubled = b * 2;          // CtorBase(b), b = 7
 *   18      baseVal = doubled;
 *   27      uint256 sum = a + b;              // Ctor(a, b)
 *   28      uint256 scaled = _scale(sum);
 *   29      total = scaled;
 *   39      y = x * k;                        // _scale, init-code copy
 *
 * The Locals scope must resolve against the init code's own bytecode and source
 * map (a runtime pc of the same number is an unrelated instruction).
 */
import {describe, expect, it} from 'vitest';

import {
  buildInfoOf,
  launch,
  locals,
  metaOf,
  type Mode,
  type Spec,
} from './support/harness.js';

const spec = (mode: Mode): Spec => ({
  contractsByAddress: {
    [String(metaOf(`ctor-${mode}-run-meta.json`).derivedAddress)]: {
      buildInfoJson: buildInfoOf(`ctor-${mode}-build-info.json`),
      contractName: 'Ctor',
    },
  },
  buildInfo: `ctor-${mode}-build-info.json`,
  trace: `ctor-${mode}-run-trace.raw.json`,
  meta: `ctor-${mode}-run-meta.json`,
  sourcePath: 'src/Ctor.sol',
  contractName: 'CtorFactory',
  methodName: 'run',
});

type Session = Awaited<ReturnType<typeof launch>>;

const top = (s: Session): string => {
  const f = s.stackTrace().stackFrames[0]!;
  return `${f.name}:${f.line}`;
};

/** Step in until the top frame is `where`, or throw. */
function stepInTo(s: Session, where: string, max = 20): void {
  for (let k = 0; k < max && top(s) !== where; k++) s.stepIn();
  if (top(s) !== where) {
    throw new Error(`never reached ${where} (stopped at ${top(s)})`);
  }
}

async function values(s: Session): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, v] of await locals(s)) out[name] = v.value;
  return out;
}

/** Each stop in order, with the locals that must be shown there. */
const STOPS: [string, Record<string, string>][] = [
  ['CtorBase.constructor:17', {b: '7'}],
  ['CtorBase.constructor:18', {b: '7', doubled: '14'}],
  ['Ctor.constructor:28', {a: '5', b: '7', sum: '12'}],
  ['_scale:39', {x: '12', k: '3'}],
  ['Ctor.constructor:29', {a: '5', b: '7', sum: '12', scaled: '36'}],
];

async function walk(s: Session): Promise<void> {
  for (const [where, expected] of STOPS) {
    stepInTo(s, where);
    expect({where, locals: await values(s)}).toMatchObject({
      where,
      locals: expected,
    });
  }
}

describe('constructor locals — CtorFactory.run', () => {
  describe('viair', () => {
    it('shows constructor params and locals', async () => {
      await walk(await launch(spec('viair')));
    });
  });

  describe('legacy', () => {
    // KNOWN GAP: legacy codegen INLINES the base constructor into the derived
    // one (no call boundary), so the height analyzer's separate propagation from
    // CtorBase's entry conflicts with Ctor's fall-through flow and every pc
    // reachable from both loses its height ⇒ no constructor-body locals. Flip to
    // `it` once the analyzer treats inlined base-constructor bodies as part of
    // the enclosing frame.
    it.fails('shows constructor params and locals', async () => {
      await walk(await launch(spec('legacy')));
    });

    it('shows the init-code copy of an internal function', async () => {
      const s = await launch(spec('legacy'));
      stepInTo(s, '_scale:39');
      expect(await values(s)).toMatchObject({x: '12', k: '3'});
    });
  });
});
