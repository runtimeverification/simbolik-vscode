/**
 * Static per-pc stack-PROVENANCE analyzer (codegen-agnostic: legacy AND viaIR).
 *
 * {@link stackProvenance} answers, for a value-type stack variable (a function
 * parameter, named return, or local — identified by its AST declaration id) and
 * a runtime pc: at what DEPTH-FROM-TOP does a stack slot HOLDING that variable's
 * value sit on arrival at `pc`? — or `undefined` when no slot is known to hold it
 * there (the variable is then OMITTED by the consumer, which is always sound).
 *
 * ── Why not "height − declarationRank" ───────────────────────────────────────
 * The legacy model assumed every local lived at one fixed frame slot in
 * declaration order. Contracts compiled with `viaIR:true` (the Yul pipeline) have
 * their stack REORDERED and REUSED per instruction by the Yul stack scheduler, so
 * a variable's real depth is a PER-PC property. This analyzer computes that per-pc
 * location by SIMULATING the stack, so it is correct for both pipelines. (It also
 * repairs value-PARAMETER locations on legacy code, which the fixed-rank model got
 * wrong at some pcs.)
 *
 * ── Value numbering ──────────────────────────────────────────────────────────
 * A per-function CFG worklist (mirroring {@link stackHeights}) propagates an
 * abstract stack whose every slot carries an optional known PUSH CONSTANT (to
 * resolve JUMP targets, exactly as the height analyzer does) and a deterministic
 * ORIGIN id — a value number identifying WHICH runtime value occupies the slot:
 *   - a value CREATED by an instruction at pc `p` (a PUSH, or any opcode result)
 *     gets origin derived from `p` — stable across worklist revisits;
 *   - the frame's below-entry (caller) slots get distinct per-function origins;
 *   - `DUPn` COPIES a slot's origin (a duplicate is the SAME value);
 *   - `SWAPn` moves slots (origins follow their values);
 *   - every other opcode pops its inputs and pushes freshly-originated results, so
 *     a slot an op overwrites gets a NEW value number (its old identity is gone).
 * Two slots share an origin iff they hold the same value; an overwrite always
 * changes the origin. Internal calls are folded into a net stack effect (never
 * followed into), keeping the caller's slots — hence origins and depths — intact.
 *
 * ── How a value gets identified as a variable (the anchor) ───────────────────
 * A variable READ is the anchor: when an instruction's source-map node is an
 * `Identifier` whose `referencedDeclaration` is a function param/local AND the
 * opcode is `DUPn`, the slot being duplicated (depth `n`) provably HOLDS that
 * variable's value — solc emits exactly this `DUPn` to read a value-type stack
 * variable (verified against recorded traces to read the correct value at 100% of
 * anchor pcs). We map that slot's ORIGIN to the variable. The variable is then
 * reported at EVERY pc where a slot with that origin is live — before the read
 * (same value, e.g. a parameter from function entry) and after — because it is
 * provably the very value the read observed.
 *
 * ── Merges ───────────────────────────────────────────────────────────────────
 * At a pc reachable from multiple predecessors the incoming stacks are INTERSECTED
 * (a constant/origin survives only where all predecessors agree), reaching a least
 * fixpoint. A slot whose origin survives a merge holds the SAME value on every
 * path, so reporting its variable there is sound; where paths disagree (e.g. a
 * variable reassigned on one branch) the origin is dropped and the variable is
 * omitted. A pc reached at two conflicting heights (optimizer block-sharing,
 * inline assembly, …) is marked ambiguous and reports `undefined`, never a guess.
 *
 * PURE-STATIC: solc artifacts only, no trace. Never throws for a single pc query.
 */
import {
  buildInstructionIndex,
  closestFunction,
  findInnermostNode,
  type CompilationUnit,
  type Contract,
  type Jump,
  type SourceMapEntry,
} from '@simbolik/solc';

/** The public accessor returned by {@link stackProvenance}. */
export interface StackProvenance {
  /**
   * Depth-from-top of a stack slot holding the value of the variable with AST
   * declaration id `declId` on arrival at `pc`, or `undefined` if none is known
   * (variable unavailable / pc outside any analyzed body / ambiguous merge).
   */
  variableDepthAt(pc: number, declId: number): number | undefined;
}

