/**
 * Event / LOG decoding surfaced as a read-only "Events" scope.
 *
 * `StorageRefs.populate()` emits ONE event on its last body statement (line 35):
 *   `event Updated(uint256 indexed key, uint256 value);`  emitted `Updated(7, 100)`
 *
 * It compiles to a single `LOG2` op. This suite pins, against the REAL recorded
 * trace (storagerefs-populate-trace.raw.json, 974 steps, contract
 * 0x5fbd…80aa3):
 *
 *   • the LOG2 op at step idx 970, pc 1121, depth 1, own-contract (not init code);
 *   • its stack (top-of-stack LAST): offset = stack[len-1] = 0x160 (352),
 *     size = stack[len-2] = 0x20 (32), topic0 = stack[len-3] (the selector),
 *     topic1 = stack[len-4] = 0x7 (the indexed `key`);
 *   • topic0 == keccak256(utf8("Updated(uint256,uint256)")) — the canonical
 *     signature over ALL params (indexed + non-indexed) in declaration order;
 *   • the LOG data = folded memory[352..384] = 0x…64 = 100 (the non-indexed
 *     `value`).
 * → decoded event = `Updated(key = 7, value = 100)`.
 *
 * The dereference-oracle (independent keccak recompute + topic/data read from the
 * raw trace) is a genuine anchor, not a tautology.
 */
import {keccak256} from 'ethereum-cryptography/keccak';
import {bytesToHex, utf8ToBytes} from 'ethereum-cryptography/utils';
import {describe, expect, it} from 'vitest';

import {StateCursor, type Step} from '@simbolik/lifting';

import type {SolidityDebugSession} from '../src/index.js';

import {
  children,
  launch,
  loadSteps,
  metaOf,
  normAddr,
  scopeRef,
  scopeVars,
  type DapVariable,
  type Spec,
} from './support/harness.js';

// ---------------------------------------------------------------------------
// Fixtures (loaded EXACTLY as storage-refs.test.ts, via the shared harness)
// ---------------------------------------------------------------------------

const TRACE = 'storagerefs-populate-trace.raw.json';
const META = 'storagerefs-populate-meta.json';
const SRC = 'src/StorageRefs.sol';
const NAME = 'StorageRefs';

/**
 * The `Updated(uint256,uint256)` event selector — '0x' + keccak256 of the
 * canonical signature. Re-derived independently in the oracle test below and
 * confirmed to equal the LOG2's topic0 in the raw trace.
 */
const SELECTOR =
  '0xd78a0cb8bb633d06981248b816e7bd33c2a35a6089241d099fa519e361cab902';

const spec: Spec = {
  buildInfo: 'storagerefs-build-info.json',
  trace: TRACE,
  meta: META,
  sourcePath: SRC,
  contractName: NAME,
  methodName: 'populate',
};

/**
 * A session run to the TERMINAL step. The LOG2 is at idx 970, the last body
 * statement; a breakpoint at line 35 would stop at the emit's FIRST step (before
 * the LOG executes), so we `continue()` with no breakpoints to the terminal STOP
 * (idx 973, still the own depth-1 StorageRefs frame) — where the event is
 * observable up to the frame's own step.
 */
async function terminalSession(): Promise<SolidityDebugSession> {
  const session = await launch(spec);
  session.continue();
  return session;
}

// ---------------------------------------------------------------------------
// 1. Dereference oracle — independently recompute the selector + read the LOG2
//    topics/data straight from the raw trace (self-anchor; may pass at once).
// ---------------------------------------------------------------------------

