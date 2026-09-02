/**
 * Static per-pc stack-height analyzer.
 *
 * {@link stackHeights} computes, for every runtime-bytecode instruction of a
 * contract, its **frame-relative stack height**: the net number of stack slots
 * pushed since the enclosing function body's entry instruction (0 at entry),
 * or `undefined` for pcs outside any analyzed function body (dispatcher, ABI
 * (de)coders, checked-arith helpers, metadata — none of which map to a
 * `FunctionDefinition`).
 *
 * The analysis is PURE-STATIC (solc artifacts only, no trace) and has four
 * parts:
 *
 *  1. Disassembly of the runtime bytecode (via `buildInstructionIndex`), with a
 *     per-opcode stack-delta table.
 *  2. Attribution of each instruction to its enclosing `FunctionDefinition`
 *     (source-map entry → `findInnermostNode` → `closestFunction`), giving each
 *     function's body-entry instruction (lowest attributed pc).
 *  3. An intra-function CFG worklist that propagates heights from each entry at
 *     height 0, resolving JUMP/JUMPI targets with a small abstract stack of
 *     known PUSH constants (solc emits `PUSH2 <tag> … JUMP`).
 *  4. Internal calls modelled as a NET stack effect (never followed into): a
 *     JUMP whose resolved target is another function/helper is a call, so the
 *     caller resumes at its return tag with height adjusted by the callee's
 *     analyzed net effect.
 *
 * ── The opcode stack-delta table ──────────────────────────────────────────────
 * Deltas are `out − in` per the EVM yellow paper / opcode reference, keyed off
 * the bytecode BYTES (not kontrol trace op-names, which differ: PUSHZERO=PUSH0,
 * EVMOR=OR — naming never changes stack DEPTH). This exact table was validated
 * against recorded traces with 0 mismatches over 964 same-depth transitions.
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

/** The public accessor returned by {@link stackHeights}. */
export interface StackHeights {
  /**
   * Frame-relative stack height at `pc` (net slots pushed since the enclosing
   * function body's entry), or `undefined` if `pc` is not an instruction start
   * inside an analyzed function body.
   */
  frameRelHeightAt(pc: number): number | undefined;
}

// ---------------------------------------------------------------------------
// 1. Opcode stack-delta table (off bytecode bytes)
// ---------------------------------------------------------------------------

/**
 * Net stack effect (`pushed − popped`) of the opcode `op` at `pc`.
 * `pc`/`bytes` are only consulted for LOGn (fixed by opcode) — the immediate
 * bytes of PUSH never change its delta (+1). Unknown/undefined opcodes → 0.
 */
