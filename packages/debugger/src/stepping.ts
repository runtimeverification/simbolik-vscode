/**
 * The client-side stepping model.
 *
 * kontrol-node is an EAGER whole-trace tracer, so every stepping operation is a
 * pure walk over the known `Step[]` using source-map-derived per-step metadata.
 * This module precomputes that metadata once per launch and exposes the
 * target-finding functions the DAP session consumes.
 *
 * The precompute is PER-STEP-CONTRACT-AWARE: a single trace can span
 * multiple compilation units (an external CALL runs the callee's code), so each
 * step is resolved to its own `{contract, cu}` via a caller-supplied resolver and
 * its source position is read against THAT contract's runtime source map and CU
 * (fileIds are per-CU, not globally 0). Optimized frames additionally fall back
 * to LINE-based stepping (statement identity is unreliable under optimization).
 *
 * The load-bearing subtleties:
 * - `combinedDepth(i) = step.depth + jumpDepthBefore(i)`, where the source-map
 *   jump flag of step i (`'i'`→+1, `'o'`→-1) is applied *after* step i, so the
 *   JUMPDEST landing carries the incremented depth. This captures Solidity
 *   INTERNAL calls, which are plain JUMPs at constant EVM depth.
 * - `isStmtStart(i)` compares against the most recent EARLIER step (in trace
 *   order, skipping unmapped steps) that had a defined `stmtId` — NOT the
 *   bytecode-adjacent instruction — so re-entering a statement after a nested
 *   one counts as a fresh start.
 */
import type {StateCursor} from '@simbolik/lifting';
import {
  closestFunctionOrModifier,
  closestStatement,
  type AstNode,
  type CompilationUnit,
  type Contract,
  type Jump,
} from '@simbolik/solc';

import {mapPc} from './contractAnalysis.js';

/** The compilation unit + contract a single trace step executes in. */
export interface StepResolution {
  contract: Contract;
  cu: CompilationUnit;
  optimized: boolean;
}

/** Resolve which contract/CU a trace step at `index` executes in. */
export type StepResolver = (index: number) => StepResolution | undefined;

/** Precomputed stepping metadata for a single trace step. */
export interface StepMeta {
  /** 1-based source line (resolved CU), or undefined for unmapped/foreign steps. */
  line: number | undefined;
  /** 0-based source column (resolved CU), or undefined. */
  col: number | undefined;
  /** Resolved source path (the step's own CU), or undefined. */
  path: string | undefined;
  /** closestStatement AST id, or undefined when unresolved. */
  stmtId: number | undefined;
  /** EVM depth + folded Solidity jump depth. */
  combinedDepth: number;
  /**
   * The source-map jump flag of THIS step's executing instruction (`'i'` into a
   * function/modifier, `'o'` out of one, `'-'` neither). Read-only metadata used
   * by internal-frame reconstruction; the fold above is unchanged.
   */
  jump: Jump;
  /** Raw EVM call depth (no folded internal jumps) — for instruction stepping. */
  depth: number;
  /** Whether this step begins a new statement (a valid stop candidate). */
  isStmtStart: boolean;
  /** Whether this step begins a new (path, line) run (optimized-frame stops). */
  isLineStart: boolean;
  /** Whether the resolved contract's CU was compiled with the optimizer. */
  optimized: boolean;
  /**
   * Whether the resolved CU was compiled with `--via-ir`. The out-of-order
   * straight-line SETUP artifact ({@link #isBackwardSetupArtifact}) is a viaIR
   * codegen phenomenon, so that heuristic is gated on this flag and never runs on
   * classic (legacy) codegen.
   */
  viaIR: boolean;
  /** Whether this step's opcode is a control-transfer (`JUMP`/`JUMPI`). */
  isJump: boolean;
  /** Whether this step's opcode is a `JUMPDEST`. */
  isJumpdest: boolean;
  /** Whether this step's opcode is a `PUSHn`. */
  isPush: boolean;
  /**
   * `[start, end)` source range + path of this step's statement (for source-order
   * and containment tests), or undefined.
   */
  stmtRange: {path: string; start: number; end: number} | undefined;
  /** The statement's AST node type (e.g. `IfStatement`), or undefined. */
  stmtType: string | undefined;
  /** A `jump:'o'` out of a USER function (not the dispatcher / a contract-level routine). */
  returnsFromUser: boolean;
  /** viaIR: mapped to a function/modifier HEADER (its parameter/return lists). */
  inHeader: boolean;
  /** viaIR: the landing step of a `jump:'i'` that maps to the callee's definition. */
  fnEntry: boolean;
  /** Mapped to a modifier's `_;` (PlaceholderStatement). */
  placeholder: boolean;
  /** AST id of the enclosing FunctionDefinition/ModifierDefinition, if mapped. */
  defId: number | undefined;
}

