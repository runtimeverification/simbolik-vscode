/**
 * Mixed compilation units + optimized fallback + multi-frame.
 *
 * Drives `SolidityDebugSession` against the REAL recorded transaction
 * `Caller(unopt).go(callee, 21)` → external `Callee(opt).compute(21)` (488
 * steps; depth 1 = Caller 363 steps, depth 2 = Callee 125 steps). The two
 * contracts live in SEPARATE build-infos compiled at DIFFERENT optimization
 * levels, so the session must:
 *   - launch with multiple build-infos (`buildInfos`) and build an
 *     address→{contract, cu} registry via CBOR runtime-code identification;
 *   - resolve source mapping / scopes / variables PER STEP against the
 *     resolved contract's own CU (external CALLs now map to the callee's CU);
 *   - return a MULTI-FRAME stackTrace across the external call (top = Callee,
 *     bottom = Caller) at a depth-2 position;
 *   - apply the OPTIMIZED-frame fallback to the Callee frame — storage-only
 *     scopes `['State','EVM']` (NO Locals) — while the unoptimized Caller
 *     frame keeps its `Locals` scope. Display order is
 *     Locals → State → Globals → Events → EVM.
 *
 * Ground-truth (confirmed against the raw trace + build-info fixtures):
 *   - 488 steps; depth-1 = Caller (0xe7f1…512), depth-2 = Callee (0x5fbd…aa3);
 *     first depth-2 step index = 249; depth-2 runs 249–373.
 *   - Callee SSTORE completes at raw step 331; `stored` = 0x2a = 42 from step
 *     332 onward. Caller `result` = 0x2b = 43 at the terminal step.
 *   - Callee compute maps to src/Callee.sol (line 7+); line 8 = `stored = x*2`.
 */
import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {SolidityDebugSession, type LaunchInputs} from '../src/index.js';

// ---------------------------------------------------------------------------
// Fixtures + LaunchInputs helper
// ---------------------------------------------------------------------------

const MIXED_TRACE_RAW = readFileSync(
  new URL('./fixtures/mixed-go-trace.raw.json', import.meta.url),
  'utf8',
);

