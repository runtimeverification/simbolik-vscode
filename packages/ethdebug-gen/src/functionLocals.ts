/**
 * Static function LOCAL-variable inventory.
 *
 * {@link functionLocals} walks a `FunctionDefinition` body and returns, in
 * declaration (source) order, a {@link LocalDescriptor} for every local variable
 * — i.e. every `VariableDeclaration` that is the child of a
 * `VariableDeclarationStatement` (this excludes the function's parameters and
 * return variables, which live under `ParameterList`).
 *
 * Each descriptor carries the variable's lexical live-range as source offsets:
 * `[declEnd, scopeEnd)` bounded below by `scopeStart`. A local is LIVE at a source
 * offset `o` when `scopeStart <= o < scopeEnd` and `o >= declEnd` (its declaration
 * statement has completed). The debugger uses this, plus the runtime stack height,
 * to bind each live local to its stack slot: locals occupy contiguous slots above
 * the frame base in declaration order, and inner-block locals reuse the slots
 * freed when an earlier block exits — so a local's slot is
 * `frameBase + rank`, where `rank` is its position among the CURRENTLY-live
 * locals ordered by declaration.
 *
 * KNOWN LIMITATION: the `frameBase + rank` model
 * above assumes every local occupies EXACTLY ONE stack slot. That holds for
 * value types and for memory/storage reference pointers, but a dynamically-sized
 * CALLDATA local (`bytes`/`string`/`T[] calldata`) occupies TWO slots
 * (offset + length). This inventory does not yet carry a per-local stack size,
 * so if such a two-slot local were live before another local, every later
 * local's `rank`/slot would be off by one. No such local appears in the
 * fixture; a `stackSize` field on {@link LocalDescriptor} (accumulated instead of
 * `rank`) is the intended fix.
 */
import type {AstNode, CompilationUnit} from '@simbolik/solc';

import {requireFunction, srcEnd, walkAst} from './ast.js';
import {declTypeFacts} from './valueTypes.js';

/** A single function local variable's static descriptor. */
export interface LocalDescriptor {
  /** Declared variable name. */
  name: string;
  /** AST declaration id — the key the stack-provenance analyzer tags slots by. */
  declId: number;
  /** 0-based declaration (source) order across the whole function body. */
  index: number;
  /** solc storage-style type id, e.g. `t_uint256` (empty for reference types). */
  solcType: string;
  /** Solidity type string for display, e.g. `uint8`, `enum Locals.Color`. */
  typeLabel: string;
  /** Value size in bytes (1..32); 0 for reference types. */
  numberOfBytes: number;
  /** True for the value types this inventory decodes; false → reference/dynamic. */
  isValueType: boolean;
  /** Source offset at/after which the variable is live (its statement's end). */
  declEnd: number;
  /** Source offset where the enclosing lexical scope (block/for) begins. */
  scopeStart: number;
  /** Source offset where the enclosing lexical scope ends (exclusive). */
  scopeEnd: number;
}

/**
 * Whether a local is live at source `offset`: its enclosing lexical scope covers
 * the offset AND its declaration statement has completed.
 */
export function isLocalLiveAt(local: LocalDescriptor, offset: number): boolean {
  return (
    offset >= local.declEnd &&
    offset >= local.scopeStart &&
    offset < local.scopeEnd
  );
}

/**
 * The nearest enclosing lexical-scope node whose exit POPS the local's stack
 * slot: a plain `Block`, an `UncheckedBlock` (`unchecked { … }` is a real block
 * scope — its locals are popped at its close just like a plain block), or a
 * `ForStatement` (whose init-clause locals are scoped to the whole loop).
 */
function enclosingScope(decl: AstNode): AstNode | undefined {
  let current = decl.parent();
  while (current !== undefined) {
    const nt = current.nodeType;
    if (nt === 'Block' || nt === 'UncheckedBlock' || nt === 'ForStatement') {
      return current;
    }
    current = current.parent();
  }
  return undefined;
}

/** Collect the local `VariableDeclaration`s of a function body, in source order. */
function collectLocalDeclarations(fnNode: AstNode): AstNode[] {
  const out: AstNode[] = [];
  walkAst(fnNode, node => {
    if (
      node.nodeType === 'VariableDeclaration' &&
      node.name !== undefined &&
      node.parent()?.nodeType === 'VariableDeclarationStatement'
    ) {
      out.push(node);
    }
  });
  // Source order = execution/stack order for straight-line declarations.
  out.sort((a, b) => a.srcStart - b.srcStart);
  return out;
}

/** The static local-variable inventory for `contractName.methodName`. */
export function functionLocals(
  cu: CompilationUnit,
  sourcePath: string,
  contractName: string,
  methodName: string
): LocalDescriptor[] {
  const fn = requireFunction(cu, sourcePath, contractName, methodName);
  return localsFromFunctionNode(fn, cu);
}

/**
 * The static local-variable inventory for an already-resolved
 * `FunctionDefinition` node. Prefer this over {@link functionLocals} when the node
 * is known (e.g. resolved from a source map at a pc): a by-name lookup is scoped
 * to a single contract's own members, so it misses INHERITED functions (defined in
 * a base contract) and cannot disambiguate overloads — whereas the node is exact.
 */
export function localsFromFunctionNode(
  fn: AstNode,
  cu: CompilationUnit
): LocalDescriptor[] {
  return collectLocalDeclarations(fn).map((decl, index) => {
    const stmt = decl.parent()!; // the VariableDeclarationStatement
    const scope = enclosingScope(decl) ?? fn;
    return {
      name: decl.name!,
      declId: decl.id,
      index,
      ...declTypeFacts(decl, cu),
      declEnd: srcEnd(stmt),
      scopeStart: scope.srcStart,
      scopeEnd: srcEnd(scope),
    };
  });
}
