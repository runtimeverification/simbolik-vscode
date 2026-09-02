/**
 * The DAP debug session over a recorded trace.
 *
 * `SolidityDebugSession` answers the core DAP request sequence
 * (`initialize → launch → threads → stackTrace → scopes → variables`) in-memory
 * against a recorded trace. It wires `@simbolik/engine` (lossless parsing),
 * `@simbolik/lifting` (step model + state cursor), `@simbolik/solc` (source maps
 * + AST + CBOR identification) and `@simbolik/ethdebug-gen` + `@ethdebug/pointers`
 * (variable pointers).
 *
 * MIXED compilation units are supported: a single transaction can span multiple
 * build-infos compiled at different optimization levels (an external CALL runs
 * the callee's code). The session loads all build-infos, builds an
 * address→{contract, cu} registry via CBOR runtime-code identification, resolves
 * source mapping / scopes / variables PER STEP against the resolved contract's
 * own CU, reconstructs a MULTI-FRAME stack across external calls, and applies an
 * optimized-frame fallback (storage-only scopes, line-based stepping).
 */
import {existsSync} from 'node:fs';
import * as nodePath from 'node:path';

import type {DebugProtocol} from '@vscode/debugprotocol';

import {parseJsonLossless} from '@simbolik/engine';
import {
  generateEthdebugProgram,
  variablesAt,
  type ArrayLayout,
  type EthdebugProgram,
  type ResolvedVariable,
  type StructMember,
} from '@simbolik/ethdebug-gen';
import {
  normalizeGethTrace,
  normalizeKontrolTrace,
  StateCursor,
  type GethTraceContext,
  type Step,
} from '@simbolik/lifting';
import type {Hex} from '@simbolik/protocol';
import {
  buildInstructionIndex,
  closestFunction,
  findAstNode,
  findInnermostNode,
  identifyContractByRuntimeCode,
  loadBuildInfo,
  type AstNode,
  type CompilationUnit,
  type Contract,
  type SourceFile,
  type SourceMapEntry,
} from '@simbolik/solc';

import {
  machineStateFor,
  readPointerBytes,
  readPointerRegions,
  readPointerValue,
  readStorageWords,
} from './machineState.js';
import {enumerateAllEvents, type DecodedEvent} from './events.js';
import {enumerateMappingKeys, mappingValueSlot} from './mappings.js';
import {
  disassembleBytecode,
  encodeInstructionAddress,
  decodeInstructionAddress,
  type EvmInstruction,
} from './disassemble.js';
import {SteppingModel, type StepResolution} from './stepping.js';
import {
  decodeValue,
  describeValueTypeString,
  enumAstId,
  fieldFromAbiWord,
  type DecodeContext,
} from './values.js';

/** Inputs to launch a session against a recorded transaction. */
export interface LaunchInputs {
  /** solc standard-json build-info (single-CU back-compat). Optional. */
  buildInfoJson?: unknown;
  /** Order-independent array of standard-json build-infos. */
  buildInfos?: unknown[];
  /** The raw `debug_traceTransaction` JSON-RPC response STRING (has `.result`). */
  traceJson: unknown;
  /** Source path within the build-info, e.g. `'src/Counter.sol'`. */
  sourcePath: string;
  /**
   * Absolute directory the build-info's RELATIVE source paths resolve against
   * (the project root, for a LOCAL launch). When set and a source file exists on
   * disk, frames reference the real file (VSCode opens the editable document and
   * gutter breakpoints work); otherwise frames fall back to a `sourceReference`
   * whose content is served via the `source` request (remote replay). Omit for
   * recompiled/remote sources that are not on the client's disk.
   */
  sourceRoot?: string;
  /** Contract name, e.g. `'Counter'`. */
  contractName: string;
  /** The invoked method name, e.g. `'setNumber'`. */
  methodName: string;
  /** The entry-frame contract address (hex), e.g. `'0x5fbd…aa3'`. */
  codeAddress: string;
  /** Trace dialect; defaults to `'kontrol'`. `'geth'` requires {@link txContext}. */
  dialect?: 'kontrol' | 'geth';
  /** The transaction context a geth trace lacks per-step (required for geth). */
  txContext?: GethTraceContext;
  /**
   * An explicit address→build-info map, keyed by LOWERCASE `0x` address.
   * Resolves each frame's CU BY ADDRESS, taking PRECEDENCE over the CBOR-from-trace
   * registry (the only workable path for geth, whose trace carries no per-step
   * code). Optional — omitting it preserves all existing behavior.
   */
  contractsByAddress?: Record<
    string,
    {buildInfoJson: unknown; contractName?: string}
  >;
  /**
   * PRE-TRACE storage to seed the cursor with, keyed `address(hex) → slot(hex) →
   * word(hex)` (minimal-hex slot keys, as the node emits and the lookup expects).
   * A delta-encoded trace omits slots that an EARLIER tx wrote and this one only
   * reads (SLOAD emits no delta), so fixture state established by `setUp()` would
   * otherwise read as zero. The resolver populates this from `eth_getStorageAt`
   * at the pre-trace block for each known contract's static layout slots.
   */
  initialStorage?: Record<string, Record<string, Hex>>;
}

/** A reconstructed EVM-depth stack frame at the current step. */
/** The static layout facts of a mapping storage var (from the producer). */
type MappingLayout = {baseSlot: number; keyType: string; valueType: string};

interface FrameInfo {
  /** Distinct DAP frame id. */
  id: number;
  /** 1-based EVM depth of this frame. */
  depth: number;
  /** Lowercase hex address of the running contract. */
  address: string;
  contract: Contract;
  cu: CompilationUnit;
  optimized: boolean;
  /** Trace step index this frame is positioned at (top = current; parent = CALL site). */
  stepIndex: number;
  /** Resolved source path of the frame's current position. */
  path: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
  /** Resolved function name (or contract name fallback). */
  name: string;
  /** The FunctionDefinition AST node for the frame, when resolved. */
  fnNode: AstNode | undefined;
}

/**
 * A variablesReference handle bound to a frame IDENTITY (by id) + scope kind.
 * The concrete frame is re-resolved against the CURRENT step at read time, so a
 * scope ref captured before stepping still reads the up-to-date position — the
 * pattern of `scopes()` then `continue()` then `variables(ref)`.
 */
interface Handle {
  kind:
    | 'State'
    | 'Locals'
    | 'EVM'
    | 'EVMStorage'
    | 'EVMMemory'
    | 'Complex'
    | 'Events'
    | 'Event';
  frameId: number;
  /** For an `EVM` handle: the nested `EVMStorage` handle ref. */
  storageRef?: number;
  /** For an `EVM` handle: the nested `EVMMemory` handle ref. */
  memoryRef?: number;
  /**
   * For an `Event` handle: the index of the decoded event within the
   * frame's re-enumerated event list, expanded into its decoded args at read
   * time (like every handle, re-resolved against the CURRENT step).
   */
  eventIndex?: number;
  /**
   * For a `Complex` handle (a nested struct variable): the name of the
   * resolved variable whose `members` are re-resolved + decoded at read time,
   * against the CURRENT step (like every other handle).
   */
  varName?: string;
  /**
   * For a `Complex` handle: WHERE the parent variable is re-resolved from —
   * `'local'` (memory params/locals via `variablesAt`) or `'state'`
   * (storage vars via `generateEthdebugProgram`). The dereference +
   * child decode is identical; only the source of the parent descriptor differs.
   */
  complexKind?: 'local' | 'state';
}

/** The wired-up state produced by {@link SolidityDebugSession.launch}. */
interface LaunchedState {
  cus: CompilationUnit[];
  /** address(hex) → {contract, cu} resolved via CBOR runtime-code identity. */
  registry: Map<string, StepResolution>;
  /** The ultimate fallback resolution (the launch/entry contract). */
  entryResolution: StepResolution;
  steps: Step[];
  cursor: StateCursor;
  model: SteppingModel;
  step: number;
  inputs: LaunchInputs;
  /** Requested breakpoint lines, keyed by source path. */
  breakpoints: Map<string, number[]>;
  /** Armed instruction breakpoints: `instructionBpKey(addr, isInit)` → set of pcs. */
  instructionBreakpoints: Map<string, Set<number>>;
  /** Active exception-breakpoint filter ids (e.g. `break-on-call`). */
  exceptionFilters: Set<string>;
}

/** Format a `bigint` EVM address as a lowercase, zero-padded hex string. */
function addressHex(addr: bigint): string {
  return '0x' + addr.toString(16).padStart(40, '0');
}

/** Arguments a step request may carry (VSCode adds `granularity`). */
interface StepArgs {
  threadId?: number;
  granularity?: DebugProtocol.SteppingGranularity;
}

/** Whether a step request asked for instruction (Disassembly View) granularity. */
function isInstruction(args?: StepArgs): boolean {
  return args?.granularity === 'instruction';
}

/**
 * Armed-instruction-breakpoint map key: an address PLUS which code image (init
 * vs runtime), so a constructor pc and a runtime pc of the same number in the
 * same contract are distinct breakpoints.
 */
function instructionBpKey(codeAddress: string, isInit: boolean): string {
  return `${codeAddress}|${isInit ? 'i' : 'r'}`;
}

