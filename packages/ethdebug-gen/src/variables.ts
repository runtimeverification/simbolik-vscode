/**
 * Static variable-context producer (`variablesAt`).
 *
 * `variablesAt(cu, sourcePath, contractName, pc)` answers "which variables are
 * live here and where do their bytes live", from the pc alone (no runtime
 * state). It returns:
 *   - the contract's storage variables, with their static storage pointers
 *     (at every pc, taken from {@link generateEthdebugProgram});
 *   - the enclosing function's parameters and in-scope locals, each with a
 *     concrete stack pointer (value types) ready to dereference.
 *
 * ## Locating stack variables
 * The primary location of a param/return/local is the per-pc stack-provenance
 * analyzer ({@link stackProvenance}), which handles both viaIR's reordered and
 * reused slots and legacy codegen. On legacy bytecode only, the frame-relative
 * slot model below fills in where provenance has no data-flow evidence.
 *
 * ## Frame-relative slot model (legacy fallback)
 * A function's params (declaration order) followed by its locals (declaration
 * order, inner-block locals reusing slots freed when an earlier block exits)
 * form one contiguous stack region above a per-function frame base. A
 * variable's frame-relative slot is `frameRelSlot = frameBase + rank`, where
 * `rank` is its position among the currently live variables (params are live
 * throughout the body; a local is live within its lexical scope after its
 * declaration statement). Reference/dynamic variables (`isValueType:false`)
 * still consume a rank so later value variables rank correctly; they are
 * listed with `pointer` omitted.
 *
 * ## frameBase anchoring
 * `frameBase` is derived once per function from the stack-height analyzer
 * ({@link stackHeights}) at a clean statement boundary: the first
 * statement-start pc in the function body, where no expression temporaries are
 * live, so `frameRelHeightAt(cleanPc) == frameBase + liveVarCount`. The
 * frame-relative coordinate cancels out of the per-pc depth-from-top:
 * `depth = frameRelHeightAt(pc) − 1 − frameRelSlot`. See
 * {@link anchorFrameBase} for how internal entry differs.
 *
 * ## Never throws
 * Any resolution failure (no enclosing function, undefined height,
 * un-anchorable frame) degrades to the resolvable subset, at minimum the
 * storage variables.
 */
import type {Pointer} from '@ethdebug/pointers';
import {
  buildInstructionIndex,
  closestFunction,
  closestStatement,
  sourceMapEntryAtPc,
  type AstNode,
  type CompilationUnit,
  type Contract,
} from '@simbolik/solc';

import {nodeAtEntry} from './ast.js';
import {codeImage, type CodeKind} from './cfg.js';
import {
  isLocalLiveAt,
  localsFromFunctionNode,
  type LocalDescriptor,
} from './functionLocals.js';
import {
  parametersFromFunctionNode,
  type ParamDescriptor,
} from './functionParameters.js';
import {
  memoryReferenceLayout,
  type ArrayLayout,
  type BytesLayout,
  type BytesStorageLayout,
  type MappingLayout,
  type StructMember,
} from './layouts.js';
import {generateEthdebugProgram} from './program.js';
import {stackHeights, type StackHeights} from './stackHeights.js';
import {stackProvenance, type StackProvenance} from './stackProvenance.js';
import {declTypeFacts, type DeclTypeFacts} from './valueTypes.js';

/** A resolved live variable at a pc, with a concrete pointer for value types. */
export interface ResolvedVariable {
  name: string;
  kind: 'storage' | 'parameter' | 'return' | 'local';
  /** AST id of the declaration (params/returns/locals only). */
  declId?: number;
  /** solc storage-style type id, e.g. `t_uint256`, `t_enum(Color)5`. */
  solcType: string;
  /** Solidity type string for display. */
  typeLabel: string;
  numberOfBytes: number;
  isValueType: boolean;
  /** Concrete pointer, ready to dereference (value types only). */
  pointer?: Pointer;
  /**
   * When the stack location came from the provenance model: that model's stack
   * length at this pc (see `StackProvenance.stackLengthAt`), so a consumer with
   * the real trace can check the model matches the executed path.
   */
  modelStackLength?: number;
  /**
   * For a memory struct of value-type members, the per-member layout, each
   * with its own concrete pointer. The variable itself stays
   * `isValueType:false` with no top-level pointer; the consumer renders it as a
   * nested variable by dereferencing each member.
   */
  members?: StructMember[];
  /**
   * For a dynamic memory array, its element layout and a dereferenceable
   * `List` pointer. The variable stays `isValueType:false` with no top-level
   * pointer and no `members`; the consumer renders it as a nested variable.
   */
  array?: ArrayLayout;
  /**
   * For a memory string / bytes, its raw-byte layout. The variable stays
   * `isValueType:false`; the consumer renders it as a scalar decoded value.
   */
  bytes?: BytesLayout;
  /**
   * For a dynamic storage string / bytes, its parity-select layout. The
   * variable stays `isValueType:false`; the consumer decodes short/long form
   * and renders a scalar value.
   */
  bytesStorage?: BytesStorageLayout;
  /**
   * For a `mapping` storage variable, the static base slot and key/value type
   * ids.
   */
  mapping?: MappingLayout;
}

