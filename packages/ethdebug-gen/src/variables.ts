/**
 * Static variable-context producer (`variablesAt`).
 *
 * `variablesAt(cu, sourcePath, contractName, pc)` is the SINGLE, PURE-STATIC
 * source of truth for "what variables are live here and where do their bytes
 * live". Given ONLY a pc (ZERO runtime facts) it returns:
 *   - the contract's STORAGE variables, with their static storage pointers
 *     (always, at every pc — reused verbatim from {@link generateEthdebugProgram});
 *   - the enclosing function's PARAMETERS and in-scope LOCALS, each with a
 *     concrete STACK pointer (value types) ready to dereference.
 *
 * ── Locating stack variables ─────────────────────────────────────────────────
 * The PRIMARY, codegen-agnostic location of a param/return/local is the per-pc
 * stack-PROVENANCE analyzer ({@link stackProvenance}: correct for viaIR's
 * reordered/reused slots AND legacy). On legacy bytecode only, the classic
 * frame-relative slot model below completes it where provenance has no
 * data-flow evidence.
 *
 * ── The uniform params+locals model (legacy fallback) ────────────────────────
 * Params and locals are ALL stack variables: a function's params (declaration
 * order) followed by its locals (declaration order, inner-block locals reusing
 * slots freed when an earlier block exits) form one contiguous stack region
 * above a per-function frame base. A variable's frame-relative slot is
 * `frameRelSlot = frameBase + rank`, where `rank` is its position among the
 * currently-LIVE variables (params are live throughout the body; a local is live
 * within its lexical scope after its declaration statement), in that order.
 * Reference/dynamic variables (`isValueType:false`) STILL consume a rank/slot so
 * later value variables rank correctly — they are listed with `pointer` omitted.
 *
 * ── frameBase anchoring (STATIC, via the analyzer) ────────────────────────────
 * `frameBase` is derived ONCE per function from the stack-height analyzer
 * ({@link stackHeights}) — NOT from any trace — at a CLEAN statement boundary:
 * the first statement-start pc in the function body, where no expression
 * temporaries are live, so `frameRelHeightAt(cleanPc) == frameBase + liveVarCount`.
 * Hence `frameBase = frameRelHeightAt(cleanPc) − liveVarCount(cleanPc)`. This
 * mirrors the external-anchor selection (first body statement past the
 * prologue), but sources the height statically from `frameRelHeightAt` instead
 * of the trace's stack length. The frame-relative coordinate cancels out of the
 * per-pc depth-from-top: `depth = frameRelHeightAt(pc) − 1 − frameRelSlot`.
 *
 * ── Never throws ──────────────────────────────────────────────────────────────
 * Any resolution failure (no enclosing function, undefined height, un-anchorable
 * frame) degrades to the resolvable subset — at minimum the storage variables.
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
   * For a reference-type COMPLEX variable (a memory struct of value-type
   * members), the per-member layout — each with its own concrete pointer. The
   * variable itself stays `isValueType:false` with NO top-level pointer; the
   * consumer renders it as a nested variable by dereferencing each member.
   */
  members?: StructMember[];
  /**
   * For a DYNAMIC MEMORY ARRAY, its element layout + a dereferenceable
   * `List` pointer. The variable stays `isValueType:false` with no top-level
   * pointer and no `members`; the consumer renders it as a nested variable.
   */
  array?: ArrayLayout;
  /**
   * For a MEMORY STRING / BYTES, its raw-byte layout. The variable stays
   * `isValueType:false`; the consumer renders it as a SCALAR decoded value.
   */
  bytes?: BytesLayout;
  /**
   * For a dynamic STORAGE STRING / BYTES, its parity-select layout. The
   * variable stays `isValueType:false`; the consumer decodes short/long + renders a
   * SCALAR value. (Kept in sync with the producer; harmless — the session reads
   * #stateVariables from generateEthdebugProgram directly.)
   */
  bytesStorage?: BytesStorageLayout;
  /**
   * For a `mapping` storage var, the static base slot + key/value type
   * ids. Kept in sync with the producer; harmless — the session reads
   * #stateVariables from generateEthdebugProgram directly.
   */
  mapping?: MappingLayout;
}

