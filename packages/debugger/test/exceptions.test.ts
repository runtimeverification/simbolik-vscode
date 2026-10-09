/**
 * Exception analysis + revert-reason decoding over real kontrol-node traces.
 *
 * Fixture: `Exceptions.sol` (legacy pipeline), one transaction per scenario.
 * Ground truth read off the raw traces (step: op, depth → caller's success flag):
 *
 * - `mixed()` (1035 steps, tx fails):
 *   - 217 REVERT (depth 2) `Error("boom")` → flag 0 at 218, caught by try/catch
 *   - 522 REVERT (depth 2) `Panic(0x11)` → flag 0 at 523, caught
 *   - 625 INVALID (depth 2) → flag 0 at 626, `EVMC_INVALID_INSTRUCTION`, caught
 *   - 1022 REVERT (depth 2) `TooSmall(3, 10)` → flag 0 at 1023; the caller
 *     re-throws the same 0x44 bytes at 1034, the final step → uncaught
 * - `direct(3)` (235 steps): the entry function's own `require` REVERTs at 234
 *   (the final step) with `Error("x too small")` → uncaught.
 * - `assertion()` (206 steps): the `vm.assertEq` STATICCALL at 193 runs no code
 *   (kontrol executes cheatcodes atomically) and pushes flag 0 at 194 with
 *   `EVMC_REVERT`; the caller bubbles the cheatcode's raw message "assertion
 *   failed: 1 != 2" (24 bytes, not ABI-encoded) with REVERT at 205 → uncaught.
 * - `expected()` (269 steps, tx succeeds): `vm.expectRevert()` (a successful
 *   cheatcode CALL at 65), then `boom()` REVERTs at 249 but the caller sees flag
 *   1 at 250 — an expected revert.
 */
import type {DebugProtocol} from '@vscode/debugprotocol';
import {describe, expect, it} from 'vitest';

import {describeException, findExceptions} from '../src/exceptions.js';
import {DapDispatcher, SolidityDebugSession} from '../src/index.js';
import {decodeRevertData, errorsBySelector} from '../src/revertData.js';
import {
  cursorFor,
  launch,
  line,
  stepToLine,
  type Spec,
} from './support/harness.js';

const trace = (fn: string) =>
  cursorFor(`exceptions-legacy-${fn}-trace.raw.json`);

const exceptionsOf = (fn: string) => {
  const {steps, cursor} = trace(fn);
  return findExceptions(steps, cursor);
};

const ERROR_BOOM =
  '0x08c379a0' +
  '0000000000000000000000000000000000000000000000000000000000000020' +
  '0000000000000000000000000000000000000000000000000000000000000004' +
  '626f6f6d00000000000000000000000000000000000000000000000000000000';
const PANIC_OVERFLOW =
  '0x4e487b71' +
  '0000000000000000000000000000000000000000000000000000000000000011';
const TOO_SMALL =
  '0xe94fe3af' +
  '0000000000000000000000000000000000000000000000000000000000000003' +
  '000000000000000000000000000000000000000000000000000000000000000a';