/**
 * A DAP exception-breakpoint filter (a "dynamic" breakpoint): a toggle in the
 * Breakpoints panel that makes `continue` stop on any opcode in a category (e.g.
 * "stop on external calls"). `ops` is the set of EVM opcodes that trip it.
 */
export interface ExceptionFilterDef {
  filter: string;
  label: string;
  description: string;
  ops: readonly string[];
}

/**
 * The offered exception-breakpoint filters (single source of truth for both the
 * `initialize` capability and continue-time matching). Mirrors the Python server.
 */
export const EXCEPTION_BREAKPOINT_FILTERS: readonly ExceptionFilterDef[] = [
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
    filter: 'break-on-revert',
    label: 'Reverts',
    description: 'Break on REVERT and INVALID',
    ops: ['REVERT', 'INVALID'],
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
  EXCEPTION_BREAKPOINT_FILTERS.flatMap((f) =>
    f.ops.map((op) => [op, f.filter] as const),
  ),
);

/** The set of valid filter ids, to reject anything unknown from the client. */
const EXCEPTION_FILTER_IDS: ReadonlySet<string> = new Set(
  EXCEPTION_BREAKPOINT_FILTERS.map((f) => f.filter),
);

/**
 * In-memory Solidity debug session over a recorded trace. Answers the core DAP
 * requests; positioned at the entry statement after {@link launch}.
 */
export class SolidityDebugSession {
  readonly #events: DebugProtocol.Event[] = [];
  #seq = 0;
  #state: LaunchedState | undefined;
  /** Per-contract runtime source-map indexing, cached across resolutions. */
  readonly #indexCache = new Map<
    Contract,
    {pcToInstruction: Map<number, number>; sourceMap: SourceMapEntry[]}
  >();
  /** Like {@link #indexCache} but over INIT (constructor) code — CREATE frames. */
  readonly #initIndexCache = new Map<
    Contract,
    {pcToInstruction: Map<number, number>; sourceMap: SourceMapEntry[]}
  >();
  /** Per-contract ethdebug program (storage-variable pointers), cached. */
  readonly #programCache = new Map<Contract, EthdebugProgram>();
  /**
   * Resolved live-variable context (`variablesAt`) keyed by `Contract` IDENTITY
   * then `pc`. Keying by the `Contract` object (like {@link #programCache} /
   * {@link #indexCache}) — not by contract NAME — avoids a mixed-CU collision:
   * the same contract name can appear in two CUs (e.g. compiled at different
   * optimization levels), or in two source paths within one CU, where the same
   * pc denotes DIFFERENT variables. `variablesAt` rebuilds the `stackHeights`
   * analyzer each call, so this avoids recomputing it on every `variables()`
   * request at the same position.
   */
  readonly #varCache = new Map<Contract, Map<number, ResolvedVariable[]>>();
  /** Live variablesReference handles, rebuilt as `scopes` is requested. */
  #handles = new Map<number, Handle>();
  #handleSeq = 100;

  /**
   * Synthetic frames for EXPANDED contract addresses (issue: an address-typed
   * variable that resolves to a known contract is drilled into to show that
   * contract's storage at the current step). Keyed by a NEGATIVE frame id so it
   * never collides with a real EVM-depth frame; `variables()` resolves a handle's
   * frame from here first, which lets the whole storage-rendering machinery
   * (`#stateVariables`/`#renderComplex`/…) work on the foreign contract unchanged.
   */
  readonly #contractFrames = new Map<number, FrameInfo>();
  #syntheticFrameSeq = -1;

  /**
   * DAP `sourceReference` registry. Trace sources live in the build-info, not
   * necessarily on the client's disk (remote replay recompiles; even local
   * build-info paths are relative), so every frame source is served through the
   * `source` request rather than a filesystem path. Each distinct `SourceFile`
   * gets a stable positive reference; `source(ref)` returns its content.
   */
  readonly #sourceRefs = new Map<SourceFile, number>();
  readonly #sourceByRef = new Map<number, SourceFile>();
  #sourceRefSeq = 1;

  /** Per-contract disassembly (init + runtime images), cached across requests. */
  readonly #disasmCache = new Map<
    Contract,
    {
      runtime?: {list: EvmInstruction[]; pcToIndex: Map<number, number>};
      init?: {list: EvmInstruction[]; pcToIndex: Map<number, number>};
    }
  >();

  /** Events emitted during the session (e.g. `'stopped'`), in order. */
  get events(): DebugProtocol.Event[] {
    return this.#events;
  }

  /** DAP capabilities. */
  initialize(
    _args?: DebugProtocol.InitializeRequestArguments,
  ): DebugProtocol.Capabilities {
    return {
      supportsConfigurationDoneRequest: true,
      supportsStepBack: true,
      supportsDisassembleRequest: true,
      supportsSteppingGranularity: true,
      supportsInstructionBreakpoints: true,
    };
  }

  /** Read-only index of the current step within the trace. */
  get currentStepIndex(): number {
    return this.#require().step;
  }

  /** Wire everything, position at the entry statement, and queue a `stopped` event. */
  async launch(inputs: LaunchInputs): Promise<void> {
    const jsons = inputs.buildInfos ?? [inputs.buildInfoJson];
    const cus = jsons
      .filter((j) => j !== undefined)
      .map((j) => loadBuildInfo(j));
    if (cus.length === 0) {
      throw new Error('launch: no build-info provided');
    }

    const parsed = parseJsonLossless(inputs.traceJson as string) as {
      result: unknown;
    };
    const dialect = inputs.dialect ?? 'kontrol';
    let steps: Step[];
    if (dialect === 'geth') {
      if (inputs.txContext === undefined) {
        throw new Error(
          'launch: dialect "geth" requires a txContext (tx to/from/input)',
        );
      }
      steps = normalizeGethTrace(parsed.result, inputs.txContext);
    } else {
      steps = normalizeKontrolTrace(parsed.result as never);
    }
    const cursor = new StateCursor(steps, inputs.initialStorage);

    // The entry/launch contract, used as the ultimate resolution fallback: found
    // by CBOR against the entry frame's code, else by name across the CUs.
    const entryResolution = this.#resolveEntry(inputs, cus, steps, cursor);

    // Build the address→{contract, cu} registry over the DISTINCT codeAddresses
    // in the trace (CBOR identification of each frame's runtime code).
    const registry = new Map<string, StepResolution>();
    const firstSeen = new Map<string, number>();
    for (let i = 0; i < steps.length; i++) {
      const addr = addressHex(steps[i]!.codeAddress);
      if (!firstSeen.has(addr)) firstSeen.set(addr, i);
    }
    for (const [addr, idx] of firstSeen) {
      const code = cursor.at(idx).bytecode;
      let resolution = this.#identify(cus, code);
      if (resolution === undefined && addr === inputs.codeAddress.toLowerCase()) {
        resolution = entryResolution;
      }
      if (resolution !== undefined) registry.set(addr, resolution);
    }
    // An explicit address→build-info map WINS over CBOR-from-trace. For
    // geth (no per-step code) this is the only way to resolve a callee's CU by
    // address; the CBOR path above stays the fallback for addresses absent here.
    if (inputs.contractsByAddress !== undefined) {
      for (const [rawAddr, entry] of Object.entries(inputs.contractsByAddress)) {
        const addr = rawAddr.toLowerCase();
        const cu = loadBuildInfo(entry.buildInfoJson);
        // Register the CU for cross-CU lookups (#nodeById etc.), deduped by the
        // parsed-CU identity (a fresh object per loadBuildInfo call).
        if (!cus.includes(cu)) cus.push(cu);
        const contract = this.#pickContract(cu, entry.contractName, cursor, firstSeen.get(addr));
        if (contract !== undefined) {
          registry.set(addr, {
            contract,
            cu,
            optimized: cu.optimizer().enabled,
          });
        }
      }
    }

    // Guarantee the entry address always resolves (single-CU back-compat).
    const entryAddr = inputs.codeAddress.toLowerCase();
    if (!registry.has(entryAddr)) registry.set(entryAddr, entryResolution);

    const resolve = (index: number): StepResolution | undefined =>
      registry.get(addressHex(steps[index]!.codeAddress)) ?? entryResolution;

    const model = new SteppingModel(cursor, resolve);

    this.#state = {
      cus,
      registry,
      entryResolution,
      steps,
      cursor,
      model,
      step: model.entry(),
      inputs,
      breakpoints: new Map(),
      instructionBreakpoints: new Map(),
      exceptionFilters: new Set(),
    };

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
    const state = this.#require();
    const lines = args.breakpoints.map((b) => b.line);
    // The stepping model keys breakpoints by the RELATIVE build-info path. When
    // frames reference the real on-disk file, VSCode sends an ABSOLUTE path here
    // — normalize it back to the project-root-relative form so it matches.
    state.breakpoints.set(this.#normalizeBreakpointPath(args.source.path), lines);
    return {breakpoints: lines.map((line) => ({verified: true, line}))};
  }

