/**
 * The session's armed breakpoints — source lines, instructions (Disassembly
 * View) and exception filters ("dynamic" breakpoints such as stop-on-call) —
 * and the run-to-stop search `continue`/`reverseContinue` perform over them.
 */
import type {DebugProtocol} from '@vscode/debugprotocol';

import type {Step} from '@simbolik/lifting';

import {
  decodeInstructionAddress,
  encodeInstructionAddress,
} from './disassemble.js';
import type {TraceException} from './exceptions.js';
import {addressHex} from './hex.js';
import type {SteppingModel, Stop} from './stepping.js';

/**
 * A DAP exception-breakpoint filter (a "dynamic" breakpoint): a toggle in the
 * Breakpoints panel. The two exception filters stop where an exception
 * originates (see `exceptions.ts`) — `exceptions: 'all'` on every one,
 * `'uncaught'` only on the one that fails the transaction — during `continue`
 * AND statement steps, so stepping over a failing call stops at the failure
 * instead of running off the end. The others make `continue` stop on any opcode
 * in a category (e.g. "stop on external calls"); `ops` is the set of EVM
 * opcodes that trip them.
 */
export interface ExceptionFilterDef {
  filter: string;
  label: string;
  description: string;
  ops: readonly string[];
  exceptions?: 'all' | 'uncaught';
  /** Whether the client enables the filter by default. */
  default?: boolean;
}

/**
 * The offered exception-breakpoint filters (single source of truth for both the
 * `initialize` capability and continue-time matching). Mirrors the Python server.
 */
export const EXCEPTION_BREAKPOINT_FILTERS: readonly ExceptionFilterDef[] = [
  {
    filter: 'break-on-uncaught-revert',
    label: 'Uncaught Reverts',
    description:
      'Break where the revert, failed assertion or exceptional halt that fails the transaction originates',
    ops: [],
    exceptions: 'uncaught',
    default: true,
  },
  {
    filter: 'break-on-revert',
    label: 'All Reverts',
    description:
      'Break where any revert, failed assertion or exceptional halt originates, even one a caller catches',
    ops: [],
    exceptions: 'all',
  },
  {
    filter: 'break-on-call',
    label: 'External Calls',
    description: 'Break on CALL, CALLCODE, DELEGATECALL, and STATICCALL',
    ops: ['CALL', 'CALLCODE', 'DELEGATECALL', 'STATICCALL'],
  },
  {
    filter: 'break-on-create',
    label: 'Contract Creations',
    description: 'Break on CREATE and CREATE2',
    ops: ['CREATE', 'CREATE2'],
  },
  {
    filter: 'break-on-return',
    label: 'Returns',
    description: 'Break on RETURN and STOP',
    ops: ['RETURN', 'STOP'],
  },
  {
    filter: 'break-on-sstore',
    label: 'Storage Writes',
    description: 'Break on SSTORE',
    ops: ['SSTORE'],
  },
  {
    filter: 'break-on-log',
    label: 'Event Logs',
    description: 'Break on LOG0, LOG1, LOG2, LOG3, and LOG4',
    ops: ['LOG0', 'LOG1', 'LOG2', 'LOG3', 'LOG4'],
  },
  {
    filter: 'break-on-jump',
    label: 'Jumps',
    description: 'Break on JUMP and JUMPI',
    ops: ['JUMP', 'JUMPI'],
  },
];

/** opcode → the filter id that stops on it (built from the table above). */
const OP_TO_EXCEPTION_FILTER: ReadonlyMap<string, string> = new Map(
  EXCEPTION_BREAKPOINT_FILTERS.flatMap(f =>
    f.ops.map(op => [op, f.filter] as const)
  )
);

/** The set of valid filter ids, to reject anything unknown from the client. */
const EXCEPTION_FILTER_IDS: ReadonlySet<string> = new Set(
  EXCEPTION_BREAKPOINT_FILTERS.map(f => f.filter)
);

/**
 * Armed-instruction-breakpoint map key: an address PLUS which code image (init
 * vs runtime), so a constructor pc and a runtime pc of the same number in the
 * same contract are distinct breakpoints.
 */
function instructionKey(codeAddress: string, isInit: boolean): string {
  return `${codeAddress}|${isInit ? 'i' : 'r'}`;
}

/** Where a run-to-stop lands and the `stopped` reason it reports. */
export interface RunTarget {
  target: number;
  reason: string;
}

export class Breakpoints {
  /** Requested breakpoint lines, keyed by (relative build-info) source path. */
  readonly #lines = new Map<string, ReadonlySet<number>>();
  /** Armed instruction breakpoints: `instructionKey(addr, isInit)` → pcs. */
  #instructions = new Map<string, Set<number>>();
  /** Active exception-breakpoint filter ids (e.g. `break-on-call`). */
  #exceptionFilters = new Set<string>();

  readonly #steps: readonly Step[];
  readonly #model: SteppingModel;
  /** The trace's exceptions, keyed by the step the debugger shows them at. */
  readonly #exceptions: ReadonlyMap<number, TraceException>;

  constructor(
    steps: readonly Step[],
    model: SteppingModel,
    exceptions: readonly TraceException[] = []
  ) {
    this.#steps = steps;
    this.#model = model;
    this.#exceptions = new Map(exceptions.map(e => [e.stop, e]));
  }