/**
 * The live variables at `pc` (storage + the enclosing function's params/locals),
 * each with a concrete ethdebug pointer for value types. Purely static: `pc`
 * indexes the `kind` code image (runtime code by default; `'init'` for a
 * constructor frame). Never throws: on any resolution failure it returns the
 * resolvable subset (at least the storage variables).
 */
export function variablesAt(
  cu: CompilationUnit,
  sourcePath: string,
  contractName: string,
  pc: number,
  kind: CodeKind = 'runtime'
): ResolvedVariable[] {
  const out: ResolvedVariable[] = [];

  // Storage variables — always present, with their static storage pointers.
  out.push(...storageVariables(cu, sourcePath, contractName));

  // Stack variables (params + locals) of the enclosing function, if any.
  try {
    out.push(...stackVariables(cu, sourcePath, contractName, pc, kind));
  } catch {
    // Any failure resolving the stack region degrades to storage-only.
  }
  return out;
}

// ## Storage

/** pc-independent, so computed once per contract (`variablesAt` runs per pc). */
const storageVarCache = new WeakMap<Contract, ResolvedVariable[]>();

/** The contract's storage variables as {@link ResolvedVariable}s (kind 'storage'). */
function storageVariables(
  cu: CompilationUnit,
  sourcePath: string,
  contractName: string
): ResolvedVariable[] {
  const contract = cu.contract(sourcePath, contractName);
  const cached =
    contract === undefined ? undefined : storageVarCache.get(contract);
  if (cached !== undefined) return cached;
  const vars = computeStorageVariables(cu, sourcePath, contractName);
  if (contract !== undefined) storageVarCache.set(contract, vars);
  return vars;
}

function computeStorageVariables(
  cu: CompilationUnit,
  sourcePath: string,
  contractName: string
): ResolvedVariable[] {
  try {
    const program = generateEthdebugProgram(cu, sourcePath, contractName);
    return program.storageVariables.map(sv => {
      const rv: ResolvedVariable = {
        name: sv.name,
        kind: 'storage' as const,
        solcType: sv.solcType,
        typeLabel: sv.solcType,
        numberOfBytes: sv.length,
        isValueType: isValueSolcType(sv.solcType),
        pointer: sv.pointer,
      };
      if (sv.array !== undefined) rv.array = sv.array;
      if (sv.members !== undefined) rv.members = sv.members;
      if (sv.bytesStorage !== undefined) rv.bytesStorage = sv.bytesStorage;
      if (sv.mapping !== undefined) rv.mapping = sv.mapping;
      return rv;
    });
  } catch {
    return [];
  }
}

/** True for the solc storage-style type ids handled as flat value types. */
function isValueSolcType(solcType: string): boolean {
  return (
    solcType === 't_bool' ||
    solcType === 't_address' ||
    solcType === 't_contract' ||
    /^t_u?int\d+$/.test(solcType) ||
    /^t_bytes\d+$/.test(solcType) ||
    solcType.startsWith('t_enum')
  );
}

// ## Stack region (params + returns + locals)

/** One ordered stack variable (param, return, or local) in the uniform live list. */
interface StackVar extends DeclTypeFacts {
  name: string;
  /** AST declaration id; the key the stack-provenance analyzer tags slots by. */
  declId: number;
  kind: 'parameter' | 'return' | 'local';
}

/** A stack variable with its frame-relative rank (legacy slot model). */
interface RankedVar {
  v: StackVar;
  rank: number;
}

interface Analyzers {
  provenance: StackProvenance;
  heights: StackHeights;
}