/** Whether `node` lies in a function/modifier's parameter or return list. */
function inParameterList(node: AstNode): boolean {
  for (let c: AstNode | undefined = node; c !== undefined; c = c.parent()) {
    const t = c.nodeType;
    if (t === 'ParameterList') return true;
    if (
      t === 'Block' ||
      t === 'FunctionDefinition' ||
      t === 'ModifierDefinition' ||
      t === 'ContractDefinition' ||
      t === 'SourceUnit'
    ) {
      return false;
    }
  }
  return false;
}

/**
 * A stop position: a trace step, or — when `beforeModifier` — the moment just
 * BEFORE that step, where it begins a modifier's execution. The latter shows the
 * modified function's frame positioned on the modifier's invocation in its
 * header, so stepping into a modified function enters one frame at a time: the
 * function (at its first modifier), then each modifier, then the body.
 */
export interface Stop {
  step: number;
  beforeModifier: boolean;
}

/** A step that begins executing one of a function's modifiers. */
export interface ModifierEntry {
  /** The modified FunctionDefinition. */
  fn: AstNode;
  /** The `ModifierInvocation` in `fn`'s header being executed. */
  invocation: AstNode;
  /** Source path, 1-based line and 0-based column of the invocation. */
  path: string;
  line: number;
  col: number;
}

/**
 * Modifier-entry detection, per combinedDepth level (a function and its
 * modifiers share one level): the level's current function and the index of
 * the last of its modifier invocations that began. A step entering a modifier
 * whose invocation comes LATER than that is an entry; entering an earlier one is
 * a modifier resuming after its `_;`.
 */
class ModifierEntryDetector {
  readonly #levelFn: (AstNode | undefined)[] = [];
  readonly #levelEntered: number[] = [];
  #prevLevel = 0;
  readonly #invocationsOf = new Map<
    AstNode,
    ReturnType<AstNode['modifierInvocations']>
  >();

  /**
   * Feed the next step (its combinedDepth `level` and enclosing definition);
   * returns the entry when the step begins one of the level's modifiers. With no
   * `cu` (optimized or unresolved code) modifier entries are not detected.
   */
  visit(
    level: number,
    def: AstNode | undefined,
    cu: CompilationUnit | undefined,
  ): ModifierEntry | undefined {
    for (let dd = this.#prevLevel + 1; dd <= level; dd++) {
      this.#levelFn[dd] = undefined;
      this.#levelEntered[dd] = -1;
    }
    this.#prevLevel = level;
    if (def?.nodeType === 'FunctionDefinition') {
      if (this.#levelFn[level] !== def) {
        this.#levelFn[level] = def;
        this.#levelEntered[level] = -1;
      }
      return undefined;
    }
    if (def?.nodeType !== 'ModifierDefinition' || cu === undefined) {
      return undefined;
    }
    const fn = this.#levelFn[level];
    if (fn === undefined) return undefined;
    const entered = this.#levelEntered[level] ?? -1;
    let invocations = this.#invocationsOf.get(fn);
    if (invocations === undefined) {
      invocations = fn.modifierInvocations();
      this.#invocationsOf.set(fn, invocations);
    }
    const k = invocations.findIndex(
      (inv, n) =>
        n > entered && (inv.modifierId === def.id || inv.name === def.name),
    );
    const inv = invocations[k]?.node;
    const invSource = inv !== undefined ? cu.sourceById(inv.srcFileId) : undefined;
    if (inv === undefined || invSource === undefined) return undefined;
    this.#levelEntered[level] = k;
    const pos = invSource.offsetToPosition(inv.srcStart);
    return {
      fn,
      invocation: inv,
      path: invSource.path,
      line: pos.line,
      col: pos.column,
    };
  }
}

/**
 * Precomputes per-step metadata over an entire trace and answers the stepping
 * predicates. Multi-CU aware: each step resolves to its own contract/CU.
 */
export class SteppingModel {
  readonly #meta: StepMeta[];
  /** Modifier entries by step, and their steps in ascending order. */
  readonly #modifierEntries = new Map<number, ModifierEntry>();
  readonly #entrySteps: number[] = [];
  /**
   * viaIR function/modifier entries that are stops although no statement starts
   * there, by step, with the position shown: the body's first statement.
   * See {@link #markCallFirstEntries}.
   */
  readonly #entryStops = new Map<number, {path: string; line: number; col: number}>();
  /** Every step of such an entry's header-mapped run up to its call → that position. */
  readonly #entryRuns = new Map<number, {path: string; line: number; col: number}>();
  /** The terminal (last) step index. */
  readonly last: number;

