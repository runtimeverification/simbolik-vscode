/**
 * Session multi-frame lift for GETH via an address→CU registry.
 *
 * Drives `SolidityDebugSession` against the REAL recorded anvil (geth-dialect)
 * transaction `Caller.go(callee, 7)` → external `Callee.compute(7)` (677 steps;
 * depth-1 = Caller `0xe7f1…512`, depth-2 = Callee `0x5fbd…aa3`, depth-2 span
 * [249..562]). The two contracts live in SEPARATE geth build-infos
 * (`caller-geth-build-info.json` / `callee-geth-build-info.json`, solc 0.8.35,
 * unopt) each with its own single source (`src/Caller.sol` / `src/Callee.sol`).
 *
 * A geth trace carries NO per-step code (`normalizeGethTrace` leaves
 * `programChange: null`), so the session's CBOR-from-trace registry
 * (`cursor.at(idx).bytecode`) is EMPTY for geth: every frame falls back to the
 * ENTRY (Caller) CU and the callee frame wrongly maps to `src/Caller.sol`. An
 * explicit address→build-info map, `contractsByAddress`, on `LaunchInputs`
 * resolves each frame's CU BY ADDRESS.
 *
 * Ground-truth (re-derived here against the raw trace + geth build-infos via the
 * real `normalizeGethTrace` + solc source-map / `variablesAt` / pointer path):
 *   - 677 steps; depth-2 span [249..562] (Callee = 0x5fbd…aa3).
 *   - Callee `compute` body: `src/Callee.sol` line 8 = `stored = x * 2;`,
 *     line 9 = `return stored + 1;`. First depth-2 step at line 8 = 358,
 *     line 9 = 441.
 *   - Callee param `x` = 7 reads at the line-8 step (358) and stays 7.
 *   - Callee SSTORE completes at step 439; `stored` = 0xe = 14 from then on
 *     (readable at the line-9 step 441 and every later depth-2 step).
 *   - Caller `result` (slot 0) is 0 while the callee runs; = 0xf = 15 only after
 *     the call returns (first at step 669; 15 at the terminal step 676).
 *
 * Without `contractsByAddress` the geth callee frame cannot be resolved by
 * address, so a `src/Callee.sol` breakpoint never matches (every step maps to
 * Caller); with it the session reconstructs the 2-frame stack, maps the callee to
 * `src/Callee.sol`, and reads `stored`=14. `contractsByAddress` is an optional
 * field on the launch object.
 */
import {describe, expect, it} from 'vitest';

import {SolidityDebugSession, type LaunchInputs} from '../src/index.js';

import {buildInfoOf, readDbgFixture} from './support/harness.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** REAL recorded anvil (geth) `debug_traceTransaction` response STRING. */
const CALLER_GO_TRACE_RAW = readDbgFixture('caller-go-anvil-trace.raw.json');

const CALLER_BI_JSON: unknown = buildInfoOf('caller-geth-build-info.json');

const CALLEE_BI_JSON: unknown = buildInfoOf('callee-geth-build-info.json');

const META = JSON.parse(
  readDbgFixture('caller-go-anvil-meta.json'),
) as {callerAddress: string; calleeAddress: string; goCalldata: string};

/** anvil dev account #0 — the tx sender. */
const ACCT0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

const CALLER_PATH = 'src/Caller.sol';
const CALLEE_PATH = 'src/Callee.sol';

// `src/Callee.sol` line 8 = `stored = x * 2;` (the `compute` body statement,
// mirroring the mixed-CU test); line 9 = `return stored + 1;`.
const CALLEE_BODY_LINE = 8;

// ---------------------------------------------------------------------------
// LaunchInputs — the `contractsByAddress` map (loose cast keeps the shape
// type-clean)
// ---------------------------------------------------------------------------

/**
 * Full geth multi-frame launch: entry = Caller, and an explicit address→CU map
 * so the callee frame resolves to the Callee CU BY ADDRESS (the fix). Keys are
 * lowercase per the API contract.
 */