  /**
   * Set instruction breakpoints (Disassembly View). Each `instructionReference`
   * is a packed `(codeAddress, pc, isInit)` address (see
   * {@link encodeInstructionAddress}) — the same value the disassembly rows and
   * `instructionPointerReference` carry. A per-row byte `offset` shifts the pc.
   * We REPLACE the whole armed set each call (DAP sends the full list) and verify
   * a row when its address decodes. Breakpoints are keyed by (address, code image)
   * so a runtime pc never matches the same-numbered pc in constructor code.
   */
  setInstructionBreakpoints(args: {
    breakpoints?: {instructionReference: string; offset?: number}[];
  }): {breakpoints: DebugProtocol.Breakpoint[]} {
    const state = this.#require();
    state.instructionBreakpoints = new Map();
    const verified: DebugProtocol.Breakpoint[] = [];
    for (const bp of args.breakpoints ?? []) {
      let codeAddress: string;
      let pc: number;
      let isInit: boolean;
      try {
        ({codeAddress, pc, isInit} = decodeInstructionAddress(
          bp.instructionReference,
        ));
      } catch {
        verified.push({verified: false});
        continue;
      }
      const target = pc + (bp.offset ?? 0);
      const key = instructionBpKey(codeAddress, isInit);
      let pcs = state.instructionBreakpoints.get(key);
      if (pcs === undefined) {
        pcs = new Set();
        state.instructionBreakpoints.set(key, pcs);
      }
      pcs.add(target);
      verified.push({
        verified: true,
        instructionReference: encodeInstructionAddress(codeAddress, target, isInit),
      });
    }
    return {breakpoints: verified};
  }

