/**
 * EVM bytecode disassembly for the DAP `disassemble` request (the Disassembly
 * View). Walks runtime bytecode into `(pc, bytes, mnemonic)` instructions,
 * consuming the inline operand of every `PUSH1..PUSH32` (`0x60..0x7f`) — the
 * same rule {@link buildInstructionIndex} uses to align pcs to instructions.
 */
import type {Hex} from '@simbolik/protocol';

/** One disassembled instruction. */
export interface EvmInstruction {
  /** Byte offset (program counter) of the opcode. */
  pc: number;
  /** The instruction's raw bytes (opcode + any PUSH operand), lowercase hex `0x…`. */
  bytes: string;
  /** Human-readable text, e.g. `PUSH1 0x80` or `SSTORE`. */
  asm: string;
}

/**
 * DAP addresses/memoryReferences are single hex numbers, but an EVM `pc` is only
 * unique WITHIN one contract — AND a contract has TWO distinct code images with
 * independent pc spaces: init (constructor) code and runtime code. We pack all
 * three into one address: an init-code flag in the high bit, the code address in
 * the middle, the pc in the low 32 (bytecode ≤ 24KB ≪ 2^32). This lets the
 * `disassemble` handler recover WHICH image to disassemble (init vs runtime) and
 * where to anchor from the reference VSCode echoes back, and keeps instruction
 * addresses globally ordered. A legacy reference without the init bit decodes as
 * runtime, so old encodings stay valid.
 */
const PC_BITS = 32n;
const PC_MASK = (1n << PC_BITS) - 1n;
const ADDR_BITS = 160n;
const ADDR_MASK = (1n << ADDR_BITS) - 1n;
/** The init-code flag sits just above the 160-bit address (bit 192). */
const INIT_BIT = PC_BITS + ADDR_BITS;

/** Pack a `(codeAddress, pc, isInit)` triple into a DAP hex address. */
export function encodeInstructionAddress(
  codeAddress: string,
  pc: number,
  isInit = false,
): string {
  const packed =
    (isInit ? 1n << INIT_BIT : 0n) +
    (BigInt(codeAddress) << PC_BITS) +
    BigInt(pc);
  return '0x' + packed.toString(16);
}

/** Unpack a DAP hex address back into its `(codeAddress, pc, isInit)` triple. */
export function decodeInstructionAddress(ref: string): {
  codeAddress: string;
  pc: number;
  isInit: boolean;
} {
  const packed = BigInt(ref);
  const pc = Number(packed & PC_MASK);
  const codeAddress =
    '0x' + ((packed >> PC_BITS) & ADDR_MASK).toString(16).padStart(40, '0');
  const isInit = ((packed >> INIT_BIT) & 1n) === 1n;
  return {codeAddress, pc, isInit};
}