/** Per-function (pc-independent) frame facts. */
interface FrameInfo {
  /** Params, then NAMED returns, with their fixed ranks. */
  fixed: RankedVar[];
  locals: LocalDescriptor[];
  /** Rank of the first live local: past every param AND every reserved return slot. */
  localRankBase: number;
  frameBase: number | undefined;
}

/**
 * Per-contract cache of the two whole-contract CFG analyzers, one pair per code
 * image. Both are pure functions of the code image, so they are built once and
 * reused for every `pc`; the full analysis is O(contract size), which is too
 * slow to repeat per pc on a large contract. Keyed by the `Contract` object
 * (stable within a `CompilationUnit`); the `WeakMap` lets the entry be
 * collected with its CU when a debug session ends.
 */
const analyzerCache = {
  runtime: new WeakMap<Contract, Analyzers>(),
  init: new WeakMap<Contract, Analyzers>(),
};

/**
 * Per-function frame facts, keyed by the contract's height analyzer then the
 * function id: `variablesAt` runs for every pc the debugger inspects (incl. the
 * last-known backward scan), and `anchorFrameBase` alone scans the contract's
 * whole source map.
 */
const frameInfoCache = new WeakMap<StackHeights, Map<number, FrameInfo>>();

function analyzersFor(
  cu: CompilationUnit,
  sourcePath: string,
  contractName: string,
  contract: Contract,
  kind: CodeKind
): Analyzers {
  let entry = analyzerCache[kind].get(contract);
  if (entry === undefined) {
    entry = {
      provenance: stackProvenance(cu, sourcePath, contractName, kind),
      heights: stackHeights(cu, sourcePath, contractName, kind),
    };
    analyzerCache[kind].set(contract, entry);
  }
  return entry;
}

function frameInfoFor(
  cu: CompilationUnit,
  contract: Contract,
  kind: CodeKind,
  fnNode: AstNode,
  heights: StackHeights
): FrameInfo {
  let perFn = frameInfoCache.get(heights);
  if (perFn === undefined) {
    perFn = new Map();
    frameInfoCache.set(heights, perFn);
  }
  let info = perFn.get(fnNode.id);
  if (info === undefined) {
    info = computeFrameInfo(cu, contract, kind, fnNode, heights);
    perFn.set(fnNode.id, info);
  }
  return info;
}

/**
 * A frame reserves a stack slot for each return parameter between the params
 * and the locals (the return values, zero-initialised in the prologue), for
 * both external and internal entry. Every declared return reserves a slot: a
 * return param at declaration index `i` ranks at `params.length + i`, and the
 * locals rank past all of them. Unnamed returns are not emitted as variables
 * but still reserve a slot, so named returns and locals after them rank
 * correctly.
 */
function computeFrameInfo(
  cu: CompilationUnit,
  contract: Contract,
  kind: CodeKind,
  fnNode: AstNode,
  heights: StackHeights
): FrameInfo {
  const params = parametersFromFunctionNode(fnNode, cu);
  const locals = localsFromFunctionNode(fnNode, cu);
  const returnNodes = fnNode.returnParameters();

  const fixed: RankedVar[] = params.map((p, i) => ({
    v: toStackVar(p, 'parameter'),
    rank: i,
  }));
  returnNodes.forEach((node, i) => {
    const name = node.name;
    if (name === undefined || name === '') return; // unnamed: reserved, not emitted.
    fixed.push({
      // A user-defined value-type return resolves to its underlying type;
      // reference returns get `isValueType:false` but still consume a rank.
      v: {name, declId: node.id, kind: 'return', ...declTypeFacts(node, cu)},
      rank: params.length + i,
    });
  });

  return {
    fixed,
    locals,
    localRankBase: params.length + returnNodes.length,
    frameBase: anchorFrameBase(
      cu,
      contract,
      kind,
      fnNode,
      params,
      locals,
      returnNodes.length,
      heights
    ),
  };
}

function toStackVar(
  d: ParamDescriptor | LocalDescriptor,
  kind: 'parameter' | 'local'
): StackVar {
  return {
    name: d.name,
    declId: d.declId,
    kind,
    solcType: d.solcType,
    typeLabel: d.typeLabel,
    numberOfBytes: d.numberOfBytes,
    isValueType: d.isValueType,
  };
}

