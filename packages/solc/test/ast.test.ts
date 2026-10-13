import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {
  AstNode,
  closestFunction,
  closestStatement,
  findInnermostNode,
  loadBuildInfo,
} from '../src/index.js';

function loadFixture(name: string): unknown {
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as unknown;
}

const rootAst = () =>
  loadBuildInfo(loadFixture('counter-build-info.json')).sourceById(0)!.ast();

describe('AstNode.src parsing', () => {
  it('parses the SourceUnit root src "32:230:0" into numeric fields', () => {
    const root = rootAst();
    expect(root.nodeType).toBe('SourceUnit');
    expect(root.id).toBe(25);
    expect(root.src).toBe('32:230:0');
    expect(root.srcStart).toBe(32);
    expect(root.srcLength).toBe(230);
    expect(root.srcFileId).toBe(0);
  });
});

describe('findInnermostNode', () => {
  it('returns the increment FunctionDefinition (id 23, src 195:64:0) for its exact range', () => {
    const node = findInnermostNode(rootAst(), 195, 64);
    expect(node).toBeDefined();
    expect(node!.id).toBe(23);
    expect(node!.nodeType).toBe('FunctionDefinition');
    expect(node!.srcStart).toBe(195);
    expect(node!.srcLength).toBe(64);
    expect(node!.srcFileId).toBe(0);
  });

  it('descends past the ExpressionStatement to the innermost Assignment for the body range 233:19', () => {
    // ExpressionStatement id=21 and Assignment id=20 share src "233:19:0";
    // the deepest node still covering the query is the Assignment.
    const node = findInnermostNode(rootAst(), 233, 19);
    expect(node).toBeDefined();
    expect(node!.nodeType).toBe('Assignment');
    expect(node!.id).toBe(20);
    expect(node!.src).toBe('233:19:0');
  });

  it('resolves the literal "1" (src 251:1:0) as the innermost node of a point range', () => {
    const node = findInnermostNode(rootAst(), 251, 1);
    expect(node).toBeDefined();
    expect(node!.id).toBe(18);
    expect(node!.nodeType).toBe('Literal');
  });
});

describe('closestStatement / closestFunction climb up the tree', () => {
  it('climbs from the literal inside increment to its ExpressionStatement and FunctionDefinition', () => {
    const literal = findInnermostNode(rootAst(), 251, 1)!;

    const stmt = closestStatement(literal);
    expect(stmt).toBeDefined();
    expect(stmt!.nodeType).toBe('ExpressionStatement');
    expect(stmt!.id).toBe(21);

    const fn = closestFunction(literal);
    expect(fn).toBeDefined();
    expect(fn!.nodeType).toBe('FunctionDefinition');
    expect(fn!.id).toBe(23);
  });

  it('climbs from a node inside setNumber to FunctionDefinition id 13', () => {
    // Identifier "newNumber" (src 173:9:0) lives inside setNumber's body.
    const ident = findInnermostNode(rootAst(), 173, 9)!;
    expect(ident.nodeType).toBe('Identifier');
    const fn = closestFunction(ident);
    expect(fn!.id).toBe(13);
    expect(fn!.nodeType).toBe('FunctionDefinition');
  });
});

describe('SourceFile.offsetToPosition (UTF-8 byte offset -> 1-based line, 0-based column)', () => {
  const file = () =>
    loadBuildInfo(loadFixture('counter-build-info.json')).sourceById(0)!;

  it('cross-checks offsets against the raw source string', () => {
    const content = file().content;
    // "contract" begins at byte 58 (matches source-map entry 58:203).
    expect(content.slice(58, 66)).toBe('contract');
    expect(content[65]).toBe('t');
    // "function" of increment begins at byte 195, indented 4 spaces.
    expect(content.slice(195, 203)).toBe('function');
  });

  it('offset 58 -> line 4, column 0 (start of `contract Counter`)', () => {
    expect(file().offsetToPosition(58)).toEqual({line: 4, column: 0});
  });

  it('offset 195 -> line 11, column 4 (start of `function increment`)', () => {
    expect(file().offsetToPosition(195)).toEqual({line: 11, column: 4});
  });

  it('offset 65 -> line 4, column 7 (mid-line, the `t` ending `contract`)', () => {
    expect(file().offsetToPosition(65)).toEqual({line: 4, column: 7});
  });
});

describe('closestStatement — Yul nodes belong to their InlineAssembly block', () => {
  // Yul nodes carry no AST id (they all read as -1, shared across every assembly
  // block), so a Yul "statement" must never be a statement of its own: stepping
  // would otherwise flip between -1 and the block's id inside every asm block.
  const asm = new AstNode({
    nodeType: 'InlineAssembly',
    id: 5,
    src: '0:60:0',
    AST: {
      nodeType: 'YulBlock',
      src: '10:40:0',
      statements: [
        {
          nodeType: 'YulExpressionStatement',
          src: '12:20:0',
          expression: {nodeType: 'YulFunctionCall', src: '12:20:0'},
        },
      ],
    },
  });

  it('resolves a Yul expression to the enclosing InlineAssembly statement', () => {
    const inner = findInnermostNode(asm, 12, 20);
    expect(inner?.nodeType).toBe('YulFunctionCall');
    expect(closestStatement(inner!)?.id).toBe(5);
    expect(closestStatement(inner!)?.nodeType).toBe('InlineAssembly');
  });
});
