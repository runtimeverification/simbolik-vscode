/**
 * EVM disassembly for the DAP Disassembly View: the bytecode walker + the
 * (codeAddress, pc) ⇄ DAP-address codec, plus an end-to-end `disassemble`
 * request over the real Counter.setNumber trace/build-info.
 */
import {readFileSync} from 'node:fs';

import type {DebugProtocol} from '@vscode/debugprotocol';
import {describe, expect, it} from 'vitest';

import {
  disassembleBytecode,
  encodeInstructionAddress,
  decodeInstructionAddress,
  SolidityDebugSession,
  type LaunchInputs,
} from '../src/index.js';

describe('disassembleBytecode', () => {
  it('decodes opcodes and swallows PUSH operands', () => {
    // PUSH1 0x80  PUSH1 0x40  MSTORE  STOP
    const instrs = disassembleBytecode('0x60806040600055');
    expect(instrs.map((i) => i.asm)).toEqual([
      'PUSH1 0x80',
      'PUSH1 0x40',
      'PUSH1 0x00',
      'SSTORE',
    ]);
    // pcs advance by the consumed operand bytes.
    expect(instrs.map((i) => i.pc)).toEqual([0, 2, 4, 6]);
  });

  it('derives the PUSH/DUP/SWAP families and names common opcodes', () => {
    expect(disassembleBytecode('0x5f')[0]!.asm).toBe('PUSH0');
    expect(disassembleBytecode('0x80')[0]!.asm).toBe('DUP1');
    expect(disassembleBytecode('0x90')[0]!.asm).toBe('SWAP1');
    expect(disassembleBytecode('0xa0')[0]!.asm).toBe('LOG0');
    expect(disassembleBytecode('0xfd')[0]!.asm).toBe('REVERT');
  });

  it('truncates a PUSH whose operand runs past end-of-code', () => {
    // PUSH32 with only 1 operand byte available.
    const [instr] = disassembleBytecode('0x7fab');
    expect(instr!.asm).toBe('PUSH32 0xab');
    expect(instr!.bytes).toBe('0x7fab');
  });
});

describe('instruction address codec', () => {
  it('round-trips (codeAddress, pc); defaults isInit=false', () => {
    const addr = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
    const ref = encodeInstructionAddress(addr, 1234);
    const back = decodeInstructionAddress(ref);
    expect(back.codeAddress).toBe(addr);
    expect(back.pc).toBe(1234);
    expect(back.isInit).toBe(false);
  });

  it('round-trips the init-code flag and keeps the address/pc intact', () => {
    const addr = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
    const ref = encodeInstructionAddress(addr, 1234, true);
    const back = decodeInstructionAddress(ref);
    expect(back).toEqual({codeAddress: addr, pc: 1234, isInit: true});
  });

  it('gives init and runtime the SAME (addr, pc) DISTINCT references', () => {
    const addr = '0x00000000000000000000000000000000000000ff';
    const runtime = encodeInstructionAddress(addr, 42, false);
    const init = encodeInstructionAddress(addr, 42, true);
    expect(init).not.toBe(runtime);
    // A legacy (2-arg) reference decodes as runtime — back-compatible.
    expect(decodeInstructionAddress(runtime).isInit).toBe(false);
  });

  it('keeps addresses ordered by pc within a contract (per image)', () => {
    const addr = '0x00000000000000000000000000000000000000ff';
    const a = BigInt(encodeInstructionAddress(addr, 10));
    const b = BigInt(encodeInstructionAddress(addr, 11));
    expect(b).toBeGreaterThan(a);
  });
});

// --- End-to-end over the real Counter trace --------------------------------

const TRACE_RAW = readFileSync(
  new URL('./fixtures/counter-setNumber-trace.raw.json', import.meta.url),
  'utf8',
);
const BUILD_INFO_JSON: unknown = JSON.parse(
  readFileSync(
    new URL('../../solc/test/fixtures/counter-build-info.json', import.meta.url),
    'utf8',
  ),
);
const META = JSON.parse(
  readFileSync(
    new URL('./fixtures/counter-setNumber-meta.json', import.meta.url),
    'utf8',
  ),
) as {contractAddress: string};

function launchInputs(): LaunchInputs {
  return {
    buildInfoJson: BUILD_INFO_JSON,
    traceJson: TRACE_RAW,
    sourcePath: 'src/Counter.sol',
    contractName: 'Counter',
    methodName: 'setNumber',
    codeAddress: META.contractAddress,
  };
}

describe('SolidityDebugSession.disassemble', () => {
  it('gives each frame an instructionPointerReference and disassembles around it', async () => {
    const session = new SolidityDebugSession();
    await session.launch(launchInputs());

    const frame = session.stackTrace().stackFrames[0]!;
    const ref = frame.instructionPointerReference!;
    expect(ref).toBeDefined();
    // The reference decodes to the frame's own contract address.
    expect(decodeInstructionAddress(ref).codeAddress.toLowerCase()).toBe(
      META.contractAddress.toLowerCase(),
    );

    const count = 16;
    const {instructions} = session.disassemble({
      memoryReference: ref,
      instructionOffset: -4,
      instructionCount: count,
    });
    // Exactly the requested count, ordered by address.
    expect(instructions).toHaveLength(count);
    const addrs = instructions.map((i) => BigInt(i.address));
    for (let i = 1; i < addrs.length; i++) {
      expect(addrs[i]!).toBeGreaterThan(addrs[i - 1]!);
    }
    // The window contains the current instruction (its address == the IP ref).
    expect(instructions.some((i) => i.address === ref)).toBe(true);
    // Real instructions carry a mnemonic; at least one maps to Counter source.
    expect(
      instructions.every(
        (i: DebugProtocol.DisassembledInstruction) =>
          typeof i.instruction === 'string' && i.instruction.length > 0,
      ),
    ).toBe(true);
    expect(
      instructions.some((i) => i.location?.path === 'src/Counter.sol'),
    ).toBe(true);
  });
});