/** Resolve the enclosing function's live params+locals at `pc` to pointers. */
function stackVariables(
  cu: CompilationUnit,
  sourcePath: string,
  contractName: string,
  pc: number,
  kind: CodeKind
): ResolvedVariable[] {
  const contract = cu.contract(sourcePath, contractName);
  if (contract === undefined) return [];

  // Enclosing function at pc: source map → innermost node → closestFunction.
  // Params/locals come from this resolved node (not a by-name lookup): the
  // source map may resolve `pc` to a function inherited from a base contract,
  // which a name lookup scoped to `contractName` would miss (degrading to
  // storage-only), and the node also disambiguates overloads.
  const entry = sourceMapEntryAtPc(contract, pc, kind);
  if (entry === undefined) return [];
  const node = nodeAtEntry(cu, entry);
  if (node === undefined) return [];
  const fnNode = closestFunction(node);
  if (fnNode === undefined || fnNode.name === undefined) return [];

  const analyzers = analyzersFor(cu, sourcePath, contractName, contract, kind);
  const {fixed, locals, localRankBase, frameBase} = frameInfoFor(
    cu,
    contract,
    kind,
    fnNode,
    analyzers.heights
  );
  // `heightHere`/`frameBase` may be undefined (analyzer couldn't resolve this
  // pc, or the frame couldn't be anchored). That only disables the fallback.
  const heightHere = analyzers.heights.frameRelHeightAt(pc);
  const frameDepthOf = (rank: number): number | undefined =>
    heightHere !== undefined && frameBase !== undefined
      ? heightHere - 1 - (frameBase + rank)
      : undefined;

  // Live ordering: params (always live), then return params (always
  // live once entered), then in-scope locals — all in declaration order;
  // reference vars are included so they consume a rank.
  const ranked: RankedVar[] = [
    ...fixed,
    ...locals
      .filter(l => isLocalLiveAt(l, entry.start))
      .map((l, j) => ({v: toStackVar(l, 'local'), rank: localRankBase + j})),
  ];
  return ranked.map(({v, rank}) =>
    resolveStackVar(cu, analyzers.provenance, pc, v, frameDepthOf(rank))
  );
}

/**
 * One stack variable at `pc`: located by provenance first, falling back (legacy
 * codegen only) to its frame-relative slot `frameDepth`; a value type gets a
 * stack pointer, a memory reference type its layout. Unlocated ⇒ listed bare.
 */
function resolveStackVar(
  cu: CompilationUnit,
  provenance: StackProvenance,
  pc: number,
  v: StackVar,
  frameDepth: number | undefined
): ResolvedVariable {
  const result: ResolvedVariable = {
    name: v.name,
    kind: v.kind,
    declId: v.declId,
    solcType: v.solcType,
    typeLabel: v.typeLabel,
    numberOfBytes: v.numberOfBytes,
    isValueType: v.isValueType,
  };
  // Primary location; `undefined` means the value is not known to be on the
  // stack here.
  let depth = provenance.variableDepthAt(pc, v.declId);
  const modelled =
    depth !== undefined ? provenance.stackLengthAt(pc) : undefined;

  if (v.isValueType) {
    // Fallback (legacy bytecode, non-parameters only): where provenance has no
    // data-flow evidence, the frame-relative slot locates a value at a stable
    // frame slot that provenance can't anchor without a read, e.g. a return
    // parameter's reserved (still-zero) slot, or a loop variable whose value
    // number changes each iteration. It is invalid under viaIR, and unreliable
    // for value parameters even on legacy, where provenance is authoritative.
    if (
      depth === undefined &&
      !cu.viaIR() &&
      v.kind !== 'parameter' &&
      frameDepth !== undefined &&
      frameDepth >= 0
    ) {
      depth = frameDepth;
    }
    if (depth === undefined) return result; // unavailable at this pc → omit.
    if (modelled !== undefined) result.modelStackLength = modelled;
    result.pointer = {
      location: 'stack',
      slot: depth,
      offset: v.solcType.startsWith('t_bytes') ? 0 : 32 - v.numberOfBytes,
      length: v.numberOfBytes,
    };
    return result;
  }

  // Reference/dynamic types: the stack slot holds the reference's handle (a
  // MEMORY struct/array/string's memory offset). No top-level pointer.
  if (modelled !== undefined) result.modelStackLength = modelled;
  // Fallback, legacy only. The frame-relative slot is sound on the legacy
  // pipeline (fixed frame slots) but not under viaIR, whose stack scheduler
  // reorders and reuses slots, so it would decode plausible but wrong values.
  // Under viaIR reference handles are located by provenance alone; unlocated
  // ones are listed without a layout.
  if (depth === undefined && !cu.viaIR()) depth = frameDepth;
  if (depth !== undefined && depth >= 0) {
    Object.assign(
      result,
      memoryReferenceLayout(cu, v.solcType, v.typeLabel, depth)
    );
  }
  // Known limitation: a calldata dynamic bytes/string (`bytes calldata` /
  // `string calldata` param) is listed without a layout. Under viaIR it is a
  // 2-slot value (calldata offset + byte length), and the offset can sit above
  // or below the length on the stack, so one provenance-anchored slot plus a
  // fixed direction can pick the wrong slot. Showing nothing is safer than a
  // wrong value until both slots of a calldata slice can be identified. See
  // the calldatafwd fixture.
  return result;
}

