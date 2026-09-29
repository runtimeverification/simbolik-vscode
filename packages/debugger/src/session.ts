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
  bytesLayoutAtMemoryOffset,
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
  closestFunctionOrModifier,
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
import {
  decodeCheatcodeCall,
  isCheatcodeCall,
  type DecodedCheatcode,
} from './cheatcodes.js';
import {enumerateAllEvents, type DecodedEvent} from './events.js';
import {enumerateMappingKeys, mappingValueSlot} from './mappings.js';
import {
  disassembleBytecode,
  encodeInstructionAddress,
  decodeInstructionAddress,
  type EvmInstruction,
} from './disassemble.js';
import {
  SteppingModel,
  type Stop,
  type StepMeta,
  type StepResolution,
} from './stepping.js';
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
    {
      buildInfoJson: unknown;
      contractName?: string;
      /**
       * The declaring source path. Contract names are NOT unique within a build
       * (forge-std and solmate both declare `MockERC20`), so a name alone can
       * select the wrong contract; with the path the pick is exact.
       */
      sourcePath?: string;
    }
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
  /**
   * The resolved contract, or `undefined` for a FOREIGN frame (`kind:'foreign'`)
   * whose code could not be attributed to any compilation unit.
   */
  contract: Contract | undefined;
  /** The resolved compilation unit, or `undefined` for a FOREIGN frame. */
  cu: CompilationUnit | undefined;
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
  /**
   * Whether this is a raw EVM-depth frame (`'evm'`, the default), a
   * reconstructed internal-function sub-frame (`'internal'`), or a Solidity
   * MODIFIER body frame (`'modifier'`, 4b). Modifier frames resolve their name
   * from the ModifierDefinition (via closestFunctionOrModifier) rather than
   * closestFunction. A `'cheatcode'` frame (4a) is a synthetic TOP frame for a
   * cheatcode CALL (a CALL to the cheatcode address): its name is the decoded
   * invocation and it has NO Solidity function of its own (non-descendable).
   * A `'foreign'` frame (4b) runs code we cannot attribute to any compilation
   * unit (etched raw bytecode, an unknown callee): it has NO `contract`/`cu`, no
   * Solidity `source`, an address-derived `name`, and is non-descendable.
   */
  kind?: 'evm' | 'internal' | 'modifier' | 'cheatcode' | 'foreign';
}

/**
 * A FOREIGN code resolution: an address running bytecode that could not be
 * attributed to any compilation unit (etched raw bytecode, an unknown callee).
 * It carries NO contract/cu — its frame is rendered EVM-only (no Solidity
 * source, an address-derived name, non-descendable) and its steps are left
 * unmapped by the stepping model (raw EVM depth, no jump fold), so a foreign
 * subcall neither mis-maps onto the entry contract nor corrupts parent stepping.
 */
interface ForeignResolution {
  kind: 'foreign';
  /** Lowercase hex code address whose bytecode is unidentifiable. */
  address: string;
}

/** A registry entry: a resolved contract CU, or a foreign (unidentifiable) code address. */
type RegistryResolution = StepResolution | ForeignResolution;

