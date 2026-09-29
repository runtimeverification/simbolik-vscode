/**
 * Call-stack reconstruction at a stop: the EVM-depth frames, each expanded into
 * its internal-function (and modifier) sub-frames, plus synthetic frames for a
 * cheatcode call.
 */
import type {AstNode, CompilationUnit, Contract} from '@simbolik/solc';

import {decodeCheatcodeCall, isCheatcodeCall} from './cheatcodes.js';
import {resolvePosition, type ResolvedPosition} from './contractAnalysis.js';
import {addressHex, strip0x} from './hex.js';
import type {StepResolution, Stop} from './stepping.js';
import type {Trace} from './trace.js';

/**
 * Whether a frame is a raw EVM-depth frame (`'evm'`), a reconstructed
 * internal-function sub-frame (`'internal'`), or a Solidity MODIFIER body frame
 * (`'modifier'`, named after its ModifierDefinition). A `'cheatcode'` frame is a
 * synthetic TOP frame for a cheatcode CALL: its name is the decoded invocation
 * and it has NO Solidity function of its own (non-descendable). A `'foreign'`
 * frame runs code we cannot attribute to any compilation unit (etched raw
 * bytecode, an unknown callee): it has NO `contract`/`cu`, no Solidity source,
 * an address-derived `name`, and is non-descendable.
 */
export type FrameKind =
  | 'evm'
  | 'internal'
  | 'modifier'
  | 'cheatcode'
  | 'foreign';

/** A reconstructed stack frame at the current step. */
export interface FrameInfo {
  /** Distinct DAP frame id. */
  id: number;
  /** 1-based EVM depth of this frame. */
  depth: number;
  /** Lowercase hex address of the running contract. */
  address: string;
  /** The resolved contract, or `undefined` for a FOREIGN frame. */
  contract: Contract | undefined;
  /** The resolved compilation unit, or `undefined` for a FOREIGN frame. */
  cu: CompilationUnit | undefined;
  optimized: boolean;
  /** Trace step index this frame is positioned at (top = current; parent = CALL site). */
  stepIndex: number;
  /** Resolved source path of the frame's current position. */
  path: string;
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
  /** Resolved function name (or contract name fallback). */
  name: string;
  /** The FunctionDefinition AST node for the frame, when resolved. */
  fnNode: AstNode | undefined;
  kind: FrameKind;
}

/** Whether a frame has Solidity context (a contract + CU) at all. */
export function isSolidityFrame(
  frame: FrameInfo
): frame is FrameInfo & {contract: Contract; cu: CompilationUnit} {
  return frame.contract !== undefined && frame.cu !== undefined;
}

/** A frame standing for `resolution`'s contract at `address`, at `stepIndex`. */
export function contractFrame(
  id: number,
  address: string,
  resolution: StepResolution,
  stepIndex: number
): FrameInfo {
  return {
    id,
    depth: 0,
    address,
    contract: resolution.contract,
    cu: resolution.cu,
    optimized: resolution.optimized,
    stepIndex,
    path: resolution.contract.sourcePath,
    line: 0,
    column: 1,
    name: resolution.contract.name,
    fnNode: undefined,
    kind: 'evm',
  };
}

/** Whether step `j` runs in the same EVM frame occurrence as `depth` + `address`. */
function inFrame(
  trace: Trace,
  j: number,
  depth: number,
  address: string
): boolean {
  const s = trace.steps[j]!;
  return s.depth === depth && addressHex(s.codeAddress) === address;
}

/** The source position of step `i` against `resolution`'s contract. */
function positionAt(
  trace: Trace,
  resolution: StepResolution,
  i: number
): ResolvedPosition | undefined {
  const s = trace.steps[i]!;
  return resolvePosition(
    resolution.contract,
    resolution.cu,
    s.pc,
    s.isInitCode
  );
}

/**
 * The frames at `stop`, BOTTOM-first (outermost first).
 *
 * Folds the trace up to the stop, maintaining a frame stack indexed by EVM
 * depth: each step overwrites `frame[depth-1]`, pushing on depth increase and
 * popping on decrease. The parent frames retain their last step — the CALL site
 * — because only the deepest frame is rewritten per step.
 */
