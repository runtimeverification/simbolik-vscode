/**
 * Static per-pc stack-provenance analyzer, for both legacy and viaIR codegen.
 *
 * {@link stackProvenance} answers, for a value-type stack variable (a function
 * parameter, named return, or local, identified by its AST declaration id) and
 * a runtime pc: at what depth-from-top does a stack slot holding that
 * variable's value sit on arrival at `pc`? It returns `undefined` when no slot
 * is known to hold it there; the consumer then omits the variable.
 *
 * ## Why not "height − declarationRank"
 * Under `viaIR:true` (the Yul pipeline) the Yul stack scheduler reorders and
 * reuses stack slots per instruction, so a variable has no fixed frame slot and
 * its depth is a per-pc property. This analyzer computes that location by
 * simulating the stack, so it works for both pipelines. On legacy code it is
 * also more precise than a fixed-rank model for value parameters.
 *
 * ## Value numbering
 * A per-function CFG worklist (sharing {@link StackFlow} with
 * {@link stackHeights}) propagates an abstract stack whose every slot carries an
 * optional known PUSH constant (to resolve JUMP targets, as the height analyzer
 * does) and a deterministic origin id: a value number identifying which runtime
 * value occupies the slot.
 *   - a value created by an instruction at pc `p` (a PUSH, or any opcode
 *     result) gets an origin derived from `p`, stable across worklist revisits;
 *   - the frame's below-entry (caller) slots get distinct per-function origins;
 *   - `DUPn` copies a slot's origin (a duplicate is the same value);
 *   - `SWAPn` moves slots (origins follow their values);
 *   - every other opcode pops its inputs and pushes freshly-originated results,
 *     so a slot an op overwrites gets a new value number.
 * Two slots share an origin iff they hold the same value. Internal calls are
 * folded into a net stack effect (never followed into), keeping the caller's
 * slots, and hence their origins and depths, intact.
 *
 * ## How a value gets identified as a variable (the anchor)
 * A variable read is the anchor: when an instruction's source-map node is an
 * `Identifier` whose `referencedDeclaration` is a function param/local, the slot
 * at depth `n` holds that variable's value. For `DUPn` (a copy read) this is
 * reliable: solc emits exactly this to read a value-type stack variable. For
 * `SWAPn` (a move read: a local's last use, the common viaIR pattern for a
 * local passed as a call's final argument) it usually holds, but SWAP
 * attribution is coarse, so SWAP anchors are subordinate to DUP ones (see
 * {@link Analyzer.recordRead}). The slot's origin is mapped to the variable,
 * which is then reported at every pc where a slot with that origin is live,
 * both before the read (e.g. a parameter from function entry) and after.
 *
 * ## Merges
 * At a pc reachable from multiple predecessors the incoming stacks are merged,
 * reaching a least fixpoint. A slot whose origin agrees on every path keeps it;
 * where paths disagree (e.g. a variable assigned in both branches of an
 * if/else, or a loop variable at the loop head) the slot gets a φ value number
 * for that join: it holds one runtime value from the join on, which a later
 * read can name. A φ never inherits a pre-join variable claim, so this stays
 * sound. A pc reached at two conflicting heights (optimizer block-sharing,
 * inline assembly, …) is marked ambiguous and reports `undefined`.
 *
 * Purely static: uses solc artifacts only, no trace. A single pc query never
 * throws.
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
  type CodeKind,
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

// ## Value-numbered abstract stack

/** One abstract stack slot: an optional known constant and value number. */
interface Slot {
  /** Known PUSH constant value (for JUMP-target resolution). */
  const?: number;
  /** Value number: which runtime value occupies this slot. */
  origin?: number;
}

type Stack = Slot[];

