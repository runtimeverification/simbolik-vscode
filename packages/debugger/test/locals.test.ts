/**
 * Reading function LOCAL variables (value types) through the debugger,
 * across nested lexical scopes.
 *
 * Local variables live on the EVM stack. Their absolute slot is fixed at
 * declaration (frame base + declaration rank among the currently-live locals),
 * but the ethdebug stack pointer is depth-from-top, so the debugger recomputes
 * `depth = currentStackLength − 1 − slot` per step from the live stack height —
 * exactly the trace-based approach used for internal stack params.
 *
 * The key behaviours pinned here (verified against the REAL recorded trace of
 * `Locals.compute(10)`):
 *   - every value-type local decodes to its true value + type;
 *   - loop-body and nested-block locals appear ONLY while in scope and reuse the
 *     stack slots freed when an earlier block exits;
 *   - a value local declared AFTER reference-type locals still reads correctly
 *     (reference locals consume a stack slot but are not decoded);
 *   - the slot depth tracks the live stack height across instruction steps.
 *
 * Ground truth (compute(10)): a=11, small=7, signed=-5, flag=true, who=0x..aa,
 * hash=0x1122, color=Blue, tail=18, loop sum 0→36 (steps 11,12,13),
 * inner=72 → sum=108, total=126.
 */
import {describe, expect, it} from 'vitest';

import {
  breakAt as breakAtSpec,
  locals as varsAt,
  readDbgFixture,
  type Spec,
} from './support/harness.js';

/** The raw EVM stack length at a given trace step (top-of-stack last). */
const RAW_STACK_LENGTHS: number[] = (
  JSON.parse(readDbgFixture('locals-compute-trace.raw.json')) as {
    result: {structLogs: {stack: string[]}[]};
  }
).result.structLogs.map((l) => l.stack.length);

const spec: Spec = {
  buildInfo: 'locals-build-info.json',
  trace: 'locals-compute-trace.raw.json',
  meta: 'locals-compute-meta.json',
  sourcePath: 'src/Locals.sol',
  contractName: 'Locals',
  methodName: 'compute',
};

/** Launch and continue to the first stop on `line`. */
const breakAt = (line: number) => breakAtSpec(spec, line);

// ---------------------------------------------------------------------------
// 1. All value-type locals decode at the top-level function scope (line 37)
// ---------------------------------------------------------------------------

