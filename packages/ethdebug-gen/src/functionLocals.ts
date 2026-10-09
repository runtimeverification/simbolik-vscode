/**
 * Static function local-variable inventory.
 *
 * {@link functionLocals} walks a `FunctionDefinition` body and returns, in
 * declaration (source) order, a {@link LocalDescriptor} for every local
 * variable: every `VariableDeclaration` that is the child of a
 * `VariableDeclarationStatement` (this excludes the function's parameters and
 * return variables, which live under `ParameterList`).
 *
 * Each descriptor carries the variable's lexical live range as source offsets.
 * A local is live at a source offset `o` when `scopeStart <= o < scopeEnd` and
 * `o >= declEnd` (its declaration statement has completed). The legacy
 * frame-relative slot model in `variables.ts` uses this: locals occupy
 * contiguous slots above the frame base in declaration order, and inner-block
 * locals reuse the slots freed when an earlier block exits, so a local's slot
 * is `frameBase + rank`, where `rank` is its position among the currently live
 * locals.
 *
 * Known limitation: that model assumes every local occupies one stack slot.
 * That holds for value types and memory/storage reference pointers, but a
 * dynamically-sized calldata local (`bytes`/`string`/`T[] calldata`) occupies
 * two (offset + length), so every later local's slot would be off by one. A
 * per-local `stackSize` (accumulated instead of `rank`) would fix this.
 */
import type {AstNode, CompilationUnit} from '@simbolik/solc';

import {requireFunction, srcEnd, walkAst} from './ast.js';
import {declTypeFacts} from './valueTypes.js';

/** A single function local variable's static descriptor. */
export interface LocalDescriptor {
  name: string;
  /** AST declaration id; the key the stack-provenance analyzer tags slots by. */
  declId: number;
  /** 0-based declaration (source) order across the whole function body. */
  index: number;
  /** solc type id, e.g. `t_uint256`; the structural id for reference types. */
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
 * Whether a local is live at source `offset`: its enclosing lexical scope
 * covers the offset and its declaration statement has completed.
 */
export function isLocalLiveAt(local: LocalDescriptor, offset: number): boolean {
  return (
    offset >= local.declEnd &&
    offset >= local.scopeStart &&
    offset < local.scopeEnd
  );
}

/**
 * The nearest enclosing lexical-scope node whose exit pops the local's stack
 * slot: a `Block`, an `UncheckedBlock` (a real block scope), or a
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

/** The local `VariableDeclaration`s of a function body, in source order. */
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
 * `FunctionDefinition` node. Prefer this over {@link functionLocals} when the
 * node is known (e.g. resolved from a source map at a pc): a by-name lookup is
 * scoped to a single contract's own members, so it misses inherited functions
 * and cannot disambiguate overloads.
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
