/**
 * FIXED-size array (`T[N]`, value-type elements) decoding in BOTH storage and
 * memory. The debugger already decodes DYNAMIC arrays via ethdebug `List`
 * pointers; fixed arrays currently fall through with NO layout, so they render
 * as opaque scalars (storage) or are dropped entirely (memory locals). These
 * tests pin the target behaviour and FAIL until the producer emits a fixed-array
 * `ArrayLayout` (packages/ethdebug-gen — memory in variables.ts, storage in
 * index.ts). No render-side change is expected.
 *
 * Fixture: FixedArrays.fill() (kontrol dialect, 324 steps), recorded live.
 *   contract FixedArrays {
 *     uint256[3] public fixedArr; // slots 0,1,2 (inplace, no keccak)
 *     uint256    public sum;      // slot 3
 *     function fill() external {
 *       fixedArr = [111, 222, 333];
 *       uint256[3] memory local = [11, 22, 33]; // inline, NO length prefix
 *       sum = local[0] + local[1] + local[2];   // = 66
 *     }
 *   }
 *
 * ── Ground truth (verified against the raw trace + machine state) ──────────────
 *   STORAGE @ terminal step (continue()): slot0=111, slot1=222, slot2=333,
 *     slot3(sum)=66. Today `fixedArr` renders as a NON-expandable scalar "111"
 *     (the first slot word), `variablesReference === 0`.
 *   MEMORY @ line 27 (`sum = local[0] + ...`, trace step 165): the memory words
 *     at byte offsets 0x80/0xa0/0xc0 read 11/22/33 (confirmed by reading the
 *     machine-state memory region directly). The stack slot for `local` points
 *     DIRECTLY at element 0 — no length word — so element i is at base + i*32.
 *     A wrong "+32 length-prefix" formula would read [22, 33, <next word>]; the
 *     exact-[11,22,33] assertion distinguishes correct from that bug.
 *
 * Line 27 is chosen for the memory case because it is the FIRST statement after
 * all three `local[i] =` writes and `local` is still lexically live there (it is
 * read by the statement), so the array is fully populated and its pointer is
 * resolvable — a robust, stable stopping point.
 */
import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {SolidityDebugSession, type LaunchInputs} from '../src/index.js';

// ---------------------------------------------------------------------------
// Fixtures + LaunchInputs (mirrors arrays.test.ts / variables.test.ts)
// ---------------------------------------------------------------------------

function solcFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../../solc/test/fixtures/${name}`, import.meta.url),
      'utf8',
    ),
  );
}
function dbgFixtureText(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}
function contractAddress(): string {
  const meta = JSON.parse(
    dbgFixtureText('fixedarrays-fill-meta.json'),
  ) as {contractAddress: string};
  return meta.contractAddress;
}

function inputs(): LaunchInputs {
  return {
    buildInfoJson: solcFixture('fixedarrays-build-info.json'),
    traceJson: dbgFixtureText('fixedarrays-fill-trace.raw.json'),
    sourcePath: 'src/FixedArrays.sol',
    contractName: 'FixedArrays',
    methodName: 'fill',
    codeAddress: contractAddress(),
    dialect: 'kontrol',
  };
}

/** A DAP variable as the session emits it. */
interface DapVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
}

function scopeRef(session: SolidityDebugSession, name: string): number {
  const frameId = session.stackTrace().stackFrames[0]!.id;
  const {scopes} = session.scopes(frameId);
  const scope = scopes.find((s) => s.name === name);
  if (scope === undefined) {
    throw new Error(
      `no '${name}' scope; scopes were ${scopes.map((s) => s.name).join(', ')}`,
    );
  }
  return scope.variablesReference;
}

async function rows(
  session: SolidityDebugSession,
  scopeName: string,
): Promise<Map<string, DapVariable>> {
  const {variables} = await session.variables(scopeRef(session, scopeName));
  return new Map((variables as DapVariable[]).map((v) => [v.name, v]));
}

async function children(
  session: SolidityDebugSession,
  parent: DapVariable,
): Promise<DapVariable[]> {
  const {variables} = await session.variables(parent.variablesReference);
  return variables as DapVariable[];
}

/** Terminal step: all storage committed. */
async function terminalSession(): Promise<SolidityDebugSession> {
  const session = new SolidityDebugSession();
  await session.launch(inputs());
  await session.continue(); // no breakpoints → run to terminal
  return session;
}

/** Break on `line` (source breakpoint) and continue to the first stop there. */
async function breakAt(line: number): Promise<SolidityDebugSession> {
  const session = new SolidityDebugSession();
  await session.launch(inputs());
  session.setBreakpoints({
    source: {path: 'src/FixedArrays.sol'},
    breakpoints: [{line}],
  });
  session.continue();
  return session;
}

// ---------------------------------------------------------------------------
// 1. STORAGE fixed array — `fixedArr` = [111, 222, 333] at slots 0/1/2
// ---------------------------------------------------------------------------

describe('storage fixed array fixedArr[3] decodes to [111, 222, 333]', () => {
  it('fixedArr is expandable with exactly 3 index-named children', async () => {
    const session = await terminalSession();
    const state = await rows(session, 'State');

    const fixedArr = state.get('fixedArr');
    expect(
      fixedArr,
      'fixedArr must be surfaced as a State variable',
    ).toBeDefined();

    // A fixed-size storage array must be a NESTED variable (expandable). Today
    // it has no array layout and renders as a scalar (ref 0, value "111").
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

// ---------------------------------------------------------------------------
// 2. MEMORY fixed array — `local` = [11, 22, 33] (inline, no length prefix)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 3. Regression — value-type sibling `sum` and non-array storage unaffected
// ---------------------------------------------------------------------------

describe('regression: value-type storage sibling unaffected', () => {
  it('sum still reads 66 as a scalar in the State scope', async () => {
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
