/**
 * Typed AST accessors on `@simbolik/solc`.
 *
 * These pay down the layering debt where the debugger walked raw build-info JSON
 * for enum member names and function parameters; it goes through the typed
 * accessors here instead. Ground-truth values are taken from the REAL
 * `vars-build-info.json` fixture (unoptimized Vars, solc 0.8.35) and were
 * cross-checked against the raw AST:
 *   - EnumDefinition `Color` has AST id 5, members [Red, Green, Blue].
 *   - FunctionDefinition `setAll` (id 67) has 7 parameters; the first is
 *     `_a` of type `uint8`; the last (`_color`) is the enum `Color`.
 */
import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {loadBuildInfo, type CompilationUnit, type Contract} from '../src/index.js';

function loadFixture(name: string): unknown {
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as unknown;
}

const vars = (): CompilationUnit =>
  loadBuildInfo(loadFixture('vars-build-info.json'));

describe('SourceFile.nodeById + AstNode.name/memberNames', () => {
  it('resolves the EnumDefinition Color by AST id 5', () => {
    const node = vars().sourceById(0)!.nodeById(5);
    expect(node).toBeDefined();
    expect(node!.nodeType).toBe('EnumDefinition');
    expect(node!.name).toBe('Color');
  });

  it('memberNames() returns the ordered enum member names', () => {
    const node = vars().sourceById(0)!.nodeById(5)!;
    expect(node.memberNames()).toEqual(['Red', 'Green', 'Blue']);
  });

  it('memberNames() is empty for a non-enum node', () => {
    // The SourceUnit root is not an EnumDefinition.
    const root = vars().sourceById(0)!.ast();
    expect(root.memberNames()).toEqual([]);
  });

  it('nodeById returns undefined for a bogus id', () => {
    expect(vars().sourceById(0)!.nodeById(999999)).toBeUndefined();
  });
});

describe('CompilationUnit.structMembers + AstNode.structMembers', () => {
  const locals = (): CompilationUnit =>
    loadBuildInfo(loadFixture('locals-build-info.json'));

  it('resolves Point members by the embedded AST id in the type identifier', () => {
    // `Locals` declares `struct Point { uint256 x; uint256 y; }` (AST id 10).
    const members = locals().structMembers('t_struct$_Point_$10_memory_ptr');
    expect(members).toEqual([
      {name: 'x', typeString: 'uint256'},
      {name: 'y', typeString: 'uint256'},
    ]);
  });

  it('resolves Point members by simple name when no id is embedded', () => {
    expect(locals().structMembers('t_struct(Point)_memory_ptr')).toEqual([
      {name: 'x', typeString: 'uint256'},
      {name: 'y', typeString: 'uint256'},
    ]);
  });

  it('AstNode.structMembers is empty for a non-struct node', () => {
    expect(locals().sourceById(0)!.ast().structMembers()).toEqual([]);
  });

  it('CompilationUnit.structMembers is empty for an unresolvable type id', () => {
    expect(locals().structMembers('t_struct$_Nope_$99999_memory_ptr')).toEqual([]);
  });
});

describe('CompilationUnit.functionDefinition + AstNode.parameters/name/typeString', () => {
  it('resolves setAll and exposes its 7 typed parameters', () => {
    const fn = vars().functionDefinition('src/Vars.sol', 'Vars', 'setAll');
    expect(fn).toBeDefined();
    expect(fn!.nodeType).toBe('FunctionDefinition');
    expect(fn!.name).toBe('setAll');

    const params = fn!.parameters();
    expect(params).toHaveLength(7);
  });

  it('exposes AstNode.name and AstNode.typeString on a parameter node', () => {
    const fn = vars().functionDefinition('src/Vars.sol', 'Vars', 'setAll')!;
    const first = fn.parameters()[0]!;
    expect(first.name).toBe('_a');
    expect(first.typeString).toBe('uint8');

    // The last parameter is the enum-typed `_color`; typeString carries the
    // fully-qualified enum type (`enum Vars.Color`).
    const last = fn.parameters()[6]!;
    expect(last.name).toBe('_color');
    expect(last.typeString).toContain('Color');
  });

  it('returns undefined for an unknown method', () => {
    expect(
      vars().functionDefinition('src/Vars.sol', 'Vars', 'nope'),
    ).toBeUndefined();
  });

  it('exposes AstNode.visibility on a FunctionDefinition', () => {
    const fn = vars().functionDefinition('src/Vars.sol', 'Vars', 'setAll')!;
    expect(fn.visibility).toBe('public');
    // A non-visibility-bearing node (the SourceUnit root) reports undefined.
    expect(vars().sourceById(0)!.ast().visibility).toBeUndefined();
  });

  it('exposes AstNode.returnParameters (void, non-empty, and non-function)', () => {
    // setAll declares no returns → empty; the accessor is empty on non-functions.
    const setAll = vars().functionDefinition('src/Vars.sol', 'Vars', 'setAll')!;
    expect(setAll.returnParameters()).toHaveLength(0);
    expect(vars().sourceById(0)!.ast().returnParameters()).toEqual([]);

    // `Locals.compute` declares `returns (uint256)` — one reserved return slot.
    // This is the shape whose reserved stack slot the variable producer accounts
    // for so parameters rank past it (see ethdebug-gen variables.ts).
    const locals = loadBuildInfo(loadFixture('locals-build-info.json'));
    const compute = locals.functionDefinition('src/Locals.sol', 'Locals', 'compute')!;
    const returns = compute.returnParameters();
    expect(returns).toHaveLength(1);
    expect(returns[0]!.typeString).toBe('uint256');
  });
});

