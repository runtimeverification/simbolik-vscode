/**
 * Static function INPUT-parameter inventory (value types).
 *
 * {@link functionParameters} turns a `FunctionDefinition`'s parameter list into a
 * flat, declaration-ordered array of {@link ParamDescriptor}s. Each descriptor is
 * a purely STATIC fact — name, index, display type, byte width, value-type-ness —
 * that the debugger later binds to a concrete ethdebug pointer per runtime frame
 * (calldata for externally-entered frames, the stack for internally-entered ones).
 *
 * The value-type classification itself lives in `valueTypes.ts`.
 */
import type {AstNode, CompilationUnit} from '@simbolik/solc';

import {requireFunction} from './ast.js';
import {declTypeFacts} from './valueTypes.js';

/** A single function input parameter's static descriptor. */
export interface ParamDescriptor {
  /** Declared parameter name (or `argN` if unnamed). */
  name: string;
  /** AST declaration id — the key the stack-provenance analyzer tags slots by. */
  declId: number;
  /** 0-based declaration order (also the ABI/stack head index for value types). */
  index: number;
  /** solc storage-style type id, e.g. `t_uint256` (empty for reference types). */
  solcType: string;
  /** Solidity type string for display, e.g. `uint8`, `int256`, `enum Vars.Color`. */
  typeLabel: string;
  /** Value size in bytes (1..32); 0 for reference types. */
  numberOfBytes: number;
  /** True for the value types this inventory handles; false → reference/dynamic (skip). */
  isValueType: boolean;
}

/**
 * The static input-parameter inventory for `contractName.methodName`, in
 * declaration order. Reference/dynamic parameters are still listed (so indices
 * stay aligned with the ABI) but carry `isValueType: false` and are skipped by
 * the debugger reader.
 */
export function functionParameters(
  cu: CompilationUnit,
  sourcePath: string,
  contractName: string,
  methodName: string
): ParamDescriptor[] {
  const fn = requireFunction(cu, sourcePath, contractName, methodName);
  return parametersFromFunctionNode(fn, cu);
}

/**
 * The static input-parameter inventory for an already-resolved
 * `FunctionDefinition` node. Prefer this over {@link functionParameters} when the
 * node is known (e.g. resolved from a source map at a pc): a by-name lookup is
 * scoped to a single contract's own members, so it misses INHERITED functions
 * (defined in a base contract) and cannot disambiguate overloads — the node is
 * exact.
 */
export function parametersFromFunctionNode(
  fn: AstNode,
  cu: CompilationUnit
): ParamDescriptor[] {
  return fn.parameters().map((param, index) => ({
    name: param.name ?? `arg${index}`,
    declId: param.id,
    index,
    ...declTypeFacts(param, cu),
  }));
}