// ---------------------------------------------------------------------------
// Opcode stack input/output arity (source of truth; delta = out − in)
// ---------------------------------------------------------------------------

/**
 * Precise `{in, out}` stack arity of a straight-line opcode (NOT push/dup/swap/
 * jump, which are handled specially). Unlike a net delta, the separate input
 * count is what lets a consumed slot be dropped and each result be freshly
 * value-numbered — e.g. `ISZERO`/`NOT` (in 1, out 1) must give the top a new
 * origin even though their net delta is 0. Deltas here match the validated
 * {@link stackHeights} table exactly.
 */
function stackInOut(op: number): {nIn: number; nOut: number} {
  if (op >= 0xa0 && op <= 0xa4) {
    return {nIn: 2 + (op - 0xa0), nOut: 0}; // LOG0..LOG4
  }
  switch (op) {
    // Binary arithmetic / comparison / bitwise: pop 2, push 1.
    case 0x01: // ADD
    case 0x02: // MUL
    case 0x03: // SUB
    case 0x04: // DIV
    case 0x05: // SDIV
    case 0x06: // MOD
    case 0x07: // SMOD
    case 0x0a: // EXP
    case 0x0b: // SIGNEXTEND
    case 0x10: // LT
    case 0x11: // GT
    case 0x12: // SLT
    case 0x13: // SGT
    case 0x14: // EQ
    case 0x16: // AND
    case 0x17: // OR
    case 0x18: // XOR
    case 0x1a: // BYTE
    case 0x1b: // SHL
    case 0x1c: // SHR
    case 0x1d: // SAR
    case 0x20: // KECCAK256
      return {nIn: 2, nOut: 1};
    // Unary: pop 1, push 1.
    case 0x15: // ISZERO
    case 0x19: // NOT
      return {nIn: 1, nOut: 1};
    // Ternary arithmetic: pop 3, push 1.
    case 0x08: // ADDMOD
    case 0x09: // MULMOD
      return {nIn: 3, nOut: 1};
    // Load-from-1: pop 1, push 1.
    case 0x51: // MLOAD
    case 0x54: // SLOAD
    case 0x5c: // TLOAD
    case 0x31: // BALANCE
    case 0x3b: // EXTCODESIZE
    case 0x3f: // EXTCODEHASH
    case 0x35: // CALLDATALOAD
    case 0x40: // BLOCKHASH
    case 0x49: // BLOBHASH
      return {nIn: 1, nOut: 1};
    // Store: pop 2.
    case 0x52: // MSTORE
    case 0x53: // MSTORE8
    case 0x55: // SSTORE
    case 0x5d: // TSTORE
      return {nIn: 2, nOut: 0};
    case 0x50: // POP
      return {nIn: 1, nOut: 0};
    case 0x56: // JUMP (handled specially; here for completeness)
      return {nIn: 1, nOut: 0};
    case 0x57: // JUMPI (handled specially)
      return {nIn: 2, nOut: 0};
    case 0x5b: // JUMPDEST
    case 0x00: // STOP
    case 0xfe: // INVALID
      return {nIn: 0, nOut: 0};
    // Nullary pushes (env/state): push 1.
    case 0x30: // ADDRESS
    case 0x32: // ORIGIN
    case 0x33: // CALLER
    case 0x34: // CALLVALUE
    case 0x36: // CALLDATASIZE
    case 0x38: // CODESIZE
    case 0x3a: // GASPRICE
    case 0x3d: // RETURNDATASIZE
    case 0x41: // COINBASE
    case 0x42: // TIMESTAMP
    case 0x43: // NUMBER
    case 0x44: // PREVRANDAO
    case 0x45: // GASLIMIT
    case 0x46: // CHAINID
    case 0x47: // SELFBALANCE
    case 0x48: // BASEFEE
    case 0x4a: // BLOBBASEFEE
    case 0x58: // PC
    case 0x59: // MSIZE
    case 0x5a: // GAS
      return {nIn: 0, nOut: 1};
    // Copies: pop 3.
    case 0x37: // CALLDATACOPY
    case 0x39: // CODECOPY
    case 0x3e: // RETURNDATACOPY
    case 0x5e: // MCOPY
      return {nIn: 3, nOut: 0};
    case 0x3c: // EXTCODECOPY: pop 4.
      return {nIn: 4, nOut: 0};
    case 0xf0: // CREATE: pop 3, push 1.
      return {nIn: 3, nOut: 1};
    case 0xf5: // CREATE2: pop 4, push 1.
      return {nIn: 4, nOut: 1};
    case 0xf1: // CALL: pop 7, push 1.
    case 0xf2: // CALLCODE
      return {nIn: 7, nOut: 1};
    case 0xf4: // DELEGATECALL: pop 6, push 1.
    case 0xfa: // STATICCALL
      return {nIn: 6, nOut: 1};
    case 0xf3: // RETURN: pop 2.
    case 0xfd: // REVERT
      return {nIn: 2, nOut: 0};
    case 0xff: // SELFDESTRUCT: pop 1.
      return {nIn: 1, nOut: 0};
    default:
      // Unknown opcode: conservatively clear the top and push one fresh result so
      // a value identity can never leak through an unmodelled op.
      return {nIn: 1, nOut: 1};
  }
}