  /** Arm `lines` for `path`, replacing that source's previous set. */
  setLines(path: string, lines: number[]): void {
    this.#lines.set(path, new Set(lines));
  }

  /**
   * Replace the armed instruction breakpoints (DAP sends the full list). Each
   * `instructionReference` is a packed `(codeAddress, pc, isInit)` address (see
   * {@link encodeInstructionAddress}); a per-row byte `offset` shifts the pc. A
   * row is verified when its address decodes.
   */
  setInstructions(
    breakpoints: {instructionReference: string; offset?: number}[]
  ): DebugProtocol.Breakpoint[] {
    this.#instructions = new Map();
    return breakpoints.map(bp => {
      let decoded: ReturnType<typeof decodeInstructionAddress>;
      try {
        decoded = decodeInstructionAddress(bp.instructionReference);
      } catch {
        return {verified: false};
      }
      const {codeAddress, pc, isInit} = decoded;
      const target = pc + (bp.offset ?? 0);
      const key = instructionKey(codeAddress, isInit);
      let pcs = this.#instructions.get(key);
      if (pcs === undefined) {
        pcs = new Set();
        this.#instructions.set(key, pcs);
      }
      pcs.add(target);
      return {
        verified: true,
        instructionReference: encodeInstructionAddress(
          codeAddress,
          target,
          isInit
        ),
      };
    });
  }

  /** Replace the active exception filters, ignoring any unknown id. */
  setExceptionFilters(filters: string[]): void {
    this.#exceptionFilters = new Set(
      filters.filter(f => EXCEPTION_FILTER_IDS.has(f))
    );
  }

  /**
   * The exception shown at `step` (its {@link TraceException.stop}), when an
   * enabled filter breaks on it.
   */
  exceptionAt(step: number): TraceException | undefined {
    const exception = this.#exceptions.get(step);
    if (exception === undefined) return undefined;
    const uncaught = this.#exceptionFilters.has('break-on-uncaught-revert');
    const all = this.#exceptionFilters.has('break-on-revert');
    return all || (uncaught && !exception.caught) ? exception : undefined;
  }

  /**
   * The first exception an enabled filter breaks on in `(from, to]` — where a
   * forward step from `from` to `to` must stop instead.
   */
  exceptionBetween(from: number, to: number): TraceException | undefined {
    let first: TraceException | undefined;
    for (const stop of this.#exceptions.keys()) {
      if (stop > from && stop <= to && stop < (first?.stop ?? Infinity)) {
        first = this.exceptionAt(stop) ?? first;
      }
    }
    return first;
  }

  /**
   * The nearest stop from `from` in direction `dir`, folding the three stop
   * kinds (source-line, instruction, exception filter) into one target and a
   * `stopped` reason. An exception (in either direction) reports `'exception'`; every other stop
   * reports `'breakpoint'`; running to the end/start reports `'step'`.
   */
  runToStop(from: Stop, dir: 1 | -1): RunTarget {
    const candidates = [
      dir === 1
        ? this.#model.continueStop(from, this.#lines).step
        : this.#model.reverseContinue(from.step, this.#lines),
    ];
    const instr = this.#nearest(from.step, dir, this.#instructions.size, j =>
      this.#isInstructionStop(j)
    );
    if (instr !== undefined) candidates.push(instr);
    const exc = this.#nearest(
      from.step,
      dir,
      this.#exceptionFilters.size,
      j =>
        this.#exceptionFilterAt(j) !== undefined ||
        this.exceptionAt(j) !== undefined
    );
    if (exc !== undefined) candidates.push(exc);
    const target =
      dir === 1 ? Math.min(...candidates) : Math.max(...candidates);

    // Re-running from the terminal step lands where it started: that is the end
    // of the trace, not a second hit of an exception raised there.
    let reason = 'step';
    if (target !== from.step && this.exceptionAt(target) !== undefined) {
      reason = 'exception';
    } else if (
      this.#exceptionFilterAt(target) !== undefined ||
      this.#model.isArmedStop(target, this.#lines) ||
      this.#isInstructionStop(target)
    ) {
      reason = 'breakpoint';
    }
    return {target, reason};
  }

  /**
   * The nearest step in `dir` from `origin` (exclusive) satisfying `hit`, or
   * `undefined` when nothing is `armed` / none is reachable.
   */
  #nearest(
    origin: number,
    dir: 1 | -1,
    armed: number,
    hit: (step: number) => boolean
  ): number | undefined {
    if (armed === 0) return undefined;
    for (let j = origin + dir; j >= 0 && j <= this.#model.last; j += dir) {
      if (hit(j)) return j;
    }
    return undefined;
  }

  /** Whether `stepIndex` sits on an armed instruction breakpoint. */
  #isInstructionStop(stepIndex: number): boolean {
    const step = this.#steps[stepIndex];
    if (step === undefined) return false;
    const key = instructionKey(addressHex(step.codeAddress), step.isInitCode);
    return this.#instructions.get(key)?.has(step.pc) ?? false;
  }

  /** The ENABLED filter id tripped by `stepIndex`'s opcode, or `undefined`. */
  #exceptionFilterAt(stepIndex: number): string | undefined {
    const step = this.#steps[stepIndex];
    if (step === undefined) return undefined;
    const filter = OP_TO_EXCEPTION_FILTER.get(step.op);
    return filter !== undefined && this.#exceptionFilters.has(filter)
      ? filter
      : undefined;
  }
}