export function reconstructFrames(trace: Trace, stop: Stop): FrameInfo[] {
  const {steps, model} = trace;
  const {step} = stop;

  // The code address is constant within a call frame, so the (costly) address
  // string is only formatted when the depth changes.
  const stack: {address: string; stepIndex: number; depth: number}[] = [];
  let prevDepth = -1;
  for (let i = 0; i <= step && i < steps.length; i++) {
    const depth = steps[i]!.depth;
    if (depth === prevDepth) {
      stack[depth - 1]!.stepIndex = i;
      continue;
    }
    prevDepth = depth;
    stack[depth - 1] = {
      address: addressHex(steps[i]!.codeAddress),
      stepIndex: i,
      depth,
    };
    stack.length = depth; // pop any frames deeper than the current depth
  }

  // Expand EVERY EVM frame into its internal-function sub-frames (constant-
  // EVM-depth JUMPs). A parent frame is replayed up to its CALL site, so its
  // innermost sub-frame sits at the call. Expanding only the innermost frame
  // collapsed the caller's internal call chain into one frame while a subcall
  // ran, and re-expanded it on return — so returning from an external call
  // looked like entering several frames at once. On any inconsistency the
  // reconstruction returns undefined and that depth falls back to a single
  // EVM frame.
  const frames: FrameInfo[] = [];
  let id = 1;
  for (const f of stack) {
    const subFrames = internalFrames(
      trace,
      f.depth,
      f.address,
      f.stepIndex
    ) ?? [{stepIndex: f.stepIndex, kind: 'evm' as const}];
    for (const sub of subFrames) {
      frames.push(
        buildFrame(trace, f.depth, f.address, sub.stepIndex, id++, sub.kind)
      );
    }
  }

  // A frame in a call-first entry's header-mapped run (no statement starts
  // before the body's first call) shows the body's first statement.
  for (let k = 0; k < frames.length; k++) {
    const pos = model.entryRunPosition(frames[k]!.stepIndex);
    if (pos !== undefined) frames[k] = atPosition(frames[k]!, pos);
  }

  // Before a modifier: the modified function's frame, positioned on the
  // modifier's invocation in its header (the modifier frame isn't entered yet).
  const modEntry = stop.beforeModifier ? model.modifierEntry(step) : undefined;
  if (modEntry !== undefined) {
    if (frames.at(-1)?.kind === 'modifier') frames.pop();
    const top = frames.at(-1);
    if (top !== undefined && top.fnNode?.id === modEntry.fn.id) {
      frames[frames.length - 1] = atPosition(top, modEntry);
    }
  }

  // A cheatcode runs as an atomic, self-contained CALL with no descendable
  // sub-trace. When the CURRENT step is one, surface it as a synthetic TOP frame
  // labelled with the decoded invocation, sharing the innermost real frame's
  // source position (the call site).
  const current = steps[step];
  const innermost = frames.at(-1);
  if (
    current !== undefined &&
    innermost !== undefined &&
    isCheatcodeCall(current)
  ) {
    const decoded = decodeCheatcodeCall(current, trace.cursor.at(step));
    frames.push({
      ...innermost,
      id: id++,
      name: decoded !== undefined ? `vm.${decoded.display}` : 'vm.cheatcode',
      fnNode: undefined,
      kind: 'cheatcode',
    });
  }
  return frames;
}

/** `frame` repositioned to a 0-based-column source position. */
function atPosition(
  frame: FrameInfo,
  pos: {path: string; line: number; col: number}
): FrameInfo {
  return {...frame, path: pos.path, line: pos.line, column: pos.col + 1};
}

type SubFrame = {stepIndex: number; kind: 'internal' | 'modifier'};

/**
 * Reconstruct the internal-function sub-frames of an EVM frame by replaying
 * its current occurrence `[evmEntryStep..cur]` (`cur` is the current step for
 * the innermost frame, the CALL site for a parent). Returns a bottom-first
 * array of per-frame step indices (parents at their call site, innermost at the
 * current step), or `undefined` to signal a fail-safe fallback to the single
 * EVM frame. Never throws.
 *
 * A genuine internal-function ENTRY is a JUMPDEST landing (a step whose
 * predecessor at this EVM depth had source-map `jump:'i'`) whose enclosing scope
 * is a `FunctionDefinition`. The FIRST entry establishes the base frame (the
 * entry function itself, via the dispatcher's jump-in). A RETURN is a landing
 * whose predecessor had `jump:'o'` → pop. Landings inside a modifier body (or
 * unmapped) resolve to no `FunctionDefinition` and are NOT pushed. Underflow
 * below the base triggers the fallback.
 */
