/**
 * A value-type MEMORY STRUCT local decoded as a NESTED DAP variable.
 *
 * `Locals.compute(10)` declares `struct Point { uint256 x; uint256 y; }` and the
 * local `Point memory pt = Point(a, small)` = `Point(11, 7)`. This is the smallest
 * reference type: a fixed group of value-type members, unblocking arrays/strings
 * later. The struct's location is runtime data — its memory offset lives in pt's
 * stack slot — so `variablesAt` emits pt's member LAYOUT statically (per-member
 * ethdebug pointers built from `$read` of the stack slot + each member's word
 * offset), and the value is read at dereference time through `@ethdebug/pointers`.
 *
 * ── Trace ground-truth (locals-compute-trace.raw.json) ────────────────────────
 * At pc 436 (line 37, the first `require` — a clean body statement AFTER pt is
 * assigned) pt's stack slot holds memory offset 0x120 (=288). In memory:
 *   memory[288..320] = 11  → pt.x
 *   memory[320..352] =  7  → pt.y
 * These were confirmed by reading the recorded trace memory directly (the struct
 * base offset from pt's stack slot, then memory[offset] / memory[offset+32]).
 *
 * Three things are pinned here (the producer SHAPE itself is pinned in
 * `@simbolik/ethdebug-gen`'s `variables.test.ts`):
 *   1. pt's member pointers dereference to 11 and 7 through the REAL ethdebug path
 *      (`machineStateFor` + `readPointerValue`) — proving the memory expression
 *      pointers resolve via `@ethdebug/pointers`.
 *   2. The session renders pt as a nested variable: a non-zero `variablesReference`
 *      + a `Point` summary, whose children are `x=11`, `y=7`.
 *   3. Regression: the value locals still decode and `nums`/`label` are surfaced.
 */
import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import type {Pointer} from '@ethdebug/pointers';
import {variablesAt, type ResolvedVariable} from '@simbolik/ethdebug-gen';
import {parseJsonLossless} from '@simbolik/engine';
import {normalizeKontrolTrace, StateCursor, type Step} from '@simbolik/lifting';
import {loadBuildInfo, type CompilationUnit} from '@simbolik/solc';

import {machineStateFor, readPointerValue} from '../src/machineState.js';
import {SolidityDebugSession, type LaunchInputs} from '../src/index.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function solcFixture(name: string): string {
  return readFileSync(
    new URL(`../../solc/test/fixtures/${name}`, import.meta.url),
    'utf8',
  );
}
function dbgFixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

function loadCu(): CompilationUnit {
  return loadBuildInfo(JSON.parse(solcFixture('locals-build-info.json')));
}
function loadSteps(): Step[] {
  const parsed = parseJsonLossless(
    dbgFixture('locals-compute-trace.raw.json'),
  ) as {result: unknown};
  return normalizeKontrolTrace(parsed.result as never);
}
function contractAddress(): string {
  const meta = JSON.parse(dbgFixture('locals-compute-meta.json')) as {
    contractAddress: string;
  };
  return meta.contractAddress;
}
/** Lowercase, 20-byte zero-padded — matches how accounts are keyed in the trace. */
function normAddr(a: string): string {
  return '0x' + BigInt(a).toString(16).padStart(40, '0');
}

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

/** A DAP variable as the session emits it. */
interface DapVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
}

// ---------------------------------------------------------------------------
// 1. Member pointers dereference to their recorded values (11, 7)
// ---------------------------------------------------------------------------

describe('struct member pointers dereference through @ethdebug/pointers', () => {
  it('pt.x reads 11 and pt.y reads 7 at pc 436 via machineStateFor + readPointerValue', async () => {
    const cu = loadCu();
    const steps = loadSteps();
    const cursor = new StateCursor(steps);
    const addr = normAddr(contractAddress());

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
    let index = -1;
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]!;
      if (s.isInitCode || s.codeAddress !== BigInt(addr)) continue;
      if (s.pc === 436) {
        index = i;
        break;
      }
    }
    expect(index, 'no own-contract step at pc 436').toBeGreaterThanOrEqual(0);
    const ms = machineStateFor(cursor.at(index), addr);

    // The pointers resolve their memory offset from pt's stack slot at dereference.
    expect(await readPointerValue(x!.pointer as Pointer, ms)).toBe(11n);
    expect(await readPointerValue(y!.pointer as Pointer, ms)).toBe(7n);
  });
});

// ---------------------------------------------------------------------------
// 2. The session renders pt as a nested variable
// ---------------------------------------------------------------------------

function inputs(): LaunchInputs {
  return {
    buildInfoJson: JSON.parse(solcFixture('locals-build-info.json')),
    traceJson: dbgFixture('locals-compute-trace.raw.json'),
    sourcePath: 'src/Locals.sol',
    contractName: 'Locals',
    methodName: 'compute',
    codeAddress: contractAddress(),
    dialect: 'kontrol',
  };
}

async function breakAt(line: number): Promise<SolidityDebugSession> {
  const session = new SolidityDebugSession();
  await session.launch(inputs());
  session.setBreakpoints({
    source: {path: 'src/Locals.sol'},
    breakpoints: [{line}],
  });
  session.continue();
  return session;
}

/** The current frame's `Locals` scope variablesReference. */
function localsRef(session: SolidityDebugSession): number {
  const frameId = session.stackTrace().stackFrames[0]!.id;
  const scope = session
    .scopes(frameId)
    .scopes.find((s) => s.name === 'Locals');
  if (scope === undefined) {
    throw new Error('no Locals scope');
  }
  return scope.variablesReference;
}

async function localsMap(
  session: SolidityDebugSession,
): Promise<Map<string, DapVariable>> {
  const {variables} = await session.variables(localsRef(session));
  return new Map((variables as DapVariable[]).map((v) => [v.name, v]));
}

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
    const {variables: children} = await session.variables(pt!.variablesReference);
    const kids = (children as DapVariable[]).map((v) => ({
      name: v.name,
      value: v.value,
    }));
    expect(kids).toEqual([
      {name: 'x', value: '11'},
      {name: 'y', value: '7'},
    ]);
    // Members carry their solc type for display.
    const x = (children as DapVariable[]).find((v) => v.name === 'x');
    expect(x!.type).toBe('uint256');
  });
});

// ---------------------------------------------------------------------------
// 3. Regression: value locals still decode; the reference locals are surfaced too
// ---------------------------------------------------------------------------

describe('regression: value locals decode & nums/label/pt are surfaced', () => {
  it('at line 37 the value locals are correct and nums/label/pt are surfaced', async () => {
    const session = await breakAt(37);
    const m = await localsMap(session);

    // Value locals unaffected.
    expect(m.get('a')).toMatchObject({value: '11', type: 'uint256'});
    expect(m.get('small')).toMatchObject({value: '7', type: 'uint8'});
    expect(m.get('sum')).toMatchObject({value: '0', type: 'uint256'});
    // `tail` sits AFTER the reference locals — still ranks/reads correctly.
    expect(m.get('tail')).toMatchObject({value: '18', type: 'uint256'});

    // The dynamic array + string are decoded (nums nested, label scalar) —
    // asserted in detail in arrays.test.ts. Here we only confirm they are
    // surfaced.
    expect(m.has('nums')).toBe(true);
    expect(m.has('label')).toBe(true);

    // The struct IS now surfaced (as a nested variable).
    expect(m.get('pt')).toBeDefined();
    expect(m.get('pt')!.variablesReference).not.toBe(0);
  });
});