/** Net stack effect of an opcode (out − in), consistent with the arity table. */
function stackDelta(op: number): number {
  if (op === 0x5f || (op >= 0x60 && op <= 0x7f)) return 1; // PUSH0 / PUSHn
  if (op >= 0x80 && op <= 0x8f) return 1; // DUPn
  if (op >= 0x90 && op <= 0x9f) return 0; // SWAPn
  const {nIn, nOut} = stackInOut(op);
  return nOut - nIn;
}

/** Opcodes that end a basic block with no in-frame fall-through successor. */
function isBlockTerminator(op: number): boolean {
  return (
    op === 0x00 || // STOP
    op === 0xf3 || // RETURN
    op === 0xfd || // REVERT
    op === 0xfe || // INVALID
    op === 0xff // SELFDESTRUCT
  );
}

// ---------------------------------------------------------------------------
// Disassembly + attribution
// ---------------------------------------------------------------------------

/** One decoded instruction with everything the analysis needs, precomputed. */
interface Insn {
  pc: number;
  op: number;
  size: number;
  pushValue: number;
  delta: number;
  jump: Jump;
  /** Enclosing `FunctionDefinition` AST id, or `undefined` (helper/dispatcher). */
  fnId: number | undefined;
  /**
   * A variable-READ anchor: this is a `DUPn` whose source-map node is an
   * `Identifier` referring to the param/local with `declId`; `depth` (= n) is the
   * depth-from-top of the slot it duplicates, which holds that variable's value.
   */
  anchor?: {declId: number; depth: number};
}

/** One abstract stack slot: an optional known constant + a value-number origin. */
interface Slot {
  /** Known PUSH constant value (for JUMP-target resolution), else `undefined`. */
  const?: number;
  /** Value number: which runtime value occupies this slot, else `undefined`. */
  origin?: number;
}

type Stack = Slot[];

function cloneStack(s: Stack): Stack {
  return s.map((slot) => ({...slot}));
}

/** Top-of-stack constant (`undefined` if unknown/empty). */
function topConst(s: Stack): number | undefined {
  return s.length > 0 ? s[s.length - 1]!.const : undefined;
}

/** Whether two stacks are identical in both constants and origins. */
function stacksEqual(a: Stack, b: Stack): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]!.const !== b[i]!.const || a[i]!.origin !== b[i]!.origin) {
      return false;
    }
  }
  return true;
}

/**
 * Merge (intersect) two incoming stacks of equal length: a constant/origin
 * survives only where both agree.
 */
function mergeStack(a: Stack, b: Stack): Stack {
  const out: Stack = new Array<Slot>(a.length);
  for (let i = 0; i < a.length; i++) {
    const sa = a[i]!;
    const sb = b[i]!;
    const slot: Slot = {};
    if (sa.const !== undefined && sa.const === sb.const) slot.const = sa.const;
    if (sa.origin !== undefined && sa.origin === sb.origin) {
      slot.origin = sa.origin;
    }
    out[i] = slot;
  }
  return out;
}

