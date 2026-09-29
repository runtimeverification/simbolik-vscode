/**
 * Detect + decode kontrol/Foundry CHEATCODE calls in an execution trace.
 *
 * kontrol-node executes a cheatcode (`vm.startPrank`, `vm.stopPrank`, …) as an
 * ATOMIC, plain EVM CALL to the well-known cheatcode address
 * `0x7109709ECfa91a80626fF3989D68f67F5b1DD12D`: a single CALL step whose
 * calldata is the ABI encoding `<4-byte selector><32-byte-word args…>`, with the
 * effect applied inline (no observable sub-trace to descend into). That makes a
 * cheatcode a self-contained event of ONE step — we recognise it by its target
 * address, read its calldata straight out of EVM memory, map the selector to a
 * known cheatcode signature, and decode the value-type args.
 *
 * The selector→signature table is built AT MODULE LOAD by keccak256-hashing a
 * list of canonical signatures (never hand-typed hex), so the selectors are
 * correct by construction and new cheatcodes are added by listing their
 * signature. Decoding is table-driven off the parsed arg-type list.
 *
 * Scope covers value-type args (`address`, `uintN`, `intN`, `bool`, `bytesN`)
 * AND the dynamic scalars `bytes` / `string` (4c): a dynamic arg's head word is
 * an ABI OFFSET (relative to the post-selector arg-data region) pointing at a
 * 32-byte length followed by the data bytes, which are read + zero-extended and
 * decoded to their real value. Other reference types (`*[]`, tuples) are still
 * rendered as a `<type>` placeholder (out of scope). An unknown selector on a
 * genuine cheatcode CALL still decodes to a raw-selector `DecodedCheatcode`
 * (never `undefined`) so the frame stays useful for cheatcodes not yet in the
 * table.
 */
import {keccak256} from 'ethereum-cryptography/keccak';
import {
  bytesToHex,
  bytesToUtf8,
  hexToBytes,
  utf8ToBytes,
} from 'ethereum-cryptography/utils';

import type {Step} from '@simbolik/lifting';

import {addressHex, wordToBigInt} from './hex.js';

/** The well-known cheatcode target address (lowercase 0x form, 42 chars). */
export const CHEATCODE_ADDRESS = '0x7109709ecfa91a80626ff3989d68f67f5b1dd12d';

/** The cheatcode address as a bigint, for masked stack comparison. */
const CHEATCODE_ADDRESS_INT = BigInt(CHEATCODE_ADDRESS);

/** The low-160-bit mask that turns a 256-bit stack word into an address. */
const ADDRESS_MASK = (1n << 160n) - 1n;

/** The EVM ops that transfer control to a callee via a target address word. */
const CALL_OPS = new Set(['CALL', 'CALLCODE', 'DELEGATECALL', 'STATICCALL']);

/** A decoded cheatcode invocation. */
export interface DecodedCheatcode {
  /** `'0x'` + 8 hex — the 4-byte function selector. */
  selector: string;
  /** The cheatcode name, e.g. `startPrank` (raw selector if unknown). */
  name: string;
  /** The canonical signature, e.g. `startPrank(address)` (raw selector if unknown). */
  signature: string;
  /** Decoded value-type args; an `address` is `'0x'` + 40 lowercase hex. */
  args: string[];
  /** Human display string, e.g. `startPrank(0xdeadbeef…deadbeef)`. */
  display: string;
}

/** A parsed cheatcode entry: name + ordered arg types for table-driven decode. */
interface CheatcodeDef {
  name: string;
  signature: string;
  argTypes: string[];
}

/**
 * Canonical cheatcode signatures. Selectors are COMPUTED from these at load via
 * keccak256 (see {@link buildSelectorTable}) — do NOT hand-type hex selectors.
 * A useful starter set of common Foundry/kontrol cheatcodes.
 */
const CHEATCODE_SIGNATURES = [
  'startPrank(address)',
  'startPrank(address,address)',
  'stopPrank()',
  'prank(address)',
  'prank(address,address)',
  'deal(address,uint256)',
  'warp(uint256)',
  'roll(uint256)',
  'load(address,bytes32)',
  'store(address,bytes32,bytes32)',
  'etch(address,bytes)',
  'mockCall(address,bytes,bytes)',
  'expectRevert()',
  'expectRevert(bytes4)',
  'assume(bool)',
  'assertTrue(bool)',
  'assertEq(uint256,uint256)',
  'label(address,string)',
];

/** Parse a canonical signature `name(t1,t2,…)` into its name + arg-type list. */
function parseSignature(signature: string): CheatcodeDef {
  const open = signature.indexOf('(');
  const name = signature.slice(0, open);
  const inner = signature.slice(open + 1, signature.lastIndexOf(')')).trim();
  const argTypes = inner === '' ? [] : inner.split(',').map((t) => t.trim());
  return {name, signature, argTypes};
}

/** The 4-byte selector (`'0x'` + 8 hex) of a canonical signature. */
function selectorOf(signature: string): string {
  const hash = bytesToHex(keccak256(utf8ToBytes(signature)));
  return '0x' + hash.slice(0, 8);
}

