/**
 * Static function LOCAL-variable inventory.
 *
 * `functionLocals(cu, sourcePath, contractName, methodName)` returns, in
 * declaration (source) order, a {@link LocalDescriptor} per local variable of a
 * function body — every value type, plus reference-type locals (marked
 * `isValueType: false` so the debugger skips DECODING them while still counting
 * their stack slot). Each descriptor also carries the lexical live-range
 * (`declEnd`/`scopeStart`/`scopeEnd`) the debugger uses to decide which locals are
 * in scope at a given source offset.
 *
 * Pinned against the real unoptimized build-info fixture (solc 0.8.35):
 * `Locals.compute` declares — in order —
 *   a, small, signed, flag, who, hash, color, sum (value types),
 *   nums (uint256[]), label (string), pt (struct) (reference types),
 *   tail (value), and — inside nested scopes — i (for-init), step (loop body),
 *   inner (block).
 */
import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {loadBuildInfo, type CompilationUnit} from '@simbolik/solc';

import {functionLocals, type LocalDescriptor} from '../src/index.js';

function loadCu(name: string): CompilationUnit {
  const url = new URL(`../../solc/test/fixtures/${name}`, import.meta.url);
  return loadBuildInfo(JSON.parse(readFileSync(url, 'utf8')));
}

const locals = (): LocalDescriptor[] =>
  functionLocals(loadCu('locals-build-info.json'), 'src/Locals.sol', 'Locals', 'compute');

describe('functionLocals — Locals.compute inventory', () => {
  it('lists every local in declaration (source) order', () => {
    expect(locals().map((l) => l.name)).toEqual([
      'a',
      'small',
      'signed',
      'flag',
      'who',
      'hash',
      'color',
      'sum',
      'nums',
      'label',
      'pt',
      'tail',
      'i',
      'step',
      'inner',
    ]);
  });

  it('assigns a contiguous 0-based declaration index', () => {
    expect(locals().map((l) => l.index)).toEqual(
      Array.from({length: 15}, (_, i) => i),
    );
  });

  it('maps every value-type local to its label + byte width', () => {
    const byName = new Map(locals().map((l) => [l.name, l]));
    expect(byName.get('a')).toMatchObject({
      typeLabel: 'uint256',
      numberOfBytes: 32,
      isValueType: true,
    });
    expect(byName.get('small')).toMatchObject({
      typeLabel: 'uint8',
      numberOfBytes: 1,
      isValueType: true,
    });
    expect(byName.get('signed')).toMatchObject({
      typeLabel: 'int256',
      numberOfBytes: 32,
      isValueType: true,
    });
    expect(byName.get('flag')).toMatchObject({
      typeLabel: 'bool',
      numberOfBytes: 1,
      isValueType: true,
    });
    expect(byName.get('who')).toMatchObject({
      typeLabel: 'address',
      numberOfBytes: 20,
      isValueType: true,
    });
    expect(byName.get('hash')).toMatchObject({
      typeLabel: 'bytes32',
      numberOfBytes: 32,
      isValueType: true,
    });
    expect(byName.get('color')!.typeLabel).toContain('Color');
    expect(byName.get('color')).toMatchObject({
      numberOfBytes: 1,
      isValueType: true,
    });
  });

  it('marks reference-type locals isValueType:false (decoding not attempted)', () => {
    const byName = new Map(locals().map((l) => [l.name, l]));
    for (const name of ['nums', 'label', 'pt']) {
      expect(byName.get(name)).toMatchObject({
        isValueType: false,
        numberOfBytes: 0,
      });
    }
    expect(byName.get('nums')!.typeLabel).toContain('uint256[]');
    expect(byName.get('label')!.typeLabel).toBe('string');
    expect(byName.get('pt')!.typeLabel).toContain('Point');
  });

  it('scopes function-body locals to the whole body but loop/block locals narrowly', () => {
    const byName = new Map(locals().map((l) => [l.name, l]));
    const a = byName.get('a')!;
    const step = byName.get('step')!;
    const inner = byName.get('inner')!;

    // The loop-body local `step` and the block local `inner` have STRICTLY
    // narrower lexical scopes than a function-body local like `a`.
    expect(step.scopeStart).toBeGreaterThan(a.scopeStart);
    expect(step.scopeEnd).toBeLessThan(a.scopeEnd);
    expect(inner.scopeStart).toBeGreaterThan(a.scopeStart);
    expect(inner.scopeEnd).toBeLessThan(a.scopeEnd);

    // `step` (loop body) and `inner` (a later, disjoint block) do not overlap.
    expect(inner.scopeStart).toBeGreaterThanOrEqual(step.scopeEnd);

    // A local becomes live only after its declaration statement ends.
    expect(a.declEnd).toBeGreaterThan(a.scopeStart);
  });

  it('throws for an unknown method', () => {
    expect(() =>
      functionLocals(loadCu('locals-build-info.json'), 'src/Locals.sol', 'Locals', 'nope'),
    ).toThrow();
  });
});