/** Mnemonics for the opcodes with fixed names (PUSH/DUP/SWAP filled below). */
const NAMES: Record<number, string> = {
  0x00: 'STOP',
  0x01: 'ADD',
  0x02: 'MUL',
  0x03: 'SUB',
  0x04: 'DIV',
  0x05: 'SDIV',
  0x06: 'MOD',
  0x07: 'SMOD',
  0x08: 'ADDMOD',
  0x09: 'MULMOD',
  0x0a: 'EXP',
  0x0b: 'SIGNEXTEND',
  0x10: 'LT',
  0x11: 'GT',
  0x12: 'SLT',
  0x13: 'SGT',
  0x14: 'EQ',
  0x15: 'ISZERO',
  0x16: 'AND',
  0x17: 'OR',
  0x18: 'XOR',
  0x19: 'NOT',
  0x1a: 'BYTE',
  0x1b: 'SHL',
  0x1c: 'SHR',
  0x1d: 'SAR',
  0x20: 'KECCAK256',
  0x30: 'ADDRESS',
  0x31: 'BALANCE',
  0x32: 'ORIGIN',
  0x33: 'CALLER',
  0x34: 'CALLVALUE',
  0x35: 'CALLDATALOAD',
  0x36: 'CALLDATASIZE',
  0x37: 'CALLDATACOPY',
  0x38: 'CODESIZE',
  0x39: 'CODECOPY',
  0x3a: 'GASPRICE',
  0x3b: 'EXTCODESIZE',
  0x3c: 'EXTCODECOPY',
  0x3d: 'RETURNDATASIZE',
  0x3e: 'RETURNDATACOPY',
  0x3f: 'EXTCODEHASH',
  0x40: 'BLOCKHASH',
  0x41: 'COINBASE',
  0x42: 'TIMESTAMP',
  0x43: 'NUMBER',
  0x44: 'PREVRANDAO',
  0x45: 'GASLIMIT',
  0x46: 'CHAINID',
  0x47: 'SELFBALANCE',
  0x48: 'BASEFEE',
  0x49: 'BLOBHASH',
  0x4a: 'BLOBBASEFEE',
  0x50: 'POP',
  0x51: 'MLOAD',
  0x52: 'MSTORE',
  0x53: 'MSTORE8',
  0x54: 'SLOAD',
  0x55: 'SSTORE',
  0x56: 'JUMP',
  0x57: 'JUMPI',
  0x58: 'PC',
  0x59: 'MSIZE',
  0x5a: 'GAS',
  0x5b: 'JUMPDEST',
  0x5c: 'TLOAD',
  0x5d: 'TSTORE',
  0x5e: 'MCOPY',
  0x5f: 'PUSH0',
  0xf0: 'CREATE',
  0xf1: 'CALL',
  0xf2: 'CALLCODE',
  0xf3: 'RETURN',
  0xf4: 'DELEGATECALL',
  0xf5: 'CREATE2',
  0xfa: 'STATICCALL',
  0xfd: 'REVERT',
  0xfe: 'INVALID',
  0xff: 'SELFDESTRUCT',
};

/** Resolve a byte to its mnemonic, deriving the PUSH/DUP/SWAP/LOG families. */
function mnemonic(op: number): string {
  const known = NAMES[op];
  if (known !== undefined) return known;
  if (op >= 0x60 && op <= 0x7f) return `PUSH${op - 0x5f}`;
  if (op >= 0x80 && op <= 0x8f) return `DUP${op - 0x7f}`;
  if (op >= 0x90 && op <= 0x9f) return `SWAP${op - 0x8f}`;
  if (op >= 0xa0 && op <= 0xa4) return `LOG${op - 0xa0}`;
  // Unknown / invalid byte — show it literally so the view stays aligned.
  return `INVALID_0x${op.toString(16).padStart(2, '0')}`;
}

/**
 * Disassemble runtime/creation bytecode into an ordered instruction list. A
 * `PUSH1..PUSH32` swallows its N operand bytes (rendered as ` 0x…`); a PUSH whose
 * operand runs past the end of code is truncated to the available bytes.
 */
export function disassembleBytecode(bytecode: Hex): EvmInstruction[] {
  const hex = bytecode.startsWith('0x') ? bytecode.slice(2) : bytecode;
  const code = new Uint8Array(hex.length / 2);
  for (let i = 0; i < code.length; i++) {
    code[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  const out: EvmInstruction[] = [];
  let pc = 0;
  while (pc < code.length) {
    const op = code[pc]!;
    const asm = mnemonic(op);
    let size = 1;
    let operandText = '';
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      const operand = code.slice(pc + 1, pc + 1 + n);
      size = 1 + operand.length; // truncated at end-of-code
      operandText =
        ' 0x' +
        Array.from(operand)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
    }
    const bytes =
      '0x' +
      Array.from(code.slice(pc, pc + size))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    out.push({pc, bytes, asm: asm + operandText});
    pc += size;
  }
  return out;
}