/** Build the selector→def table by keccak-hashing every canonical signature. */
function buildSelectorTable(): Map<string, CheatcodeDef> {
  const table = new Map<string, CheatcodeDef>();
  for (const signature of CHEATCODE_SIGNATURES) {
    table.set(selectorOf(signature), parseSignature(signature));
  }
  return table;
}

/** selector (`'0x'`+8 hex) → parsed cheatcode def. Computed once at load. */
const SELECTOR_TABLE = buildSelectorTable();

/** Parse a machine WORD (hex, optionally `0x`-prefixed) to a number. */
function wordToNumber(word: string): number {
  return Number(wordToBigInt(word));
}

/**
 * Read exactly `lenChars` hex chars from `hex` starting at char `startChar`,
 * ZERO-EXTENDING (right-padding with `'0'`) when the source runs short. Real EVM
 * memory is conceptually zero to infinity, so a dynamic offset/length that runs
 * past the available flattened memory reads zero bytes rather than crashing.
 */
function readHex(hex: string, startChar: number, lenChars: number): string {
  return hex.slice(startChar, startChar + lenChars).padEnd(lenChars, '0');
}

/**
 * Whether `step` is a CALL to the cheatcode address. True iff `step.op` is a
 * CALL-family op AND the target word (`stack[len-2]`, low 160 bits) equals the
 * cheatcode address. Safe (false) when the stack is too short.
 */
export function isCheatcodeCall(step: Step): boolean {
  if (!CALL_OPS.has(step.op)) return false;
  const len = step.stack.length;
  if (len < 2) return false;
  const target = BigInt(step.stack[len - 2]!) & ADDRESS_MASK;
  return target === CHEATCODE_ADDRESS_INT;
}

/**
 * Decode a cheatcode CALL step into its selector, name, args, and display
 * string, reading the calldata from `machine.memory` (a `StateCursor.at(i)`
 * MachineState — an array of 32-byte hex WORDS). Returns `undefined` ONLY when
 * `step` is not a cheatcode call; an unknown selector still decodes to a
 * raw-selector `DecodedCheatcode`.
 *
 * The calldata byte range is op-specific: CALL/CALLCODE take
 * `argsOff=stack[len-4]`, `argsLen=stack[len-5]`; STATICCALL/DELEGATECALL (no
 * value word) take `argsOff=stack[len-3]`, `argsLen=stack[len-4]`.
 */
export function decodeCheatcodeCall(
  step: Step,
  machine: {memory: string[]},
): DecodedCheatcode | undefined {
  if (!isCheatcodeCall(step)) return undefined;

  const st = step.stack;
  const len = st.length;
  const hasValue = step.op === 'CALL' || step.op === 'CALLCODE';
  const argsOff = wordToNumber(st[len - (hasValue ? 4 : 3)]!);
  const argsLen = wordToNumber(st[len - (hasValue ? 5 : 4)]!);

  // calldata = folded memory byte-slice [argsOff, argsOff+argsLen). Memory is a
  // 32-byte-WORD array: flatten (each word padded to a full word) then slice.
  const flat = machine.memory
    .map((w) => w.replace(/^0x/, '').padStart(64, '0'))
    .join('');
  const calldata = flat.slice(argsOff * 2, (argsOff + argsLen) * 2);
  const selector = '0x' + calldata.slice(0, 8);

  const def = SELECTOR_TABLE.get(selector);
  if (def === undefined) {
    // Genuine cheatcode call, selector not in the table — keep it useful.
    return {
      selector,
      name: selector,
      signature: `${selector}(...)`,
      args: [],
      display: `${selector}(…)`,
    };
  }

  // The arg-data region is everything AFTER the 4-byte (8-hex) selector; every
  // ABI offset for a dynamic arg is measured from the START of this region.
  const argData = calldata.slice(8);

  // Each arg occupies one 32-byte HEAD word at position i. A value arg holds its
  // value inline; a dynamic arg (`bytes`/`string`) holds an OFFSET into argData
  // where a 32-byte length then that many data bytes sit. Reads are zero-extended
  // past the available memory so malformed/short input never crashes or NaNs.
  const args: string[] = [];
  const displayArgs: string[] = [];
  for (let i = 0; i < def.argTypes.length; i++) {
    const argType = def.argTypes[i]!;
    const headHex = readHex(argData, i * 64, 64);
    if (argType === 'bytes' || argType === 'string') {
      const offset = Number(BigInt('0x' + headHex));
      const rawLength = Number(BigInt('0x' + readHex(argData, offset * 2, 64)));
      // A dynamic arg's data lives WITHIN the arg-data region; a corrupt or
      // hostile length word (up to 2^256-1) must never drive a giant slice or
      // allocation that hangs/crashes the debugger. Bound the read to the bytes
      // actually available after the length word — for well-formed calldata this
      // is a no-op (real length ≤ available), and for garbage it degrades to a
      // safe short/empty value instead of a multi-GB string or a RangeError.
      const availBytes = Math.max(0, (argData.length - (offset * 2 + 64)) / 2);
      const length = Math.min(rawLength, availBytes);
      const dataHex = readHex(argData, offset * 2 + 64, length * 2);
      const {full, display} = decodeDynamicArg(argType, dataHex, length);
      args.push(full);
      displayArgs.push(display);
      continue;
    }
    const {full, display} = decodeArg(argType, headHex);
    args.push(full);
    displayArgs.push(display);
  }

  return {
    selector,
    name: def.name,
    signature: def.signature,
    args,
    display: `${def.name}(${displayArgs.join(', ')})`,
  };
}

