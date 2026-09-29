/** A raw solc AST node as it appears in the standard-json output. */
interface RawAstNode {
  readonly id?: number;
  readonly nodeType?: string;
  readonly src?: string;
  readonly [key: string]: unknown;
}

/** Node types treated as "statements" by {@link closestStatement}. */
function isStatement(nodeType: string): boolean {
  // Yul nodes are never statements of their own: they carry no AST id (every
  // one reads as -1, shared across ALL assembly blocks) and viaIR maps assembly
  // only to the whole block, so the enclosing `InlineAssembly` is the statement.
  if (nodeType.startsWith('Yul')) return false;
  return (
    nodeType.endsWith('Statement') ||
    nodeType === 'Return' ||
    nodeType === 'Break' ||
    nodeType === 'Continue' ||
    nodeType === 'Throw' ||
    nodeType === 'PlaceholderStatement' ||
    nodeType === 'InlineAssembly'
  );
}

/**
 * A navigable wrapper over a solc AST node. `src` is solc's `"start:length:fileId"`
 * triple, exposed pre-parsed as {@link srcStart}/{@link srcLength}/{@link srcFileId}.
 */
export class AstNode {
  readonly #raw: RawAstNode;
  readonly #parent: AstNode | undefined;
  #srcStart = 0;
  #srcLength = 0;
  #srcFileId = 0;
  #children: readonly AstNode[] | undefined;

  constructor(raw: RawAstNode, parent?: AstNode) {
    this.#raw = raw;
    this.#parent = parent;
    const [s, l, f] = (raw.src ?? '0:0:0').split(':');
    this.#srcStart = parseInt(s ?? '0', 10);
    this.#srcLength = parseInt(l ?? '0', 10);
    this.#srcFileId = parseInt(f ?? '0', 10);
  }

  get id(): number {
    return this.#raw.id ?? -1;
  }

  get nodeType(): string {
    return this.#raw.nodeType ?? '';
  }

  get src(): string {
    return this.#raw.src ?? '';
  }

  /** The raw `name` field (e.g. a declaration or definition name), if present. */
  get name(): string | undefined {
    const value = this.#raw.name;
    return typeof value === 'string' ? value : undefined;
  }

  /**
   * The raw `visibility` field of a declaration (`public` / `external` /
   * `internal` / `private`), e.g. on a `FunctionDefinition`; `undefined` if absent.
   */
  /**
   * For a `VariableDeclarationStatement`: its `assignments` — the declared
   * variable ids in tuple order, with `null` for a skipped component (`(a, , b)`).
   */
  assignments(): (number | null)[] {
    const a = this.#raw.assignments;
    if (!Array.isArray(a)) return [];
    return a.map((x) => (typeof x === 'number' ? x : null));
  }

  /** The raw `operator` field (e.g. `=`, `+=`, `++`, `delete`), if present. */
  get operator(): string | undefined {
    const value = this.#raw.operator;
    return typeof value === 'string' ? value : undefined;
  }

  /**
   * For an `InlineAssembly` node: the AST declaration ids of the Solidity
   * variables it references (`externalReferences[].declaration`).
   */
  externalReferenceIds(): number[] {
    const refs = this.#raw.externalReferences;
    if (!Array.isArray(refs)) return [];
    return refs
      .map((r) => (r as {declaration?: unknown}).declaration)
      .filter((d): d is number => typeof d === 'number');
  }

  get visibility(): string | undefined {
    const value = this.#raw.visibility;
    return typeof value === 'string' ? value : undefined;
  }

  /** The raw `typeDescriptions.typeString` (e.g. `uint8`, `enum Vars.Color`). */
  get typeString(): string | undefined {
    const td = this.#raw.typeDescriptions as
      | {typeString?: unknown}
      | undefined;
    return typeof td?.typeString === 'string' ? td.typeString : undefined;
  }

