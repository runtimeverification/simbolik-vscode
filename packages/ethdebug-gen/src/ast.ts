/** Small AST navigation helpers shared across the producers and analyzers. */
import {
  findInnermostNode,
  type AstNode,
  type CompilationUnit,
  type SourceMapEntry,
} from '@simbolik/solc';

/**
 * The innermost AST node a source-map entry points at, or `undefined` when the
 * entry has no source (`fileId` −1) or its file is not part of the output.
 */
export function nodeAtEntry(
  cu: CompilationUnit,
  entry: SourceMapEntry
): AstNode | undefined {
  if (entry.fileId < 0) return undefined;
  const source = cu.sourceById(entry.fileId);
  if (source === undefined) return undefined;
  return findInnermostNode(source.ast(), entry.start, entry.length);
}

/** Pre-order walk of the subtree rooted at `node`. */
export function walkAst(node: AstNode, visit: (node: AstNode) => void): void {
  visit(node);
  for (const child of node.children()) walkAst(child, visit);
}

/** Pre-order walk of every source's AST, skipping ASTs that fail to load. */
export function walkAllSources(
  cu: CompilationUnit,
  visit: (node: AstNode) => void
): void {
  for (const source of cu.sources()) {
    let root: AstNode;
    try {
      root = source.ast();
    } catch {
      continue;
    }
    walkAst(root, visit);
  }
}

/** The source range end (exclusive) of `node`. */
export function srcEnd(node: AstNode): number {
  return node.srcStart + node.srcLength;
}

/** The `FunctionDefinition` of `contractName.methodName`; throws if absent. */
export function requireFunction(
  cu: CompilationUnit,
  sourcePath: string,
  contractName: string,
  methodName: string
): AstNode {
  const fn = cu.functionDefinition(sourcePath, contractName, methodName);
  if (fn === undefined) {
    throw new Error(
      `function not found: ${sourcePath}:${contractName}.${methodName}`
    );
  }
  return fn;
}