function cloneStack(s: Stack): Stack {
  return s.map(slot => ({...slot}));
}

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
 * different values the slot gets a φ value number unique to `(pc, slot)`. The
 * slot still holds one runtime value from the join onward, so a later read can
 * name it. φ numbers are stable across revisits, so the fixpoint terminates.
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
//   inlinedArgOrigin  (−2^40, −2^36]
//   phiOrigin         (−2^44, −2^40]
//   callReturnOrigin  ≤ −2^44
const INLINED_ARG_BASE = -(2 ** 36);
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
 * The value number of result `k` of an internal call resuming at `returnPc`.
 * This has a range of its own: a call can return more than 8 values, and
 * `freshOrigin`'s `pc * 8 + k` would then collide with the next pc's origins
 * (e.g. tagging a return label pushed right after the call as a returned
 * variable).
 */
function callReturnOrigin(returnPc: number, k: number): number {
  return CALL_RETURN_BASE - (returnPc * 4096 + k);
}

/**
 * The value number of the argument slot at `depth` on arrival at an inlined
 * function's entry `pc` (see {@link Analyzer.inlinedEntryParams}).
 */
function inlinedArgOrigin(pc: number, depth: number): number {
  return INLINED_ARG_BASE - (pc * 64 + depth);
}

/** The pc at which a value number was created, if any (not for caller slots). */
function originBirthPc(origin: number): number | undefined {
  if (origin >= 0) return Math.floor(origin / 8);
  if (origin <= CALL_RETURN_BASE) {
    return Math.floor((CALL_RETURN_BASE - origin) / 4096);
  }
  if (origin <= PHI_BASE) return Math.floor((PHI_BASE - origin) / 1024);
  if (origin <= INLINED_ARG_BASE) {
    return Math.floor((INLINED_ARG_BASE - origin) / 64);
  }
  return undefined; // below-entry (caller) slot
}

/**
 * A fresh abstract stack seeded with the frame's below-entry (caller) slots, each
 * given a distinct per-function value number so a below-entry variable (an
 * internally-passed parameter) can be identified and tracked like any other.
 */
function baseStack(entryPc: number): Stack {
  const s: Stack = new Array<Slot>(64);
  // Negative, function-unique origins: 128 spacing > 64 slots, so functions
  // never overlap, and they never collide with a pc-derived origin ≥ 0.
  const base = -(entryPc * 128) - 1;
  for (let i = 0; i < s.length; i++) s[i] = {origin: base - i};
  return s;
}

