import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import type {Hex} from '@simbolik/protocol';
import {
  buildInstructionIndex,
  loadBuildInfo,
  parseSourceMap,
  sourceMapEntryAtPc,
} from '../src/index.js';

function loadFixture(name: string): unknown {
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as unknown;
}

describe('parseSourceMap — field inheritance', () => {
  it('decodes a hand-written map with empty (inherited) entries', () => {
    // ["58:203:0:-:0", "", "", "109:80"]
    const entries = parseSourceMap('58:203:0:-:0;;;109:80');
    expect(entries).toHaveLength(4);
    expect(entries[0]).toEqual({
      start: 58,
      length: 203,
      fileId: 0,
      jump: '-',
      modifierDepth: 0,
    });
    // Empty entries inherit the previous entry verbatim.
    expect(entries[1]).toEqual(entries[0]);
    expect(entries[2]).toEqual(entries[0]);
    // Only s and l are given; f, j, m inherit from entry 0.
    expect(entries[3]).toEqual({
      start: 109,
      length: 80,
      fileId: 0,
      jump: '-',
      modifierDepth: 0,
    });
  });

  it('handles f=-1, jump i/o/-, and modifier-depth inheritance', () => {
    // entry0: all fields; entry1: f=0,j=o (s,l,m inherited); entry2: j=-,m=5 (s,l,f inherited)
    const entries = parseSourceMap('10:20:-1:i:2;::0:o;:::-:5');
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({
      start: 10,
      length: 20,
      fileId: -1,
      jump: 'i',
      modifierDepth: 2,
    });
    expect(entries[1]).toEqual({
      start: 10,
      length: 20,
      fileId: 0,
      jump: 'o',
      modifierDepth: 2,
    });
    expect(entries[2]).toEqual({
      start: 10,
      length: 20,
      fileId: 0,
      jump: '-',
      modifierDepth: 5,
    });
  });
});

describe('parseSourceMap — real runtime source map', () => {
  const runtimeMap = () =>
    (
      loadFixture('counter-build-info.json') as {
        output: {
          contracts: Record<
            string,
            Record<string, {evm: {deployedBytecode: {sourceMap: string}}}>
          >;
        };
      }
    ).output.contracts['src/Counter.sol']!['Counter']!.evm.deployedBytecode
      .sourceMap;

  it('decodes 271 entries; entry 0 is the ContractDefinition range 58:203', () => {
    const entries = parseSourceMap(runtimeMap());
    expect(entries).toHaveLength(271);
    expect(entries[0]).toEqual({
      start: 58,
      length: 203,
      fileId: 0,
      jump: '-',
      modifierDepth: 0,
    });
  });

  it('carries a jump-in entry for the setNumber body (109:80) and a fileId 1 entry', () => {
    const entries = parseSourceMap(runtimeMap());
    // First 'jump in' entry points at the setNumber function range 109:80.
    expect(entries[54]).toEqual({
      start: 109,
      length: 80,
      fileId: 0,
      jump: 'i',
      modifierDepth: 0,
    });
    // First 'jump out'.
    expect(entries[94]!.jump).toBe('o');
    // solc utility code is attributed to a synthetic second source (fileId 1).
    expect(entries[116]!.fileId).toBe(1);
  });
});

describe('buildInstructionIndex — PUSH data skipping (synthetic)', () => {
  it('maps only instruction starts for 0x6001600100 (PUSH1 1; PUSH1 1; STOP)', () => {
    // Bytes: 60 01 | 60 01 | 00
    //   pc0 = PUSH1 (instr 0), pc1 = immediate data (no instruction)
    //   pc2 = PUSH1 (instr 1), pc3 = immediate data (no instruction)
    //   pc4 = STOP  (instr 2)
    const {pcToInstruction, instructionToPc} = buildInstructionIndex(
      '0x6001600100' as Hex,
    );
    expect(instructionToPc).toEqual([0, 2, 4]);
    expect(pcToInstruction.get(0)).toBe(0);
    expect(pcToInstruction.get(2)).toBe(1);
    expect(pcToInstruction.get(4)).toBe(2);
    // PUSH immediate data bytes are NOT instruction starts.
    expect(pcToInstruction.get(1)).toBeUndefined();
    expect(pcToInstruction.get(3)).toBeUndefined();
  });

  it('skips all immediate bytes of a multi-byte push (0x61000100 = PUSH2 0x0001; STOP)', () => {
    // Bytes: 61 00 01 | 00
    //   pc0 = PUSH2 (instr 0), pc1+pc2 = immediate data, pc3 = STOP (instr 1)
    const {pcToInstruction, instructionToPc} = buildInstructionIndex(
      '0x61000100' as Hex,
    );
    expect(instructionToPc).toEqual([0, 3]);
    expect(pcToInstruction.get(0)).toBe(0);
    expect(pcToInstruction.get(3)).toBe(1);
    expect(pcToInstruction.get(1)).toBeUndefined();
    expect(pcToInstruction.get(2)).toBeUndefined();
  });
});

describe('buildInstructionIndex / sourceMapEntryAtPc — real runtime bytecode', () => {
  const contract = () =>
    loadBuildInfo(loadFixture('counter-build-info.json')).contract(
      'src/Counter.sol',
      'Counter',
    )!;

  it('maps pc 0 to instruction 0; the runtime starts PUSH1 0x80 so instr 1 is at pc 2', () => {
    const {pcToInstruction, instructionToPc} = buildInstructionIndex(
      contract().runtimeBytecode(),
    );
    expect(pcToInstruction.get(0)).toBe(0);
    expect(instructionToPc[0]).toBe(0);
    expect(instructionToPc[1]).toBe(2);
    // pc 1 is the immediate 0x80 of the leading PUSH1.
    expect(pcToInstruction.get(1)).toBeUndefined();
  });

  it('sourceMapEntryAtPc(pc 0, runtime) is the ContractDefinition range 58:203', () => {
    const entry = sourceMapEntryAtPc(contract(), 0, 'runtime');
    expect(entry).toEqual({
      start: 58,
      length: 203,
      fileId: 0,
      jump: '-',
      modifierDepth: 0,
    });
  });

  it('sourceMapEntryAtPc(pc 0, init) is the ContractDefinition range 58:203', () => {
    const entry = sourceMapEntryAtPc(contract(), 0, 'init');
    expect(entry).toEqual({
      start: 58,
      length: 203,
      fileId: 0,
      jump: '-',
      modifierDepth: 0,
    });
  });

  it('returns undefined for a pc that lands inside PUSH immediate data', () => {
    expect(sourceMapEntryAtPc(contract(), 1, 'runtime')).toBeUndefined();
  });
});