function internalFrames(
  trace: Trace,
  depth: number,
  address: string,
  cur: number
): SubFrame[] | undefined {
  const {steps, model} = trace;
  // A FOREIGN frame has no contract/CU, so there is nothing to reconstruct.
  const resolution = trace.registry.contractAt(address);
  if (resolution === undefined) return undefined;

  // The current EVM occurrence began just after the last step shallower than
  // this depth (step 0 for a single-EVM-depth trace).
  let evmEntryStep = 0;
  for (let i = cur; i >= 0; i--) {
    if (steps[i]!.depth < depth) {
      evmEntryStep = i + 1;
      break;
    }
  }

  // A stack over ALL internal jumps (every `jump:'i'` pushes, every `jump:'o'`
  // pops), so it stays balanced across compiler-generated internal routines
  // (ABI en/decoders, allocators) whose landings resolve to NO user function,
  // and across the dispatcher→wrapper→body jumps that map to a function's OWN
  // body. Only `real` entries — a jump into a DIFFERENT user `FunctionDefinition`
  // — become DAP frames; `real:false` entries are "phantoms" that keep the depth
  // honest. A real frame renders at its call site (a parent) or at the current
  // step (the innermost, finalized below).
  // `lastOwn`: the latest step of a real frame that lies in its OWN function —
  // its call site when it calls out. The step just before a call's jump can lie
  // elsewhere (a modifier body; viaIR's function-pointer dispatcher, which maps
  // to the ContractDefinition), where the frame would be named after the contract.
  // `viaModifier`: the call site's step when a MODIFIER body made the call — the
  // modifier then stays on the stack beneath the callee (it is suspended there,
  // not finished) instead of vanishing while the callee runs.
  type Entry = {
    stepIndex: number;
    real: boolean;
    fnId: number;
    lastOwn?: number;
    viaModifier?: number;
    /** Entered without a `jump:'i'` (see the fall-through call below). */
    inline?: boolean;
  };
  const stack: Entry[] = [];
  /** The topmost real frame, whose call site is set when it makes a call. */
  const topReal = (): Entry | undefined => {
    for (let k = stack.length - 1; k >= 0; k--) {
      if (stack[k]!.real) return stack[k];
    }
    return undefined;
  };
  const fnAt = (i: number): AstNode | undefined => {
    const fn = positionAt(trace, resolution, i)?.fnNode;
    return fn?.nodeType === 'FunctionDefinition' ? fn : undefined;
  };
  const defAt = (i: number): AstNode | undefined =>
    positionAt(trace, resolution, i)?.defNode;
  let prevStep = -1;
  let prevJump: 'i' | 'o' | '-' = '-';
  /** The latest step (at this depth) inside a function or modifier. */
  let lastDefStep = -1;

  for (let i = evmEntryStep; i <= cur; i++) {
    // Skip steps inside an external subcall (a deeper EVM frame); their internal
    // jumps belong to that frame, not this one.
    if (steps[i]!.depth !== depth) continue;
    const fn = fnAt(i);
    const caller = topReal();

    if (prevJump === 'i') {
      // `i` is a JUMPDEST landing. A jump into a DIFFERENT user function is a
      // genuine call → a real frame. A landing in the SAME function (the
      // dispatcher→wrapper→body path, or intra-function jumps), a modifier body,
      // a compiler routine, or an unmapped pc → a phantom that only balances the
      // depth.
      if (fn !== undefined && caller?.fnId !== fn.id) {
        if (caller !== undefined) caller.stepIndex = caller.lastOwn ?? prevStep; // call site
        const viaModifier =
          caller !== undefined &&
          lastDefStep >= 0 &&
          defAt(lastDefStep)?.nodeType === 'ModifierDefinition'
            ? lastDefStep
            : undefined;
        stack.push({stepIndex: i, real: true, fnId: fn.id, viaModifier});
      } else {
        stack.push({stepIndex: i, real: false, fnId: fn?.id ?? -1});
      }
    } else if (prevJump === 'o') {
      // A return: pop the matching entry. Nothing to pop → inconsistency.
      if (stack.length === 0) return undefined;
      stack.pop();
    } else if (
      caller !== undefined &&
      caller.lastOwn === prevStep &&
      fn !== undefined &&
      fn.id !== caller.fnId
    ) {
      // Straight from the caller's own code into ANOTHER user function without
      // a `jump:'i'`: viaIR calls a function that never returns (one that
      // always reverts) with a plain JUMP, or inlines its body outright. It is
      // still a call — otherwise the callee REPLACED its caller on the stack.
      // Falling back into the frame below (an inlined body that returns)
      // pops it again.
      const below = stack.filter(f => f.real).at(-2);
      if (caller.inline === true && below?.fnId === fn.id) {
        stack.splice(stack.lastIndexOf(caller), 1);
      } else {
        caller.stepIndex = prevStep; // call site
        stack.push({stepIndex: i, real: true, fnId: fn.id, inline: true});
      }
    } else if (caller === undefined && fn !== undefined) {
      // The entry function is reached from the dispatcher WITHOUT a `jump:'i'`,
      // so seed the base frame from the first step whose enclosing scope is a
      // FunctionDefinition (the entry-function body).
      stack.push({stepIndex: i, real: true, fnId: fn.id});
    }

    const owner = topReal();
    if (owner !== undefined && fn?.id === owner.fnId) owner.lastOwn = i;
    if (defAt(i) !== undefined) lastDefStep = i;
    prevStep = i;
    prevJump = model.at(i).jump;
  }

  // Materialize the real frames (bottom-first). No base established → the
  // single-EVM-frame fallback.
  const real = stack.filter(f => f.real);
  if (real.length === 0) return undefined;
  /** Bottom-first frames, with each calling modifier beneath its callee. */
  const materialize = (): SubFrame[] =>
    real.flatMap((f): SubFrame[] => [
      ...(f.viaModifier !== undefined
        ? [{stepIndex: f.viaModifier, kind: 'modifier' as const}]
        : []),
      {stepIndex: f.stepIndex, kind: 'internal'},
    ]);

  // If the CURRENT step sits inside a ModifierDefinition body (an INLINE
  // modifier — no jump:'i'/'o', the only signal is the AST climb), materialize
  // a MODIFIER frame ON TOP of the function it decorates, leaving the function
  // frame at its call site. Suspend/resume fall out for free: at the placeholder
  // `_;` control lands in the function body (no modifier frame); on resume it is
  // back in the ModifierDefinition (the frame is re-emitted).
  //
  // Unmapped compiler-generated helper steps (ABI coders, checked arithmetic,
  // allocators) called from the modifier or function body carry no source
  // position of their own, so walk back over them — within THIS same EVM frame
  // — to the nearest step that resolves to a user def. Without this, a helper
  // called from the modifier body (e.g. the checked-mul for `x * 2`) would drop
  // the modifier frame and mislabel the function frame as the contract.
  let curPos = positionAt(trace, resolution, cur);
  for (
    let j = cur - 1;
    curPos?.defNode === undefined &&
    j >= evmEntryStep &&
    inFrame(trace, j, depth, address);
    j--
  ) {
    curPos = positionAt(trace, resolution, j);
  }
  if (curPos?.defNode?.nodeType === 'ModifierDefinition') {
    return [...materialize(), {stepIndex: cur, kind: 'modifier'}];
  }

  // The innermost frame is positioned at the current step.
  real.at(-1)!.stepIndex = cur;
  return materialize();
}