describe('findExceptions', () => {
  it('mixed(): three caught origins, then the uncaught one re-thrown by the caller', () => {
    expect(exceptionsOf('mixed')).toEqual([
      {
        step: 217,
        stop: 217,
        kind: 'revert',
        data: ERROR_BOOM,
        status: undefined,
        cheatcode: false,
        caught: true,
        expected: false,
        rethrows: [],
      },
      {
        step: 522,
        stop: 522,
        kind: 'revert',
        data: PANIC_OVERFLOW,
        status: undefined,
        cheatcode: false,
        caught: true,
        expected: false,
        rethrows: [],
      },
      {
        step: 625,
        stop: 625,
        kind: 'invalid',
        data: '0x',
        status: 'EVMC_INVALID_INSTRUCTION',
        cheatcode: false,
        caught: true,
        expected: false,
        rethrows: [],
      },
      {
        step: 1022,
        stop: 1022,
        kind: 'revert',
        data: TOO_SMALL,
        status: undefined,
        cheatcode: false,
        caught: false,
        expected: false,
        rethrows: [1034],
      },
    ]);
  });

  it('direct(): a revert in the entry function itself is uncaught', () => {
    const [e, ...rest] = exceptionsOf('direct');
    expect(rest).toEqual([]);
    expect(e).toMatchObject({step: 234, kind: 'revert', caught: false});
    expect(decodeRevertData(e!.data!, new Map()).summary).toBe(
      'Error("x too small")'
    );
  });

  it('assertion(): a failing cheatcode originates at its call; the bubbled message is its data', () => {
    const [e, ...rest] = exceptionsOf('assertion');
    expect(rest).toEqual([]);
    expect(e).toEqual({
      step: 193,
      stop: 193,
      kind: 'call',
      data: '0x' + Buffer.from('assertion failed: 1 != 2').toString('hex'),
      status: 'EVMC_REVERT',
      cheatcode: true,
      caught: false,
      expected: false,
      rethrows: [205],
    });
  });

  it('expected(): a revert vm.expectRevert turned into success is expected and caught', () => {
    const [e, ...rest] = exceptionsOf('expected');
    expect(rest).toEqual([]);
    expect(e).toMatchObject({
      step: 249,
      stop: 249,
      kind: 'revert',
      data: ERROR_BOOM,
      caught: true,
      expected: true,
    });
  });

  it('a successful transaction with no failing call has no exceptions', () => {
    const {steps, cursor} = cursorFor('counter-setNumber-trace.raw.json');
    expect(findExceptions(steps, cursor)).toEqual([]);
  });

  it('a caught revert whose caller carries on is not re-thrown (RevertStep)', () => {
    const {steps, cursor} = cursorFor('revertstep-run-trace.raw.json');
    expect(findExceptions(steps, cursor)).toMatchObject([
      {step: 292, kind: 'revert', caught: true, rethrows: []},
    ]);
  });
});

// Synthetic traces for shapes the recordings do not cover. A stack lists its
// top LAST; a REVERT's top two words are offset, then size.
describe('findExceptions: synthetic traces', () => {
  const step = (op: string, depth: number, stack: string[] = []) =>
    ({op, depth, stack, statusCode: 'EVMC_SUCCESS', codeAddress: 1n}) as never;
  const word = (hex: string) => hex.padEnd(64, '0');
  /** A cursor whose memory at step `i` is `memory[i]` (default: none recorded). */
  const cursor = (memory: Record<number, string[]> = {}) =>
    ({at: (i: number) => ({memory: memory[i] ?? []})}) as never;
  const find = (steps: never[], memory?: Record<number, string[]>) =>
    findExceptions(steps, cursor(memory));

  it('a REVERT with an impossible size does not throw, and its data is unknown', () => {
    const [e] = find([
      step('PUSH1', 1),
      step('REVERT', 1, ['0xffffffffff', '0x0']),
    ]);
    expect(e).toMatchObject({kind: 'revert', data: undefined, caught: false});
    expect(describeException(e!, [], cursor(), new Map()).message).toBe(
      'reverted (the trace does not record the revert data)'
    );
  });

  it('a trace without memory (geth) does not make up revert data', () => {
    const [e] = find([step('PUSH1', 1), step('REVERT', 1, ['0x64', '0x0'])]);
    expect(e!.data).toBeUndefined();
  });

  it('vm.expectRevert catching a revert re-thrown by a wrapper marks the origin expected', () => {
    const steps = [
      step('CALL', 1), // test → wrapper
      step('CALL', 2), // wrapper → token
      step('REVERT', 3, ['0x4', '0x0']), // token reverts: the origin
      step('RETURNDATACOPY', 2, ['0x0']), // wrapper bubbles it…
      step('REVERT', 2, ['0x4', '0x0']), // …with the same bytes
      step('STOP', 1, ['0x1']), // test sees success
    ];
    const data = {2: [word('41424344')], 4: [word('41424344')]};
    expect(find(steps, data)).toMatchObject([
      {step: 2, expected: true, caught: true, rethrows: [4]},
    ]);
  });

  it('a caller reverting with its own reason after a halt raises a new exception', () => {
    const steps = [
      step('CALL', 1),
      step('JUMP', 2), // the callee halts (bad jump)
      step('ISZERO', 1, ['0x0']),
      step('REVERT', 1, ['0x4', '0x0']), // catch { revert("…") }: no RETURNDATACOPY
    ];
    expect(find(steps, {3: [word('41424344')]})).toMatchObject([
      {step: 1, kind: 'halt', data: '0x', caught: true},
      {step: 3, kind: 'revert', data: '0x41424344', caught: false},
    ]);
  });

  it('a later, unrelated revert is not a re-throw of a handled atomic failure', () => {
    const steps = [
      step('CALL', 1),
      step('POP', 1, ['0x0']), // the call failed; the result is checked…
      step('SSTORE', 1),
      step('REVERT', 1, ['0x4', '0x0']), // …then an unrelated revert
    ];
    expect(find(steps, {3: [word('41424344')]})).toMatchObject([
      {step: 0, kind: 'call', caught: true, rethrows: []},
      {step: 3, kind: 'revert', caught: false},
    ]);
  });
});