/** A freshly value-numbered result of the instruction at `pc` (output index `k`). */
function freshOrigin(pc: number, k: number): number {
  return pc * 8 + k; // pc-derived ⇒ stable across worklist revisits; k < 8.
}

/**
 * Apply a straight-line (non-JUMP/JUMPI) opcode to the stack, tracking PUSH/DUP/
 * SWAP constants+origins exactly and modelling every other opcode as popping its
 * inputs and pushing freshly value-numbered results.
 */
function applyToStack(s: Stack, insn: Insn): void {
  const {op, pc} = insn;
  if (op === 0x5f) {
    s.push({const: 0, origin: freshOrigin(pc, 0)}); // PUSH0
    return;
  }
  if (op >= 0x60 && op <= 0x7f) {
    s.push({const: insn.pushValue, origin: freshOrigin(pc, 0)}); // PUSHn
    return;
  }
  if (op >= 0x80 && op <= 0x8f) {
    // DUPn duplicates the slot at depth n (DUP1 → the top): copy const AND origin.
    const n = op - 0x80;
    const src = s[s.length - 1 - n];
    s.push(src ? {...src} : {origin: freshOrigin(pc, 0)});
    return;
  }
  if (op >= 0x90 && op <= 0x9f) {
    // SWAPn swaps the top with the slot at depth n (origins follow values).
    const n = op - 0x90 + 1;
    const i = s.length - 1;
    const j = s.length - 1 - n;
    if (j >= 0) {
      const tmp = s[i]!;
      s[i] = s[j]!;
      s[j] = tmp;
    }
    return;
  }
  const {nIn, nOut} = stackInOut(op);
  for (let k = 0; k < nIn; k++) s.pop();
  for (let k = 0; k < nOut; k++) s.push({origin: freshOrigin(pc, k)});
}

// ---------------------------------------------------------------------------
// The analyzer
// ---------------------------------------------------------------------------

class Analyzer {
  private readonly insns = new Map<number, Insn>();
  private readonly jumpdests = new Set<number>();
  private readonly entryByFn = new Map<number, number>();
  /** Per-pc recorded arrival stack (least fixpoint). */
  private readonly recorded = new Map<number, Stack>();
  private readonly conflicted = new Set<number>();
  /** AST ids of function params/locals (the taggable stack variables). */
  private readonly varDeclIds = new Set<number>();
  /** Value number (origin) → the variable declId a read proved it to hold. */
  private readonly originToDecl = new Map<number, number>();
  /** Origins a read tied to two different variables (ambiguous ⇒ never reported). */
  private readonly originAmbiguous = new Set<number>();
  private readonly netCache = new Map<number, number | undefined>();
  private readonly netInProgress = new Set<number>();

  constructor(cu: CompilationUnit, contract: Contract) {
    this.collectVarDeclIds(cu);
    this.disassemble(cu, contract);
  }

  /** All function param/local `VariableDeclaration` ids across the unit. */
  private collectVarDeclIds(cu: CompilationUnit): void {
    for (const source of cu.sources()) {
      let ast;
      try {
        ast = source.ast();
      } catch {
        continue;
      }
      const visit = (node: {
        nodeType: string;
        id: number;
        children(): unknown[];
      }): void => {
        if (
          node.nodeType === 'VariableDeclaration' &&
          node.id >= 0 &&
          // A param/local sits inside a FunctionDefinition; a state variable does
          // not (it is a direct child of the ContractDefinition).
          closestFunction(node as never) !== undefined
        ) {
          this.varDeclIds.add(node.id);
        }
        for (const child of node.children() as (typeof node)[]) {
          visit(child);
        }
      };
      visit(ast as never);
    }
  }

