/**
 * The control-flow machinery shared by the two static stack analyzers
 * ({@link stackHeights} and {@link stackProvenance}):
 *
 *  - {@link Program}: the decoded runtime bytecode, each instruction attributed
 *    to its enclosing `FunctionDefinition` (source-map entry → innermost node →
 *    `closestFunction`), giving each function's body-entry instruction (lowest
 *    attributed pc).
 *  - {@link StackFlow}: the successor relation of one instruction over an
 *    ABSTRACT stack (resolving JUMP/JUMPI targets from known PUSH constants —
 *    solc emits `PUSH2 <tag> … JUMP`), with internal calls modelled as a NET
 *    stack effect (never followed into): a JUMP whose resolved target is another
 *    function/helper is a call, so the caller resumes at its return tag with the
 *    callee's analyzed net effect.
 *
 * The analyzers differ only in what an abstract stack slot carries (a known
 * constant; or a constant plus a value number), captured by {@link StackDomain},
 * and in how they merge states at a pc, which each keeps to itself.
 */
import {
  buildInstructionIndex,
  closestFunction,
  type AstNode,
  type CompilationUnit,
  type Contract,
  type Jump,
} from '@simbolik/solc';

import {nodeAtEntry} from './ast.js';
import {
  JUMP,
  JUMPDEST,
  JUMPI,
  hexToBytes,
  isBlockTerminator,
  isPushN,
} from './opcodes.js';

/** One decoded instruction with everything the analyses need, precomputed. */
export interface Insn {
  pc: number;
  op: number;
  /** Total byte size (1 + immediate bytes for PUSHn). */
  size: number;
  /** Immediate value for PUSH1..PUSH32 (0 for non-pushes / PUSH0). */
  pushValue: number;
  /** Net stack effect (`pushed − popped`). */
  delta: number;
  jump: Jump;
  /** Innermost AST node of the instruction's source-map entry, if any. */
  node: AstNode | undefined;
  /** Enclosing `FunctionDefinition` AST id, or `undefined` (helper/dispatcher). */
  fnId: number | undefined;
  /**
   * For a `JUMP [in]`: how many values the call returns (from the call's AST
   * type) — used when the target is DYNAMIC (a call through a function pointer).
   */
  callRets?: number;
}

/** The decoded runtime code of one contract. */
export class Program {
  readonly insns = new Map<number, Insn>();
  /** Every instruction-start pc, in increasing order. */
  readonly pcs: readonly number[];
  readonly jumpdests = new Set<number>();
  /** Function id → its body-entry pc (lowest attributed pc). */
  readonly entryByFn = new Map<number, number>();

  constructor(
    cu: CompilationUnit,
    contract: Contract,
    deltaOf: (op: number) => number
  ) {
    const bytecode = contract.runtimeBytecode();
    const bytes = hexToBytes(bytecode);
    const {instructionToPc} = buildInstructionIndex(bytecode);
    const sourceMap = contract.runtimeSourceMap();
    this.pcs = instructionToPc;

    for (let i = 0; i < instructionToPc.length; i++) {
      const pc = instructionToPc[i]!;
      const op = bytes[pc]!;
      let size = 1;
      let pushValue = 0;
      if (isPushN(op)) {
        const n = op - 0x5f;
        size += n;
        for (let k = 0; k < n; k++) {
          pushValue = pushValue * 256 + (bytes[pc + 1 + k] ?? 0);
        }
      }
      if (op === JUMPDEST) this.jumpdests.add(pc);
      const entry = sourceMap[i];
      const node = entry ? nodeAtEntry(cu, entry) : undefined;
      const fnId = node ? closestFunction(node)?.id : undefined;
      const callRets =
        op === JUMP && entry?.jump === 'i' ? callReturnCount(node) : undefined;
      this.insns.set(pc, {
        pc,
        op,
        size,
        pushValue,
        delta: deltaOf(op),
        jump: entry?.jump ?? '-',
        node,
        fnId,
        ...(callRets !== undefined ? {callRets} : {}),
      });
      if (fnId !== undefined) {
        const prev = this.entryByFn.get(fnId);
        if (prev === undefined || pc < prev) this.entryByFn.set(fnId, pc);
      }
    }
  }

