/**
 * DUAL-PIPELINE coverage for MEMORY reference-type locals.
 *
 * `MemRefs.run()` builds three memory reference locals and passes them to a
 * recursive (non-inlined) `consume`, so each is a genuine last-use stack read:
 *   line 29  uint256[] memory nums = new uint256[](2);  → [11, 22]
 *   line 32  string  memory label = "hi";               → "hi"
 *   line 33  uint256[3] memory fixed3 = [101, 202, 303]; → [101, 202, 303]
 *   line 34  return consume(nums, label, fixed3, 1);     // all read (last use)
 *
 * The SAME source is recorded both `--via-ir` and legacy. Under viaIR the stack
 * slot holding each reference's memory offset is scheduled per-instruction (the
 * per-pc stack-provenance path must locate it); under legacy the frame-relative
 * slot model locates it. Both must render identical values — this is the
 * regression that the reference-type rendering is NOT overfit to viaIR.
 */
import {describe, expect, it} from 'vitest';

import {
  children,
  eachMode,
  launch,
  locals,
  stepToLine,
  type Spec,
} from './support/harness.js';

const base = (mode: 'viair' | 'legacy'): Spec => ({
  buildInfo:
    mode === 'viair'
      ? 'memrefs-viair-build-info.json'
      : 'newfixtures-legacy-build-info.json',
  trace: `memrefs-${mode}-run-trace.raw.json`,
  meta: `memrefs-${mode}-run-meta.json`,
  sourcePath: 'src/MemRefs.sol',
  contractName: 'MemRefs',
  methodName: 'run',
});

describe('memory reference locals render on both pipelines (line 34)', () => {
  eachMode({viair: base('viair'), legacy: base('legacy')}, (_mode, spec) => {
    it('nums=[11,22], label="hi", fixed3=[101,202,303]', async () => {
      const s = await launch(spec);
      stepToLine(s, 34, 25);
      const m = await locals(s);

      // Dynamic value array.
      const nums = m.get('nums');
      expect(nums, 'nums surfaced').toBeDefined();
      expect(nums!.type).toBe('uint256[]');
      expect(nums!.variablesReference).toBeGreaterThan(0);
      expect((await children(s, nums!.variablesReference)).map((k) => k.value)).toEqual(
        ['11', '22'],
      );

      // Memory string (scalar).
      const label = m.get('label');
      expect(label, 'label surfaced').toBeDefined();
      expect(label!.value).toBe('"hi"');
      expect(label!.variablesReference).toBe(0);

      // Fixed-size memory array.
      const fixed3 = m.get('fixed3');
      expect(fixed3, 'fixed3 surfaced').toBeDefined();
      expect(fixed3!.type).toBe('uint256[3]');
      expect(fixed3!.variablesReference).toBeGreaterThan(0);
      expect(
        (await children(s, fixed3!.variablesReference)).map((k) => k.value),
      ).toEqual(['101', '202', '303']);
    });
  });
});