  /** Whether `stepIndex` sits on an armed instruction breakpoint. */
  #isInstructionStop(state: LaunchedState, stepIndex: number): boolean {
    const step = state.steps[stepIndex];
    if (step === undefined) return false;
    const key = instructionBpKey(addressHex(step.codeAddress), step.isInitCode);
    return state.instructionBreakpoints.get(key)?.has(step.pc) ?? false;
  }

  /**
   * The nearest step in `dir` from `origin` (exclusive) that sits on an armed
   * instruction breakpoint, or `undefined` when none is armed / reachable.
   */
  #nextInstructionStop(
    state: LaunchedState,
    origin: number,
    dir: 1 | -1,
  ): number | undefined {
    if (state.instructionBreakpoints.size === 0) return undefined;
    for (
      let j = origin + dir;
      j >= 0 && j <= state.model.last;
      j += dir
    ) {
      if (this.#isInstructionStop(state, j)) return j;
    }
    return undefined;
  }

  /**
   * Set the active exception-breakpoint filters — the "dynamic" breakpoints (e.g.
   * "stop on external calls"). DAP sends the FULL active id list each call, so we
   * REPLACE the set (ignoring any unknown id). Applied during continue only.
   */
  setExceptionBreakpoints(args: {
    filters?: string[];
  }): {breakpoints: DebugProtocol.Breakpoint[]} {
    const state = this.#require();
    state.exceptionFilters = new Set(
      (args.filters ?? []).filter((f) => EXCEPTION_FILTER_IDS.has(f)),
    );
    return {breakpoints: []};
  }

  /**
   * The active filter id tripped by `stepIndex`'s opcode, or `undefined`. Only an
   * ENABLED filter matches (so a category with its toggle off never stops).
   */
  #exceptionFilterAt(state: LaunchedState, stepIndex: number): string | undefined {
    if (state.exceptionFilters.size === 0) return undefined;
    const step = state.steps[stepIndex];
    if (step === undefined) return undefined;
    const filter = OP_TO_EXCEPTION_FILTER.get(step.op);
    return filter !== undefined && state.exceptionFilters.has(filter)
      ? filter
      : undefined;
  }

  /**
   * The nearest step in `dir` from `origin` (exclusive) whose opcode trips an
   * active exception filter, or `undefined` when none is enabled / reachable.
   */
  #nextExceptionStop(
    state: LaunchedState,
    origin: number,
    dir: 1 | -1,
  ): number | undefined {
    if (state.exceptionFilters.size === 0) return undefined;
    for (let j = origin + dir; j >= 0 && j <= state.model.last; j += dir) {
      if (this.#exceptionFilterAt(state, j) !== undefined) return j;
    }
    return undefined;
  }

  /** Map an incoming breakpoint source path to the relative build-info path. */
  #normalizeBreakpointPath(path: string): string {
    const root = this.#state?.inputs.sourceRoot;
    if (root !== undefined && root !== '' && nodePath.isAbsolute(path)) {
      const rel = nodePath.relative(root, path).split(nodePath.sep).join('/');
      // Only accept a path that stays within the root (no leading '..').
      if (!rel.startsWith('..')) return rel;
    }
    return path;
  }

  /**
   * Step over. At `instruction` granularity (Disassembly View) this is a single
   * EVM opcode, running any external subcall to completion; otherwise a statement
   * step that does not descend into internal calls.
   */
  next(args?: StepArgs): Record<string, never> {
    const state = this.#require();
    state.step = isInstruction(args)
      ? state.model.nextInstruction(state.step)
      : state.model.next(state.step);
    this.#stop('step');
    return {};
  }

  /** Step into. At `instruction` granularity, a single EVM opcode forward. */
  stepIn(args?: StepArgs): Record<string, never> {
    const state = this.#require();
    state.step = isInstruction(args)
      ? Math.min(state.step + 1, state.model.last)
      : state.model.stepIn(state.step);
    this.#stop('step');
    return {};
  }

  /** Step out of the current call (statement- or instruction-granular). */
  stepOut(args?: StepArgs): Record<string, never> {
    const state = this.#require();
    state.step = isInstruction(args)
      ? state.model.stepOutInstruction(state.step)
      : state.model.stepOut(state.step);
    this.#stop('step');
    return {};
  }

  /** Reverse step. At `instruction` granularity, a single EVM opcode backward. */
  stepBack(args?: StepArgs): Record<string, never> {
    const state = this.#require();
    state.step = isInstruction(args)
      ? Math.max(state.step - 1, 0)
      : state.model.stepBack(state.step);
    this.#stop('step');
    return {};
  }

  /** Single EVM instruction forward (clamped to the terminal step). */
  stepInstruction(_args?: {threadId?: number}): Record<string, never> {
    const state = this.#require();
    state.step = Math.min(state.step + 1, state.model.last);
    this.#stop('step');
    return {};
  }

  /** Single EVM instruction backward (clamped to step 0). */
  stepBackInstruction(_args?: {threadId?: number}): Record<string, never> {
    const state = this.#require();
    state.step = Math.max(state.step - 1, 0);
    this.#stop('step');
    return {};
  }

  /**
   * Run forward to the nearest stop — a source-line breakpoint, an instruction
   * breakpoint, OR an enabled exception filter (a "dynamic" breakpoint like
   * stop-on-call) — whichever comes first, else the terminal step.
   */
  continue(_args?: {threadId?: number}): Record<string, never> {
    const {target, reason} = this.#runToStop(this.#require(), 1);
    this.#require().step = target;
    this.#stop(reason);
    return {};
  }

  /**
   * Run backward to the nearest stop of the same three kinds, else to step 0.
   */
  reverseContinue(_args?: {threadId?: number}): Record<string, never> {
    const {target, reason} = this.#runToStop(this.#require(), -1);
    this.#require().step = target;
    this.#stop(reason);
    return {};
  }

  /**
   * The nearest stop from the current step in direction `dir`, folding the three
   * stop kinds (source-line, instruction, exception filter) into one target and a
   * `stopped` reason. A revert filter reports `'exception'`; every other stop
   * reports `'breakpoint'`; running to the end/start reports `'step'`.
   */
  #runToStop(
    state: LaunchedState,
    dir: 1 | -1,
  ): {target: number; reason: string} {
    const bps = this.#breakpointMap(state);
    const srcTarget =
      dir === 1
        ? state.model.continue(state.step, bps)
        : state.model.reverseContinue(state.step, bps);
    const candidates = [srcTarget];
    const instrTarget = this.#nextInstructionStop(state, state.step, dir);
    if (instrTarget !== undefined) candidates.push(instrTarget);
    const excTarget = this.#nextExceptionStop(state, state.step, dir);
    if (excTarget !== undefined) candidates.push(excTarget);
    const target = dir === 1 ? Math.min(...candidates) : Math.max(...candidates);

    const filter = this.#exceptionFilterAt(state, target);
    let reason = 'step';
    if (filter !== undefined) {
      reason = filter === 'break-on-revert' ? 'exception' : 'breakpoint';
    } else if (
      state.model.isArmedStop(target, bps) ||
      this.#isInstructionStop(state, target)
    ) {
      reason = 'breakpoint';
    }
    return {target, reason};
  }

  /** The single execution thread. */
  threads(): {threads: DebugProtocol.Thread[]} {
    return {threads: [{id: 1, name: 'main'}]};
  }

  /**
   * The EVM-depth call stack at the current step, TOP-FIRST (innermost frame
   * first). A single frame at a depth-1 position; two frames across an external
   * call (callee over caller).
   */
  stackTrace(): {stackFrames: DebugProtocol.StackFrame[]; totalFrames: number} {
    const state = this.#require();
    const frames = this.#currentFrames();
    const stackFrames: DebugProtocol.StackFrame[] = [...frames]
      .reverse()
      .map((f) => ({
        id: f.id,
        name: f.name,
        source: this.#frameSource(f),
        line: f.line,
        column: f.column,
        // Enables "Open Disassembly View": packs (codeAddress, pc, isInit) so the
        // disassemble request recovers this frame's CORRECT code image (init vs
        // runtime) and anchor position.
        instructionPointerReference: encodeInstructionAddress(
          f.address,
          state.steps[f.stepIndex]?.pc ?? 0,
          state.steps[f.stepIndex]?.isInitCode ?? false,
        ),
      }));
    return {stackFrames, totalFrames: stackFrames.length};
  }

  /**
   * Build the DAP `Source` for a frame. The source text lives in the build-info
   * (relative paths; possibly recompiled and not on the client's disk), so we
   * expose it through a `sourceReference` served by {@link source} — keeping the
   * relative `path` as the identity that breakpoints and the stepping model share.
   */
  #frameSource(frame: FrameInfo): DebugProtocol.Source {
    return (
      this.#sourceFor(frame.cu, frame.path) ?? {
        // No matching SourceFile (unmapped/foreign step) — best-effort path only.
        name: frame.path.split('/').pop() ?? frame.path,
        path: frame.path,
      }
    );
  }

  /**
   * Build a DAP `Source` for a `(cu, sourcePath)`, assigning/reusing a stable
   * `sourceReference` so the content is served via the `source` request. Returns
   * `undefined` when the CU has no such source file. Shared by frame sources and
   * per-instruction disassembly locations.
   */
  #sourceFor(
    cu: CompilationUnit,
    sourcePath: string,
  ): DebugProtocol.Source | undefined {
    const file = cu.sourceByPath(sourcePath);
    if (file === undefined) return undefined;
    const name = sourcePath.split('/').pop() ?? sourcePath;

    // LOCAL launch: if the file exists on disk under the project root, reference
    // the REAL file (no sourceReference) so VSCode opens the editable document
    // and gutter breakpoints work. `setBreakpoints` maps the absolute path back
    // to this relative one for the stepping model.
    const root = this.#state?.inputs.sourceRoot;
    if (root !== undefined && root !== '') {
      const abs = nodePath.resolve(root, sourcePath);
      if (existsSync(abs)) {
        return {name, path: abs};
      }
    }

    // Otherwise serve the build-info content via the `source` request: `path`
    // stays the relative build-info path (breakpoint/model identity) and the
    // `sourceReference` makes VSCode fetch content.
    let ref = this.#sourceRefs.get(file);
    if (ref === undefined) {
      ref = this.#sourceRefSeq++;
      this.#sourceRefs.set(file, ref);
      this.#sourceByRef.set(ref, file);
    }
    return {name, path: sourcePath, sourceReference: ref};
  }

  /**
   * Serve the content for a `sourceReference` handed out by {@link stackTrace}.
   * Answers the DAP `source` request (VSCode issues it for any frame source that
   * carries a non-zero `sourceReference`).
   */
  source(sourceReference: number): {content: string; mimeType?: string} {
    const file = this.#sourceByRef.get(sourceReference);
    if (file === undefined) {
      throw new Error(`unknown sourceReference: ${sourceReference}`);
    }
    return {content: file.content, mimeType: 'text/x-solidity'};
  }

  /**
   * Disassemble EVM bytecode for the Disassembly View. `memoryReference` packs
   * `(codeAddress, pc)` (see {@link encodeInstructionAddress}) — we recover the
   * contract, disassemble its runtime bytecode (cached), anchor at the requested
   * pc, and return exactly `instructionCount` instructions from
   * `anchor + instructionOffset`, each carrying its source location when mapped.
   * Out-of-range positions are padded with `invalid` placeholders so the count
   * (and VSCode's paging) stays consistent at code boundaries.
   */
  disassemble(args: {
    memoryReference: string;
    offset?: number;
    instructionOffset?: number;
    instructionCount: number;
  }): {instructions: DebugProtocol.DisassembledInstruction[]} {
    const state = this.#require();
    const {codeAddress, pc: refPc, isInit} = decodeInstructionAddress(
      args.memoryReference,
    );
    const pc0 = refPc + (args.offset ?? 0);
    const {contract, cu} =
      state.registry.get(codeAddress) ?? state.entryResolution;
    const {list, pcToIndex} = this.#disassemblyFor(contract, isInit);

    // Anchor = the instruction at pc0, else the last instruction starting ≤ pc0.
    let anchor = pcToIndex.get(pc0);
    if (anchor === undefined) {
      anchor = 0;
      for (let i = 0; i < list.length; i++) {
        if (list[i]!.pc <= pc0) anchor = i;
        else break;
      }
    }

    const start = anchor + (args.instructionOffset ?? 0);
    const instructions: DebugProtocol.DisassembledInstruction[] = [];
    for (let k = 0; k < args.instructionCount; k++) {
      const i = start + k;
      const instr = list[i];
      if (instr !== undefined) {
        const entry: DebugProtocol.DisassembledInstruction = {
          address: encodeInstructionAddress(codeAddress, instr.pc, isInit),
          instructionBytes: spacedHex(instr.bytes),
          instruction: instr.asm,
        };
        const pos = this.#resolvePosition(contract, cu, instr.pc, isInit);
        if (pos !== undefined) {
          const src = this.#sourceFor(cu, pos.path);
          if (src !== undefined) {
            entry.location = src;
            entry.line = pos.line;
            entry.column = pos.col + 1;
          }
        }
        instructions.push(entry);
      } else {
        // Before the first / past the last instruction — synthesize an ordered
        // address so paging stays monotonic, marked invalid.
        const lastPc = list.length > 0 ? list[list.length - 1]!.pc : 0;
        const firstPc = list.length > 0 ? list[0]!.pc : 0;
        const virtualPc = i < 0 ? firstPc + i : lastPc + (i - (list.length - 1));
        instructions.push({
          address: encodeInstructionAddress(codeAddress, virtualPc, isInit),
          instruction: '(unknown)',
          presentationHint: 'invalid',
        });
      }
    }
    return {instructions};
  }

  /**
   * Disassemble a contract's code once (per image), then cache it. `isInit`
   * selects the constructor (init) image over the runtime image — a CREATE frame
   * executes init code with its OWN pc space, so disassembling runtime bytecode
   * there would show the wrong instructions and mis-anchor the pointer.
   */
  #disassemblyFor(
    contract: Contract,
    isInit: boolean,
  ): {list: EvmInstruction[]; pcToIndex: Map<number, number>} {
    let entry = this.#disasmCache.get(contract);
    if (entry === undefined) {
      entry = {};
      this.#disasmCache.set(contract, entry);
    }
    const key = isInit ? 'init' : 'runtime';
    let cached = entry[key];
    if (cached === undefined) {
      const bytecode = isInit
        ? contract.initBytecode()
        : contract.runtimeBytecode();
      const list = disassembleBytecode(bytecode);
      const pcToIndex = new Map<number, number>();
      list.forEach((instr, i) => pcToIndex.set(instr.pc, i));
      cached = {list, pcToIndex};
      entry[key] = cached;
    }
    return cached;
  }

  /**
   * The variable scopes for `frameId`. Unoptimized frames expose
   * `State, Locals, EVM`; optimized frames omit `Locals` (locals are unreliable
   * under optimization) → `State, EVM`. Each scope gets a distinct
   * variablesReference bound to the frame.
   */
  scopes(frameId: number): {scopes: DebugProtocol.Scope[]} {
    const frames = this.#currentFrames();
    const frame = frames.find((f) => f.id === frameId) ?? frames[frames.length - 1];
    if (frame === undefined) {
      return {scopes: []};
    }

    const fid = frame.id;
    const scopes: DebugProtocol.Scope[] = [];
    scopes.push({
      name: 'State',
      variablesReference: this.#allocHandle({kind: 'State', frameId: fid}),
      expensive: false,
    });
    if (!frame.optimized) {
      scopes.push({
        name: 'Locals',
        variablesReference: this.#allocHandle({kind: 'Locals', frameId: fid}),
        expensive: false,
      });
    }
    const storageRef = this.#allocHandle({kind: 'EVMStorage', frameId: fid});
    const memoryRef = this.#allocHandle({kind: 'EVMMemory', frameId: fid});
    scopes.push({
      name: 'EVM',
      variablesReference: this.#allocHandle({
        kind: 'EVM',
        frameId: fid,
        storageRef,
        memoryRef,
      }),
      expensive: true,
    });
    // A read-only Events scope, appended LAST on EVERY frame (optimized
    // included — event decoding scans LOG ops + ABI, not the stack analysis the
    // optimized no-Locals fallback disables).
    scopes.push({
      name: 'Events',
      variablesReference: this.#allocHandle({kind: 'Events', frameId: fid}),
      expensive: false,
    });
    return {scopes};
  }

  /** Variables for a scope reference, read through the real ethdebug pointer path. */
  async variables(
    variablesReference: number,
  ): Promise<{variables: DebugProtocol.Variable[]}> {
    const handle = this.#handles.get(variablesReference);
    if (handle === undefined) {
      return {variables: []};
    }
    // Events are GLOBAL (all contracts, chronological, up to the current step) —
    // resolved WITHOUT a frame, so they render even at a frameless position.
    if (handle.kind === 'Events') {
      return {variables: this.#eventsVariables()};
    }
    if (handle.kind === 'Event') {
      return {variables: this.#eventChildren(handle.eventIndex ?? 0)};
    }
    // Re-resolve the frame against the CURRENT step (by id, falling back to the
    // deepest frame if that depth is no longer live). A synthetic contract frame
    // (an expanded address) is resolved from its own registry first.
    const frames = this.#currentFrames();
    const frame =
      this.#contractFrames.get(handle.frameId) ??
      frames.find((f) => f.id === handle.frameId) ??
      frames[frames.length - 1];
    if (frame === undefined) {
      return {variables: []};
    }
    switch (handle.kind) {
      case 'State':
        return {variables: await this.#stateVariables(frame)};
      case 'Locals':
        return {variables: await this.#localVariables(frame)};
      case 'EVM':
        return {
          variables: this.#evmVariables(
            frame,
            handle.storageRef!,
            handle.memoryRef!,
          ),
        };
      case 'EVMStorage':
        return {variables: this.#evmStorageVariables(frame)};
      case 'EVMMemory':
        return {variables: this.#evmMemoryVariables(frame)};
      case 'Complex':
        return {
          variables: await this.#complexVariables(
            frame,
            handle.varName!,
            handle.complexKind ?? 'local',
          ),
        };
    }
  }

  /** Tear down; leaves the session inert. */
  disconnect(): void {
    this.#state = undefined;
    this.#handles.clear();
    this.#sourceRefs.clear();
    this.#sourceByRef.clear();
    this.#contractFrames.clear();
    this.#disasmCache.clear();
    this.#indexCache.clear();
    this.#programCache.clear();
    this.#varCache.clear();
  }

  // ─── frame reconstruction ──────────────────────────────────────────────────

  /**
   * Fold the trace up to the current step, maintaining a frame stack indexed by
   * EVM depth: each step overwrites `frame[depth-1]` (address + pc), pushing on
   * depth increase and popping on decrease. The parent frames retain their last
   * pc — the CALL site — because only the deepest frame is rewritten per step.
   */
  #currentFrames(): FrameInfo[] {
    const state = this.#require();
    const {steps, step} = state;
    if (steps.length === 0) return [];

    // Fold: record (address, stepIndex) at each depth up to `step`.
    const stack: {address: string; stepIndex: number; depth: number}[] = [];
    for (let i = 0; i <= step && i < steps.length; i++) {
      const depth = steps[i]!.depth;
      const address = addressHex(steps[i]!.codeAddress);
      stack[depth - 1] = {address, stepIndex: i, depth};
      stack.length = depth; // pop any frames deeper than the current depth
    }

    return stack.map((f, i) => this.#buildFrame(f.depth, f.address, f.stepIndex, i + 1));
  }

  /** Resolve a single frame's contract + source position (with in-frame fallback). */
  #buildFrame(
    depth: number,
    address: string,
    stepIndex: number,
    id: number,
  ): FrameInfo {
    const state = this.#require();
    const resolution = state.registry.get(address) ?? state.entryResolution;
    const {contract, cu, optimized} = resolution;

    // A CREATE frame runs constructor (init) code → resolve against the init map.
    const isInit = state.steps[stepIndex]!.isInitCode;

    // Resolve the position at the frame's pc; if unmapped, walk back within the
    // SAME frame (same depth + address) to the nearest mapped step.
    let pos = this.#resolvePosition(
      contract,
      cu,
      state.steps[stepIndex]!.pc,
      isInit,
    );
    for (
      let j = stepIndex - 1;
      pos === undefined &&
      j >= 0 &&
      state.steps[j]!.depth === depth &&
      addressHex(state.steps[j]!.codeAddress) === address;
      j--
    ) {
      pos = this.#resolvePosition(contract, cu, state.steps[j]!.pc, isInit);
    }

    // A constructor (init) frame has no function NAME in the AST, so label it by
    // its contract; a named function uses its own name; else the contract name.
    const fnName = pos?.fnNode?.name;
    const name = isInit
      ? `${contract.name}.constructor`
      : fnName !== undefined && fnName !== ''
        ? fnName
        : contract.name;

    return {
      id,
      depth,
      address,
      contract,
      cu,
      optimized,
      stepIndex,
      path: pos?.path ?? contract.sourcePath,
      line: pos?.line ?? 0,
      column: pos !== undefined ? pos.col + 1 : 1,
      name,
      fnNode: pos?.fnNode,
    };
  }

  /**
   * Render an address/contract-typed VALUE. When the address resolves to a known
   * contract, show `<ContractName> (0x…)` and make it EXPANDABLE — a nested
   * variable whose children are that contract's storage fields at the current
   * step (via a synthetic frame). A plain / unknown / zero address stays a scalar.
   */
  #renderContractAddress(
    name: string,
    field: bigint,
    typeLabel: string | undefined,
  ): DebugProtocol.Variable {
    const addr = addressHex(field & ((1n << 160n) - 1n));
    const zero = '0x' + '0'.repeat(40);
    const resolution =
      addr !== zero ? this.#state?.registry.get(addr) : undefined;
    if (resolution !== undefined) {
      const synthetic = this.#syntheticContractFrame(addr, resolution);
      const ref = this.#allocHandle({kind: 'State', frameId: synthetic.id});
      return {
        name,
        value: `${resolution.contract.name} (${addr})`,
        type: typeLabel,
        variablesReference: ref,
      };
    }
    return {name, value: addr, type: typeLabel, variablesReference: 0};
  }

  /**
   * Build (and register) a synthetic frame standing for a CONTRACT AT `address`,
   * positioned at the CURRENT step so its storage reads reflect "now". Reused by
   * the whole storage-rendering path via {@link #contractFrames}.
   */
  #syntheticContractFrame(
    address: string,
    resolution: StepResolution,
  ): FrameInfo {
    const state = this.#require();
    const id = this.#syntheticFrameSeq;
    this.#syntheticFrameSeq -= 1;
    const frame: FrameInfo = {
      id,
      depth: 0,
      address,
      contract: resolution.contract,
      cu: resolution.cu,
      optimized: resolution.optimized,
      stepIndex: state.step,
      path: resolution.contract.sourcePath,
      line: 0,
      column: 1,
      name: resolution.contract.name,
      fnNode: undefined,
    };
    this.#contractFrames.set(id, frame);
    return frame;
  }

  /** Whether a solc type holds an address (a plain `address` or a contract ref). */
  #isAddressType(solcType: string): boolean {
    return solcType.startsWith('t_address') || solcType.startsWith('t_contract');
  }

  /** Resolve `(contract, cu, pc)` to a source position + enclosing function node. */
  #resolvePosition(
    contract: Contract,
    cu: CompilationUnit,
    pc: number,
    isInit = false,
  ):
    | {
        path: string;
        line: number;
        col: number;
        offset: number;
        fnNode: AstNode | undefined;
      }
    | undefined {
    const {pcToInstruction, sourceMap} = this.#indexFor(contract, isInit);
    const instruction = pcToInstruction.get(pc);
    if (instruction === undefined) return undefined;
    const entry = sourceMap[instruction];
    if (entry === undefined || entry.fileId < 0) return undefined;
    const source = cu.sourceById(entry.fileId);
    if (source === undefined) return undefined;
    const p = source.offsetToPosition(entry.start);
    const node = findInnermostNode(source.ast(), entry.start, entry.length);
    const fnNode = node !== undefined ? closestFunction(node) : undefined;
    return {
      path: source.path,
      line: p.line,
      col: p.column,
      offset: entry.start,
      fnNode,
    };
  }

  #indexFor(
    contract: Contract,
    isInit = false,
  ): {
    pcToInstruction: Map<number, number>;
    sourceMap: SourceMapEntry[];
  } {
    const cache = isInit ? this.#initIndexCache : this.#indexCache;
    let idx = cache.get(contract);
    if (idx === undefined) {
      idx = {
        pcToInstruction: buildInstructionIndex(
          isInit ? contract.initBytecode() : contract.runtimeBytecode(),
        ).pcToInstruction,
        sourceMap: isInit
          ? contract.initSourceMap()
          : contract.runtimeSourceMap(),
      };
      cache.set(contract, idx);
    }
    return idx;
  }

  // ─── registry construction ─────────────────────────────────────────────────

  /**
   * Pick the contract within a single (address-mapped) CU. Prefer the
   * caller-supplied `contractName`; else the SOLE contract with non-empty runtime
   * bytecode (interfaces/abstracts have empty bytecode → skipped); else CBOR-match
   * the trace's per-step code at `traceIdx` if one is available (kontrol).
   */
  #pickContract(
    cu: CompilationUnit,
    contractName: string | undefined,
    cursor: StateCursor,
    traceIdx: number | undefined,
  ): Contract | undefined {
    if (contractName !== undefined) {
      const byName = cu.contracts().find((c) => c.name === contractName);
      if (byName !== undefined) return byName;
    }
    const deployable = cu
      .contracts()
      .filter((c) => c.runtimeBytecode().length > 2);
    if (deployable.length === 1) return deployable[0];
    if (traceIdx !== undefined) {
      const contract = identifyContractByRuntimeCode(cu, cursor.at(traceIdx).bytecode);
      if (contract !== undefined) return contract;
    }
    return undefined;
  }

  /** Identify a runtime code across all CUs (CBOR metadata), first match wins. */
  #identify(cus: CompilationUnit[], code: Hex): StepResolution | undefined {
    for (const cu of cus) {
      const contract = identifyContractByRuntimeCode(cu, code);
      if (contract !== undefined) {
        return {contract, cu, optimized: cu.optimizer().enabled};
      }
    }
    return undefined;
  }

  /**
   * Resolve the entry/launch contract: by CBOR against the entry frame's runtime
   * code, else by the launch `contractName` scanned across the loaded CUs.
   */
  #resolveEntry(
    inputs: LaunchInputs,
    cus: CompilationUnit[],
    steps: Step[],
    cursor: StateCursor,
  ): StepResolution {
    const entryAddr = inputs.codeAddress.toLowerCase();
    const entryStep = steps.findIndex(
      (s) => addressHex(s.codeAddress) === entryAddr,
    );
    if (entryStep >= 0) {
      const byCbor = this.#identify(cus, cursor.at(entryStep).bytecode);
      if (byCbor !== undefined) return byCbor;
    }
    for (const cu of cus) {
      const contract = cu.contract(inputs.sourcePath, inputs.contractName);
      if (contract !== undefined) {
        return {contract, cu, optimized: cu.optimizer().enabled};
      }
    }
    throw new Error(
      `contract not found: ${inputs.sourcePath}:${inputs.contractName}`,
    );
  }

  // ─── variable readers (per frame) ──────────────────────────────────────────

  /**
   * Read the frame contract's storage variables, extracting each PACKED field
   * from its slot word and decoding it by solc type against the frame's own
   * storage account.
   */
  async #stateVariables(frame: FrameInfo): Promise<DebugProtocol.Variable[]> {
    const state = this.#require();
    const {contract, cu, address, stepIndex} = frame;
    let program = this.#programCache.get(contract);
    if (program === undefined) {
      program = generateEthdebugProgram(cu, contract.sourcePath, contract.name);
      this.#programCache.set(contract, program);
    }
    const ms = machineStateFor(state.cursor.at(stepIndex), address);
    const variables: DebugProtocol.Variable[] = [];
    for (const sv of program.storageVariables) {
      // A dynamic-array / value-struct storage var is rendered as a
      // NESTED variable via the SHARED complex-render routine — the only
      // difference from the memory path is `location:'storage'` inside the
      // pointers; dereference + child decode are identical.
      if (
        sv.array !== undefined ||
        (sv.members !== undefined && sv.members.length > 0)
      ) {
        variables.push(
          await this.#renderComplex(
            frame,
            cu,
            {
              name: sv.name,
              typeLabel: sv.solcType,
              array: sv.array,
              members: sv.members,
            },
            ms,
            'state',
          ),
        );
        continue;
      }

      // A mapping storage var carries a `mapping` descriptor. Keys are
      // not enumerable statically — the shared complex-render routine enumerates
      // observed keys from the trace (keccak-preimage scan) and reads each value
      // slot, rendering the mapping as a NESTED variable {key: value, …}.
      if (sv.mapping !== undefined) {
        variables.push(
          await this.#renderComplex(
            frame,
            cu,
            {name: sv.name, typeLabel: sv.solcType, mapping: sv.mapping},
            ms,
            'state',
          ),
        );
        continue;
      }

      // A dynamic string/bytes storage var carries a `bytesStorage`
      // descriptor (value types have none, so branching on its presence isolates
      // this case). The producer supplies the LAYOUT (flag word + static keccak
      // base); the session owns the runtime encoding RULES (length/parity select,
      // high-byte inline slice, multi-word long trim) — analogous to the packed
      // value-field extraction below — and renders a SCALAR.
      if (sv.bytesStorage !== undefined) {
        const {flagPointer, longBaseSlot, isString} = sv.bytesStorage;
        const flagWord = await readPointerValue(flagPointer, ms);
        const lowByte = flagWord & 0xffn;
        let dataHex: string;
        if (lowByte % 2n === 0n) {
          // SHORT: data stored INLINE in the HIGH `len` bytes; length = lowByte/2.
          const len = Number(lowByte / 2n);
          dataHex = flagWord.toString(16).padStart(64, '0').slice(0, len * 2);
        } else {
          // LONG: length = (flagWord-1)/2; data in `ceil(len/32)` consecutive words
          // starting at the static keccak base slot.
          const len = Number((flagWord - 1n) / 2n);
          const wordCount = Math.ceil(len / 32);
          const words =
            wordCount > 0
              ? await readStorageWords(BigInt(longBaseSlot), wordCount, ms)
              : [];
          const allHex = words
            .map((w) => w.toString(16).padStart(64, '0'))
            .join('');
          dataHex = allHex.slice(0, len * 2);
        }
        const storageType = contract.storageType(sv.solcType);
        const value = isString
          ? `"${Buffer.from(dataHex, 'hex').toString('utf8')}"`
          : '0x' + dataHex;
        variables.push({
          name: sv.name,
          value,
          type: storageType?.label,
          variablesReference: 0,
        });
        continue;
      }

      // Value-type storage: UNCHANGED packed-word extraction (word >> offset & mask).
      const word = await readPointerValue(
        {location: 'storage', slot: sv.slot, offset: 0, length: 32},
        ms,
      );
      const field =
        (word >> BigInt(8 * sv.offset)) & ((1n << BigInt(8 * sv.length)) - 1n);

      const storageType = contract.storageType(sv.solcType);
      // An address/contract-typed field can be expanded into the contract living
      // at that address (its storage fields).
      if (this.#isAddressType(sv.solcType)) {
        variables.push(
          this.#renderContractAddress(sv.name, field, storageType?.label),
        );
        continue;
      }
      const ctx: DecodeContext = {label: storageType?.label};
      if (sv.solcType.startsWith('t_enum')) {
        const enumId = enumAstId(sv.solcType);
        const node =
          enumId !== undefined ? this.#nodeById(cu, enumId) : undefined;
        ctx.memberNames = node?.memberNames();
        ctx.enumName = node?.name;
      }

      const {value, type} = decodeValue(field, sv.solcType, sv.length, ctx);
      variables.push({name: sv.name, value, type, variablesReference: 0});
    }
    return variables;
  }

  /**
   * Read the current frame function's live VALUE-TYPE params + locals.
   *
   * All variable LAYOUT is delegated to `variablesAt` (`@simbolik/ethdebug-gen`),
   * the single static source of truth for "what is live here and where its bytes
   * live". This method holds NO param/local location math: it takes the resolved
   * entries with a concrete pointer, dereferences each through the real ethdebug
   * path (`readPointerValue`/`machineStateFor`), and decodes. Reference/dynamic
   * variables have no pointer and are skipped (as before).
   */
  async #localVariables(frame: FrameInfo): Promise<DebugProtocol.Variable[]> {
    const state = this.#require();
    const {cu, address} = frame;

    // Read at the frame's live body position: a frame parked at its function
    // epilogue (e.g. after `continue` runs to the terminal STOP) has already
    // unwound its params/locals off the stack, so `variablesAt` correctly gives
    // them no pointer there. Walk back to the last in-body statement step of the
    // same occurrence — pure trace reconstruction, no variable-location math.
    const stepIndex = this.#localReadStep(frame);
    const pc = state.steps[stepIndex]!.pc;
    const vars = this.#variablesFor(frame, pc);
    const ms = machineStateFor(state.cursor.at(stepIndex), address);

    const variables: DebugProtocol.Variable[] = [];
    for (const v of vars) {
      if (v.kind !== 'parameter' && v.kind !== 'return' && v.kind !== 'local') {
        continue; // storage lives in another scope.
      }
      // A reference-type COMPLEX variable — a memory STRUCT (`members`)
      // or a DYNAMIC memory ARRAY (`array`) — is surfaced as a NESTED variable via
      // the SHARED complex-render routine (children decoded on handle expansion).
      if (
        (v.members !== undefined && v.members.length > 0) ||
        v.array !== undefined
      ) {
        variables.push(
          await this.#renderComplex(
            frame,
            cu,
            {
              name: v.name,
              typeLabel: v.typeLabel,
              array: v.array,
              members: v.members,
            },
            ms,
            'local',
          ),
        );
        continue;
      }
      // A memory STRING / BYTES carries a `bytes` layout — a SCALAR value.
      if (v.bytes !== undefined) {
        const hex = await readPointerBytes(v.bytes.pointer, ms);
        const value = v.bytes.isString
          ? `"${Buffer.from(hex.slice(2), 'hex').toString('utf8')}"`
          : hex;
        variables.push({name: v.name, value, type: v.typeLabel, variablesReference: 0});
        continue;
      }
      if (v.pointer === undefined) {
        continue; // a reference/dynamic var still deferred (no pointer, no members).
      }
      const field = await readPointerValue(v.pointer, ms);
      if (this.#isAddressType(v.solcType)) {
        variables.push(this.#renderContractAddress(v.name, field, v.typeLabel));
        continue;
      }
      const {value, type} = this.#decodeField(
        cu,
        field,
        v.solcType,
        v.typeLabel,
        v.numberOfBytes,
      );
      variables.push({name: v.name, value, type, variablesReference: 0});
    }
    return variables;
  }

  /**
   * Render a reference-type COMPLEX variable (a memory struct / memory array /
   * storage array+struct) as a NESTED DAP variable: allocate a `Complex`
   * handle (children decoded on expansion via {@link #complexVariables}) and build
   * a one-line preview. SHARED by the memory (`#localVariables`) and storage
   * (`#stateVariables`) paths — the only difference is `complexKind` (where the
   * parent is re-resolved) and `location` inside the pointers; the preview
   * dereference is identical.
   */
  async #renderComplex(
    frame: FrameInfo,
    cu: CompilationUnit,
    v: {
      name: string;
      typeLabel: string;
      array?: ArrayLayout;
      members?: StructMember[];
      mapping?: MappingLayout;
    },
    ms: import('@ethdebug/pointers').Machine.State,
    complexKind: 'local' | 'state',
  ): Promise<DebugProtocol.Variable> {
    const ref = this.#allocHandle({
      kind: 'Complex',
      frameId: frame.id,
      varName: v.name,
      complexKind,
    });
    let value: string;
    if (v.array !== undefined) {
      const {array} = v;
      const words = await readPointerRegions(array.pointer, ms);
      // Decode each element for the preview the SAME way its child is decoded
      // (normalize the full word to the element type first), so it matches the
      // expanded children for narrow / `bytesN` element types too.
      const values = words.map((word) => {
        const field = fieldFromAbiWord(
          word,
          array.elementSolcType,
          array.elementNumberOfBytes,
        );
        return this.#decodeField(
          cu,
          field,
          array.elementSolcType,
          array.elementTypeLabel,
          array.elementNumberOfBytes,
        ).value;
      });
      value = `[${values.join(', ')}]`;
    } else if (v.mapping !== undefined) {
      // Preview the observed entries the SAME way the children are
      // decoded — `{key: value, …}` in first-seen order.
      const entries = await this.#mappingEntries(frame, v.mapping, ms);
      value = `{${entries.map((e) => `${e.name}: ${e.value}`).join(', ')}}`;
    } else {
      value = structSummary(v.typeLabel);
    }
    return {name: v.name, value, type: v.typeLabel, variablesReference: ref};
  }

  /**
   * The OBSERVED entries of a storage mapping at the frame's step, each a decoded
   * `{name: key, value, type}`. Enumeration + keccak arithmetic live in
   * `./mappings.js` (trace scan + `keccak256(key‖slot)` value slot); this only
   * reads each value slot through the real storage path + decodes by value type.
   * SHARED by the preview ({@link #renderComplex}) and the children
   * ({@link #complexVariables}) so both stay in lock-step.
   */
  async #mappingEntries(
    frame: FrameInfo,
    mapping: MappingLayout,
    ms: import('@ethdebug/pointers').Machine.State,
  ): Promise<{name: string; value: string; type: string}[]> {
    const state = this.#require();
    const {cu, contract} = frame;
    // Bounded by the frame's own step: a key touched later must not appear here.
    const keys = enumerateMappingKeys(
      state.steps,
      state.cursor,
      mapping.baseSlot,
      frame.stepIndex,
    );
    const keyType = contract.storageType(mapping.keyType);
    const valueType = contract.storageType(mapping.valueType);
    const keyBytes = keyType?.numberOfBytes ?? 32;
    const valueBytes = valueType?.numberOfBytes ?? 32;
    const base = BigInt(mapping.baseSlot);
    const entries: {name: string; value: string; type: string}[] = [];
    for (const key of keys) {
      const valueSlot = mappingValueSlot(key, base);
      const word = await readPointerValue(
        {
          location: 'storage',
          // A `0x`-hex literal slot: pad to a full 32-byte word so the huge
          // keccak-derived slot parses (odd-length hex misparses) and matches
          // the account's storage key.
          slot: `0x${valueSlot.toString(16).padStart(64, '0')}`,
          offset: 0,
          length: 32,
        },
        ms,
      );
      const field = fieldFromAbiWord(word, mapping.valueType, valueBytes);
      const {value, type} = this.#decodeField(
        cu,
        field,
        mapping.valueType,
        valueType?.label ?? mapping.valueType.replace(/^t_/, ''),
        valueBytes,
      );
      // The key is the raw preimage word0. Normalize it to the key type's own
      // bytes (exactly as the value is via `fieldFromAbiWord`) BEFORE decoding the
      // child NAME: right-aligned key types (uint/int/address/bool/enum) are a
      // no-op, but a LEFT-aligned `bytesN` (N<32) key must be sliced down to its
      // high N bytes and a negative `intN` key masked to its width — otherwise the
      // raw 32-byte word renders as `0xdeadbeef000…0` / a huge positive int. (The
      // VALUE SLOT above still hashes the RAW `key` word0, which reproduces the
      // trace preimage verbatim for every 32-byte-padded key type.)
      const keyField = fieldFromAbiWord(key, mapping.keyType, keyBytes);
      const {value: name} = this.#decodeField(
        cu,
        keyField,
        mapping.keyType,
        keyType?.label ?? mapping.keyType.replace(/^t_/, ''),
        keyBytes,
      );
      entries.push({name, value, type});
    }
    return entries;
  }

  /**
   * Decode the children of a nested COMPLEX variable, re-resolving its static
   * layout against the CURRENT step (like every handle) then dereferencing +
   * decoding through the real ethdebug path. SHARED by memory and storage: for a
   * `'local'` handle the parent is re-resolved from `variablesAt` (at the live
   * body read step); for a `'state'` handle from `generateEthdebugProgram`'s
   * storage vars (storage is account state — persists — so the frame's own step
   * suffices). All offset/slot LAYOUT lives in `@simbolik/ethdebug-gen`; this only
   * dereferences + decodes + renders the nesting.
   */
  async #complexVariables(
    frame: FrameInfo,
    varName: string,
    complexKind: 'local' | 'state',
  ): Promise<DebugProtocol.Variable[]> {
    const state = this.#require();
    const {cu, contract, address} = frame;

    let parent:
      | {array?: ArrayLayout; members?: StructMember[]; mapping?: MappingLayout}
      | undefined;
    let ms: import('@ethdebug/pointers').Machine.State;
    if (complexKind === 'state') {
      let program = this.#programCache.get(contract);
      if (program === undefined) {
        program = generateEthdebugProgram(cu, contract.sourcePath, contract.name);
        this.#programCache.set(contract, program);
      }
      parent = program.storageVariables.find((sv) => sv.name === varName);
      ms = machineStateFor(state.cursor.at(frame.stepIndex), address);
    } else {
      const stepIndex = this.#localReadStep(frame);
      const pc = state.steps[stepIndex]!.pc;
      parent = this.#variablesFor(frame, pc).find((v) => v.name === varName);
      ms = machineStateFor(state.cursor.at(stepIndex), address);
    }
    if (parent === undefined) {
      return [];
    }

    // A DYNAMIC ARRAY — indexed children are the decoded elements.
    if (parent.array !== undefined) {
      const {array} = parent;
      const words = await readPointerRegions(array.pointer, ms);
      return words.map((word, i) => {
        // Each element region is a full 32-byte word; normalize it to the element
        // type's own bytes before decoding — a no-op for word-aligned right-aligned
        // types (uint256, address, …) but essential for narrow `intN` (sign bits)
        // and LEFT-aligned `bytesN` elements.
        const field = fieldFromAbiWord(
          word,
          array.elementSolcType,
          array.elementNumberOfBytes,
        );
        const {value, type} = this.#decodeField(
          cu,
          field,
          array.elementSolcType,
          array.elementTypeLabel,
          array.elementNumberOfBytes,
        );
        return {name: String(i), value, type, variablesReference: 0};
      });
    }

    // A MAPPING — children are the decoded observed entries.
    if (parent.mapping !== undefined) {
      const entries = await this.#mappingEntries(frame, parent.mapping, ms);
      return entries.map((e) => ({
        name: e.name,
        value: e.value,
        type: e.type,
        variablesReference: 0,
      }));
    }

    if (parent.members === undefined) {
      return [];
    }
    const variables: DebugProtocol.Variable[] = [];
    for (const member of parent.members) {
      if (member.pointer === undefined) {
        continue; // reference-type member: out of scope this cycle.
      }
      const field = await readPointerValue(member.pointer, ms);
      const {value, type} = this.#decodeField(
        cu,
        field,
        member.solcType,
        member.typeLabel,
        member.numberOfBytes,
      );
      variables.push({name: member.name, value, type, variablesReference: 0});
    }
    return variables;
  }

  /**
   * `variablesAt(frame.cu, …, pc)`, memoized per `(contract, pc)`. `variablesAt`
   * rebuilds the `stackHeights` analyzer on every call, so a stepping session
   * that re-reads the Locals scope at the same position would otherwise recompute
   * it each time. The cache is cleared in {@link disconnect}.
   */
  #variablesFor(frame: FrameInfo, pc: number): ResolvedVariable[] {
    let byPc = this.#varCache.get(frame.contract);
    if (byPc === undefined) {
      byPc = new Map<number, ResolvedVariable[]>();
      this.#varCache.set(frame.contract, byPc);
    }
    let vars = byPc.get(pc);
    if (vars === undefined) {
      vars = variablesAt(frame.cu, frame.contract.sourcePath, frame.contract.name, pc);
      byPc.set(pc, vars);
    }
    return vars;
  }

  /**
   * The step to read the frame's params/locals at. Normally the frame's own step,
   * but when the frame is parked at its function PROLOGUE/EPILOGUE (a step with no
   * enclosing body statement — e.g. the terminal STOP after `continue`), the
   * on-stack variables have already unwound. Walk back within the same frame
   * occurrence (same depth + address) to the last step that IS inside a body
   * statement, where the variables are still live. Statement-anchored trace
   * reconstruction only — no variable-location (slot/offset/rank) math.
   */
  #localReadStep(frame: FrameInfo): number {
    const state = this.#require();
    const {depth, address} = frame;
    let j = frame.stepIndex;
    while (
      j > 0 &&
      state.model.at(j).stmtId === undefined &&
      state.steps[j - 1]!.depth === depth &&
      addressHex(state.steps[j - 1]!.codeAddress) === address
    ) {
      j--;
    }
    return j;
  }

  /** Decode a raw stack/calldata `field` bigint by its solc type (+ enum ctx). */
  #decodeField(
    cu: CompilationUnit,
    field: bigint,
    solcType: string,
    typeLabel: string,
    numberOfBytes: number,
  ): {value: string; type: string} {
    const ctx: DecodeContext = {label: typeLabel};
    if (solcType === 't_enum') {
      const enumName = describeValueTypeString(typeLabel)?.enumName;
      if (enumName !== undefined) {
        const node = this.#findEnumNode(cu, enumName);
        ctx.memberNames = node?.memberNames();
        ctx.enumName = node?.name ?? enumName;
      }
    }
    return decodeValue(field, solcType, numberOfBytes, ctx);
  }

  /**
   * The raw EVM machine state at the frame's step: pc/op scalars plus expandable
   * memory + storage sub-views.
   */
  #evmVariables(
    frame: FrameInfo,
    storageRef: number,
    memoryRef: number,
  ): DebugProtocol.Variable[] {
    const state = this.#require();
    const ms = state.cursor.at(frame.stepIndex);
    return [
      {name: 'pc', value: String(ms.pc), variablesReference: 0},
      {name: 'op', value: ms.op, variablesReference: 0},
      {name: 'stack', value: `${ms.stack.length} items`, variablesReference: 0},
      {
        name: 'memory',
        value: `${ms.memory.length} words`,
        variablesReference: ms.memory.length > 0 ? memoryRef : 0,
      },
      {
        name: 'storage',
        value: `${this.#evmStorageVariables(frame).length} slots`,
        variablesReference: storageRef,
      },
      {name: 'calldata', value: ms.calldata, variablesReference: 0},
    ];
  }

  /** The touched storage slots of the frame's account, as `slot → 0x…word`. */
  #evmStorageVariables(frame: FrameInfo): DebugProtocol.Variable[] {
    const state = this.#require();
    const ms = state.cursor.at(frame.stepIndex);
    const account = ms.accounts.get(frame.address.toLowerCase());
    const variables: DebugProtocol.Variable[] = [];
    for (const [slot, word] of Object.entries(account?.storage ?? {})) {
      variables.push({
        name: slot,
        value: word.startsWith('0x') ? word : '0x' + word,
        variablesReference: 0,
      });
    }
    return variables;
  }

  /**
   * The frame's EVM memory as one row per 32-byte word: the name is the word's
   * BYTE offset, zero-padded to 4 hex digits for column alignment (`0x0000`,
   * `0x0020`, `0x0040`, …; it grows past 4 digits only beyond 64 KiB), and the
   * value the full word. Memory is word-addressed in the cursor; kontrol emits
   * bare (no-`0x`) words, so normalize the prefix. Empty memory yields no rows
   * (the parent shows `0 words`).
   */
  #evmMemoryVariables(frame: FrameInfo): DebugProtocol.Variable[] {
    const state = this.#require();
    const ms = state.cursor.at(frame.stepIndex);
    return ms.memory.map((word, i) => {
      const hex = word.startsWith('0x') ? word.slice(2) : word;
      return {
        name: '0x' + (i * 32).toString(16).padStart(4, '0'),
        value: '0x' + hex.padStart(64, '0'),
        variablesReference: 0,
      };
    });
  }

  // ─── events ──────────────────────────────────────────────────────────────

  /**
   * ALL events emitted across ALL contracts, in chronological (emission) order,
   * up to the CURRENT execution step — NOT tied to the selected frame. Each LOG
   * is decoded against the ABI of the contract that emitted it, resolved by its
   * executing code address through the address→contract registry (falling back to
   * the entry contract for the entry address). Bounded by `state.step` so an event
   * emitted later never appears while paused earlier (and reverse-stepping hides
   * it again).
   */
  #decodedEvents(): DecodedEvent[] {
    const state = this.#require();
    return enumerateAllEvents(
      state.steps,
      state.cursor,
      state.step,
      (codeAddress) => {
        const addr = addressHex(codeAddress);
        const resolution =
          state.registry.get(addr) ??
          (addr === state.inputs.codeAddress.toLowerCase()
            ? state.entryResolution
            : undefined);
        if (resolution === undefined) return undefined;
        return {
          defs: resolution.contract.events(),
          name: resolution.contract.name,
        };
      },
    );
  }

  /**
   * Render the global event log as NESTED variables: each event's name (a
   * `Name #k` suffix disambiguates repeats), a one-line preview over the decoded
   * args (prefixed with the emitting contract), and an `Event` handle whose
   * children are the decoded args.
   */
  #eventsVariables(): DebugProtocol.Variable[] {
    const decoded = this.#decodedEvents();
    const counts = new Map<string, number>();
    for (const e of decoded) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
    const seen = new Map<string, number>();

    return decoded.map((e, i) => {
      let name = e.name;
      if ((counts.get(e.name) ?? 0) > 1) {
        const k = seen.get(e.name) ?? 0;
        seen.set(e.name, k + 1);
        name = `${e.name} #${k}`;
      }
      const signature = `${e.name}(${e.args
        .map((a) => `${a.name}: ${a.value}`)
        .join(', ')})`;
      const value = e.emitter ? `${e.emitter}.${signature}` : signature;
      const ref = this.#allocHandle({kind: 'Event', frameId: -1, eventIndex: i});
      return {name, value, variablesReference: ref};
    });
  }

  /** The decoded args of the `eventIndex`-th global event as leaf variables. */
  #eventChildren(eventIndex: number): DebugProtocol.Variable[] {
    const event = this.#decodedEvents()[eventIndex];
    if (event === undefined) return [];
    return event.args.map((a) => ({
      name: a.name,
      value: String(a.value),
      type: a.typeLabel,
      variablesReference: 0,
    }));
  }

  // ─── helpers ───────────────────────────────────────────────────────────────

  /** Find an AST node by id anywhere in the CU's sources. */
  #nodeById(cu: CompilationUnit, id: number): AstNode | undefined {
    for (const source of cu.sources()) {
      const node = source.nodeById(id);
      if (node !== undefined) return node;
    }
    return undefined;
  }

  /** Find an `EnumDefinition` by simple name anywhere in the CU's sources. */
  #findEnumNode(cu: CompilationUnit, name: string): AstNode | undefined {
    for (const source of cu.sources()) {
      const node = findAstNode(
        source.ast(),
        (n) => n.nodeType === 'EnumDefinition' && n.name === name,
      );
      if (node !== undefined) return node;
    }
    return undefined;
  }

  /** Allocate a fresh variablesReference handle. */
  #allocHandle(handle: Handle): number {
    const ref = this.#handleSeq++;
    this.#handles.set(ref, handle);
    return ref;
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

  /** The requested breakpoint lines as a path → line-set map. */
  #breakpointMap(state: LaunchedState): Map<string, ReadonlySet<number>> {
    const map = new Map<string, ReadonlySet<number>>();
    for (const [path, lines] of state.breakpoints) {
      map.set(path, new Set(lines));
    }
    return map;
  }

  #require(): LaunchedState {
    if (this.#state === undefined) {
      throw new Error('session not launched');
    }
    return this.#state;
  }
}

/**
 * A one-line summary shown as a nested struct's own `value` (its children carry
 * the fields). Strips solc's `struct Contract.` qualifier so `struct Locals.Point`
 * renders as `Point {…}`.
 */
/** Render `0x6080…` instruction bytes as space-separated pairs (`60 80 …`). */
function spacedHex(bytes: string): string {
  const hex = bytes.startsWith('0x') ? bytes.slice(2) : bytes;
  return (hex.match(/.{2}/g) ?? []).join(' ');
}

function structSummary(typeLabel: string): string {
  const name = typeLabel.replace(/^struct\s+(?:.+\.)?/, '');
  return `${name} {…}`;
}
