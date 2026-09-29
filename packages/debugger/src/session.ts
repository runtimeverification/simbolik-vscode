/**
 * The DAP debug session over a recorded trace.
 *
 * `SolidityDebugSession` answers the core DAP request sequence
 * (`initialize → launch → threads → stackTrace → scopes → variables`) in-memory
 * against a recorded trace. It is a thin facade over the launch-time model
 * ({@link loadTrace}: steps, state cursor, address registry, stepping model),
 * the session's position + breakpoints, and the per-scope renderers.
 *
 * MIXED compilation units are supported: a single transaction can span multiple
 * build-infos compiled at different optimization levels (an external CALL runs
 * the callee's code). Source mapping / scopes / variables resolve PER STEP
 * against the resolved contract's own CU, the stack spans external calls, and
 * optimized frames fall back to storage-only scopes and line-based stepping.
 */
import type {DebugProtocol} from '@vscode/debugprotocol';

import {Breakpoints, EXCEPTION_BREAKPOINT_FILTERS} from './breakpoints.js';
import type {Disassembly} from './contractAnalysis.js';
import {encodeInstructionAddress} from './disassemble.js';
import {disassembleView, type DisassembleArgs} from './disassemblyView.js';
import {
  decodedEvents,
  eventArgVariables,
  eventsVariables,
} from './eventsScope.js';
import {
  accountStorageVariables,
  accountsVariables,
  accountVariables,
  calldataVariables,
  evmVariables,
  memoryVariables,
} from './evmScope.js';
import {reconstructFrames, type FrameInfo} from './frames.js';
import {globalGroupVariables, globalsVariables} from './globalsScope.js';
import {HandleTable, type Handle} from './handles.js';
import type {LaunchInputs} from './launchInputs.js';
import {SolidityVariables} from './solidityVariables.js';
import {SourceRegistry} from './sources.js';
import type {StepMeta, Stop} from './stepping.js';
import {loadTrace, type Trace} from './trace.js';

export {
  EXCEPTION_BREAKPOINT_FILTERS,
  type ExceptionFilterDef,
} from './breakpoints.js';
export type {LaunchInputs} from './launchInputs.js';

/** The DAP capabilities of a session. */
export const CAPABILITIES: DebugProtocol.Capabilities = {
  supportsConfigurationDoneRequest: true,
  supportsStepBack: true,
  supportsSteppingGranularity: true,
  supportsDisassembleRequest: true,
  supportsInstructionBreakpoints: true,
  // "Dynamic" breakpoints (stop-on-call/create/revert/…) shown as toggles in
  // the Breakpoints panel; matched during continue.
  exceptionBreakpointFilters: EXCEPTION_BREAKPOINT_FILTERS.map(f => ({
    filter: f.filter,
    label: f.label,
    description: f.description,
    default: false,
  })),
};

/** Arguments a step request may carry (VSCode adds `granularity`). */
interface StepArgs {
  threadId?: number;
  granularity?: DebugProtocol.SteppingGranularity;
}

/** Everything wired up by {@link SolidityDebugSession.launch}. */
interface Launched {
  trace: Trace;
  /** The current stop. */
  stop: Stop;
  breakpoints: Breakpoints;
  sources: SourceRegistry;
  variables: SolidityVariables;
  handles: HandleTable;
  foreignDisassembly: Map<string, Disassembly>;
}

/**
 * In-memory Solidity debug session over a recorded trace. Answers the core DAP
 * requests; positioned at the entry statement after {@link launch}.
 */
export class SolidityDebugSession {
  readonly #events: DebugProtocol.Event[] = [];
  #seq = 0;
  /** Whether a `terminated` event has already been emitted this session. */
  #endEmitted = false;
  #launched: Launched | undefined;

  /** Events emitted during the session (e.g. `'stopped'`), in order. */
  get events(): DebugProtocol.Event[] {
    return this.#events;
  }

  /** DAP capabilities. */
  initialize(
    _args?: DebugProtocol.InitializeRequestArguments
  ): DebugProtocol.Capabilities {
    return CAPABILITIES;
  }

  /** Read-only index of the current step within the trace. */
  get currentStepIndex(): number {
    return this.#require().stop.step;
  }

  /**
   * Reposition the session at trace step `index` (clamped), without emitting
   * any event. Test/harness support: lets a driver probe `next`/`stepOut` from
   * a stop reached by `stepIn` and then return to it, since every stepping
   * command is a pure function of the current step index.
   */
  seekStep(index: number): void {
    const s = this.#require();
    s.stop = {
      step: Math.max(0, Math.min(index, s.trace.model.last)),
      beforeModifier: false,
    };
  }