/**
 * The live variables at `pc` (storage + the enclosing function's params/locals),
 * each with a concrete ethdebug pointer for value types. Pure-static: `pc` is the
 * only runtime-adjacent input; it indexes the `kind` code image (runtime code by
 * default; `'init'` for a constructor frame). Never throws — on any resolution
 * failure it returns the resolvable subset (at least the storage variables).
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

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

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
      // Keep the reference layout in sync with the producer (harmless;
      // the session reads #stateVariables from generateEthdebugProgram directly).
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

// ---------------------------------------------------------------------------
// Stack region (params + returns + locals)
// ---------------------------------------------------------------------------

/** One ordered stack variable (param, return, or local) in the uniform live list. */
interface StackVar extends DeclTypeFacts {
  name: string;
  /** AST declaration id — the key the stack-provenance analyzer tags slots by. */
  declId: number;
  kind: 'parameter' | 'return' | 'local';
}

/** A stack variable with its frame-relative rank (legacy slot model). */
interface RankedVar {
  v: StackVar;
  rank: number;
}

/** The two whole-contract CFG analyzers. */
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
 * image. Both `stackProvenance` and `stackHeights` are PURE functions of the
 * contract's code image, so they are built ONCE per image and reused across every
 * `pc`. Keyed by the `Contract` object (stable within a `CompilationUnit`); a `WeakMap` lets the
 * entry be collected with its CU when a debug session ends. Without this the
 * full CFG analysis (O(contract size)) reran on every `variablesAt` call —
 * ~300ms per newly-visited pc on a large viaIR contract.
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
 * A frame reserves a stack slot for EACH return parameter between the params and
 * the locals (the return values, zero-initialised in the prologue). This holds
 * for BOTH external and internal entry, so the count is unconditional. ALL
 * declared returns (including UNNAMED ones) reserve a slot: a return param at
 * declaration index `i` ranks at `params.length + i`, and the locals rank past
 * ALL reserved return slots. UNNAMED returns are NOT emitted as variables but
 * STILL reserve a slot, so named returns and locals after them rank correctly.
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
  // Params/locals come from this RESOLVED node (not a by-name lookup): the
  // source map may resolve `pc` to a function INHERITED from a base contract,
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
  // `heightHere`/`frameBase` may be undefined (analyzer couldn't resolve this pc,
  // or the frame couldn't be anchored). That only disables the legacy fallback.
  const heightHere = analyzers.heights.frameRelHeightAt(pc);
  const frameDepthOf = (rank: number): number | undefined =>
    heightHere !== undefined && frameBase !== undefined
      ? heightHere - 1 - (frameBase + rank)
      : undefined;

  // Uniform LIVE ordering: params (always live), then return params (always
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
  // PRIMARY, codegen-agnostic location. `undefined` means the value is not known
  // to be on the stack here.
  let depth = provenance.variableDepthAt(pc, v.declId);
  const modelled =
    depth !== undefined ? provenance.stackLengthAt(pc) : undefined;

  if (v.isValueType) {
    // FALLBACK (legacy bytecode, non-parameters only): where provenance has no
    // data-flow evidence, the classic "height − declarationRank" slot is a sound
    // completion on the classic pipeline — it locates a value at a stable frame
    // slot that provenance can't anchor without a read: a return parameter's
    // reserved (still-zero) slot, or a loop variable whose value number changes
    // each iteration. It is NOT used under viaIR (the model is invalid there),
    // nor for value PARAMETERS (the fixed-rank model mislocated them even on
    // legacy — provenance is authoritative for params).
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
  // FALLBACK — legacy only. The frame-relative slot is sound on the classic
  // pipeline (fixed frame slots) but NOT under viaIR, whose stack scheduler
  // reorders and reuses slots: the differential uniswap campaign showed it
  // decoding plausible-but-WRONG values there (a `bytes params` showing another
  // local's string, an array shown as its sibling). Under viaIR reference
  // handles are located by provenance instead (parameter entry claims,
  // declaration-end claims, and reads); unlocated ⇒ listed without a layout.
  if (depth === undefined && !cu.viaIR()) depth = frameDepth;
  if (depth !== undefined && depth >= 0) {
    Object.assign(
      result,
      memoryReferenceLayout(cu, v.solcType, v.typeLabel, depth)
    );
  }
  // KNOWN GAP: a CALLDATA dynamic bytes/string (`bytes calldata` / `string
  // calldata` param) is listed but NOT given a layout. Under viaIR it is a
  // 2-slot value (calldata offset + byte length), and — verified across Uniswap
  // frames — the offset can sit ABOVE or BELOW the length on the stack (e.g.
  // off@slot2/len@slot1 in `PoolManager.unlock` but off@slot0/len@slot1 in
  // `ActionsRouter`-style callees), so a single provenance-anchored slot plus a
  // fixed direction picks the wrong slot and decodes GARBAGE. Fail-safe: show
  // nothing (rather than a wrong value) until stackProvenance identifies BOTH
  // slots of a calldata slice. See the calldatafwd fixture.
  return result;
}

