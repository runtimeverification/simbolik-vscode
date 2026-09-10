/**
 * Static function INPUT-parameter inventory (value types).
 *
 * {@link functionParameters} turns a `FunctionDefinition`'s parameter list into a
 * flat, declaration-ordered array of {@link ParamDescriptor}s. Each descriptor is
 * a purely STATIC fact — name, index, display type, byte width, value-type-ness —
 * that the debugger later binds to a concrete ethdebug pointer per runtime frame
 * (calldata for externally-entered frames, the stack for internally-entered ones).
 *
 * The value-type classification lives here (rather than in the debugger) because
 * it is a build-info-derived fact shared by the static inventory and the runtime
 * reader; the debugger re-exports {@link describeValueTypeString} from this module.
 */
import type {CompilationUnit} from '@simbolik/solc';

import {referenceTypeId} from './functionLocals.js';

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
 * The value-type shape of a solc `typeString` (as carried by an AST
 * `VariableDeclaration.typeDescriptions.typeString`): its storage-style type id
 * and byte width, plus the enum simple name when applicable. Returns `undefined`
 * for reference/dynamic types (bytes/string/array/struct/mapping), which are out
 * of scope for the value-type inventory.
 */
export function describeValueTypeString(
  typeString: string,
): {typeId: string; numberOfBytes: number; enumName?: string} | undefined {
  const ts = typeString.trim();

  if (ts === 'bool') {
    return {typeId: 't_bool', numberOfBytes: 1};
  }
  if (ts === 'address' || ts.startsWith('address ')) {
    return {typeId: 't_address', numberOfBytes: 20};
  }

  const uint = /^uint(\d+)$/.exec(ts);
  if (uint) {
    return {typeId: `t_uint${uint[1]}`, numberOfBytes: Number(uint[1]) / 8};
  }
  const int = /^int(\d+)$/.exec(ts);
  if (int) {
    return {typeId: `t_int${int[1]}`, numberOfBytes: Number(int[1]) / 8};
  }
  const bytes = /^bytes(\d+)$/.exec(ts);
  if (bytes) {
    return {typeId: `t_bytes${bytes[1]}`, numberOfBytes: Number(bytes[1])};
  }
  const contract = /^contract\s+(.+)$/.exec(ts);
  if (contract) {
    return {typeId: 't_contract', numberOfBytes: 20};
  }
  const enumMatch = /^enum\s+(?:.+\.)?(\w+)$/.exec(ts);
  if (enumMatch) {
    return {typeId: 't_enum', numberOfBytes: 1, enumName: enumMatch[1]};
  }

  return undefined;
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
  methodName: string,
): ParamDescriptor[] {
  const fn = cu.functionDefinition(sourcePath, contractName, methodName);
  if (fn === undefined) {
    throw new Error(
      `function not found: ${sourcePath}:${contractName}.${methodName}`,
    );
  }
  return fn.parameters().map((param, index) => {
    const typeLabel = param.typeString ?? '';
    const desc = describeValueTypeString(typeLabel);
    return {
      name: param.name ?? `arg${index}`,
      declId: param.id,
      index,
      // Reference-type params carry their solc structural type id.
      solcType: desc?.typeId ?? referenceTypeId(param),
      typeLabel,
      numberOfBytes: desc?.numberOfBytes ?? 0,
      isValueType: desc !== undefined,
    };
  });
}