describe('decodeRevertData', () => {
  const errors = errorsBySelector([
    {
      name: 'TooSmall',
      signature: 'TooSmall(uint256,uint256)',
      selector: '0xe94fe3af',
      params: [
        {name: 'got', solcType: 't_uint256', typeLabel: 'uint256'},
        {name: 'min', solcType: 't_uint256', typeLabel: 'uint256'},
      ],
    },
  ]);

  it('Error(string)', () => {
    expect(decodeRevertData(ERROR_BOOM, errors)).toEqual({
      id: 'Error',
      message: 'boom',
      summary: 'Error("boom")',
      signature: 'Error(string)',
    });
  });

  it('Panic(uint256) with the compiler panic code explained', () => {
    expect(decodeRevertData(PANIC_OVERFLOW, errors)).toEqual({
      id: 'Panic',
      message: '0x11: arithmetic underflow or overflow',
      summary: 'Panic(0x11: arithmetic underflow or overflow)',
      signature: 'Panic(uint256)',
    });
  });

  it('a custom error with named arguments', () => {
    expect(decodeRevertData(TOO_SMALL, errors)).toEqual({
      id: 'TooSmall',
      message: 'TooSmall(got: 3, min: 10)',
      summary: 'TooSmall(got: 3, min: 10)',
      signature: 'TooSmall(uint256,uint256)',
    });
  });

  it('empty revert data', () => {
    expect(decodeRevertData('0x', errors)).toMatchObject({
      id: 'Revert',
      message: 'reverted without a reason',
    });
  });

  it('a raw UTF-8 message (kontrol cheatcode failure)', () => {
    const data = '0x' + Buffer.from('assertion failed: 1 != 2').toString('hex');
    expect(decodeRevertData(data, errors)).toEqual({
      id: 'Revert',
      message: 'assertion failed: 1 != 2',
      summary: 'assertion failed: 1 != 2',
    });
  });

  it('locates arguments after a static array', () => {
    const e = errorsBySelector([
      {
        name: 'E',
        signature: 'E(uint256[2],uint256)',
        selector: '0x12345678',
        params: [
          {name: 'a', solcType: 't_array(t_uint256)2', typeLabel: 'uint256[2]'},
          {name: 'b', solcType: 't_uint256', typeLabel: 'uint256'},
        ],
      },
    ]);
    const w = (n: number) => n.toString(16).padStart(64, '0');
    expect(decodeRevertData('0x12345678' + w(1) + w(2) + w(3), e).summary).toBe(
      'E(a: <uint256[2]>, b: 3)'
    );
  });

  it('an out-of-range panic code', () => {
    expect(
      decodeRevertData('0x4e487b71' + '0'.repeat(62) + 'ff', new Map()).message
    ).toBe('0xff: unknown panic code');
  });

  it('an unknown selector falls back to hex', () => {
    expect(decodeRevertData('0xdeadbeef00', errors).message).toBe(
      'unrecognized revert data 0xdeadbeef00 (5 bytes)'
    );
  });
});