  /**
   * Is this JUMP a call into another subroutine (vs an intra-function jump)?
   * A call is a solc `PUSH <returnTag> … PUSH <funcTag> JUMP` marked `jump: 'i'`
   * whose target is NOT the current function. The extra function-id guard is
   * needed because an external function's ABI wrapper enters its OWN body via a
   * `jump: 'i'` (same function id) — that must stay an internal jump.
   */
  isCall(insn: Insn, fnId: number | undefined, target: number): boolean {
    if (insn.jump !== 'i') return false;
    const targetFn = this.insns.get(target)?.fnId;
    const sameFunction =
      fnId !== undefined && targetFn !== undefined && fnId === targetFn;
    return !sameFunction;
  }

  /**
   * Depth (0-based from the top) of the return-tag constant on an abstract
   * stack of `length` slots at a call: the topmost known constant BELOW the
   * funcTag whose value is a JUMPDEST. solc pushes the return tag before the
   * args, so it sits just below `argSlots` argument slots; scanning down from the
   * top finds it.
   *
   * When the call site is inside a `FunctionDefinition` (`ownerFnId` defined),
   * the return tag MUST be a JUMPDEST of that same function — the point control
   * resumes at is, by construction, the caller's own code. This guard is
   * essential: an argument value can coincide with an unrelated JUMPDEST pc
   * (e.g. `0x40`), and only the same-function filter distinguishes it from the
   * genuine return tag. For helper subroutines (`ownerFnId` undefined, no AST
   * function) we fall back to the topmost JUMPDEST-valued constant.
   */
  returnTagDepth(
    length: number,
    constAt: (depth: number) => number | undefined,
    ownerFnId: number | undefined
  ): number | undefined {
    for (let depth = 1; depth < length; depth++) {
      const value = constAt(depth);
      if (value === undefined || !this.jumpdests.has(value)) continue;
      if (
        ownerFnId !== undefined &&
        this.insns.get(value)?.fnId !== ownerFnId
      ) {
        continue;
      }
      return depth;
    }
    return undefined;
  }
}

/**
 * The number of values the internal call at `node` returns, read from the
 * enclosing `FunctionCall`'s type (`tuple()` → 0, `tuple(a,b)` → 2, any other
 * type → 1); `undefined` if the node is not inside a call.
 */
function callReturnCount(node: AstNode | undefined): number | undefined {
  let n = node;
  while (n !== undefined && n.nodeType !== 'FunctionCall') n = n.parent();
  const t = n?.typeString;
  if (t === undefined) return undefined;
  const m = /^tuple\((.*)\)$/.exec(t);
  if (m === null) return 1;
  const inner = m[1]!.trim();
  if (inner === '') return 0;
  let depth = 0;
  let count = 1;
  for (const ch of inner) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (ch === ',' && depth === 0) count++;
  }
  return count;
}

/** What an analysis tracks per abstract stack; stacks are arrays, top last. */
export interface StackDomain<S> {
  /** A fresh stack for a walk entering at `entryPc` (seeded with caller slots). */
  base(entryPc: number): S;
  clone(stack: S): S;
  length(stack: S): number;
  /** The known constant at `depth` from the top, else `undefined`. */
  constAt(stack: S, depth: number): number | undefined;
  /** Pop `n` slots in place. */
  pop(stack: S, n: number): void;
  /** Push, in place, the `count` results of an internal call resuming at `returnPc`. */
  pushCallResults(stack: S, returnPc: number, count: number): void;
  /** Apply a straight-line (non-JUMP/JUMPI) instruction in place. */
  apply(stack: S, insn: Insn): void;
}

