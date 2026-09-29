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
 * `Identifier` whose `referencedDeclaration` is a function param/local, the slot
 * at depth `n` holds that variable's value — for `DUPn` (a COPY read) provably
 * (solc emits exactly this to read a value-type stack variable, verified against
 * recorded traces at 100% of anchor pcs); for `SWAPn` (a MOVE read — a local's
 * LAST use, the common viaIR pattern for a local passed as a call's final
 * argument) usually, but SWAP attribution is coarse, so SWAP anchors are treated
 * as SUBORDINATE to DUP ones (see {@link Analyzer.recordRead}). We map that slot's
 * ORIGIN to the variable. The variable is then
 * reported at EVERY pc where a slot with that origin is live — before the read
 * (same value, e.g. a parameter from function entry) and after — because it is
 * the very value the read observed.
 *
 * ── Merges ───────────────────────────────────────────────────────────────────
 * At a pc reachable from multiple predecessors the incoming stacks are MERGED,
 * reaching a least fixpoint. A slot whose origin agrees on every path keeps it;
 * where paths disagree (e.g. a variable assigned in both branches of an if/else,
 * or a loop variable at the loop head) the slot gets a φ value number for that
 * join — it holds one runtime value from the join on, which a LATER read can
 * name. A φ never inherits a pre-join variable claim, so this stays sound. A pc reached at two conflicting heights (optimizer block-sharing,
 * inline assembly, …) is marked ambiguous and reports `undefined`, never a guess.
 *
 * PURE-STATIC: solc artifacts only, no trace. Never throws for a single pc query.
 */
import {
  buildInstructionIndex,
  closestFunction,
  closestStatement,
  findInnermostNode,
  type AstNode,
  type CompilationUnit,
  type Contract,
  type Jump,
  type SourceMapEntry,
} from '@simbolik/solc';
import {indirectCallReturns} from './stackHeights.js';