function gethMultiFrameInputs(): LaunchInputs {
  return {
    dialect: 'geth',
    txContext: {
      to: META.callerAddress,
      from: ACCT0,
      input: META.goCalldata,
    },
    // Entry build-info (also present in the address map below). Provided so the
    // entry CU resolves regardless of how the map seeds `state.cus`.
    buildInfoJson: CALLER_BI_JSON,
    traceJson: CALLER_GO_TRACE_RAW,
    sourcePath: CALLER_PATH,
    contractName: 'Caller',
    methodName: 'go',
    codeAddress: META.callerAddress,
    // Optional field: address → {build-info, contract name}.
    contractsByAddress: {
      [META.callerAddress.toLowerCase()]: {
        buildInfoJson: CALLER_BI_JSON,
        contractName: 'Caller',
      },
      [META.calleeAddress.toLowerCase()]: {
        buildInfoJson: CALLEE_BI_JSON,
        contractName: 'Callee',
      },
    },
  } as unknown as LaunchInputs;
}

/**
 * The SAME geth trace WITHOUT `contractsByAddress` — only both build-infos in
 * the `buildInfos` array. Documents the gap: geth carries no per-step code, so
 * CBOR identification cannot resolve the callee and it falls back to the entry
 * (Caller) CU.
 */
function gethNoMapInputs(): LaunchInputs {
  return {
    dialect: 'geth',
    txContext: {
      to: META.callerAddress,
      from: ACCT0,
      input: META.goCalldata,
    },
    buildInfos: [CALLER_BI_JSON, CALLEE_BI_JSON],
    traceJson: CALLER_GO_TRACE_RAW,
    sourcePath: CALLER_PATH,
    contractName: 'Caller',
    methodName: 'go',
    codeAddress: META.callerAddress,
  } as LaunchInputs;
}

// ---------------------------------------------------------------------------
// Helpers (mirroring mixed.test.ts)
// ---------------------------------------------------------------------------

/** Scope refs for one frame, by name. */
function scopeRefsFor(
  session: SolidityDebugSession,
  frameId: number,
): {names: string[]; ref(name: string): number} {
  const {scopes} = session.scopes(frameId);
  return {
    names: scopes.map((s) => s.name),
    ref: (name: string) =>
      scopes.find((s) => s.name === name)?.variablesReference ?? -1,
  };
}

/**
 * Drive from entry to a depth-2 position INSIDE the Callee frame by arming a
 * breakpoint at `src/Callee.sol` line 8 and continuing. Returns once (in GREEN)
 * `stackTrace()` shows two frames.
 */
function continueIntoCallee(session: SolidityDebugSession): void {
  session.setBreakpoints({
    source: {path: CALLEE_PATH},
    breakpoints: [{line: CALLEE_BODY_LINE}],
  });
  session.continue();
}

/** Minimal DAP Variable shape used by the assertions below. */
interface V {
  name: string;
  value: string;
  type?: string;
  variablesReference?: number;
}

// ---------------------------------------------------------------------------
// 1. Full 2-frame geth lift — the address→CU registry
// ---------------------------------------------------------------------------