/**
 * Apply a straight-line (non-JUMP/JUMPI) opcode to the stack, tracking
 * PUSH/DUP/SWAP constants and origins exactly and modelling every other opcode
 * as popping its inputs and pushing freshly value-numbered results.
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
    // DUPn duplicates the slot at depth n (DUP1 → the top): copy const and origin.
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

// ## The analyzer

/**
 * A variable-read anchor: a `DUPn`/`SWAPn` whose source-map node is an
 * `Identifier` referring to the param/local with `declId`; `depth` (= n) is the
 * depth-from-top of the slot it reads, which holds that variable's value.
 * `kind` is `'dup'` (a copy read, reliable) or `'swap'` (a last-use move,
 * subordinate: viaIR's coarse attribution can tag a stack-shuffle SWAP with an
 * unrelated variable's Identifier, so a SWAP anchor never overrides or
 * invalidates a DUP one; see {@link Analyzer.recordRead}). `at` is the
 * identifier occurrence's source offset.
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
   * Value number (origin) → declId claimed by a subordinate `SWAPn` last-use
   * read, for origins no `DUPn` anchor claims. SWAP attribution is coarse under
   * viaIR (a stack-shuffle SWAP can carry an unrelated Identifier), so these are
   * consulted only after {@link originToDecl} and never mark a DUP-claimed
   * origin ambiguous. They locate value-type locals whose only read is a move
   * (e.g. a local passed as a call's final argument).
   */
  private readonly swapOriginToDecl = new Map<number, number>();
  /** Origins a read tied to two different variables (ambiguous ⇒ never reported). */
  private readonly originAmbiguous = new Set<number>();
  /** Origins a SWAP read tied to two different variables (dropped from SWAP map). */
  private readonly swapOriginAmbiguous = new Set<number>();

  // viaIR-only anchors (empty on legacy code).

  /**
   * Internal-call entry pcs of a function → its parameters' entry depths. The
   * Yul code transform enters a function with `…, returnLabel, paramN, …,
   * param1` (param 1 on top), so at the call target the slot at depth
   * Σ(slots of params before i) holds param i. This is the only anchor a
   * single-use parameter gets under viaIR (it is consumed in place, never
   * DUP-read by an Identifier-tagged instruction).
   */
  private readonly paramEntryClaims = new Map<
    number,
    {declId: number; depth: number}[]
  >();
  /**
   * Entry pc of each inlined function (a base constructor legacy codegen
   * inlines into the derived constructor; see `Program.frameEntries`) → its
   * parameters' depths and total slot count. The derived code pushes the
   * arguments in order and falls through, so on arrival param i sits at depth
   * Σ(slots of params after i). An argument is typically a DUP copy of a
   * derived-constructor variable, i.e. the same value number, which a read of
   * both variables would mark ambiguous. So the argument slots get value
   * numbers of their own on arrival ({@link inlinedArgOrigin}) and are claimed
   * by the calling convention.
   */
  private readonly inlinedEntryParams = new Map<
    number,
    {claims: {declId: number; depth: number}[]; slots: number}
  >();
  /**
   * pc → local declared by the single-variable `VariableDeclarationStatement`
   * (with an initializer) whose code falls through to that pc. On arrival the
   * initializer's value — the new local — is on top of the stack. The only anchor
   * a single-use local gets under viaIR (it is consumed where it sits). Recorded
   * as a subordinate (swap-level) claim, so any DUP read wins and conflicting
   * claims cancel.
   */
  private readonly declEndClaims = new Map<number, number>();
  /**
   * AST id of a declaration statement's initializer call → the variables it
   * declares, in order. At that call's return landing the top n slots are the
   * returned values, the last one on top (`(a, b) = f()` ⇒ top = b, then a).
   * This is the only anchor for tuple-destructured locals used once.
   */
  private readonly initCallDecls = new Map<
    number,
    {slots: (number | null)[]; callee: number}
  >();
  /** Per instruction: its enclosing statement's AST id. */
  private readonly stmtOf = new Map<number, number>();
  /** Statement id → the declarations it writes (see {@link statementWrites}). */
  private readonly writesCache = new Map<number, Set<number>>();

  constructor(cu: CompilationUnit, contract: Contract, kind: CodeKind) {
    this.cu = cu;
    this.collectVarDeclIds();
    this.program = new Program(cu, contract, stackDelta, kind);
    this.flow = new StackFlow(this.program, provenanceDomain);
    this.collectAnchors();
    this.collectInlinedEntryParams();
    this.dropShuffleSwaps();
    if (cu.viaIR()) {
      this.collectParamEntryClaims();
      this.collectDeclEndClaims();
      this.collectInitCallDecls();
    }
    for (const entryPc of this.program.frameEntries) {
      this.propagateFunction(entryPc);
    }
  }

  // ## Queries

  stackLengthAt(pc: number): number | undefined {
    if (this.conflicted.has(pc)) return undefined;
    return this.recorded.get(pc)?.length;
  }

  variableDepthAt(pc: number, declId: number): number | undefined {
    if (this.conflicted.has(pc)) return undefined;
    const stack = this.recorded.get(pc);
    if (stack === undefined) return undefined;
    // viaIR: inside a statement that assigns the variable, a value computed by
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
    // variable. A DUP-proved slot always wins over a SWAP-claimed one anywhere
    // on the stack: a variable has one current value, and when the Yul
    // scheduler has already DUP'd it to the top, an Identifier-tagged SWAP that
    // merely moves it down would otherwise claim the unrelated slot it swapped
    // with.
    return (
      shallowest(o => this.originToDecl.get(o) === declId) ??
      shallowest(
        o =>
          !this.originToDecl.has(o) && this.swapOriginToDecl.get(o) === declId
      )
    );
  }

  // ## Static anchor collection

  /** All function param/local `VariableDeclaration` ids across the unit. */
  private collectVarDeclIds(): void {
    walkAllSources(this.cu, node => {
      if (
        node.nodeType === 'VariableDeclaration' &&
        node.id >= 0 &&
        // A param/local sits inside a FunctionDefinition; a state variable is a
        // direct child of the ContractDefinition.
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
   * If `node` is an `Identifier` reading a known param/local, a read anchor for
   * a `DUPn` or `SWAPn` (`op`): the slot at depth `n` holds that variable in the
   * incoming stack. For `DUPn` (`n = op − 0x80`) the value is copied to the top
   * (a non-consuming read); for `SWAPn` (`n = op − 0x8f`) it is moved to the top
   * to be consumed, which solc emits for a value-type local's last use under
   * viaIR. Either way the slot at depth `n` holds the variable at this pc, so
   * its value number identifies the variable wherever that value is live,
   * including before this read.
   */
  private readAnchor(node: AstNode, op: number): ReadAnchor | undefined {
    if (node.nodeType !== 'Identifier') return undefined;
    const declId = node.referencedDeclaration;
    if (declId === undefined || !this.varDeclIds.has(declId)) return undefined;
    const swap = isSwap(op);
    // An identifier on the left of an assignment is a write, not a read: under
    // viaIR `x = e` is a SWAPn moving e's value (the top) into x's position, so
    // the slot at depth n is x's old position (a stale value, or an unrelated
    // slot such as the return label when x is an unassigned return variable).
    // The value moved there is x's new value, so claim the top instead.
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
   * A SWAP anchor in the same basic block as a DUP anchor on the same
   * identifier occurrence is a stack shuffle around the real read (the DUP):
   * e.g. viaIR reads `y` in `y < 0` as `SWAP1; DUP2`, and `x.f()` as
   * `SWAPn; PUSH2 <ret>; DUP(n+2)`, where the SWAP only brings an unrelated slot
   * (a return label) up. Its depth-n slot is not the variable, so drop it.
   */
  private dropShuffleSwaps(): void {
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
    // An internal call is `PUSH <target>; JUMP [in]` into another function.
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

  /** See {@link inlinedEntryParams}. */
  private collectInlinedEntryParams(): void {
    for (const [fnId, entryPc] of this.program.entryByFn) {
      if (this.program.insns.get(entryPc)?.frameFnId === fnId) continue;
      const params = this.cu.nodeById(fnId)?.parameters() ?? [];
      const slotsOf = params.map(p => stackSlotsOf(p.typeIdentifier));
      let depth = slotsOf.reduce((a, b) => a + b, 0);
      const slots = depth;
      const claims: {declId: number; depth: number}[] = [];
      params.forEach((p, i) => {
        depth -= slotsOf[i]!;
        if (slotsOf[i] === 1 && this.varDeclIds.has(p.id)) {
          claims.push({declId: p.id, depth});
        }
      });
      if (slots > 0) this.inlinedEntryParams.set(entryPc, {claims, slots});
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
      // Exactly one declared variable and an initializer (a tuple destructuring
      // leaves several values; a bare declaration may be materialised lazily).
      if (decls.length !== 1 || children.length !== 2) continue;
      const declId = decls[0]!.id;
      if (!this.varDeclIds.has(declId)) continue;
      const insn = this.program.insns.get(pc)!;
      // Only a fall-through end: a jump/terminator continues elsewhere.
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
      // `assignments` lists the tuple components in order, `null` for a
      // skipped one (`(a, b, , ) = f()`). Every returned value occupies a slot,
      // so gaps must be counted or names shift onto the skipped values.
      const slots = n.assignments();
      // The called function (`f(…)` / `x.f(…)`): only a jump into that very
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
   * Declarations a statement writes: an assignment's LHS identifiers, or the
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
          // Only the statement's own expressions, not nested statement bodies.
          if (!isNestedBody(c.nodeType)) visit(c);
        }
      };
      visit(stmt);
    }
    w = writes;
    this.writesCache.set(stmtId, w);
    return w;
  }

  // ## Intra-function CFG worklist (least-fixpoint with origin intersection)

  private propagateFunction(entryPc: number): void {
    const fnId = this.program.insns.get(entryPc)?.frameFnId;
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
      const inlined = this.inlinedEntryParams.get(pc);
      if (inlined !== undefined) {
        for (let depth = 0; depth < inlined.slots; depth++) {
          const k = incoming.length - 1 - depth;
          if (k >= 0) {
            incoming[k] = {
              ...incoming[k]!,
              origin: inlinedArgOrigin(pc, depth),
            };
          }
        }
      }
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
      // Two conflicting heights reach this pc: no single depth can be assigned,
      // so report unknown rather than guess.
      this.conflicted.add(pc);
      return undefined;
    } else if (preds.size <= 1) {
      // A single-predecessor pc is not a join: its state is exactly its
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

    // Function entry: the parameter slots are fixed by the calling convention,
    // so they are as authoritative as a DUP read.
    for (const {declId, depth} of [
      ...(this.paramEntryClaims.get(insn.pc) ?? []),
      ...(this.inlinedEntryParams.get(insn.pc)?.claims ?? []),
    ]) {
      const origin = originAt(depth);
      if (origin !== undefined) this.recordRead(origin, declId, 'dup');
    }

    const declared = this.declEndClaims.get(insn.pc);
    if (declared !== undefined) {
      const origin = originAt(0);
      if (origin !== undefined) this.recordRead(origin, declared, 'swap');
    }

    // Read anchor: the read slot's value is `declId`; record its value number
    // so the variable is reported wherever this value lives.
    const anchor = this.anchors.get(insn.pc);
    if (anchor !== undefined) {
      const {declId, depth, kind} = anchor;
      const idx = cur.length - 1 - depth;
      const origin = idx >= 0 ? cur[idx]!.origin : undefined;
      // A SWAP read is only believable when the variable's value is not already
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
   * A declaration's initializer call: its returned values are the declared
   * variables (last one on top); see {@link initCallDecls}.
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
   * conflicts. `DUPn` reads (`kind: 'dup'`) are authoritative: they populate
   * {@link originToDecl} and drop any subordinate SWAP claim for the origin.
   * `SWAPn` reads (`kind: 'swap'`) are subordinate: they fill only origins no
   * DUP has claimed (a mismatched SWAP on a DUP-claimed origin is ignored, not
   * marked ambiguous, since viaIR mis-attributes stack-shuffle SWAPs), and two
   * SWAP reads disagreeing on one origin drop it from the SWAP map.
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
    // SWAP: defer entirely to an existing DUP claim.
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

/** Whether a child node is a nested statement body, not an own expression. */
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
 * (or init) code. See the module doc; the returned {@link StackProvenance}
 * exposes {@link StackProvenance.variableDepthAt}.
 */
export function stackProvenance(
  cu: CompilationUnit,
  sourcePath: string,
  contractName: string,
  kind: CodeKind = 'runtime'
): StackProvenance {
  const contract = cu.contract(sourcePath, contractName);
  if (contract === undefined) {
    throw new Error(`contract not found: ${sourcePath}:${contractName}`);
  }
  const analyzer = new Analyzer(cu, contract, kind);
  return {
    variableDepthAt: (pc: number, declId: number) =>
      analyzer.variableDepthAt(pc, declId),
    stackLengthAt: (pc: number) => analyzer.stackLengthAt(pc),
  };
}