/**
 * The frame base (frame-relative) of a function, anchored ONCE via the static
 * analyzer. The frame base is the frame-relative slot below the first variable,
 * so `frameRelSlot(var) = frameBase + rank`. How the params sit on the stack
 * differs by ENTRY KIND, so the anchor does too:
 *
 * - **External / public** (entered from the dispatcher, as the recorded traces
 *   do): the function's own prologue ABI-DECODES its params and pushes them ABOVE
 *   the body entry. If the function declares return value(s), the prologue ALSO
 *   reserves one zero-initialised stack slot per return parameter, sitting BETWEEN
 *   the params and the locals — so `liveVarCount` at the anchor counts
 *   `paramCount + returnSlots` (no locals live yet, no expression temporaries) and
 *   `frameRelHeightAt(cleanPc) == frameBase + liveVarCount`. Hence
 *   `frameBase = frameRelHeightAt(cleanPc) − (paramCount + returnSlots)`. The
 *   caller ranks locals past those return slots so both params and locals resolve.
 *   This is the external-anchor selection (first body statement past the
 *   prologue), driven by the STATIC `frameRelHeightAt` rather than a trace length.
 *   (Each return parameter is assumed to occupy exactly one slot — the same
 *   one-slot assumption as params/locals; a dynamic calldata return would take two,
 *   the carried-over calldata-2-slot limitation.)
 *
 * - **Internal / private** (entered by a Solidity JUMP): the CALLER pushed the
 *   params BELOW the body entry, so they sit at the `paramCount` slots just below
 *   the analyzer's height-0 entry: `frameBase = frameRelHeightAt(entryPc) −
 *   paramCount` (= −paramCount). A first-statement anchor would misplace them,
 *   because an internal function that returns a value reserves its return slot on
 *   the stack in the prologue (counted into the first-statement height but not a
 *   variable). The reserved return slot(s) sit ABOVE this entry (between the
 *   below-entry params and the body locals), so the caller counts `returnSlots`
 *   into the LOCALS' ranks — an internal function with BOTH stack return slots AND
 *   body locals (e.g. the `helper` fixture: param `y`, return `out`, local `local`)
 *   ranks its locals correctly. (`frameBase` itself does NOT add `returnSlots`
 *   for internal entry: the params sit below the height-0 entry, unaffected by the
 *   later-reserved return slots.)
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
 * missing visibility) enter externally in the recorded frames; `internal`/
 * `private` are entered internally. NOTE: a `public` function CALLED
 * INTERNALLY within the same contract is entered by a JUMP with its params BELOW
 * the entry (like a private call), yet reports `visibility:'public'` — so its
 * shared body pcs would be anchored with the external model. No fixture exercises
 * a public function called internally; documented for the session cycle.
 */
function isExternalEntry(visibility: string | undefined): boolean {
  return (
    visibility === undefined ||
    visibility === 'public' ||
    visibility === 'external'
  );
}