const CALLER_UNOPT_JSON: unknown = JSON.parse(
  readFileSync(
    new URL(
      '../../solc/test/fixtures/caller-unopt-build-info.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

const CALLEE_OPT_JSON: unknown = JSON.parse(
  readFileSync(
    new URL(
      '../../solc/test/fixtures/callee-opt-build-info.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

const MIXED_META = JSON.parse(
  readFileSync(
    new URL('./fixtures/mixed-go-meta.json', import.meta.url),
    'utf8',
  ),
) as {callerAddress: string; calleeAddress: string};

const CALLER_PATH = 'src/Caller.sol';
const CALLEE_PATH = 'src/Callee.sol';

/** Multi-build-info LaunchInputs for the mixed Caller→Callee transaction. */
function mixedLaunchInputs(): LaunchInputs {
  return {
    // Order-independent array of standard-json build-infos. The entry frame
    // is resolved from `codeAddress`; per-step frames from the CBOR registry.
    buildInfos: [CALLER_UNOPT_JSON, CALLEE_OPT_JSON],
    traceJson: MIXED_TRACE_RAW,
    sourcePath: CALLER_PATH,
    contractName: 'Caller',
    methodName: 'go',
    codeAddress: MIXED_META.callerAddress,
  } as LaunchInputs;
}

/** Launch a fresh mixed-CU session positioned at entry (Caller.go). */
async function mixedSession(): Promise<SolidityDebugSession> {
  const session = new SolidityDebugSession();
  await session.launch(mixedLaunchInputs());
  return session;
}

/** Scope refs for one frame, by name (Locals may be absent under optimization). */
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
 * Drive the session from entry to a depth-2 position INSIDE the Callee frame,
 * by arming a breakpoint at `src/Callee.sol` line 8 (`stored = x * 2`) and
 * continuing. Returns once `stackTrace()` shows two frames.
 */
function continueIntoCallee(session: SolidityDebugSession): void {
  session.setBreakpoints({
    source: {path: CALLEE_PATH},
    breakpoints: [{line: 8}],
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
// 1. Multi-frame stackTrace at a depth-2 position
// ---------------------------------------------------------------------------

describe('mixed-CU stackTrace — multi-frame across the external call', () => {
  it('at entry (depth 1) reports a single Caller frame', async () => {
    const session = await mixedSession();
    const {stackFrames} = session.stackTrace();
    expect(stackFrames).toHaveLength(1);
    expect(stackFrames[0]!.source?.path).toBe(CALLER_PATH);
  });

  it('at a depth-2 step reports 2 frames: Callee (top) over Caller (bottom)', async () => {
    const session = await mixedSession();
    continueIntoCallee(session);

    const {stackFrames} = session.stackTrace();
    expect(stackFrames).toHaveLength(2);
    // TOP-FIRST DAP ordering: innermost (Callee) first, caller last.
    expect(stackFrames[0]!.source?.path).toBe(CALLEE_PATH);
    expect(stackFrames[1]!.source?.path).toBe(CALLER_PATH);
  });
});

// ---------------------------------------------------------------------------
// 2. Per-frame scopes — optimized-frame fallback (no Locals)
// ---------------------------------------------------------------------------

describe('mixed-CU scopes — per-frame optimized fallback', () => {
  it('the optimized Callee (top) frame exposes State + EVM only (NO Locals)', async () => {
    const session = await mixedSession();
    continueIntoCallee(session);

    const frames = session.stackTrace().stackFrames;
    const calleeFrameId = frames[0]!.id;
    // A read-only `Events` scope is appended (independent of the optimized
    // no-Locals fallback — event decoding does not rely on stack analysis).
    expect(scopeRefsFor(session, calleeFrameId).names).toEqual([
      'State',
      'Globals',
      'Events',
      'EVM',
    ]);
  });

  it('the unoptimized Caller (bottom) frame keeps State, Locals, EVM', async () => {
    const session = await mixedSession();
    continueIntoCallee(session);

    const frames = session.stackTrace().stackFrames;
    const callerFrameId = frames[1]!.id;
    expect(scopeRefsFor(session, callerFrameId).names).toEqual([
      'Locals',
      'State',
      'Globals',
      'Events',
      'EVM',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. Per-frame variables — decoded against each frame's own CU
// ---------------------------------------------------------------------------

describe('mixed-CU variables — per-frame storage decode', () => {
  it("Callee State shows stored = '42' (uint256) after its SSTORE", async () => {
    const session = await mixedSession();
    continueIntoCallee(session);

    // The optimized breakpoint lands at the FIRST line-8 step, which precedes
    // the SSTORE. Advance instruction-by-instruction (staying in the Callee
    // frame) until the write is observable in the Callee State scope.
    let stored: V | undefined;
    for (let k = 0; k < 200; k++) {
      const frames = session.stackTrace().stackFrames;
      if (frames.length !== 2) break; // returned to the Caller frame
      const calleeFrameId = frames[0]!.id;
      const stateRef = scopeRefsFor(session, calleeFrameId).ref('State');
      const {variables} = await session.variables(stateRef);
      const s = (variables as V[]).find((v) => v.name === 'stored');
      if (s !== undefined && s.value === '42') {
        stored = s;
        break;
      }
      session.stepInstruction();
    }
    expect(stored).toBeDefined();
    expect(stored!.value).toBe('42');
    expect(stored!.type).toBe('uint256');
  });

  it("Caller State shows result = '43' at the terminal step", async () => {
    const session = await mixedSession();
    await session.continue(); // no breakpoints armed → run to terminal (depth 1)

    const {stackFrames} = session.stackTrace();
    expect(stackFrames).toHaveLength(1);
    expect(stackFrames[0]!.source?.path).toBe(CALLER_PATH);

    const stateRef = scopeRefsFor(session, stackFrames[0]!.id).ref('State');
    const {variables} = await session.variables(stateRef);
    const result = (variables as V[]).find((v) => v.name === 'result');
    expect(result).toBeDefined();
    expect(result!.value).toBe('43');
    expect(result!.type).toBe('uint256');
  });
});

// ---------------------------------------------------------------------------
// 4. Registry / per-step contract resolution (observable via source.path)
// ---------------------------------------------------------------------------

describe('mixed-CU registry — per-step contract resolution', () => {
  it('a depth-1 step resolves to src/Caller.sol; a depth-2 step to src/Callee.sol', async () => {
    const session = await mixedSession();

    // Entry step is depth-1 → Caller CU.
    expect(session.stackTrace().stackFrames[0]!.source?.path).toBe(CALLER_PATH);

    // Cross the external CALL: a depth-2 step must resolve to the Callee CU
    // (the single-contract limitation the registry fixes).
    continueIntoCallee(session);
    expect(session.stackTrace().stackFrames[0]!.source?.path).toBe(CALLEE_PATH);
  });

  it('reaches the breakpoint armed in src/Callee.sol at EVM depth 2', async () => {
    const session = await mixedSession();
    continueIntoCallee(session);
    // Two frames == EVM depth 2; a Callee-source breakpoint must land here, not
    // be ignored as a line-only match against the Caller source.
    expect(session.stackTrace().stackFrames).toHaveLength(2);
    expect(session.stackTrace().stackFrames[0]!.source?.path).toBe(CALLEE_PATH);
  });
});

// ---------------------------------------------------------------------------
// 5. Back-compat — the new `buildInfos` array works for a single CU
// ---------------------------------------------------------------------------

describe('mixed-CU launch — single-CU back-compat via buildInfos', () => {
  const COUNTER_TRACE_RAW = readFileSync(
    new URL('./fixtures/counter-setNumber-trace.raw.json', import.meta.url),
    'utf8',
  );
  const COUNTER_JSON: unknown = JSON.parse(
    readFileSync(
      new URL('../../solc/test/fixtures/counter-build-info.json', import.meta.url),
      'utf8',
    ),
  );
  const COUNTER_META = JSON.parse(
    readFileSync(
      new URL('./fixtures/counter-setNumber-meta.json', import.meta.url),
      'utf8',
    ),
  ) as {contractAddress: string};

  it('launches a single-CU trace through buildInfos:[one] and reads a State var', async () => {
    const session = new SolidityDebugSession();
    await session.launch({
      buildInfos: [COUNTER_JSON],
      traceJson: COUNTER_TRACE_RAW,
      sourcePath: 'src/Counter.sol',
      contractName: 'Counter',
      methodName: 'setNumber',
      codeAddress: COUNTER_META.contractAddress,
    } as LaunchInputs);

    await session.continue(); // run to terminal (setNumber(42) committed)
    const frameId = session.stackTrace().stackFrames[0]!.id;
    const stateRef = scopeRefsFor(session, frameId).ref('State');
    const {variables} = await session.variables(stateRef);
    const number = (variables as V[]).find((v) => v.name === 'number');
    expect(number).toBeDefined();
    expect(number!.value).toBe('42');
  });
});

// ---------------------------------------------------------------------------
// 6. Registry robustness — settings-aware CBOR is order-independent
// ---------------------------------------------------------------------------

// Both fixture build-infos define BOTH `Caller` and `Callee` (the callee CU is
// a superset), differing only by optimizer settings. So resolution CANNOT be by
// contract name / array order — it must key off the settings-specific CBOR
// metadata trailer. These tests reverse the `buildInfos` order to prove the
// entry still resolves to the UNOPTIMIZED Caller CU (Locals present) and the
// depth-2 frame to the OPTIMIZED Callee CU (Locals absent) regardless of order.
describe('mixed-CU registry — settings-aware CBOR is order-independent', () => {
  function reversedInputs(): LaunchInputs {
    return {
      buildInfos: [CALLEE_OPT_JSON, CALLER_UNOPT_JSON], // reversed order
      traceJson: MIXED_TRACE_RAW,
      sourcePath: CALLER_PATH,
      contractName: 'Caller',
      methodName: 'go',
      codeAddress: MIXED_META.callerAddress,
    } as LaunchInputs;
  }

  it('entry resolves to the UNOPTIMIZED Caller even when its CU is listed last', async () => {
    const session = new SolidityDebugSession();
    await session.launch(reversedInputs());

    const {stackFrames} = session.stackTrace();
    expect(stackFrames).toHaveLength(1);
    expect(stackFrames[0]!.source?.path).toBe(CALLER_PATH);
    // Unoptimized ⇒ Locals present. If resolution were name/order-based it would
    // pick the OPTIMIZED Caller in the first CU and drop Locals.
    // A read-only `Events` scope is appended on every frame.
    expect(scopeRefsFor(session, stackFrames[0]!.id).names).toEqual([
      'Locals',
      'State',
      'Globals',
      'Events',
      'EVM',
    ]);
  });

  it('depth-2 resolves to the OPTIMIZED Callee regardless of CU order', async () => {
    const session = new SolidityDebugSession();
    await session.launch(reversedInputs());
    continueIntoCallee(session);

    const {stackFrames} = session.stackTrace();
    expect(stackFrames).toHaveLength(2);
    expect(stackFrames[0]!.source?.path).toBe(CALLEE_PATH);
    // Optimized ⇒ NO Locals. A read-only `Events` scope is appended
    // (independent of the optimized no-Locals fallback).
    expect(scopeRefsFor(session, stackFrames[0]!.id).names).toEqual([
      'State',
      'Globals',
      'Events',
      'EVM',
    ]);
  });
});