// ## Session: exception filters, stops, `exceptionInfo`, and the launch notice.
// Source lines (src/Exceptions.sol): boom's revert 15, overflow 19, invalid()
// 24, check's `revert TooSmall` 30; mixed(): try-boom 48, try-overflow 49,
// try-invalidOp 50, `reached = 1` 51, `t.check(3)` 52; direct(): the
// `require` 59; assertion(): `vm.assertEq` 65; expected(): `t.boom()` 71.

const spec = (fn: string): Spec => ({
  buildInfo: 'exceptions-legacy-build-info.json',
  trace: `exceptions-legacy-${fn}-trace.raw.json`,
  meta: `exceptions-legacy-${fn}-meta.json`,
  sourcePath: 'src/Exceptions.sol',
  contractName: 'Exceptions',
  methodName: fn,
});

async function launchWith(
  fn: string,
  filters: string[]
): Promise<SolidityDebugSession> {
  const s = await launch(spec(fn));
  s.setExceptionBreakpoints({filters});
  return s;
}

const UNCAUGHT = ['break-on-uncaught-revert'];
const ALL = ['break-on-revert'];

const lastStop = (s: SolidityDebugSession) =>
  s.events.at(-1) as DebugProtocol.StoppedEvent;

describe('session: exception filters', () => {
  it('advertises exceptionInfo and the two exception filters, uncaught on by default', () => {
    const caps = new SolidityDebugSession().initialize();
    expect(caps.supportsExceptionInfoRequest).toBe(true);
    const filters = caps.exceptionBreakpointFilters!;
    expect(filters.slice(0, 2)).toEqual([
      expect.objectContaining({
        filter: 'break-on-uncaught-revert',
        label: 'Uncaught Reverts',
        default: true,
      }),
      expect.objectContaining({
        filter: 'break-on-revert',
        label: 'All Reverts',
        default: false,
      }),
    ]);
  });

  it('Uncaught Reverts: continue stops where the failing revert originates', async () => {
    const s = await launchWith('mixed', UNCAUGHT);
    s.continue();
    expect(s.currentStepIndex).toBe(1022);
    expect(line(s)).toBe(30);
    expect(lastStop(s).body).toEqual({
      reason: 'exception',
      threadId: 1,
      allThreadsStopped: true,
      description: 'Paused on uncaught exception',
      text: 'TooSmall',
    });
  });

  it('All Reverts: continue visits every origin — never the re-throwing REVERT', async () => {
    const s = await launchWith('mixed', ALL);
    const visited: [number, number | undefined, string][] = [];
    for (let k = 0; k < 5; k++) {
      s.continue();
      visited.push([s.currentStepIndex, line(s), lastStop(s).body.reason]);
    }
    expect(visited).toEqual([
      [217, 15, 'exception'],
      [464, 19, 'exception'], // before the panic helper (see below)
      [625, 24, 'exception'],
      [1022, 30, 'exception'],
      [1034, 52, 'step'], // the terminal step: the caller's re-throw is no stop
    ]);
  });

  it('with no exception filter, continue runs to the end', async () => {
    const s = await launchWith('mixed', []);
    s.continue();
    expect(s.currentStepIndex).toBe(1034);
    expect(lastStop(s).body.reason).toBe('step');
  });

  it('reverse-continue stops at exception origins too', async () => {
    const s = await launchWith('mixed', ALL);
    s.seekStep(1034);
    s.reverseContinue();
    expect(s.currentStepIndex).toBe(1022);
    expect(lastStop(s).body.reason).toBe('exception');
  });

  it('stepping over the failing call stops at the failure instead of ending the session', async () => {
    const s = await launchWith('mixed', UNCAUGHT);
    stepToLine(s, 52);
    s.next();
    expect(s.currentStepIndex).toBe(1022);
    expect(lastStop(s).body.reason).toBe('exception');
    expect(s.events.some(e => e.event === 'terminated')).toBe(false);
  });

  it('stepping over a caught revert only stops there with All Reverts', async () => {
    const quiet = await launchWith('mixed', UNCAUGHT);
    quiet.next(); // line 48 → 49 over the caught Error("boom")
    expect(line(quiet)).toBe(49);

    const all = await launchWith('mixed', ALL);
    all.next();
    expect(all.currentStepIndex).toBe(217);
    expect(lastStop(all).body.reason).toBe('exception');
  });

  it('an uncaught revert on the final step stops, then the next step ends the session', async () => {
    const s = await launchWith('direct', UNCAUGHT);
    stepToLine(s, 59);
    s.next();
    expect(s.currentStepIndex).toBe(234);
    expect(lastStop(s).body.reason).toBe('exception');
    s.continue(); // already at the end: no second exception stop
    expect(lastStop(s).body.reason).toBe('step');
  });

  it('an expected revert is not uncaught', async () => {
    const s = await launchWith('expected', UNCAUGHT);
    s.continue();
    expect(s.currentStepIndex).toBe(268);
    expect(lastStop(s).body.reason).toBe('step');
  });
});