/** One successor state of an instruction: next pc, its arrival stack, height change. */
export interface Successor<S> {
  pc: number;
  stack: S;
  delta: number;
}

/**
 * Called when a direct internal call resumes: `resumed` is the arrival stack at
 * the return tag, whose top `returnSlots` slots are the callee's results.
 */
export type OnCallResume<S> = (
  insn: Insn,
  target: number,
  resumed: S,
  returnSlots: number
) => void;

/** The successor relation + memoized subroutine net effects over one domain. */
export class StackFlow<S> {
  private readonly netCache = new Map<number, number | undefined>();
  private readonly netInProgress = new Set<number>();

  constructor(
    readonly program: Program,
    private readonly domain: StackDomain<S>
  ) {}

  /** Whether `insn` is a JUMP whose target is not a known JUMPDEST constant. */
  isDynamicJump(insn: Insn, stack: S): boolean {
    if (insn.op !== JUMP) return false;
    const target = this.domain.constAt(stack, 0);
    return target === undefined || !this.program.jumpdests.has(target);
  }

  /**
   * The successors of `insn` on arrival `stack` (not mutated), in the order a
   * LIFO worklist must push them. `fnId` owns the call site (for call detection
   * and the return-tag search). A block terminator, a frame return (a dynamic
   * JUMP that is not an indirect call) and a call that never returns have none.
   */
  successors(
    insn: Insn,
    stack: S,
    fnId: number | undefined,
    onCallResume?: OnCallResume<S>
  ): Successor<S>[] {
    const d = this.domain;
    if (isBlockTerminator(insn.op)) return [];

    if (insn.op === JUMP) {
      const target = d.constAt(stack, 0);
      if (target === undefined || !this.program.jumpdests.has(target)) {
        // Dynamic target: the caller-supplied return address ⇒ frame return —
        // unless it is an INDIRECT CALL (`[in]`, through a function pointer):
        // then resume at its return tag with the call's return values.
        const resume = this.indirectResume(stack, insn, fnId);
        return resume === undefined ? [] : [resume];
      }
      if (this.program.isCall(insn, fnId, target)) {
        // Internal call: fold in the callee's net effect and resume at the
        // return tag; never propagate into the callee's body.
        const net = this.netEffect(target);
        if (net === undefined) return []; // callee never returns ⇒ dead resume.
        const call = this.returnSite(stack, fnId);
        if (call === undefined) return [];
        // The call consumes funcTag + args + returnTag (depth + 1 top slots) and
        // leaves the callee's return values; net = returnSlots − argSlots − 2, so
        // returnSlots = net + depth + 1.
        const returnSlots = net + call.depth + 1;
        const resumed = d.clone(stack);
        d.pop(resumed, call.depth + 1);
        d.pushCallResults(resumed, call.returnPc, returnSlots);
        onCallResume?.(insn, target, resumed, returnSlots);
        return [{pc: call.returnPc, stack: resumed, delta: net}];
      }
      // Internal jump within the same function: pop the destination and continue.
      const next = d.clone(stack);
      d.pop(next, 1);
      return [{pc: target, stack: next, delta: insn.delta}];
    }

    if (insn.op === JUMPI) {
      // Pop dest + cond; propagate to both target and fall-through.
      const target = d.constAt(stack, 0);
      const branched = d.clone(stack);
      d.pop(branched, 2);
      const out: Successor<S>[] = [];
      if (target !== undefined && this.program.jumpdests.has(target)) {
        out.push({pc: target, stack: d.clone(branched), delta: insn.delta});
      }
      out.push({pc: insn.pc + insn.size, stack: branched, delta: insn.delta});
      return out;
    }

    // Straight-line instruction: fall through.
    const next = d.clone(stack);
    d.apply(next, insn);
    return [{pc: insn.pc + insn.size, stack: next, delta: insn.delta}];
  }