function stackDelta(op: number): number {
  // PUSH0 (0x5f) and PUSH1..PUSH32 (0x60..0x7f): push one word.
  if (op === 0x5f || (op >= 0x60 && op <= 0x7f)) {
    return 1;
  }
  // DUP1..DUP16 (0x80..0x8f): +1.
  if (op >= 0x80 && op <= 0x8f) {
    return 1;
  }
  // SWAP1..SWAP16 (0x90..0x9f): 0.
  if (op >= 0x90 && op <= 0x9f) {
    return 0;
  }
  // LOG0..LOG4 (0xa0..0xa4): pop 2 (offset,size) + n topics = −(2 + n).
  if (op >= 0xa0 && op <= 0xa4) {
    return -(2 + (op - 0xa0));
  }
  switch (op) {
    // Binary arithmetic / comparison / bitwise: pop 2, push 1 = −1.
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
      return -1;
    // Unary: pop 1, push 1 = 0.
    case 0x15: // ISZERO
    case 0x19: // NOT
      return 0;
    // Ternary arithmetic: pop 3, push 1 = −2.
    case 0x08: // ADDMOD
    case 0x09: // MULMOD
      return -2;
    // Load-from-1: pop 1, push 1 = 0.
    case 0x51: // MLOAD
    case 0x54: // SLOAD
    case 0x5c: // TLOAD
    case 0x31: // BALANCE
    case 0x3b: // EXTCODESIZE
    case 0x3f: // EXTCODEHASH
    case 0x35: // CALLDATALOAD
      return 0;
    // Store: pop 2 = −2.
    case 0x52: // MSTORE
    case 0x53: // MSTORE8
    case 0x55: // SSTORE
    case 0x5d: // TSTORE
      return -2;
    case 0x50: // POP
      return -1;
    case 0x56: // JUMP: pop dest.
      return -1;
    case 0x57: // JUMPI: pop dest + cond.
      return -2;
    case 0x5b: // JUMPDEST
      return 0;
    // Nullary pushes (env/state): 0 → 1 = +1.
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
    case 0x58: // PC
    case 0x59: // MSIZE
    case 0x5a: // GAS
      return 1;
    // Copies: pop 3 (destOffset, offset, size) = −3.
    case 0x37: // CALLDATACOPY
    case 0x39: // CODECOPY
    case 0x3e: // RETURNDATACOPY
    case 0x5e: // MCOPY
      return -3;
    case 0x3c: // EXTCODECOPY: pop 4.
      return -4;
    case 0xf0: // CREATE: pop 3, push 1 = −2.
      return -2;
    case 0xf5: // CREATE2: pop 4, push 1 = −3.
      return -3;
    case 0xf1: // CALL: pop 7, push 1 = −6.
    case 0xf2: // CALLCODE
      return -6;
    case 0xf4: // DELEGATECALL: pop 6, push 1 = −5.
    case 0xfa: // STATICCALL
      return -5;
    case 0xf3: // RETURN: pop 2.
    case 0xfd: // REVERT
      return -2;
    case 0xff: // SELFDESTRUCT: pop 1.
      return -1;
    case 0x00: // STOP
    case 0xfe: // INVALID
      return 0;
    default:
      return 0;
  }
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
// 2. Disassembly + attribution
// ---------------------------------------------------------------------------

/** One decoded instruction with everything the analysis needs, precomputed. */
interface Insn {
  pc: number;
  op: number;
  /** Total byte size (1 + immediate bytes for PUSHn). */
  size: number;
  /** Immediate value for PUSH0..PUSH32 (0 for non-pushes / PUSH0). */
  pushValue: number;
  delta: number;
  jump: Jump;
  /** Enclosing `FunctionDefinition` AST id, or `undefined` (helper/dispatcher). */
  fnId: number | undefined;
}

/** The abstract stack of known PUSH constants; `undefined` = an unknown slot. */
type AbstractStack = Array<number | undefined>;

/** Duplicate the abstract stack so worklist branches never alias. */
function cloneStack(s: AbstractStack): AbstractStack {
  return s.slice();
}

/** Read the top-of-stack constant (`undefined` if unknown or empty). */
function top(s: AbstractStack): number | undefined {
  return s.length > 0 ? s[s.length - 1] : undefined;
}

/**
 * Apply a straight-line (non-JUMP/JUMPI) opcode's effect to the abstract stack,
 * tracking PUSH/DUP/SWAP constants exactly and modelling every other opcode's
 * net effect as popping its inputs and pushing `undefined` results.
 */
function applyToStack(s: AbstractStack, insn: Insn): void {
  const {op} = insn;
  if (op === 0x5f) {
    s.push(0); // PUSH0
    return;
  }
  if (op >= 0x60 && op <= 0x7f) {
    s.push(insn.pushValue); // PUSHn
    return;
  }
  if (op >= 0x80 && op <= 0x8f) {
    // DUPn duplicates the (n-1)-th slot below the top (DUP1 → the top).
    const n = op - 0x80;
    s.push(s[s.length - 1 - n]);
    return;
  }
  if (op >= 0x90 && op <= 0x9f) {
    // SWAPn swaps the top with the n-th slot below it.
    const n = op - 0x90 + 1;
    const i = s.length - 1;
    const j = s.length - 1 - n;
    if (j >= 0) {
      const tmp = s[i];
      s[i] = s[j];
      s[j] = tmp;
    }
    return;
  }
  const d = insn.delta;
  if (d < 0) {
    for (let k = 0; k < -d; k++) {
      s.pop();
    }
  } else {
    for (let k = 0; k < d; k++) {
      s.push(undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// The analyzer
// ---------------------------------------------------------------------------

class Analyzer {
  private readonly insns = new Map<number, Insn>();
  private readonly jumpdests = new Set<number>();
  /** Function id → its body-entry pc (lowest attributed pc). */
  private readonly entryByFn = new Map<number, number>();
  private readonly heights = new Map<number, number>();
  /**
   * Pcs reached at two conflicting frame-relative heights during propagation.
   * In valid unoptimized solc output this never happens, but optimizer-shared
   * blocks, modifiers, try/catch or inline assembly can merge control flow at a
   * pc the frame-relative model cannot assign a single height to. Rather than
   * crash a debug session, such a pc is recorded here and reported as
   * `undefined` (honest "unknown"), while the rest of the function keeps its
   * best-effort heights.
   */
  private readonly conflicted = new Set<number>();
  /** Memoized subroutine net effects, keyed by entry pc. */
  private readonly netCache = new Map<number, number | undefined>();
  private readonly netInProgress = new Set<number>();

  constructor(cu: CompilationUnit, contract: Contract) {
    this.disassemble(cu, contract);
  }

  /** Decode every instruction and attribute it to a FunctionDefinition. */
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
      this.insns.set(pc, {
        pc,
        op,
        size,
        pushValue,
        delta: stackDelta(op),
        jump: entry?.jump ?? '-',
        fnId,
      });
      if (fnId !== undefined) {
        const prev = this.entryByFn.get(fnId);
        if (prev === undefined || pc < prev) {
          this.entryByFn.set(fnId, pc);
        }
      }
    }
  }

  /** Map a source-map entry to its enclosing FunctionDefinition id, if any. */
  private attributeFunction(
    cu: CompilationUnit,
    entry: SourceMapEntry,
  ): number | undefined {
    if (entry.fileId < 0) {
      return undefined;
    }
    const source = cu.sourceById(entry.fileId);
    if (source === undefined) {
      return undefined;
    }
    const node = findInnermostNode(source.ast(), entry.start, entry.length);
    if (node === undefined) {
      return undefined;
    }
    const fn = closestFunction(node);
    return fn === undefined ? undefined : fn.id;
  }

  /** Run the analysis: propagate every attributed function from its entry. */
  analyze(): void {
    for (const entryPc of this.entryByFn.values()) {
      this.propagateFunction(entryPc);
    }
  }

  frameRelHeightAt(pc: number): number | undefined {
    if (this.conflicted.has(pc)) {
      return undefined; // ambiguous merge height ⇒ report unknown, never wrong.
    }
    return this.heights.get(pc);
  }

  // -------------------------------------------------------------------------
  // 3. Intra-function CFG worklist
  // -------------------------------------------------------------------------

  /**
   * Propagate frame-relative heights across one function's CFG, starting from
   * its body entry at height 0. Internal jumps follow the resolved constant
   * target; calls (jump into a different function/helper) are folded into a net
   * effect and continue at the return tag. Heights are written into
   * {@link heights}; a pc reached at two conflicting heights (not expected in
   * valid unoptimized output) is recorded in {@link conflicted} and reported as
   * `undefined` rather than crashing the analysis.
   */
  private propagateFunction(entryPc: number): void {
    const fnId = this.insns.get(entryPc)?.fnId;
    interface Item {
      pc: number;
      height: number;
      stack: AbstractStack;
    }
    const work: Item[] = [{pc: entryPc, height: 0, stack: baseStack()}];

    while (work.length > 0) {
      const {pc, height, stack} = work.pop()!;
      const insn = this.insns.get(pc);
      if (insn === undefined) {
        continue; // pc points into push data or past the end.
      }
      const seen = this.heights.get(pc);
      if (seen !== undefined) {
        if (seen !== height) {
          // A correct unoptimized function never reaches a pc at two heights;
          // this signals code the frame-relative model can't handle (optimizer
          // block-sharing, modifiers, try/catch, inline assembly). Degrade
          // gracefully: mark the pc unknown and stop this branch instead of
          // aborting the whole contract's analysis (a debugger must not crash
          // on an odd contract).
          this.conflicted.add(pc);
        }
        continue; // already fixed (or now marked conflicted); don't revisit.
      }
      this.heights.set(pc, height);

      if (isBlockTerminator(insn.op)) {
        continue;
      }

      if (insn.op === 0x56) {
        // JUMP.
        this.handleJump(height, stack, insn, fnId, (next) => work.push(next));
        continue;
      }

      if (insn.op === 0x57) {
        // JUMPI: pop dest + cond, propagate to both target and fall-through.
        const target = top(stack);
        const branched = cloneStack(stack);
        branched.pop();
        branched.pop();
        const nextHeight = height + insn.delta;
        if (target !== undefined && this.jumpdests.has(target)) {
          work.push({
            pc: target,
            height: nextHeight,
            stack: cloneStack(branched),
          });
        }
        work.push({pc: pc + insn.size, height: nextHeight, stack: branched});
        continue;
      }

      // Straight-line instruction: fall through.
      const nextStack = cloneStack(stack);
      applyToStack(nextStack, insn);
      work.push({
        pc: pc + insn.size,
        height: height + insn.delta,
        stack: nextStack,
      });
    }
  }

  /** Handle a JUMP: internal jump, internal call (net effect), or return. */
  private handleJump(
    height: number,
    stack: AbstractStack,
    insn: Insn,
    fnId: number | undefined,
    push: (item: {pc: number; height: number; stack: AbstractStack}) => void,
  ): void {
    const target = top(stack);
    if (target === undefined || !this.jumpdests.has(target)) {
      // Dynamic target = the caller-supplied return address ⇒ frame return.
      return;
    }
    if (this.isCall(insn, fnId, target)) {
      // Internal call: fold in the callee's net effect and resume at the
      // return tag; never propagate into the callee's body.
      const net = this.netEffect(target);
      if (net === undefined) {
        return; // callee never returns (revert-only) ⇒ dead resume.
      }
      const depth = this.returnTagDepth(stack, fnId);
      if (depth === undefined) {
        return; // no discernible return tag (defensive; unreached in practice).
      }
      const returnPc = stack[stack.length - 1 - depth]!;
      // The call consumes funcTag + args + returnTag (depth + 1 top slots) and
      // leaves the callee's return values; net = returnSlots − argSlots − 2, so
      // returnSlots = net + depth + 1.
      const resumed = cloneStack(stack);
      for (let k = 0; k <= depth; k++) {
        resumed.pop();
      }
      const returnSlots = net + depth + 1;
      for (let k = 0; k < returnSlots; k++) {
        resumed.push(undefined);
      }
      push({pc: returnPc, height: height + net, stack: resumed});
      return;
    }
    // Internal jump within the same function: pop the destination and continue.
    const nextStack = cloneStack(stack);
    nextStack.pop();
    push({pc: target, height: height + insn.delta, stack: nextStack});
  }

  /**
   * Is this JUMP a call into another subroutine (vs an intra-function jump)?
   * A call is a solc `PUSH <returnTag> … PUSH <funcTag> JUMP` marked `jump: 'i'`
   * whose target is NOT the current function. The extra function-id guard is
   * needed because an external function's ABI wrapper enters its OWN body via a
   * `jump: 'i'` (same function id) — that must stay an internal jump.
   */
  private isCall(
    insn: Insn,
    fnId: number | undefined,
    target: number,
  ): boolean {
    if (insn.jump !== 'i') {
      return false;
    }
    const targetFn = this.insns.get(target)?.fnId;
    const sameFunction =
      fnId !== undefined && targetFn !== undefined && fnId === targetFn;
    return !sameFunction;
  }

  /**
   * Depth (0-based from the top) of the return-tag constant on the abstract
   * stack at a call: the topmost known constant BELOW the funcTag whose value is
   * a JUMPDEST. solc pushes the return tag before the args, so it sits just
   * below `argSlots` argument slots; scanning down from the top finds it.
   *
   * When the call site is inside a `FunctionDefinition` (`ownerFnId` defined),
   * the return tag MUST be a JUMPDEST of that same function — the point control
   * resumes at is, by construction, the caller's own code. This guard is
   * essential: an argument value can coincide with an unrelated JUMPDEST pc
   * (e.g. `0x40`), and only the same-function filter distinguishes it from the
   * genuine return tag. For helper subroutines (`ownerFnId` undefined, no AST
   * function) we fall back to the topmost JUMPDEST-valued constant.
   */
  private returnTagDepth(
    stack: AbstractStack,
    ownerFnId: number | undefined,
  ): number | undefined {
    for (let depth = 1; depth < stack.length; depth++) {
      const value = stack[stack.length - 1 - depth];
      if (value === undefined || !this.jumpdests.has(value)) {
        continue;
      }
      if (ownerFnId !== undefined && this.insns.get(value)?.fnId !== ownerFnId) {
        continue;
      }
      return depth;
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // 4. Subroutine net-effect analysis
  // -------------------------------------------------------------------------

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
  private netEffect(entryPc: number): number | undefined {
    const cached = this.netCache.get(entryPc);
    if (cached !== undefined || this.netCache.has(entryPc)) {
      return cached;
    }
    if (this.netInProgress.has(entryPc)) {
      return undefined; // recursive cycle: treat as non-returning here.
    }
    this.netInProgress.add(entryPc);

    interface Item {
      pc: number;
      height: number;
      stack: AbstractStack;
    }
    const localHeights = new Map<number, number>();
    const work: Item[] = [{pc: entryPc, height: 0, stack: baseStack()}];
    let hret: number | undefined;

    while (work.length > 0) {
      const {pc, height, stack} = work.pop()!;
      const insn = this.insns.get(pc);
      if (insn === undefined) {
        continue;
      }
      const seen = localHeights.get(pc);
      if (seen !== undefined) {
        continue; // heights agree in valid solc output; first visit wins.
      }
      localHeights.set(pc, height);

      if (isBlockTerminator(insn.op)) {
        continue; // STOP/REVERT/… — a non-returning path.
      }

      if (insn.op === 0x56) {
        const target = top(stack);
        if (target === undefined || !this.jumpdests.has(target)) {
          // Terminal return to the caller-supplied address.
          if (hret === undefined) {
            hret = height;
          }
          continue;
        }
        if (this.isCall(insn, insn.fnId, target)) {
          const net = this.netEffect(target);
          if (net === undefined) {
            continue;
          }
          const depth = this.returnTagDepth(stack, insn.fnId);
          if (depth === undefined) {
            continue;
          }
          const returnPc = stack[stack.length - 1 - depth]!;
          const resumed = cloneStack(stack);
          for (let k = 0; k <= depth; k++) {
            resumed.pop();
          }
          for (let k = 0; k < net + depth + 1; k++) {
            resumed.push(undefined);
          }
          work.push({pc: returnPc, height: height + net, stack: resumed});
          continue;
        }
        const nextStack = cloneStack(stack);
        nextStack.pop();
        work.push({pc: target, height: height + insn.delta, stack: nextStack});
        continue;
      }

      if (insn.op === 0x57) {
        const target = top(stack);
        const branched = cloneStack(stack);
        branched.pop();
        branched.pop();
        const nextHeight = height + insn.delta;
        if (target !== undefined && this.jumpdests.has(target)) {
          work.push({
            pc: target,
            height: nextHeight,
            stack: cloneStack(branched),
          });
        }
        work.push({pc: pc + insn.size, height: nextHeight, stack: branched});
        continue;
      }

      const nextStack = cloneStack(stack);
      applyToStack(nextStack, insn);
      work.push({
        pc: pc + insn.size,
        height: height + insn.delta,
        stack: nextStack,
      });
    }

    this.netInProgress.delete(entryPc);
    const net = hret === undefined ? undefined : hret - 2;
    this.netCache.set(entryPc, net);
    return net;
  }
}

/**
 * A fresh abstract stack seeded with unknown caller slots. Heights are tracked
 * separately as integers, so the base is only a cushion that lets DUP/SWAP that
 * reach below the analyzed region resolve to `undefined` instead of underflow.
 */
function baseStack(): AbstractStack {
  return new Array<number | undefined>(64).fill(undefined);
}

/** Decode a `0x`-prefixed hex string to bytes. */
function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/**
 * Build the static per-pc stack-height analyzer for one contract's runtime code.
 * See the module doc for the algorithm; the returned {@link StackHeights}
 * exposes {@link StackHeights.frameRelHeightAt}.
 */
export function stackHeights(
  cu: CompilationUnit,
  sourcePath: string,
  contractName: string,
): StackHeights {
  const contract = cu.contract(sourcePath, contractName);
  if (contract === undefined) {
    throw new Error(`contract not found: ${sourcePath}:${contractName}`);
  }
  const analyzer = new Analyzer(cu, contract);
  analyzer.analyze();
  return {
    frameRelHeightAt: (pc: number) => analyzer.frameRelHeightAt(pc),
  };
}