describe('Locals — every value type at function scope', () => {
  it('decodes all eight value-type locals (+ the param seed)', async () => {
    const session = await breakAt(37);
    expect(session.stackTrace().stackFrames[0]!.line).toBe(37);
    const v = await varsAt(session);

    expect(v.get('seed')).toMatchObject({value: '10', type: 'uint256'});
    expect(v.get('a')).toMatchObject({value: '11', type: 'uint256'});
    expect(v.get('small')).toMatchObject({value: '7', type: 'uint8'});
    expect(v.get('signed')).toMatchObject({value: '-5', type: 'int256'});
    expect(v.get('flag')).toMatchObject({value: 'true', type: 'bool'});
    expect(v.get('who')).toMatchObject({
      value: '0x00000000000000000000000000000000000000aa',
      type: 'address',
    });
    expect(v.get('hash')).toMatchObject({
      value:
        '0x0000000000000000000000000000000000000000000000000000000000001122',
      type: 'bytes32',
    });
    expect(v.get('color')!.value).toBe('Blue');
    expect(v.get('color')!.type).toContain('Color');
    expect(v.get('sum')).toMatchObject({value: '0', type: 'uint256'});
  });

  it('reads a value local declared AFTER reference-type locals (slot accounting)', async () => {
    // `tail` is declared after nums (uint256[]), label (string) and pt (struct);
    // reading tail = a + small = 18 proves the stack-slot rank counts the three
    // reference-type slots even though those locals are not themselves decoded.
    const session = await breakAt(37);
    const v = await varsAt(session);
    expect(v.get('tail')).toMatchObject({value: '18', type: 'uint256'});
  });

  it('surfaces the struct pt AND the array nums + string label', async () => {
    // The value-type memory struct `pt` is decoded as a nested variable; the
    // dynamic array `nums` (nested) and the string `label` (scalar) are decoded
    // too — detailed assertions live in structs.test.ts / arrays.test.ts.
    const session = await breakAt(37);
    const v = await varsAt(session);
    expect(v.has('pt')).toBe(true);
    expect(v.has('nums')).toBe(true);
    expect(v.has('label')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Nested scopes: loop-body + block locals appear only while in scope
// ---------------------------------------------------------------------------

describe('Locals — nested lexical scopes', () => {
  it('exposes the loop variable and loop-body local inside the loop', async () => {
    const session = await breakAt(43); // `sum = sum + step;`
    const v = await varsAt(session);
    // First loop iteration: i=0, step=i+a=11, sum not yet updated (0).
    expect(v.get('i')).toMatchObject({value: '0', type: 'uint256'});
    expect(v.get('step')).toMatchObject({value: '11', type: 'uint256'});
    expect(v.get('sum')).toMatchObject({value: '0', type: 'uint256'});
    // Outer locals stay visible.
    expect(v.get('a')).toMatchObject({value: '11'});
    expect(v.get('tail')).toMatchObject({value: '18'});
    // The nested-block local is NOT in scope yet.
    expect(v.has('inner')).toBe(false);
  });

  it('exposes a block-scoped local and reuses the loop slots', async () => {
    const session = await breakAt(48); // `sum = sum + inner;`
    const v = await varsAt(session);
    // After the loop: sum=36, inner=sum*2=72.
    expect(v.get('inner')).toMatchObject({value: '72', type: 'uint256'});
    expect(v.get('sum')).toMatchObject({value: '36', type: 'uint256'});
    // The loop locals have left scope (their slots are now reused by `inner`).
    expect(v.has('i')).toBe(false);
    expect(v.has('step')).toBe(false);
  });

  it('drops loop and block locals once both scopes have closed', async () => {
    const session = await breakAt(51); // `total = a + sum + ...;`
    const v = await varsAt(session);
    expect(v.get('sum')).toMatchObject({value: '108', type: 'uint256'});
    expect(v.get('a')).toMatchObject({value: '11'});
    expect(v.get('tail')).toMatchObject({value: '18'});
    for (const gone of ['i', 'step', 'inner']) {
      expect(v.has(gone)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Dynamic depth: the slot tracks the live stack height across steps
// ---------------------------------------------------------------------------

describe('Locals — depth recomputed per step', () => {
  it('keeps reading correct values as the stack grows mid-statement', async () => {
    const session = await breakAt(51);
    const stackAtBreak = RAW_STACK_LENGTHS[session.currentStepIndex]!;
    // Step into the arithmetic of line 51, which pushes temporaries above the
    // locals; a hardcoded depth would mis-read, the dynamic depth stays correct.
    let grew = false;
    for (let k = 0; k < 4; k++) {
      session.stepInstruction();
      // Non-tautology guard: prove temporaries actually pile up above the locals
      // (so a fixed depth WOULD mis-read); the dynamic depth must still hold.
      if (RAW_STACK_LENGTHS[session.currentStepIndex]! > stackAtBreak) grew = true;
      const v = await varsAt(session);
      expect(v.get('a')).toMatchObject({value: '11', type: 'uint256'});
      expect(v.get('sum')).toMatchObject({value: '108', type: 'uint256'});
      expect(v.get('small')).toMatchObject({value: '7', type: 'uint8'});
    }
    expect(grew).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. REGRESSION: reading locals while stepping THROUGH the for-loop
//    header (line 41) must stay correct even once the loop variable `i` has been
//    physically pushed but is not yet lexically live.
//
//    History: an earlier #frameBaseHeight re-derived the base per query as
//    `stackLength − liveCount` at the nearest statement-boundary step. At the
//    for-header, `i` is already PHYSICALLY on the stack (pushed by the for-init),
//    but the lexical liveness rule (`offset >= declEnd`) reports it as not-yet-
//    live, so liveCount under-counted by one and the base came out one slot too
//    high — every local then read one slot up (e.g. a=7, small's value; tail=0).
//    This test was a `it.fails` tripwire while that bug stood.
//
//    The fix ANCHORS the frame base once at body entry (see #frameBaseHeight), so
//    it no longer depends on the per-step live count. The test now runs as a
//    plain `it` and locks in the corrected behaviour.
// ---------------------------------------------------------------------------

describe('Locals — for-header frame base (regression)', () => {
  it(
    'keeps locals correct while stepping through the for-header (line 41)',
    async () => {
      const session = await breakAt(41);
      // Step through the header; while still on line 41, every outer local must
      // keep its true value regardless of whether `i` has been pushed yet.
      for (let k = 0; k < 12; k++) {
        if (session.stackTrace().stackFrames[0]!.line !== 41) break;
        const v = await varsAt(session);
        expect(v.get('a')).toMatchObject({value: '11', type: 'uint256'});
        expect(v.get('small')).toMatchObject({value: '7', type: 'uint8'});
        expect(v.get('tail')).toMatchObject({value: '18', type: 'uint256'});
        session.stepInstruction();
      }
    },
  );
});