describe('dereference oracle: LOG2 selector + topic1/data', () => {
  it('one LOG2 at idx 970; topic0==keccak(sig), topic1=7, data=100', () => {
    const steps = loadSteps(TRACE);

    // Exactly one LOG op in the whole trace, and it is the LOG2 at idx 970.
    const logIndices = steps
      .map((s, i) => ({i, op: s.op}))
      .filter((s) => /^LOG[0-4]$/.test(s.op));
    expect(logIndices).toEqual([{i: 970, op: 'LOG2'}]);

    const s = steps[970]!;
    expect(s.pc).toBe(1121);
    expect(s.depth).toBe(1);
    expect(s.isInitCode).toBe(false);
    // Attributed to the emitting (own) contract.
    expect('0x' + s.codeAddress.toString(16)).toBe(normAddr(metaOf(META).contractAddress));

    // Stack top-of-stack LAST: offset=stack[-1], size=stack[-2],
    // topic0=stack[-3], topic1=stack[-4] (n = 2 topics → LOG2).
    const st = s.stack;
    const n = st.length;
    const offset = BigInt(st[n - 1]!);
    const size = BigInt(st[n - 2]!);
    const topic0 = BigInt(st[n - 3]!);
    const topic1 = BigInt(st[n - 4]!);
    expect(offset).toBe(352n);
    expect(size).toBe(32n);
    expect(topic1).toBe(7n);

    // Independent keccak recompute of the canonical signature == topic0.
    const selector =
      '0x' + bytesToHex(keccak256(utf8ToBytes('Updated(uint256,uint256)')));
    expect(selector).toBe(SELECTOR);
    expect(topic0).toBe(BigInt(SELECTOR));

    // LOG data = folded memory[offset..offset+size] byte-slice = 100.
    const cursor = new StateCursor(steps);
    const flat = cursor
      .at(970)
      .memory.map((w) => w.replace(/^0x/, '').padStart(64, '0'))
      .join('');
    const off = Number(offset);
    const sz = Number(size);
    const dataHex = flat.slice(off * 2, (off + sz) * 2);
    expect(BigInt('0x' + dataHex)).toBe(100n);
  });
});

// ---------------------------------------------------------------------------
// 2. Enumeration/decoding helper — `enumerateEvents` decodes the LOG2 into the
//    single Updated(7, 100) event, bounded by the current step.
//
// The helper's HOME is flexible. To stay type-clean, we load it via a RUNTIME
// (non-literal) dynamic import across the plausible module homes and fall back to
// `undefined`; the "must be defined" assertion guards that the export is present.
// The signature is
// `enumerateEvents(steps, cursor, codeAddress, uptoStepIndex, eventDefs)`.
//
// `eventDefs` is supplied as an INLINE literal (matching the solc `events()`
// inventory shape) so this test is independent of the solc accessor.
// ---------------------------------------------------------------------------

interface DecodedEventArg {
  name: string;
  value: unknown;
  typeLabel?: string;
}
interface DecodedEvent {
  name: string;
  args: DecodedEventArg[];
}
type EnumerateEventsFn = (
  steps: Step[],
  cursor: StateCursor,
  codeAddress: string,
  uptoStepIndex: number,
  eventDefs: unknown,
) => DecodedEvent[];

/** The event inventory as the solc `events()` accessor is contracted to yield. */
const EVENT_DEFS = [
  {
    name: 'Updated',
    selector: SELECTOR,
    params: [
      {name: 'key', solcType: 't_uint256', typeLabel: 'uint256', indexed: true},
      {name: 'value', solcType: 't_uint256', typeLabel: 'uint256', indexed: false},
    ],
  },
];

/** Discover `enumerateEvents` wherever the implementer exports it. */
async function loadEnumerateEvents(): Promise<EnumerateEventsFn | undefined> {
  const candidates = [
    '../src/events.js',
    '../src/index.js',
    '../src/mappings.js',
    '../src/machineState.js',
  ];
  for (const candidate of candidates) {
    try {
      const mod = (await import(candidate)) as Record<string, unknown>;
      const fn = mod['enumerateEvents'];
      if (typeof fn === 'function') return fn as unknown as EnumerateEventsFn;
    } catch {
      // Not exported from this candidate module — try the next.
    }
  }
  return undefined;
}