  /** Decode every instruction; attribute to a function; detect read anchors. */
  private disassemble(cu: CompilationUnit, contract: Contract): void {
    const bytecode = contract.runtimeBytecode();
    const bytes = hexToBytes(bytecode);
    const {instructionToPc} = buildInstructionIndex(bytecode);
    const sourceMap = contract.runtimeSourceMap();

    for (let i = 0; i < instructionToPc.length; i++) {
      const pc = instructionToPc[i]!;
      const op = bytes[pc]!;
      let size = 1;
      let pushValue = 0;
      if (op >= 0x60 && op <= 0x7f) {
        const n = op - 0x5f;
        size += n;
        for (let k = 0; k < n; k++) {
          pushValue = pushValue * 256 + (bytes[pc + 1 + k] ?? 0);
        }
      }
      if (op === 0x5b) {
        this.jumpdests.add(pc);
      }
      const entry = sourceMap[i];
      const fnId = entry ? this.attributeFunction(cu, entry) : undefined;
      const anchor =
        entry && op >= 0x80 && op <= 0x8f
          ? this.readAnchor(cu, entry, op)
          : undefined;
      this.insns.set(pc, {
        pc,
        op,
        size,
        pushValue,
        delta: stackDelta(op),
        jump: entry?.jump ?? '-',
        fnId,
        ...(anchor ? {anchor} : {}),
      });
      if (fnId !== undefined) {
        const prev = this.entryByFn.get(fnId);
        if (prev === undefined || pc < prev) {
          this.entryByFn.set(fnId, pc);
        }
      }
    }
  }

  /**
   * If `entry`'s innermost node is an `Identifier` reading a known param/local, a
   * read anchor for a `DUPn` (`op`): the duplicated slot at depth `n = op − 0x80`
   * holds that variable.
   */
  private readAnchor(
    cu: CompilationUnit,
    entry: SourceMapEntry,
    op: number,
  ): {declId: number; depth: number} | undefined {
    if (entry.fileId < 0) return undefined;
    const source = cu.sourceById(entry.fileId);
    if (source === undefined) return undefined;
    const node = findInnermostNode(source.ast(), entry.start, entry.length);
    if (node === undefined || node.nodeType !== 'Identifier') return undefined;
    const declId = node.referencedDeclaration;
    if (declId === undefined || !this.varDeclIds.has(declId)) return undefined;
    return {declId, depth: op - 0x80};
  }

  private attributeFunction(
    cu: CompilationUnit,
    entry: SourceMapEntry,
  ): number | undefined {
    if (entry.fileId < 0) return undefined;
    const source = cu.sourceById(entry.fileId);
    if (source === undefined) return undefined;
    const node = findInnermostNode(source.ast(), entry.start, entry.length);
    if (node === undefined) return undefined;
    const fn = closestFunction(node);
    return fn === undefined ? undefined : fn.id;
  }

  analyze(): void {
    for (const entryPc of this.entryByFn.values()) {
      this.propagateFunction(entryPc);
    }
  }

