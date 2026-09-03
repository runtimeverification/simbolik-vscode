/**
 * Sub-feature 4a — Cheatcode call DETECTION + DECODING (pure module).
 *
 * kontrol-node runs a Foundry/kontrol cheatcode (`vm.startPrank`, `vm.stopPrank`)
 * as a plain EVM CALL to the well-known cheatcode address
 * `0x7109709ECfa91a80626fF3989D68f67F5b1DD12D`. This suite pins the behaviour of
 * the (not-yet-existing) pure module `../src/cheatcodes.ts`:
 *   - `isCheatcodeCall(step)` — true iff `step.op ∈ {CALL,CALLCODE,DELEGATECALL,
 *     STATICCALL}` AND the CALL target (`stack[len-2]`, low 160 bits) is the
 *     cheatcode address.
 *   - `decodeCheatcodeCall(step, machine)` — reads the CALL's calldata from EVM
 *     memory `[argsOff, argsOff+argsLen)`, pulls the 4-byte selector, maps it to a
 *     known cheatcode signature, and decodes value-type args.
 *
 * These tests MUST FAIL today: `../src/cheatcodes.ts` does not exist yet, so the
 * import cannot resolve — the whole file fails at load (the RIGHT reason: feature
 * absent, not a typo/wrong API).
 *
 * ── CONFIRMED GROUND TRUTH (observed by running the fixture through the real
 *    lifting API — NOT copied blindly from the spec) ─────────────────────────
 *   Fixture: prank-run-trace.raw.json (kontrol, 933 steps), Prank.run(deadbeef…).
 *   - startPrank cheatcode CALL  → step 574: op=CALL, depth 1, argsOff=0xa0=160,
 *     argsLen=0x24=36. calldata = <selector><32-byte address>. next op ISZERO@1.
 *   - stopPrank  cheatcode CALL  → step 917: op=CALL, depth 1, argsOff=0xc0=192,
 *     argsLen=0x4=4. calldata = <selector> only. next op ISZERO@1.
 *   - Ordinary (NON-cheatcode) external CALLs at steps 205 and 610 (target
 *     0xa16e02e8… = the deployed Target contract) → isCheatcodeCall false.
 *   - Plain non-CALL steps: step 573 = GAS, step 916 = GAS → false.
 *   - SELECTORS: the spec's `0xca669fa7` for startPrank is WRONG for this
 *     signature. solc's own methodIdentifiers AND an independent
 *     keccak256("startPrank(address)")[:4] BOTH give `0x06447d56`; the on-wire
 *     calldata in the trace's EVM memory begins with `06447d56` too. stopPrank()
 *     is `0x90c5013b` (matches spec). The startPrank address arg decodes to
 *     0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef.
 *
 * IMPLEMENTER NOTE: the selector→signature map MUST key startPrank(address) on
 * `0x06447d56` (canonical keccak selector), not `0xca669fa7`, or it will not
 * match this fixture.
 */
import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';
import {keccak256} from 'ethereum-cryptography/keccak';
import {bytesToHex, utf8ToBytes} from 'ethereum-cryptography/utils';

import {parseJsonLossless} from '@simbolik/engine';
import {normalizeKontrolTrace, StateCursor, type Step} from '@simbolik/lifting';

// The proposed pure module — does NOT exist yet (this import is why the suite
// fails today). API surface the implementer should build to:
//   export const CHEATCODE_ADDRESS: string;            // lowercased 0x form
//   export function isCheatcodeCall(step: Step): boolean;
//   export interface DecodedCheatcode {
//     selector: string;      // '0x' + 8 hex, e.g. '0x06447d56'
//     name: string;          // 'startPrank'
//     signature: string;     // 'startPrank(address)'
//     args: string[];        // full decoded value-type args (address → 0x+40 hex)
//     display: string;       // human string, e.g. 'startPrank(0xdead…beef)'
//   }
//   export function decodeCheatcodeCall(
//     step: Step,
//     machine: {memory: string[]},   // a StateCursor.at(i) MachineState
//   ): DecodedCheatcode | undefined;
import {
  CHEATCODE_ADDRESS,
  isCheatcodeCall,
  decodeCheatcodeCall,
} from '../src/cheatcodes.js';