// viaIR reverts from shared Yul helpers (`revert_error_…`, `panic_error_…`)
// that solc maps to the whole contract. Stopping at their REVERT would show the
// contract header (and name the frame after the contract), so the stop moves
// back to the last step of the same frame that belongs to a statement. Ground truth
// from the viaIR recordings: direct()'s REVERT at 307 maps to `contract
// Exceptions` (line 35); the require's last own step is 227 (line 59). mixed()'s
// Panic REVERT at 701 maps to `contract Thrower` (line 11); the overflowing
// `return` is last seen at 659 (line 19).
describe('session: exceptions raised from viaIR helpers', () => {
  const viaIR = async (fn: string, filters: string[]) => {
    const s = await launch({
      ...spec(fn),
      buildInfo: 'exceptions-viair-build-info.json',
      trace: `exceptions-viair-${fn}-trace.raw.json`,
      meta: `exceptions-viair-${fn}-meta.json`,
    });
    s.setExceptionBreakpoints({filters});
    return s;
  };
  const frames = (s: SolidityDebugSession) =>
    s.stackTrace().stackFrames.map(f => `${f.name}:${f.line}`);

  it('a failing require stops on the require line, not the contract header', async () => {
    const s = await viaIR('direct', UNCAUGHT);
    s.continue();
    expect(s.currentStepIndex).toBe(227);
    expect(frames(s)).toEqual(['direct:59']);
    expect(s.exceptionInfo()).toMatchObject({
      exceptionId: 'Error',
      description: 'x too small',
      details: {stackTrace: '    at direct (src/Exceptions.sol:59)'},
    });
  });

  it('stepping over the require stops there too', async () => {
    const s = await viaIR('direct', UNCAUGHT);
    stepToLine(s, 59);
    s.next();
    expect(frames(s)).toEqual(['direct:59']);
    expect(lastStop(s).body.reason).toBe('exception');
  });

  it('a panic stops on the overflowing expression', async () => {
    const s = await viaIR('mixed', ALL);
    s.continue(); // Error("boom")
    s.continue();
    expect(s.currentStepIndex).toBe(659);
    expect(frames(s)).toEqual(['overflow:19', 'mixed:49']);
    expect(s.exceptionInfo().exceptionId).toBe('Panic');
  });

  it('the launch notice points at the require', async () => {
    const s = await viaIR('direct', []);
    expect((s.events[0] as DebugProtocol.OutputEvent).body.output).toBe(
      'The transaction failed: Error("x too small")\n' +
        '    at direct (src/Exceptions.sol:59)\n'
    );
  });

  it('continuing past a shown exception does not stop at it again', async () => {
    const s = await viaIR('direct', ALL);
    s.continue();
    s.continue();
    expect(s.currentStepIndex).toBe(307);
    expect(lastStop(s).body.reason).toBe('step');
  });
});