  variableDepthAt(pc: number, declId: number): number | undefined {
    if (this.conflicted.has(pc)) return undefined;
    const stack = this.recorded.get(pc);
    if (stack === undefined) return undefined;
    // Shallowest slot (closest to top) whose value was proved to be this
    // variable; all such slots hold the value, so any is sound.
    for (let depth = 0; depth < stack.length; depth++) {
      const origin = stack[stack.length - 1 - depth]!.origin;
      if (origin === undefined || this.originAmbiguous.has(origin)) continue;
      if (this.originToDecl.get(origin) === declId) return depth;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Intra-function CFG worklist (least-fixpoint with origin intersection)
  // -------------------------------------------------------------------------

  private propagateFunction(entryPc: number): void {
    const fnId = this.insns.get(entryPc)?.fnId;
    interface Item {
      pc: number;
      stack: Stack;
    }
    const work: Item[] = [{pc: entryPc, stack: baseStack(entryPc)}];
    // Defensive iteration cap (the monotone-descending lattice terminates well
    // before this; guards against pathological optimizer output).
    let budget = 2000000;

    while (work.length > 0 && budget-- > 0) {
      const {pc, stack: incoming} = work.pop()!;
      const insn = this.insns.get(pc);
      if (insn === undefined) continue; // into push data / past end.
      if (this.conflicted.has(pc)) continue;

      const prev = this.recorded.get(pc);
      let cur: Stack;
      if (prev === undefined) {
        cur = cloneStack(incoming);
        this.recorded.set(pc, cur);
      } else if (prev.length !== incoming.length) {
        // Two conflicting heights reach this pc — the frame-relative model can't
        // assign a single depth; report unknown rather than guess.
        this.conflicted.add(pc);
        continue;
      } else {
        const merged = mergeStack(prev, incoming);
        if (stacksEqual(merged, prev)) continue; // fixpoint for this pc.
        cur = merged;
        this.recorded.set(pc, cur);
      }

      // Read anchor: the duplicated slot's VALUE is proved to be `declId` — record
      // that value number so the variable is reported wherever this value lives.
      if (insn.anchor !== undefined) {
        const idx = cur.length - 1 - insn.anchor.depth;
        const origin = idx >= 0 ? cur[idx]!.origin : undefined;
        if (origin !== undefined) this.recordRead(origin, insn.anchor.declId);
      }

      if (isBlockTerminator(insn.op)) continue;

      if (insn.op === 0x56) {
        this.handleJump(cur, insn, fnId, (next) => work.push(next));
        continue;
      }

      if (insn.op === 0x57) {
        // JUMPI: pop dest + cond; propagate to target and fall-through.
        const target = topConst(cur);
        const branched = cloneStack(cur);
        branched.pop(); // dest
        branched.pop(); // cond
        if (target !== undefined && this.jumpdests.has(target)) {
          work.push({pc: target, stack: cloneStack(branched)});
        }
        work.push({pc: pc + insn.size, stack: branched});
        continue;
      }

      const nextStack = cloneStack(cur);
      applyToStack(nextStack, insn);
      work.push({pc: pc + insn.size, stack: nextStack});
    }
  }

  /** Tie a value number to the variable a read proved it to hold (guard conflicts). */
  private recordRead(origin: number, declId: number): void {
    if (this.originAmbiguous.has(origin)) return;
    const prev = this.originToDecl.get(origin);
    if (prev === undefined) {
      this.originToDecl.set(origin, declId);
    } else if (prev !== declId) {
      // The same value read as two different variables — cannot both be sound.
      this.originAmbiguous.add(origin);
    }
  }

  private handleJump(
    stack: Stack,
    insn: Insn,
    fnId: number | undefined,
    push: (item: {pc: number; stack: Stack}) => void,
  ): void {
    const target = topConst(stack);
    if (target === undefined || !this.jumpdests.has(target)) {
      return; // dynamic target = return address ⇒ frame return.
    }
    if (this.isCall(insn, fnId, target)) {
      const net = this.netEffect(target);
      if (net === undefined) return; // callee never returns.
      const depth = this.returnTagDepth(stack, fnId);
      if (depth === undefined) return;
      const returnConst = stack[stack.length - 1 - depth]!.const;
      if (returnConst === undefined) return;
      const resumed = cloneStack(stack);
      for (let k = 0; k <= depth; k++) resumed.pop();
      const returnSlots = net + depth + 1;
      for (let k = 0; k < returnSlots; k++) {
        resumed.push({origin: freshOrigin(returnConst, k)}); // callee returns.
      }
      push({pc: returnConst, stack: resumed});
      return;
    }
    // Internal jump within the same function: pop the destination and continue.
    const nextStack = cloneStack(stack);
    nextStack.pop();
    push({pc: target, stack: nextStack});
  }

  private isCall(
    insn: Insn,
    fnId: number | undefined,
    target: number,
  ): boolean {
    if (insn.jump !== 'i') return false;
    const targetFn = this.insns.get(target)?.fnId;
    const sameFunction =
      fnId !== undefined && targetFn !== undefined && fnId === targetFn;
    return !sameFunction;
  }

  private returnTagDepth(
    stack: Stack,
    ownerFnId: number | undefined,
  ): number | undefined {
    for (let depth = 1; depth < stack.length; depth++) {
      const value = stack[stack.length - 1 - depth]!.const;
      if (value === undefined || !this.jumpdests.has(value)) continue;
      if (ownerFnId !== undefined && this.insns.get(value)?.fnId !== ownerFnId) {
        continue;
      }
      return depth;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Subroutine net-effect analysis (const-only; mirrors stackHeights)
  // -------------------------------------------------------------------------

  private netEffect(entryPc: number): number | undefined {
    const cached = this.netCache.get(entryPc);
    if (cached !== undefined || this.netCache.has(entryPc)) return cached;
    if (this.netInProgress.has(entryPc)) return undefined;
    this.netInProgress.add(entryPc);

    interface Item {
      pc: number;
      height: number;
      stack: Stack;
    }
    const localHeights = new Map<number, number>();
    const work: Item[] = [{pc: entryPc, height: 0, stack: baseStack(entryPc)}];
    let hret: number | undefined;

    while (work.length > 0) {
      const {pc, height, stack} = work.pop()!;
      const insn = this.insns.get(pc);
      if (insn === undefined) continue;
      if (localHeights.has(pc)) continue; // first visit wins (heights agree).
      localHeights.set(pc, height);

      if (isBlockTerminator(insn.op)) continue;

      if (insn.op === 0x56) {
        const target = topConst(stack);
        if (target === undefined || !this.jumpdests.has(target)) {
          if (hret === undefined) hret = height;
          continue;
        }
        if (this.isCall(insn, insn.fnId, target)) {
          const net = this.netEffect(target);
          if (net === undefined) continue;
          const depth = this.returnTagDepth(stack, insn.fnId);
          if (depth === undefined) continue;
          const returnConst = stack[stack.length - 1 - depth]!.const;
          if (returnConst === undefined) continue;
          const resumed = cloneStack(stack);
          for (let k = 0; k <= depth; k++) resumed.pop();
          for (let k = 0; k < net + depth + 1; k++) {
            resumed.push({origin: freshOrigin(returnConst, k)});
          }
          work.push({pc: returnConst, height: height + net, stack: resumed});
          continue;
        }
        const nextStack = cloneStack(stack);
        nextStack.pop();
        work.push({pc: target, height: height + insn.delta, stack: nextStack});
        continue;
      }

      if (insn.op === 0x57) {
        const target = topConst(stack);
        const branched = cloneStack(stack);
        branched.pop();
        branched.pop();
        const nextHeight = height + insn.delta;
        if (target !== undefined && this.jumpdests.has(target)) {
          work.push({pc: target, height: nextHeight, stack: cloneStack(branched)});
        }
        work.push({pc: pc + insn.size, height: nextHeight, stack: branched});
        continue;
      }

      const nextStack = cloneStack(stack);
      applyToStack(nextStack, insn);
      work.push({pc: pc + insn.size, height: height + insn.delta, stack: nextStack});
    }

    this.netInProgress.delete(entryPc);
    const net = hret === undefined ? undefined : hret - 2;
    this.netCache.set(entryPc, net);
    return net;
  }
}

/**
 * A fresh abstract stack seeded with the frame's below-entry (caller) slots, each
 * given a distinct per-function value number so a below-entry variable (an
 * internally-passed parameter) can be identified and tracked like any other.
 */
function baseStack(entryPc: number): Stack {
  const s: Stack = new Array<Slot>(64);
  // Distinct, negative, function-unique origins (128 spacing > 64 slots ⇒ no
  // overlap between functions; never collides with a pc-derived origin ≥ 0).
  const base = -(entryPc * 128) - 1;
  for (let i = 0; i < s.length; i++) s[i] = {origin: base - i};
  return s;
}

function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Build the static per-pc stack-provenance analyzer for one contract's runtime
 * code. See the module doc; the returned {@link StackProvenance} exposes
 * {@link StackProvenance.variableDepthAt}.
 */
export function stackProvenance(
  cu: CompilationUnit,
  sourcePath: string,
  contractName: string,
): StackProvenance {
  const contract = cu.contract(sourcePath, contractName);
  if (contract === undefined) {
    throw new Error(`contract not found: ${sourcePath}:${contractName}`);
  }
  const analyzer = new Analyzer(cu, contract);
  analyzer.analyze();
  return {
    variableDepthAt: (pc: number, declId: number) =>
      analyzer.variableDepthAt(pc, declId),
  };
}