// ── fixture loaders ─────────────────────────────────────────────────────────
function readTrace(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

// The kontrol trace carries DECIMAL bigints for some fields, so it MUST be
// loaded through the lossless parser + normalizer (never JSON.parse).
function loadSteps(): Step[] {
  const parsed = parseJsonLossless(
    readTrace('prank-run-trace.raw.json'),
  ) as {result: unknown};
  return normalizeKontrolTrace(parsed.result as never);
}

/** Load + normalize any kontrol trace fixture by file name (lossless). */
function loadTrace(name: string): Step[] {
  const parsed = parseJsonLossless(readTrace(name)) as {result: unknown};
  return normalizeKontrolTrace(parsed.result as never);
}

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
    const steps = loadSteps();
    expect(isCheatcodeCall(steps[START_PRANK_STEP]!)).toBe(true);
    expect(isCheatcodeCall(steps[STOP_PRANK_STEP]!)).toBe(true);
  });

  it('false at an ordinary external CALL (step 205 → Target, not the cheatcode addr)', () => {
    const steps = loadSteps();
    expect(isCheatcodeCall(steps[ORDINARY_CALL_STEP]!)).toBe(false);
  });

  it('false at a plain non-CALL step (step 573 = GAS)', () => {
    const steps = loadSteps();
    expect(isCheatcodeCall(steps[PLAIN_STEP]!)).toBe(false);
  });
});

