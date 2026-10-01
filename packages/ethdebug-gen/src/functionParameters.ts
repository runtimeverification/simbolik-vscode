/**
 * Static function input-parameter inventory.
 *
 * {@link functionParameters} turns a `FunctionDefinition`'s parameter list into
 * a declaration-ordered array of {@link ParamDescriptor}s: name, index, display
 * type, byte width and value-type-ness. The value-type classification lives in
 * `valueTypes.ts`.
 */
import type {AstNode, CompilationUnit} from '@simbolik/solc';

import {requireFunction} from './ast.js';
import {declTypeFacts} from './valueTypes.js';

/** A single function input parameter's static descriptor. */
export interface ParamDescriptor {
  /** Declared parameter name (or `argN` if unnamed). */
  name: string;
  /** AST declaration id; the key the stack-provenance analyzer tags slots by. */
  declId: number;
  /** 0-based declaration order (also the ABI/stack head index for value types). */
  index: number;
  /** solc type id, e.g. `t_uint256`; the structural id for reference types. */
  solcType: string;
  /** Solidity type string for display, e.g. `uint8`, `int256`, `enum Vars.Color`. */
  typeLabel: string;
  /** Value size in bytes (1..32); 0 for reference types. */
  numberOfBytes: number;
  /** True for value types; false for reference/dynamic types. */
  isValueType: boolean;
}

/**
 * The static input-parameter inventory for `contractName.methodName`, in
 * declaration order. Reference/dynamic parameters are still listed (so indices
 * stay aligned with the ABI) but carry `isValueType: false`.
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
 * `FunctionDefinition` node. Prefer this over {@link functionParameters} when
 * the node is known (e.g. resolved from a source map at a pc): a by-name lookup
 * is scoped to a single contract's own members, so it misses inherited
 * functions and cannot disambiguate overloads.
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
