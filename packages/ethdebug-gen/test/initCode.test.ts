/**
 * Static analysis of constructor (init) code, on `Ctor` from
 * test/fixtures/counter/src/Ctor.sol: `constructor(a, b) CtorBase(b)`, where
 * `CtorBase`'s constructor has its own param `b` and local `doubled`.
 *
 * Legacy codegen inlines the base constructor into the derived one: its body is
 * entered by falling through from the derived prologue, so it shares the derived
 * constructor's stack frame. viaIR calls it as a separate function instead.
 */
import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {
  buildInstructionIndex,
  closestFunction,
  closestStatement,
  loadBuildInfo,
  type CompilationUnit,
} from '@simbolik/solc';

import {nodeAtEntry} from '../src/ast.js';
import {Program} from '../src/cfg.js';
import {stackHeights, variablesAt} from '../src/index.js';
import {stackDelta} from '../src/opcodes.js';

const SOURCE = 'src/Ctor.sol';

function loadCu(mode: 'legacy' | 'viair'): CompilationUnit {
  const url = new URL(
    `../../solc/test/fixtures/ctor-${mode}-build-info.json`,
    import.meta.url
  );
  return loadBuildInfo(JSON.parse(readFileSync(url, 'utf8')));
}

/** The constructor `FunctionDefinition` id of each contract in Ctor.sol. */
function constructorIds(cu: CompilationUnit): {ctor: number; base: number} {
  const program = new Program(
    cu,
    cu.contract(SOURCE, 'Ctor')!,
    stackDelta,
    'init'
  );
  const ids = new Map<string, number>();
  for (const insn of program.insns.values()) {
    const fn = insn.node ? closestFunction(insn.node) : undefined;
    const contract = fn?.parent();
    // A constructor is the (only) FunctionDefinition with an empty name.
    if (fn?.name === '' && contract?.name !== undefined) {
      ids.set(contract.name, fn.id);
    }
  }
  const ctor = ids.get('Ctor');
  const base = ids.get('CtorBase');
  if (ctor === undefined || base === undefined) {
    throw new Error('constructors not found in the init code');
  }
  return {ctor, base};
}

/** Every init pc inside a statement of either constructor body, with its function. */
function bodyPcs(cu: CompilationUnit): {pc: number; fnId: number}[] {
  const contract = cu.contract(SOURCE, 'Ctor')!;
  const {ctor, base} = constructorIds(cu);
  const {instructionToPc} = buildInstructionIndex(contract.initBytecode());
  const out: {pc: number; fnId: number}[] = [];
  contract.initSourceMap().forEach((entry, i) => {
    const node = nodeAtEntry(cu, entry);
    const fnId = node ? closestFunction(node)?.id : undefined;
    if (fnId !== ctor && fnId !== base) return;
    if (closestStatement(node!) === undefined) return;
    out.push({pc: instructionToPc[i]!, fnId});
  });
  // Both bodies must be represented, or the per-pc checks prove nothing.
  expect(new Set(out.map(x => x.fnId))).toEqual(new Set([ctor, base]));
  return out;
}

describe('init code — legacy (base constructor inlined)', () => {
  const cu = loadCu('legacy');
  const {ctor, base} = constructorIds(cu);
  const program = new Program(
    cu,
    cu.contract(SOURCE, 'Ctor')!,
    stackDelta,
    'init'
  );

  it('attributes the inlined base constructor to the derived frame', () => {
    const baseInsns = [...program.insns.values()].filter(i => i.fnId === base);
    expect(baseInsns.length).toBeGreaterThan(0);
    for (const insn of baseInsns) expect(insn.frameFnId).toBe(ctor);
    expect(program.frameEntries).toContain(program.entryByFn.get(ctor));
    expect(program.frameEntries).not.toContain(program.entryByFn.get(base));
  });

  it('has a stack height at every constructor-body pc', () => {
    const heights = stackHeights(cu, SOURCE, 'Ctor', 'init');
    for (const {pc} of bodyPcs(cu)) {
      expect({pc, h: heights.frameRelHeightAt(pc)}).toEqual({
        pc,
        h: expect.any(Number),
      });
    }
  });

  it('locates both constructors’ `b` as distinct variables', () => {
    // At every base-body pc the base's `b` (the pushed argument) is located;
    // at every derived-body pc the derived `b` is.
    for (const {pc, fnId} of bodyPcs(cu)) {
      const b = variablesAt(cu, SOURCE, 'Ctor', pc, 'init').find(
        v => v.name === 'b'
      );
      expect({pc, fnId, pointer: b?.pointer}).toEqual({
        pc,
        fnId,
        pointer: expect.objectContaining({location: 'stack'}),
      });
    }
  });
});

describe('init code — viaIR (base constructor called)', () => {
  const cu = loadCu('viair');
  const program = new Program(
    cu,
    cu.contract(SOURCE, 'Ctor')!,
    stackDelta,
    'init'
  );

  it('keeps every function in its own frame', () => {
    for (const insn of program.insns.values()) {
      expect(insn.frameFnId).toBe(insn.fnId);
    }
    expect([...program.frameEntries].sort()).toEqual(
      [...program.entryByFn.values()].sort()
    );
  });
});