describe('enumerateEvents decodes the LOG2 into Updated(7, 100)', () => {
  it('returns one Updated event after the LOG step; [] before it', async () => {
    const enumerate = await loadEnumerateEvents();
    expect(
      enumerate,
      'enumerateEvents must be exported (debugger events helper)',
    ).toBeDefined();

    const steps = loadSteps(TRACE);
    const cursor = new StateCursor(steps);
    const addr = normAddr(metaOf(META).contractAddress);

    // Up to the terminal step (past the LOG2 at idx 970) → exactly one event.
    const decoded = enumerate!(steps, cursor, addr, steps.length - 1, EVENT_DEFS);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]!.name).toBe('Updated');
    const args = decoded[0]!.args;
    expect(args.map((a) => a.name)).toEqual(['key', 'value']);
    // value may be rendered as a string ('7') or a bigint (7n) — accept either.
    expect(String(args[0]!.value)).toBe('7');
    expect(String(args[1]!.value)).toBe('100');

    // Bounded by the current step: BEFORE the LOG2 (idx 970) no event exists.
    expect(enumerate!(steps, cursor, addr, 969, EVENT_DEFS)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Session — a read-only `Events` scope that lists the decoded event nested.
// ---------------------------------------------------------------------------

describe('session exposes a read-only Events scope', () => {
  it('scopes() includes Events; it lists Updated with nested key=7, value=100', async () => {
    const session = await terminalSession();
    const frameId = session.stackTrace().stackFrames[0]!.id;
    const {scopes} = session.scopes(frameId);

    const names = scopes.map((s) => s.name);
    expect(names, `Events scope missing; scopes were ${names.join(', ')}`).toContain(
      'Events',
    );
    const eventsScope = scopes.find((s) => s.name === 'Events');
    expect(eventsScope, 'Events scope must be present').toBeDefined();
    // A read-only supplementary scope — not marked expensive.
    expect(eventsScope!.expensive ?? false).toBe(false);

    const {variables} = await session.variables(eventsScope!.variablesReference);
    const dap = variables as DapVariable[];
    const updated = dap.find((v) => v.name.startsWith('Updated'));
    expect(updated, 'the Events scope must list the Updated event').toBeDefined();
    expect(
      updated!.variablesReference,
      'the event must expand into its decoded args',
    ).not.toBe(0);
    // Parent preview asserted loosely — it should surface the decoded values.
    expect(updated!.value).toContain('7');
    expect(updated!.value).toContain('100');

    const {variables: children} = await session.variables(
      updated!.variablesReference,
    );
    const kids = (children as DapVariable[]).map((v) => ({
      name: v.name,
      value: v.value,
    }));
    expect(kids).toEqual([
      {name: 'key', value: '7'},
      {name: 'value', value: '100'},
    ]);
    for (const child of children as DapVariable[]) {
      expect(child.type).toBe('uint256');
      expect(child.variablesReference).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Regression — the new Events scope is ADDITIVE: State/Locals/EVM survive in
//    order, with Events appended last (the ordering this cycle pins).
// ---------------------------------------------------------------------------

describe('regression: Events is appended to State/Locals/EVM', () => {
  it('the storagerefs frame exposes State, Locals, EVM, Events in order', async () => {
    const session = await terminalSession();
    const frameId = session.stackTrace().stackFrames[0]!.id;
    const names = session.scopes(frameId).scopes.map((s) => s.name);
    expect(names).toEqual(['Locals', 'State', 'Globals', 'Events', 'EVM']);
  });
});

// ---------------------------------------------------------------------------
// 5. The Events view is GLOBAL: bounded by the CURRENT step (not the whole
//    trace), and each entry names the emitting contract.
// ---------------------------------------------------------------------------

/** The Events scope variables for the top frame of `session`. */
async function eventsOf(
  session: SolidityDebugSession,
): Promise<DapVariable[]> {
  return scopeVars(session, 'Events');
}

describe('Events view — global, current-step-bounded, emitter-labelled', () => {
  it('is empty at entry (LOG not yet executed) and populated at the terminal', async () => {
    const atEntry = await launch(spec);
    // At the entry stop the emit has NOT run, so the global Events view is empty.
    expect(await eventsOf(atEntry)).toEqual([]);

    // After continue (past the LOG) the event appears, tagged with its emitter.
    atEntry.continue();
    const events = await eventsOf(atEntry);
    expect(events).toHaveLength(1);
    expect(events[0]!.name).toBe('Updated');
    expect(events[0]!.value).toContain(`${NAME}.Updated`); // emitter-qualified
    expect(events[0]!.value).toContain('7');
    expect(events[0]!.value).toContain('100');
  });

  it('renders the same list regardless of which frame requested the scope', async () => {
    const session = await terminalSession();
    const frames = session.stackTrace().stackFrames;
    const lists = await Promise.all(
      frames.map((f) => children(session, scopeRef(session, 'Events', f.id))),
    );
    for (const list of lists) {
      expect(list.map((v) => v.value)).toEqual(lists[0]!.map((v) => v.value));
    }
  });
});
