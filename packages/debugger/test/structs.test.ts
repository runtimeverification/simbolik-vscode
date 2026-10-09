/**
 * A value-type memory struct local decoded as a nested DAP variable.
 *
 * `Locals.compute(10)` declares `struct Point { uint256 x; uint256 y; }` and the
 * local `Point memory pt = Point(a, small)` = `Point(11, 7)`: a fixed group of
 * value-type members. The struct's location is runtime data — its memory offset
 * lives in pt's stack slot — so `variablesAt` emits pt's member layout
 * statically (per-member ethdebug pointers built from `$read` of the stack slot
 * + each member's word offset), and the value is read at dereference time
 * through `@ethdebug/pointers`.
 *
 * ## Trace ground truth (locals-compute-trace.raw.json)
 * At pc 436 (line 37, the first `require` — a clean body statement after pt is
 * assigned) pt's stack slot holds memory offset 0x120 (=288). In memory:
 *   memory[288..320] = 11  → pt.x
 *   memory[320..352] =  7  → pt.y
 *
 * Pinned here (the producer shape itself is pinned in `@simbolik/ethdebug-gen`'s
 * `variables.test.ts`):
 *   1. pt's member pointers dereference to 11 and 7 through the real ethdebug
 *      path (`machineStateFor` + `readPointerValue`).
 *   2. The session renders pt as a nested variable: a non-zero `variablesReference`
 *      + a `Point` summary, whose children are `x=11`, `y=7`.
 *   3. The value locals decode and `nums`/`label` are surfaced alongside.
 */
import {describe, expect, it} from 'vitest';

import type {Pointer} from '@ethdebug/pointers';
import {variablesAt, type ResolvedVariable} from '@simbolik/ethdebug-gen';

import {readPointerValue} from '../src/machineState.js';
import {
  breakAt as breakAtSpec,
  children,
  loadCu,
  locals as localsMap,
  machineStateAtPc,
  type Spec,
} from './support/harness.js';

// ## Fixtures

const CU = 'locals-build-info.json';
const TRACE = 'locals-compute-trace.raw.json';
const META = 'locals-compute-meta.json';

/** The per-member descriptor under `ResolvedVariable.members`. */
interface StructMemberShape {
  name: string;
  typeLabel: string;
  solcType: string;
  numberOfBytes: number;
  pointer?: unknown;
}
/** Loose accessor for the `members` field. */
function membersOf(v: ResolvedVariable): StructMemberShape[] | undefined {
  return (v as unknown as {members?: StructMemberShape[]}).members;
}

const spec: Spec = {
  buildInfo: CU,
  trace: TRACE,
  meta: META,
  sourcePath: 'src/Locals.sol',
  contractName: 'Locals',
  methodName: 'compute',
};
const breakAt = (line: number) => breakAtSpec(spec, line);

// ## 1. Member pointers dereference to their recorded values (11, 7)

describe('struct member pointers dereference through @ethdebug/pointers', () => {
  it('pt.x reads 11 and pt.y reads 7 at pc 436 via machineStateFor + readPointerValue', async () => {
    const cu = loadCu(CU);

    const pt = variablesAt(cu, 'src/Locals.sol', 'Locals', 436).find(
      (v) => v.name === 'pt',
    )!;
    const members = membersOf(pt);
    expect(members, 'pt must carry member pointers to dereference').toBeDefined();
    const [x, y] = members!;
    expect(x!.name).toBe('x');
    expect(y!.name).toBe('y');
    expect(x!.pointer, 'member x needs a pointer').toBeDefined();
    expect(y!.pointer, 'member y needs a pointer').toBeDefined();

    // MachineState at the first own-contract step whose pc is 436.
    const ms = machineStateAtPc(TRACE, META, 436);

    // The pointers resolve their memory offset from pt's stack slot at dereference.
    expect(await readPointerValue(x!.pointer as Pointer, ms)).toBe(11n);
    expect(await readPointerValue(y!.pointer as Pointer, ms)).toBe(7n);
  });
});

// ## 2. The session renders pt as a nested variable

describe('session renders pt as a nested DAP variable', () => {
  it('pt has a non-zero variablesReference + a Point summary; children are x=11, y=7', async () => {
    const session = await breakAt(37); // line 37 = first `require`, pt assigned & live
    expect(session.stackTrace().stackFrames[0]!.line).toBe(37);

    const pt = (await localsMap(session)).get('pt');
    expect(pt, 'pt should be surfaced as a Locals variable').toBeDefined();
    // A nested variable exposes its children via a non-zero reference.
    expect(pt!.variablesReference).not.toBe(0);
    // The parent's displayed value is a struct summary, not a scalar.
    expect(
      /Point|\{/.test(pt!.value),
      `pt value summary should mention Point or {: got "${pt!.value}"`,
    ).toBe(true);

    // Expanding the handle yields the decoded members.
    const childVars = await children(session, pt!.variablesReference);
    const kids = childVars.map((v) => ({
      name: v.name,
      value: v.value,
    }));
    expect(kids).toEqual([
      {name: 'x', value: '11'},
      {name: 'y', value: '7'},
    ]);
    // Members carry their solc type for display.
    const x = childVars.find((v) => v.name === 'x');
    expect(x!.type).toBe('uint256');
  });
});

// ## 3. Value locals decode alongside the surfaced reference locals

describe('value locals decode & nums/label/pt are surfaced', () => {
  it('at line 37 the value locals are correct and nums/label/pt are surfaced', async () => {
    const session = await breakAt(37);
    const m = await localsMap(session);

    expect(m.get('a')).toMatchObject({value: '11', type: 'uint256'});
    expect(m.get('small')).toMatchObject({value: '7', type: 'uint8'});
    expect(m.get('sum')).toMatchObject({value: '0', type: 'uint256'});
    // `tail` sits after the reference locals and still ranks/reads correctly.
    expect(m.get('tail')).toMatchObject({value: '18', type: 'uint256'});

    // The dynamic array + string are decoded (nums nested, label scalar) —
    // asserted in detail in arrays.test.ts. Here we only confirm they are
    // surfaced.
    expect(m.has('nums')).toBe(true);
    expect(m.has('label')).toBe(true);

    // The struct is surfaced as a nested variable.
    expect(m.get('pt')).toBeDefined();
    expect(m.get('pt')!.variablesReference).not.toBe(0);
  });
});
