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
 * A per-function CFG worklist (sharing {@link StackFlow} with
 * {@link stackHeights}) propagates an abstract stack whose every slot carries an
 * optional known PUSH CONSTANT (to resolve JUMP targets, exactly as the height
 * analyzer does) and a deterministic ORIGIN id — a value number identifying WHICH
 * runtime value occupies the slot:
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
 * name. A φ never inherits a pre-join variable claim, so this stays sound. A pc
 * reached at two conflicting heights (optimizer block-sharing, inline assembly,
 * …) is marked ambiguous and reports `undefined`, never a guess.
 *
 * PURE-STATIC: solc artifacts only, no trace. Never throws for a single pc query.
 */
import {
  closestFunction,
  closestStatement,
  type AstNode,
  type CompilationUnit,
  type Contract,
} from '@simbolik/solc';

import {walkAllSources} from './ast.js';
import {
  Program,
  StackFlow,
  type Insn,
  type OnCallResume,
  type StackDomain,
} from './cfg.js';
import {
  AND,
  JUMP,
  JUMPDEST,
  PUSH0,
  endsBlock,
  isDup,
  isPushN,
  isSwap,
  stackDelta,
  stackInOut,
} from './opcodes.js';

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
// Value-numbered abstract stack
// ---------------------------------------------------------------------------

/** One abstract stack slot: an optional known constant + a value-number origin. */
interface Slot {
  /** Known PUSH constant value (for JUMP-target resolution), else `undefined`. */
  const?: number;
  /** Value number: which runtime value occupies this slot, else `undefined`. */
  origin?: number;
}

type Stack = Slot[];

