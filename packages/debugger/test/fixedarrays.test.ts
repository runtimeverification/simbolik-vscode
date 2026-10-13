/**
 * Fixed-size array (`T[N]`, value-type elements) decoding in both storage and
 * memory. Without a fixed-array `ArrayLayout` from the producer
 * (packages/ethdebug-gen — memory in variables.ts, storage in index.ts) such
 * arrays render as opaque scalars (storage) or are dropped entirely (memory
 * locals).
 *
 * Fixture: FixedArrays.fill() (kontrol dialect, 324 steps).
 *   contract FixedArrays {
 *     uint256[3] public fixedArr; // slots 0,1,2 (inplace, no keccak)
 *     uint256    public sum;      // slot 3
 *     function fill() external {
 *       fixedArr = [111, 222, 333];
 *       uint256[3] memory local = [11, 22, 33]; // inline, no length prefix
 *       sum = local[0] + local[1] + local[2];   // = 66
 *     }
 *   }
 *
 * ## Ground truth (from the raw trace + machine state)
 *   Storage @ terminal step (continue()): slot0=111, slot1=222, slot2=333,
 *     slot3(sum)=66.
 *   Memory @ line 27 (`sum = local[0] + ...`, trace step 165): the memory words
 *     at byte offsets 0x80/0xa0/0xc0 read 11/22/33. The stack slot for `local`
 *     points directly at element 0 — no length word — so element i is at
 *     base + i*32. A wrong "+32 length-prefix" formula would read
 *     [22, 33, <next word>]; the exact-[11,22,33] assertion catches that.
 *
 * Line 27 is chosen for the memory case because it is the first statement after
 * all three `local[i] =` writes and `local` is still lexically live there (it is
 * read by the statement), so the array is fully populated and its pointer is
 * resolvable.
 */
import {describe, expect, it} from 'vitest';

import {type SolidityDebugSession} from '../src/index.js';
import {
  breakAt as breakAtSpec,
  children as childrenOfRef,
  launch,
  locals as rowsLocals,
  stateVars,
  type DapVariable,
  type Spec,
} from './support/harness.js';

// ## Fixtures + LaunchInputs

const spec: Spec = {
  buildInfo: 'fixedarrays-build-info.json',
  trace: 'fixedarrays-fill-trace.raw.json',
  meta: 'fixedarrays-fill-meta.json',
  sourcePath: 'src/FixedArrays.sol',
  contractName: 'FixedArrays',
  methodName: 'fill',
  dialect: 'kontrol',
};

/** The variables in a named scope (`State` or `Locals`) keyed by name. */
async function rows(
  session: SolidityDebugSession,
  scopeName: string,
): Promise<Map<string, DapVariable>> {
  return scopeName === 'State' ? stateVars(session) : rowsLocals(session);
}

async function children(
  session: SolidityDebugSession,
  parent: DapVariable,
): Promise<DapVariable[]> {
  return childrenOfRef(session, parent.variablesReference);
}

/** Terminal step: all storage committed. */
async function terminalSession(): Promise<SolidityDebugSession> {
  const session = await launch(spec);
  await session.continue(); // no breakpoints → run to terminal
  return session;
}

/** Break on `line` (source breakpoint) and continue to the first stop there. */
const breakAt = (line: number) => breakAtSpec(spec, line);

// ## 1. Storage fixed array — `fixedArr` = [111, 222, 333] at slots 0/1/2

describe('storage fixed array fixedArr[3] decodes to [111, 222, 333]', () => {
  it('fixedArr is expandable with exactly 3 index-named children', async () => {
    const session = await terminalSession();
    const state = await rows(session, 'State');

    const fixedArr = state.get('fixedArr');
    expect(
      fixedArr,
      'fixedArr must be surfaced as a State variable',
    ).toBeDefined();

    // A fixed-size storage array must be a nested variable (expandable), not a
    // scalar showing its first slot word (ref 0, value "111").
    expect(
      fixedArr!.variablesReference,
      'fixedArr must be expandable (non-zero variablesReference)',
    ).not.toBe(0);

    const kids = await children(session, fixedArr!);
    expect(kids, 'a uint256[3] must expand to exactly 3 elements').toHaveLength(3);
    expect(kids.map((k) => ({name: k.name, value: k.value}))).toEqual([
      {name: '0', value: '111'},
      {name: '1', value: '222'},
      {name: '2', value: '333'},
    ]);
    for (const child of kids) {
      expect(child.type).toBe('uint256');
      expect(child.variablesReference).toBe(0);
    }
  });
});

// ## 2. Memory fixed array — `local` = [11, 22, 33] (inline, no length prefix)

describe('memory fixed array local[3] decodes to [11, 22, 33]', () => {
  it('local is live at line 27 (the sum statement) and fully populated', async () => {
    const session = await breakAt(27);
    // Robust stop: first statement after all three `local[i] =` writes, and
    // `local` is read here so it is lexically live.
    expect(session.stackTrace().stackFrames[0]!.line).toBe(27);
  });

  it('local is expandable with exactly 3 children = [11, 22, 33]', async () => {
    const session = await breakAt(27);
    const locals = await rows(session, 'Locals');

    const local = locals.get('local');
    expect(
      local,
      `local must be surfaced in the Locals scope; saw ${[...locals.keys()].join(', ') || '(none)'}`,
    ).toBeDefined();

    expect(
      local!.variablesReference,
      'local must be expandable (non-zero variablesReference)',
    ).not.toBe(0);

    const kids = await children(session, local!);
    // Exactly 3 (static count N) — proves the no-length-prefix formula. A "+32"
    // length-prefix bug would read [22, 33, <garbage>] or a wrong count.
    expect(kids, 'a uint256[3] must expand to exactly 3 elements').toHaveLength(3);
    expect(kids.map((k) => ({name: k.name, value: k.value}))).toEqual([
      {name: '0', value: '11'},
      {name: '1', value: '22'},
      {name: '2', value: '33'},
    ]);
    for (const child of kids) {
      expect(child.type).toBe('uint256');
      expect(child.variablesReference).toBe(0);
    }
  });
});

// ## 3. The value-type sibling `sum` stays a scalar

describe('value-type storage sibling stays a scalar', () => {
  it('sum reads 66 as a scalar in the State scope', async () => {
    const session = await terminalSession();
    const state = await rows(session, 'State');

    const sum = state.get('sum');
    expect(sum, 'sum must be surfaced as a State variable').toBeDefined();
    expect(sum!.value).toBe('66');
    expect(sum!.type).toBe('uint256');
    // A plain value type stays a scalar — no spurious expansion.
    expect(sum!.variablesReference).toBe(0);
  });
});
