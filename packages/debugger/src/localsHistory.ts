/**
 * Trace-based reasoning about a frame's params/locals over its invocation:
 * where to read them, whether the static model's location applies on the
 * executed path, whether a live slot holds a stale copy, and where the variable
 * was last located. Pure trace reconstruction — all variable LAYOUT comes from
 * `variablesAt` (`@simbolik/ethdebug-gen`).
 */
import type {ResolvedVariable} from '@simbolik/ethdebug-gen';
import type {CompilationUnit} from '@simbolik/solc';

import {liveVariables} from './contractAnalysis.js';
import {isSolidityFrame, type FrameInfo} from './frames.js';
import {addressHex} from './hex.js';
import type {Trace} from './trace.js';
import {statementWriteKind, statementWrites} from './writes.js';

/** Pure stack/control plumbing — executing only these does no computation. */
function isShuffleOp(op: string): boolean {
  return (
    op.startsWith('PUSH') ||
    op.startsWith('DUP') ||
    op.startsWith('SWAP') ||
    op === 'POP' ||
    op === 'JUMP' ||
    op === 'JUMPI' ||
    op === 'JUMPDEST'
  );
}

/** Opcodes that push NO result (everything else except DUP/SWAP pushes exactly one). */
// prettier-ignore
const NO_RESULT_OPS = new Set([
  'POP', 'JUMP', 'JUMPI', 'JUMPDEST', 'MSTORE', 'MSTORE8', 'SSTORE', 'TSTORE',
  'LOG0', 'LOG1', 'LOG2', 'LOG3', 'LOG4', 'STOP', 'RETURN', 'REVERT', 'INVALID',
  'SELFDESTRUCT', 'CALLDATACOPY', 'CODECOPY', 'EXTCODECOPY', 'RETURNDATACOPY', 'MCOPY',
]);

/** Whether a resolved variable is a param/return/local (not storage). */
export function isFrameLocal(v: ResolvedVariable): boolean {
  return v.kind === 'parameter' || v.kind === 'return' || v.kind === 'local';
}

/** The live variables of a (Solidity) frame's contract at `pc`. */
export function variablesAtPc(
  frame: FrameInfo,
  pc: number
): ResolvedVariable[] {
  return isSolidityFrame(frame)
    ? liveVariables(frame.contract, frame.cu, pc)
    : [];
}

/** A step where a variable was last located, with the variable as resolved there. */
export interface Location {
  v: ResolvedVariable;
  step: number;
}

export class LocalsHistory {
  readonly #trace: Trace;
  readonly #modelRefCache = new Map<string, number | undefined>();

  constructor(trace: Trace) {
    this.#trace = trace;
  }

  #addressAt(j: number): string {
    return addressHex(this.#trace.steps[j]!.codeAddress);
  }

  /**
   * The step to read the frame's params/locals at. Normally the frame's own step,
   * but when the frame is parked at its function PROLOGUE/EPILOGUE (a step with no
   * enclosing body statement — e.g. the terminal STOP after `continue`), the
   * on-stack variables have already unwound. Walk back within the same frame
   * occurrence (same depth + address) to the last step that IS inside a body
   * statement, where the variables are still live.
   */
  readStep(frame: FrameInfo): number {
    const {steps, model} = this.#trace;
    let j = frame.stepIndex;
    while (
      j > 0 &&
      model.at(j).stmtId === undefined &&
      steps[j - 1]!.depth === frame.depth &&
      this.#addressAt(j - 1) === frame.address
    ) {
      j--;
    }
    return j;
  }