  /** Test/harness support: the stepping model's metadata for trace step `index`. */
  stepMeta(index: number): StepMeta {
    return this.#require().trace.model.at(index);
  }

  /** Wire everything, position at the entry statement, and queue a `stopped` event. */
  async launch(inputs: LaunchInputs): Promise<void> {
    this.#endEmitted = false;
    const trace = loadTrace(inputs);
    const handles = new HandleTable();
    const launched: Launched = {
      trace,
      stop: trace.model.entryStop(),
      breakpoints: new Breakpoints(trace.steps, trace.model),
      sources: new SourceRegistry(inputs.sourceRoot),
      variables: new SolidityVariables(
        trace,
        handles.alloc,
        () => launched.stop.step
      ),
      handles,
      foreignDisassembly: new Map(),
    };
    this.#launched = launched;
    this.#stop('entry');
  }

  /** DAP handshake no-op. */
  configurationDone(): Record<string, never> {
    return {};
  }

  /** Store the requested breakpoint lines for a source; verify all as-is. */
  setBreakpoints(args: {
    source: {path: string};
    breakpoints: {line: number}[];
  }): {breakpoints: {verified: boolean; line: number}[]} {
    const {breakpoints, sources} = this.#require();
    const lines = args.breakpoints.map(b => b.line);
    breakpoints.setLines(sources.relativePath(args.source.path), lines);
    return {breakpoints: lines.map(line => ({verified: true, line}))};
  }

