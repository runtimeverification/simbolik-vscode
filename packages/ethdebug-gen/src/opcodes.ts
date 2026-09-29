/**
 * EVM opcode facts shared by the static stack analyzers ({@link stackHeights},
 * {@link stackProvenance}).
 *
 * Arities are keyed off the bytecode BYTES (not kontrol trace op-names, which
 * differ: PUSHZERO=PUSH0, EVMOR=OR — naming never changes stack DEPTH). The net
 * deltas derived here were validated against recorded traces with 0 mismatches
 * over 964 same-depth transitions.
 */

export const JUMP = 0x56;
export const JUMPI = 0x57;
export const JUMPDEST = 0x5b;
export const PUSH0 = 0x5f;
export const AND = 0x16;

/** PUSH1..PUSH32 (`0x60..0x7f`): opcodes carrying immediate bytes. */
export function isPushN(op: number): boolean {
  return op >= 0x60 && op <= 0x7f;
}

/** DUP1..DUP16 (`0x80..0x8f`). */
export function isDup(op: number): boolean {
  return op >= 0x80 && op <= 0x8f;
}

/** SWAP1..SWAP16 (`0x90..0x9f`). */
export function isSwap(op: number): boolean {
  return op >= 0x90 && op <= 0x9f;
}

/**
 * Precise `{in, out}` stack arity of a straight-line opcode (NOT push/dup/swap,
 * which are handled specially). Unlike a net delta, the separate input count is
 * what lets a consumed slot be dropped and each result be freshly value-numbered
 * — e.g. `ISZERO`/`NOT` (in 1, out 1) must give the top a new origin even though
 * their net delta is 0.
 */
export function stackInOut(op: number): {nIn: number; nOut: number} {
  if (op >= 0xa0 && op <= 0xa4) {
    return {nIn: 2 + (op - 0xa0), nOut: 0}; // LOG0..LOG4
  }
  switch (op) {
    // Binary arithmetic / comparison / bitwise: pop 2, push 1.
    case 0x01: // ADD
    case 0x02: // MUL
    case 0x03: // SUB
    case 0x04: // DIV
    case 0x05: // SDIV
    case 0x06: // MOD
    case 0x07: // SMOD
    case 0x0a: // EXP
    case 0x0b: // SIGNEXTEND
    case 0x10: // LT
    case 0x11: // GT
    case 0x12: // SLT
    case 0x13: // SGT
    case 0x14: // EQ
    case 0x16: // AND
    case 0x17: // OR
    case 0x18: // XOR
    case 0x1a: // BYTE
    case 0x1b: // SHL
    case 0x1c: // SHR
    case 0x1d: // SAR
    case 0x20: // KECCAK256
      return {nIn: 2, nOut: 1};
    // Unary: pop 1, push 1.
    case 0x15: // ISZERO
    case 0x19: // NOT
      return {nIn: 1, nOut: 1};
    // Ternary arithmetic: pop 3, push 1.
    case 0x08: // ADDMOD
    case 0x09: // MULMOD
      return {nIn: 3, nOut: 1};
    // Load-from-1: pop 1, push 1.
    case 0x51: // MLOAD
    case 0x54: // SLOAD
    case 0x5c: // TLOAD
    case 0x31: // BALANCE
    case 0x3b: // EXTCODESIZE
    case 0x3f: // EXTCODEHASH
    case 0x35: // CALLDATALOAD
    case 0x40: // BLOCKHASH
    case 0x49: // BLOBHASH
      return {nIn: 1, nOut: 1};
    // Store: pop 2.
    case 0x52: // MSTORE
    case 0x53: // MSTORE8
    case 0x55: // SSTORE
    case 0x5d: // TSTORE
      return {nIn: 2, nOut: 0};
    case 0x50: // POP
      return {nIn: 1, nOut: 0};
    case 0x56: // JUMP: pop dest.
      return {nIn: 1, nOut: 0};
    case 0x57: // JUMPI: pop dest + cond.
      return {nIn: 2, nOut: 0};
    case 0x5b: // JUMPDEST
    case 0x00: // STOP
    case 0xfe: // INVALID
      return {nIn: 0, nOut: 0};
    // Nullary pushes (env/state): push 1.
    case 0x30: // ADDRESS
    case 0x32: // ORIGIN
    case 0x33: // CALLER
    case 0x34: // CALLVALUE
    case 0x36: // CALLDATASIZE
    case 0x38: // CODESIZE
    case 0x3a: // GASPRICE
    case 0x3d: // RETURNDATASIZE
    case 0x41: // COINBASE
    case 0x42: // TIMESTAMP
    case 0x43: // NUMBER
    case 0x44: // PREVRANDAO
    case 0x45: // GASLIMIT
    case 0x46: // CHAINID
    case 0x47: // SELFBALANCE
    case 0x48: // BASEFEE
    case 0x4a: // BLOBBASEFEE
    case 0x58: // PC
    case 0x59: // MSIZE
    case 0x5a: // GAS
      return {nIn: 0, nOut: 1};
    // Copies: pop 3 (destOffset, offset, size).
    case 0x37: // CALLDATACOPY
    case 0x39: // CODECOPY
    case 0x3e: // RETURNDATACOPY
    case 0x5e: // MCOPY
      return {nIn: 3, nOut: 0};
    case 0x3c: // EXTCODECOPY: pop 4.
      return {nIn: 4, nOut: 0};
    case 0xf0: // CREATE: pop 3, push 1.
      return {nIn: 3, nOut: 1};
    case 0xf5: // CREATE2: pop 4, push 1.
      return {nIn: 4, nOut: 1};
    case 0xf1: // CALL: pop 7, push 1.
    case 0xf2: // CALLCODE
      return {nIn: 7, nOut: 1};
    case 0xf4: // DELEGATECALL: pop 6, push 1.
    case 0xfa: // STATICCALL
      return {nIn: 6, nOut: 1};
    case 0xf3: // RETURN: pop 2.
    case 0xfd: // REVERT
      return {nIn: 2, nOut: 0};
    case 0xff: // SELFDESTRUCT: pop 1.
      return {nIn: 1, nOut: 0};
    default:
      // Unknown opcode: conservatively clear the top and push one fresh result so
      // a value identity can never leak through an unmodelled op.
      return {nIn: 1, nOut: 1};
  }
}

/** Net stack effect (`pushed − popped`) of an opcode, consistent with {@link stackInOut}. */
export function stackDelta(op: number): number {
  if (op === PUSH0 || isPushN(op)) return 1;
  if (isDup(op)) return 1;
  if (isSwap(op)) return 0;
  const {nIn, nOut} = stackInOut(op);
  return nOut - nIn;
}

/** Opcodes that end a basic block with no in-frame fall-through successor. */
export function isBlockTerminator(op: number): boolean {
  return (
    op === 0x00 || // STOP
    op === 0xf3 || // RETURN
    op === 0xfd || // REVERT
    op === 0xfe || // INVALID
    op === 0xff // SELFDESTRUCT
  );
}

/** Opcodes after which the next instruction starts a new basic block. */
export function endsBlock(op: number): boolean {
  return op === JUMP || op === JUMPI || isBlockTerminator(op);
}

/** Decode a `0x`-prefixed hex string to bytes. */
export function hexToBytes(hex: string): Uint8Array {
  const body = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(body.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(body.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