/**
 * Decode ONE value-type arg from its 32-byte head word (64 hex chars, no `0x`),
 * returning both the FULL value (for `args[]`) and a DISPLAY value (addresses
 * abbreviated). The dynamic scalars `bytes`/`string` are handled by the caller
 * (their head word is an offset, not a value); any remaining reference type
 * (`*[]`, tuples) is a `<type>` placeholder for both.
 */
function decodeArg(
  argType: string,
  wordHex: string,
): {full: string; display: string} {
  const padded = wordHex.padEnd(64, '0');
  const word = padded.length > 0 ? BigInt('0x' + padded) : 0n;

  // Reference types (`*[]`, tuples) are out of scope — the head word is an ABI
  // offset, not the value, so render a placeholder rather than a wrong number.
  if (!isValueType(argType)) {
    const placeholder = `<${argType}>`;
    return {full: placeholder, display: placeholder};
  }

  if (argType === 'address') {
    const addr = addressHex(word & ADDRESS_MASK);
    return {full: addr, display: abbreviateAddress(addr)};
  }
  if (argType === 'bool') {
    const value = word === 0n ? 'false' : 'true';
    return {full: value, display: value};
  }
  let m: RegExpExecArray | null;
  if ((m = /^bytes(\d+)$/.exec(argType))) {
    const nb = Number(m[1]);
    const value = '0x' + padded.slice(0, nb * 2);
    return {full: value, display: value};
  }
  if ((m = /^int(\d+)$/.exec(argType))) {
    const bits = Number(m[1]);
    // ABI sign-EXTENDS a signed integer to the full 32-byte head word, so for a
    // narrow intN the high bits above `bits` are all copies of the sign bit and
    // must be masked off BEFORE the two's-complement fold — otherwise a negative
    // narrow int (e.g. int8 -1 = 0xff…ff) reads as a huge positive number. For
    // int256 the mask is a no-op.
    const mask = (1n << BigInt(bits)) - 1n;
    const masked = word & mask;
    const signBit = 1n << BigInt(bits - 1);
    const value =
      (masked & signBit) !== 0n ? masked - (1n << BigInt(bits)) : masked;
    const s = value.toString();
    return {full: s, display: s};
  }
  // uintN (and the fallback numeric case).
  const s = word.toString();
  return {full: s, display: s};
}

/** Longest bytes value (in bytes) shown in full in `display`; longer → summary. */
const BYTES_DISPLAY_FULL = 32;
/** Longest string (in chars) shown in full in `display`; longer → truncated. */
const STRING_DISPLAY_FULL = 32;

/**
 * Decode a DYNAMIC scalar arg (`bytes` / `string`) from its already-sliced,
 * zero-extended data hex (`dataHex`, exactly `length * 2` chars) and byte
 * `length`. Returns the FULL value for `args[]` and a compact DISPLAY value:
 * - `bytes` → full lowercase `'0x'`+hex (empty → `'0x'`); display shows the full
 *   hex when short, else `0x<8 hex>…(<length> bytes)`.
 * - `string` → the raw UTF-8-decoded string, UNQUOTED; display QUOTES it and
 *   truncates a long one to `"<head>…"`.
 */
function decodeDynamicArg(
  argType: string,
  dataHex: string,
  length: number,
): {full: string; display: string} {
  if (argType === 'bytes') {
    const full = '0x' + dataHex;
    const display =
      length <= BYTES_DISPLAY_FULL
        ? full
        : `0x${dataHex.slice(0, 8)}…(${length} bytes)`;
    return {full, display};
  }
  // string: UTF-8 decode the raw data bytes.
  const full = length === 0 ? '' : bytesToUtf8(hexToBytes(dataHex));
  const display =
    full.length <= STRING_DISPLAY_FULL
      ? `"${full}"`
      : `"${full.slice(0, STRING_DISPLAY_FULL)}…"`;
  return {full, display};
}

/** Abbreviate a full `'0x'`+40-hex address as `0x<8 hex>…<8 hex>`. */
function abbreviateAddress(addr: string): string {
  const hex = addr.replace(/^0x/, '');
  return `0x${hex.slice(0, 8)}…${hex.slice(-8)}`;
}

/** Whether an ABI type label denotes a value type (decodable from one word). */
function isValueType(argType: string): boolean {
  if (argType === 'string' || argType === 'bytes') return false; // dynamic
  if (argType.includes('[') || argType.startsWith('tuple')) return false;
  return true;
}