  /**
   * Set instruction breakpoints (Disassembly View), REPLACING the whole armed
   * set (DAP sends the full list). Keyed by (address, code image) so a runtime
   * pc never matches the same-numbered pc in constructor code.
   */
  setInstructionBreakpoints(args: {
    breakpoints?: {instructionReference: string; offset?: number}[];
  }): {breakpoints: DebugProtocol.Breakpoint[]} {
    return {
      breakpoints: this.#require().breakpoints.setInstructions(
        args.breakpoints ?? []
      ),
    };
  }

  /**
   * Set the active exception-breakpoint filters — the "dynamic" breakpoints (e.g.
   * "stop on external calls"). DAP sends the FULL active id list each call, so we
   * REPLACE the set (ignoring any unknown id). Applied during continue only.
   */
  setExceptionBreakpoints(args: {filters?: string[]}): {
    breakpoints: DebugProtocol.Breakpoint[];
  } {
    this.#require().breakpoints.setExceptionFilters(args.filters ?? []);
    return {breakpoints: []};
  }

  // ─── stepping ──────────────────────────────────────────────────────────────

  /**
   * Step over. At `instruction` granularity (Disassembly View) this is a single
   * EVM opcode, running any external subcall to completion; otherwise a statement
   * step that does not descend into internal calls.
   */
  next(args?: StepArgs): Record<string, never> {
    const {model} = this.#require().trace;
    return this.#forward(
      args,
      step => model.nextInstruction(step),
      stop => model.nextStop(stop)
    );
  }

  /** Step into. At `instruction` granularity, a single EVM opcode forward. */
  stepIn(args?: StepArgs): Record<string, never> {
    const {model} = this.#require().trace;
    return this.#forward(
      args,
      step => Math.min(step + 1, model.last),
      stop => model.stepInStop(stop)
    );
  }

  /** Step out of the current call (statement- or instruction-granular). */
  stepOut(args?: StepArgs): Record<string, never> {
    const {model} = this.#require().trace;
    return this.#forward(
      args,
      step => model.stepOutInstruction(step),
      stop => model.stepOutStop(stop)
    );
  }

  /** Reverse step. At `instruction` granularity, a single EVM opcode backward. */
  stepBack(args?: StepArgs): Record<string, never> {
    const s = this.#require();
    s.stop =
      args?.granularity === 'instruction'
        ? {step: Math.max(s.stop.step - 1, 0), beforeModifier: false}
        : s.trace.model.stepBackStop(s.stop);
    this.#stop('step');
    return {};
  }

  /** Single EVM instruction forward (clamped to the terminal step). */
  stepInstruction(_args?: {threadId?: number}): Record<string, never> {
    return this.stepIn({granularity: 'instruction'});
  }

  /** Single EVM instruction backward (clamped to step 0). */
  stepBackInstruction(_args?: {threadId?: number}): Record<string, never> {
    return this.stepBack({granularity: 'instruction'});
  }

  /**
   * Run forward to the nearest stop — a source-line breakpoint, an instruction
   * breakpoint, OR an enabled exception filter (a "dynamic" breakpoint like
   * stop-on-call) — whichever comes first, else the terminal step. Unlike an
   * explicit step past the last statement (which ends the session), continue
   * reports a `stopped` even at the terminal step: the state stays inspectable.
   */
  continue(_args?: {threadId?: number}): Record<string, never> {
    return this.#run(1);
  }

  /** Run backward to the nearest stop of the same three kinds, else to step 0. */
  reverseContinue(_args?: {threadId?: number}): Record<string, never> {
    return this.#run(-1);
  }

  /**
   * A forward step: a single-instruction move at `instruction` granularity,
   * else a statement-level move that ends the session when it runs off the end.
   */
  #forward(
    args: StepArgs | undefined,
    instruction: (step: number) => number,
    statement: (stop: Stop) => Stop
  ): Record<string, never> {
    const s = this.#require();
    if (args?.granularity === 'instruction') {
      s.stop = {step: instruction(s.stop.step), beforeModifier: false};
      this.#stop('step');
    } else {
      s.stop = statement(s.stop);
      this.#stopOrEnd('step');
    }
    return {};
  }

  #run(dir: 1 | -1): Record<string, never> {
    const s = this.#require();
    const {target, reason} = s.breakpoints.runToStop(s.stop, dir);
    s.stop = {step: target, beforeModifier: false};
    this.#stop(reason);
    return {};
  }

  // ─── stack + sources ───────────────────────────────────────────────────────

  /** The single execution thread. */
  threads(): {threads: DebugProtocol.Thread[]} {
    return {threads: [{id: 1, name: 'main'}]};
  }

  /** The call stack at the current step, TOP-FIRST (innermost frame first). */
  stackTrace(): {stackFrames: DebugProtocol.StackFrame[]; totalFrames: number} {
    const {trace, sources} = this.#require();
    const stackFrames = this.#frames()
      .reverse()
      .map((f): DebugProtocol.StackFrame => {
        const step = trace.steps[f.stepIndex];
        return {
          id: f.id,
          name: f.name,
          // A FOREIGN frame is not attributed to any Solidity source at all.
          source:
            f.cu !== undefined ? sources.sourceOrPath(f.cu, f.path) : undefined,
          line: f.line,
          column: f.column,
          // Enables "Open Disassembly View": packs (codeAddress, pc, isInit) so the
          // disassemble request recovers this frame's CORRECT code image (init vs
          // runtime) and anchor position.
          instructionPointerReference: encodeInstructionAddress(
            f.address,
            step?.pc ?? 0,
            step?.isInitCode ?? false
          ),
        };
      });
    return {stackFrames, totalFrames: stackFrames.length};
  }

  /**
   * Serve the content for a `sourceReference` handed out by {@link stackTrace}
   * (VSCode issues the `source` request for any source carrying one).
   */
  source(sourceReference: number): {content: string; mimeType?: string} {
    return this.#require().sources.content(sourceReference);
  }

  /** Disassemble EVM bytecode for the Disassembly View (see {@link disassembleView}). */
  disassemble(args: DisassembleArgs): {
    instructions: DebugProtocol.DisassembledInstruction[];
  } {
    const {trace, sources, foreignDisassembly} = this.#require();
    return {
      instructions: disassembleView(trace, sources, foreignDisassembly, args),
    };
  }

  // ─── scopes + variables ────────────────────────────────────────────────────

  /**
   * The variable scopes for `frameId`, in display order Locals → State →
   * Globals → Events → EVM. Locals is omitted on optimized frames (the stack
   * analysis it needs is unreliable under optimization) and on cheatcode frames
   * (no Solidity function of their own). A FOREIGN frame has no contract at
   * all, so it exposes ONLY the address-driven EVM scope.
   */
  scopes(frameId: number): {scopes: DebugProtocol.Scope[]} {
    const {handles} = this.#require();
    const frames = this.#frames();
    const frame = frames.find(f => f.id === frameId) ?? frames.at(-1);
    if (frame === undefined) return {scopes: []};

    const scope = (
      name: string,
      handle: Handle,
      expensive = false
    ): DebugProtocol.Scope => ({
      name,
      variablesReference: handles.alloc(handle),
      expensive,
    });
    const frameIdOf = {frameId: frame.id};
    const scopes: DebugProtocol.Scope[] = [];
    const foreign = frame.kind === 'foreign' || frame.cu === undefined;
    if (!foreign && !frame.optimized && frame.kind !== 'cheatcode') {
      scopes.push(scope('Locals', {kind: 'Locals', ...frameIdOf}));
    }
    if (!foreign) {
      scopes.push(
        scope('State', {kind: 'State', ...frameIdOf}),
        scope('Globals', {kind: 'Globals', ...frameIdOf}),
        scope('Events', {kind: 'Events'})
      );
    }
    const storageRef = handles.alloc({kind: 'EVMStorage', ...frameIdOf});
    const memoryRef = handles.alloc({kind: 'EVMMemory', ...frameIdOf});
    scopes.push(
      scope('EVM', {kind: 'EVM', ...frameIdOf, storageRef, memoryRef}, true)
    );
    return {scopes};
  }

  /** Variables for a scope reference, read through the real ethdebug pointer path. */
  async variables(
    variablesReference: number
  ): Promise<{variables: DebugProtocol.Variable[]}> {
    return {variables: await this.#variables(variablesReference)};
  }

  async #variables(ref: number): Promise<DebugProtocol.Variable[]> {
    const s = this.#launched;
    const handle = s?.handles.get(ref);
    if (s === undefined || handle === undefined) return [];
    const {trace, handles, variables} = s;
    // Events are GLOBAL — resolved WITHOUT a frame, so they render even at a
    // frameless position.
    if (handle.kind === 'Events') {
      return eventsVariables(decodedEvents(trace, s.stop.step), handles.alloc);
    }
    if (handle.kind === 'Event') {
      return eventArgVariables(
        decodedEvents(trace, s.stop.step)[handle.eventIndex]
      );
    }
    // Re-resolve the frame against the CURRENT step (by id, falling back to the
    // deepest frame if that depth is no longer live). A synthetic contract frame
    // (an expanded address) is resolved from its own registry first.
    const frame =
      variables.contractFrame(handle.frameId) ??
      this.#frameById(handle.frameId);
    if (frame === undefined) return [];
    const ms = trace.cursor.at(frame.stepIndex);
    switch (handle.kind) {
      case 'State':
        return variables.state(frame);
      case 'Locals':
        return variables.locals(frame);
      case 'Complex':
        return variables.children(frame, handle.varName, handle.complexKind);
      case 'EVM':
        return evmVariables(
          ms,
          frame.id,
          frame.address.toLowerCase(),
          handle,
          handles.alloc
        );
      case 'EVMStorage':
        return accountStorageVariables(ms, frame.address.toLowerCase());
      case 'EVMMemory':
        return memoryVariables(ms);
      case 'EVMCalldata':
        return calldataVariables(ms);
      case 'EVMAccounts':
        return accountsVariables(ms, frame.id, handles.alloc);
      case 'EVMAccount':
        return accountVariables(
          ms,
          frame.id,
          handle.accountAddress,
          handles.alloc
        );
      case 'EVMAccountStorage':
        return accountStorageVariables(ms, handle.accountAddress);
      case 'Globals': {
        const step = trace.steps[frame.stepIndex]!;
        return globalsVariables(step, ms, frame.id, handles.alloc);
      }
      case 'GlobalGroup': {
        const step = trace.steps[frame.stepIndex];
        return step === undefined
          ? []
          : globalGroupVariables(step, ms, handle.group);
      }
    }
  }

  /** Tear down; leaves the session inert. */
  disconnect(): void {
    this.#launched?.handles.clear();
    this.#launched = undefined;
  }

  // ─── helpers ───────────────────────────────────────────────────────────────

  /** The frames at the current stop, bottom-first. */
  #frames(): FrameInfo[] {
    const {trace, stop} = this.#require();
    return reconstructFrames(trace, stop);
  }

  /** The live frame with `id`, else the deepest one. */
  #frameById(id: number): FrameInfo | undefined {
    const frames = this.#frames();
    return frames.find(f => f.id === id) ?? frames.at(-1);
  }

  /** Queue a `stopped` event on the single thread. */
  #stop(reason: string): void {
    const stopped: DebugProtocol.StoppedEvent = {
      seq: this.#seq++,
      type: 'event',
      event: 'stopped',
      body: {reason, threadId: 1, allThreadsStopped: true},
    };
    this.#events.push(stopped);
  }

  /**
   * Report the outcome of a SOURCE-level forward step. If it landed on the
   * terminal trace step, execution has finished — the trace has no step after
   * it, and that step is the contract's dispatch epilogue (whose source range is
   * the whole contract, so a `stopped` there would park the client on the
   * contract-declaration line and freeze). Emit `terminated` so the client ends
   * the session cleanly. Otherwise report a normal `stopped`.
   */
  #stopOrEnd(reason: string): void {
    const s = this.#require();
    if (s.stop.step < s.trace.model.last) {
      this.#stop(reason);
    } else if (!this.#endEmitted) {
      this.#endEmitted = true;
      this.#events.push({seq: this.#seq++, type: 'event', event: 'terminated'});
    }
  }

  #require(): Launched {
    if (this.#launched === undefined) {
      throw new Error('session not launched');
    }
    return this.#launched;
  }
}