describe('cheatcodes — decodeCheatcodeCall', () => {
  it('startPrank(address): selector 0x06447d56, name startPrank, address arg deadbeef…', () => {
    const steps = loadSteps();
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
    // Display string is the implementer's to finalize — assert a robust substring.
    expect(decoded!.display).toContain('startPrank');
  });

  it('stopPrank(): selector 0x90c5013b, name stopPrank, no args', () => {
    const steps = loadSteps();
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

// ── REGRESSION (reviewer, 4a): value-type decoders + op offset branches the
// prank fixture never exercises. Built as SYNTHETIC cheatcode CALL steps +
// memory (memory is a full-32-byte-word `Hex[]` WITHOUT `0x`, as the node emits),
// driven through the real `decodeCheatcodeCall`. These pin the classic
// fixture-masked hazards: byte alignment (address low-20, bytesN high bytes),
// bool truthiness, the STATICCALL (view-cheatcode) offset branch, and safety on
// malformed/short input. They must not weaken the fixture-based tests above.
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

describe('cheatcodes — value decoders (synthetic, regression)', () => {
  it('address takes the LOW 20 bytes, masking dirty high bits', () => {
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

  it('bytesN takes the HIGH bytes, not the low bytes', () => {
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
    // A non-CALL op that merely has the cheatcode address on its stack is NOT a call.
    expect(isCheatcodeCall(synthStep('PUSH20', ['0x0', CHEAT]))).toBe(false);
  });

  it('does not throw on empty memory (degenerate) and stays defined', () => {
    const d = decodeCheatcodeCall(synthStep('CALL', callStack(36)), {memory: []});
    expect(d).toBeDefined();
    expect(d!.selector.startsWith('0x')).toBe(true);
  });
});

// ── Sub-feature 4c — DYNAMIC arg decoding (bytes / string) ───────────────────
//
// 4a decodes value-type args only and renders a dynamic/reference arg (`bytes`,
// `string`) as a `<type>` PLACEHOLDER (confirmed: at step 191 of etchraw and step
// 274 of etch, `decodeCheatcodeCall(...).args[1]` is the literal string
// `'<bytes>'`). 4c must ABI-decode the dynamic arg: the arg's head word is an
// OFFSET (relative to the arg-data region, i.e. the bytes AFTER the 4-byte
// selector); at that offset sits a 32-byte length, then `length` data bytes
// (right-padded to a word).
//
// ── CONFIRMED GROUND TRUTH (re-derived by hand-decoding the fixtures' EVM memory
//    through StateCursor — NOT copied blindly) ────────────────────────────────
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
//     by a SYNTHETIC label(address,string) call — selector
//     keccak256('label(address,string)')[:4] = 0xc657c718; "Alice" UTF-8 =
//     0x416c696365 (5 bytes). Verified all three selectors + the Alice bytes.
//
// ── PROPOSED DECODER BEHAVIOR the implementer must build to (asserted below) ──
//   • `bytes` arg → `args[i]` is the FULL decoded value as lowercase `'0x'`+hex
//     (all bytes, exact), regardless of length.
//   • `string` arg → `args[i]` is the raw decoded string, UNQUOTED (e.g. `Alice`).
//   • `display`: a SHORT bytes value is shown in full (etchraw → the full
//     `0x600160005260206000f3`); a LONG bytes value is truncated/summarized (the
//     tests below accept either a byte-count `469` or the `0x6080…` prefix, so the
//     exact truncation format stays the implementer's choice). A `string` value is
//     QUOTED in `display` (e.g. `"Alice"`).
//
// These MUST FAIL today: `args[1]` is the `<bytes>`/`<string>` placeholder.
describe('cheatcodes — dynamic arg decoding (4c: bytes / string)', () => {
  const ADDR_BEEF = '0x000000000000000000000000000000000000beef';

  it('bytes decode — etchraw step 191: short bytes decoded in full', () => {
    const steps = loadTrace('etchraw-run-trace.raw.json');
    const cursor = new StateCursor(steps);
    const decoded = decodeCheatcodeCall(steps[191]!, cursor.at(191));

    expect(decoded).toBeDefined();
    expect(decoded!.selector).toBe('0xb4d6c782');
    expect(decoded!.name).toBe('etch');
    // arg[0] = the full etch target address (lowercased, 42 chars).
    expect(decoded!.args[0]!.toLowerCase()).toBe(ADDR_BEEF);
    expect(decoded!.args[0]!.length).toBe(42);
    // arg[1] = the FULL 10-byte value, exact (today: the '<bytes>' placeholder).
    expect(decoded!.args[1]).toBe('0x600160005260206000f3');
    // A short bytes value is shown in full in the display.
    expect(decoded!.display).toContain('etch(');
    expect(decoded!.display).toContain('600160005260206000f3');
  });

  it('bytes decode — etch step 274: long bytes carried in full, summarized in display', () => {
    const steps = loadTrace('etch-run-trace.raw.json');
    const cursor = new StateCursor(steps);
    const decoded = decodeCheatcodeCall(steps[274]!, cursor.at(274));

    expect(decoded).toBeDefined();
    expect(decoded!.selector).toBe('0xb4d6c782');
    expect(decoded!.name).toBe('etch');
    expect(decoded!.args[0]!.toLowerCase()).toBe(ADDR_BEEF);
    // arg[1] carries the REAL decoded value (full hex), not a placeholder or a
    // truncated string: 469 bytes → '0x' + 938 hex chars = 940 chars, starting
    // 0x60806040 and ending in the CBOR tail …0033.
    expect(decoded!.args[1]!.startsWith('0x60806040')).toBe(true);
    expect(decoded!.args[1]!.endsWith('0033')).toBe(true);
    expect(decoded!.args[1]!.length).toBe(940);
    // A LONG bytes value is truncated/summarized in the display — accept either a
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
    // args carry the RAW (unquoted) string; display QUOTES it.
    expect(decoded!.args[1]).toBe('Alice');
    expect(decoded!.display).toContain('label(');
    expect(decoded!.display).toContain('"Alice"');
  });
});

// ── REGRESSION (4c): dynamic-arg edge cases flagged by the validator — an EMPTY
// bytes value (zero length) and MULTIPLE dynamic args in one signature (each head
// word an INDEPENDENT offset). Both are hand-encoded with offsets measured from
// the post-selector arg-data region, the same way the `label` case above was.
describe('cheatcodes — dynamic arg decoding (4c regression)', () => {
  it('EMPTY bytes decodes to 0x without crashing', () => {
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

  it('a HUGE/hostile length word cannot hang or crash the decoder (bounded to argData)', () => {
    // etch(address,bytes) whose dynamic LENGTH word is 2^256-1. Without a cap
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

  it('MULTIPLE dynamic args decode independently (mockCall(address,bytes,bytes))', () => {
    // Two distinct byte payloads, each reached via its OWN head offset:
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
