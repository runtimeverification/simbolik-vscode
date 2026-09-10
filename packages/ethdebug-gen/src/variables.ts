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
 * ── The uniform params+locals model ──────────────────────────────────────────
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
  findInnermostNode,
  sourceMapEntryAtPc,
  type AstNode,
  type CompilationUnit,
  type Contract,
} from '@simbolik/solc';

import {generateEthdebugProgram} from './index.js';
import {
  describeValueTypeString,
  functionParameters,
  type ParamDescriptor,
} from './functionParameters.js';
import {
  functionLocals,
  referenceTypeId,
  type LocalDescriptor,
} from './functionLocals.js';
import {stackHeights} from './stackHeights.js';
import {stackProvenance} from './stackProvenance.js';

/**
 * One value-type member of a reference-type variable (a memory struct),
 * with a CONCRETE ethdebug pointer that resolves the member's bytes at
 * dereference time (a `Group` whose value region reads the struct's runtime
 * memory offset out of the parent's stack slot).
 */
export interface StructMember {
  name: string;
  /** Solidity type string for display, e.g. `uint256`. */
  typeLabel: string;
  /** solc storage-style type id, e.g. `t_uint256` (empty for reference members). */
  solcType: string;
  numberOfBytes: number;
  /** Concrete member pointer, ready to dereference (value-type members only). */
  pointer?: Pointer;
}

/**
 * For a DYNAMIC MEMORY ARRAY variable, its element layout. The array's
 * stack slot holds the array's memory offset; `pointer` is a dereferenceable
 * `List` (wrapped in a `Group` that first names `base` = the stack slot and
 * `len` = the memory word at `base` = the element count) whose per-element
 * regions are NAMED `'element'` (index order). The consumer collects the values
 * via `regions.named('element')`. The variable itself stays `isValueType:false`
 * with no top-level pointer and no `members`.
 */
export interface ArrayLayout {
  /** Concrete `List` pointer, ready to dereference (element regions = `'element'`). */
  pointer: Pointer;
  /** solc storage-style element type id, e.g. `t_uint256`. */
  elementSolcType: string;
  /** Solidity element type string for display, e.g. `uint256`. */
  elementTypeLabel: string;
  /** Element size in bytes (1..32). */
  elementNumberOfBytes: number;
}

/**
 * For a MEMORY STRING / BYTES variable, its raw-byte layout. The stack
 * slot holds the memory offset; `pointer` is a `Group` (named `base` = the stack
 * slot, `len` = the memory word at `base` = the byte length) whose FINAL region
 * is the raw byte string (dynamic `length: {$read:'len'}` at `base+32`). The
 * consumer reads the final region as bytes and decodes (string → UTF-8, bytes →
 * hex). `isString` is true for `string`, false for `bytes`.
 */
export interface BytesLayout {
  /** Concrete `Group` pointer whose final region is the raw bytes. */
  pointer: Pointer;
  /** True for `string` (UTF-8 decode); false for `bytes` (hex). */
  isString: boolean;
}

/**
 * For a dynamic-`bytes`-encoded STORAGE `string`/`bytes` var, the layout
 * facts the session parity-selects on. `flagPointer` addresses the inline/flag word
 * (the base slot's full 32-byte word: HIGH bytes = inline short data, LOW byte =
 * length*2 with the parity bit); `longBaseSlot` is the CONCRETE `keccak256(pad32(
 * slot))` base for the long-form consecutive data words (static → computed at gen
 * time, no runtime `$keccak256`); `isString` selects UTF-8 vs `0x…` rendering.
 */
export interface BytesStorageLayout {
  /** Storage pointer at the inline/flag word (the base slot's full 32-byte word). */
  flagPointer: Pointer;
  /** CONCRETE keccak256(pad32(slot)) base slot for the long-form data words. */
  longBaseSlot: string;
  /** True for `string` (UTF-8 decode); false for `bytes` (hex). */
  isString: boolean;
}