  /**
   * The raw `typeDescriptions.typeIdentifier` (solc's structural type id, e.g.
   * `t_uint256` or `t_struct$_Point_$10_memory_ptr`). Unlike the storage-style
   * `t_struct(Point)10` ids, it embeds the referenced definition's AST id between
   * `$_…_$` and the following `_`, which {@link CompilationUnit.structMembers}
   * parses to resolve the `StructDefinition`.
   */
  get typeIdentifier(): string | undefined {
    const td = this.#raw.typeDescriptions as
      | {typeIdentifier?: unknown}
      | undefined;
    return typeof td?.typeIdentifier === 'string' ? td.typeIdentifier : undefined;
  }

  /**
   * For an `EnumDefinition`, the ordered member names (from `members[].name`);
   * an empty array for any other node type.
   */
  memberNames(): string[] {
    if (this.nodeType !== 'EnumDefinition') {
      return [];
    }
    const members = this.#raw.members;
    if (!Array.isArray(members)) {
      return [];
    }
    return members
      .map((m) => (m as {name?: unknown}).name)
      .filter((n): n is string => typeof n === 'string');
  }

  /**
   * For a `StructDefinition`, its member `VariableDeclaration`s as
   * `{name, typeString}` in declaration order; an empty array for any other node
   * type. Each member's `typeString` (e.g. `uint256`) is what the value-type
   * describer consumes to size + type the member.
   */
  structMembers(): {name: string; typeString: string}[] {
    if (this.nodeType !== 'StructDefinition') {
      return [];
    }
    const members = this.#raw.members;
    if (!Array.isArray(members)) {
      return [];
    }
    return members
      .filter(isRawAstNode)
      .map((m) => new AstNode(m, this))
      .filter((m) => m.name !== undefined)
      .map((m) => ({name: m.name!, typeString: m.typeString ?? ''}));
  }

  /**
   * For a `FunctionDefinition`, its parameter `VariableDeclaration` nodes (from
   * `parameters.parameters`); an empty array for any other node type.
   */
  parameters(): AstNode[] {
    if (this.nodeType !== 'FunctionDefinition') {
      return [];
    }
    const list = this.#raw.parameters as
      | {parameters?: unknown}
      | undefined;
    const params = list?.parameters;
    if (!Array.isArray(params)) {
      return [];
    }
    return params
      .filter(isRawAstNode)
      .map((p) => new AstNode(p, this));
  }

  /**
   * For a `FunctionDefinition`, its return-parameter `VariableDeclaration` nodes
   * (from `returnParameters.parameters`); an empty array for any other node type
   * or a function with no declared returns. Each such return value occupies a
   * reserved stack slot in an externally-entered frame (see the frame model in
   * `@simbolik/ethdebug-gen`).
   */
  returnParameters(): AstNode[] {
    if (this.nodeType !== 'FunctionDefinition') {
      return [];
    }
    const list = this.#raw.returnParameters as
      | {parameters?: unknown}
      | undefined;
    const params = list?.parameters;
    if (!Array.isArray(params)) {
      return [];
    }
    return params
      .filter(isRawAstNode)
      .map((p) => new AstNode(p, this));
  }

  /**
   * For a `FunctionDefinition`, its `ModifierInvocation` nodes in source (=
   * execution) order, each with the id and name of the modifier it names. A
   * constructor's base-constructor calls are ModifierInvocations too; their id
   * is a contract's, so they never match an executing `ModifierDefinition`.
   */
  modifierInvocations(): {
    node: AstNode;
    modifierId: number | undefined;
    name: string | undefined;
  }[] {
    if (this.nodeType !== 'FunctionDefinition') return [];
    return this.children()
      .filter((c) => c.nodeType === 'ModifierInvocation')
      .map((node) => {
        const ref = node.#raw.modifierName as
          | {referencedDeclaration?: unknown; name?: unknown}
          | undefined;
        return {
          node,
          modifierId:
            typeof ref?.referencedDeclaration === 'number'
              ? ref.referencedDeclaration
              : undefined,
          name: typeof ref?.name === 'string' ? ref.name : undefined,
        };
      });
  }

  /**
   * The raw `referencedDeclaration` field of an `Identifier` (or `MemberAccess`)
   * node: the AST id of the declaration this reference resolves to (a
   * `VariableDeclaration`, `FunctionDefinition`, …), or `undefined` when absent.
   * Used to recognise a stack-variable READ (an `Identifier` whose referent is a
   * known param/local) during static stack-provenance analysis.
   */
  get referencedDeclaration(): number | undefined {
    const value = this.#raw.referencedDeclaration;
    return typeof value === 'number' ? value : undefined;
  }

