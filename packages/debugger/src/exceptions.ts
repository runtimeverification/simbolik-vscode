/**
 * Find where exceptions ORIGINATE in a recorded trace, and whether the
 * transaction survived them.
 *
 * A call fails in one of four ways: its frame executes REVERT, executes the
 * designated INVALID instruction, halts exceptionally (out of gas, bad jump,
 * stack underflow, …), or — for a call that runs no code of its own, like a
 * kontrol-node cheatcode (`vm.assertEq`) or a transfer with too little balance —
 * the call itself fails atomically. The caller learns of it from the success
 * flag the CALL pushes, which is the top of the stack at the step after the
 * callee returns.
 *
 * A failure that a caller merely passes on is not a new exception: Solidity
 * bubbles a failed call's revert data up by copying it (RETURNDATACOPY) and
 * REVERTing with the same bytes. Such a REVERT is recorded as a RETHROW of the
 * original exception, so every exception is reported once, at the instruction
 * that caused it. An exception is CAUGHT
 * when a caller carries on (try/catch, a low-level call whose result is
 * checked, …) and UNCAUGHT when it reaches the top frame and fails the
 * transaction. `vm.expectRevert` turns an expected revert into a success, which
 * the caller sees as a success flag of 1 despite the callee's REVERT.
 */
import type {StateCursor, Step} from '@simbolik/lifting';

import type {ErrorInfo} from '@simbolik/solc';

import {decodeCheatcodeCall, isCheatcodeCall} from './cheatcodes.js';
import {strip0x} from './hex.js';
import {decodeRevertData, type RevertReason} from './revertData.js';

/** How an exception originated. */
export type ExceptionKind = 'revert' | 'invalid' | 'halt' | 'call';

/** One exception, positioned where it originates. */
export interface TraceException {
  /** The trace step that raises it: the REVERT/INVALID/halting op or the failed call. */
  step: number;
  /**
   * Where the debugger stops to show it: {@link step}, or — when that step has
   * no statement of its own — the last step before it, in the same call frame,
   * that does (see {@link placeExceptions}). Initially {@link step}.
   */
  stop: number;
  kind: ExceptionKind;
  /**
   * The revert data (`0x`-prefixed hex; `'0x'` for an INVALID or exceptional
   * halt, which return nothing), or `undefined` when the trace does not show
   * it: an atomic call's data is only visible once a caller re-throws it, and a
   * geth/anvil trace records no memory to read a REVERT's data from.
   */
  data: string | undefined;
  /** The engine's status for the failed call (kontrol `EVMC_*`), when reported. */
  status: string | undefined;
  /** Whether the failing call targeted the cheatcode address. */
  cheatcode: boolean;
  /** `false` when it propagated out of the top frame and failed the transaction. */
  caught: boolean;
  /** Turned into a success by `vm.expectRevert`. */
  expected: boolean;
  /** The REVERT steps of callers that re-threw it, innermost first. */
  rethrows: number[];
}

const CALL_OPS = new Set([
  'CALL',
  'CALLCODE',
  'DELEGATECALL',
  'STATICCALL',
  'CREATE',
  'CREATE2',
]);

/** Ops that end a call successfully (anything else ending a frame is a halt). */
const NORMAL_EXITS = new Set(['RETURN', 'STOP', 'SELFDESTRUCT']);

/** A call frame still executing during the scan. */
interface OpenFrame {
  /** The exception of this frame's most recent call, if that call failed. */
  lastFailure: TraceException | undefined;
  /** Whether the frame ran RETURNDATACOPY since `lastFailure` returned. */
  copied: boolean;
}

/** Memory is addressed by numbers; anything beyond this cannot be real data. */
const MAX_REVERT_BYTES = 1 << 20;