/** Whether a registry resolution is a FOREIGN (unidentifiable) code address. */
function isForeign(r: RegistryResolution): r is ForeignResolution {
  return (r as ForeignResolution).kind === 'foreign';
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
    | 'EVMCalldata'
    | 'EVMAccounts'
    | 'EVMAccount'
    | 'EVMAccountStorage'
    | 'Complex'
    | 'Events'
    | 'Event'
    | 'Globals'
    | 'GlobalGroup';
  frameId: number;
  /**
   * For an `EVMAccount` / `EVMAccountStorage` handle: the raw account map key
   * (as emitted by the node) whose fields / storage are re-resolved at read time.
   */
  accountAddress?: string;
  /** For a `GlobalGroup` handle: which Solidity global namespace it expands. */
  group?: 'msg' | 'tx' | 'block';
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
  /**
   * address(hex) → {contract, cu} resolved via CBOR runtime-code identity, or a
   * FOREIGN sentinel for a code address we could not attribute to any CU.
   */
  registry: Map<string, RegistryResolution>;
  /** The ultimate fallback resolution (the launch/entry contract). */
  entryResolution: StepResolution;
  steps: Step[];
  cursor: StateCursor;
  model: SteppingModel;
  step: number;
  /**
   * Whether the stop is just BEFORE `step`, which begins a modifier: the
   * modified function's frame is shown at the modifier's invocation instead of
   * inside the modifier (see {@link Stop}). Every step assignment clears it.
   */
  beforeModifier: boolean;
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

/** A pc's source position + enclosing definitions (see `#resolvePosition`). */
interface ResolvedPosition {
  path: string;
  line: number;
  col: number;
  offset: number;
  fnNode: AstNode | undefined;
  defNode: AstNode | undefined;
  modifierDepth: number;
}

/** A statement or block node (the boundary of a statement's OWN expressions). */
function isNestedStatement(n: AstNode): boolean {
  const t = n.nodeType;
  return (
    t === 'Block' ||
    t === 'UncheckedBlock' ||
    t.endsWith('Statement') ||
    t === 'Return' ||
    t === 'InlineAssembly' ||
    t === 'Break' ||
    t === 'Continue' ||
    t === 'Throw'
  );
}

/** Pure stack/control plumbing — executing only these does no computation. */
function isShuffleOp(op: string): boolean {
  return (
    op.startsWith('PUSH') ||
    op.startsWith('DUP') ||
    op.startsWith('SWAP') ||
    op === 'POP' ||
    op === 'JUMP' ||
    op === 'JUMPI' ||
    op === 'JUMPDEST'
  );
}

/** Opcodes that push NO result (everything else except DUP/SWAP pushes exactly one). */
const NO_RESULT_OPS = new Set([
  'POP', 'JUMP', 'JUMPI', 'JUMPDEST', 'MSTORE', 'MSTORE8', 'SSTORE', 'TSTORE',
  'LOG0', 'LOG1', 'LOG2', 'LOG3', 'LOG4', 'STOP', 'RETURN', 'REVERT', 'INVALID',
  'SELFDESTRUCT', 'CALLDATACOPY', 'CODECOPY', 'EXTCODECOPY', 'RETURNDATACOPY', 'MCOPY',
]);

/** Whether executing `op` pushes a freshly produced value on top of the stack. */
function producesValue(op: string): boolean {
  return !NO_RESULT_OPS.has(op);
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
  /** Whether a `terminated` event has already been emitted this session. */
  #endEmitted = false;
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

  /** Foreign-address raw-bytecode disassembly, cached by lowercase hex address. */
  readonly #foreignDisasmCache = new Map<
    string,
    {list: EvmInstruction[]; pcToIndex: Map<number, number>}
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

  /**
   * Reposition the session at trace step `index` (clamped), without emitting
   * any event. Test/harness support: lets a driver probe `next`/`stepOut` from
   * a stop reached by `stepIn` and then return to it, since every stepping
   * command is a pure function of the current step index.
   */
  seekStep(index: number): void {
    const state = this.#require();
    state.step = Math.max(0, Math.min(index, state.model.last));
    state.beforeModifier = false;
  }

  /** Test/harness support: the stepping model's metadata for trace step `index`. */
  stepMeta(index: number): StepMeta {
    return this.#require().model.at(index);
  }

  /** Wire everything, position at the entry statement, and queue a `stopped` event. */
  async launch(inputs: LaunchInputs): Promise<void> {
    this.#endEmitted = false;
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
    // A trace with no steps means the traced transaction executed no EVM
    // instructions — the target address has no code (a failed/oversized deploy,
    // or a call to an EOA). Proceeding would build an empty stepping model whose
    // `entry()` points past its own metadata, so the first step command throws a
    // cryptic "Cannot destructure property 'stmtId' of undefined". Fail fast here
    // with an explanation instead; the launch resolver's deploy-status check
    // catches the common cause earlier, but this guards every other 0-step path.
    if (steps.length === 0) {
      const addr = inputs.codeAddress ?? 'the entry contract';
      throw new Error(
        `launch: the traced transaction executed no instructions — ${addr} ` +
          'has no code (the deploy may have failed, e.g. an oversized contract, ' +
          'or the call targeted an account with no code). There is nothing to debug.',
      );
    }
    const cursor = new StateCursor(steps, inputs.initialStorage);

    // The entry/launch contract, used as the ultimate resolution fallback: found
    // by CBOR against the entry frame's code, else by name across the CUs.
    const entryResolution = this.#resolveEntry(inputs, cus, steps, cursor);

    // Build the address→{contract, cu} registry over the DISTINCT codeAddresses
    // in the trace (CBOR identification of each frame's runtime code).
    const registry = new Map<string, RegistryResolution>();
    const firstSeen = new Map<string, number>();
    // A separate index of the first RUNTIME-code step per address. A contract
    // CREATE'd during THIS transaction first appears running its INIT (creation)
    // code, which never matches the build-info deployedBytecode — identifying from
    // it would mark the address foreign. Identify from a deployed-runtime step so
    // an in-tx `new C()` resolves to its CU (and its frame is steppable).
    const firstRuntimeSeen = new Map<string, number>();
    for (let i = 0; i < steps.length; i++) {
      const addr = addressHex(steps[i]!.codeAddress);
      if (!firstSeen.has(addr)) firstSeen.set(addr, i);
      if (!steps[i]!.isInitCode && !firstRuntimeSeen.has(addr)) {
        firstRuntimeSeen.set(addr, i);
      }
    }
    for (const [addr, idx] of firstSeen) {
      const code = cursor.at(firstRuntimeSeen.get(addr) ?? idx).bytecode;
      const identified = this.#identify(cus, code);
      let resolution: RegistryResolution;
      if (identified !== undefined) {
        resolution = identified;
      } else if (addr === inputs.codeAddress.toLowerCase()) {
        // The ENTRY address maps to entryResolution — that IS its own code, even
        // when CBOR-identification fails (e.g. metadata stripped).
        resolution = entryResolution;
      } else {
        // Any OTHER address whose code does not CBOR-identify is FOREIGN (etched
        // raw bytecode, an unknown callee). Marking it foreign — rather than
        // falling back to the entry CU — keeps its foreign PCs from mis-mapping
        // onto the entry contract's source.
        resolution = {kind: 'foreign', address: addr};
      }
      registry.set(addr, resolution);
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
        const contract = this.#pickContract(
          cu,
          entry.contractName,
          cursor,
          firstRuntimeSeen.get(addr) ?? firstSeen.get(addr),
          entry.sourcePath,
        );
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

    const resolve = (index: number): StepResolution | undefined => {
      const r =
        registry.get(addressHex(steps[index]!.codeAddress)) ?? entryResolution;
      // Foreign code has no source map — leave the step UNMAPPED so the stepping
      // model keeps its raw EVM depth and contributes no jump fold (strictly
      // safer than mis-mapping the foreign PCs onto the entry contract's map).
      return isForeign(r) ? undefined : r;
    };

    const model = new SteppingModel(cursor, resolve);
    const entryStop = model.entryStop();

    this.#state = {
      cus,
      registry,
      entryResolution,
      steps,
      cursor,
      model,
      step: entryStop.step,
      beforeModifier: entryStop.beforeModifier,
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
    if (isInstruction(args)) {
      state.step = state.model.nextInstruction(state.step);
      state.beforeModifier = false;
      this.#stop('step');
    } else {
      this.#goTo(state, state.model.nextStop(this.#stopOf(state)));
      this.#stopOrEnd('step');
    }
    return {};
  }

  /** The current stop. */
  #stopOf(state: LaunchedState): Stop {
    return {step: state.step, beforeModifier: state.beforeModifier};
  }

  #goTo(state: LaunchedState, stop: Stop): void {
    state.step = stop.step;
    state.beforeModifier = stop.beforeModifier;
  }

  /** Step into. At `instruction` granularity, a single EVM opcode forward. */
  stepIn(args?: StepArgs): Record<string, never> {
    const state = this.#require();
    if (isInstruction(args)) {
      state.step = Math.min(state.step + 1, state.model.last);
      state.beforeModifier = false;
      this.#stop('step');
    } else {
      this.#goTo(state, state.model.stepInStop(this.#stopOf(state)));
      this.#stopOrEnd('step');
    }
    return {};
  }

  /** Step out of the current call (statement- or instruction-granular). */
  stepOut(args?: StepArgs): Record<string, never> {
    const state = this.#require();
    if (isInstruction(args)) {
      state.step = state.model.stepOutInstruction(state.step);
      state.beforeModifier = false;
      this.#stop('step');
    } else {
      this.#goTo(state, state.model.stepOutStop(this.#stopOf(state)));
      this.#stopOrEnd('step');
    }
    return {};
  }

  /** Reverse step. At `instruction` granularity, a single EVM opcode backward. */
  stepBack(args?: StepArgs): Record<string, never> {
    const state = this.#require();
    this.#goTo(
      state,
      isInstruction(args)
        ? {step: Math.max(state.step - 1, 0), beforeModifier: false}
        : state.model.stepBackStop(this.#stopOf(state)),
    );
    this.#stop('step');
    return {};
  }

  /** Single EVM instruction forward (clamped to the terminal step). */
  stepInstruction(_args?: {threadId?: number}): Record<string, never> {
    const state = this.#require();
    state.step = Math.min(state.step + 1, state.model.last);
    state.beforeModifier = false;
    this.#stop('step');
    return {};
  }

  /** Single EVM instruction backward (clamped to step 0). */
  stepBackInstruction(_args?: {threadId?: number}): Record<string, never> {
    const state = this.#require();
    state.step = Math.max(state.step - 1, 0);
    state.beforeModifier = false;
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
    this.#goTo(this.#require(), {step: target, beforeModifier: false});
    // NOTE: continue deliberately reports a `stopped` even at the terminal step
    // (the state remains inspectable there), unlike an explicit step-over past
    // the last statement, which ends the session via #stopOrEnd.
    this.#stop(reason);
    return {};
  }

  /**
   * Run backward to the nearest stop of the same three kinds, else to step 0.
   */
  reverseContinue(_args?: {threadId?: number}): Record<string, never> {
    const {target, reason} = this.#runToStop(this.#require(), -1);
    this.#goTo(this.#require(), {step: target, beforeModifier: false});
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
        ? state.model.continueStop(this.#stopOf(state), bps).step
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
  #frameSource(frame: FrameInfo): DebugProtocol.Source | undefined {
    // A FOREIGN frame (etched raw bytecode / unknown callee) has NO compilation
    // unit and is not attributed to any Solidity source at all.
    if (frame.cu === undefined) return undefined;
    return (
      this.#sourceFor(frame.cu, frame.path) ?? {
        // No matching SourceFile (unmapped step) — best-effort path only.
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
    const resolution = state.registry.get(codeAddress) ?? state.entryResolution;
    // A FOREIGN frame has no CU: disassemble the RAW bytecode straight from the
    // trace (no source locations) rather than a contract runtime image.
    const contract = isForeign(resolution) ? undefined : resolution.contract;
    const cu = isForeign(resolution) ? undefined : resolution.cu;
    const {list, pcToIndex} =
      contract !== undefined
        ? this.#disassemblyFor(contract, isInit)
        : this.#foreignDisassemblyFor(codeAddress);

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
        // Source locations only exist for a resolved contract; a foreign frame
        // shows bare instructions.
        if (contract !== undefined && cu !== undefined) {
          const pos = this.#resolvePosition(contract, cu, instr.pc, isInit);
          if (pos !== undefined) {
            const src = this.#sourceFor(cu, pos.path);
            if (src !== undefined) {
              entry.location = src;
              entry.line = pos.line;
              entry.column = pos.col + 1;
            }
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
   * Disassemble a FOREIGN code address's RAW bytecode from the trace (cached by
   * address). A foreign frame has no compilation unit, so there is no contract
   * runtime image to disassemble — we take the code the node executed at that
   * address directly. Empty when the address never appears in the trace.
   */
  #foreignDisassemblyFor(
    codeAddress: string,
  ): {list: EvmInstruction[]; pcToIndex: Map<number, number>} {
    let cached = this.#foreignDisasmCache.get(codeAddress);
    if (cached === undefined) {
      const state = this.#require();
      const idx = state.steps.findIndex(
        (s) => addressHex(s.codeAddress) === codeAddress,
      );
      const bytecode = idx >= 0 ? state.cursor.at(idx).bytecode : '0x';
      const list = disassembleBytecode(bytecode);
      const pcToIndex = new Map<number, number>();
      list.forEach((instr, i) => pcToIndex.set(instr.pc, i));
      cached = {list, pcToIndex};
      this.#foreignDisasmCache.set(codeAddress, cached);
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
    // Display order: Locals → State → Globals → Events → EVM. Locals is present
    // only on non-optimized frames (the stack analysis it needs is disabled by
    // the optimized fallback); the remaining four appear on EVERY frame.
    const scopes: DebugProtocol.Scope[] = [];
    // A FOREIGN frame (4b) has no contract/CU at all: the Solidity-decoded scopes
    // (Locals/State/Globals/Events) assume a contract/fnNode, so it exposes ONLY
    // the address-driven EVM scope (raw pc/op/stack/memory/storage/calldata).
    const foreign = frame.kind === 'foreign' || frame.cu === undefined;
    // A synthetic cheatcode frame (4a) has no Solidity function of its own, so it
    // exposes NO Locals scope — the local/param resolution assumes a real
    // FunctionDefinition (`frame.fnNode`), which a cheatcode frame lacks.
    if (!foreign && !frame.optimized && frame.kind !== 'cheatcode') {
      scopes.push({
        name: 'Locals',
        variablesReference: this.#allocHandle({kind: 'Locals', frameId: fid}),
        expensive: false,
      });
    }
    if (!foreign) {
      scopes.push({
        name: 'State',
        variablesReference: this.#allocHandle({kind: 'State', frameId: fid}),
        expensive: false,
      });
      // A read-only Globals scope (Solidity `msg`/`tx`/`block`/`gasleft()`).
      // Frame-RELATIVE: resolved against the frame's step in `variables()`.
      scopes.push({
        name: 'Globals',
        variablesReference: this.#allocHandle({kind: 'Globals', frameId: fid}),
        expensive: false,
      });
      // A read-only Events scope (event decoding scans LOG ops + ABI, not the
      // stack analysis the optimized no-Locals fallback disables).
      scopes.push({
        name: 'Events',
        variablesReference: this.#allocHandle({kind: 'Events', frameId: fid}),
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
      case 'EVMCalldata':
        return {variables: this.#evmCalldataVariables(frame)};
      case 'EVMAccounts':
        return {variables: this.#evmAccountsVariables(frame)};
      case 'EVMAccount':
        return {
          variables: this.#evmAccountVariables(frame, handle.accountAddress!),
        };
      case 'EVMAccountStorage':
        return {
          variables: this.#evmAccountStorageVariables(
            frame,
            handle.accountAddress!,
          ),
        };
      case 'Complex':
        return {
          variables: await this.#complexVariables(
            frame,
            handle.varName!,
            handle.complexKind ?? 'local',
          ),
        };
      case 'Globals':
        return {variables: this.#globalsVariables(frame)};
      case 'GlobalGroup':
        return {variables: this.#globalGroupVariables(frame, handle.group!)};
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
    this.#foreignDisasmCache.clear();
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
    // The code address is constant within a call frame, so the (costly) address
    // string is only formatted when the depth changes; otherwise just the frame's
    // latest step index advances.
    const stack: {address: string; stepIndex: number; depth: number}[] = [];
    let prevDepth = -1;
    for (let i = 0; i <= step && i < steps.length; i++) {
      const depth = steps[i]!.depth;
      if (depth === prevDepth) {
        stack[depth - 1]!.stepIndex = i;
        continue;
      }
      prevDepth = depth;
      const address = addressHex(steps[i]!.codeAddress);
      stack[depth - 1] = {address, stepIndex: i, depth};
      stack.length = depth; // pop any frames deeper than the current depth
    }
    if (stack.length === 0) return [];

    // Expand EVERY EVM frame into its internal-function sub-frames (constant-
    // EVM-depth JUMPs). A parent frame is replayed up to its CALL site, so its
    // innermost sub-frame sits at the call. Expanding only the innermost frame
    // collapsed the caller's internal call chain into one frame while a subcall
    // ran, and re-expanded it on return — so returning from an external call
    // looked like entering several frames at once. On any inconsistency the
    // reconstruction returns undefined and that depth falls back to a single
    // EVM frame.
    const frames: FrameInfo[] = [];
    let id = 1;
    for (const f of stack) {
      const internalSteps = this.#reconstructInternalFrames(
        f.depth,
        f.address,
        f.stepIndex,
      );
      if (internalSteps === undefined) {
        frames.push(this.#buildFrame(f.depth, f.address, f.stepIndex, id++));
        continue;
      }
      for (const sub of internalSteps) {
        frames.push(
          this.#buildFrame(f.depth, f.address, sub.stepIndex, id++, sub.kind),
        );
      }
    }

    // A frame in a call-first entry's header-mapped run (no statement starts
    // before the body's first call) shows the body's first statement.
    for (let k = 0; k < frames.length; k++) {
      const pos = state.model.entryRunPosition(frames[k]!.stepIndex);
      if (pos !== undefined) {
        frames[k] = {
          ...frames[k]!,
          path: pos.path,
          line: pos.line,
          column: pos.col + 1,
        };
      }
    }

    // Before a modifier: the modified function's frame, positioned on the
    // modifier's invocation in its header (the modifier frame isn't entered yet).
    const modEntry = state.beforeModifier
      ? state.model.modifierEntry(step)
      : undefined;
    if (modEntry !== undefined) {
      if (frames[frames.length - 1]?.kind === 'modifier') frames.pop();
      const top = frames[frames.length - 1];
      if (top !== undefined && top.fnNode?.id === modEntry.fn.id) {
        frames[frames.length - 1] = {
          ...top,
          path: modEntry.path,
          line: modEntry.line,
          column: modEntry.col + 1,
        };
      }
    }

    // ── 4a: synthetic cheatcode frame ────────────────────────────────────────
    // When the CURRENT step is a cheatcode CALL (a CALL to the cheatcode
    // address), a Foundry/kontrol cheatcode runs as an atomic, self-contained
    // CALL with no descendable sub-trace. Surface it as a synthetic TOP frame
    // (appended → renders as stackFrames[0]) labelled with the decoded
    // invocation, ADDITIVE above the preserved real contract frame(s). It shares
    // the innermost real frame's source position (the call site — the current
    // step already maps there). When the step is NOT a cheatcode call this never
    // runs, so every non-cheatcode fixture reconstructs unchanged.
    const currentStep = steps[step];
    const innermostFrame = frames[frames.length - 1];
    if (
      currentStep !== undefined &&
      innermostFrame !== undefined &&
      isCheatcodeCall(currentStep)
    ) {
      const decoded = decodeCheatcodeCall(currentStep, state.cursor.at(step));
      frames.push(this.#buildCheatcodeFrame(innermostFrame, decoded, id++));
    }
    return frames;
  }

  /**
   * Build the synthetic cheatcode frame: a NON-descendable top frame that shares
   * `below`'s source position (cu/path/line/column — the cheatcode call site) but
   * whose name is the decoded `vm.<display>` invocation. `kind:'cheatcode'` keeps
   * `scopes()` from fabricating Solidity locals for a pseudo-function.
   */
  #buildCheatcodeFrame(
    below: FrameInfo,
    decoded: DecodedCheatcode | undefined,
    id: number,
  ): FrameInfo {
    const name =
      decoded !== undefined ? `vm.${decoded.display}` : 'vm.cheatcode';
    return {
      ...below,
      id,
      name,
      fnNode: undefined,
      kind: 'cheatcode',
    };
  }

  /**
   * Reconstruct the internal-function sub-frames of an EVM frame by replaying
   * its current occurrence `[evmEntryStep..cur]` (`cur` is the current step for
   * the innermost frame, the CALL site for a parent). Returns a bottom-first
   * array of per-frame step indices (parents at their call site, innermost at the
   * current step), or `undefined` to signal a fail-safe fallback to the single
   * EVM frame. Never throws.
   *
   * A genuine internal-function ENTRY is a JUMPDEST landing (a step whose
   * predecessor at this EVM depth had source-map `jump:'i'`) whose enclosing scope
   * is a `FunctionDefinition` (`closestFunction`). The FIRST entry establishes the
   * base frame (the entry function itself, via the dispatcher's jump-in). A RETURN
   * is a landing whose predecessor had `jump:'o'` → pop. Landings inside a
   * modifier body (or unmapped) resolve to no `FunctionDefinition` and are NOT
   * pushed (4a skips modifiers). Underflow below the base triggers the fallback.
   */
  #reconstructInternalFrames(
    depth: number,
    address: string,
    cur: number,
  ): {stepIndex: number; kind: 'internal' | 'modifier'}[] | undefined {
    const state = this.#require();
    const {steps} = state;
    const resolution = state.registry.get(address) ?? state.entryResolution;
    // A FOREIGN frame has no contract/CU, so internal-function reconstruction
    // (fnAt / #resolvePosition / #indexFor) cannot run — bail to the single-EVM
    // frame path (one foreign frame over the preserved parent).
    if (isForeign(resolution)) return undefined;
    const {contract, cu} = resolution;

    // The current EVM occurrence began just after the last step shallower than
    // this depth (step 0 for a single-EVM-depth trace).
    let evmEntryStep = 0;
    for (let i = cur; i >= 0; i--) {
      if (steps[i]!.depth < depth) {
        evmEntryStep = i + 1;
        break;
      }
    }

    // A stack over ALL internal jumps (every `jump:'i'` pushes, every `jump:'o'`
    // pops), so it stays balanced across compiler-generated internal routines
    // (ABI en/decoders, allocators) whose landings resolve to NO user function,
    // and across the dispatcher→wrapper→body jumps that map to a function's OWN
    // body. Only `real` entries — a jump into a DIFFERENT user `FunctionDefinition`
    // — become DAP frames; `real:false` entries are "phantoms" that keep the depth
    // honest. A real frame renders at its call site (a parent) or at the current
    // step (the innermost, finalized below).
    // `lastOwn`: the latest step of a real frame that lies in its OWN function —
    // its call site when it calls out. The step just before a call's jump can lie
    // elsewhere (a modifier body; viaIR's function-pointer dispatcher, which maps
    // to the ContractDefinition), where the frame would be named after the contract.
    // `viaModifier`: the call site's step when a MODIFIER body made the call — the
    // modifier then stays on the stack beneath the callee (it is suspended there,
    // not finished) instead of vanishing while the callee runs.
    type Entry = {
      stepIndex: number;
      real: boolean;
      fnId: number;
      lastOwn?: number;
      viaModifier?: number;
      /** Entered without a `jump:'i'` (see the fall-through call below). */
      inline?: boolean;
    };
    const stack: Entry[] = [];
    /** The topmost real frame, whose call site is set when it makes a call. */
    const topReal = ():
      | Entry
      | undefined => {
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k]!.real) return stack[k]!;
      }
      return undefined;
    };
    const fnAt = (i: number): AstNode | undefined => {
      const fn = this.#resolvePosition(
        contract,
        cu,
        steps[i]!.pc,
        steps[i]!.isInitCode,
      )?.fnNode;
      return fn !== undefined && fn.nodeType === 'FunctionDefinition'
        ? fn
        : undefined;
    };
    const defAt = (i: number): AstNode | undefined =>
      this.#resolvePosition(contract, cu, steps[i]!.pc, steps[i]!.isInitCode)
        ?.defNode;
    let prevStep = -1;
    let prevJump: 'i' | 'o' | '-' = '-';
    /** The latest step (at this depth) inside a function or modifier. */
    let lastDefStep = -1;

    for (let i = evmEntryStep; i <= cur; i++) {
      // Skip steps inside an external subcall (a deeper EVM frame); their internal
      // jumps belong to that frame, not this one.
      if (steps[i]!.depth !== depth) continue;

      if (prevJump === 'i') {
        // `i` is a JUMPDEST landing. A jump into a DIFFERENT user function is a
        // genuine call → a real frame. A landing in the SAME function (the
        // dispatcher→wrapper→body path, or intra-function jumps), a modifier body,
        // a compiler routine, or an unmapped pc → a phantom that only balances the
        // depth.
        const fn = fnAt(i);
        const caller = topReal();
        if (
          fn !== undefined &&
          (caller === undefined || caller.fnId !== fn.id)
        ) {
          if (caller !== undefined) caller.stepIndex = caller.lastOwn ?? prevStep; // call site
          const viaModifier =
            caller !== undefined &&
            lastDefStep >= 0 &&
            defAt(lastDefStep)?.nodeType === 'ModifierDefinition'
              ? lastDefStep
              : undefined;
          stack.push({stepIndex: i, real: true, fnId: fn.id, viaModifier});
        } else {
          stack.push({stepIndex: i, real: false, fnId: fn?.id ?? -1});
        }
      } else if (prevJump === 'o') {
        // A return: pop the matching entry. Nothing to pop → inconsistency.
        if (stack.length === 0) return undefined;
        stack.pop();
      } else if (
        topReal() !== undefined &&
        topReal()!.lastOwn === prevStep &&
        fnAt(i) !== undefined &&
        fnAt(i)!.id !== topReal()!.fnId
      ) {
        // Straight from the caller's own code into ANOTHER user function without
        // a `jump:'i'`: viaIR calls a function that never returns (one that
        // always reverts) with a plain JUMP, or inlines its body outright. It is
        // still a call — otherwise the callee REPLACED its caller on the stack.
        // Falling back into the frame below (an inlined body that returns)
        // pops it again.
        const caller = topReal()!;
        const below = stack.filter((f) => f.real).at(-2);
        if (caller.inline === true && below?.fnId === fnAt(i)!.id) {
          stack.splice(stack.lastIndexOf(caller), 1);
        } else {
          caller.stepIndex = prevStep; // call site
          stack.push({stepIndex: i, real: true, fnId: fnAt(i)!.id, inline: true});
        }
      } else if (topReal() === undefined) {
        // The entry function is reached from the dispatcher WITHOUT a `jump:'i'`,
        // so seed the base frame from the first curDepth step whose enclosing
        // scope is a FunctionDefinition (the entry-function body).
        const fn = fnAt(i);
        if (fn !== undefined) {
          stack.push({stepIndex: i, real: true, fnId: fn.id});
        }
      }

      const owner = topReal();
      if (owner !== undefined && fnAt(i)?.id === owner.fnId) owner.lastOwn = i;
      if (defAt(i) !== undefined) lastDefStep = i;
      prevStep = i;
      prevJump = state.model.at(i).jump;
    }

    // Materialize the real frames (bottom-first). No base established → today's
    // single-EVM-frame behavior.
    const real = stack.filter((f) => f.real);
    if (real.length === 0) return undefined;
    /** Bottom-first frames, with each calling modifier beneath its callee. */
    const materialize = (): {
      stepIndex: number;
      kind: 'internal' | 'modifier';
    }[] =>
      real.flatMap((f) => [
        ...(f.viaModifier !== undefined
          ? [{stepIndex: f.viaModifier, kind: 'modifier' as const}]
          : []),
        {stepIndex: f.stepIndex, kind: 'internal' as const},
      ]);

    // ── 4b: modifier frame ──────────────────────────────────────────────────
    // If the CURRENT step sits inside a ModifierDefinition body (an INLINE
    // modifier — no jump:'i'/'o', the only signal is the AST climb + the
    // source-map modifierDepth), materialize a MODIFIER frame ON TOP of the
    // function it decorates. The innermost real (function) frame is then LEFT at
    // its seed position — the modifier's application / decl call site (line 17) —
    // instead of being repositioned to `cur` (a modifier pc). When the current
    // step is NOT in a modifier this branch never runs, so every modifier-free
    // fixture reconstructs byte-identically to 4a (regression guardrail).
    //
    // SUSPEND/RESUME fall out for free: at the placeholder `_;` the modifierDepth
    // INCREASES and control lands in the FunctionDefinition body, so `cur` is no
    // longer in a modifier → no modifier frame (→ [bump]). On RESUME the
    // modifierDepth DECREASES back into the ModifierDefinition, so `cur` is in a
    // modifier again → the frame is re-emitted.
    // Resolve the def governing the CURRENT logical position. Unmapped
    // compiler-generated helper steps (ABI coders, checked-arithmetic routines,
    // allocators) called from within the modifier or function body carry no
    // source position of their own, so walk back over them — within THIS same
    // EVM frame — to the nearest step that resolves to a user def, exactly as
    // #buildFrame does for the frame's own line. Without this look-through, a
    // helper called from the modifier body (e.g. the checked-mul for `x * 2`)
    // resolves to no ModifierDefinition, so the modifier frame is dropped AND
    // the function frame is repositioned onto the helper pc and mislabeled as
    // the contract for the whole helper region (steps 118–187 here). The
    // function-body helpers behave symmetrically (they walk back to `bump`), and
    // in a modifier-free trace no walk-back ever reaches a ModifierDefinition,
    // so the reconstruction stays byte-identical to 4a (regression guardrail).
    let curPos = this.#resolvePosition(
      contract,
      cu,
      steps[cur]!.pc,
      steps[cur]!.isInitCode,
    );
    for (
      let j = cur - 1;
      (curPos === undefined || curPos.defNode === undefined) &&
      j >= evmEntryStep &&
      steps[j]!.depth === depth &&
      addressHex(steps[j]!.codeAddress) === address;
      j--
    ) {
      curPos = this.#resolvePosition(
        contract,
        cu,
        steps[j]!.pc,
        steps[j]!.isInitCode,
      );
    }
    if (curPos?.defNode?.nodeType === 'ModifierDefinition') {
      // Keep the innermost function frame at its call site (seed), append the
      // modifier frame at the current step (bottom-first → [fn, modifier]).
      return [...materialize(), {stepIndex: cur, kind: 'modifier' as const}];
    }

    // The innermost frame is positioned at the current step.
    real[real.length - 1]!.stepIndex = cur;
    return materialize();
  }

  /** Resolve a single frame's contract + source position (with in-frame fallback). */
  #buildFrame(
    depth: number,
    address: string,
    stepIndex: number,
    id: number,
    kind: 'evm' | 'internal' | 'modifier' | 'cheatcode' = 'evm',
  ): FrameInfo {
    const state = this.#require();
    const resolution = state.registry.get(address) ?? state.entryResolution;
    // A FOREIGN frame is rendered EVM-only (no contract/cu, no Solidity source,
    // an address-derived name) — see {@link #buildForeignFrame}.
    if (isForeign(resolution)) {
      return this.#buildForeignFrame(depth, address, stepIndex, id);
    }
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
    // A MODIFIER frame (4b) resolves its name from the enclosing
    // ModifierDefinition (via closestFunctionOrModifier / pos.defNode) — the
    // function-only pos.fnNode is undefined inside a modifier body.
    const fnName =
      kind === 'modifier' ? pos?.defNode?.name : pos?.fnNode?.name;
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
      kind,
    };
  }

  /**
   * Build a FOREIGN frame: a NON-descendable EVM-only frame for a code address
   * running bytecode we could not attribute to any compilation unit (etched raw
   * bytecode, an unknown callee). It carries NO contract/cu (→ no Solidity
   * `source`) and its name is derived from its CODE ADDRESS, so it is never
   * mis-attributed to the entry contract's source.
   */
  #buildForeignFrame(
    depth: number,
    address: string,
    stepIndex: number,
    id: number,
  ): FrameInfo {
    return {
      id,
      depth,
      address,
      contract: undefined,
      cu: undefined,
      optimized: false,
      stepIndex,
      path: '',
      line: 0,
      column: 1,
      name: foreignFrameName(address),
      fnNode: undefined,
      kind: 'foreign',
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
    // A FOREIGN address (unidentifiable code) is not expandable into contract
    // storage — render it as a plain scalar address.
    if (resolution !== undefined && !isForeign(resolution)) {
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
        /** Nearest enclosing FunctionDefinition OR ModifierDefinition (4b). */
        defNode: AstNode | undefined;
        /** Source-map modifier depth of this step (4b). */
        modifierDepth: number;
      }
    | undefined {
    // Pure in (contract, isInit, pc) — memoized: frame reconstruction resolves
    // every step of the current EVM frame on each stackTrace.
    let byPc = this.#positionCache.get(contract);
    if (byPc === undefined) {
      byPc = new Map();
      this.#positionCache.set(contract, byPc);
    }
    const key = isInit ? -1 - pc : pc;
    if (byPc.has(key)) return byPc.get(key);
    const resolved = this.#computePosition(contract, cu, pc, isInit);
    byPc.set(key, resolved);
    return resolved;
  }

  readonly #positionCache = new WeakMap<
    Contract,
    Map<number, ResolvedPosition | undefined>
  >();

  #computePosition(
    contract: Contract,
    cu: CompilationUnit,
    pc: number,
    isInit: boolean,
  ): ResolvedPosition | undefined {
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
    const defNode =
      node !== undefined ? closestFunctionOrModifier(node) : undefined;
    return {
      path: source.path,
      line: p.line,
      col: p.column,
      offset: entry.start,
      fnNode,
      defNode,
      modifierDepth: entry.modifierDepth,
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
    sourcePath?: string,
  ): Contract | undefined {
    if (contractName !== undefined) {
      const byName = cu
        .contracts()
        .filter(
          (c) =>
            c.name === contractName &&
            (sourcePath === undefined || c.sourcePath === sourcePath),
        );
      if (byName.length === 1) return byName[0];
      // Ambiguous name (same-named contracts in different files): the running
      // code decides — never an arbitrary first match, whose source map would
      // silently mis-map every step of the frame.
      if (byName.length > 1 && traceIdx !== undefined) {
        const code = cursor.at(traceIdx).bytecode;
        const identified =
          code.length > 2 ? identifyContractByRuntimeCode(cu, code) : undefined;
        if (identified !== undefined && byName.includes(identified)) {
          return identified;
        }
      }
      if (byName.length > 0) return byName[0];
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
    // A FOREIGN frame has no contract layout — no Solidity storage variables.
    if (contract === undefined || cu === undefined) return [];
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
    // A FOREIGN frame has no function — no locals/params.
    if (cu === undefined || frame.contract === undefined) return [];

    // Read at the frame's live body position: a frame parked at its function
    // epilogue (e.g. after `continue` runs to the terminal STOP) has already
    // unwound its params/locals off the stack, so `variablesAt` correctly gives
    // them no pointer there. Walk back to the last in-body statement step of the
    // same occurrence — pure trace reconstruction, no variable-location math.
    const stepIndex = this.#localReadStep(frame);
    // Constructor frames run INIT code, whose pcs index the init source map;
    // `variablesAt` models RUNTIME code only, so resolving them there would name
    // an unrelated runtime function's variables. Not supported ⇒ none, not wrong.
    if (state.steps[stepIndex]!.isInitCode) return [];
    const pc = state.steps[stepIndex]!.pc;
    const vars = this.#variablesFor(frame, pc);
    const ms = machineStateFor(state.cursor.at(stepIndex), address);
    const modelRef = this.#modelReference(frame, stepIndex);

    const variables: DebugProtocol.Variable[] = [];
    for (const v of vars) {
      if (v.kind !== 'parameter' && v.kind !== 'return' && v.kind !== 'local') {
        continue; // storage lives in another scope.
      }
      // Decode each variable in isolation: one undecodable value (e.g. a string
      // whose length word is garbage) must not blank the whole Locals scope.
      try {
        await this.#pushLocal(variables, frame, cu, v, ms, stepIndex, modelRef);
      } catch (e) {
        variables.push({
          name: v.name,
          value: `<unreadable: ${e instanceof Error ? e.message : String(e)}>`,
          type: v.typeLabel,
          variablesReference: 0,
        });
      }
    }
    return variables;
  }

  /** Decode one live param/local `v` of {@link #localVariables} into `variables`. */
  async #pushLocal(
    variables: DebugProtocol.Variable[],
    frame: FrameInfo,
    cu: CompilationUnit,
    v: ResolvedVariable,
    ms: import('@ethdebug/pointers').Machine.State,
    stepIndex: number,
    modelRef: number | undefined,
  ): Promise<void> {
    // The static model's location is only trustworthy where the model matches
    // the executed path (see #modelReference): otherwise treat as unlocated.
    if (!this.#modelMatches(v, stepIndex, modelRef)) {
      v = {...v, pointer: undefined, members: undefined, array: undefined, bytes: undefined};
    }
    {
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
        return;
      }
      // A memory STRING / BYTES carries a `bytes` layout — a SCALAR value.
      if (v.bytes !== undefined) {
        const hex = await readPointerBytes(v.bytes.pointer, ms);
        const value = v.bytes.isString
          ? `"${Buffer.from(hex.slice(2), 'hex').toString('utf8')}"`
          : hex;
        variables.push({name: v.name, value, type: v.typeLabel, variablesReference: 0});
        return;
      }
      // Value numbering names a VALUE, so a leftover copy of a variable's OLD
      // value can still be named after the variable was reassigned (e.g. an
      // initializer `0` kept on the stack while `x -= …` ran in a loop). The
      // trace settles it: a stale copy is not the variable — treat it as
      // unlocated here and fall back to the last-known value below.
      if (v.pointer !== undefined && !this.#isStaleCopy(frame, v, stepIndex)) {
        const field = await readPointerValue(v.pointer, ms);
        if (this.#isAddressType(v.solcType)) {
          variables.push(this.#renderContractAddress(v.name, field, v.typeLabel));
        } else {
          const {value, type} = this.#decodeField(
            cu,
            field,
            v.solcType,
            v.typeLabel,
            v.numberOfBytes,
          );
          variables.push({name: v.name, value, type, variablesReference: 0});
        }
        return;
      }
      // Unavailable at the live pc: its stack slot has been freed/reused (common
      // under viaIR once a value local's LAST use has passed), yet it is still in
      // lexical scope (`variablesAt` listed it here). Show its LAST KNOWN value —
      // decoded at the most recent earlier step of THIS SAME frame invocation where
      // it was still locatable, and marked stale. Sound: it reads the variable's
      // genuine historical value, never the current (reused) slot. Scalars only;
      // a complex reference type is shown only while live.
      const stale = await this.#lastKnownScalar(frame, cu, v.name, stepIndex, modelRef);
      if (stale !== undefined) {
        variables.push(stale);
        return;
      }
      // A NAMED RETURN variable starts at its type's zero value (a Solidity
      // guarantee). viaIR keeps no stack slot for it until its first assignment,
      // so before that — when the trace shows no write to it since the frame was
      // entered — its value is known without a location: the default.
      if (v.kind === 'return' && this.#unwrittenSinceEntry(frame, cu, v, stepIndex)) {
        const zero = v.isValueType
          ? this.#isAddressType(v.solcType)
            ? {value: addressHex(0n), type: v.typeLabel}
            : this.#decodeField(cu, 0n, v.solcType, v.typeLabel, v.numberOfBytes)
          : undefined;
        if (zero !== undefined) {
          variables.push({name: v.name, ...zero, variablesReference: 0});
        }
      }
    }
  }

  /**
   * The frame invocation's reference offset between the RUNTIME stack length and
   * the provenance MODEL's stack length. Wherever the static model matches the
   * executed path this offset is constant (it is the caller's share of the
   * stack); the most common offset over the invocation's first located steps is
   * the reference. Memoized per invocation.
   */
  #modelReference(frame: FrameInfo, curStep: number): number | undefined {
    const {steps, model} = this.#require();
    const d = model.at(curStep).combinedDepth;
    let s0 = curStep;
    while (s0 > 0 && model.at(s0 - 1).combinedDepth >= d) s0--;
    const key = `${frame.address}:${s0}:${d}`;
    if (this.#modelRefCache.has(key)) return this.#modelRefCache.get(key);
    const counts = new Map<number, number>();
    let seen = 0;
    for (let j = s0; j <= curStep && seen < 24; j++) {
      const m = model.at(j);
      if (m.combinedDepth !== d || addressHex(steps[j]!.codeAddress) !== frame.address) continue;
      if (steps[j]!.isInitCode) continue;
      const len = this.#variablesFor(frame, steps[j]!.pc).find(
        (x) => x.modelStackLength !== undefined,
      )?.modelStackLength;
      if (len === undefined) continue;
      const off = steps[j]!.stack.length - len;
      counts.set(off, (counts.get(off) ?? 0) + 1);
      seen++;
    }
    let ref: number | undefined;
    let best = 0;
    for (const [off, n] of counts) if (n > best) [ref, best] = [off, n];
    // Only memoize a settled reference (enough samples), else recompute later.
    if (seen >= 24 || curStep - s0 > 5000) this.#modelRefCache.set(key, ref);
    return ref;
  }

  readonly #modelRefCache = new Map<string, number | undefined>();

  /** Whether `v`'s model-derived location is consistent with the trace at `step`. */
  #modelMatches(v: ResolvedVariable, step: number, modelRef: number | undefined): boolean {
    if (v.modelStackLength === undefined || modelRef === undefined) return true;
    return this.#require().steps[step]!.stack.length - v.modelStackLength === modelRef;
  }

  /** No statement writing `v` ran in this frame invocation before `curStep`. */
  #unwrittenSinceEntry(
    frame: FrameInfo,
    cu: CompilationUnit,
    v: ResolvedVariable,
    curStep: number,
  ): boolean {
    if (v.declId === undefined) return false;
    const {steps, model} = this.#require();
    const d = model.at(curStep).combinedDepth;
    for (let j = curStep - 1, n = 0; j >= 0; j--, n++) {
      if (n > 50000) return false; // too long to prove — don't guess
      const m = model.at(j);
      if (m.combinedDepth < d) return true; // reached the frame's entry
      if (m.combinedDepth > d || addressHex(steps[j]!.codeAddress) !== frame.address) continue;
      if (m.stmtId !== undefined && this.#statementWrites(cu, m.stmtId, v.declId)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Whether the live stack slot `v.pointer` names at `curStep` holds a value
   * produced BEFORE the start of `v`'s last write in this frame invocation — i.e.
   * a leftover copy of an OLD value (value numbering names values, not variables,
   * so after `x = …` / `x -= …` a surviving copy of x's previous value may still
   * be named `x`). Decided from the trace: the slot's value is followed backward
   * through DUP (copy source) / SWAP (move) to the step that produced it.
   */
  #isStaleCopy(frame: FrameInfo, v: ResolvedVariable, curStep: number): boolean {
    const declId = v.declId;
    const cu = frame.cu;
    const ptr = v.pointer as {location?: string; slot?: number} | undefined;
    if (declId === undefined || cu === undefined || ptr?.location !== 'stack') return false;
    if (typeof ptr.slot !== 'number') return false;
    const state = this.#require();
    const {steps, model} = state;
    const d = model.at(curStep).combinedDepth;
    const evmDepth = steps[curStep]!.depth;
    const addr = frame.address;
    // 1. The step span [writeStart, writeEnd] of the last execution of a
    // statement writing `v` in this invocation.
    let writeStart: number | undefined;
    let writeEnd: number | undefined;
    let writeStmt: number | undefined;
    let didWork = false;
    for (let j = curStep - 1, n = 0; j >= 0 && n < 50000; j--, n++) {
      const m = model.at(j);
      if (m.combinedDepth < d) break; // left this invocation
      if (addressHex(steps[j]!.codeAddress) !== addr) continue;
      if (m.combinedDepth > d) {
        if (writeStmt !== undefined) didWork = true; // a call made by the write
        continue;
      }
      if (writeStmt !== undefined && m.stmtId === writeStmt) {
        writeStart = j; // extend back to the span's first step
        if (!isShuffleOp(steps[j]!.op)) didWork = true;
        continue;
      }
      if (m.stmtId === undefined) continue;
      if (writeStmt !== undefined) {
        // The span ended. viaIR hoists single instructions of a statement ahead
        // of it (a `PUSH <label>` attributed to `x -= …`): a span that did no real
        // work is such a fragment, not the write having run — keep looking.
        if (didWork) break;
        writeStmt = undefined;
        writeStart = writeEnd = undefined;
      }
      if (this.#statementWrites(cu, m.stmtId, declId)) {
        writeStmt = m.stmtId;
        writeStart = j;
        writeEnd = j;
        didWork = !isShuffleOp(steps[j]!.op);
      }
    }
    if (writeStmt !== undefined && !didWork) writeStart = writeEnd = undefined;
    if (writeStart === undefined || writeEnd === undefined) return false;
    // 2. Follow the slot's value back through its lineage (DUP = copy of a
    // source slot, SWAP = move). The variable's current value was produced OR
    // copied while its last write executed; a leftover copy of an OLD value never
    // touches that span. (A plain "produced after the write" test is wrong: a
    // write may copy an existing value, e.g. `lo = a` returning a parameter.)
    let i = steps[curStep]!.stack.length - 1 - ptr.slot; // absolute index from bottom
    const inWrite = (j: number): boolean => j >= writeStart! && j <= writeEnd!;
    // A COMPOUND write (`x -= e`, `x++`) always computes a FRESH value inside the
    // statement, so only a value PRODUCED during it can be x's; shuffles (DUP/
    // SWAP) of older values during the statement prove nothing. A PLAIN write
    // (`x = e`, a declaration) may just copy an existing value (`lo = a`), so
    // there being copied/moved during the write counts as current.
    const compound = this.#statementWriteKind(cu, writeStmt!, declId) === 'compound';
    for (let j = curStep - 1; j >= writeStart; j--) {
      const st = steps[j]!;
      if (st.depth !== evmDepth) continue; // an external sub-call's own stack
      const after = steps[j + 1]!.stack.length;
      const len = st.stack.length;
      const op = st.op;
      if (op.startsWith('DUP')) {
        if (i === after - 1) {
          if (inWrite(j) && !compound) return false; // copied during the write ⇒ current
          i = len - Number(op.slice(3)); // a later copy: follow its source
        }
        continue;
      }
      if (op.startsWith('SWAP')) {
        const n = Number(op.slice(4));
        const touched = i === len - 1 || i === len - 1 - n;
        if (touched && inWrite(j) && !compound) return false; // moved into place by the write
        if (i === len - 1) i = len - 1 - n;
        else if (i === len - 1 - n) i = len - 1;
        continue;
      }
      if (i === after - 1 && after > 0 && producesValue(op)) {
        // Produced during the write ⇒ current; produced after it ⇒ not a value
        // the write gave the variable (a mis-named slot) ⇒ treat as stale.
        return !inWrite(j);
      }
      if (i >= after) return false; // defensive: index out of range
    }
    return true; // lineage predates the write ⇒ an OLD value's copy
  }

  /**
   * The LAST KNOWN value of a scalar param/local `name` that is in scope at the
   * current frame position but has no live location there (its slot was freed or
   * reused). Scans backward from `curStep` — bounded to the current frame
   * invocation via the stepping model's `combinedDepth` (a step SHALLOWER than the
   * frame's own level ends the invocation; a DEEPER one is a sub-call, skipped) and
   * the frame's address — for the most recent step where `variablesAt` gives `name`
   * a concrete SCALAR pointer (value type or memory string/bytes), then decodes it
   * against THAT step's reconstructed machine state, rendered like a live value.
   * Returns `undefined` if the variable is never
   * located within the invocation, or is a COMPLEX reference type (struct/array —
   * shown only while live). NEVER reads the current step's (reused) slot, so a
   * value shown is always one the variable genuinely held.
   */
  async #lastKnownScalar(
    frame: FrameInfo,
    cu: CompilationUnit,
    name: string,
    curStep: number,
    modelRef?: number,
  ): Promise<DebugProtocol.Variable | undefined> {
    const state = this.#require();
    const {steps, model} = state;
    const frameDepth = model.at(curStep).combinedDepth;
    const addr = frame.address;
    let declId: number | undefined;
    for (let j = curStep - 1; j >= 0; j--) {
      const m = model.at(j);
      if (m.combinedDepth < frameDepth) break; // returned out of this invocation
      if (m.combinedDepth > frameDepth) continue; // inside a sub-call
      if (addressHex(steps[j]!.codeAddress) !== addr) continue;
      if (steps[j]!.isInitCode) continue; // init code: not modelled (see #localVariables)
      // Never reach back ACROSS a write to the variable: a value located before
      // `x = …` / `x++` / `delete x` / an asm block touching `x` is superseded,
      // and showing it as "last known" would be wrong, not merely stale.
      if (
        declId !== undefined &&
        m.stmtId !== undefined &&
        this.#statementWrites(cu, m.stmtId, declId)
      ) {
        return undefined;
      }
      const v = this.#variablesFor(frame, steps[j]!.pc).find(
        (x) =>
          x.name === name &&
          (x.kind === 'parameter' ||
            x.kind === 'return' ||
            x.kind === 'local'),
      );
      if (v === undefined) continue;
      if (declId === undefined && v.declId !== undefined) {
        // First sighting (the scan starts where the variable is in scope but
        // unlocated): from here on, watch for writes — and check this step too.
        declId = v.declId;
        if (m.stmtId !== undefined && this.#statementWrites(cu, m.stmtId, declId)) {
          return undefined;
        }
      }
      if (v.members !== undefined || v.array !== undefined) return undefined;
      const ms = machineStateFor(state.cursor.at(j), addr);
      if (v.bytes !== undefined) {
        // A location that does not decode here (e.g. a slot read before the
        // variable was assigned) is not a value the variable held — keep looking
        // further back rather than surfacing the failure as a live value.
        let hex: string;
        try {
          hex = await readPointerBytes(v.bytes.pointer, ms);
        } catch {
          continue;
        }
        const raw = v.bytes.isString
          ? `"${Buffer.from(hex.slice(2), 'hex').toString('utf8')}"`
          : hex;
        return this.#staleVariable(v.name, raw, v.typeLabel);
      }
      if (v.pointer === undefined) continue; // present but unlocated here too
      if (!this.#modelMatches(v, j, modelRef)) continue; // model off this path here
      if (this.#isStaleCopy(frame, v, j)) continue; // an old value's copy, not v
      const field = await readPointerValue(v.pointer, ms);
      if (this.#isAddressType(v.solcType)) {
        // Same rendering as a live address (contract label + expandable state),
        // so a value does not change presentation merely because its slot was
        // freed (viaIR) while the variable stayed in scope.
        return this.#renderContractAddress(v.name, field, v.typeLabel);
      }
      const {value, type} = this.#decodeField(
        cu,
        field,
        v.solcType,
        v.typeLabel,
        v.numberOfBytes,
      );
      return this.#staleVariable(v.name, value, type);
    }
    return undefined;
  }

  /**
   * Whether statement `stmtId` may WRITE the variable `declId`: an assignment
   * with it on the left-hand side (incl. tuple destructuring), `++`/`--`/
   * `delete` on it, or an inline-assembly block referencing it (conservative —
   * assembly reads and writes are not distinguished). Memoized per statement.
   */
  #statementWrites(cu: CompilationUnit, stmtId: number, declId: number): boolean {
    let writes = this.#writesCache.get(stmtId);
    if (writes === undefined) {
      writes = new Set<number>();
      const compound = new Set<number>();
      let compoundNow = false;
      this.#compoundWrites.set(stmtId, compound);
      const stmt = cu.nodeById(stmtId);
      const visit = (n: AstNode, inLhs: boolean): void => {
        if (n.nodeType === 'Assignment') {
          const kids = n.children();
          // The right-hand side is the child starting last.
          const rhs = kids.reduce((a, b) => (b.srcStart > a.srcStart ? b : a), kids[0]!);
          compoundNow = n.operator !== '=';
          for (const k of kids) visit(k, k !== rhs);
          compoundNow = false;
          return;
        }
        if (
          n.nodeType === 'UnaryOperation' &&
          (n.operator === '++' || n.operator === '--' || n.operator === 'delete')
        ) {
          compoundNow = n.operator !== 'delete';
          for (const k of n.children()) visit(k, true);
          compoundNow = false;
          return;
        }
        if (n.nodeType === 'InlineAssembly') {
          for (const id of n.externalReferenceIds()) writes!.add(id);
          return;
        }
        if (inLhs && n.nodeType === 'Identifier' && n.referencedDeclaration !== undefined) {
          writes!.add(n.referencedDeclaration);
          if (compoundNow) compound.add(n.referencedDeclaration);
        }
        // Index/member accesses on the LHS write into the base's CONTENTS, not
        // the stack variable itself (a memory handle is unchanged).
        const lhsPasses = inLhs && (n.nodeType === 'TupleExpression' || n.nodeType === 'Identifier');
        for (const k of n.children()) {
          // Only the statement's OWN expressions: a nested statement (an `if`/
          // `while` body) runs under its own steps — the loop's condition steps
          // must not count as writing what the body assigns.
          if (k !== stmt && isNestedStatement(k)) continue;
          visit(k, lhsPasses);
        }
      };
      if (stmt !== undefined) {
        // A declaration statement initialises its own variables (a write too).
        if (stmt.nodeType === 'VariableDeclarationStatement') {
          for (const d of stmt.children()) {
            if (d.nodeType === 'VariableDeclaration') writes.add(d.id);
          }
        }
        visit(stmt, false);
      }
      this.#writesCache.set(stmtId, writes);
    }
    return writes.has(declId);
  }

  readonly #writesCache = new Map<number, Set<number>>();
  readonly #compoundWrites = new Map<number, Set<number>>();

  /** Whether statement `stmtId` writes `declId` by a compound update (`-=`, `++`). */
  #statementWriteKind(
    cu: CompilationUnit,
    stmtId: number,
    declId: number,
  ): 'compound' | 'plain' | undefined {
    if (!this.#statementWrites(cu, stmtId, declId)) return undefined;
    return this.#compoundWrites.get(stmtId)?.has(declId) ? 'compound' : 'plain';
  }

  /** A last-known scalar value, rendered exactly like a live one. */
  #staleVariable(
    name: string,
    value: string,
    type: string | undefined,
  ): DebugProtocol.Variable {
    return {name, value, type, variablesReference: 0};
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
  /**
   * Render the elements of a `bytes[]` / `string[]` array: each `'element'`
   * region is the element's MEMORY OFFSET, dereferenced as a raw byte string.
   * SHARED by the preview ({@link #renderComplex}) and the children
   * ({@link #complexVariables}) so both stay in lock-step. `bytes` → `0x…` hex;
   * `string` → a quoted UTF-8 string (matching the scalar string/bytes path).
   */
  async #bytesArrayElements(
    array: ArrayLayout,
    ms: import('@ethdebug/pointers').Machine.State,
  ): Promise<string[]> {
    const isString = array.elementBytes?.isString === true;
    const offsets = await readPointerRegions(array.pointer, ms);
    const values: string[] = [];
    for (const offset of offsets) {
      const layout = bytesLayoutAtMemoryOffset(Number(offset), isString);
      const hex = await readPointerBytes(layout.pointer, ms);
      values.push(
        isString
          ? `"${Buffer.from(hex.slice(2), 'hex').toString('utf8')}"`
          : hex,
      );
    }
    return values;
  }

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
      const values =
        array.elementBytes !== undefined
          ? await this.#bytesArrayElements(array, ms)
          : (await readPointerRegions(array.pointer, ms)).map((word) =>
              // Decode each element for the preview the SAME way its child is
              // decoded (normalize the full word to the element type first), so it
              // matches the expanded children for narrow / `bytesN` elements too.
              this.#decodeField(
                cu,
                fieldFromAbiWord(
                  word,
                  array.elementSolcType,
                  array.elementNumberOfBytes,
                ),
                array.elementSolcType,
                array.elementTypeLabel,
                array.elementNumberOfBytes,
              ).value,
            );
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
    // A FOREIGN frame has no contract layout — no mappings to enumerate.
    if (cu === undefined || contract === undefined) return [];
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
    // A FOREIGN frame has no contract layout — no complex variables.
    if (cu === undefined || contract === undefined) return [];

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
      // `bytes[]` / `string[]`: each element is itself a dynamic byte string
      // reached through its memory offset — render each as its own leaf value.
      if (array.elementBytes !== undefined) {
        const values = await this.#bytesArrayElements(array, ms);
        return values.map((value, i) => ({
          name: String(i),
          value,
          type: array.elementTypeLabel,
          variablesReference: 0,
        }));
      }
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
    const {contract, cu} = frame;
    // A FOREIGN frame has no contract — no resolvable variables.
    if (contract === undefined || cu === undefined) return [];
    let byPc = this.#varCache.get(contract);
    if (byPc === undefined) {
      byPc = new Map<number, ResolvedVariable[]>();
      this.#varCache.set(contract, byPc);
    }
    let vars = byPc.get(pc);
    if (vars === undefined) {
      vars = variablesAt(cu, contract.sourcePath, contract.name, pc);
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
    const calldataHex = ms.calldata.startsWith('0x')
      ? ms.calldata.slice(2)
      : ms.calldata;
    const calldataBytes = calldataHex.length / 2;
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
      {
        name: 'calldata',
        value: calldataBytes > 0 ? `${calldataBytes} bytes` : '0x',
        variablesReference:
          calldataBytes > 0
            ? this.#allocHandle({kind: 'EVMCalldata', frameId: frame.id})
            : 0,
      },
      {name: 'returnData', value: ms.returnData, variablesReference: 0},
      {
        name: 'accounts',
        value: `${ms.accounts.size} accounts`,
        variablesReference:
          ms.accounts.size > 0
            ? this.#allocHandle({kind: 'EVMAccounts', frameId: frame.id})
            : 0,
      },
    ];
  }

  /**
   * The frame's calldata decoded into a 4-byte function selector plus one row
   * per 32-byte ABI word AFTER the selector. Rows are named by their BYTE OFFSET
   * into the calldata: `0x00` (selector), then `0x04`, `0x24`, `0x44`, … i.e.
   * `4 + k*32` in hex (min 2 digits). Short calldata degrades gracefully — a
   * selector-only calldata yields just the `0x00` row, and calldata shorter than
   * 4 bytes yields whatever selector bytes are present.
   */
  #evmCalldataVariables(frame: FrameInfo): DebugProtocol.Variable[] {
    const state = this.#require();
    const ms = state.cursor.at(frame.stepIndex);
    const hex = ms.calldata.startsWith('0x') ? ms.calldata.slice(2) : ms.calldata;
    if (hex.length === 0) return [];
    const variables: DebugProtocol.Variable[] = [];
    const selector = hex.slice(0, 8);
    variables.push({
      name: '0x00',
      value: '0x' + selector,
      type: 'bytes4',
      variablesReference: 0,
    });
    const rest = hex.slice(8);
    for (let k = 0; k * 64 < rest.length; k++) {
      const offset = 4 + k * 32;
      const chunk = rest.slice(k * 64, k * 64 + 64);
      variables.push({
        name: '0x' + offset.toString(16).padStart(2, '0'),
        value: '0x' + chunk,
        variablesReference: 0,
      });
    }
    return variables;
  }

  /**
   * One row per touched account: named by its display address
   * (`addressHex(BigInt(key))`, tolerating decimal or 0x-hex node keys),
   * expandable into the account's fields. Preserves the Map's iteration order.
   */
  #evmAccountsVariables(frame: FrameInfo): DebugProtocol.Variable[] {
    const state = this.#require();
    const ms = state.cursor.at(frame.stepIndex);
    const variables: DebugProtocol.Variable[] = [];
    for (const key of ms.accounts.keys()) {
      variables.push({
        name: addressHex(BigInt(key)),
        value: '',
        variablesReference: this.#allocHandle({
          kind: 'EVMAccount',
          frameId: frame.id,
          accountAddress: key,
        }),
      });
    }
    return variables;
  }

  /**
   * The fields of one account: `address`, `balance`, `nonce`, `code` (a size
   * summary leaf), and an expandable `storage` row. Balance/nonce show
   * `Unavailable` when the node emitted no change for them.
   */
  #evmAccountVariables(
    frame: FrameInfo,
    accountAddress: string,
  ): DebugProtocol.Variable[] {
    const state = this.#require();
    const ms = state.cursor.at(frame.stepIndex);
    const account = ms.accounts.get(accountAddress);
    const codeByteLen =
      account?.code === undefined ? 0 : (account.code.length - 2) / 2;
    const slotCount = Object.keys(account?.storage ?? {}).length;
    return [
      {
        name: 'address',
        value: addressHex(BigInt(accountAddress)),
        type: 'address',
        variablesReference: 0,
      },
      {
        name: 'balance',
        value:
          account?.balance === undefined
            ? 'Unavailable'
            : String(BigInt(account.balance)),
        type: 'uint256',
        variablesReference: 0,
      },
      {
        name: 'nonce',
        value:
          account?.nonce === undefined
            ? 'Unavailable'
            : String(BigInt(account.nonce)),
        type: 'uint256',
        variablesReference: 0,
      },
      {
        name: 'code',
        value: `${codeByteLen} bytes`,
        variablesReference: 0,
      },
      {
        name: 'storage',
        value: `${slotCount} slots`,
        variablesReference:
          slotCount > 0
            ? this.#allocHandle({
                kind: 'EVMAccountStorage',
                frameId: frame.id,
                accountAddress,
              })
            : 0,
      },
    ];
  }

  /** One account's touched storage slots, as `slot → 0x…word`. */
  #evmAccountStorageVariables(
    frame: FrameInfo,
    accountAddress: string,
  ): DebugProtocol.Variable[] {
    const state = this.#require();
    const ms = state.cursor.at(frame.stepIndex);
    const account = ms.accounts.get(accountAddress);
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

  /** The touched storage slots of the frame's account, as `slot → 0x…word`. */
  #evmStorageVariables(frame: FrameInfo): DebugProtocol.Variable[] {
    return this.#evmAccountStorageVariables(frame, frame.address.toLowerCase());
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
        // A FOREIGN emitter has no ABI to decode its logs against.
        if (resolution === undefined || isForeign(resolution)) return undefined;
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

  // ─── Globals scope (Solidity msg/tx/block/gasleft()) ────────────────────────

  /**
   * The children of one Solidity global namespace (`msg`/`tx`/`block`) at the
   * frame's step. Availability rule: a child is rendered only when its source is
   * defined (kontrol carries `tx.gasprice` + all `block.*`; geth leaves them
   * `undefined`). Returns `[]` for a group with no available data.
   */
  #globalGroupVariables(
    frame: FrameInfo,
    group: 'msg' | 'tx' | 'block',
  ): DebugProtocol.Variable[] {
    const state = this.#require();
    const step = state.steps[frame.stepIndex];
    if (step === undefined) return [];
    const ms = state.cursor.at(frame.stepIndex);
    const vars: DebugProtocol.Variable[] = [];
    if (group === 'msg') {
      const calldata = ms.calldata;
      vars.push({
        name: 'sender',
        value: addressHex(step.msgSender),
        type: 'address',
        variablesReference: 0,
      });
      vars.push({
        name: 'value',
        value: String(step.msgValue),
        type: 'uint256',
        variablesReference: 0,
      });
      vars.push({
        name: 'data',
        value: calldata,
        type: 'bytes',
        variablesReference: 0,
      });
      vars.push({
        name: 'sig',
        value: '0x' + calldata.slice(2, 10),
        type: 'bytes4',
        variablesReference: 0,
      });
    } else if (group === 'tx') {
      vars.push({
        name: 'origin',
        value: addressHex(step.txOrigin),
        type: 'address',
        variablesReference: 0,
      });
      if (step.gasPrice !== undefined) {
        vars.push({
          name: 'gasprice',
          value: String(step.gasPrice),
          type: 'uint256',
          variablesReference: 0,
        });
      }
    } else {
      if (step.blockNumber !== undefined) {
        vars.push({
          name: 'number',
          value: String(step.blockNumber),
          type: 'uint256',
          variablesReference: 0,
        });
      }
      if (step.blockTimestamp !== undefined) {
        vars.push({
          name: 'timestamp',
          value: String(step.blockTimestamp),
          type: 'uint256',
          variablesReference: 0,
        });
      }
      if (step.coinbase !== undefined) {
        vars.push({
          name: 'coinbase',
          value: addressHex(step.coinbase),
          type: 'address',
          variablesReference: 0,
        });
      }
      if (step.difficulty !== undefined) {
        vars.push({
          name: 'prevrandao',
          value: String(step.difficulty),
          type: 'uint256',
          variablesReference: 0,
        });
      }
    }
    return vars;
  }

  /**
   * The top-level Globals rows for a frame: the `msg`/`tx`/`block` groups that
   * have ≥1 available child (each an expandable `GlobalGroup` handle), followed
   * by the `gasleft()` scalar leaf (always present, both dialects).
   */
  #globalsVariables(frame: FrameInfo): DebugProtocol.Variable[] {
    const state = this.#require();
    const rows: DebugProtocol.Variable[] = [];
    for (const group of ['msg', 'tx', 'block'] as const) {
      if (this.#globalGroupVariables(frame, group).length === 0) continue;
      rows.push({
        name: group,
        value: '',
        variablesReference: this.#allocHandle({
          kind: 'GlobalGroup',
          frameId: frame.id,
          group,
        }),
      });
    }
    const ms = state.cursor.at(frame.stepIndex);
    rows.push({
      name: 'gasleft()',
      value: String(ms.gas),
      type: 'uint256',
      variablesReference: 0,
    });
    return rows;
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

  /**
   * Report the outcome of a SOURCE-level forward step. If it landed on the
   * terminal trace step, execution has finished — the trace has no step after
   * it, and that step is the contract's dispatch epilogue (whose source range is
   * the whole contract, so a `stopped` there would park the client on the
   * contract-declaration line and freeze). Emit `terminated` so the client ends
   * the session cleanly, exactly as stepping over the last statement should.
   * Otherwise report a normal `stopped`.
   */
  #stopOrEnd(reason: string): void {
    const state = this.#state;
    if (state !== undefined && state.step >= state.model.last) {
      this.#terminate();
      return;
    }
    this.#stop(reason);
  }

  /** Emit a `terminated` event once (idempotent within a launched session). */
  #terminate(): void {
    if (this.#endEmitted) return;
    this.#endEmitted = true;
    this.#events.push({
      seq: this.#seq++,
      type: 'event',
      event: 'terminated',
    });
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

/**
 * The display name for a FOREIGN frame, derived from its lowercase hex code
 * address: `code @ 0x0000…beef` (a shortened head…tail form). Address-derived so
 * it is never confused with the entry contract's name.
 */
function foreignFrameName(address: string): string {
  const hex = address.startsWith('0x') ? address.slice(2) : address;
  const short =
    hex.length > 8 ? `0x${hex.slice(0, 4)}…${hex.slice(-4)}` : `0x${hex}`;
  return `code @ ${short}`;
}
