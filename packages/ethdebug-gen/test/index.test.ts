import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {buildInstructionIndex, loadBuildInfo} from '@simbolik/solc';
import {Data, dereference, isPointer, Pointer} from '@ethdebug/pointers';
import type {Machine} from '@ethdebug/pointers';
import {generateEthdebugProgram} from '../src/index.js';

// Unoptimized Counter build-info (solc 0.8.35), shared with packages/solc.
const fixtureUrl = new URL(
  '../../solc/test/fixtures/counter-build-info.json',
  import.meta.url,
);
const cu = loadBuildInfo(JSON.parse(readFileSync(fixtureUrl, 'utf8')));

const SOURCE_PATH = 'src/Counter.sol';
const CONTRACT_NAME = 'Counter';

/**
 * Minimal `Machine.State` that `cursor.view` needs even for a storage pointer
 * (it touches `state.stack.length`). Every region exposes a `read`, and the
 * stack exposes `length`/`peek`, all returning zero.
 */
function mockState(): Machine.State {
  return {
    stack: {length: Promise.resolve(0n), peek: async () => Data.fromNumber(0)},
    memory: {read: async () => Data.fromNumber(0)},
    storage: {read: async () => Data.fromNumber(0)},
    calldata: {read: async () => Data.fromNumber(0)},
    returndata: {read: async () => Data.fromNumber(0)},
    transient: {read: async () => Data.fromNumber(0)},
    code: {read: async () => Data.fromNumber(0)},
  } as unknown as Machine.State;
}

describe('generateEthdebugProgram (runtime)', () => {
  it('identifies the contract and defaults to the runtime kind', () => {
    const program = generateEthdebugProgram(cu, SOURCE_PATH, CONTRACT_NAME);
    expect(program.contract).toBe('src/Counter.sol:Counter');
    expect(program.kind).toBe('runtime');
  });

  it('emits exactly one storage variable with an ethdebug pointer', () => {
    const program = generateEthdebugProgram(cu, SOURCE_PATH, CONTRACT_NAME);
    expect(program.storageVariables).toEqual([
      {
        name: 'number',
        astId: 3,
        solcType: 't_uint256',
        slot: 0,
        offset: 0,
        length: 32,
        pointer: {location: 'storage', slot: 0, offset: 0, length: 32},
      },
    ]);
  });

  it('aligns the instruction stream 1:1 with the runtime source map, excluding the metadata trailer', () => {
    const program = generateEthdebugProgram(cu, SOURCE_PATH, CONTRACT_NAME);
    const contract = cu.contract(SOURCE_PATH, CONTRACT_NAME)!;
    const sourceMap = contract.runtimeSourceMap();
    const {instructionToPc} = buildInstructionIndex(contract.runtimeBytecode());

    // The raw disassembly runs past the source map, because the CBOR metadata
    // trailer decodes as bogus instruction starts (302 raw starts vs 271
    // source-map entries for this fixture). The program must exclude it.
    expect(sourceMap.length).toBeLessThan(instructionToPc.length);

    // The stream aligns 1:1 with the source map, not with the full
    // disassembly; walking buildInstructionIndex would emit the ~31 trailer
    // instructions.
    expect(program.instructions.length).toBe(sourceMap.length);

    // The last emitted instruction is the last source-mapped instruction, at
    // its real pc; nothing from the metadata trailer leaks in.
    const last = program.instructions.at(-1)!;
    expect(last.instructionIndex).toBe(sourceMap.length - 1);
    expect(last.pc).toBe(instructionToPc[sourceMap.length - 1]!);
    // `last.source` is not asserted: here the last source-map entry has
    // fileId 1 (a solc-internal source absent from output.sources), so it is
    // undefined.
  });

  it('maps the first runtime instruction to its source range', () => {
    const program = generateEthdebugProgram(cu, SOURCE_PATH, CONTRACT_NAME);
    expect(program.instructions.length).toBeGreaterThan(0);

    const first = program.instructions[0]!;
    expect(first.pc).toBe(0);
    expect(first.instructionIndex).toBe(0);
    // First runtime byte of the Counter deployed bytecode is PUSH1 (0x60).
    expect(first.op).toBe(0x60);
    // First runtime source-map entry is `58:203:0`; offset 58 is line 4, col 0.
    expect(first.source).toEqual({
      fileId: 0,
      start: 58,
      length: 203,
      line: 4,
      column: 0,
    });
  });

  it('resolves every source to the single source file (fileId 0)', () => {
    const program = generateEthdebugProgram(cu, SOURCE_PATH, CONTRACT_NAME);
    for (const instruction of program.instructions) {
      if (instruction.source !== undefined) {
        expect(instruction.source.fileId).toBe(0);
      }
    }
  });
});

describe('conformance: @ethdebug/pointers consumes the generated pointer', () => {
  it('recognizes the storage pointer as a storage region pointer', () => {
    const program = generateEthdebugProgram(cu, SOURCE_PATH, CONTRACT_NAME);
    const {pointer} = program.storageVariables[0]!;
    expect(isPointer(pointer)).toBe(true);
    expect(Pointer.Region.isStorage(pointer)).toBe(true);
  });

  it('dereferences to a single storage region at slot 0, offset 0, length 32', async () => {
    const program = generateEthdebugProgram(cu, SOURCE_PATH, CONTRACT_NAME);
    const {pointer} = program.storageVariables[0]!;

    const cursor = await dereference(pointer);
    const {regions} = await cursor.view(mockState());

    expect(regions.length).toBe(1);
    expect(regions[0]!.slot.asUint()).toBe(0n);
    expect(regions[0]!.offset.asUint()).toBe(0n);
    expect(regions[0]!.length.asUint()).toBe(32n);
  });
});

describe('generateEthdebugProgram (init)', () => {
  it('derives init-code instructions from the init source map', () => {
    const program = generateEthdebugProgram(
      cu,
      SOURCE_PATH,
      CONTRACT_NAME,
      'init',
    );
    expect(program.kind).toBe('init');

    const contract = cu.contract(SOURCE_PATH, CONTRACT_NAME)!;
    const initSourceMap = contract.initSourceMap();
    const {instructionToPc} = buildInstructionIndex(contract.initBytecode());

    // Init code embeds the runtime code + metadata as data (CODECOPY), so the
    // raw disassembly is far longer than the creation source map; the stream
    // must still align 1:1 with the source map.
    expect(initSourceMap.length).toBeLessThan(instructionToPc.length);
    expect(program.instructions.length).toBe(initSourceMap.length);
    expect(program.instructions[0]!.pc).toBe(0);
    expect(program.instructions[0]!.instructionIndex).toBe(0);
  });
});