/** A resolved live variable at a pc, with a concrete pointer for value types. */
export interface ResolvedVariable {
  name: string;
  kind: 'storage' | 'parameter' | 'return' | 'local';
  /** solc storage-style type id, e.g. `t_uint256`, `t_enum(Color)5`. */
  solcType: string;
  /** Solidity type string for display. */
  typeLabel: string;
  numberOfBytes: number;
  isValueType: boolean;
  /** Concrete pointer, ready to dereference (value types only). */
  pointer?: Pointer;
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
  mapping?: {baseSlot: number; keyType: string; valueType: string};
}

/**
 * The live variables at `pc` (storage + the enclosing function's params/locals),
 * each with a concrete ethdebug pointer for value types. Pure-static: `pc` is the
 * only runtime-adjacent input. Never throws — on any resolution failure it
 * returns the resolvable subset (at least the storage variables).
 */
export function variablesAt(
  cu: CompilationUnit,
  sourcePath: string,
  contractName: string,
  pc: number,
): ResolvedVariable[] {
  const out: ResolvedVariable[] = [];

  // 1. Storage variables — always present, with their static storage pointers.
  out.push(...storageVariables(cu, sourcePath, contractName));

  // 2..5. Stack variables (params + locals) of the enclosing function, if any.
  try {
    out.push(...stackVariables(cu, sourcePath, contractName, pc));
  } catch {
    // Any failure resolving the stack region degrades to storage-only.
  }
  return out;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/** The contract's storage variables as {@link ResolvedVariable}s (kind 'storage'). */
function storageVariables(
  cu: CompilationUnit,
  sourcePath: string,
  contractName: string,
): ResolvedVariable[] {
  try {
    const program = generateEthdebugProgram(cu, sourcePath, contractName);
    return program.storageVariables.map((sv) => {
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
// Stack region (params + locals)
// ---------------------------------------------------------------------------

/** One ordered stack variable (param, return, or local) in the uniform live list. */
interface StackVar {
  name: string;
  /** AST declaration id — the key the stack-provenance analyzer tags slots by. */
  declId: number;
  kind: 'parameter' | 'return' | 'local';
  solcType: string;
  typeLabel: string;
  numberOfBytes: number;
  isValueType: boolean;
}

/**
 * Per-contract cache of the two whole-contract CFG analyzers. Both
 * `stackProvenance` and `stackHeights` are PURE functions of the contract, so
 * they are built ONCE per contract and reused across every `pc`. Keyed by the
 * `Contract` object (stable within a `CompilationUnit`); a `WeakMap` lets the
 * entry be collected with its CU when a debug session ends. Without this the
 * full CFG analysis (O(contract size)) reran on every `variablesAt` call —
 * ~300ms per newly-visited pc on a large viaIR contract.
 */
const analyzerCache = new WeakMap<
  Contract,
  {
    provenance: ReturnType<typeof stackProvenance>;
    heights: ReturnType<typeof stackHeights>;
  }
>();

function analyzersFor(
  cu: CompilationUnit,
  sourcePath: string,
  contractName: string,
  contract: Contract,
): {provenance: ReturnType<typeof stackProvenance>; heights: ReturnType<typeof stackHeights>} {
  let entry = analyzerCache.get(contract);
  if (entry === undefined) {
    entry = {
      provenance: stackProvenance(cu, sourcePath, contractName),
      heights: stackHeights(cu, sourcePath, contractName),
    };
    analyzerCache.set(contract, entry);
  }
  return entry;
}

/** Resolve the enclosing function's live params+locals at `pc` to pointers. */
function stackVariables(
  cu: CompilationUnit,
  sourcePath: string,
  contractName: string,
  pc: number,
): ResolvedVariable[] {
  const contract = cu.contract(sourcePath, contractName);
  if (contract === undefined) return [];

  // 2. Enclosing function at pc: source map → innermost node → closestFunction.
  const entry = sourceMapEntryAtPc(contract, pc, 'runtime');
  if (entry === undefined || entry.fileId < 0) return [];
  const source = cu.sourceById(entry.fileId);
  if (source === undefined) return [];
  const node = findInnermostNode(source.ast(), entry.start, entry.length);
  if (node === undefined) return [];
  const fnNode = closestFunction(node);
  const fnName = fnNode?.name;
  if (fnNode === undefined || fnName === undefined) return [];

  const params = functionParameters(cu, sourcePath, contractName, fnName);
  const locals = functionLocals(cu, sourcePath, contractName, fnName);

  // Value-type params/locals are located by the per-pc stack-PROVENANCE analyzer
  // (codegen-agnostic: correct for viaIR's reordered/reused slots AND legacy). The
  // frame-relative height model below is retained ONLY to place reference-type
  // layouts (structs/arrays/strings), which the provenance analyzer does not track.
  const {provenance, heights} = analyzersFor(
    cu,
    sourcePath,
    contractName,
    contract,
  );
  // `heightHere`/`frameBase` may be undefined (analyzer couldn't resolve this pc,
  // or the frame couldn't be anchored). That no longer suppresses value-type
  // variables — they come from provenance — only the reference-type layouts below.

  const heightHere = heights.frameRelHeightAt(pc);

  // A frame reserves a stack slot for EACH return parameter between the params and
  // the locals (the return values, zero-initialised in the prologue). This holds
  // for BOTH external and internal entry, so the count is unconditional. ALL
  // declared returns (including UNNAMED ones) reserve a slot, so locals rank past
  // them correctly. Those slots must be counted so params, returns AND locals rank
  // correctly.
  const returnNodes = fnNode.returnParameters();
  const returnSlots = returnNodes.length;

  // 3. frameBase — anchored ONCE per function via the static analyzer (used only
  //    for reference-type layouts; value types no longer depend on it).
  const frameBase = anchorFrameBase(
    cu,
    contract,
    fnNode,
    params,
    locals,
    returnSlots,
    heights,
  );

  // 4. Uniform LIVE ordering: params (always live), then return params (always
  //    live once entered), then in-scope locals — all in declaration order;
  //    reference vars are included so they consume a rank. The reserved
  //    return-value slot(s) sit BETWEEN the params and the locals: a return param
  //    at declaration index `i` ranks at `params.length + i`, and the locals' ranks
  //    are offset past ALL reserved return slots (`returnSlots`). UNNAMED returns
  //    are NOT emitted as variables but STILL reserve a slot (they count toward
  //    `returnSlots` and consume a return rank), so named returns and locals after
  //    them rank correctly.
  const offset = entry.start;
  const paramVars = params.map(paramToStackVar);
  const returnRanked: Array<{v: StackVar; rank: number}> = [];
  returnNodes.forEach((node, i) => {
    const name = node.name;
    if (name === undefined || name === '') return; // unnamed: reserved, not emitted.
    returnRanked.push({v: returnParamToStackVar(node, name), rank: paramVars.length + i});
  });
  const localVars = locals.filter((l) => isLive(l, offset)).map(localToStackVar);
  const ranked: Array<{v: StackVar; rank: number}> = [
    ...paramVars.map((v, i) => ({v, rank: i})),
    ...returnRanked,
    ...localVars.map((v, j) => ({v, rank: paramVars.length + returnSlots + j})),
  ];

  // 5. Per-variable stack pointer at this pc.
  return ranked.map(({v, rank}) => {
    const result: ResolvedVariable = {
      name: v.name,
      kind: v.kind,
      solcType: v.solcType,
      typeLabel: v.typeLabel,
      numberOfBytes: v.numberOfBytes,
      isValueType: v.isValueType,
    };
    // Frame-relative fixed-slot depth (legacy codegen model). Used for value
    // types only as a completeness FALLBACK on legacy bytecode, and for
    // reference-type layouts.
    const frameDepth =
      heightHere !== undefined && frameBase !== undefined
        ? heightHere - 1 - (frameBase + rank)
        : undefined;

    if (v.isValueType) {
      // PRIMARY, codegen-agnostic location: the per-pc stack-provenance analyzer
      // (sound for viaIR's reordered/reused slots AND legacy). `undefined` means
      // the value is not known to be on the stack here.
      let depth = provenance.variableDepthAt(pc, v.declId);

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
      result.pointer = {
        location: 'stack',
        slot: depth,
        offset: v.solcType.startsWith('t_bytes') ? 0 : 32 - v.numberOfBytes,
        length: v.numberOfBytes,
      };
      return result;
    }

    // Reference/dynamic types still use the frame-relative fixed-slot model.
    if (frameDepth === undefined) {
      return result; // frame unresolved → list reference var without a layout.
    }
    const depth = frameDepth;

    // Reference/dynamic: listed, no top-level pointer (still consumed a rank).
    // A MEMORY STRUCT of value-type members is expanded into per-member
    // pointers (a `Group` reading the struct's memory offset from its stack slot).
    // Arrays/strings/mappings stay bare. The expansion is
    // gated to MEMORY structs (the solc typeIdentifier carries the data location,
    // e.g. `t_struct$_Point_$10_memory_ptr`): a STORAGE or CALLDATA struct local/
    // param holds a storage-slot / calldata offset in its stack slot — NOT a memory
    // offset — so the memory member pointers below would decode WRONG values from
    // it. Those are left bare (listed, no members) until their own cycle rather than
    // mis-decoded. (Fixtures only exercise a memory struct.)
    if (depth >= 0 && v.solcType.includes('_memory')) {
      if (v.solcType.startsWith('t_struct')) {
        const members = structMemberPointers(cu, v.solcType, depth);
        if (members.length > 0) {
          result.members = members;
        }
      } else if (v.solcType.startsWith('t_array')) {
        // A DYNAMIC memory array of value-type elements → a `List` layout.
        const array = arrayLayout(v.solcType, v.typeLabel, depth);
        if (array !== undefined) {
          result.array = array;
        }
      } else if (
        v.solcType.startsWith('t_string') ||
        v.solcType.startsWith('t_bytes_')
      ) {
        // A memory string/bytes → a raw-byte layout (final region = bytes).
        result.bytes = bytesLayout(v.solcType.startsWith('t_string'), depth);
      }
    }
    return result;
  });
}

/**
 * The value-type members of a MEMORY struct, each with a concrete ethdebug
 * pointer. The struct's memory offset lives in the local's stack slot at `depth`;
 * member k (a value type of `N` bytes) sits at memory word k of the struct. Each
 * member pointer is a `Group`:
 *   - a NAMED base region over the stack slot (`{name:'base', slot: depth, …}`),
 *     whose 32-byte value IS the struct's runtime memory offset;
 *   - a memory value region at `{$sum:[{$read:'base'}, k*32 + inWord]}` of length
 *     `N`, where `inWord` right-aligns non-`bytesN` value types within the word
 *     (`32 − N`; `bytesN` are left-aligned so `inWord = 0`).
 * The producer supplies only this LAYOUT; `@ethdebug/pointers` resolves the
 * `$read`/`$sum` against the machine state at dereference. Reference-type members
 * (out of scope) are listed without a pointer rather than crashing.
 */
function structMemberPointers(
  cu: CompilationUnit,
  structSolcType: string,
  depth: number,
): StructMember[] {
  return cu.structMembers(structSolcType).map((m, k) => {
    const desc = describeValueTypeString(m.typeString);
    if (desc === undefined) {
      // Reference-type member (nested struct / array / string): out of scope.
      return {
        name: m.name,
        typeLabel: m.typeString,
        solcType: '',
        numberOfBytes: 0,
      };
    }
    const n = desc.numberOfBytes;
    const inWord = desc.typeId.startsWith('t_bytes') ? 0 : 32 - n;
    const pointer: Pointer = {
      group: [
        {name: 'base', location: 'stack', slot: depth, offset: 0, length: 32},
        {
          location: 'memory',
          offset: {$sum: [{$read: 'base'}, k * 32 + inWord]},
          length: n,
        },
      ],
    };
    return {
      name: m.name,
      typeLabel: m.typeString,
      solcType: desc.typeId,
      numberOfBytes: n,
      pointer,
    };
  });
}

/**
 * The `List` layout of a DYNAMIC memory array of VALUE-TYPE elements.
 * The array's memory offset lives in the local's stack slot at `depth`; the
 * element count is the memory word at that offset, and element `i` (a value type
 * of one word) sits at `offset + 32 + i*32`. The pointer is a `Group`:
 *   - `base` — the stack slot (its 32-byte value IS the array's memory offset);
 *   - `len` — the memory word at `base` (the element count);
 *   - a `List` of `count:{$read:'len'}` regions NAMED `'element'`, each a 32-byte
 *     memory word at `{$sum:[{$read:'base'}, 32, {$product:['i', 32]}]}`.
 * The producer supplies only this LAYOUT; `@ethdebug/pointers` resolves the
 * `$read`/`$sum`/`$product` against the machine state at dereference. Returns
 * `undefined` for a non-value-type element (out of scope this cycle).
 *
 * FIXED-size arrays (`t_array$_…_$<N>_memory_ptr`) are also handled here: a fixed
 * memory `T[N]` is inline with NO length word — the stack slot points DIRECTLY at
 * element 0, so element `i` sits at `base + i*32` and the count is the static `N`.
 * The pointer drops the `len` region and the leading `+32` of the dynamic form.
 */
function arrayLayout(
  arraySolcType: string,
  arrayTypeLabel: string,
  depth: number,
): ArrayLayout | undefined {
  // Dynamic OR fixed memory arrays: `t_array$_<elemId>_$(dyn|<N>)_memory_ptr`.
  const m = /^t_array\$_(.+)_\$(dyn|\d+)_memory_ptr$/.exec(arraySolcType);
  if (m === null) return undefined;
  const sizeToken = m[2]!;
  const isDynamic = sizeToken === 'dyn';
  // Element type/size from the array's display label (`uint256[]` → `uint256`),
  // reusing the value-type describer. `elementSolcType` comes from the same
  // describer so it matches the value-decode path.
  const elementTypeLabel = arrayTypeLabel.replace(/\[\d*\]\s*(memory|calldata|storage)?\s*$/, '').trim();
  const desc = describeValueTypeString(elementTypeLabel);
  if (desc === undefined) return undefined; // reference-type elements: out of scope.

  const pointer: Pointer = isDynamic
    ? {
        group: [
          {name: 'base', location: 'stack', slot: depth, offset: 0, length: 32},
          {name: 'len', location: 'memory', offset: {$read: 'base'}, length: 32},
          {
            list: {
              count: {$read: 'len'},
              each: 'i',
              is: {
                name: 'element',
                location: 'memory',
                offset: {$sum: [{$read: 'base'}, 32, {$product: ['i', 32]}]},
                length: 32,
              },
            },
          },
        ],
      }
    : {
        // Fixed `T[N]`: no `len` region, static count, element i at base + i*32.
        group: [
          {name: 'base', location: 'stack', slot: depth, offset: 0, length: 32},
          {
            list: {
              count: Number(sizeToken),
              each: 'i',
              is: {
                name: 'element',
                location: 'memory',
                offset: {$sum: [{$read: 'base'}, {$product: ['i', 32]}]},
                length: 32,
              },
            },
          },
        ],
      };
  return {
    pointer,
    elementSolcType: desc.typeId,
    elementTypeLabel,
    elementNumberOfBytes: desc.numberOfBytes,
  };
}

/**
 * The raw-byte layout of a memory string/bytes. The memory offset lives
 * in the local's stack slot at `depth`; the byte length is the memory word at
 * that offset, and the raw bytes follow at `offset + 32`. The pointer is a
 * `Group`:
 *   - `base` — the stack slot (the memory offset);
 *   - `len` — the memory word at `base` (the byte length);
 *   - a raw byte region of dynamic `length:{$read:'len'}` at `{$sum:[{$read:
 *     'base'}, 32]}` — the FINAL region, which the consumer reads as bytes.
 */
function bytesLayout(isString: boolean, depth: number): BytesLayout {
  const pointer: Pointer = {
    group: [
      {name: 'base', location: 'stack', slot: depth, offset: 0, length: 32},
      {name: 'len', location: 'memory', offset: {$read: 'base'}, length: 32},
      {
        location: 'memory',
        offset: {$sum: [{$read: 'base'}, 32]},
        length: {$read: 'len'},
      },
    ],
  };
  return {pointer, isString};
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
 *   now ranks its locals correctly. (`frameBase` itself does NOT add `returnSlots`
 *   for internal entry: the params sit below the height-0 entry, unaffected by the
 *   later-reserved return slots.)
 */
function anchorFrameBase(
  cu: CompilationUnit,
  contract: Contract,
  fnNode: {id: number; visibility?: string},
  params: ParamDescriptor[],
  locals: LocalDescriptor[],
  returnSlots: number,
  heights: ReturnType<typeof stackHeights>,
): number | undefined {
  const external = isExternalEntry(fnNode.visibility);
  const bytecode = contract.runtimeBytecode();
  const sourceMap = contract.runtimeSourceMap();
  const {instructionToPc} = buildInstructionIndex(bytecode);

  let prevStmtId: number | undefined;
  for (let i = 0; i < sourceMap.length; i++) {
    const smEntry = sourceMap[i];
    if (smEntry === undefined || smEntry.fileId < 0) continue;
    const src = cu.sourceById(smEntry.fileId);
    if (src === undefined) continue;
    const n = findInnermostNode(src.ast(), smEntry.start, smEntry.length);
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
      locals.filter((l) => isLive(l, smEntry.start)).length;
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

function paramToStackVar(p: ParamDescriptor): StackVar {
  return {
    name: p.name,
    declId: p.declId,
    kind: 'parameter',
    solcType: p.solcType,
    typeLabel: p.typeLabel,
    numberOfBytes: p.numberOfBytes,
    isValueType: p.isValueType,
  };
}

/**
 * A NAMED return parameter's AST node → an ordered stack variable (kind 'return'),
 * reusing the same value-type mapping as params/locals ({@link describeValueTypeString}).
 * Reference/dynamic returns get `isValueType:false` and no pointer downstream, but
 * still consume a rank/slot.
 */
function returnParamToStackVar(node: AstNode, name: string): StackVar {
  const typeLabel = node.typeString ?? '';
  const desc = describeValueTypeString(typeLabel);
  return {
    name,
    declId: node.id,
    kind: 'return',
    // Reference-type returns carry their solc structural type id.
    solcType: desc?.typeId ?? referenceTypeId(node),
    typeLabel,
    numberOfBytes: desc?.numberOfBytes ?? 0,
    isValueType: desc !== undefined,
  };
}

function localToStackVar(l: LocalDescriptor): StackVar {
  return {
    name: l.name,
    declId: l.declId,
    kind: 'local',
    solcType: l.solcType,
    typeLabel: l.typeLabel,
    numberOfBytes: l.numberOfBytes,
    isValueType: l.isValueType,
  };
}

/**
 * Whether a local is live at source `offset`: its enclosing lexical scope covers
 * the offset AND its declaration statement has completed.
 */
function isLive(local: LocalDescriptor, offset: number): boolean {
  return (
    offset >= local.declEnd &&
    offset >= local.scopeStart &&
    offset < local.scopeEnd
  );
}