  constructor(cursor: StateCursor, resolve: StepResolver) {
    const meta: StepMeta[] = new Array(cursor.length);
    /** viaIR function/modifier entry steps + their body's first statement position. */
    const entryCandidates: {
      step: number;
      pos: {path: string; line: number; col: number};
    }[] = [];
    // Internal-function nesting is folded PER RAW-EVM-FRAME, not globally.
    // `frameJumps[d-1]` is the internal-call ('jump:i' minus 'jump:o') depth
    // accrued WITHIN the frame at raw EVM depth `d`; `internalSum` is their total.
    // combinedDepth = rawDepth + internalSum (the full logical call-stack depth).
    // When an external CALL/CREATE returns, its frame is POPPED and its internal
    // jumps are discarded from `internalSum` — so a callee's unbalanced fold
    // cannot leak into the caller. A single global accumulator (the previous
    // design) drifted upward whenever a mapped 'jump:i' had no matching mapped
    // 'jump:o' — which happens constantly on real traces, where unmapped steps
    // (foreign code, unidentified constructor/init code) carry 'jump:-'. That
    // drift inflated later combinedDepths so `next`/`stepOut` (which stop at the
    // first statement with `combinedDepth <= origin`) skipped their target and
    // ran to the terminal step.
    //
    // Each frame keeps a STACK of the weights of its open internal calls, so a
    // 'jump:o' removes exactly what its 'jump:i' added. Under viaIR a modifier is
    // its own Yul function and its `_;` is a 'jump:i' into the function body;
    // those jumps weigh 0 so a modified function's body (and its modifiers) sit
    // at the function's own level — as on legacy, which inlines modifiers.
    // Otherwise `next` from a modifier line would step over the whole body.
    // A 'jump:i' is weighed when its LANDING step is known (it decides whether
    // the jump enters a modifier), hence `pendingCall`.
    const frameJumps: number[][] = [];
    let internalSum = 0;
    let pendingCall: {frame: number; weightless: boolean} | undefined;
    let lastDefinedStmtId: number | undefined;
    let lastPath: string | undefined;
    let lastLine: number | undefined;
    const modifierEntries = new ModifierEntryDetector();

    for (let i = 0; i < cursor.length; i++) {
      const st = cursor.at(i);
      const resolution = resolve(i);
      // Sync the frame stack to this step's raw EVM depth (which changes by at
      // most 1 per step). Growing pushes fresh frames at internal-depth 0; a
      // return pops the callee frame(s), discarding their internal-jump fold.
      while (frameJumps.length < st.depth) frameJumps.push([]);
      while (frameJumps.length > st.depth) {
        for (const w of frameJumps.pop()!) internalSum -= w;
      }

      const optimized = resolution?.optimized ?? false;
      const viaIR = resolution?.cu.viaIR() ?? false;

      // A CREATE/CREATE2 frame runs the constructor's INIT code, indexed by the
      // init source map (`isInitCode`), not the runtime map. If the frame's
      // contract wasn't identified (the pc won't be a valid init instruction),
      // the pc does not map and the step stays unmapped — so statement stepping
      // steps OVER an unresolved constructor rather than mis-mapping it (which
      // previously corrupted `combinedDepth`).
      const mapped =
        resolution !== undefined
          ? mapPc(resolution.contract, resolution.cu, st.pc, st.isInitCode)
          : undefined;
      const entry = mapped?.entry;
      const node = mapped?.node;
      const source = mapped?.source;
      const pos = source?.offsetToPosition(entry!.start);
      const line = pos?.line;
      const col = pos?.column;
      const path = source?.path;
      const stmt = node !== undefined ? closestStatement(node) : undefined;
      const stmtId = stmt?.id;

      const def =
        node !== undefined ? closestFunctionOrModifier(node) : undefined;

      // Weigh the previous step's internal call now that its landing is known.
      if (pendingCall !== undefined) {
        const {frame, weightless} = pendingCall;
        pendingCall = undefined;
        const weight =
          weightless || (viaIR && def?.nodeType === 'ModifierDefinition')
            ? 0
            : 1;
        if (frame < frameJumps.length) {
          frameJumps[frame]!.push(weight);
          internalSum += weight;
        }
      }
      const combinedDepth = st.depth + internalSum;

      const modifierEntry = modifierEntries.visit(
        combinedDepth,
        def,
        optimized ? undefined : resolution?.cu,
      );
      if (modifierEntry !== undefined) {
        this.#modifierEntries.set(i, modifierEntry);
        this.#entrySteps.push(i);
      }

      const isStmtStart = stmtId !== undefined && stmtId !== lastDefinedStmtId;
      const isLineStart =
        line !== undefined && (path !== lastPath || line !== lastLine);

      meta[i] = {
        line,
        col,
        path,
        stmtId,
        combinedDepth,
        depth: st.depth,
        jump: entry?.jump ?? '-',
        isStmtStart,
        isLineStart,
        optimized,
        viaIR,
        isJump: st.op === 'JUMP' || st.op === 'JUMPI',
        isJumpdest: st.op === 'JUMPDEST',
        isPush: st.op.startsWith('PUSH'),
        stmtRange:
          stmt !== undefined && path !== undefined
            ? {path, start: stmt.srcStart, end: stmt.srcStart + stmt.srcLength}
            : undefined,
        stmtType: stmt?.nodeType,
        returnsFromUser:
          entry?.jump === 'o' &&
          node !== undefined &&
          node.nodeType !== 'ContractDefinition',
        inHeader: viaIR && node !== undefined && inParameterList(node),
        fnEntry:
          viaIR &&
          i > 0 &&
          meta[i - 1]!.jump === 'i' &&
          (node?.nodeType === 'FunctionDefinition' ||
            node?.nodeType === 'ModifierDefinition'),
        placeholder: stmt?.nodeType === 'PlaceholderStatement',
        defId: def?.id,
      };

      if (meta[i]!.fnEntry && def !== undefined && resolution !== undefined) {
        const body = def.children().find((c) => c.nodeType === 'Block');
        const first = body?.children()[0];
        const src =
          first !== undefined ? resolution.cu.sourceById(first.srcFileId) : undefined;
        if (first !== undefined && src !== undefined) {
          const p = src.offsetToPosition(first.srcStart);
          entryCandidates.push({
            step: i,
            pos: {path: src.path, line: p.line, col: p.column},
          });
        }
      }

      if (stmtId !== undefined) {
        lastDefinedStmtId = stmtId;
      }
      if (line !== undefined) {
        lastPath = path;
        lastLine = line;
      }
      // Fold this step's jump into the CURRENT frame AFTER recording its depth,
      // so the landing step (not the JUMP itself) carries the changed depth. A
      // 'jump:o' is clamped at 0 so a frame that returns more than it entered
      // (e.g. a 'jump:o' whose matching 'jump:i' was unmapped) cannot go negative.
      if (entry !== undefined && frameJumps.length > 0) {
        const top = frameJumps.length - 1;
        if (entry.jump === 'i') {
          // `_;` (a PlaceholderStatement) enters the modified function's body.
          pendingCall = {
            frame: top,
            weightless: viaIR && node?.nodeType === 'PlaceholderStatement',
          };
        } else if (entry.jump === 'o' && frameJumps[top]!.length > 0) {
          internalSum -= frameJumps[top]!.pop()!;
        }
      }
    }

    this.#meta = meta;
    this.last = meta.length - 1;
    if (meta.some((m) => m.viaIR)) {
      this.#dropHoistedPushes();
      this.#restorePrologueStarts();
    }
    this.#dropCompoundJoins();
    this.#markCallFirstEntries(entryCandidates);
  }

