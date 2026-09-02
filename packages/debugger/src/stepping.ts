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
  buildInstructionIndex,
  closestStatement,
  findInnermostNode,
  type CompilationUnit,
  type Contract,
  type SourceMapEntry,
} from '@simbolik/solc';

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
  /** Raw EVM call depth (no folded internal jumps) — for instruction stepping. */
  depth: number;
  /** Whether this step begins a new statement (a valid stop candidate). */
  isStmtStart: boolean;
  /** Whether this step begins a new (path, line) run (optimized-frame stops). */
  isLineStart: boolean;
  /** Whether the resolved contract's CU was compiled with the optimizer. */
  optimized: boolean;
}

/** Per-contract source-map indexing, cached across steps. */
interface ContractIndex {
  pcToInstruction: Map<number, number>;
  sourceMap: SourceMapEntry[];
}

/**
 * Precomputes per-step metadata over an entire trace and answers the stepping
 * predicates. Multi-CU aware: each step resolves to its own contract/CU.
 */
export class SteppingModel {
  readonly #meta: StepMeta[];
  /** The terminal (last) step index. */
  readonly last: number;

  constructor(cursor: StateCursor, resolve: StepResolver) {
    const runtimeCache = new Map<Contract, ContractIndex>();
    const initCache = new Map<Contract, ContractIndex>();
    // Init (constructor) code has its OWN bytecode + source map, distinct from
    // runtime code — a CREATE frame's pcs index into it, not the runtime map.
    const indexFor = (contract: Contract, isInit: boolean): ContractIndex => {
      const cache = isInit ? initCache : runtimeCache;
      let idx = cache.get(contract);
      if (idx === undefined) {
        idx = {
          pcToInstruction: buildInstructionIndex(
            isInit ? contract.initBytecode() : contract.runtimeBytecode(),
          ).pcToInstruction,
          sourceMap: isInit
            ? contract.initSourceMap()
            : contract.runtimeSourceMap(),
        };
        cache.set(contract, idx);
      }
      return idx;
    };

    const meta: StepMeta[] = new Array(cursor.length);
    let jumpDepthBefore = 0;
    let lastDefinedStmtId: number | undefined;
    let lastPath: string | undefined;
    let lastLine: number | undefined;

    for (let i = 0; i < cursor.length; i++) {
      const st = cursor.at(i);
      const resolution = resolve(i);
      const combinedDepth = st.depth + jumpDepthBefore;

      let line: number | undefined;
      let col: number | undefined;
      let path: string | undefined;
      let stmtId: number | undefined;
      let entry: SourceMapEntry | undefined;
      const optimized = resolution?.optimized ?? false;

      // A CREATE/CREATE2 frame runs the constructor's INIT code, indexed by the
      // init source map (`isInitCode`), not the runtime map. If the frame's
      // contract wasn't identified (the pc won't be a valid init instruction),
      // `pcToInstruction.get` returns undefined and the step stays unmapped — so
      // statement stepping steps OVER an unresolved constructor rather than
      // mis-mapping it (which previously corrupted `combinedDepth`).
      if (resolution !== undefined) {
        const {pcToInstruction, sourceMap} = indexFor(
          resolution.contract,
          st.isInitCode,
        );
        const instruction = pcToInstruction.get(st.pc);
        entry = instruction !== undefined ? sourceMap[instruction] : undefined;
        if (entry !== undefined && entry.fileId >= 0) {
          const source = resolution.cu.sourceById(entry.fileId);
          if (source !== undefined) {
            const pos = source.offsetToPosition(entry.start);
            line = pos.line;
            col = pos.column;
            path = source.path;
            const node = findInnermostNode(
              source.ast(),
              entry.start,
              entry.length,
            );
            stmtId = node !== undefined ? closestStatement(node)?.id : undefined;
          }
        }
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
        isStmtStart,
        isLineStart,
        optimized,
      };

      if (stmtId !== undefined) {
        lastDefinedStmtId = stmtId;
      }
      if (line !== undefined) {
        lastPath = path;
        lastLine = line;
      }
      // Fold this step's jump AFTER recording its depth, so the landing step
      // (not the JUMP itself) carries the changed depth.
      if (entry !== undefined) {
        if (entry.jump === 'i') jumpDepthBefore += 1;
        else if (entry.jump === 'o') jumpDepthBefore -= 1;
      }
    }

    this.#meta = meta;
    this.last = meta.length - 1;
  }

  /** Metadata for `index`. */
  at(index: number): StepMeta {
    return this.#meta[index]!;
  }

  /** The first statement-start step (the entry stop after launch). */
  entry(): number {
    for (let i = 0; i <= this.last; i++) {
      if (this.#meta[i]!.isStmtStart) return i;
    }
    return 0;
  }

  /**
   * `next` / `stepOver`: skip descents into internal calls. Unoptimized frames
   * use statement identity; optimized frames fall back to line identity —
   * the smallest j>O at or below the origin depth whose (path, line) differs.
   */
  next(origin: number): number {
    const o = this.#meta[origin]!;
    if (o.optimized) {
      for (let j = origin + 1; j <= this.last; j++) {
        const m = this.#meta[j]!;
        if (
          m.isLineStart &&
          m.combinedDepth <= o.combinedDepth &&
          (m.path !== o.path || m.line !== o.line)
        ) {
          return j;
        }
      }
      return this.last;
    }
    for (let j = origin + 1; j <= this.last; j++) {
      const m = this.#meta[j]!;
      if (m.isStmtStart && m.combinedDepth <= o.combinedDepth && m.stmtId !== o.stmtId)
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

  /** `stepIn`: smallest j>O that starts a different statement (any depth). */
  stepIn(origin: number): number {
    const {stmtId: s} = this.#meta[origin]!;
    for (let j = origin + 1; j <= this.last; j++) {
      const m = this.#meta[j]!;
      if (m.isStmtStart && m.stmtId !== s) return j;
    }
    return this.last;
  }

  /** `stepOut`: smallest j>O that starts a statement strictly shallower. */
  stepOut(origin: number): number {
    const {combinedDepth: d} = this.#meta[origin]!;
    for (let j = origin + 1; j <= this.last; j++) {
      const m = this.#meta[j]!;
      if (m.isStmtStart && m.combinedDepth < d) return j;
    }
    return this.last;
  }

  /** `stepBack`: largest j<O that starts a statement; stay at 0 if none. */
  stepBack(origin: number): number {
    for (let j = origin - 1; j >= 0; j--) {
      if (this.#meta[j]!.isStmtStart) return j;
    }
    return 0;
  }

  /**
   * `continue`: smallest j>O that is an armed breakpoint stop; terminal if none.
   * Breakpoints are path-keyed: a step matches only when its RESOLVED source
   * path + line is armed (so a Callee-source line does not match a Caller line).
   */
  continue(origin: number, breakpoints: ReadonlyMap<string, ReadonlySet<number>>): number {
    for (let j = origin + 1; j <= this.last; j++) {
      if (this.#isArmedStop(j, breakpoints)) return j;
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
      if (this.#isArmedStop(j, breakpoints)) return j;
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
    return this.#isArmedStop(index, breakpoints);
  }

  #isArmedStop(
    index: number,
    breakpoints: ReadonlyMap<string, ReadonlySet<number>>,
  ): boolean {
    const m = this.#meta[index]!;
    if (m.path === undefined || m.line === undefined) return false;
    if (!(breakpoints.get(m.path)?.has(m.line) ?? false)) return false;
    return m.optimized ? m.isLineStart : m.isStmtStart;
  }
}