  get srcStart(): number {
    return this.#srcStart;
  }

  get srcLength(): number {
    return this.#srcLength;
  }

  get srcFileId(): number {
    return this.#srcFileId;
  }

  /** The parent node this wrapper was descended from, if any. */
  parent(): AstNode | undefined {
    return this.#parent;
  }

  /**
   * Direct AST child nodes. Discovered structurally: every value that is itself
   * an AST node (has a `nodeType`), and every element of arrays of such nodes.
   */
  children(): readonly AstNode[] {
    // Memoized: the raw AST is immutable, so the wrappers are too. Callers (e.g.
    // findInnermostNode, run once per source-map entry by the frame-base anchor)
    // otherwise re-allocate the whole path from the root on every lookup.
    if (this.#children !== undefined) return this.#children;
    const out: AstNode[] = [];
    for (const key of Object.keys(this.#raw)) {
      if (key === 'nodeType' || key === 'id' || key === 'src') {
        continue;
      }
      const value = this.#raw[key];
      if (isRawAstNode(value)) {
        out.push(new AstNode(value, this));
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (isRawAstNode(item)) {
            out.push(new AstNode(item, this));
          }
        }
      }
    }
    this.#children = out;
    return out;
  }
}

function isRawAstNode(value: unknown): value is RawAstNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as {nodeType?: unknown}).nodeType === 'string'
  );
}

/** Does `node`'s src range cover the query range `[start, start+length)`? */
function covers(node: AstNode, start: number, length: number): boolean {
  return (
    node.srcStart <= start &&
    node.srcStart + node.srcLength >= start + length
  );
}

/**
 * The deepest AST node whose src range covers `[start, start+length)`.
 * Descends into a covering child whenever one exists, so for two nodes sharing
 * the same range (e.g. `ExpressionStatement` ⊃ `Assignment`) the deeper one wins.
 */
export function findInnermostNode(
  root: AstNode,
  start: number,
  length: number,
): AstNode | undefined {
  if (!covers(root, start, length)) {
    return undefined;
  }
  let best = root;
  for (;;) {
    const next = best.children().find((c) => covers(c, start, length));
    if (next === undefined) {
      break;
    }
    best = next;
  }
  return best;
}

/** Depth-first search of an AST subtree for the first node matching `pred`. */
export function findAstNode(
  root: AstNode,
  pred: (node: AstNode) => boolean,
): AstNode | undefined {
  if (pred(root)) {
    return root;
  }
  for (const child of root.children()) {
    const found = findAstNode(child, pred);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/** Climb from `node` to the nearest enclosing statement-like node (inclusive). */
export function closestStatement(node: AstNode): AstNode | undefined {
  let current: AstNode | undefined = node;
  while (current !== undefined) {
    if (isStatement(current.nodeType)) {
      return current;
    }
    current = current.parent();
  }
  return undefined;
}

/** Climb from `node` to the nearest enclosing `FunctionDefinition` (inclusive). */
export function closestFunction(node: AstNode): AstNode | undefined {
  let current: AstNode | undefined = node;
  while (current !== undefined) {
    if (current.nodeType === 'FunctionDefinition') {
      return current;
    }
    current = current.parent();
  }
  return undefined;
}

/**
 * Climb from `node` to the nearest enclosing `FunctionDefinition` OR
 * `ModifierDefinition` (inclusive). Mirrors {@link closestFunction} but also
 * matches a modifier body — used ONLY for modifier-frame detection + name
 * resolution; the function-only {@link closestFunction} contract is unchanged.
 */
export function closestFunctionOrModifier(
  node: AstNode,
): AstNode | undefined {
  let current: AstNode | undefined = node;
  while (current !== undefined) {
    if (
      current.nodeType === 'FunctionDefinition' ||
      current.nodeType === 'ModifierDefinition'
    ) {
      return current;
    }
    current = current.parent();
  }
  return undefined;
}