  /**
   * viaIR hoists single `PUSHn <return label>` instructions ahead of a call and
   * attributes each to a LATER statement. Such a one-step PUSH whose next step is
   * a different statement is not that statement's start (it would bounce the
   * walk between lines / show them out of order), and must not count as the
   * statement having begun. Recomputes `isStmtStart` accordingly.
   */
  #dropHoistedPushes(): void {
    const meta = this.#meta;
    let lastStmt: number | undefined;
    for (let i = 0; i < meta.length; i++) {
      const m = meta[i]!;
      const next = meta[i + 1];
      const hoisted =
        m.viaIR &&
        m.isPush &&
        m.stmtId !== undefined &&
        m.stmtId !== lastStmt &&
        next !== undefined &&
        next.stmtId !== m.stmtId;
      if (hoisted) {
        m.isStmtStart = false;
        continue;
      }
      m.isStmtStart = m.stmtId !== undefined && m.stmtId !== lastStmt;
      if (m.stmtId !== undefined) lastStmt = m.stmtId;
    }
  }

  /**
   * viaIR function prologue: on entry the first body statement often gets a
   * one-step mark, then the header code runs (parameter/return declarations, a
   * zero-init helper), and only then the statement really starts. The mark is
   * discarded as a blip, but it already made the real start "not new", so the
   * function's first statement — or a one-statement helper entirely — got no
   * stop. After each entry, clear starts up to the last header step and force a
   * start on the first statement step after it.
   */
  #restorePrologueStarts(): void {
    const meta = this.#meta;
    for (let e = 0; e < meta.length; e++) {
      if (!meta[e]!.fnEntry) continue;
      const d = meta[e]!.combinedDepth;
      let headerEnd = -1;
      for (let k = e + 1; k < meta.length; k++) {
        const m = meta[k]!;
        if (m.combinedDepth < d) break;
        if (m.combinedDepth > d) {
          if (m.stmtId !== undefined) break; // a real sub-call, not a helper
          continue;
        }
        if (m.jump === 'o') break;
        if (m.inHeader) headerEnd = k;
      }
      if (headerEnd < 0) continue;
      for (let k = e + 1; k <= headerEnd; k++) {
        if (meta[k]!.combinedDepth === d) meta[k]!.isStmtStart = false;
      }
      for (let k = headerEnd + 1; k < meta.length; k++) {
        const m = meta[k]!;
        if (m.combinedDepth < d) break;
        if (m.combinedDepth === d && m.stmtId !== undefined) {
          m.isStmtStart = true;
          break;
        }
      }
    }
  }

  /**
   * After a branch/loop body, the join code is mapped to the WHOLE enclosing
   * `if`/`for`/`while`, which made the walk climb back up an if/else-if chain
   * and stop on a `for` header several times per iteration. A compound
   * statement's step is a stop only when entered from OUTSIDE it — not when the
   * frame's previous statement lies inside it.
   */
  #dropCompoundJoins(): void {
    const meta = this.#meta;
    const lastAt: (number | undefined)[] = [];
    let prevDepth = 0;
    for (let i = 0; i < meta.length; i++) {
      const m = meta[i]!;
      const d = m.combinedDepth;
      // Entering a deeper frame: stale statements of earlier calls at those
      // depths must not count as "previous".
      for (let dd = prevDepth + 1; dd <= d; dd++) lastAt[dd] = undefined;
      prevDepth = d;
      if (m.stmtId === undefined) continue;
      if (
        m.isStmtStart &&
        (m.stmtType === 'IfStatement' ||
          m.stmtType === 'ForStatement' ||
          m.stmtType === 'WhileStatement' ||
          m.stmtType === 'DoWhileStatement')
      ) {
        const p = lastAt[d] === undefined ? undefined : meta[lastAt[d]!]!;
        const r = m.stmtRange;
        const pr = p?.stmtRange;
        if (
          p !== undefined &&
          p.stmtId !== m.stmtId &&
          r !== undefined &&
          pr !== undefined &&
          pr.path === r.path &&
          pr.start >= r.start &&
          pr.end <= r.end
        ) {
          m.isStmtStart = false;
        }
      }
      lastAt[d] = i;
    }
  }

  /**
   * viaIR maps a function's (or modifier's) code up to its first call to the
   * definition's HEADER, so when the body starts with a call — `f(); …`,
   * `modifier m() { check(); _; }` — no statement starts before the callee's, and
   * the first stop after entering lies INSIDE the callee: step-into (and the
   * launch stop) entered two frames at once. Such an entry step becomes a stop
   * itself, shown at the body's first statement.
   */
  #markCallFirstEntries(
    candidates: {step: number; pos: {path: string; line: number; col: number}}[],
  ): void {
    for (const {step: e, pos} of candidates) {
      const d = this.#meta[e]!.combinedDepth;
      for (let j = e; j <= this.last; j++) {
        const m = this.#meta[j]!;
        if (m.combinedDepth < d) break; // returned without a stop
        if (m.isStmtStart && this.#persists(j)) {
          if (m.combinedDepth > d) {
            this.#entryStops.set(e, pos);
            for (let k = e; k < j && this.#meta[k]!.combinedDepth === d; k++) {
              this.#entryRuns.set(k, pos);
            }
          }
          break;
        }
      }
    }
  }

  /** Whether step `j` is a statement-granular stop candidate. */
  #isStop(j: number): boolean {
    return (
      (this.#meta[j]!.isStmtStart && this.#persists(j)) ||
      this.#entryStops.has(j)
    );
  }

  /**
   * The position a frame at `step` shows when `step` lies in a call-first
   * entry's header-mapped run (see {@link #markCallFirstEntries}): the body's
   * first statement — also as the call site while the callee runs.
   */
  entryRunPosition(
    step: number,
  ): {path: string; line: number; col: number} | undefined {
    return this.#entryRuns.get(step);
  }

  /** Metadata for `index`. */
  at(index: number): StepMeta {
    return this.#meta[index]!;
  }

  /**
   * Whether the statement at `index` reappears at the SAME combinedDepth before
   * that depth changes — i.e. it briefly yielded to another line (viaIR call-arg
   * setup) but resumes and keeps executing, rather than being a one-shot prologue
   * blip. Used to keep `#persists` from discarding a real statement.
   */
  #resumes(index: number): boolean {
    const s = this.#meta[index]!.stmtId;
    const d = this.#meta[index]!.combinedDepth;
    if (s === undefined) return false;
    for (let k = index + 1; k <= this.last; k++) {
      const m = this.#meta[k]!;
      if (m.combinedDepth !== d) return false; // depth changed before it resumed
      if (m.stmtId === s) return true; // resumed at the same depth
    }
    return false;
  }

  readonly #lastInFrame = new Map<number, boolean>();

  /**
   * Whether no OTHER statement starts in the frame of `index` (same
   * combinedDepth) before that frame returns. Memoized.
   */
  #isLastInFrame(index: number): boolean {
    const cached = this.#lastInFrame.get(index);
    if (cached !== undefined) return cached;
    const {combinedDepth: d, stmtId: s} = this.#meta[index]!;
    let last = true;
    for (let k = index + 1; k <= this.last; k++) {
      const m = this.#meta[k]!;
      if (m.combinedDepth < d) break;
      if (m.combinedDepth === d && m.isStmtStart && m.stmtId !== s) {
        last = false;
        break;
      }
    }
    this.#lastInFrame.set(index, last);
    return last;
  }

  /**
   * Whether the statement starting at `index` is REAL execution rather than a
   * compiler entry-prologue artifact. On entering a function, solc emits local-
   * variable initialization code whose source maps point at the declaration/use
   * statements OUT OF SOURCE ORDER — each visited for a single step before control
   * returns to the function-definition line. Those transient visits are marked
   * `isStmtStart` too, so a naive "first statement start" lands on the wrong
   * (often the LAST) source line of the function.
   *
   * A genuine statement's execution STAYS in it (the next step carries the same
   * `stmtId`) or DESCENDS into it (the next step is at a greater combinedDepth);
   * a prologue init is abandoned immediately — the next step is a DIFFERENT
   * statement (or the unmapped function-definition line) at the same-or-shallower
   * combinedDepth. The terminal step is treated as persistent.
   */
  #persists(index: number): boolean {
    if (index >= this.last) return true;
    const cur = this.#meta[index]!;
    const nxt = this.#meta[index + 1]!;
    // viaIR: after returning from a user function, the caller statement may get
    // only a single JUMPDEST step. When that call was the caller's LAST statement,
    // that step is the caller's only remaining stop — discarding it made step-out
    // skip up TWO levels. (If another caller statement follows, the normal guard
    // applies and step-out lands there, as on legacy.) Not for a `_;` landing
    // (the modifier resuming after the function body).
    if (
      cur.viaIR &&
      cur.isStmtStart &&
      index > 0 &&
      this.#meta[index - 1]!.returnsFromUser &&
      !cur.placeholder &&
      this.#isLastInFrame(index)
    ) {
      return true;
    }
    // One-step guard: a single-step out-of-order artifact (the next step is a
    // DIFFERENT statement at the same-or-shallower depth) is abandoned at once —
    // UNLESS the statement RESUMES at the same depth (it does real work after
    // briefly yielding, e.g. a viaIR call statement whose argument setup is
    // attributed to the function-declaration line before the call descends). A
    // genuine prologue blip never resumes; a real statement does.
    if (
      nxt.stmtId !== cur.stmtId &&
      nxt.combinedDepth <= cur.combinedDepth &&
      !this.#resumes(index)
    ) {
      return false;
    }
    // Multi-step guard: a viaIR straight-line SETUP artifact (see below).
    return !this.#isBackwardSetupArtifact(index);
  }

  /**
   * Whether the statement-start at `index` is a viaIR straight-line SETUP
   * artifact rather than the statement's real execution.
   *
   * Under `--via-ir`, solc lays out a function's argument/return-slot setup as one
   * contiguous straight-line block and attributes each little stack-shuffling
   * group (typically bare `PUSH`es) to whichever statement's variables it touches
   * — OUT OF SOURCE ORDER and possibly SEVERAL steps long, so the one-step
   * {@link #persists} guard does not catch it. Concretely, a multi-arg statement's
   * source position is emitted for setup instructions that physically precede an
   * EARLIER statement's real call, then control falls straight through to that
   * earlier statement. Stopping there strands step-into/step-over on a later
   * source line before the real next statement has run.
   *
   * The run of steps that stay in this statement (same `stmtId`) at its own depth
   * is examined: if it ever DESCENDS into a sub-call (a deeper combinedDepth) or
   * the frame RETURNS (a shallower one), the statement does real work and is kept.
   * Otherwise the run is flat; the step that leaves it is the exit. A genuine
   * backward flow (loop back-edge, `continue`) reaches its target via a taken
   * JUMP, so only a FALL-THROUGH (the last run step is not a jump) to an EARLIER
   * statement (a smaller AST id, i.e. earlier in the frame's execution) is the
   * artifact. Forward fall-through (ordinary sequential statements, a loop's
   * final exit test) is real.
   */
  #isBackwardSetupArtifact(index: number): boolean {
    const cur = this.#meta[index]!;
    // This is a viaIR straight-line-setup phenomenon; classic codegen maps
    // statements in source order, so never suppress a legacy step as an artifact.
    if (!cur.viaIR) return false;
    const s = cur.stmtId;
    const d = cur.combinedDepth;
    if (s === undefined) return false;
    for (let j = index + 1; j <= this.last; j++) {
      const m = this.#meta[j]!;
      if (m.combinedDepth > d) return false; // descended into a sub-call
      if (m.combinedDepth < d) return false; // frame returned (last statement)
      if (m.stmtId === s) continue; // still inside this statement's run
      // Reached via a taken jump (the step before is the JUMP/JUMPI, or it is
      // the landing JUMPDEST of one).
      const prev = this.#meta[j - 1]!;
      if (prev.isJump) return false;
      if (prev.isJumpdest && j >= 2 && this.#meta[j - 2]!.isJump) return false;
      // Fall-through to a DIFFERENT statement at the same depth. Under viaIR the
      // argument setup of a CALL statement is attributed alternately to the
      // statement and to its function-declaration line (a smaller AST id) before
      // the call actually descends — so `s` briefly yields to an earlier line and
      // then RESUMES and does its real work (e.g. a 1-line forwarder
      // `x() { y(...); }`). Only a GENUINE blip — one that never resumes in this
      // same-depth run — is a setup artifact. If `s` resumes, keep scanning so the
      // descend/return checks above decide (they will see the real sub-call).
      let resumes = false;
      for (let k = j + 1; k <= this.last; k++) {
        const mk = this.#meta[k]!;
        if (mk.combinedDepth !== d) break;
        if (mk.stmtId === s) {
          resumes = true;
          break;
        }
      }
      if (resumes) continue;
      // Fall-through to an EARLIER statement, by SOURCE position — AST ids are no
      // order (a nested else-if is a child of the outer if, with a smaller id).
      const r = cur.stmtRange;
      const mr = m.stmtRange;
      if (m.stmtId === undefined || r === undefined || mr === undefined) return false;
      return mr.path === r.path ? mr.start < r.start : m.stmtId < s;
    }
    return false;
  }

  /** The first statement-start step (the entry stop after launch). */
  entry(): number {
    for (let i = 0; i <= this.last; i++) {
      if (this.#isStop(i)) return i;
    }
    return 0;
  }

  /**
   * `next` / `stepOver`: skip descents into internal calls. Unoptimized frames
   * use statement identity; optimized frames fall back to line identity —
   * the smallest j>O at or below the origin depth whose (path, line) differs.
   * Transient entry-prologue artifacts (see {@link #persists}) are skipped: solc
   * can emit a later statement's source position for a single step at the
   * caller's own depth BEFORE the real next statement, which would otherwise make
   * step-over jump forward past several statements to that out-of-order line.
   */
  next(origin: number): number {
    const o = this.#meta[origin]!;
    if (o.optimized) {
      for (let j = origin + 1; j <= this.last; j++) {
        const m = this.#meta[j]!;
        if (
          m.isLineStart &&
          m.combinedDepth <= o.combinedDepth &&
          (m.path !== o.path || m.line !== o.line) &&
          this.#persists(j)
        ) {
          return j;
        }
      }
      return this.last;
    }
    for (let j = origin + 1; j <= this.last; j++) {
      const m = this.#meta[j]!;
      if (
        m.combinedDepth <= o.combinedDepth &&
        m.stmtId !== o.stmtId &&
        this.#isStop(j)
      )
        return j;
    }
    return this.last;
  }

  /**
   * Instruction `next` (step-over at instruction granularity): the very next
   * step, EXCEPT that an external subcall (CALL/CREATE — a RAW EVM depth
   * increase) is run to completion. Target = smallest j>O whose raw EVM depth is
   * ≤ the origin's; for a non-call opcode that is simply O+1. Internal Solidity
   * calls are plain JUMPs at constant EVM depth, so — correctly for a disassembly
   * view — they are single-stepped, not stepped over.
   */
  nextInstruction(origin: number): number {
    const d = this.#meta[origin]!.depth;
    for (let j = origin + 1; j <= this.last; j++) {
      if (this.#meta[j]!.depth <= d) return j;
    }
    return this.last;
  }

  /** Instruction `stepOut`: smallest j>O at a shallower RAW EVM depth. */
  stepOutInstruction(origin: number): number {
    const d = this.#meta[origin]!.depth;
    for (let j = origin + 1; j <= this.last; j++) {
      if (this.#meta[j]!.depth < d) return j;
    }
    return this.last;
  }

  /**
   * `stepIn`: smallest j>O that starts a different, REAL statement (any depth).
   * Entry-prologue statement-starts (see {@link #persists}) are skipped, so
   * stepping into a function lands on its first executed statement rather than a
   * variable-init artifact mapped to a later source line.
   */
  stepIn(origin: number): number {
    const {stmtId: s} = this.#meta[origin]!;
    for (let j = origin + 1; j <= this.last; j++) {
      const m = this.#meta[j]!;
      if (m.stmtId !== s && this.#isStop(j)) return j;
    }
    return this.last;
  }

  /**
   * `stepOut`: smallest j>O that starts a REAL statement strictly shallower.
   * Transient entry-prologue artifacts (see {@link #persists}) are skipped.
   */
  stepOut(origin: number): number {
    const {combinedDepth: d} = this.#meta[origin]!;
    for (let j = origin + 1; j <= this.last; j++) {
      const m = this.#meta[j]!;
      if (m.combinedDepth < d && this.#isStop(j)) return j;
    }
    return this.last;
  }

  /**
   * `stepBack`: largest j<O that starts a REAL statement — one forward stepping
   * could stop at (transient artifacts, see {@link #persists}, are skipped); stay
   * at 0 if none.
   */
  stepBack(origin: number): number {
    for (let j = origin - 1; j >= 0; j--) {
      if (this.#isStop(j)) return j;
    }
    return 0;
  }

  // ─── stops (steps + before-modifier positions) ────────────────────────────

  /** The modifier entry at `step`, if that step begins a modifier. */
  modifierEntry(step: number): ModifierEntry | undefined {
    return this.#modifierEntries.get(step);
  }

  /** The first modifier-entry step > `after` passing `accept`, if any. */
  #entryAfter(
    after: number,
    accept: (e: number) => boolean = () => true,
  ): number | undefined {
    for (const e of this.#entrySteps) {
      if (e > after && accept(e)) return e;
    }
    return undefined;
  }

  /** The earlier of a before-modifier stop at `entry` and a step stop at `step`. */
  static #earlier(entry: number | undefined, step: number): Stop {
    return entry !== undefined && entry <= step
      ? {step: entry, beforeModifier: true}
      : {step, beforeModifier: false};
  }

  /** The first real statement stop at or after `from`. */
  #stopFrom(from: number): number {
    for (let j = from; j <= this.last; j++) {
      if (this.#isStop(j)) return j;
    }
    return this.last;
  }

  /** The launch stop: {@link entry}, or an earlier modifier entry. */
  entryStop(): Stop {
    return SteppingModel.#earlier(this.#entryAfter(-1), this.entry());
  }

  /**
   * `stepIn` over stops: the next statement (see {@link stepIn}) or, if one
   * comes first, the next modifier entry. From a before-modifier stop the
   * modifier's own first statement is next.
   */
  stepInStop(o: Stop): Stop {
    const step = o.beforeModifier
      ? this.#stopFrom(o.step)
      : this.stepIn(o.step);
    return SteppingModel.#earlier(this.#entryAfter(o.step), step);
  }

  /**
   * `next` over stops. A modifier entry at or above the origin's depth is a stop
   * (from a modifier's last statement, `next` reaches the following modifier's
   * invocation). From a before-modifier stop, the modifier itself is stepped over:
   * the next stop outside it — the following modifier or the function body.
   */
  nextStop(o: Stop): Stop {
    const d = this.#meta[o.step]!.combinedDepth;
    const shallow = (e: number): boolean => this.#meta[e]!.combinedDepth <= d;
    if (!o.beforeModifier) {
      return SteppingModel.#earlier(
        this.#entryAfter(o.step, shallow),
        this.next(o.step),
      );
    }
    const mod = this.#meta[o.step]!.defId;
    let step = this.last;
    for (let j = o.step + 1; j <= this.last; j++) {
      const m = this.#meta[j]!;
      if (m.combinedDepth <= d && m.defId !== mod && this.#isStop(j)) {
        step = j;
        break;
      }
    }
    return SteppingModel.#earlier(this.#entryAfter(o.step, shallow), step);
  }

  /** `stepOut` over stops (a before-modifier stop is in the function's frame). */
  stepOutStop(o: Stop): Stop {
    return {step: this.stepOut(o.step), beforeModifier: false};
  }

  /** `stepBack` over stops: the latest statement start or modifier entry before `o`. */
  stepBackStop(o: Stop): Stop {
    if (!o.beforeModifier && this.#modifierEntries.has(o.step)) {
      return {step: o.step, beforeModifier: true};
    }
    const step = this.stepBack(o.step);
    let entry: number | undefined;
    for (const e of this.#entrySteps) {
      if (e >= o.step) break;
      entry = e;
    }
    return entry !== undefined && entry > step
      ? {step: entry, beforeModifier: true}
      : {step, beforeModifier: false};
  }

  /** `continue` over stops (from a before-modifier stop, its own step may be armed). */
  continueStop(
    o: Stop,
    breakpoints: ReadonlyMap<string, ReadonlySet<number>>,
  ): Stop {
    if (o.beforeModifier && this.isArmedStop(o.step, breakpoints)) {
      return {step: o.step, beforeModifier: false};
    }
    return {step: this.continue(o.step, breakpoints), beforeModifier: false};
  }

  /**
   * `continue`: smallest j>O that is an armed breakpoint stop; terminal if none.
   * Breakpoints are path-keyed: a step matches only when its RESOLVED source
   * path + line is armed (so a Callee-source line does not match a Caller line).
   */
  continue(origin: number, breakpoints: ReadonlyMap<string, ReadonlySet<number>>): number {
    for (let j = origin + 1; j <= this.last; j++) {
      if (this.isArmedStop(j, breakpoints)) return j;
    }
    return this.last;
  }

  /**
   * `reverseContinue`: largest j<O that is an armed breakpoint stop; step 0 if
   * none.
   */
  reverseContinue(
    origin: number,
    breakpoints: ReadonlyMap<string, ReadonlySet<number>>,
  ): number {
    for (let j = origin - 1; j >= 0; j--) {
      if (this.isArmedStop(j, breakpoints)) return j;
    }
    return 0;
  }

  /**
   * Whether step `index` is a valid breakpoint stop for `breakpoints`: its
   * resolved (path, line) must be armed AND it must be a genuine stop candidate
   * — a statement start for unoptimized frames, or a line start for optimized
   * frames (statement identity is unreliable under optimization).
   */
  isArmedStop(
    index: number,
    breakpoints: ReadonlyMap<string, ReadonlySet<number>>,
  ): boolean {
    const at = this.#entryStops.get(index);
    if (at !== undefined) return breakpoints.get(at.path)?.has(at.line) ?? false;
    const m = this.#meta[index]!;
    if (m.path === undefined || m.line === undefined) return false;
    if (!(breakpoints.get(m.path)?.has(m.line) ?? false)) return false;
    return m.optimized ? m.isLineStart : m.isStmtStart;
  }
}
