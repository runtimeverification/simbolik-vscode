/**
 * Static function input-parameter inventory.
 *
 * `functionParameters` returns a {@link ParamDescriptor} per input parameter
 * in declaration order: name, index, display type, byte width and
 * value-type-ness. Fixtures: unoptimized build-info (solc 0.8.35).
 *
 * Expected, from the source AST:
 *   - Stepper.double(uint256 v)          → [v: uint256/32]
 *   - Stepper.run(uint256 x)             → [x: uint256/32]
 *   - Vars.setAll(uint8,uint16,bool,address,int256,bytes32,Color)
 *                                        → 7 value-type descriptors, in order
 */
import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {loadBuildInfo, type CompilationUnit} from '@simbolik/solc';

import {functionParameters} from '../src/index.js';

function loadCu(name: string): CompilationUnit {
  const url = new URL(`../../solc/test/fixtures/${name}`, import.meta.url);
  return loadBuildInfo(JSON.parse(readFileSync(url, 'utf8')));
}

const stepper = (): CompilationUnit => loadCu('stepper-build-info.json');
const vars = (): CompilationUnit => loadCu('vars-build-info.json');

// ## Stepper.double(uint256 v): the internal, stack-param function

describe('functionParameters — Stepper.double', () => {
  it('returns exactly one uint256 value-type descriptor for v', () => {
    const params = functionParameters(
      stepper(),
      'src/Stepper.sol',
      'Stepper',
      'double',
    );
    expect(params).toHaveLength(1);
    expect(params[0]).toMatchObject({
      name: 'v',
      index: 0,
      typeLabel: 'uint256',
      numberOfBytes: 32,
      isValueType: true,
    });
  });
});

// ## Stepper.run(uint256 x): the external entry function

describe('functionParameters — Stepper.run', () => {
  it('returns exactly one uint256 value-type descriptor for x', () => {
    const params = functionParameters(
      stepper(),
      'src/Stepper.sol',
      'Stepper',
      'run',
    );
    expect(params).toHaveLength(1);
    expect(params[0]).toMatchObject({
      name: 'x',
      index: 0,
      typeLabel: 'uint256',
      numberOfBytes: 32,
      isValueType: true,
    });
  });
});

// ## Vars.setAll(...): all 7 value types, in declaration order

describe('functionParameters — Vars.setAll (7 value types)', () => {
  it('returns 7 descriptors in declaration order with correct name/index', () => {
    const params = functionParameters(vars(), 'src/Vars.sol', 'Vars', 'setAll');
    expect(params).toHaveLength(7);
    expect(params.map((p) => p.name)).toEqual([
      '_a',
      '_b',
      '_flag',
      '_owner',
      '_delta',
      '_h',
      '_color',
    ]);
    expect(params.map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('maps each value type to its label + byte width', () => {
    const params = functionParameters(vars(), 'src/Vars.sol', 'Vars', 'setAll');
    const byName = new Map(params.map((p) => [p.name, p]));

    expect(byName.get('_a')).toMatchObject({typeLabel: 'uint8', numberOfBytes: 1});
    expect(byName.get('_b')).toMatchObject({
      typeLabel: 'uint16',
      numberOfBytes: 2,
    });
    expect(byName.get('_flag')).toMatchObject({
      typeLabel: 'bool',
      numberOfBytes: 1,
    });
    expect(byName.get('_owner')).toMatchObject({
      typeLabel: 'address',
      numberOfBytes: 20,
    });
    expect(byName.get('_delta')).toMatchObject({
      typeLabel: 'int256',
      numberOfBytes: 32,
    });
    expect(byName.get('_h')).toMatchObject({
      typeLabel: 'bytes32',
      numberOfBytes: 32,
    });

    // The enum param: typeLabel carries the enum name (`Color` or the
    // fully-qualified `enum Vars.Color`); it is a single-byte value type.
    const color = byName.get('_color')!;
    expect(color.typeLabel).toContain('Color');
    expect(color.numberOfBytes).toBe(1);
  });

  it('marks every setAll param as a value type', () => {
    // setAll has only value-type parameters; reference-type parameters are
    // not covered by this fixture.
    const params = functionParameters(vars(), 'src/Vars.sol', 'Vars', 'setAll');
    for (const p of params) {
      expect(p.isValueType).toBe(true);
    }
  });
});