/** Resolve a single frame's contract + source position (with in-frame fallback). */
function buildFrame(
  trace: Trace,
  depth: number,
  address: string,
  stepIndex: number,
  id: number,
  kind: 'evm' | 'internal' | 'modifier'
): FrameInfo {
  const resolution = trace.registry.contractAt(address);
  if (resolution === undefined)
    return foreignFrame(depth, address, stepIndex, id);
  const {contract, cu, optimized} = resolution;

  // Resolve the position at the frame's pc; if unmapped, walk back within the
  // SAME frame (same depth + address) to the nearest mapped step.
  let pos = positionAt(trace, resolution, stepIndex);
  for (
    let j = stepIndex - 1;
    pos === undefined && j >= 0 && inFrame(trace, j, depth, address);
    j--
  ) {
    pos = positionAt(trace, resolution, j);
  }

  // A constructor (init) frame has no function NAME in the AST, so label it by
  // its contract; a modifier frame is named after its ModifierDefinition (the
  // function-only `fnNode` is undefined inside a modifier body); else the
  // function's own name, falling back to the contract name.
  const fnName = kind === 'modifier' ? pos?.defNode?.name : pos?.fnNode?.name;
  const name = trace.steps[stepIndex]!.isInitCode
    ? `${contract.name}.constructor`
    : fnName !== undefined && fnName !== ''
      ? fnName
      : contract.name;

  return {
    id,
    depth,
    address,
    contract,
    cu,
    optimized,
    stepIndex,
    path: pos?.path ?? contract.sourcePath,
    line: pos?.line ?? 0,
    column: pos !== undefined ? pos.col + 1 : 1,
    name,
    fnNode: pos?.fnNode,
    kind,
  };
}

/**
 * A FOREIGN frame: a NON-descendable EVM-only frame for a code address running
 * bytecode we could not attribute to any compilation unit. It carries NO
 * contract/cu (→ no Solidity `source`) and its name is derived from its CODE
 * ADDRESS, so it is never mis-attributed to the entry contract's source.
 */
function foreignFrame(
  depth: number,
  address: string,
  stepIndex: number,
  id: number
): FrameInfo {
  return {
    id,
    depth,
    address,
    contract: undefined,
    cu: undefined,
    optimized: false,
    stepIndex,
    path: '',
    line: 0,
    column: 1,
    name: foreignFrameName(address),
    fnNode: undefined,
    kind: 'foreign',
  };
}

/** `code @ 0x0000…beef`: an address-derived name, never the entry contract's. */
function foreignFrameName(address: string): string {
  const hex = strip0x(address);
  const short =
    hex.length > 8 ? `0x${hex.slice(0, 4)}…${hex.slice(-4)}` : `0x${hex}`;
  return `code @ ${short}`;
}