describe('session: exceptionInfo', () => {
  it('describes a custom error with its signature and stack', async () => {
    const s = await launchWith('mixed', UNCAUGHT);
    s.continue();
    expect(s.exceptionInfo()).toEqual({
      exceptionId: 'TooSmall',
      description: 'TooSmall(got: 3, min: 10)',
      breakMode: 'unhandled',
      details: {
        message: 'TooSmall(got: 3, min: 10)',
        typeName: 'TooSmall(uint256,uint256)',
        stackTrace:
          '    at check (src/Exceptions.sol:30)\n' +
          '    at mixed (src/Exceptions.sol:52)',
      },
    });
  });

  it('a caught exception breaks "always"', async () => {
    const s = await launchWith('mixed', ALL);
    s.continue();
    expect(s.exceptionInfo()).toMatchObject({
      exceptionId: 'Error',
      description: 'boom',
      breakMode: 'always',
    });
    s.continue();
    expect(s.exceptionInfo()).toMatchObject({
      exceptionId: 'Panic',
      description: '0x11: arithmetic underflow or overflow',
    });
    s.continue();
    expect(s.exceptionInfo()).toMatchObject({
      exceptionId: 'InvalidInstruction',
    });
  });

  it('names the failing cheatcode and shows its message', async () => {
    const s = await launchWith('assertion', UNCAUGHT);
    s.continue();
    expect(s.currentStepIndex).toBe(193);
    expect(line(s)).toBe(65);
    expect(s.exceptionInfo()).toMatchObject({
      exceptionId: 'vm.assertEq',
      description: 'assertion failed: 1 != 2',
      breakMode: 'unhandled',
    });
  });

  it('marks a revert vm.expectRevert expected', async () => {
    const s = await launchWith('expected', ALL);
    s.continue();
    expect(s.currentStepIndex).toBe(249);
    expect(s.exceptionInfo().description).toBe(
      'boom (expected by vm.expectRevert)'
    );
  });

  it('fails when not paused at an exception', async () => {
    const s = await launchWith('mixed', ALL);
    expect(() => s.exceptionInfo()).toThrow('not paused at an exception');
  });
});

describe('session: launch notice', () => {
  it('reports why a failed transaction failed on stderr, before the entry stop', async () => {
    const s = await launch(spec('direct'));
    expect(s.events.map(e => [e.event, e.body])).toEqual([
      [
        'output',
        {
          category: 'stderr',
          output:
            'The transaction failed: Error("x too small")\n' +
            '    at direct (src/Exceptions.sol:59)\n',
        },
      ],
      ['stopped', {reason: 'entry', threadId: 1, allThreadsStopped: true}],
    ]);
  });

  it('is silent for a successful transaction', async () => {
    const s = await launch(spec('expected'));
    expect(s.events.map(e => e.event)).toEqual(['stopped']);
  });
});

describe('dispatcher: exceptionInfo', () => {
  it('routes the request to the session', async () => {
    const dispatcher = new DapDispatcher(async () => {
      const s = await launch(spec('mixed'));
      s.setExceptionBreakpoints({filters: UNCAUGHT});
      return s;
    });
    let seq = 1;
    const send = (command: string, args?: unknown) =>
      dispatcher.handle({
        seq: seq++,
        type: 'request',
        command,
        arguments: args,
      } as DebugProtocol.Request);
    await send('initialize');
    await send('launch', {});
    await send('continue', {threadId: 1});
    const [response] = await send('exceptionInfo', {threadId: 1});
    expect(response).toMatchObject({
      success: true,
      command: 'exceptionInfo',
      body: {exceptionId: 'TooSmall', breakMode: 'unhandled'},
    });
  });
});
