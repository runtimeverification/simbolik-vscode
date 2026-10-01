/**
 * Cheatcode call detection and decoding (pure module `../src/cheatcodes.ts`).
 *
 * kontrol-node runs a Foundry/kontrol cheatcode (`vm.startPrank`, `vm.stopPrank`)
 * as a plain EVM CALL to the well-known cheatcode address
 * `0x7109709ECfa91a80626fF3989D68f67F5b1DD12D`.
 *   - `isCheatcodeCall(step)` — true iff `step.op ∈ {CALL,CALLCODE,DELEGATECALL,
 *     STATICCALL}` and the CALL target (`stack[len-2]`, low 160 bits) is the
 *     cheatcode address.
 *   - `decodeCheatcodeCall(step, machine)` — reads the CALL's calldata from EVM
 *     memory `[argsOff, argsOff+argsLen)`, pulls the 4-byte selector, maps it to a
 *     known cheatcode signature, and decodes the args.
 *
 * Ground truth (prank-run-trace.raw.json, kontrol, 933 steps,
 * Prank.run(deadbeef…)):
 *   - startPrank cheatcode CALL  → step 574: op=CALL, depth 1, argsOff=0xa0=160,
 *     argsLen=0x24=36. calldata = <selector><32-byte address>. next op ISZERO@1.
 *   - stopPrank  cheatcode CALL  → step 917: op=CALL, depth 1, argsOff=0xc0=192,
 *     argsLen=0x4=4. calldata = <selector> only. next op ISZERO@1.
 *   - Ordinary (non-cheatcode) external CALLs at steps 205 and 610 (target
 *     0xa16e02e8… = the deployed Target contract) → isCheatcodeCall false.
 *   - Plain non-CALL steps: step 573 = GAS, step 916 = GAS → false.
 *   - Selectors: startPrank(address) is `0x06447d56` (keccak256 of the
 *     signature, solc's methodIdentifiers, and the on-wire calldata all agree),
 *     not `0xca669fa7`. stopPrank() is `0x90c5013b`. The startPrank address arg
 *     decodes to 0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef.
 */
import {describe, expect, it} from 'vitest';
import {keccak256} from 'ethereum-cryptography/keccak';
import {bytesToHex, utf8ToBytes} from 'ethereum-cryptography/utils';

import {StateCursor, type Step} from '@simbolik/lifting';

import {
  CHEATCODE_ADDRESS,
  isCheatcodeCall,
  decodeCheatcodeCall,
} from '../src/cheatcodes.js';

import {loadSteps} from './support/harness.js';

// The kontrol trace carries decimal bigints for some fields, so it must be
// loaded through the lossless parser + normalizer (`loadSteps`), never
// `JSON.parse`.
const PRANK_TRACE = 'prank-run-trace.raw.json';

const START_PRANK_STEP = 574;
const STOP_PRANK_STEP = 917;
const ORDINARY_CALL_STEP = 205; // external CALL to the Target contract
const PLAIN_STEP = 573; // GAS — not a CALL at all

describe('cheatcodes — CHEATCODE_ADDRESS', () => {
  it('is the lowercased cheatcode address', () => {
    expect(CHEATCODE_ADDRESS).toBe(
      '0x7109709ecfa91a80626ff3989d68f67f5b1dd12d',
    );
  });
});

describe('cheatcodes — isCheatcodeCall', () => {
  it('true at the startPrank CALL (step 574) and stopPrank CALL (step 917)', () => {
    const steps = loadSteps(PRANK_TRACE);
    expect(isCheatcodeCall(steps[START_PRANK_STEP]!)).toBe(true);
    expect(isCheatcodeCall(steps[STOP_PRANK_STEP]!)).toBe(true);
  });

  it('false at an ordinary external CALL (step 205 → Target, not the cheatcode addr)', () => {
    const steps = loadSteps(PRANK_TRACE);
    expect(isCheatcodeCall(steps[ORDINARY_CALL_STEP]!)).toBe(false);
  });

  it('false at a plain non-CALL step (step 573 = GAS)', () => {
    const steps = loadSteps(PRANK_TRACE);
    expect(isCheatcodeCall(steps[PLAIN_STEP]!)).toBe(false);
  });
});

