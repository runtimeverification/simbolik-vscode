/**
 * Which variables a statement may WRITE — a static AST analysis the Locals
 * scope uses to bound "last known value" lookups and detect stale stack copies.
 */
import type {AstNode, CompilationUnit} from '@simbolik/solc';

/** The variables a statement writes, and the subset written by a compound update. */
interface StatementWrites {
  writes: Set<number>;
  /** Written by a compound update (`x -= e`, `x++`), not a plain `=`. */
  compound: Set<number>;
}

const cache = new WeakMap<CompilationUnit, Map<number, StatementWrites>>();

/** A statement or block node (the boundary of a statement's OWN expressions). */
function isNestedStatement(n: AstNode): boolean {
  const t = n.nodeType;
  return (
    t === 'Block' ||
    t === 'UncheckedBlock' ||
    t.endsWith('Statement') ||
    t === 'Return' ||
    t === 'InlineAssembly' ||
    t === 'Break' ||
    t === 'Continue' ||
    t === 'Throw'
  );
}

/**
 * How statement `stmtId` writes the variable `declId`: `'compound'` for an
 * update that computes from the old value (`-=`, `++`), `'plain'` for any other
 * write, `undefined` when it does not write it. A write is an assignment with it
 * on the left-hand side (incl. tuple destructuring), `++`/`--`/`delete` on it, a
 * declaration of it, or an inline-assembly block referencing it (conservative —
 * assembly reads and writes are not distinguished).
 */
export function statementWriteKind(
  cu: CompilationUnit,
  stmtId: number,
  declId: number
): 'compound' | 'plain' | undefined {
  const {writes, compound} = writesOf(cu, stmtId);
  if (!writes.has(declId)) return undefined;
  return compound.has(declId) ? 'compound' : 'plain';
}

/** Whether statement `stmtId` may write the variable `declId`. */
export function statementWrites(
  cu: CompilationUnit,
  stmtId: number,
  declId: number
): boolean {
  return writesOf(cu, stmtId).writes.has(declId);
}

function writesOf(cu: CompilationUnit, stmtId: number): StatementWrites {
  let byStmt = cache.get(cu);
  if (byStmt === undefined) {
    byStmt = new Map();
    cache.set(cu, byStmt);
  }
  let result = byStmt.get(stmtId);
  if (result === undefined) {
    result = analyze(cu.nodeById(stmtId));
    byStmt.set(stmtId, result);
  }
  return result;
}

function analyze(stmt: AstNode | undefined): StatementWrites {
  const writes = new Set<number>();
  const compound = new Set<number>();
  if (stmt === undefined) return {writes, compound};
  let compoundNow = false;
  const visit = (n: AstNode, inLhs: boolean): void => {
    if (n.nodeType === 'Assignment') {
      const kids = n.children();
      // The right-hand side is the child starting last.
      const rhs = kids.reduce(
        (a, b) => (b.srcStart > a.srcStart ? b : a),
        kids[0]!
      );
      compoundNow = n.operator !== '=';
      for (const k of kids) visit(k, k !== rhs);
      compoundNow = false;
      return;
    }
    if (
      n.nodeType === 'UnaryOperation' &&
      (n.operator === '++' || n.operator === '--' || n.operator === 'delete')
    ) {
      compoundNow = n.operator !== 'delete';
      for (const k of n.children()) visit(k, true);
      compoundNow = false;
      return;
    }
    if (n.nodeType === 'InlineAssembly') {
      for (const id of n.externalReferenceIds()) writes.add(id);
      return;
    }
    if (
      inLhs &&
      n.nodeType === 'Identifier' &&
      n.referencedDeclaration !== undefined
    ) {
      writes.add(n.referencedDeclaration);
      if (compoundNow) compound.add(n.referencedDeclaration);
    }
    // Index/member accesses on the LHS write into the base's CONTENTS, not
    // the stack variable itself (a memory handle is unchanged).
    const lhsPasses =
      inLhs &&
      (n.nodeType === 'TupleExpression' || n.nodeType === 'Identifier');
    for (const k of n.children()) {
      // Only the statement's OWN expressions: a nested statement (an `if`/
      // `while` body) runs under its own steps — the loop's condition steps
      // must not count as writing what the body assigns.
      if (k !== stmt && isNestedStatement(k)) continue;
      visit(k, lhsPasses);
    }
  };
  // A declaration statement initialises its own variables (a write too).
  if (stmt.nodeType === 'VariableDeclarationStatement') {
    for (const d of stmt.children()) {
      if (d.nodeType === 'VariableDeclaration') writes.add(d.id);
    }
  }
  visit(stmt, false);
  return {writes, compound};
}