  /**
   * The frame invocation's reference offset between the RUNTIME stack length and
   * the provenance MODEL's stack length. Wherever the static model matches the
   * executed path this offset is constant (it is the caller's share of the
   * stack); the most common offset over the invocation's first located steps is
   * the reference. Memoized per invocation.
   */
  modelReference(frame: FrameInfo, curStep: number): number | undefined {
    const {steps, model} = this.#trace;
    const d = model.at(curStep).combinedDepth;
    let s0 = curStep;
    while (s0 > 0 && model.at(s0 - 1).combinedDepth >= d) s0--;
    const key = `${frame.address}:${s0}:${d}`;
    if (this.#modelRefCache.has(key)) return this.#modelRefCache.get(key);
    const counts = new Map<number, number>();
    let seen = 0;
    for (let j = s0; j <= curStep && seen < 24; j++) {
      if (
        model.at(j).combinedDepth !== d ||
        this.#addressAt(j) !== frame.address
      )
        continue;
      if (steps[j]!.isInitCode) continue;
      const len = variablesAtPc(frame, steps[j]!.pc).find(
        x => x.modelStackLength !== undefined
      )?.modelStackLength;
      if (len === undefined) continue;
      const off = steps[j]!.stack.length - len;
      counts.set(off, (counts.get(off) ?? 0) + 1);
      seen++;
    }
    let ref: number | undefined;
    let best = 0;
    for (const [off, n] of counts) if (n > best) [ref, best] = [off, n];
    // Only memoize a settled reference (enough samples), else recompute later.
    if (seen >= 24 || curStep - s0 > 5000) this.#modelRefCache.set(key, ref);
    return ref;
  }

  /** Whether `v`'s model-derived location is consistent with the trace at `step`. */
  modelMatches(
    v: ResolvedVariable,
    step: number,
    modelRef: number | undefined
  ): boolean {
    if (v.modelStackLength === undefined || modelRef === undefined) return true;
    return (
      this.#trace.steps[step]!.stack.length - v.modelStackLength === modelRef
    );
  }

  /** No statement writing `v` ran in this frame invocation before `curStep`. */
  unwrittenSinceEntry(
    frame: FrameInfo,
    cu: CompilationUnit,
    v: ResolvedVariable,
    curStep: number
  ): boolean {
    if (v.declId === undefined) return false;
    const {model} = this.#trace;
    const d = model.at(curStep).combinedDepth;
    for (let j = curStep - 1, n = 0; j >= 0; j--, n++) {
      if (n > 50000) return false; // too long to prove — don't guess
      const m = model.at(j);
      if (m.combinedDepth < d) return true; // reached the frame's entry
      if (m.combinedDepth > d || this.#addressAt(j) !== frame.address) continue;
      if (m.stmtId !== undefined && statementWrites(cu, m.stmtId, v.declId)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Whether the live stack slot `v.pointer` names at `curStep` holds a value
   * produced BEFORE the start of `v`'s last write in this frame invocation — i.e.
   * a leftover copy of an OLD value (value numbering names values, not variables,
   * so after `x = …` / `x -= …` a surviving copy of x's previous value may still
   * be named `x`). Decided from the trace: the slot's value is followed backward
   * through DUP (copy source) / SWAP (move) to the step that produced it.
   */
  isStaleCopy(frame: FrameInfo, v: ResolvedVariable, curStep: number): boolean {
    const declId = v.declId;
    const cu = frame.cu;
    const ptr = v.pointer as {location?: string; slot?: number} | undefined;
    if (declId === undefined || cu === undefined || ptr?.location !== 'stack')
      return false;
    if (typeof ptr.slot !== 'number') return false;
    const write = this.#lastWrite(frame, cu, declId, curStep);
    if (write === undefined) return false;
    const {start, end, compound} = write;
    const {steps} = this.#trace;
    const evmDepth = steps[curStep]!.depth;
    // Follow the slot's value back through its lineage (DUP = copy of a source
    // slot, SWAP = move). The variable's current value was produced OR copied
    // while its last write executed; a leftover copy of an OLD value never
    // touches that span. (A plain "produced after the write" test is wrong: a
    // write may copy an existing value, e.g. `lo = a` returning a parameter.)
    //
    // A COMPOUND write (`x -= e`, `x++`) always computes a FRESH value inside the
    // statement, so only a value PRODUCED during it can be x's; shuffles (DUP/
    // SWAP) of older values during the statement prove nothing. A PLAIN write
    // (`x = e`, a declaration) may just copy an existing value (`lo = a`), so
    // there being copied/moved during the write counts as current.
    let i = steps[curStep]!.stack.length - 1 - ptr.slot; // absolute index from bottom
    const inWrite = (j: number): boolean => j >= start && j <= end;
    for (let j = curStep - 1; j >= start; j--) {
      const st = steps[j]!;
      if (st.depth !== evmDepth) continue; // an external sub-call's own stack
      const after = steps[j + 1]!.stack.length;
      const len = st.stack.length;
      const op = st.op;
      if (op.startsWith('DUP')) {
        if (i === after - 1) {
          if (inWrite(j) && !compound) return false; // copied during the write ⇒ current
          i = len - Number(op.slice(3)); // a later copy: follow its source
        }
        continue;
      }
      if (op.startsWith('SWAP')) {
        const n = Number(op.slice(4));
        const touched = i === len - 1 || i === len - 1 - n;
        if (touched && inWrite(j) && !compound) return false; // moved into place by the write
        if (i === len - 1) i = len - 1 - n;
        else if (i === len - 1 - n) i = len - 1;
        continue;
      }
      if (i === after - 1 && after > 0 && !NO_RESULT_OPS.has(op)) {
        // Produced during the write ⇒ current; produced after it ⇒ not a value
        // the write gave the variable (a mis-named slot) ⇒ treat as stale.
        return !inWrite(j);
      }
      if (i >= after) return false; // defensive: index out of range
    }
    return true; // lineage predates the write ⇒ an OLD value's copy
  }

  /**
   * The step span `[start, end]` of the last execution of a statement writing
   * `declId` in this frame invocation before `curStep`, and whether it is a
   * compound update.
   */
  #lastWrite(
    frame: FrameInfo,
    cu: CompilationUnit,
    declId: number,
    curStep: number
  ): {start: number; end: number; compound: boolean} | undefined {
    const {steps, model} = this.#trace;
    const d = model.at(curStep).combinedDepth;
    let start: number | undefined;
    let end: number | undefined;
    let stmt: number | undefined;
    let didWork = false;
    for (let j = curStep - 1, n = 0; j >= 0 && n < 50000; j--, n++) {
      const m = model.at(j);
      if (m.combinedDepth < d) break; // left this invocation
      if (this.#addressAt(j) !== frame.address) continue;
      if (m.combinedDepth > d) {
        if (stmt !== undefined) didWork = true; // a call made by the write
        continue;
      }
      if (stmt !== undefined && m.stmtId === stmt) {
        start = j; // extend back to the span's first step
        if (!isShuffleOp(steps[j]!.op)) didWork = true;
        continue;
      }
      if (m.stmtId === undefined) continue;
      if (stmt !== undefined) {
        // The span ended. viaIR hoists single instructions of a statement ahead
        // of it (a `PUSH <label>` attributed to `x -= …`): a span that did no real
        // work is such a fragment, not the write having run — keep looking.
        if (didWork) break;
        stmt = start = end = undefined;
      }
      if (statementWrites(cu, m.stmtId, declId)) {
        stmt = m.stmtId;
        start = end = j;
        didWork = !isShuffleOp(steps[j]!.op);
      }
    }
    if (stmt === undefined || !didWork) return undefined;
    return {
      start: start!,
      end: end!,
      compound: statementWriteKind(cu, stmt, declId) === 'compound',
    };
  }

  /**
   * Candidate earlier locations of a param/local `name` that is in scope at
   * `curStep` but has no live location there (its slot was freed or reused),
   * most recent first. Scans backward — bounded to the current frame invocation
   * via the stepping model's `combinedDepth` (a step SHALLOWER than the frame's
   * own level ends the invocation; a DEEPER one is a sub-call, skipped) and the
   * frame's address — for steps where `variablesAt` gives `name` a concrete
   * SCALAR location (a value-type pointer, or a memory string/bytes layout the
   * caller may still fail to decode). Ends at a write to the variable (an older
   * value is superseded, not merely stale) or at a COMPLEX reference type
   * (struct/array — shown only while live). NEVER yields the current step, so a
   * value read is always one the variable genuinely held.
   */
  *earlierLocations(
    frame: FrameInfo,
    cu: CompilationUnit,
    name: string,
    curStep: number,
    modelRef: number | undefined
  ): Generator<Location> {
    const {steps, model} = this.#trace;
    const frameDepth = model.at(curStep).combinedDepth;
    let declId: number | undefined;
    const writes = (stmtId: number | undefined): boolean =>
      declId !== undefined &&
      stmtId !== undefined &&
      statementWrites(cu, stmtId, declId);
    for (let j = curStep - 1; j >= 0; j--) {
      const m = model.at(j);
      if (m.combinedDepth < frameDepth) return; // returned out of this invocation
      if (m.combinedDepth > frameDepth) continue; // inside a sub-call
      if (this.#addressAt(j) !== frame.address) continue;
      if (steps[j]!.isInitCode) continue; // init code: not modelled
      // Never reach back ACROSS a write to the variable.
      if (writes(m.stmtId)) return;
      const v = variablesAtPc(frame, steps[j]!.pc).find(
        x => x.name === name && isFrameLocal(x)
      );
      if (v === undefined) continue;
      if (declId === undefined && v.declId !== undefined) {
        // First sighting (the scan starts where the variable is in scope but
        // unlocated): from here on, watch for writes — and check this step too.
        declId = v.declId;
        if (writes(m.stmtId)) return;
      }
      if (v.members !== undefined || v.array !== undefined) return;
      if (v.bytes !== undefined) {
        yield {v, step: j};
        continue;
      }
      if (v.pointer === undefined) continue; // present but unlocated here too
      if (!this.modelMatches(v, j, modelRef)) continue; // model off this path here
      if (this.isStaleCopy(frame, v, j)) continue; // an old value's copy, not v
      yield {v, step: j};
    }
  }
}
