/**
 * Stepping engine + breakpoints.
 *
 * Drives interactive stepping (`next`/`stepIn`/`stepOut`/`stepBack`/`stepOver`
 * via `next`, `stepInstruction`/`stepBackInstruction`), source-line breakpoints
 * (`setBreakpoints` + `continue`/`reverseContinue`), and the DAP
 * `configurationDone` handshake — in-memory against a REAL recorded
 * `Stepper.run(10)` trace (339 steps).
 *
 * `run(10)` computes: a = 11, b = double(11) = 22, total = 33. The internal
 * `double()` call is a Solidity JUMP at constant EVM depth, so stepping relies
 * on COMBINED depth (EVM depth + jump depth) to enter/skip/leave it.
 *
 * Every step-transition assertion below is CONFIRMED against the real trace:
 *   statement-start steps of run(10) are exactly
 *     113 (line 8, ENTRY) → 175 (line 9) → 182 (line 14, inside double)
 *     → 266 (line 9, back in run) → 269 (line 10); terminal step = 338.
 *
 * These exercise the stepping methods (`configurationDone`, `next`, `stepIn`,
 * `stepOut`, `stepBack`, `stepInstruction`, `stepBackInstruction`, `continue`,
 * `reverseContinue`, `setBreakpoints`) and the `currentStepIndex` accessor on
 * `SolidityDebugSession`, with `launch` positioned at the entry statement.
 */
import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {SolidityDebugSession, type LaunchInputs} from '../src/index.js';

// ---------------------------------------------------------------------------
// Fixtures + LaunchInputs helper
// ---------------------------------------------------------------------------

/** Raw `debug_traceTransaction` JSON-RPC response STRING — parsed by launch. */
const TRACE_RAW = readFileSync(
  new URL('./fixtures/stepper-run-trace.raw.json', import.meta.url),
  'utf8',
);

/** solc standard-json build-info for the unoptimized Stepper (solc 0.8.35). */
const BUILD_INFO_JSON: unknown = JSON.parse(
  readFileSync(
    new URL('../../solc/test/fixtures/stepper-build-info.json', import.meta.url),
    'utf8',
  ),
);

/** Recorded meta: the running contract address, calldata, terminal storage. */
const META = JSON.parse(
  readFileSync(
    new URL('./fixtures/stepper-run-meta.json', import.meta.url),
    'utf8',
  ),
) as {contractAddress: string};

const CODE_ADDRESS = META.contractAddress;

/** Build the `LaunchInputs` the whole suite drives against. */
function stepperInputs(): LaunchInputs {
  return {
    buildInfoJson: BUILD_INFO_JSON,
    traceJson: TRACE_RAW,
    sourcePath: 'src/Stepper.sol',
    contractName: 'Stepper',
    methodName: 'run',
    codeAddress: CODE_ADDRESS,
  };
}

/** Launch a fresh, entry-positioned Stepper session. */
async function launchedStepper(): Promise<SolidityDebugSession> {
  const session = new SolidityDebugSession();
  await session.launch(stepperInputs());
  return session;
}

/** Shape of a queued DAP `stopped` event. */
interface StoppedEvent {
  event: 'stopped';
  body: {reason: string; threadId: number};
}

/** The most recently queued `stopped` event, or `undefined`. */
function lastStopped(session: SolidityDebugSession): StoppedEvent | undefined {
  const stopped = session.events.filter((e) => e.event === 'stopped');
  return stopped[stopped.length - 1] as StoppedEvent | undefined;
}

/** The current source line, via the single stack frame. */
function currentLine(session: SolidityDebugSession): number {
  return session.stackTrace().stackFrames[0]!.line;
}

// The confirmed step indices behind the source lines (used for the exact
// step-index assertions below — see file header for the ground-truth table).
const ENTRY = 113; //  line 8  `uint256 a = x + 1`
const LINE9 = 175; //  line 9  `uint256 b = double(a)`
const LINE14 = 182; // line 14 `return v * 2`  (inside double)
const BACK9 = 266; //  line 9  back in run (assign b)
const LINE10 = 269; // line 10 `total = a + b`
const TERMINAL = 338;

// ---------------------------------------------------------------------------
// 1. launch → entry stop at the first executable statement (line 8)
// ---------------------------------------------------------------------------

