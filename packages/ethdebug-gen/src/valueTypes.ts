/**
 * Value-type classification of AST declarations — a build-info-derived fact
 * shared by the static parameter/local inventories, the variable producer and
 * the debugger's runtime reader (which re-exports {@link describeValueTypeString}).
 */
import type {AstNode, CompilationUnit} from '@simbolik/solc';

/** The value-type shape of a declaration: storage-style type id + byte width. */
export interface ValueTypeShape {
  typeId: string;
  numberOfBytes: number;
  /** The enum's simple name, for an enum type. */
  enumName?: string;
}

/**
 * The value-type shape of a solc `typeString` (as carried by an AST
 * `VariableDeclaration.typeDescriptions.typeString`): its storage-style type id
 * and byte width, plus the enum simple name when applicable. Returns `undefined`
 * for reference/dynamic types (bytes/string/array/struct/mapping), which are out
 * of scope for the value-type inventory.
 */
export function describeValueTypeString(
  typeString: string
): ValueTypeShape | undefined {
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
  if (/^contract\s+(.+)$/.test(ts)) {
    return {typeId: 't_contract', numberOfBytes: 20};
  }
  const enumMatch = /^enum\s+(?:.+\.)?(\w+)$/.exec(ts);
  if (enumMatch) {
    return {typeId: 't_enum', numberOfBytes: 1, enumName: enumMatch[1]};
  }

  return undefined;
}

/**
 * The value-type descriptor for a `VariableDeclaration`, resolving a USER-DEFINED
 * VALUE TYPE (`type X is <elementary>`) to its underlying type.
 *
 * A UDVT variable's `typeString` is the alias name (e.g. `Currency`), which
 * {@link describeValueTypeString} does not recognise, so such a local/param would
 * be misclassified as a reference type and shown without a value. Its
 * declaration's `UserDefinedTypeName` child carries a `referencedDeclaration`
 * pointing at the `UserDefinedValueTypeDefinition` (possibly in another source),
 * whose `ElementaryTypeName` child is the real value type (e.g. `address`). Falls
 * back to `undefined` for genuine reference/dynamic types.
 */
export function describeDeclValueType(
  decl: AstNode,
  cu: CompilationUnit
): ValueTypeShape | undefined {
  const direct = describeValueTypeString(decl.typeString ?? '');
  if (direct !== undefined) return direct;
  if (!(decl.typeIdentifier ?? '').startsWith('t_userDefinedValueType')) {
    return undefined;
  }
  const typeName = decl
    .children()
    .find(c => c.nodeType === 'UserDefinedTypeName');
  const ref = typeName?.referencedDeclaration;
  if (ref === undefined) return undefined;
  const defn = cu.nodeById(ref);
  if (
    defn === undefined ||
    defn.nodeType !== 'UserDefinedValueTypeDefinition'
  ) {
    return undefined;
  }
  const underlying = defn
    .children()
    .find(c => c.nodeType === 'ElementaryTypeName');
  return underlying?.typeString === undefined
    ? undefined
    : describeValueTypeString(underlying.typeString);
}

/** The type facts every stack-variable descriptor (param/return/local) carries. */
export interface DeclTypeFacts {
  /** solc storage-style type id for value types; the structural type id otherwise. */
  solcType: string;
  /** Solidity type string for display. */
  typeLabel: string;
  /** Value size in bytes (1..32); 0 for reference types. */
  numberOfBytes: number;
  isValueType: boolean;
}

/**
 * The {@link DeclTypeFacts} of a `VariableDeclaration`. A value type carries its
 * storage-style id; a reference type (struct/array/string/bytes/mapping) still
 * carries its solc STRUCTURAL type id (e.g. `t_struct$_Point_$10_memory_ptr`,
 * `t_array$_t_uint256_$dyn_memory_ptr`, `t_string_memory_ptr`) so the variable
 * producer can resolve its shape (memory struct → members; dynamic memory
 * array/string/bytes).
 */
export function declTypeFacts(
  decl: AstNode,
  cu: CompilationUnit
): DeclTypeFacts {
  const desc = describeDeclValueType(decl, cu);
  return {
    solcType: desc?.typeId ?? decl.typeIdentifier ?? '',
    typeLabel: decl.typeString ?? '',
    numberOfBytes: desc?.numberOfBytes ?? 0,
    isValueType: desc !== undefined,
  };
}
