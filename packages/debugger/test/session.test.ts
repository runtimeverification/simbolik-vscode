/**
 * Minimal end-to-end DAP skeleton.
 *
 * Drives the core DAP request sequence
 * (`initialize → launch → threads → stackTrace → scopes → variables`) in-memory
 * against a REAL recorded `Counter.setNumber(42)` trace, plus a focused test of
 * the `Machine.State` adapter + `readPointerValue` path through the real
 * `@ethdebug/pointers` library.
 *
 * `launch` stops at the first executable statement (entry) rather than the
 * terminal step, so the Counter expectations reflect the entry position (line 8,
 * `number` still unset → "0"); a `continue()`-to-terminal test covers the read
 * path (`number` → "42"). The `machineStateFor` + `readPointerValue` adapter test
 * exercises the real `@ethdebug/pointers` path.
 *
 * All ground-truth values below were verified against the real trace +
 * build-info fixtures.
 */
import {fileURLToPath} from 'node:url';
import * as nodePath from 'node:path';

import {describe, expect, it} from 'vitest';

import {
  machineStateFor,
  readPointerValue,
  SolidityDebugSession,
  type LaunchInputs,
} from '../src/index.js';

import {
  cursorFor,
  launch,
  metaOf,
  toLaunchInputs,
  type Spec,
} from './support/harness.js';

// ---------------------------------------------------------------------------
// Fixtures + LaunchInputs helper
// ---------------------------------------------------------------------------

const TRACE = 'counter-setNumber-trace.raw.json';

/** Recorded meta: the running contract address, calldata, terminal storage. */
const CODE_ADDRESS = metaOf('counter-setNumber-meta.json').contractAddress;

/** The fixture bundle + entry coordinates the whole suite drives against. */
const spec: Spec = {
  buildInfo: 'counter-build-info.json',
  trace: TRACE,
  meta: 'counter-setNumber-meta.json',
  sourcePath: 'src/Counter.sol',
  contractName: 'Counter',
  methodName: 'setNumber',
};

/** Build the `LaunchInputs` the whole suite drives against. */
function launchInputs(): LaunchInputs {
  return toLaunchInputs(spec);
}

/** Launch a fresh, positioned session. */
async function launchedSession(): Promise<SolidityDebugSession> {
  return launch(spec);
}

// ---------------------------------------------------------------------------
// 1. initialize
// ---------------------------------------------------------------------------