describe('launch (Stepper) stops at the entry statement', () => {
  it('positions at line 8 and queues stopped reason "entry"', async () => {
    const session = await launchedStepper();

    expect(currentLine(session)).toBe(8);
    expect(session.currentStepIndex).toBe(ENTRY);

    const stopped = lastStopped(session);
    expect(stopped).toBeDefined();
    expect(stopped!.body.reason).toBe('entry');
    expect(stopped!.body.threadId).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. next / stepIn / stepOut / stepBack / stepOver transitions
// ---------------------------------------------------------------------------

describe('statement stepping transitions', () => {
  it('next from entry (line 8) → line 9', async () => {
    const session = await launchedStepper();

    await session.next();

    expect(currentLine(session)).toBe(9);
    expect(session.currentStepIndex).toBe(LINE9);
    expect(lastStopped(session)!.body.reason).toBe('step');
  });

  it('stepIn from line 9 → line 14 (enters double)', async () => {
    const session = await launchedStepper();
    await session.next(); // → line 9

    await session.stepIn();

    expect(currentLine(session)).toBe(14);
    expect(session.currentStepIndex).toBe(LINE14);
    expect(lastStopped(session)!.body.reason).toBe('step');
  });

  it('stepOut from line 14 → line 9 (back in run)', async () => {
    const session = await launchedStepper();
    await session.next(); // → line 9
    await session.stepIn(); // → line 14

    await session.stepOut();

    expect(currentLine(session)).toBe(9);
    expect(session.currentStepIndex).toBe(BACK9);
    expect(lastStopped(session)!.body.reason).toBe('step');
  });

  it('next from the returned-to line 9 → line 10', async () => {
    const session = await launchedStepper();
    await session.next(); // → line 9
    await session.stepIn(); // → line 14
    await session.stepOut(); // → line 9 (step 266)

    await session.next();

    expect(currentLine(session)).toBe(10);
    expect(session.currentStepIndex).toBe(LINE10);
    expect(lastStopped(session)!.body.reason).toBe('step');
  });

  it('stepOver from line 9 → line 10 (skips double entirely)', async () => {
    const session = await launchedStepper();
    await session.next(); // → line 9

    // stepOver is `next`: it must not descend into double() nor stop at the
    // same-statement return step 266 — it lands directly on line 10.
    await session.next();

    expect(currentLine(session)).toBe(10);
    expect(session.currentStepIndex).toBe(LINE10);
    expect(lastStopped(session)!.body.reason).toBe('step');
  });

  it('next past the last statement (line 10) falls through to the terminal', async () => {
    const session = await launchedStepper();
    await session.next(); // → line 9 (175)
    await session.next(); // → line 10 (269), skipping double

    // No later statement-start exists, so the model targets the terminal step.
    await session.next();

    expect(session.currentStepIndex).toBe(TERMINAL);
    expect(lastStopped(session)!.body.reason).toBe('step');
  });

  it('stepBack from line 10 → line 9, then → line 14', async () => {
    const session = await launchedStepper();
    // Reach line 10 (step 269) the long way so the reverse walk has history.
    await session.next(); // → line 9 (175)
    await session.stepIn(); // → line 14 (182)
    await session.stepOut(); // → line 9 (266)
    await session.next(); // → line 10 (269)

    await session.stepBack();
    expect(currentLine(session)).toBe(9);
    expect(session.currentStepIndex).toBe(BACK9);
    expect(lastStopped(session)!.body.reason).toBe('step');

    await session.stepBack();
    expect(currentLine(session)).toBe(14);
    expect(session.currentStepIndex).toBe(LINE14);
    expect(lastStopped(session)!.body.reason).toBe('step');
  });
});

// ---------------------------------------------------------------------------
// 3. setBreakpoints + continue
// ---------------------------------------------------------------------------

describe('breakpoints and continue', () => {
  it('setBreakpoints verifies every requested line as-is', async () => {
    const session = await launchedStepper();

    const result = session.setBreakpoints({
      source: {path: 'src/Stepper.sol'},
      breakpoints: [{line: 14}],
    });

    expect(result).toEqual({breakpoints: [{verified: true, line: 14}]});
  });

  it('continue from entry stops at a breakpoint on line 14', async () => {
    const session = await launchedStepper();
    session.setBreakpoints({
      source: {path: 'src/Stepper.sol'},
      breakpoints: [{line: 14}],
    });

    await session.continue();

    expect(currentLine(session)).toBe(14);
    expect(session.currentStepIndex).toBe(LINE14);
    expect(lastStopped(session)!.body.reason).toBe('breakpoint');
  });

  it('continue from entry stops at a breakpoint on line 10', async () => {
    const session = await launchedStepper();
    session.setBreakpoints({
      source: {path: 'src/Stepper.sol'},
      breakpoints: [{line: 10}],
    });

    await session.continue();

    expect(currentLine(session)).toBe(10);
    expect(session.currentStepIndex).toBe(LINE10);
    expect(lastStopped(session)!.body.reason).toBe('breakpoint');
  });

  it('continue to terminal reports reason "step" even if a breakpoint is on a non-statement line', async () => {
    // Regression: line 7 (`function run(...)`) is the terminal step's mapped
    // line but is NOT a statement start, so no step can ever "hit" it. continue
    // must fall through to the terminal and report 'step', not a false
    // 'breakpoint'.
    const session = await launchedStepper();
    session.setBreakpoints({
      source: {path: 'src/Stepper.sol'},
      breakpoints: [{line: 7}],
    });

    await session.continue();

    expect(session.currentStepIndex).toBe(TERMINAL);
    expect(lastStopped(session)!.body.reason).toBe('step');
  });

  it('continue with no breakpoints runs to the terminal (total === 33)', async () => {
    const session = await launchedStepper();

    await session.continue();

    // Terminal indicator: a frame is still returned and storage holds the
    // computed result total = 33.
    expect(session.currentStepIndex).toBe(TERMINAL);
    const {stackFrames} = session.stackTrace();
    expect(stackFrames).toHaveLength(1);

    const stateRef = session
      .scopes(stackFrames[0]!.id)
      .scopes.find((s) => s.name === 'State')!.variablesReference;
    const {variables} = await session.variables(stateRef);
    const total = variables.find((v) => v.name === 'total');
    expect(total?.value).toBe('33');
  });
});

// ---------------------------------------------------------------------------
// 4. reverseContinue
// ---------------------------------------------------------------------------

describe('reverseContinue', () => {
  it('from a later position stops at a breakpoint on line 8', async () => {
    const session = await launchedStepper();
    // Advance to line 10 (step 269) first.
    session.setBreakpoints({
      source: {path: 'src/Stepper.sol'},
      breakpoints: [{line: 10}],
    });
    await session.continue();
    expect(session.currentStepIndex).toBe(LINE10);

    // Now break on line 8 and reverse.
    session.setBreakpoints({
      source: {path: 'src/Stepper.sol'},
      breakpoints: [{line: 8}],
    });
    await session.reverseContinue();

    expect(currentLine(session)).toBe(8);
    expect(session.currentStepIndex).toBe(ENTRY);
    expect(lastStopped(session)!.body.reason).toBe('breakpoint');
  });
});

// ---------------------------------------------------------------------------
// 5. stepInstruction / stepBackInstruction (net ±1)
// ---------------------------------------------------------------------------

describe('instruction stepping is net ±1', () => {
  it('stepInstruction then stepBackInstruction returns to the same step', async () => {
    const session = await launchedStepper();
    const start = session.currentStepIndex;
    expect(start).toBe(ENTRY);

    await session.stepInstruction();
    expect(session.currentStepIndex).toBe(start + 1);

    await session.stepBackInstruction();
    expect(session.currentStepIndex).toBe(start);
    expect(currentLine(session)).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// 5b. instruction-GRANULARITY stepping (Disassembly View sends granularity)
// ---------------------------------------------------------------------------

describe('step requests honor instruction granularity', () => {
  it('next/stepIn/stepBack at instruction granularity move a single opcode', async () => {
    const session = await launchedStepper();
    const start = session.currentStepIndex;

    // A non-call opcode: instruction step-over == one step forward.
    session.next({granularity: 'instruction'});
    expect(session.currentStepIndex).toBe(start + 1);

    session.stepIn({granularity: 'instruction'});
    expect(session.currentStepIndex).toBe(start + 2);

    session.stepBack({granularity: 'instruction'});
    expect(session.currentStepIndex).toBe(start + 1);
  });

  it('next WITHOUT granularity still does statement stepping (→ line 9)', async () => {
    const session = await launchedStepper();
    session.next();
    expect(session.currentStepIndex).toBe(LINE9);
    expect(currentLine(session)).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// 5c. instruction breakpoints (Disassembly View)
// ---------------------------------------------------------------------------

describe('instruction breakpoints', () => {
  /** The packed (codeAddress, pc) address of the frame `steps` opcodes ahead. */
  async function refAhead(steps: number): Promise<string> {
    const probe = await launchedStepper();
    for (let i = 0; i < steps; i++) probe.stepInstruction();
    return probe.stackTrace().stackFrames[0]!.instructionPointerReference!;
  }

  it('verifies a decodable instructionReference and echoes it back', async () => {
    const session = await launchedStepper();
    const ref = await refAhead(2);

    const result = session.setInstructionBreakpoints({
      breakpoints: [{instructionReference: ref}],
    });

    expect(result.breakpoints).toHaveLength(1);
    expect(result.breakpoints[0]!.verified).toBe(true);
    expect(result.breakpoints[0]!.instructionReference).toBe(ref);
  });

  it('continue stops at an armed instruction breakpoint (reason "breakpoint")', async () => {
    const ref = await refAhead(2);
    const session = await launchedStepper();
    const start = session.currentStepIndex;
    session.setInstructionBreakpoints({breakpoints: [{instructionReference: ref}]});

    session.continue();

    // The pc two opcodes ahead is unique among (start, start+2], so continue
    // lands exactly there.
    expect(session.currentStepIndex).toBe(start + 2);
    expect(
      session.stackTrace().stackFrames[0]!.instructionPointerReference,
    ).toBe(ref);
    expect(lastStopped(session)!.body.reason).toBe('breakpoint');
  });

  it('a later empty setInstructionBreakpoints disarms them (continue runs on)', async () => {
    const ref = await refAhead(2);
    const session = await launchedStepper();
    session.setInstructionBreakpoints({breakpoints: [{instructionReference: ref}]});
    session.setInstructionBreakpoints({breakpoints: []});

    session.continue();

    expect(session.currentStepIndex).toBe(TERMINAL);
    expect(lastStopped(session)!.body.reason).toBe('step');
  });
});

// ---------------------------------------------------------------------------
// 6. configurationDone handshake
// ---------------------------------------------------------------------------

describe('configurationDone', () => {
  it('returns without throwing', async () => {
    const session = await launchedStepper();
    expect(() => session.configurationDone()).not.toThrow();
  });
});