describe('geth multi-frame lift — stackTrace via contractsByAddress', () => {
  it('at entry reports a single Caller frame in src/Caller.sol', async () => {
    const session = new SolidityDebugSession();
    await session.launch(gethMultiFrameInputs());

    const {stackFrames} = session.stackTrace();
    expect(stackFrames).toHaveLength(1);
    expect(stackFrames[0]!.source?.path).toBe(CALLER_PATH);
    expect(stackFrames[0]!.name).toContain('go');
  });

  it('at a depth-2 step reports 2 frames: Callee (top) over Caller (bottom)', async () => {
    const session = new SolidityDebugSession();
    await session.launch(gethMultiFrameInputs());
    continueIntoCallee(session);

    const {stackFrames} = session.stackTrace();
    expect(stackFrames).toHaveLength(2);

    // TOP-FIRST DAP ordering: innermost (Callee) first, caller last.
    const [top, parent] = stackFrames;
    // The CORE of the fix: the callee frame maps to Callee.sol, NOT Caller.sol.
    expect(top!.source?.path).toContain('Callee.sol');
    expect(top!.source?.path).toBe(CALLEE_PATH);
    expect(top!.name).toContain('compute');

    expect(parent!.source?.path).toBe(CALLER_PATH);
    expect(parent!.name).toContain('go');
  });

  it('the callee (top) frame does NOT map to the entry Caller CU', async () => {
    const session = new SolidityDebugSession();
    await session.launch(gethMultiFrameInputs());
    continueIntoCallee(session);

    const {stackFrames} = session.stackTrace();
    expect(stackFrames).toHaveLength(2);
    // Regression guard for the entry-CU fallback bug: the top frame's source
    // must not be the Caller source.
    expect(stackFrames[0]!.source?.path).not.toBe(CALLER_PATH);
  });

  it('renders an address var that resolves to a contract as an expandable frame', async () => {
    const session = new SolidityDebugSession();
    await session.launch(gethMultiFrameInputs());

    // Caller.go(callee, x): the `callee` param is `address`, but its VALUE is the
    // Callee contract's address (in contractsByAddress) → shown as the contract
    // type with its address, and EXPANDABLE into that contract's storage.
    const frameId = session.stackTrace().stackFrames[0]!.id;
    const localsRef = scopeRefsFor(session, frameId).ref('Locals');
    const locals = (await session.variables(localsRef)).variables as V[];

    const callee = locals.find((v) => v.name === 'callee');
    expect(callee).toBeDefined();
    expect(callee!.value).toContain('Callee');
    expect(callee!.value.toLowerCase()).toContain(
      META.calleeAddress.toLowerCase(),
    );
    expect(callee!.variablesReference).toBeGreaterThan(0);

    // Expanding it yields the Callee contract's own storage fields.
    const inner = (await session.variables(callee!.variablesReference!))
      .variables as V[];
    expect(inner.map((v) => v.name)).toContain('stored');

    // A non-contract address (or a plain value) stays a scalar: `x` = 7.
    expect(locals.find((v) => v.name === 'x')?.variablesReference ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Per-frame variables — decoded against each frame's own (address) CU
// ---------------------------------------------------------------------------

describe('geth multi-frame lift — per-frame variables', () => {
  it("the callee frame's param x reads 7 (external compute(x))", async () => {
    const session = new SolidityDebugSession();
    await session.launch(gethMultiFrameInputs());
    continueIntoCallee(session);

    const frames = session.stackTrace().stackFrames;
    expect(frames).toHaveLength(2);
    const calleeFrameId = frames[0]!.id;
    const localsRef = scopeRefsFor(session, calleeFrameId).ref('Locals');
    const {variables} = await session.variables(localsRef);
    const x = (variables as V[]).find((v) => v.name === 'x');
    expect(x).toBeDefined();
    expect(x!.value).toBe('7');
  });

  it("the callee frame's State shows stored = 14 (callee storage) after its SSTORE", async () => {
    const session = new SolidityDebugSession();
    await session.launch(gethMultiFrameInputs());
    continueIntoCallee(session);

    // The line-8 breakpoint lands at the FIRST body step, which precedes the
    // SSTORE. Advance instruction-by-instruction (staying in the Callee frame)
    // until the write is observable in the Callee State scope. (Mirrors the
    // mixed-CU test.)
    let stored: V | undefined;
    for (let k = 0; k < 250; k++) {
      const frames = session.stackTrace().stackFrames;
      if (frames.length !== 2) break; // returned to the Caller frame
      const calleeFrameId = frames[0]!.id;
      const stateRef = scopeRefsFor(session, calleeFrameId).ref('State');
      const {variables} = await session.variables(stateRef);
      const s = (variables as V[]).find((v) => v.name === 'stored');
      if (s !== undefined && s.value === '14') {
        stored = s;
        break;
      }
      session.stepInstruction();
    }
    expect(stored).toBeDefined();
    expect(stored!.value).toBe('14');
    expect(stored!.type).toBe('uint256');
  });

  it('the parent Caller frame State shows result = 0 while the callee is running', async () => {
    const session = new SolidityDebugSession();
    await session.launch(gethMultiFrameInputs());
    continueIntoCallee(session);

    const frames = session.stackTrace().stackFrames;
    expect(frames).toHaveLength(2);
    const callerFrameId = frames[1]!.id;
    const stateRef = scopeRefsFor(session, callerFrameId).ref('State');
    const {variables} = await session.variables(stateRef);
    const result = (variables as V[]).find((v) => v.name === 'result');
    expect(result).toBeDefined();
    // The assignment `result = r` has not executed yet (the callee has not
    // returned), so the Caller's slot 0 is still 0.
    expect(result!.value).toBe('0');
  });

  it('the Caller frame State shows result = 15 at the terminal step', async () => {
    const session = new SolidityDebugSession();
    await session.launch(gethMultiFrameInputs());
    await session.continue(); // no callee breakpoint armed → run to terminal (depth 1)

    const {stackFrames} = session.stackTrace();
    expect(stackFrames).toHaveLength(1);
    expect(stackFrames[0]!.source?.path).toBe(CALLER_PATH);

    const stateRef = scopeRefsFor(session, stackFrames[0]!.id).ref('State');
    const {variables} = await session.variables(stateRef);
    const result = (variables as V[]).find((v) => v.name === 'result');
    expect(result).toBeDefined();
    expect(result!.value).toBe('15');
    expect(result!.type).toBe('uint256');
  });
});

// ---------------------------------------------------------------------------
// 3. Regression / gap doc — without the map, geth cannot resolve the callee
// ---------------------------------------------------------------------------

describe('geth multi-frame gap — without contractsByAddress', () => {
  it('cannot lift the geth callee to src/Callee.sol via buildInfos alone (CBOR needs per-step code geth lacks)', async () => {
    const session = new SolidityDebugSession();
    await session.launch(gethNoMapInputs());

    // Arm the Callee-source breakpoint and continue. With no address→CU map and
    // no per-step code, the callee cannot be identified, so no step resolves to
    // src/Callee.sol: the breakpoint never matches and continue runs to the
    // terminal single Caller frame. Assert loosely (documents the gap the
    // with-map path closes) — the top frame is NOT the Callee source.
    continueIntoCallee(session);
    const {stackFrames} = session.stackTrace();
    expect(stackFrames[0]!.source?.path).not.toBe(CALLEE_PATH);
  });
});

// ---------------------------------------------------------------------------
// 4. instruction step-over skips an external subcall (raw EVM depth)
// ---------------------------------------------------------------------------

describe('instruction step-over across an external CALL', () => {
  it('next({granularity:"instruction"}) at the CALL runs the callee to completion', async () => {
    const session = new SolidityDebugSession();
    await session.launch(gethMultiFrameInputs());

    // Advance one opcode at a time until the NEXT instruction enters the callee
    // (a second, depth-2 frame appears); step back to sit ON the CALL opcode.
    let guard = 0;
    while (guard++ < 5000) {
      if (session.currentStepIndex >= 676) break; // safety: near the last step
      session.stepInstruction();
      if (session.stackTrace().stackFrames.length === 2) {
        session.stepBackInstruction();
        break;
      }
    }
    const callStep = session.currentStepIndex;
    // At the CALL we are still in the single (Caller) frame...
    expect(session.stackTrace().stackFrames.length).toBe(1);

    // ...and instruction step-over runs the whole callee, landing back at depth 1
    // more than one step later (the entire [callee] span was skipped).
    session.next({granularity: 'instruction'});
    expect(session.stackTrace().stackFrames.length).toBe(1);
    expect(session.currentStepIndex).toBeGreaterThan(callStep + 1);
    expect(session.stackTrace().stackFrames[0]!.source?.path).toBe(CALLER_PATH);
  });
});

// ---------------------------------------------------------------------------
// 5. exception filters ("dynamic" breakpoints) — stop on external calls
// ---------------------------------------------------------------------------

describe('exception filter break-on-call stops at the external CALL', () => {
  it('continue stops ON the CALL op (still depth-1), then steps into the callee', async () => {
    const session = new SolidityDebugSession();
    await session.launch(gethMultiFrameInputs());
    session.setExceptionBreakpoints({filters: ['break-on-call']});

    session.continue();

    // Stopped ON the CALL opcode: still the single (caller) frame, reason set.
    expect(session.stackTrace().stackFrames.length).toBe(1);
    const stopped = session.events.filter((e) => e.event === 'stopped');
    expect(
      (stopped[stopped.length - 1] as {body: {reason: string}}).body.reason,
    ).toBe('breakpoint');
    // The very next instruction descends into the callee (depth 2).
    session.stepInstruction();
    expect(session.stackTrace().stackFrames.length).toBe(2);
  });

  it('with no filter enabled, continue runs past the call to the terminal', async () => {
    const withFilter = new SolidityDebugSession();
    await withFilter.launch(gethMultiFrameInputs());
    withFilter.setExceptionBreakpoints({filters: ['break-on-call']});
    withFilter.continue();
    const stoppedAtCall = withFilter.currentStepIndex;

    const noFilter = new SolidityDebugSession();
    await noFilter.launch(gethMultiFrameInputs());
    noFilter.continue(); // no breakpoints, no filters → terminal
    expect(noFilter.currentStepIndex).toBeGreaterThan(stoppedAtCall);
  });
});