  /**
   * An indirect internal call (`JUMP [in]` to a function-pointer target): resume
   * at the return tag, the call having consumed target + args + return tag and
   * left its `callRets` return values. `undefined` when not resolvable.
   */
  private indirectResume(
    stack: S,
    insn: Insn,
    fnId: number | undefined
  ): Successor<S> | undefined {
    if (insn.jump !== 'i' || insn.callRets === undefined) return undefined;
    const call = this.returnSite(stack, fnId);
    if (call === undefined) return undefined;
    const resumed = this.domain.clone(stack);
    this.domain.pop(resumed, call.depth + 1);
    this.domain.pushCallResults(resumed, call.returnPc, insn.callRets);
    return {
      pc: call.returnPc,
      stack: resumed,
      delta: insn.callRets - call.depth - 1,
    };
  }

  /** The return tag of a call on `stack`: its depth and the pc it resumes at. */
  private returnSite(
    stack: S,
    fnId: number | undefined
  ): {depth: number; returnPc: number} | undefined {
    const d = this.domain;
    const depth = this.program.returnTagDepth(
      d.length(stack),
      k => d.constAt(stack, k),
      fnId
    );
    if (depth === undefined) return undefined;
    const returnPc = d.constAt(stack, depth);
    return returnPc === undefined ? undefined : {depth, returnPc};
  }

  /**
   * Net stack effect a CALL to the subroutine at `entryPc` has on its caller
   * (`returnSlots − argSlots − 2`, the −2 covering the funcTag popped by the
   * jump-in and the returnTag popped by the jump-out).
   *
   * Derived structurally: analyze the subroutine from its entry at relative
   * height 0; at its terminal return (`JUMP` to the caller-supplied dynamic
   * address, i.e. an unknown top-of-stack) the relative height is `Hret`, and
   * the net effect is `Hret − 2`. Returns `undefined` if no return is reachable
   * (a revert-only helper). Memoized; recursion is cycle-guarded.
   */
  netEffect(entryPc: number): number | undefined {
    const cached = this.netCache.get(entryPc);
    if (cached !== undefined || this.netCache.has(entryPc)) return cached;
    if (this.netInProgress.has(entryPc)) {
      return undefined; // recursive cycle: treat as non-returning here.
    }
    this.netInProgress.add(entryPc);

    const visited = new Set<number>();
    const work: {pc: number; height: number; stack: S}[] = [
      {pc: entryPc, height: 0, stack: this.domain.base(entryPc)},
    ];
    let hret: number | undefined;
    let hretOut: number | undefined;

    while (work.length > 0) {
      const {pc, height, stack} = work.pop()!;
      const insn = this.program.insns.get(pc);
      if (insn === undefined) continue; // into push data / past the end.
      if (visited.has(pc)) continue; // heights agree in valid solc output; first visit wins.
      visited.add(pc);

      if (this.isDynamicJump(insn, stack) && insn.jump !== 'i') {
        // Terminal return to the caller-supplied address. An `[out]` jump is
        // authoritative; an untagged one is a weaker candidate. (A dynamic `[in]`
        // jump is an INDIRECT CALL — through a function pointer, e.g. forge-std's
        // console `_sendLogPayload` — whose height is not the frame's return
        // height: taking it skewed every caller by +4 per `bound()` on real
        // uniswap tests. `successors` resumes it at its return tag instead.)
        if (insn.jump === 'o') hretOut ??= height;
        else hret ??= height;
        continue;
      }
      for (const next of this.successors(insn, stack, insn.fnId)) {
        work.push({
          pc: next.pc,
          height: height + next.delta,
          stack: next.stack,
        });
      }
    }

    this.netInProgress.delete(entryPc);
    const ret = hretOut ?? hret;
    const net = ret === undefined ? undefined : ret - 2;
    this.netCache.set(entryPc, net);
    return net;
  }
}