/** Every exception in the trace, in step order. */
export function findExceptions(
  steps: readonly Step[],
  cursor: StateCursor
): TraceException[] {
  const found: TraceException[] = [];
  const frames: OpenFrame[] = [{lastFailure: undefined, copied: false}];

  const raise = (e: Omit<TraceException, 'stop' | 'caught' | 'rethrows'>) => {
    const exception = {...e, stop: e.step, caught: true, rethrows: []};
    found.push(exception);
    return exception;
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const next = steps[i + 1];
    if (next !== undefined && next.depth > step.depth) {
      frames.push({lastFailure: undefined, copied: false});
      continue;
    }
    if (step.op === 'RETURNDATACOPY') frames.at(-1)!.copied = true;
    if (next === undefined || next.depth < step.depth) {
      // The frame ends here. The top frame has no caller to report success, so
      // its exit op alone decides.
      const frame = frames.pop() ?? {lastFailure: undefined, copied: false};
      const failed =
        next === undefined ? !NORMAL_EXITS.has(step.op) : !succeeded(next);
      const faulty = step.op === 'REVERT' || step.op === 'INVALID';
      let exception: TraceException | undefined;
      if (failed || faulty) {
        const kind: ExceptionKind =
          step.op === 'REVERT'
            ? 'revert'
            : step.op === 'INVALID'
              ? 'invalid'
              : 'halt';
        const data = kind === 'revert' ? revertData(step, cursor, i) : '0x';
        // A re-throw copies the failed call's return data and reverts with it.
        // Data the trace does not show on either side cannot contradict it.
        const prior = frame.lastFailure;
        if (
          kind === 'revert' &&
          prior !== undefined &&
          frame.copied &&
          (prior.data === undefined ||
            data === undefined ||
            prior.data === data)
        ) {
          prior.rethrows.push(i);
          prior.data ??= data;
          // vm.expectRevert may catch it several frames up from its origin.
          if (!failed) prior.expected = true;
          exception = prior;
        } else {
          exception = raise({
            step: i,
            kind,
            data,
            status: kind === 'revert' ? undefined : statusOf(next),
            cheatcode: false,
            expected: !failed,
          });
        }
      }
      const caller = frames.at(-1);
      if (caller !== undefined) {
        caller.lastFailure = failed ? exception : undefined;
        caller.copied = false;
      }
      if (next === undefined && failed && exception !== undefined) {
        exception.caught = false;
      }
      continue;
    }
    if (CALL_OPS.has(step.op) && next !== undefined) {
      // A call that ran no code of its own (next step at the same depth).
      const frame = frames.at(-1)!;
      frame.copied = false;
      frame.lastFailure = succeeded(next)
        ? undefined
        : raise({
            step: i,
            kind: 'call',
            data: undefined,
            status: statusOf(next),
            cheatcode: isCheatcodeCall(step),
            expected: false,
          });
    }
  }
  return found;
}

/** Explanations of the engine's failure statuses for halts and failed calls. */
const STATUS_MESSAGES: Readonly<Record<string, string>> = {
  EVMC_OUT_OF_GAS: 'out of gas',
  EVMC_INVALID_INSTRUCTION: 'executed the designated INVALID instruction',
  EVMC_UNDEFINED_INSTRUCTION: 'executed an undefined instruction',
  EVMC_STACK_OVERFLOW: 'stack overflow',
  EVMC_STACK_UNDERFLOW: 'stack underflow',
  EVMC_BAD_JUMP_DESTINATION: 'jump to an invalid destination',
  EVMC_INVALID_MEMORY_ACCESS: 'invalid memory access',
  EVMC_CALL_DEPTH_EXCEEDED: 'call depth limit exceeded',
  EVMC_STATIC_MODE_VIOLATION: 'state modification in a static call',
  EVMC_PRECOMPILE_FAILURE: 'precompile failed',
  EVMC_INSUFFICIENT_BALANCE: 'insufficient balance for the transfer',
  EVMC_BALANCE_UNDERFLOW: 'insufficient balance for the transfer',
};

/** `EVMC_OUT_OF_GAS` → `OutOfGas`. */
function statusId(status: string): string {
  return status
    .replace(/^EVMC_/, '')
    .toLowerCase()
    .replace(/(^|_)([a-z])/g, (_, _sep: string, c: string) => c.toUpperCase());
}

function statusMessage(status: string): string {
  return (
    STATUS_MESSAGES[status] ??
    status
      .replace(/^EVMC_/, '')
      .toLowerCase()
      .replace(/_/g, ' ')
  );
}

/**
 * Explain `exception` for the client: decode its revert data against the known
 * custom `errors`, or describe the halt / failed call.
 */