/** The public accessor returned by {@link stackProvenance}. */
export interface StackProvenance {
  /**
   * Depth-from-top of a stack slot holding the value of the variable with AST
   * declaration id `declId` on arrival at `pc`, or `undefined` if none is known
   * (variable unavailable / pc outside any analyzed body / ambiguous merge).
   */
  variableDepthAt(pc: number, declId: number): number | undefined;
  /**
   * The modelled abstract stack length on arrival at `pc` (`undefined` if not
   * analyzed or conflicted). Within one frame invocation, runtime stack length
   * minus this is constant wherever the model matches the executed path — a
   * consumer can detect a pc where it does not (and distrust its depths there).
   */
  stackLengthAt(pc: number): number | undefined;
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
   * A variable-READ anchor: a `DUPn`/`SWAPn` whose source-map node is an
   * `Identifier` referring to the param/local with `declId`; `depth` (= n) is the
   * depth-from-top of the slot it reads, which holds that variable's value. `kind`
   * is `'dup'` (a copy read — reliable) or `'swap'` (a last-use move — subordinate:
   * viaIR's coarse attribution can tag a stack-shuffle SWAP with an unrelated
   * variable's Identifier, so a SWAP anchor never overrides or invalidates a DUP
   * one; see {@link Analyzer.recordRead}).
   */
  anchor?: {declId: number; depth: number; kind: 'dup' | 'swap'; at?: number};
  /** For a `JUMP [in]`: the call's return-value count (for indirect calls). */
  callRets?: number;
  /** For a `JUMP [in]`: AST id of its innermost source node (the call). */
  callNode?: number;
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
 * Merge two incoming stacks of equal length at `pc`: a constant survives only
 * where both agree. An origin survives where both agree; where the paths bring
 * DIFFERENT values the slot gets a φ value number unique to `(pc, slot)` — the
 * slot still holds ONE runtime value from the join onward, so a later read can
 * name it (e.g. a local assigned in both branches of an if/else, or a loop
 * variable at the loop head). Stable across revisits ⇒ the fixpoint terminates.
 */
function mergeStack(a: Stack, b: Stack, pc: number): Stack {
  const out: Stack = new Array<Slot>(a.length);
  for (let i = 0; i < a.length; i++) {
    const sa = a[i]!;
    const sb = b[i]!;
    const slot: Slot = {};
    if (sa.const !== undefined && sa.const === sb.const) slot.const = sa.const;
    slot.origin =
      sa.origin !== undefined && sa.origin === sb.origin
        ? sa.origin
        : phiOrigin(pc, i);
    out[i] = slot;
  }
  return out;
}

/**
 * The φ value number of stack slot `index` (from the bottom) at join `pc`: a
 * range disjoint from pc-derived origins (≥ 0) and below-entry origins
 * (> −2^32 for any real contract size).
 */
function phiOrigin(pc: number, index: number): number {
  return -(2 ** 40) - (pc * 1024 + index);
}

/**
 * The value number of result `k` of an internal call resuming at `returnPc` — a
 * range of its own: a call can return more than 8 values, and `freshOrigin`'s
 * `pc * 8 + k` would then collide with the NEXT pc's origins (observed: a return
 * label pushed right after a call was tagged as the call's returned variable).
 */
function callReturnOrigin(returnPc: number, k: number): number {
  return -(2 ** 44) - (returnPc * 4096 + k);
}

/** The pc at which a value number was created (fresh, φ or call-return), if any. */
function originBirthPc(origin: number): number | undefined {
  if (origin >= 0) return Math.floor(origin / 8); // freshOrigin
  if (origin <= -(2 ** 44)) return Math.floor((-(2 ** 44) - origin) / 4096); // callReturnOrigin
  if (origin <= -(2 ** 40)) return Math.floor((-(2 ** 40) - origin) / 1024); // phiOrigin
  return undefined; // below-entry (caller) slot
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
  if (op === 0x16) {
    // AND of two known constants stays known: legacy masks internal-call targets
    // (`PUSH2 tag; …; PUSH4 0xffffffff; AND; JUMP [in]`), which must resolve or
    // the call is mistaken for a frame return and the rest of the body is lost.
    const a = s.pop()?.const;
    const b = s.pop()?.const;
    const known =
      a !== undefined && b !== undefined && Number.isSafeInteger(a) && Number.isSafeInteger(b);
    s.push({
      ...(known ? {const: Number(BigInt(a) & BigInt(b))} : {}),
      origin: freshOrigin(pc, 0),
    });
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
  /** Value number (origin) → the variable declId a DUP read proved it to hold. */
  private readonly originToDecl = new Map<number, number>();
  /**
   * Value number (origin) → declId claimed by a SUBORDINATE `SWAPn` last-use read,
   * for origins no `DUPn` anchor claims. SWAP attribution is coarse under viaIR (a
   * stack-shuffle SWAP can carry an unrelated Identifier), so these are consulted
   * only AFTER {@link originToDecl} and never mark a DUP-claimed origin ambiguous —
   * they add value-type locals whose ONLY read is a move (e.g. a local passed as a
   * call's final argument) without corrupting DUP-proved variables.
   */
  private readonly swapOriginToDecl = new Map<number, number>();
  /** Origins a read tied to two different variables (ambiguous ⇒ never reported). */
  private readonly originAmbiguous = new Set<number>();
  /** Origins a SWAP read tied to two different variables (dropped from SWAP map). */
  private readonly swapOriginAmbiguous = new Set<number>();
  /**
   * viaIR only: internal-call ENTRY pcs of a function → its parameters' entry
   * depths. The Yul code transform enters a function with
   * `…, returnLabel, paramN, …, param1` (param 1 on top), so at the call target
   * the slot at depth Σ(slots of params before i) provably holds param i. This is
   * the only anchor a single-use parameter gets under viaIR (it is consumed in
   * place, never DUP-read by an Identifier-tagged instruction).
   */
  private readonly paramEntryClaims = new Map<
    number,
    {declId: number; depth: number}[]
  >();
  /**
   * viaIR only: pc → local declared by the single-variable
   * `VariableDeclarationStatement` (with an initializer) whose code falls
   * through to that pc. On arrival the initializer's value — the new local — is
   * on top of the stack. The only anchor a single-use local gets under viaIR (it
   * is consumed where it sits). Recorded as a SUBORDINATE (swap-level) claim, so
   * any DUP read wins and conflicting claims cancel.
   */
  private readonly declEndClaims = new Map<number, number>();
  /** Per instruction: its enclosing statement's AST id (for declEndClaims). */
  private readonly stmtOf = new Map<number, number>();
  /** Distinct predecessor pcs seen per pc (a pc with ≥ 2 is a join). */
  private readonly preds = new Map<number, Set<number>>();
  private readonly netCache = new Map<number, number | undefined>();
  private readonly netInProgress = new Set<number>();

  private readonly writesCache = new Map<number, Set<number>>();

  /** Declarations a statement WRITES: an assignment's LHS identifiers, or the
   * variables a declaration statement declares. */
  private statementWrites(stmtId: number): Set<number> {
    let w = this.writesCache.get(stmtId);
    if (w !== undefined) return w;
    w = new Set<number>();
    const stmt = this.cu.nodeById(stmtId);
    if (stmt !== undefined) {
      if (stmt.nodeType === 'VariableDeclarationStatement') {
        for (const d of stmt.children()) {
          if (d.nodeType === 'VariableDeclaration') w.add(d.id);
        }
      }
      const visit = (n: AstNode): void => {
        if (n.nodeType === 'Assignment') {
          const kids = n.children();
          const rhs = kids.reduce((a, b) => (b.srcStart > a.srcStart ? b : a), kids[0]!);
          for (const k of kids) {
            if (k === rhs) continue;
            const lhs = (m: AstNode): void => {
              if (m.nodeType === 'Identifier' && m.referencedDeclaration !== undefined) {
                w!.add(m.referencedDeclaration);
              } else if (m.nodeType === 'TupleExpression') {
                for (const c of m.children()) lhs(c);
              }
            };
            lhs(k);
          }
        }
        for (const c of n.children()) {
          // Only the statement's OWN expressions, not nested statements (bodies).
          const t = c.nodeType;
          if (
            t === 'Block' ||
            t === 'UncheckedBlock' ||
            t.endsWith('Statement') ||
            t === 'Return' ||
            t === 'InlineAssembly'
          ) {
            continue;
          }
          visit(c);
        }
      };
      visit(stmt);
    }
    this.writesCache.set(stmtId, w);
    return w;
  }

  private readonly cu: CompilationUnit;

  constructor(cu: CompilationUnit, contract: Contract) {
    this.cu = cu;
    this.collectVarDeclIds(cu);
    this.disassemble(cu, contract);
    this.dropShuffleSwaps();
    if (cu.viaIR()) {
      this.collectParamEntryClaims(cu);
      this.collectDeclEndClaims(cu);
      this.collectInitCallDecls(cu);
    }
  }

  /**
   * viaIR: AST id of a declaration statement's initializer CALL → the variables
   * it declares, in order. At that call's return landing the top n slots are the
   * returned values, the LAST one on top (verified on uniswap `_accountDelta`:
   * `(previous, next) = currency.applyDelta(…)` ⇒ top = next, then previous) —
   * the only anchor for tuple-destructured locals used once.
   */
  private readonly initCallDecls = new Map<
    number,
    {slots: (number | null)[]; callee: number}
  >();

  private collectInitCallDecls(cu: CompilationUnit): void {
    for (const source of cu.sources()) {
      let root;
      try {
        root = source.ast();
      } catch {
        continue;
      }
      const visit = (n: AstNode): void => {
        if (n.nodeType === 'VariableDeclarationStatement') {
          const init = n.children().find((c) => c.nodeType === 'FunctionCall');
          // `assignments` lists the tuple components IN ORDER, `null` for a
          // skipped one (`(a, b, , ) = f()`) — every returned value occupies a
          // slot, so gaps must be counted (a gap-blind mapping shifted names by
          // one onto the skipped values: uniswap `(sqrtPriceX96, tick, , ) = getSlot0`).
          const slots = n.assignments();
          // The called function (`f(…)` / `x.f(…)`): only a jump INTO that very
          // function returns the initializer's values. Other internal jumps
          // attributed to the call node (the ABI encode/decode helpers of an
          // external call) return pointers, not the declared values.
          // The called expression is the child starting where the call starts
          // (children() follow the raw key order, where `arguments` come first).
          const callee = init
            ?.children()
            .find((c) => c.srcStart === init.srcStart)?.referencedDeclaration;
          if (
            init !== undefined &&
            callee !== undefined &&
            slots.length >= 1 &&
            slots.some((id) => id !== null) &&
            slots.every((id) => id === null || this.varDeclIds.has(id))
          ) {
            this.initCallDecls.set(init.id, {slots, callee});
          }
        }
        for (const c of n.children()) visit(c);
      };
      visit(root);
    }
  }

  /** See {@link declEndClaims}. */
  private collectDeclEndClaims(cu: CompilationUnit): void {
    // Last instruction (in code order) of each statement.
    const lastPc = new Map<number, number>();
    for (const [pc, stmtId] of this.stmtOf) {
      const prev = lastPc.get(stmtId);
      if (prev === undefined || pc > prev) lastPc.set(stmtId, pc);
    }
    for (const [stmtId, pc] of lastPc) {
      const stmt = cu.nodeById(stmtId);
      if (stmt === undefined || stmt.nodeType !== 'VariableDeclarationStatement') continue;
      const children = stmt.children();
      const decls = children.filter((c) => c.nodeType === 'VariableDeclaration');
      // Exactly one declared variable AND an initializer (a tuple destructuring
      // leaves several values; a bare declaration may be materialised lazily).
      if (decls.length !== 1 || children.length !== 2) continue;
      const declId = decls[0]!.id;
      if (!this.varDeclIds.has(declId)) continue;
      const insn = this.insns.get(pc)!;
      // Only a FALL-THROUGH end: a jump/terminator ends elsewhere.
      if (insn.op === 0x56 || insn.op === 0x57 || isBlockTerminator(insn.op)) continue;
      const next = pc + insn.size;
      const nextInsn = this.insns.get(next);
      if (nextInsn === undefined || nextInsn.fnId !== insn.fnId) continue;
      if (this.stmtOf.get(next) === stmtId) continue;
      this.declEndClaims.set(next, declId);
    }
  }

  /**
   * A SWAP anchor ADJACENT to a DUP anchor on the same identifier occurrence is a
   * stack shuffle around the real read (the DUP): e.g. viaIR reads `y` in
   * `y < 0` as `SWAP1; DUP2`, where the SWAP only brings an unrelated slot (a
   * return label) up. Its depth-n slot is not the variable — drop the anchor.
   */
  private dropShuffleSwaps(): void {
    // One identifier OCCURRENCE is one read; when a DUP anchor for it exists in
    // the same basic block (viaIR emits e.g. `SWAPn; PUSH2 <ret>; DUP(n+2)` for
    // `x.f()`), that DUP is the read and the SWAP only shuffles.
    const pcs = [...this.insns.keys()].sort((a, b) => a - b);
    const blockEnd = (op: number): boolean =>
      op === 0x56 || op === 0x57 || isBlockTerminator(op);
    for (let i = 0; i < pcs.length; i++) {
      const insn = this.insns.get(pcs[i]!)!;
      const a = insn.anchor;
      if (a === undefined || a.kind !== 'swap' || a.at === undefined) continue;
      const sameRead = (k: number): boolean => {
        const b = this.insns.get(pcs[k]!)?.anchor;
        return b !== undefined && b.kind === 'dup' && b.declId === a.declId && b.at === a.at;
      };
      let found = false;
      // forward to the end of the block
      for (let k = i + 1; k < pcs.length && !found; k++) {
        const op = this.insns.get(pcs[k]!)!.op;
        if (op === 0x5b) break; // JUMPDEST starts a new block
        if (sameRead(k)) found = true;
        if (blockEnd(op)) break;
      }
      // backward to the start of the block
      for (let k = i - 1; k >= 0 && !found; k--) {
        const op = this.insns.get(pcs[k]!)!.op;
        if (blockEnd(op)) break;
        if (sameRead(k)) found = true;
        if (op === 0x5b) break;
      }
      if (found) delete insn.anchor;
    }
  }

  /** See {@link paramEntryClaims}. */
  private collectParamEntryClaims(cu: CompilationUnit): void {
    // An internal call is `PUSH <target>; JUMP [in]` into ANOTHER function.
    let prev: Insn | undefined;
    for (const pc of [...this.insns.keys()].sort((a, b) => a - b)) {
      const insn = this.insns.get(pc)!;
      if (
        insn.op === 0x56 &&
        insn.jump === 'i' &&
        prev !== undefined &&
        prev.op >= 0x60 &&
        prev.op <= 0x7f
      ) {
        const target = prev.pushValue;
        const targetFn = this.insns.get(target)?.fnId;
        if (
          this.jumpdests.has(target) &&
          targetFn !== undefined &&
          targetFn !== insn.fnId &&
          !this.paramEntryClaims.has(target)
        ) {
          const claims = this.entryDepths(cu, targetFn);
          if (claims !== undefined) this.paramEntryClaims.set(target, claims);
        }
      }
      prev = insn;
    }
  }

  /** Entry depth of each single-slot parameter of function `fnId` (viaIR layout). */
  private entryDepths(
    cu: CompilationUnit,
    fnId: number,
  ): {declId: number; depth: number}[] | undefined {
    const fn = cu.nodeById(fnId);
    if (fn === undefined || fn.nodeType !== 'FunctionDefinition') return undefined;
    const claims: {declId: number; depth: number}[] = [];
    let depth = 0;
    for (const p of fn.parameters()) {
      const slots = stackSlotsOf(p.typeIdentifier);
      if (slots === 1 && this.varDeclIds.has(p.id)) claims.push({declId: p.id, depth});
      depth += slots;
    }
    return claims.length > 0 ? claims : undefined;
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
      if (entry !== undefined && entry.fileId >= 0 && cu.viaIR()) {
        const src = cu.sourceById(entry.fileId);
        const n = src && findInnermostNode(src.ast(), entry.start, entry.length);
        const stmt = n ? closestStatement(n) : undefined;
        if (stmt !== undefined) this.stmtOf.set(pc, stmt.id);
      }
      const anchor =
        entry && op >= 0x80 && op <= 0x9f // DUPn (0x80–0x8f) or SWAPn (0x90–0x9f)
          ? this.readAnchor(cu, entry, op)
          : undefined;
      const callRets =
        op === 0x56 && entry?.jump === 'i' ? indirectCallReturns(cu, entry) : undefined;
      let callNode: number | undefined;
      if (op === 0x56 && entry?.jump === 'i' && entry.fileId >= 0 && cu.viaIR()) {
        const src = cu.sourceById(entry.fileId);
        callNode = src && findInnermostNode(src.ast(), entry.start, entry.length)?.id;
      }
      this.insns.set(pc, {
        pc,
        op,
        size,
        pushValue,
        delta: stackDelta(op),
        jump: entry?.jump ?? '-',
        fnId,
        ...(anchor ? {anchor} : {}),
        ...(callRets !== undefined ? {callRets} : {}),
        ...(callNode !== undefined ? {callNode} : {}),
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
   * read anchor for a `DUPn` OR `SWAPn` (`op`): the slot at depth `n` holds that
   * variable in the INCOMING stack. For `DUPn` (`n = op − 0x80`) the value is
   * COPIED to the top (a non-consuming read); for `SWAPn` (`n = op − 0x8f`) it is
   * moved to the top to be consumed — solc emits this for a value-type local's
   * LAST use under viaIR, which the DUP-only anchor missed. Either way the slot at
   * depth `n` provably holds the variable at this pc, so anchoring its value number
   * is sound (the value number identifies the value throughout its life, so the
   * variable is then reported at every pc where that value is still live —
   * including BEFORE this read).
   */
  private readAnchor(
    cu: CompilationUnit,
    entry: SourceMapEntry,
    op: number,
  ): {declId: number; depth: number; kind: 'dup' | 'swap'; at?: number} | undefined {
    if (entry.fileId < 0) return undefined;
    const source = cu.sourceById(entry.fileId);
    if (source === undefined) return undefined;
    const node = findInnermostNode(source.ast(), entry.start, entry.length);
    if (node === undefined || node.nodeType !== 'Identifier') return undefined;
    const declId = node.referencedDeclaration;
    if (declId === undefined || !this.varDeclIds.has(declId)) return undefined;
    const isSwap = op >= 0x90;
    // An identifier on the LEFT of an assignment is a WRITE, not a read: under
    // viaIR `x = e` is a SWAPn moving e's value (the top) INTO x's position, so the
    // slot at depth n is x's OLD position (a stale value, or an unrelated slot such
    // as the return label when x is an unassigned return variable) — claiming it
    // named the wrong value. The value moved there IS x's new value: claim the top.
    const parent = node.parent();
    if (parent?.nodeType === 'TupleExpression') {
      const grand = parent.parent();
      if (grand?.nodeType === 'Assignment' && grand.srcStart === parent.srcStart) {
        return undefined; // tuple destructuring: which element is which is unknown
      }
    }
    if (parent?.nodeType === 'Assignment' && parent.srcStart === node.srcStart) {
      return isSwap ? {declId, depth: 0, kind: 'swap'} : undefined;
    }
    return {
      declId,
      depth: isSwap ? op - 0x8f : op - 0x80,
      kind: isSwap ? 'swap' : 'dup',
      at: node.srcStart,
    };
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

  stackLengthAt(pc: number): number | undefined {
    if (this.conflicted.has(pc)) return undefined;
    return this.recorded.get(pc)?.length;
  }

  variableDepthAt(pc: number, declId: number): number | undefined {
    if (this.conflicted.has(pc)) return undefined;
    const stack = this.recorded.get(pc);
    if (stack === undefined) return undefined;
    // viaIR: inside a statement that ASSIGNS the variable, a value computed by
    // that statement is not the variable's value until the write executes (a
    // stop at `x = c ? a : b`'s join sees the new value on top already). Skip
    // origins born inside the current statement when it writes this variable.
    const stmt = this.stmtOf.get(pc);
    const writesHere = stmt !== undefined && this.statementWrites(stmt).has(declId);
    const bornHere = (origin: number): boolean => {
      if (!writesHere) return false;
      const birth = originBirthPc(origin);
      return birth !== undefined && this.stmtOf.get(birth) === stmt;
    };
    // Shallowest slot (closest to top) whose value was proved to be this
    // variable. A DUP-proved (authoritative) slot ALWAYS wins over a SWAP-claimed
    // one anywhere on the stack: a variable has one current value, and when the
    // Yul scheduler has already DUP'd it to the top, an Identifier-tagged SWAP that
    // merely moves it down would otherwise claim the UNRELATED slot it swapped
    // with (observed on real viaIR code: `absTick`, `zeroForOne`, `target`).
    for (let depth = 0; depth < stack.length; depth++) {
      const origin = stack[stack.length - 1 - depth]!.origin;
      if (origin === undefined || this.originAmbiguous.has(origin)) continue;
      if (this.originToDecl.get(origin) === declId && !bornHere(origin)) return depth;
    }
    for (let depth = 0; depth < stack.length; depth++) {
      const origin = stack[stack.length - 1 - depth]!.origin;
      if (origin === undefined || this.originAmbiguous.has(origin)) continue;
      if (
        !this.originToDecl.has(origin) &&
        this.swapOriginToDecl.get(origin) === declId &&
        !bornHere(origin)
      ) {
        return depth;
      }
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
      /** The predecessor pc this state flows from (−1 for the entry). */
      from: number;
    }
    const work: Item[] = [{pc: entryPc, stack: baseStack(entryPc), from: -1}];
    // Defensive iteration cap (the monotone-descending lattice terminates well
    // before this; guards against pathological optimizer output).
    let budget = 2000000;

    while (work.length > 0 && budget-- > 0) {
      const {pc, stack: incoming, from} = work.pop()!;
      const insn = this.insns.get(pc);
      if (insn === undefined) continue; // into push data / past end.
      if (this.conflicted.has(pc)) continue;
      let preds = this.preds.get(pc);
      if (preds === undefined) {
        preds = new Set();
        this.preds.set(pc, preds);
      }
      preds.add(from);

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
      } else if (preds.size <= 1) {
        // A single-predecessor pc is NOT a join: its state is exactly its
        // predecessor's (refined on a revisit), so take it over. Merging here
        // would mint a fresh φ at every instruction downstream of a revisited
        // join, changing a value's identity per instruction and confining a read's
        // claim to the read's own pc.
        if (stacksEqual(incoming, prev)) continue;
        cur = cloneStack(incoming);
        this.recorded.set(pc, cur);
      } else {
        const merged = mergeStack(prev, incoming, pc);
        if (stacksEqual(merged, prev)) continue; // fixpoint for this pc.
        cur = merged;
        this.recorded.set(pc, cur);
      }

      // viaIR function entry: the parameter slots are proved by the calling
      // convention — authoritative, like a DUP read.
      const entryClaims = this.paramEntryClaims.get(pc);
      if (entryClaims !== undefined) {
        for (const {declId, depth} of entryClaims) {
          const origin = cur[cur.length - 1 - depth]?.origin;
          if (origin !== undefined) this.recordRead(origin, declId, 'dup');
        }
      }

      const declared = this.declEndClaims.get(pc);
      if (declared !== undefined) {
        const origin = cur[cur.length - 1]?.origin;
        if (origin !== undefined) this.recordRead(origin, declared, 'swap');
      }

      // Read anchor: the duplicated slot's VALUE is proved to be `declId` — record
      // that value number so the variable is reported wherever this value lives.
      if (insn.anchor !== undefined) {
        const {declId, depth, kind} = insn.anchor;
        const idx = cur.length - 1 - depth;
        const origin = idx >= 0 ? cur[idx]!.origin : undefined;
        // A SWAP read is only believable when the variable's value is not ALREADY
        // known to sit elsewhere on this stack (then the SWAP just moves it).
        const liveElsewhere =
          kind === 'swap' &&
          cur.some(
            (slot, k) =>
              k !== idx &&
              slot.origin !== undefined &&
              this.originToDecl.get(slot.origin) === declId,
          );
        if (origin !== undefined && !liveElsewhere) {
          this.recordRead(origin, declId, kind);
        }
      }

      if (isBlockTerminator(insn.op)) continue;

      if (insn.op === 0x56) {
        this.handleJump(cur, insn, fnId, (next) => work.push({...next, from: pc}));
        continue;
      }

      if (insn.op === 0x57) {
        // JUMPI: pop dest + cond; propagate to target and fall-through.
        const target = topConst(cur);
        const branched = cloneStack(cur);
        branched.pop(); // dest
        branched.pop(); // cond
        if (target !== undefined && this.jumpdests.has(target)) {
          work.push({pc: target, stack: cloneStack(branched), from: pc});
        }
        work.push({pc: pc + insn.size, stack: branched, from: pc});
        continue;
      }

      const nextStack = cloneStack(cur);
      applyToStack(nextStack, insn);
      work.push({pc: pc + insn.size, stack: nextStack, from: pc});
    }
  }

  /**
   * Tie a value number to the variable a read proved it to hold, guarding
   * conflicts. `DUPn` reads (`kind: 'dup'`) are AUTHORITATIVE: they populate
   * {@link originToDecl} and, on setting an origin, drop any subordinate SWAP claim
   * for it. `SWAPn` reads (`kind: 'swap'`) are SUBORDINATE: they fill only origins
   * no DUP has claimed (a DUP-claimed origin's mismatched SWAP is ignored, NOT
   * marked ambiguous — viaIR mis-attributes stack-shuffle SWAPs), and two SWAP
   * reads disagreeing on one origin drop it from the SWAP map.
   */
  private recordRead(origin: number, declId: number, kind: 'dup' | 'swap'): void {
    if (kind === 'dup') {
      // A DUP claim overrides any tentative SWAP claim for this origin.
      this.swapOriginToDecl.delete(origin);
      if (this.originAmbiguous.has(origin)) return;
      const prev = this.originToDecl.get(origin);
      if (prev === undefined) {
        this.originToDecl.set(origin, declId);
      } else if (prev !== declId) {
        this.originAmbiguous.add(origin); // read as two variables — unsound.
      }
      return;
    }
    // SWAP: subordinate. Defer entirely to an existing DUP claim.
    if (this.originToDecl.has(origin) || this.swapOriginAmbiguous.has(origin)) {
      return;
    }
    const prev = this.swapOriginToDecl.get(origin);
    if (prev === undefined) {
      this.swapOriginToDecl.set(origin, declId);
    } else if (prev !== declId) {
      this.swapOriginToDecl.delete(origin);
      this.swapOriginAmbiguous.add(origin);
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
      // Dynamic target = return address ⇒ frame return — unless an INDIRECT
      // CALL (`[in]` through a function pointer): resume at its return tag.
      const resume = this.indirectResume(stack, insn, fnId);
      if (resume !== undefined) push({pc: resume.pc, stack: resume.stack});
      return;
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
        resumed.push({origin: callReturnOrigin(returnConst, k)}); // callee returns.
      }
      // A declaration's initializer call: its returned values ARE the declared
      // variables (last one on top).
      const init = insn.callNode === undefined ? undefined : this.initCallDecls.get(insn.callNode);
      const decls =
        init !== undefined && this.insns.get(target)?.fnId === init.callee ? init.slots : undefined;
      // Exactly one returned value per component; otherwise the mapping is unsure.
      if (decls !== undefined && decls.length === returnSlots) {
        decls.forEach((declId, k) => {
          if (declId === null) return;
          const origin = resumed[resumed.length - decls.length + k]?.origin;
          if (origin !== undefined) this.recordRead(origin, declId, 'swap');
        });
      }
      push({pc: returnConst, stack: resumed});
      return;
    }
    // Internal jump within the same function: pop the destination and continue.
    const nextStack = cloneStack(stack);
    nextStack.pop();
    push({pc: target, stack: nextStack});
  }

  /**
   * An indirect internal call (`JUMP [in]` to a function-pointer target): resume
   * at the return tag with `callRets` freshly-numbered return values.
   */
  private indirectResume(
    stack: Stack,
    insn: Insn,
    fnId: number | undefined,
  ): {pc: number; stack: Stack; net: number} | undefined {
    if (insn.jump !== 'i' || insn.callRets === undefined) return undefined;
    const depth = this.returnTagDepth(stack, fnId);
    if (depth === undefined) return undefined;
    const returnConst = stack[stack.length - 1 - depth]!.const;
    if (returnConst === undefined) return undefined;
    const resumed = cloneStack(stack);
    for (let k = 0; k <= depth; k++) resumed.pop();
    for (let k = 0; k < insn.callRets; k++) {
      resumed.push({origin: callReturnOrigin(returnConst, k)});
    }
    return {pc: returnConst, stack: resumed, net: insn.callRets - depth - 1};
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
    let hretOut: number | undefined;

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
          // A dynamic jump is the RETURN only if it is not a call (`[in]`, e.g. a
          // call through a function pointer whose target we can't resolve). An
          // `[out]` jump is authoritative; an untagged one is a weaker candidate.
          if (insn.jump === 'o') {
            if (hretOut === undefined) hretOut = height;
          } else if (insn.jump !== 'i' && hret === undefined) {
            hret = height;
          } else if (insn.jump === 'i') {
            const resume = this.indirectResume(stack, insn, insn.fnId);
            if (resume !== undefined) {
              work.push({pc: resume.pc, height: height + resume.net, stack: resume.stack});
            }
          }
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
            resumed.push({origin: callReturnOrigin(returnConst, k)});
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
    const ret = hretOut ?? hret;
    const net = ret === undefined ? undefined : ret - 2;
    this.netCache.set(entryPc, net);
    return net;
  }
}

/**
 * Stack slots a parameter of solc type `typeIdentifier` occupies: two for a
 * calldata dynamic array/bytes/string (offset + length) and an external function
 * pointer (address + selector), one otherwise.
 */
function stackSlotsOf(typeIdentifier: string | undefined): number {
  if (typeIdentifier === undefined) return 1;
  if (/_calldata_ptr$/.test(typeIdentifier) && /^t_(bytes|string)_|_dyn_calldata_ptr$/.test(typeIdentifier)) {
    return 2;
  }
  if (/^t_function_external/.test(typeIdentifier)) return 2;
  return 1;
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
    stackLengthAt: (pc: number) => analyzer.stackLengthAt(pc),
  };
}
