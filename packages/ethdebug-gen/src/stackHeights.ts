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
 * The analysis is PURE-STATIC (solc artifacts only, no trace):
 *
 *  1. Disassembly + attribution of each instruction to its enclosing
 *     `FunctionDefinition` ({@link Program}), with the per-opcode stack deltas of
 *     `opcodes.ts`.
 *  2. An intra-function CFG worklist that propagates heights from each entry at
 *     height 0, resolving JUMP/JUMPI targets with a small abstract stack of
 *     known PUSH constants ({@link StackFlow}).
 *  3. Internal calls modelled as a NET stack effect (never followed into): the
 *     caller resumes at its return tag with height adjusted by the callee's
 *     analyzed net effect.
 */
import type {CompilationUnit, Contract} from '@simbolik/solc';

import {
  Program,
  StackFlow,
  type CodeKind,
  type Insn,
  type StackDomain,
} from './cfg.js';
import {PUSH0, isDup, isPushN, isSwap, stackDelta} from './opcodes.js';

/** The public accessor returned by {@link stackHeights}. */
export interface StackHeights {
  /**
   * Frame-relative stack height at `pc` (net slots pushed since the enclosing
   * function body's entry), or `undefined` if `pc` is not an instruction start
   * inside an analyzed function body.
   */
  frameRelHeightAt(pc: number): number | undefined;
}

/**
 * Net stack effect of `op` for the height model. Identical to the shared
 * {@link stackDelta} except BLOBBASEFEE (`0x4a`), which this model has always
 * treated as an unknown opcode (delta 0) rather than a nullary push (+1).
 */
function heightDelta(op: number): number {
  return op === 0x4a ? 0 : stackDelta(op);
}

/** The abstract stack of known PUSH constants; `undefined` = an unknown slot. */
type AbstractStack = Array<number | undefined>;

const constantsDomain: StackDomain<AbstractStack> = {
  // Heights are tracked separately as integers, so the base is only a cushion
  // that lets DUP/SWAP that reach below the analyzed region resolve to
  // `undefined` instead of underflow.
  base: () => new Array<number | undefined>(64).fill(undefined),
  clone: s => s.slice(),
  length: s => s.length,
  constAt: (s, depth) => s[s.length - 1 - depth],
  pop: (s, n) => {
    for (let k = 0; k < n; k++) s.pop();
  },
  pushCallResults: (s, _returnPc, count) => {
    for (let k = 0; k < count; k++) s.push(undefined);
  },
  apply: applyToStack,
};

/**
 * Apply a straight-line (non-JUMP/JUMPI) opcode's effect to the abstract stack,
 * tracking PUSH/DUP/SWAP constants exactly and modelling every other opcode's
 * net effect as popping its inputs and pushing `undefined` results.
 */
function applyToStack(s: AbstractStack, insn: Insn): void {
  const {op} = insn;
  if (op === PUSH0) {
    s.push(0);
    return;
  }
  if (isPushN(op)) {
    s.push(insn.pushValue);
    return;
  }
  if (isDup(op)) {
    // DUPn duplicates the (n-1)-th slot below the top (DUP1 → the top).
    const n = op - 0x80;
    s.push(s[s.length - 1 - n]);
    return;
  }
  if (isSwap(op)) {
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
    for (let k = 0; k < -d; k++) s.pop();
  } else {
    for (let k = 0; k < d; k++) s.push(undefined);
  }
}

class Analyzer {
  private readonly program: Program;
  private readonly flow: StackFlow<AbstractStack>;
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

  constructor(cu: CompilationUnit, contract: Contract, kind: CodeKind) {
    this.program = new Program(cu, contract, heightDelta, kind);
    this.flow = new StackFlow(this.program, constantsDomain);
    for (const entryPc of this.program.entryByFn.values()) {
      this.propagateFunction(entryPc);
    }
  }

  frameRelHeightAt(pc: number): number | undefined {
    if (this.conflicted.has(pc)) {
      return undefined; // ambiguous merge height ⇒ report unknown, never wrong.
    }
    return this.heights.get(pc);
  }

  /**
   * Propagate frame-relative heights across one function's CFG, starting from
   * its body entry at height 0. A pc reached at two conflicting heights is
   * recorded in {@link conflicted} rather than crashing the analysis.
   */
  private propagateFunction(entryPc: number): void {
    const fnId = this.program.insns.get(entryPc)?.fnId;
    const work = [
      {pc: entryPc, height: 0, stack: constantsDomain.base(entryPc)},
    ];

    while (work.length > 0) {
      const {pc, height, stack} = work.pop()!;
      const insn = this.program.insns.get(pc);
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

      for (const next of this.flow.successors(insn, stack, fnId)) {
        work.push({
          pc: next.pc,
          height: height + next.delta,
          stack: next.stack,
        });
      }
    }
  }
}

/**
 * Build the static per-pc stack-height analyzer for one contract's runtime (or
 * init) code. See the module doc for the algorithm; the returned
 * {@link StackHeights} exposes {@link StackHeights.frameRelHeightAt}.
 */
export function stackHeights(
  cu: CompilationUnit,
  sourcePath: string,
  contractName: string,
  kind: CodeKind = 'runtime'
): StackHeights {
  const contract = cu.contract(sourcePath, contractName);
  if (contract === undefined) {
    throw new Error(`contract not found: ${sourcePath}:${contractName}`);
  }
  const analyzer = new Analyzer(cu, contract, kind);
  return {
    frameRelHeightAt: (pc: number) => analyzer.frameRelHeightAt(pc),
  };
}