/**
 * The frame base (frame-relative) of a function: the frame-relative slot below
 * the first variable, so `frameRelSlot(var) = frameBase + rank`. How the params
 * sit on the stack differs by entry kind, so the anchor does too:
 *
 * - **External / public** (entered from the dispatcher): the function's own
 *   prologue ABI-decodes its params and pushes them above the body entry, then
 *   reserves one zero-initialised slot per return parameter. At the first body
 *   statement no expression temporaries are live, so
 *   `frameBase = frameRelHeightAt(cleanPc) − (paramCount + returnSlots
 *   + liveLocals)`. Each return parameter is assumed to occupy one slot, like
 *   params and locals; a dynamic calldata return would take two.
 *
 * - **Internal / private** (entered by a Solidity JUMP): the caller pushed the
 *   params below the body entry, so they sit at the `paramCount` slots just
 *   below the analyzer's height-0 entry: `frameBase = frameRelHeightAt(entryPc)
 *   − paramCount`. A first-statement anchor would misplace them, because the
 *   return slots reserved in the prologue count into the first-statement
 *   height. Those return slots sit above the entry, between the params and the
 *   body locals; the caller adds `returnSlots` to the locals' ranks, not to
 *   `frameBase`.
 */
function anchorFrameBase(
  cu: CompilationUnit,
  contract: Contract,
  kind: CodeKind,
  fnNode: AstNode,
  params: ParamDescriptor[],
  locals: LocalDescriptor[],
  returnSlots: number,
  heights: StackHeights
): number | undefined {
  const external = isExternalEntry(fnNode.visibility);
  const {bytecode, sourceMap} = codeImage(contract, kind);
  const {instructionToPc} = buildInstructionIndex(bytecode);

  let prevStmtId: number | undefined;
  for (let i = 0; i < sourceMap.length; i++) {
    const smEntry = sourceMap[i];
    if (smEntry === undefined) continue;
    const n = nodeAtEntry(cu, smEntry);
    if (n === undefined) continue;

    const owningFnId = closestFunction(n)?.id;
    const pc = instructionToPc[i]!;

    if (!external) {
      // Internal/private: anchor at the body ENTRY (lowest attributed pc, the
      // analyzer's height 0). Instructions are in increasing-pc order, so the
      // first attributed one with a defined height is that entry.
      if (owningFnId !== fnNode.id) continue;
      const height = heights.frameRelHeightAt(pc);
      if (height === undefined) continue;
      return height - params.length;
    }

    // External/public: anchor at the first CLEAN statement boundary of the body.
    const stmtId = closestStatement(n)?.id;
    const isStmtStart = stmtId !== undefined && stmtId !== prevStmtId;
    if (stmtId !== undefined) prevStmtId = stmtId;
    if (owningFnId !== fnNode.id || !isStmtStart) continue;
    const height = heights.frameRelHeightAt(pc);
    if (height === undefined) continue;
    const liveVarCount =
      params.length +
      returnSlots +
      locals.filter(l => isLocalLiveAt(l, smEntry.start)).length;
    return height - liveVarCount;
  }
  return undefined;
}

/**
 * Whether a function is entered from the dispatcher (external ABI entry) rather
 * than via an internal Solidity JUMP. `public`/`external` (and, defensively, a
 * missing visibility) count as external; `internal`/`private` as internal.
 * Known limitation: a `public` function called internally within the same
 * contract is entered by a JUMP with its params below the entry, yet its body
 * pcs are anchored with the external model.
 */
function isExternalEntry(visibility: string | undefined): boolean {
  return (
    visibility === undefined ||
    visibility === 'public' ||
    visibility === 'external'
  );
}