export function describeException(
  exception: TraceException,
  steps: readonly Step[],
  cursor: StateCursor,
  errors: ReadonlyMap<string, ErrorInfo>
): RevertReason {
  const reason = baseReason(exception, steps, cursor, errors);
  if (!exception.expected) return reason;
  const note = ' (expected by vm.expectRevert)';
  return {
    ...reason,
    message: reason.message + note,
    summary: reason.summary + note,
  };
}

function baseReason(
  exception: TraceException,
  steps: readonly Step[],
  cursor: StateCursor,
  errors: ReadonlyMap<string, ErrorInfo>
): RevertReason {
  const {kind, data, status} = exception;
  const decoded =
    data === undefined ? undefined : decodeRevertData(data, errors);
  if (kind === 'revert') {
    if (decoded !== undefined) return decoded;
    const message = 'reverted (the trace does not record the revert data)';
    return {id: 'Revert', message, summary: message};
  }
  if (kind === 'call') {
    const step = steps[exception.step]!;
    if (exception.cheatcode) {
      const call = decodeCheatcodeCall(step, cursor.at(exception.step));
      const id = `vm.${call?.name ?? 'cheatcode'}`;
      const message = decoded?.message ?? 'the cheatcode failed';
      return {...decoded, id, message, summary: `${id}: ${message}`};
    }
    if (decoded !== undefined) return decoded;
    const message =
      status === undefined
        ? `the ${step.op} failed without running any code`
        : `the ${step.op} failed: ${statusMessage(status)}`;
    return {id: 'CallFailed', message, summary: message};
  }
  if (kind === 'invalid') {
    const message = 'executed the designated INVALID instruction (0xfe)';
    return {id: 'InvalidInstruction', message, summary: message};
  }
  if (status !== undefined) {
    const message = statusMessage(status);
    return {id: statusId(status), message, summary: message};
  }
  const message = `execution halted exceptionally at ${steps[exception.step]!.op}`;
  return {id: 'ExceptionalHalt', message, summary: message};
}

/**
 * Move each exception's {@link TraceException.stop} onto the statement that
 * raised it. viaIR code reverts from shared Yul helpers (`revert_error_…`,
 * `panic_error_…`) that solc attributes to the whole contract, so stopping at
 * the REVERT would show the contract header instead of the failing `require`
 * or expression. The last step of the same call frame (skipping callees) that
 * belongs to a statement is where the failure happened in the source.
 */
export function placeExceptions(
  exceptions: readonly TraceException[],
  steps: readonly Step[],
  hasStatement: (step: number) => boolean
): void {
  for (const e of exceptions) {
    const depth = steps[e.step]!.depth;
    for (let j = e.step; j >= 0 && steps[j]!.depth >= depth; j--) {
      if (steps[j]!.depth === depth && hasStatement(j)) {
        e.stop = j;
        break;
      }
    }
  }
}

/**
 * Whether the call that just returned into `after` succeeded (its pushed flag).
 * A trace recorded without stacks cannot tell, and is taken to succeed.
 */
function succeeded(after: Step): boolean {
  const flag = after.stack.at(-1);
  return flag === undefined || BigInt(flag) !== 0n;
}

/** A failure status reported on the step after a call returned, if any. */
function statusOf(after: Step | undefined): string | undefined {
  const status = after?.statusCode;
  return status?.startsWith('EVMC_') && status !== 'EVMC_SUCCESS'
    ? status
    : undefined;
}

/**
 * The bytes a REVERT step returns: memory[offset, offset + size), or
 * `undefined` when the trace does not show them (no stack or memory recorded)
 * or the range is too large to be real (the REVERT then runs out of gas).
 */
function revertData(
  step: Step,
  cursor: StateCursor,
  index: number
): string | undefined {
  const st = step.stack;
  if (st.length < 2) return undefined;
  const offset = BigInt(st[st.length - 1]!);
  const size = BigInt(st[st.length - 2]!);
  if (size === 0n) return '0x';
  if (size > MAX_REVERT_BYTES || offset > 1n << 32n) return undefined;
  const words = cursor.at(index).memory;
  if (words.length === 0) return undefined; // geth traces record no memory
  const memory = words.map(w => strip0x(w).padStart(64, '0')).join('');
  // Memory past its current end reads as zeros.
  const [from, length] = [Number(offset), Number(size)];
  const slice = memory.slice(from * 2, (from + length) * 2);
  return ('0x' + slice.padEnd(length * 2, '0')).toLowerCase();
}