describe('SolidityDebugSession.initialize', () => {
  it('advertises supportsConfigurationDoneRequest', () => {
    const session = new SolidityDebugSession();
    const caps = session.initialize();
    expect(caps.supportsConfigurationDoneRequest).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. launch → 'stopped' event
// ---------------------------------------------------------------------------

describe('SolidityDebugSession.launch', () => {
  it('queues a "stopped" event with reason "entry" on thread 1', async () => {
    const session = await launchedSession();
    const stopped = session.events.find((e) => e.event === 'stopped') as
      | {event: 'stopped'; body: {reason: string; threadId: number}}
      | undefined;
    expect(stopped).toBeDefined();
    expect(stopped!.body.reason).toBe('entry');
    expect(stopped!.body.threadId).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. threads
// ---------------------------------------------------------------------------

describe('SolidityDebugSession.threads', () => {
  it('returns exactly one thread with id 1', async () => {
    const session = await launchedSession();
    const {threads} = session.threads();
    expect(threads).toHaveLength(1);
    expect(threads[0]!.id).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. stackTrace
// ---------------------------------------------------------------------------

describe('SolidityDebugSession.stackTrace', () => {
  it('returns exactly one frame at the entry statement (src/Counter.sol 8:18)', async () => {
    const session = await launchedSession();
    const {stackFrames, totalFrames} = session.stackTrace();
    expect(stackFrames).toHaveLength(1);
    expect(totalFrames).toBe(1);

    const frame = stackFrames[0]!;
    expect(frame.name).toBe('setNumber');
    expect(frame.source?.path).toBe('src/Counter.sol');
    // Entry stop: `number = newNumber;` on line 8.
    expect(frame.line).toBe(8);
    expect(frame.column).toBe(18);
  });

  it('serves frame source content via a sourceReference (source request)', async () => {
    const session = await launchedSession();
    const frame = session.stackTrace().stackFrames[0]!;

    // The frame carries a positive sourceReference so VSCode fetches content
    // (the build-info source is relative / may not be on the client's disk).
    expect(frame.source?.sourceReference).toBeGreaterThan(0);
    expect(frame.source?.name).toBe('Counter.sol');
    expect(frame.source?.path).toBe('src/Counter.sol');

    const {content} = session.source(frame.source!.sourceReference!);
    expect(content).toContain('contract Counter');
    expect(content).toContain('function setNumber');
  });

  it('throws on an unknown sourceReference', async () => {
    const session = await launchedSession();
    expect(() => session.source(999999)).toThrow(/unknown sourceReference/);
  });

  it('references the REAL on-disk file when sourceRoot is set (no sourceReference)', async () => {
    // The counter foundry fixture has src/Counter.sol on disk under this root.
    const root = fileURLToPath(
      new URL('../../../test/fixtures/counter', import.meta.url),
    );
    const session = new SolidityDebugSession();
    await session.launch({...launchInputs(), sourceRoot: root});

    const frame = session.stackTrace().stackFrames[0]!;
    // Real file → absolute path, and NO sourceReference (VSCode opens the file).
    expect(frame.source?.sourceReference).toBeUndefined();
    expect(frame.source?.path).toBe(nodePath.join(root, 'src/Counter.sol'));
  });

  it('arms a breakpoint set via the absolute real-file path (path normalized)', async () => {
    const root = fileURLToPath(
      new URL('../../../test/fixtures/counter', import.meta.url),
    );
    const session = new SolidityDebugSession();
    await session.launch({...launchInputs(), sourceRoot: root});

    // Run to the terminal, then set a breakpoint on line 8 using the ABSOLUTE
    // path VSCode sends for the real file. reverseContinue must land on it —
    // which only happens if the path was normalized to the model's relative key.
    session.continue();
    session.setBreakpoints({
      source: {path: nodePath.join(root, 'src/Counter.sol')},
      breakpoints: [{line: 8}],
    });
    session.reverseContinue();
    expect(session.stackTrace().stackFrames[0]!.line).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// 5. scopes
// ---------------------------------------------------------------------------

describe('SolidityDebugSession.scopes', () => {
  it('returns State, Locals, EVM, each with a distinct positive ref', async () => {
    const session = await launchedSession();
    const frameId = session.stackTrace().stackFrames[0]!.id;
    const {scopes} = session.scopes(frameId);

    // Display order: Locals → State → Globals → Events → EVM.
    expect(scopes).toHaveLength(5);
    expect(scopes.map((s) => s.name)).toEqual([
      'Locals',
      'State',
      'Globals',
      'Events',
      'EVM',
    ]);

    const state = scopes.find((s) => s.name === 'State');
    const locals = scopes.find((s) => s.name === 'Locals');
    const evm = scopes.find((s) => s.name === 'EVM');
    expect(state!.variablesReference).toBeGreaterThan(0);
    expect(locals!.variablesReference).toBeGreaterThan(0);
    expect(evm!.variablesReference).toBeGreaterThan(0);
    const refs = [
      state!.variablesReference,
      locals!.variablesReference,
      evm!.variablesReference,
    ];
    expect(new Set(refs).size).toBe(3);
    // State/Locals are cheap; EVM may be marked expensive.
    expect(state!.expensive).toBe(false);
    expect(locals!.expensive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6-8. variables
// ---------------------------------------------------------------------------

describe('SolidityDebugSession.variables', () => {
  /** Resolve the two scope refs for the single frame. */
  async function scopeRefs(): Promise<{
    session: SolidityDebugSession;
    stateRef: number;
    localsRef: number;
  }> {
    const session = await launchedSession();
    const frameId = session.stackTrace().stackFrames[0]!.id;
    const {scopes} = session.scopes(frameId);
    return {
      session,
      stateRef: scopes.find((s) => s.name === 'State')!.variablesReference,
      localsRef: scopes.find((s) => s.name === 'Locals')!.variablesReference,
    };
  }

  it('State scope exposes number = 0 at entry (unset), read via the storage pointer', async () => {
    const {session, stateRef} = await scopeRefs();
    const {variables} = await session.variables(stateRef);
    expect(variables).toHaveLength(1);
    // At the entry stop the assignment has NOT executed yet, so storage slot 0
    // is still zero.
    expect(variables[0]).toEqual({
      name: 'number',
      value: '0',
      type: 'uint256',
      variablesReference: 0,
    });
  });

  it('State scope reflects seeded initialStorage at entry (setUp-style pre-state)', async () => {
    // A prior tx (e.g. `setUp()`) wrote slot 0 to 123; this trace only READS it,
    // so a delta trace carries no SLOAD delta. Seeding the pre-state (keyed by
    // the minimal-hex slot the node/lookup use) must surface it from step 0.
    const session = new SolidityDebugSession();
    await session.launch({
      ...launchInputs(),
      initialStorage: {[CODE_ADDRESS.toLowerCase()]: {'0x0': '0x7b'}},
    });
    const frameId = session.stackTrace().stackFrames[0]!.id;
    const stateRef = session
      .scopes(frameId)
      .scopes.find((s) => s.name === 'State')!.variablesReference;
    const {variables} = await session.variables(stateRef);
    expect(variables[0]).toEqual({
      name: 'number',
      value: '123',
      type: 'uint256',
      variablesReference: 0,
    });
  });

  it('State scope exposes number = 42 after continue() runs to the terminal', async () => {
    const {session, stateRef} = await scopeRefs();
    // No breakpoints set → continue runs to the terminal step, where the
    // assignment has executed and storage slot 0 holds 42.
    await session.continue();
    const {variables} = await session.variables(stateRef);
    expect(variables).toHaveLength(1);
    expect(variables[0]).toEqual({
      name: 'number',
      value: '42',
      type: 'uint256',
      variablesReference: 0,
    });
  });

  it('Locals scope exposes newNumber = 42 (uint256), read via the calldata pointer', async () => {
    const {session, localsRef} = await scopeRefs();
    const {variables} = await session.variables(localsRef);
    expect(variables).toHaveLength(1);
    expect(variables[0]).toEqual({
      name: 'newNumber',
      value: '42',
      type: 'uint256',
      variablesReference: 0,
    });
  });

  it('returns no variables for an unknown reference', async () => {
    const {session, stateRef, localsRef} = await scopeRefs();
    const bogus = Math.max(stateRef, localsRef) + 1000;
    const {variables} = await session.variables(bogus);
    expect(variables).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 9. disconnect
// ---------------------------------------------------------------------------

describe('SolidityDebugSession.disconnect', () => {
  it('does not throw', async () => {
    const session = await launchedSession();
    expect(() => session.disconnect()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 10. Machine.State adapter + readPointerValue (the real @ethdebug path)
// ---------------------------------------------------------------------------

describe('machineStateFor + readPointerValue (terminal step 117)', () => {
  it('reads storage slot 0 and calldata[4:36] as 42n', async () => {
    const {cursor} = cursorFor(TRACE);
    expect(cursor.length).toBe(118);

    const state = cursor.at(117);
    const ms = machineStateFor(state, CODE_ADDRESS);

    // Words path: storage.read({slot: Data}) → slot.asUint() → word.
    const stored = await readPointerValue(
      {location: 'storage', slot: 0, offset: 0, length: 32},
      ms,
    );
    expect(stored).toBe(42n);

    // Bytes path: calldata.read({slice: {offset: bigint, length: bigint}}).
    const arg = await readPointerValue(
      {location: 'calldata', offset: 4, length: 32},
      ms,
    );
    expect(arg).toBe(42n);
  });
});