// ---------------------------------------------------------------------------
// Contract.events() event inventory + selectors.
//
// The StorageRefs Contract declares `event Updated(uint256 indexed key,
// uint256 value)`. `events()` lists it with an ABI selector and typed params.
// Ground truth (re-derived from the raw trace's LOG2 topic0 and confirmed
// against keccak256): the selector is '0x' + keccak256(utf8-bytes of the
// CANONICAL signature "Updated(uint256,uint256)") — over ALL params, indexed +
// non-indexed, in declaration order, using ABI canonical type names.
//
// Loose accessor: `events()` does not exist on `Contract` yet, so it is reached
// through a runtime cast that returns `undefined` when absent — the RED is the
// "must be defined" assertion, NOT a type error (mirrors the storage-refs
// loose-accessor style).
// ---------------------------------------------------------------------------

interface EventParamShape {
  name: string;
  solcType?: string;
  typeLabel?: string;
  indexed: boolean;
}
interface EventInfoShape {
  name: string;
  selector: string;
  params: EventParamShape[];
}
function eventsOf(contract: Contract): EventInfoShape[] | undefined {
  const fn = (contract as unknown as {events?: () => EventInfoShape[]}).events;
  return typeof fn === 'function' ? fn.call(contract) : undefined;
}

describe('Contract.events() event inventory + selectors', () => {
  const storagerefs = (): CompilationUnit =>
    loadBuildInfo(loadFixture('storagerefs-build-info.json'));

  // '0x' + keccak256(utf8("Updated(uint256,uint256)")) — the LOG2 topic0.
  const UPDATED_SELECTOR =
    '0xd78a0cb8bb633d06981248b816e7bd33c2a35a6089241d099fa519e361cab902';

  it('lists Updated with the keccak selector of its canonical signature', () => {
    const contract = storagerefs().contract(
      'src/StorageRefs.sol',
      'StorageRefs',
    );
    expect(contract, 'StorageRefs contract must resolve').toBeDefined();

    const events = eventsOf(contract!);
    expect(events, 'Contract.events() accessor must exist').toBeDefined();

    const updated = events!.find((e) => e.name === 'Updated');
    expect(updated, 'events() must include Updated').toBeDefined();
    expect(updated!.selector).toBe(UPDATED_SELECTOR);
  });

  it('decodes Updated params: key (indexed uint256), value (non-indexed uint256)', () => {
    const contract = storagerefs().contract(
      'src/StorageRefs.sol',
      'StorageRefs',
    )!;
    const events = eventsOf(contract);
    expect(events, 'Contract.events() accessor must exist').toBeDefined();

    const updated = events!.find((e) => e.name === 'Updated');
    expect(updated, 'events() must include Updated').toBeDefined();
    expect(updated!.params).toHaveLength(2);

    const [key, value] = updated!.params;
    expect(key).toMatchObject({name: 'key', indexed: true});
    expect(value).toMatchObject({name: 'value', indexed: false});
    // Both params are uint256 — asserted loosely on whichever type field the
    // accessor carries (typeLabel 'uint256' and/or solcType 't_uint256').
    for (const p of updated!.params) {
      expect(`${p.typeLabel ?? ''} ${p.solcType ?? ''}`).toContain('uint256');
    }
  });
});