describe('cheatcodes — decodeCheatcodeCall', () => {
  it('startPrank(address): selector 0x06447d56, name startPrank, address arg deadbeef…', () => {
    const steps = loadSteps(PRANK_TRACE);
    const cursor = new StateCursor(steps);
    const decoded = decodeCheatcodeCall(
      steps[START_PRANK_STEP]!,
      cursor.at(START_PRANK_STEP),
    );

    expect(decoded).toBeDefined();
    expect(decoded!.selector).toBe('0x06447d56');
    // name/signature are the stable identity of the cheatcode.
    expect(decoded!.name).toContain('startPrank');
    expect(decoded!.signature).toContain('startPrank');
    // The single value-type arg is the pranked address, decoded in full.
    expect(decoded!.args).toHaveLength(1);
    expect(decoded!.args[0]!.toLowerCase()).toBe(
      '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    );
    // Assert only a robust substring of the display string.
    expect(decoded!.display).toContain('startPrank');
  });

  it('stopPrank(): selector 0x90c5013b, name stopPrank, no args', () => {
    const steps = loadSteps(PRANK_TRACE);
    const cursor = new StateCursor(steps);
    const decoded = decodeCheatcodeCall(
      steps[STOP_PRANK_STEP]!,
      cursor.at(STOP_PRANK_STEP),
    );

    expect(decoded).toBeDefined();
    expect(decoded!.selector).toBe('0x90c5013b');
    expect(decoded!.name).toContain('stopPrank');
    expect(decoded!.args).toHaveLength(0);
    expect(decoded!.display).toContain('stopPrank');
  });
});

// Value-type decoders and op offset branches the prank fixture never
// exercises, built as synthetic cheatcode CALL steps + memory (memory is a
// full-32-byte-word `Hex[]` without `0x`, as the node emits) and driven through
// the real `decodeCheatcodeCall`. They pin byte alignment (address low-20,
// bytesN high bytes), bool truthiness, the STATICCALL (view-cheatcode) offset
// branch, and safety on malformed/short input.
const CHEAT = '0x7109709ecfa91a80626ff3989d68f67f5b1dd12d';
function selectorOf(sig: string): string {
  return '0x' + bytesToHex(keccak256(utf8ToBytes(sig))).slice(0, 8);
}
/** Full-word (64-hex, no 0x) memory image of a flat calldata hex laid at offset 0. */
function memWords(calldataHex: string): string[] {
  const padded = calldataHex.padEnd(Math.ceil(calldataHex.length / 64) * 64, '0');
  const words: string[] = [];
  for (let i = 0; i < padded.length; i += 64) words.push(padded.slice(i, i + 64));
  return words;
}
function synthStep(op: string, stack: string[]): Step {
  return {op, stack} as unknown as Step;
}
/** CALL bottom-up stack: [retLen, retOff, argsLen, argsOff=0, value, addr, gas]. */
function callStack(argsLen: number): string[] {
  return ['0x0', '0x0', '0x' + argsLen.toString(16), '0x0', '0x0', CHEAT, '0xffff'];
}
/** STATICCALL bottom-up stack: [retLen, retOff, argsLen, argsOff=0, addr, gas]. */
function staticStack(argsLen: number): string[] {
  return ['0x0', '0x0', '0x' + argsLen.toString(16), '0x0', CHEAT, '0xffff'];
}
/** 64-hex right-aligned word (no 0x). */
function word(hex: string): string {
  return hex.replace(/^0x/, '').padStart(64, '0');
}

describe('cheatcodes — value decoders (synthetic)', () => {
  it('address takes the low 20 bytes, masking dirty high bits', () => {
    const arg =
      'ffffffffffffffffffffffff' + 'dead000000000000000000000000000000000001';
    const cd = selectorOf('prank(address)').slice(2) + arg;
    const d = decodeCheatcodeCall(
      synthStep('CALL', callStack(cd.length / 2)),
      {memory: memWords(cd)},
    );
    expect(d!.name).toBe('prank');
    expect(d!.args[0]!.toLowerCase()).toBe(
      '0xdead000000000000000000000000000000000001',
    );
  });

  it('bytes32 (load) takes the full left-aligned word', () => {
    const val = 'deadbeef' + '00'.repeat(28);
    const cd =
      selectorOf('load(address,bytes32)').slice(2) +
      word('0x' + 'a'.repeat(40)) +
      val;
    const d = decodeCheatcodeCall(
      synthStep('CALL', callStack(cd.length / 2)),
      {memory: memWords(cd)},
    );
    expect(d!.args[1]).toBe('0x' + val);
  });

  it('bytesN takes the high bytes, not the low bytes', () => {
    const cd = selectorOf('expectRevert(bytes4)').slice(2) + '11223344' + '00'.repeat(28);
    const d = decodeCheatcodeCall(
      synthStep('CALL', callStack(cd.length / 2)),
      {memory: memWords(cd)},
    );
    expect(d!.args[0]).toBe('0x11223344');
  });

  it('bool is true for any nonzero word, false for zero', () => {
    const cdT = selectorOf('assume(bool)').slice(2) + word('0x2');
    const cdF = selectorOf('assume(bool)').slice(2) + word('0x0');
    expect(
      decodeCheatcodeCall(synthStep('CALL', callStack(cdT.length / 2)), {
        memory: memWords(cdT),
      })!.args[0],
    ).toBe('true');
    expect(
      decodeCheatcodeCall(synthStep('CALL', callStack(cdF.length / 2)), {
        memory: memWords(cdF),
      })!.args[0],
    ).toBe('false');
  });

  it('STATICCALL (view cheatcode) reads argsOff/argsLen from the no-value layout', () => {
    const cd =
      selectorOf('prank(address)').slice(2) +
      word('0xdead000000000000000000000000000000000001');
    const step = synthStep('STATICCALL', staticStack(cd.length / 2));
    expect(isCheatcodeCall(step)).toBe(true);
    const d = decodeCheatcodeCall(step, {memory: memWords(cd)});
    expect(d!.name).toBe('prank');
    expect(d!.args[0]!.toLowerCase()).toBe(
      '0xdead000000000000000000000000000000000001',
    );
  });

  it('is safe on a short/empty stack and on a non-CALL op', () => {
    expect(isCheatcodeCall(synthStep('CALL', ['0x1']))).toBe(false);
    expect(isCheatcodeCall(synthStep('CALL', []))).toBe(false);
    // A non-CALL op that merely has the cheatcode address on its stack is not a call.
    expect(isCheatcodeCall(synthStep('PUSH20', ['0x0', CHEAT]))).toBe(false);
  });

  it('does not throw on empty memory (degenerate) and stays defined', () => {
    const d = decodeCheatcodeCall(synthStep('CALL', callStack(36)), {memory: []});
    expect(d).toBeDefined();
    expect(d!.selector.startsWith('0x')).toBe(true);
  });
});

// ## Dynamic arg decoding (bytes / string)
//
// A dynamic arg's head word is an offset (relative to the arg-data region, i.e.
// the bytes after the 4-byte selector); at that offset sits a 32-byte length,
// then `length` data bytes (right-padded to a word).
//
// Ground truth (hand-decoded from the fixtures' EVM memory via StateCursor):
//   etch selector = keccak256('etch(address,bytes)')[:4] = 0xb4d6c782 (matches
//   the on-wire calldata in both fixtures).
//   • etchraw-run-trace.raw.json (420 steps): the vm.etch CALL is step 191
//     (op=CALL, argsOff=128, argsLen=132). Decodes to address
//     0x000000000000000000000000000000000000beef and bytes
//     0x600160005260206000f3 (10 bytes; dynamic offset 0x40=64, length 10).
//   • etch-run-trace.raw.json (761 steps): the vm.etch CALL is step 274 (op=CALL,
//     argsOff=640, argsLen=580). Decodes to the same 0x…beef address and bytes =
//     Impl's runtime code, 469 bytes (938 hex chars), starting 0x60806040 and
//     ending …0033 (dynamic offset 0x40=64, length 469).
//   • No fixture exercises a `string` cheatcode arg, so string decoding is covered
//     by a synthetic label(address,string) call — selector
//     keccak256('label(address,string)')[:4] = 0xc657c718; "Alice" UTF-8 =
//     0x416c696365 (5 bytes).
//
// Decoder contract:
//   • `bytes` arg → `args[i]` is the full decoded value as lowercase `'0x'`+hex
//     (all bytes, exact), regardless of length.
//   • `string` arg → `args[i]` is the raw decoded string, unquoted (e.g. `Alice`).
//   • `display`: a short bytes value is shown in full (etchraw → the full
//     `0x600160005260206000f3`); a long bytes value is truncated/summarized (the
//     tests accept either a byte-count `469` or the `0x6080…` prefix, so the
//     exact truncation format is not pinned). A `string` value is quoted in
//     `display` (e.g. `"Alice"`).
describe('cheatcodes — dynamic arg decoding (bytes / string)', () => {
  const ADDR_BEEF = '0x000000000000000000000000000000000000beef';

  it('bytes decode — etchraw step 191: short bytes decoded in full', () => {
    const steps = loadSteps('etchraw-run-trace.raw.json');
    const cursor = new StateCursor(steps);
    const decoded = decodeCheatcodeCall(steps[191]!, cursor.at(191));

    expect(decoded).toBeDefined();
    expect(decoded!.selector).toBe('0xb4d6c782');
    expect(decoded!.name).toBe('etch');
    // arg[0] = the full etch target address (lowercased, 42 chars).
    expect(decoded!.args[0]!.toLowerCase()).toBe(ADDR_BEEF);
    expect(decoded!.args[0]!.length).toBe(42);
    // arg[1] = the full 10-byte value, exact (not a '<bytes>' placeholder).
    expect(decoded!.args[1]).toBe('0x600160005260206000f3');
    // A short bytes value is shown in full in the display.
    expect(decoded!.display).toContain('etch(');
    expect(decoded!.display).toContain('600160005260206000f3');
  });

  it('bytes decode — etch step 274: long bytes carried in full, summarized in display', () => {
    const steps = loadSteps('etch-run-trace.raw.json');
    const cursor = new StateCursor(steps);
    const decoded = decodeCheatcodeCall(steps[274]!, cursor.at(274));

    expect(decoded).toBeDefined();
    expect(decoded!.selector).toBe('0xb4d6c782');
    expect(decoded!.name).toBe('etch');
    expect(decoded!.args[0]!.toLowerCase()).toBe(ADDR_BEEF);
    // arg[1] carries the real decoded value (full hex), not a placeholder or a
    // truncated string: 469 bytes → '0x' + 938 hex chars = 940 chars, starting
    // 0x60806040 and ending in the CBOR tail …0033.
    expect(decoded!.args[1]!.startsWith('0x60806040')).toBe(true);
    expect(decoded!.args[1]!.endsWith('0033')).toBe(true);
    expect(decoded!.args[1]!.length).toBe(940);
    // A long bytes value is truncated/summarized in the display — accept either a
    // byte-count (469) or the 0x6080 prefix so the exact format stays open.
    expect(decoded!.display).toContain('etch(');
    expect(
      decoded!.display.includes('469') || decoded!.display.includes('6080'),
    ).toBe(true);
  });

  it('string decode — synthetic label(address,string): "Alice"', () => {
    // Hand-encode label(address,string) calldata: selector 0xc657c718, then
    //   head[0] = address, head[1] = dynamic offset 0x40 (=64, post-selector),
    //   then at offset 64: length 5, then "Alice" (0x416c696365) right-padded.
    const addr = 'ab'.repeat(20); // 40 hex chars
    const cd =
      selectorOf('label(address,string)').slice(2) +
      word('0x' + addr) + // head[0]: address
      word('0x40') + // head[1]: offset to string data = 64
      word('0x05') + // string length = 5
      '416c696365'.padEnd(64, '0'); // "Alice" UTF-8, right-padded to a word

    const decoded = decodeCheatcodeCall(
      synthStep('CALL', callStack(cd.length / 2)),
      {memory: memWords(cd)},
    );

    expect(decoded).toBeDefined();
    expect(decoded!.selector).toBe('0xc657c718');
    expect(decoded!.name).toBe('label');
    expect(decoded!.args[0]!.toLowerCase()).toBe('0x' + addr);
    // args carry the raw (unquoted) string; display quotes it.
    expect(decoded!.args[1]).toBe('Alice');
    expect(decoded!.display).toContain('label(');
    expect(decoded!.display).toContain('"Alice"');
  });
});

// Dynamic-arg edge cases: an empty bytes value (zero length), a hostile
// length word, and multiple dynamic args in one signature (each head word an
// independent offset). All are hand-encoded with offsets measured from the
// post-selector arg-data region, like the `label` case above.
describe('cheatcodes — dynamic arg decoding (edge cases)', () => {
  it('empty bytes decodes to 0x without crashing', () => {
    // etch(address,bytes) with a zero-length bytes payload.
    const addr = 'cd'.repeat(20);
    const cd =
      selectorOf('etch(address,bytes)').slice(2) +
      word('0x' + addr) + // head[0]: address
      word('0x40') + // head[1]: offset to bytes data = 64
      word('0x00'); // length 0 (no data bytes follow)

    const decoded = decodeCheatcodeCall(
      synthStep('CALL', callStack(cd.length / 2)),
      {memory: memWords(cd)},
    );

    expect(decoded).toBeDefined();
    expect(decoded!.name).toBe('etch');
    expect(decoded!.args[0]!.toLowerCase()).toBe('0x' + addr);
    expect(decoded!.args[1]).toBe('0x');
  });

  it('a huge/hostile length word cannot hang or crash the decoder (bounded to argData)', () => {
    // etch(address,bytes) whose dynamic length word is 2^256-1. Without a cap
    // the decoder slices+zero-pads `length*2` chars → a multi-GB string or a
    // RangeError ("Invalid string length"), wedging the debugger. The read must
    // be bounded to the bytes actually available after the length word.
    const addr = 'ef'.repeat(20);
    const cd =
      selectorOf('etch(address,bytes)').slice(2) +
      word('0x' + addr) + // head[0]: address
      word('0x40') + // head[1]: offset to bytes data = 64
      'ff'.repeat(32); // length = 2^256-1 (no data bytes actually follow)

    const start = Date.now();
    const decoded = decodeCheatcodeCall(
      synthStep('CALL', callStack(cd.length / 2)),
      {memory: memWords(cd)},
    );
    // Must return promptly (a real cap; not a 268MB+ allocation) and safely.
    expect(Date.now() - start).toBeLessThan(1000);
    expect(decoded).toBeDefined();
    expect(decoded!.name).toBe('etch');
    expect(decoded!.args[0]!.toLowerCase()).toBe('0x' + addr);
    // No data bytes are available after the length word → decodes to empty.
    expect(decoded!.args[1]).toBe('0x');
    // The full-length string never gets built.
    expect(decoded!.args[1]!.length).toBeLessThan(100);
  });

  it('multiple dynamic args decode independently (mockCall(address,bytes,bytes))', () => {
    // Two distinct byte payloads, each reached via its own head offset:
    //   head[0]=address, head[1]=offset to bytes#1 (0x60=96),
    //   head[2]=offset to bytes#2 (0xa0=160 = 96 + 32 len + 32 padded data#1).
    //   at 96: len 2, then aabb (padded);  at 160: len 3, then ccddee (padded).
    const addr = '11'.repeat(20);
    const cd =
      selectorOf('mockCall(address,bytes,bytes)').slice(2) +
      word('0x' + addr) + // head[0]
      word('0x60') + // head[1]: offset to bytes#1 = 96
      word('0xa0') + // head[2]: offset to bytes#2 = 160
      word('0x02') + // bytes#1 length = 2
      'aabb'.padEnd(64, '0') + // bytes#1 data, right-padded
      word('0x03') + // bytes#2 length = 3
      'ccddee'.padEnd(64, '0'); // bytes#2 data, right-padded

    const decoded = decodeCheatcodeCall(
      synthStep('CALL', callStack(cd.length / 2)),
      {memory: memWords(cd)},
    );

    expect(decoded).toBeDefined();
    expect(decoded!.selector).toBe(selectorOf('mockCall(address,bytes,bytes)'));
    expect(decoded!.name).toBe('mockCall');
    expect(decoded!.args[0]!.toLowerCase()).toBe('0x' + addr);
    expect(decoded!.args[1]).toBe('0xaabb');
    expect(decoded!.args[2]).toBe('0xccddee');
  });
});
