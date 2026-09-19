/**
 * A dynamic memory ARRAY (`nums`) as a NESTED DAP variable and a memory
 * STRING (`label`) as a SCALAR DAP variable.
 *
 * `Locals.compute(10)` declares:
 *   `uint256[] memory nums = new uint256[](2); nums[0] = a;`  → [11, 0]
 *   `string  memory label = "hi";`                            → "hi" (bytes 0x6869)
 *
 * Both are memory reference locals whose stack slot holds a memory OFFSET; the
 * array's length + the string's byte length are read from memory at that offset.
 * `variablesAt` emits the LAYOUT statically: `nums` gets an `array`
 * structure (a dereferenceable `List` whose element regions are named `'element'`)
 * and `label` gets a `bytes` structure (a dynamic-length byte region). The values
 * are read at dereference time through the REAL `@ethdebug/pointers` path.
 *
 * ── Trace ground-truth (locals-compute-trace.raw.json, pc 436 = line 37) ───────
 * Established by reading the recorded trace memory directly:
 *   nums:  stack slot holds memory offset 0x80 (=128); mem[128]=len 2;
 *          mem[160]=nums[0]=11; mem[192]=nums[1]=0.
 *   label: stack slot holds memory offset 0xe0 (=224); mem[224]=len 2;
 *          mem[256]=raw bytes 0x6869 ("hi").
 *
 * What is pinned here:
 *   1. nums' array pointer dereferences (via the real ethdebug path) to the
 *      concrete elements [11n, 0n]; label's byte pointer decodes to "hi".
 *   2. The session renders nums as a nested variable (non-zero
 *      `variablesReference`; children `0`=11, `1`=0, type uint256) and label as a
 *      scalar (`value === '"hi"'`, `variablesReference: 0`, type string).
 *   3. Regression: pt (struct) still nests {x:11, y:7}; the value locals still
 *      decode.
 */
import {describe, expect, it} from 'vitest';

import type {Pointer} from '@ethdebug/pointers';
import {dereference} from '@ethdebug/pointers';
import {variablesAt, type ResolvedVariable} from '@simbolik/ethdebug-gen';

import {
  breakAt,
  children,
  loadCu,
  locals,
  machineStateAtPc,
  type DapVariable,
  type Spec,
} from './support/harness.js';

// ── Loose accessors for the producer fields ───────────────────────────────────

/** The `array` field added under `ResolvedVariable`. */
interface ArrayShape {
  pointer?: Pointer;
  elementSolcType: string;
  elementTypeLabel: string;
  elementNumberOfBytes: number;
}
function arrayOf(v: ResolvedVariable): ArrayShape | undefined {
  return (v as unknown as {array?: ArrayShape}).array;
}
/** The `bytes` field added under `ResolvedVariable`. */
interface BytesShape {
  pointer?: Pointer;
  isString: boolean;
}
function bytesOf(v: ResolvedVariable): BytesShape | undefined {
  return (v as unknown as {bytes?: BytesShape}).bytes;
}

const CU = 'locals-build-info.json';
const TRACE = 'locals-compute-trace.raw.json';
const META = 'locals-compute-meta.json';

const spec: Spec = {
  buildInfo: CU,
  trace: TRACE,
  meta: META,
  sourcePath: 'src/Locals.sol',
  contractName: 'Locals',
  methodName: 'compute',
};

// ---------------------------------------------------------------------------
// 1. The array pointer dereferences to its concrete elements [11, 0]
// ---------------------------------------------------------------------------

describe('nums array pointer dereferences through @ethdebug/pointers', () => {
  it('nums resolves to elements [11n, 0n] at pc 436 (real deref path)', async () => {
    const cu = loadCu(CU);
    const nums = variablesAt(cu, 'src/Locals.sol', 'Locals', 436).find(
      (v) => v.name === 'nums',
    )!;
    const arr = arrayOf(nums);
    expect(arr, 'nums must carry an array structure to dereference').toBeDefined();
    expect(arr!.pointer, 'the array needs a concrete pointer').toBeDefined();

    const ms = machineStateAtPc(TRACE, META, 436);
    const cursor = await dereference(arr!.pointer as Pointer, {state: ms});
    const view = await cursor.view(ms);

    // The element regions are named `'element'` (index order); read each as uint.
    const elementRegions = view.regions.named('element');
    expect(elementRegions.length, 'the dynamic length is read from memory').toBe(2);
    const values: bigint[] = [];
    for (const region of elementRegions) {
      values.push((await view.read(region)).asUint());
    }
    expect(values).toEqual([11n, 0n]);
  });
});

