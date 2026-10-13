/**
 * Static, per-contract analyses shared by the stepping model and the session:
 * pc → source-map entry → source position / AST, disassembly, the ethdebug
 * storage program, and live variables per pc.
 *
 * Every result is a pure function of the (immutable) parsed `Contract` plus its
 * code image (init vs runtime), so it is memoized in a `WeakMap` keyed by the
 * `Contract` identity — never by name: the same contract name can appear in two
 * CUs (compiled at different optimization levels) or in two source paths, where
 * the same pc denotes different code.
 */
import {
  generateEthdebugProgram,
  variablesAt,
  type EthdebugProgram,
  type ResolvedVariable,
} from '@simbolik/ethdebug-gen';
import type {Hex} from '@simbolik/protocol';
import {
  buildInstructionIndex,
  closestFunction,
  closestFunctionOrModifier,
  findInnermostNode,
  type AstNode,
  type CompilationUnit,
  type Contract,
  type SourceFile,
  type SourceMapEntry,
} from '@simbolik/solc';

import {disassembleBytecode, type EvmInstruction} from './disassemble.js';

/** Memoize `compute(contract, isInit)` per contract identity and code image. */
function perImage<T>(
  compute: (contract: Contract, isInit: boolean) => T
): (contract: Contract, isInit: boolean) => T {
  const caches = {
    runtime: new WeakMap<Contract, T>(),
    init: new WeakMap<Contract, T>(),
  };
  return (contract, isInit) => {
    const cache = isInit ? caches.init : caches.runtime;
    if (cache.has(contract)) return cache.get(contract)!;
    const value = compute(contract, isInit);
    cache.set(contract, value);
    return value;
  };
}

/** Get-or-create the value for `key` in `map`. */
function memo<K, V>(map: Map<K, V>, key: K, compute: () => V): V {
  if (map.has(key)) return map.get(key)!;
  const value = compute();
  map.set(key, value);
  return value;
}

/**
 * The source-map index of a contract's code image. Init (constructor) code has
 * its own bytecode + source map, distinct from runtime code — a CREATE frame's
 * pcs index into it, not the runtime map.
 */
const sourceIndex = perImage((contract, isInit) => ({
  pcToInstruction: buildInstructionIndex(
    isInit ? contract.initBytecode() : contract.runtimeBytecode()
  ).pcToInstruction,
  sourceMap: isInit ? contract.initSourceMap() : contract.runtimeSourceMap(),
}));

/** The source-map entry of `pc`, with its source file + innermost AST node. */
export interface MappedPc {
  entry: SourceMapEntry;
  /** Undefined when the entry maps to no source (`fileId < 0` or unknown). */
  source: SourceFile | undefined;
  node: AstNode | undefined;
}

/** Map `pc` of the contract's code image to its source-map entry, if any. */
export function mapPc(
  contract: Contract,
  cu: CompilationUnit,
  pc: number,
  isInit: boolean
): MappedPc | undefined {
  const {pcToInstruction, sourceMap} = sourceIndex(contract, isInit);
  const instruction = pcToInstruction.get(pc);
  const entry = instruction !== undefined ? sourceMap[instruction] : undefined;
  if (entry === undefined) return undefined;
  const source = entry.fileId >= 0 ? cu.sourceById(entry.fileId) : undefined;
  const node =
    source !== undefined
      ? findInnermostNode(source.ast(), entry.start, entry.length)
      : undefined;
  return {entry, source, node};
}

/** A pc's source position + enclosing definitions. */
export interface ResolvedPosition {
  path: string;
  /** 1-based line. */
  line: number;
  /** 0-based column. */
  col: number;
  offset: number;
  /** Nearest enclosing FunctionDefinition. */
  fnNode: AstNode | undefined;
  /** Nearest enclosing FunctionDefinition or ModifierDefinition. */
  defNode: AstNode | undefined;
  /** Source-map modifier depth of this step. */
  modifierDepth: number;
}

const positionCache = perImage(
  () => new Map<number, ResolvedPosition | undefined>()
);

/**
 * Resolve `(contract, pc)` to a source position + enclosing definitions, or
 * `undefined` for an unmapped pc. Memoized: frame reconstruction resolves every
 * step of the current EVM frame on each stackTrace.
 */
export function resolvePosition(
  contract: Contract,
  cu: CompilationUnit,
  pc: number,
  isInit = false
): ResolvedPosition | undefined {
  return memo(positionCache(contract, isInit), pc, () => {
    const mapped = mapPc(contract, cu, pc, isInit);
    if (mapped?.source === undefined) return undefined;
    const {entry, source, node} = mapped;
    const p = source.offsetToPosition(entry.start);
    return {
      path: source.path,
      line: p.line,
      col: p.column,
      offset: entry.start,
      fnNode: node !== undefined ? closestFunction(node) : undefined,
      defNode: node !== undefined ? closestFunctionOrModifier(node) : undefined,
      modifierDepth: entry.modifierDepth,
    };
  });
}

/** A disassembled code image plus its pc → instruction-index lookup. */
export interface Disassembly {
  list: EvmInstruction[];
  pcToIndex: Map<number, number>;
}

/** Disassemble raw bytecode into a {@link Disassembly}. */
export function disassemble(bytecode: Hex): Disassembly {
  const list = disassembleBytecode(bytecode);
  const pcToIndex = new Map<number, number>();
  list.forEach((instr, i) => pcToIndex.set(instr.pc, i));
  return {list, pcToIndex};
}

/**
 * The disassembly of a contract's code image. A CREATE frame executes init code
 * with its own pc space, so disassembling runtime bytecode there would show the
 * wrong instructions and mis-anchor the pointer.
 */
export const contractDisassembly = perImage((contract, isInit) =>
  disassemble(isInit ? contract.initBytecode() : contract.runtimeBytecode())
);

const programCache = new WeakMap<Contract, EthdebugProgram>();

/** The contract's ethdebug program (storage-variable pointers). */
export function ethdebugProgram(
  contract: Contract,
  cu: CompilationUnit
): EthdebugProgram {
  let program = programCache.get(contract);
  if (program === undefined) {
    program = generateEthdebugProgram(cu, contract.sourcePath, contract.name);
    programCache.set(contract, program);
  }
  return program;
}

const variablesCache = perImage(() => new Map<number, ResolvedVariable[]>());

/**
 * `variablesAt(cu, …, pc)` over the contract's runtime or init code image,
 * memoized per pc: a session re-reading the Locals scope at the same position
 * would otherwise redo the per-pc resolution each time.
 */
export function liveVariables(
  contract: Contract,
  cu: CompilationUnit,
  pc: number,
  isInit: boolean
): ResolvedVariable[] {
  return memo(variablesCache(contract, isInit), pc, () =>
    variablesAt(
      cu,
      contract.sourcePath,
      contract.name,
      pc,
      isInit ? 'init' : 'runtime'
    )
  );
}