function cloneStack(s: Stack): Stack {
  return s.map(slot => ({...slot}));
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

// Value-number ranges, pairwise disjoint:
//   freshOrigin       ≥ 0
//   below-entry       (−2^32, 0)   (see baseStack; for any real contract size)
//   phiOrigin         (−2^44, −2^40]
//   callReturnOrigin  ≤ −2^44
const PHI_BASE = -(2 ** 40);
const CALL_RETURN_BASE = -(2 ** 44);

/** A freshly value-numbered result of the instruction at `pc` (output index `k`). */
function freshOrigin(pc: number, k: number): number {
  return pc * 8 + k; // pc-derived ⇒ stable across worklist revisits; k < 8.
}

/** The φ value number of stack slot `index` (from the bottom) at join `pc`. */
function phiOrigin(pc: number, index: number): number {
  return PHI_BASE - (pc * 1024 + index);
}

/**
 * The value number of result `k` of an internal call resuming at `returnPc` — a
 * range of its own: a call can return more than 8 values, and `freshOrigin`'s
 * `pc * 8 + k` would then collide with the NEXT pc's origins (observed: a return
 * label pushed right after a call was tagged as the call's returned variable).
 */
function callReturnOrigin(returnPc: number, k: number): number {
  return CALL_RETURN_BASE - (returnPc * 4096 + k);
}

/** The pc at which a value number was created (fresh, φ or call-return), if any. */
function originBirthPc(origin: number): number | undefined {
  if (origin >= 0) return Math.floor(origin / 8);
  if (origin <= CALL_RETURN_BASE) {
    return Math.floor((CALL_RETURN_BASE - origin) / 4096);
  }
  if (origin <= PHI_BASE) return Math.floor((PHI_BASE - origin) / 1024);
  return undefined; // below-entry (caller) slot
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

/**
 * Apply a straight-line (non-JUMP/JUMPI) opcode to the stack, tracking PUSH/DUP/
 * SWAP constants+origins exactly and modelling every other opcode as popping its
 * inputs and pushing freshly value-numbered results.
 */
function applyToStack(s: Stack, insn: Insn): void {
  const {op, pc} = insn;
  if (op === PUSH0) {
    s.push({const: 0, origin: freshOrigin(pc, 0)});
    return;
  }
  if (isPushN(op)) {
    s.push({const: insn.pushValue, origin: freshOrigin(pc, 0)});
    return;
  }
  if (isDup(op)) {
    // DUPn duplicates the slot at depth n (DUP1 → the top): copy const AND origin.
    const n = op - 0x80;
    const src = s[s.length - 1 - n];
    s.push(src ? {...src} : {origin: freshOrigin(pc, 0)});
    return;
  }
  if (isSwap(op)) {
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
  if (op === AND) {
    // AND of two known constants stays known: legacy masks internal-call targets
    // (`PUSH2 tag; …; PUSH4 0xffffffff; AND; JUMP [in]`), which must resolve or
    // the call is mistaken for a frame return and the rest of the body is lost.
    const a = s.pop()?.const;
    const b = s.pop()?.const;
    const known =
      a !== undefined &&
      b !== undefined &&
      Number.isSafeInteger(a) &&
      Number.isSafeInteger(b);
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

const provenanceDomain: StackDomain<Stack> = {
  base: baseStack,
  clone: cloneStack,
  length: s => s.length,
  constAt: (s, depth) => s[s.length - 1 - depth]?.const,
  pop: (s, n) => {
    for (let k = 0; k < n; k++) s.pop();
  },
  pushCallResults: (s, returnPc, count) => {
    for (let k = 0; k < count; k++) {
      s.push({origin: callReturnOrigin(returnPc, k)});
    }
  },
  apply: applyToStack,
};

// ---------------------------------------------------------------------------
// The analyzer
// ---------------------------------------------------------------------------

/**
 * A variable-READ anchor: a `DUPn`/`SWAPn` whose source-map node is an
 * `Identifier` referring to the param/local with `declId`; `depth` (= n) is the
 * depth-from-top of the slot it reads, which holds that variable's value. `kind`
 * is `'dup'` (a copy read — reliable) or `'swap'` (a last-use move — subordinate:
 * viaIR's coarse attribution can tag a stack-shuffle SWAP with an unrelated
 * variable's Identifier, so a SWAP anchor never overrides or invalidates a DUP
 * one; see {@link Analyzer.recordRead}). `at` is the identifier occurrence's
 * source offset.
 */
interface ReadAnchor {
  declId: number;
  depth: number;
  kind: ReadKind;
  at?: number;
}

type ReadKind = 'dup' | 'swap';

class Analyzer {
  private readonly cu: CompilationUnit;
  private readonly program: Program;
  private readonly flow: StackFlow<Stack>;
  /** Per-pc recorded arrival stack (least fixpoint). */
  private readonly recorded = new Map<number, Stack>();
  private readonly conflicted = new Set<number>();
  /** Distinct predecessor pcs seen per pc (a pc with ≥ 2 is a join). */
  private readonly preds = new Map<number, Set<number>>();
  /** AST ids of function params/locals (the taggable stack variables). */
  private readonly varDeclIds = new Set<number>();
  /** Per DUPn/SWAPn pc: the variable read it performs (see {@link ReadAnchor}). */
  private readonly anchors = new Map<number, ReadAnchor>();
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

  // viaIR-only anchors (empty on legacy code).

  /**
   * Internal-call ENTRY pcs of a function → its parameters' entry depths. The
   * Yul code transform enters a function with `…, returnLabel, paramN, …,
   * param1` (param 1 on top), so at the call target the slot at depth
   * Σ(slots of params before i) provably holds param i. This is the only anchor a
   * single-use parameter gets under viaIR (it is consumed in place, never
   * DUP-read by an Identifier-tagged instruction).
   */
  private readonly paramEntryClaims = new Map<
    number,
    {declId: number; depth: number}[]
  >();
  /**
   * pc → local declared by the single-variable `VariableDeclarationStatement`
   * (with an initializer) whose code falls through to that pc. On arrival the
   * initializer's value — the new local — is on top of the stack. The only anchor
   * a single-use local gets under viaIR (it is consumed where it sits). Recorded
   * as a SUBORDINATE (swap-level) claim, so any DUP read wins and conflicting
   * claims cancel.
   */
  private readonly declEndClaims = new Map<number, number>();
  /**
   * AST id of a declaration statement's initializer CALL → the variables it
   * declares, in order. At that call's return landing the top n slots are the
   * returned values, the LAST one on top (verified on uniswap `_accountDelta`:
   * `(previous, next) = currency.applyDelta(…)` ⇒ top = next, then previous) —
   * the only anchor for tuple-destructured locals used once.
   */
  private readonly initCallDecls = new Map<
    number,
    {slots: (number | null)[]; callee: number}
  >();
  /** Per instruction: its enclosing statement's AST id. */
  private readonly stmtOf = new Map<number, number>();
  /** Statement id → the declarations it writes (see {@link statementWrites}). */
  private readonly writesCache = new Map<number, Set<number>>();

  constructor(cu: CompilationUnit, contract: Contract) {
    this.cu = cu;
    this.collectVarDeclIds();
    this.program = new Program(cu, contract, stackDelta);
    this.flow = new StackFlow(this.program, provenanceDomain);
    this.collectAnchors();
    this.dropShuffleSwaps();
    if (cu.viaIR()) {
      this.collectParamEntryClaims();
      this.collectDeclEndClaims();
      this.collectInitCallDecls();
    }
    for (const entryPc of this.program.entryByFn.values()) {
      this.propagateFunction(entryPc);
    }
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

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
    const writesHere =
      stmt !== undefined && this.statementWrites(stmt).has(declId);
    const bornHere = (origin: number): boolean => {
      if (!writesHere) return false;
      const birth = originBirthPc(origin);
      return birth !== undefined && this.stmtOf.get(birth) === stmt;
    };
    const shallowest = (holds: (origin: number) => boolean) => {
      for (let depth = 0; depth < stack.length; depth++) {
        const origin = stack[stack.length - 1 - depth]!.origin;
        if (origin === undefined || this.originAmbiguous.has(origin)) continue;
        if (holds(origin) && !bornHere(origin)) return depth;
      }
      return undefined;
    };
    // Shallowest slot (closest to top) whose value was proved to be this
    // variable. A DUP-proved (authoritative) slot ALWAYS wins over a SWAP-claimed
    // one anywhere on the stack: a variable has one current value, and when the
    // Yul scheduler has already DUP'd it to the top, an Identifier-tagged SWAP that
    // merely moves it down would otherwise claim the UNRELATED slot it swapped
    // with (observed on real viaIR code: `absTick`, `zeroForOne`, `target`).
    return (
      shallowest(o => this.originToDecl.get(o) === declId) ??
      shallowest(
        o =>
          !this.originToDecl.has(o) && this.swapOriginToDecl.get(o) === declId
      )
    );
  }

  // -------------------------------------------------------------------------
  // Static anchor collection
  // -------------------------------------------------------------------------

  /** All function param/local `VariableDeclaration` ids across the unit. */
  private collectVarDeclIds(): void {
    walkAllSources(this.cu, node => {
      if (
        node.nodeType === 'VariableDeclaration' &&
        node.id >= 0 &&
        // A param/local sits inside a FunctionDefinition; a state variable does
        // not (it is a direct child of the ContractDefinition).
        closestFunction(node) !== undefined
      ) {
        this.varDeclIds.add(node.id);
      }
    });
  }

  /** Detect every instruction's read anchor (and, under viaIR, its statement). */
  private collectAnchors(): void {
    const viaIR = this.cu.viaIR();
    for (const insn of this.program.insns.values()) {
      if (insn.node === undefined) continue;
      if (viaIR) {
        const stmt = closestStatement(insn.node);
        if (stmt !== undefined) this.stmtOf.set(insn.pc, stmt.id);
      }
      if (isDup(insn.op) || isSwap(insn.op)) {
        const anchor = this.readAnchor(insn.node, insn.op);
        if (anchor !== undefined) this.anchors.set(insn.pc, anchor);
      }
    }
  }

  /**
   * If `node` is an `Identifier` reading a known param/local, a read anchor for a
   * `DUPn` OR `SWAPn` (`op`): the slot at depth `n` holds that variable in the
   * INCOMING stack. For `DUPn` (`n = op − 0x80`) the value is COPIED to the top (a
   * non-consuming read); for `SWAPn` (`n = op − 0x8f`) it is moved to the top to
   * be consumed — solc emits this for a value-type local's LAST use under viaIR,
   * which the DUP-only anchor missed. Either way the slot at depth `n` provably
   * holds the variable at this pc, so anchoring its value number is sound (the
   * value number identifies the value throughout its life, so the variable is
   * then reported at every pc where that value is still live — including BEFORE
   * this read).
   */
  private readAnchor(node: AstNode, op: number): ReadAnchor | undefined {
    if (node.nodeType !== 'Identifier') return undefined;
    const declId = node.referencedDeclaration;
    if (declId === undefined || !this.varDeclIds.has(declId)) return undefined;
    const swap = isSwap(op);
    // An identifier on the LEFT of an assignment is a WRITE, not a read: under
    // viaIR `x = e` is a SWAPn moving e's value (the top) INTO x's position, so the
    // slot at depth n is x's OLD position (a stale value, or an unrelated slot such
    // as the return label when x is an unassigned return variable) — claiming it
    // named the wrong value. The value moved there IS x's new value: claim the top.
    const parent = node.parent();
    if (parent?.nodeType === 'TupleExpression') {
      const grand = parent.parent();
      if (
        grand?.nodeType === 'Assignment' &&
        grand.srcStart === parent.srcStart
      ) {
        return undefined; // tuple destructuring: which element is which is unknown
      }
    }
    if (
      parent?.nodeType === 'Assignment' &&
      parent.srcStart === node.srcStart
    ) {
      return swap ? {declId, depth: 0, kind: 'swap'} : undefined;
    }
    return {
      declId,
      depth: swap ? op - 0x8f : op - 0x80,
      kind: swap ? 'swap' : 'dup',
      at: node.srcStart,
    };
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
    const {pcs, insns} = this.program;
    const opAt = (k: number): number => insns.get(pcs[k]!)!.op;
    for (let i = 0; i < pcs.length; i++) {
      const a = this.anchors.get(pcs[i]!);
      if (a === undefined || a.kind !== 'swap' || a.at === undefined) continue;
      const sameRead = (k: number): boolean => {
        const b = this.anchors.get(pcs[k]!);
        return (
          b !== undefined &&
          b.kind === 'dup' &&
          b.declId === a.declId &&
          b.at === a.at
        );
      };
      let found = false;
      // forward to the end of the block
      for (let k = i + 1; k < pcs.length && !found; k++) {
        const op = opAt(k);
        if (op === JUMPDEST) break; // JUMPDEST starts a new block
        if (sameRead(k)) found = true;
        if (endsBlock(op)) break;
      }
      // backward to the start of the block
      for (let k = i - 1; k >= 0 && !found; k--) {
        const op = opAt(k);
        if (endsBlock(op)) break;
        if (sameRead(k)) found = true;
        if (op === JUMPDEST) break;
      }
      if (found) this.anchors.delete(pcs[i]!);
    }
  }

  /** See {@link paramEntryClaims}. */
  private collectParamEntryClaims(): void {
    // An internal call is `PUSH <target>; JUMP [in]` into ANOTHER function.
    let prev: Insn | undefined;
    for (const pc of this.program.pcs) {
      const insn = this.program.insns.get(pc)!;
      if (
        insn.op === JUMP &&
        insn.jump === 'i' &&
        prev !== undefined &&
        isPushN(prev.op)
      ) {
        const target = prev.pushValue;
        const targetFn = this.program.insns.get(target)?.fnId;
        if (
          this.program.jumpdests.has(target) &&
          targetFn !== undefined &&
          targetFn !== insn.fnId &&
          !this.paramEntryClaims.has(target)
        ) {
          const claims = this.entryDepths(targetFn);
          if (claims !== undefined) this.paramEntryClaims.set(target, claims);
        }
      }
      prev = insn;
    }
  }

  /** Entry depth of each single-slot parameter of function `fnId` (viaIR layout). */
  private entryDepths(
    fnId: number
  ): {declId: number; depth: number}[] | undefined {
    const fn = this.cu.nodeById(fnId);
    if (fn === undefined || fn.nodeType !== 'FunctionDefinition') {
      return undefined;
    }
    const claims: {declId: number; depth: number}[] = [];
    let depth = 0;
    for (const p of fn.parameters()) {
      const slots = stackSlotsOf(p.typeIdentifier);
      if (slots === 1 && this.varDeclIds.has(p.id)) {
        claims.push({declId: p.id, depth});
      }
      depth += slots;
    }
    return claims.length > 0 ? claims : undefined;
  }

  /** See {@link declEndClaims}. */
  private collectDeclEndClaims(): void {
    // Last instruction (in code order) of each statement.
    const lastPc = new Map<number, number>();
    for (const [pc, stmtId] of this.stmtOf) {
      const prev = lastPc.get(stmtId);
      if (prev === undefined || pc > prev) lastPc.set(stmtId, pc);
    }
    for (const [stmtId, pc] of lastPc) {
      const stmt = this.cu.nodeById(stmtId);
      if (stmt?.nodeType !== 'VariableDeclarationStatement') continue;
      const children = stmt.children();
      const decls = children.filter(c => c.nodeType === 'VariableDeclaration');
      // Exactly one declared variable AND an initializer (a tuple destructuring
      // leaves several values; a bare declaration may be materialised lazily).
      if (decls.length !== 1 || children.length !== 2) continue;
      const declId = decls[0]!.id;
      if (!this.varDeclIds.has(declId)) continue;
      const insn = this.program.insns.get(pc)!;
      // Only a FALL-THROUGH end: a jump/terminator ends elsewhere.
      if (endsBlock(insn.op)) continue;
      const next = pc + insn.size;
      const nextInsn = this.program.insns.get(next);
      if (nextInsn === undefined || nextInsn.fnId !== insn.fnId) continue;
      if (this.stmtOf.get(next) === stmtId) continue;
      this.declEndClaims.set(next, declId);
    }
  }

  /** See {@link initCallDecls}. */
  private collectInitCallDecls(): void {
    walkAllSources(this.cu, n => {
      if (n.nodeType !== 'VariableDeclarationStatement') return;
      const init = n.children().find(c => c.nodeType === 'FunctionCall');
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
        .find(c => c.srcStart === init.srcStart)?.referencedDeclaration;
      if (
        init !== undefined &&
        callee !== undefined &&
        slots.length >= 1 &&
        slots.some(id => id !== null) &&
        slots.every(id => id === null || this.varDeclIds.has(id))
      ) {
        this.initCallDecls.set(init.id, {slots, callee});
      }
    });
  }

  /**
   * Declarations a statement WRITES: an assignment's LHS identifiers, or the
   * variables a declaration statement declares.
   */
  private statementWrites(stmtId: number): Set<number> {
    let w = this.writesCache.get(stmtId);
    if (w !== undefined) return w;
    const writes = new Set<number>();
    const stmt = this.cu.nodeById(stmtId);
    if (stmt !== undefined) {
      if (stmt.nodeType === 'VariableDeclarationStatement') {
        for (const d of stmt.children()) {
          if (d.nodeType === 'VariableDeclaration') writes.add(d.id);
        }
      }
      const lhs = (m: AstNode): void => {
        if (
          m.nodeType === 'Identifier' &&
          m.referencedDeclaration !== undefined
        ) {
          writes.add(m.referencedDeclaration);
        } else if (m.nodeType === 'TupleExpression') {
          for (const c of m.children()) lhs(c);
        }
      };
      const visit = (n: AstNode): void => {
        if (n.nodeType === 'Assignment') {
          const kids = n.children();
          const rhs = kids.reduce(
            (a, b) => (b.srcStart > a.srcStart ? b : a),
            kids[0]!
          );
          for (const k of kids) if (k !== rhs) lhs(k);
        }
        for (const c of n.children()) {
          // Only the statement's OWN expressions, not nested statements (bodies).
          if (!isNestedBody(c.nodeType)) visit(c);
        }
      };
      visit(stmt);
    }
    w = writes;
    this.writesCache.set(stmtId, w);
    return w;
  }

  // -------------------------------------------------------------------------
  // Intra-function CFG worklist (least-fixpoint with origin intersection)
  // -------------------------------------------------------------------------

  private propagateFunction(entryPc: number): void {
    const fnId = this.program.insns.get(entryPc)?.fnId;
    /** `from`: the predecessor pc this state flows from (−1 for the entry). */
    const work: {pc: number; stack: Stack; from: number}[] = [
      {pc: entryPc, stack: baseStack(entryPc), from: -1},
    ];
    // Defensive iteration cap (the monotone-descending lattice terminates well
    // before this; guards against pathological optimizer output).
    let budget = 2000000;

    while (work.length > 0 && budget-- > 0) {
      const {pc, stack: incoming, from} = work.pop()!;
      const insn = this.program.insns.get(pc);
      if (insn === undefined) continue; // into push data / past end.
      if (this.conflicted.has(pc)) continue;
      const cur = this.arrive(pc, incoming, from);
      if (cur === undefined) continue; // conflicted, or no new information.

      this.recordClaimsAt(insn, cur);

      for (const next of this.flow.successors(
        insn,
        cur,
        fnId,
        this.claimInitializerResults
      )) {
        work.push({pc: next.pc, stack: next.stack, from: pc});
      }
    }
  }

  /**
   * Fold an `incoming` stack (from predecessor `from`) into `pc`'s recorded
   * arrival state. Returns the new state to propagate, or `undefined` when the
   * state did not change (fixpoint) or the pc became conflicted.
   */
  private arrive(pc: number, incoming: Stack, from: number): Stack | undefined {
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
    } else if (prev.length !== incoming.length) {
      // Two conflicting heights reach this pc — the frame-relative model can't
      // assign a single depth; report unknown rather than guess.
      this.conflicted.add(pc);
      return undefined;
    } else if (preds.size <= 1) {
      // A single-predecessor pc is NOT a join: its state is exactly its
      // predecessor's (refined on a revisit), so take it over. Merging here
      // would mint a fresh φ at every instruction downstream of a revisited
      // join, changing a value's identity per instruction and confining a read's
      // claim to the read's own pc.
      if (stacksEqual(incoming, prev)) return undefined;
      cur = cloneStack(incoming);
    } else {
      const merged = mergeStack(prev, incoming, pc);
      if (stacksEqual(merged, prev)) return undefined; // fixpoint for this pc.
      cur = merged;
    }
    this.recorded.set(pc, cur);
    return cur;
  }

  /** Record the variable claims the instruction at `insn.pc` proves on `cur`. */
  private recordClaimsAt(insn: Insn, cur: Stack): void {
    const originAt = (depth: number): number | undefined =>
      cur[cur.length - 1 - depth]?.origin;

    // viaIR function entry: the parameter slots are proved by the calling
    // convention — authoritative, like a DUP read.
    for (const {declId, depth} of this.paramEntryClaims.get(insn.pc) ?? []) {
      const origin = originAt(depth);
      if (origin !== undefined) this.recordRead(origin, declId, 'dup');
    }

    const declared = this.declEndClaims.get(insn.pc);
    if (declared !== undefined) {
      const origin = originAt(0);
      if (origin !== undefined) this.recordRead(origin, declared, 'swap');
    }

    // Read anchor: the read slot's VALUE is proved to be `declId` — record that
    // value number so the variable is reported wherever this value lives.
    const anchor = this.anchors.get(insn.pc);
    if (anchor !== undefined) {
      const {declId, depth, kind} = anchor;
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
            this.originToDecl.get(slot.origin) === declId
        );
      if (origin !== undefined && !liveElsewhere) {
        this.recordRead(origin, declId, kind);
      }
    }
  }

  /**
   * A declaration's initializer call: its returned values ARE the declared
   * variables (last one on top) — see {@link initCallDecls}.
   */
  private readonly claimInitializerResults: OnCallResume<Stack> = (
    insn,
    target,
    resumed,
    returnSlots
  ) => {
    const init =
      insn.node === undefined
        ? undefined
        : this.initCallDecls.get(insn.node.id);
    if (init === undefined) return;
    if (this.program.insns.get(target)?.fnId !== init.callee) return;
    const decls = init.slots;
    // Exactly one returned value per component; otherwise the mapping is unsure.
    if (decls.length !== returnSlots) return;
    decls.forEach((declId, k) => {
      if (declId === null) return;
      const origin = resumed[resumed.length - decls.length + k]?.origin;
      if (origin !== undefined) this.recordRead(origin, declId, 'swap');
    });
  };

  /**
   * Tie a value number to the variable a read proved it to hold, guarding
   * conflicts. `DUPn` reads (`kind: 'dup'`) are AUTHORITATIVE: they populate
   * {@link originToDecl} and, on setting an origin, drop any subordinate SWAP claim
   * for it. `SWAPn` reads (`kind: 'swap'`) are SUBORDINATE: they fill only origins
   * no DUP has claimed (a DUP-claimed origin's mismatched SWAP is ignored, NOT
   * marked ambiguous — viaIR mis-attributes stack-shuffle SWAPs), and two SWAP
   * reads disagreeing on one origin drop it from the SWAP map.
   */
  private recordRead(origin: number, declId: number, kind: ReadKind): void {
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
}

/** Child node types that are nested statement bodies, not a statement's own expressions. */
function isNestedBody(nodeType: string): boolean {
  return (
    nodeType === 'Block' ||
    nodeType === 'UncheckedBlock' ||
    nodeType.endsWith('Statement') ||
    nodeType === 'Return' ||
    nodeType === 'InlineAssembly'
  );
}

/**
 * Stack slots a parameter of solc type `typeIdentifier` occupies: two for a
 * calldata dynamic array/bytes/string (offset + length) and an external function
 * pointer (address + selector), one otherwise.
 */
function stackSlotsOf(typeIdentifier: string | undefined): number {
  if (typeIdentifier === undefined) return 1;
  if (
    /_calldata_ptr$/.test(typeIdentifier) &&
    /^t_(bytes|string)_|_dyn_calldata_ptr$/.test(typeIdentifier)
  ) {
    return 2;
  }
  if (/^t_function_external/.test(typeIdentifier)) return 2;
  return 1;
}

/**
 * Build the static per-pc stack-provenance analyzer for one contract's runtime
 * code. See the module doc; the returned {@link StackProvenance} exposes
 * {@link StackProvenance.variableDepthAt}.
 */
export function stackProvenance(
  cu: CompilationUnit,
  sourcePath: string,
  contractName: string
): StackProvenance {
  const contract = cu.contract(sourcePath, contractName);
  if (contract === undefined) {
    throw new Error(`contract not found: ${sourcePath}:${contractName}`);
  }
  const analyzer = new Analyzer(cu, contract);
  return {
    variableDepthAt: (pc: number, declId: number) =>
      analyzer.variableDepthAt(pc, declId),
    stackLengthAt: (pc: number) => analyzer.stackLengthAt(pc),
  };
}