// ---------------------------------------------------------------------------
// 2. The string pointer decodes to "hi"
// ---------------------------------------------------------------------------

describe('label string pointer decodes through @ethdebug/pointers', () => {
  it('label resolves to the UTF-8 string "hi" at pc 436 (real deref path)', async () => {
    const cu = loadCu(CU);
    const label = variablesAt(cu, 'src/Locals.sol', 'Locals', 436).find(
      (v) => v.name === 'label',
    )!;
    const b = bytesOf(label);
    expect(b, 'label must carry a bytes structure to dereference').toBeDefined();
    expect(b!.pointer, 'the string needs a concrete byte pointer').toBeDefined();
    expect(b!.isString).toBe(true);

    const ms = machineStateAtPc(TRACE, META, 436);
    const cursor = await dereference(b!.pointer as Pointer, {state: ms});
    const view = await cursor.view(ms);

    // The FINAL region is the raw bytes (dynamic length read from memory).
    const raw = view.regions[view.regions.length - 1]!;
    const hex = (await view.read(raw)).toHex();
    expect(hex).toBe('0x6869');
    expect(Buffer.from(hex.slice(2), 'hex').toString('utf8')).toBe('hi');
  });
});

// ---------------------------------------------------------------------------
// 3. The session renders nums nested + label scalar
// ---------------------------------------------------------------------------

describe('session renders nums as a nested DAP variable', () => {
  it('nums has a non-zero variablesReference; children 0=11, 1=0 (uint256)', async () => {
    const session = await breakAt(spec, 37); // line 37, nums assigned & live
    expect(session.stackTrace().stackFrames[0]!.line).toBe(37);

    const nums = (await locals(session)).get('nums');
    expect(nums, 'nums should be surfaced as a Locals variable').toBeDefined();
    // A nested variable exposes its children via a non-zero reference.
    expect(nums!.variablesReference).not.toBe(0);
    // The parent's summary reads as an array (e.g. `uint256[2]` or `[11, 0]`).
    expect(
      nums!.value.includes('['),
      `nums value summary should look array-like: got "${nums!.value}"`,
    ).toBe(true);

    // Expanding the handle yields the decoded elements, index-named.
    const kids = (await children(session, nums!.variablesReference)).map((v) => ({
      name: v.name,
      value: v.value,
    }));
    expect(kids).toEqual([
      {name: '0', value: '11'},
      {name: '1', value: '0'},
    ]);
    // Elements carry their solc element type for display.
    for (const child of await children(session, nums!.variablesReference)) {
      expect(child.type).toBe('uint256');
      expect(child.variablesReference).toBe(0);
    }
  });
});

describe('session renders label as a scalar DAP variable', () => {
  it('label value is the decoded string "hi" with no children', async () => {
    const session = await breakAt(spec, 37);
    const label = (await locals(session)).get('label');
    expect(label, 'label should be surfaced as a Locals variable').toBeDefined();
    // A scalar: no expandable handle.
    expect(label!.variablesReference).toBe(0);
    // Rendered as a quoted string literal.
    expect(label!.value).toBe('"hi"');
    expect(label!.type).toContain('string');
  });
});

// ---------------------------------------------------------------------------
// 4. Regression: struct pt still nests; value locals still decode
// ---------------------------------------------------------------------------

describe('regression: struct pt + value locals unaffected', () => {
  it('pt still nests {x:11, y:7} and the value locals still decode', async () => {
    const session = await breakAt(spec, 37);
    const m = await locals(session);

    // Value locals unaffected.
    expect(m.get('a')).toMatchObject({value: '11', type: 'uint256'});
    expect(m.get('small')).toMatchObject({value: '7', type: 'uint8'});
    expect(m.get('sum')).toMatchObject({value: '0', type: 'uint256'});
    expect(m.get('tail')).toMatchObject({value: '18', type: 'uint256'});

    // pt is still a nested struct with children x=11, y=7.
    const pt = m.get('pt');
    expect(pt).toBeDefined();
    expect(pt!.variablesReference).not.toBe(0);
    const ptKids = await children(session, pt!.variablesReference);
    expect(ptKids.map((v: DapVariable) => ({name: v.name, value: v.value}))).toEqual([
      {name: 'x', value: '11'},
      {name: 'y', value: '7'},
    ]);
  });
});
