/**
 * Decode EVM revert data into a human-readable reason.
 *
 * Solidity encodes a revert reason as ABI-encoded error data behind a 4-byte
 * selector: `Error(string)` for `require`/`revert("…")`, `Panic(uint256)` for
 * compiler-inserted checks (overflow, division by zero, `assert`, …) and a
 * custom error's own selector for `revert MyError(…)`. Custom errors are looked
 * up in the ABIs of every loaded contract. Anything else is shown as raw text
 * when it is printable UTF-8 (kontrol-node's cheatcode failures, e.g. a failing
 * `vm.assertEq`, revert with the bare message) and as hex otherwise.
 */
import type {ErrorInfo} from '@simbolik/solc';

import {isValueType, numberOfBytesForType} from './events.js';
import {strip0x} from './hex.js';
import {decodeValue, fieldFromAbiWord} from './values.js';

/** A decoded revert reason. */
export interface RevertReason {
  /** Short exception name, e.g. `Error`, `Panic`, `TooSmall`, `Revert`. */
  id: string;
  /** The reason in words, e.g. `boom` or `arithmetic underflow or overflow`. */
  message: string;
  /** A one-line rendering, e.g. `Error("boom")` or `TooSmall(got: 3, min: 10)`. */
  summary: string;
  /** The matched error's canonical signature, e.g. `Error(string)`. */
  signature?: string;
}

const ERROR_SELECTOR = '0x08c379a0';
const PANIC_SELECTOR = '0x4e487b71';

/** Solidity's panic codes (see "Panic via assert and Error via require"). */
const PANIC_CODES: ReadonlyMap<number, string> = new Map([
  [0x00, 'generic compiler panic'],
  [0x01, 'assertion failed'],
  [0x11, 'arithmetic underflow or overflow'],
  [0x12, 'division or modulo by zero'],
  [0x21, 'conversion to an out-of-range enum value'],
  [0x22, 'incorrectly encoded storage byte array'],
  [0x31, 'pop() on an empty array'],
  [0x32, 'array index out of bounds'],
  [0x41, 'out of memory (allocation too large)'],
  [0x51, 'call to a zero-initialized internal function'],
]);

/** Index error definitions by selector (the first definition wins on a clash). */
export function errorsBySelector(
  errors: Iterable<ErrorInfo>
): Map<string, ErrorInfo> {
  const bySelector = new Map<string, ErrorInfo>();
  for (const e of errors) {
    if (!bySelector.has(e.selector)) bySelector.set(e.selector, e);
  }
  return bySelector;
}

/** Decode revert `data` (`0x`-prefixed hex) against the known custom errors. */
export function decodeRevertData(
  data: string,
  errors: ReadonlyMap<string, ErrorInfo>
): RevertReason {
  const hex = strip0x(data).toLowerCase();
  if (hex.length === 0) {
    const message = 'reverted without a reason';
    return {id: 'Revert', message, summary: message};
  }
  const selector = '0x' + hex.slice(0, 8);
  const body = hex.slice(8);

  if (selector === ERROR_SELECTOR) {
    const text = abiString(body, 0);
    if (text !== undefined) {
      return {
        id: 'Error',
        message: text,
        summary: `Error(${JSON.stringify(text)})`,
        signature: 'Error(string)',
      };
    }
  }
  if (selector === PANIC_SELECTOR && body.length >= 64) {
    const code = BigInt('0x' + body.slice(0, 64));
    const codeHex = '0x' + code.toString(16).padStart(2, '0');
    const explained = code <= 0xffn ? PANIC_CODES.get(Number(code)) : undefined;
    const message = `${codeHex}: ${explained ?? 'unknown panic code'}`;
    return {
      id: 'Panic',
      message,
      summary: `Panic(${message})`,
      signature: 'Panic(uint256)',
    };
  }
  const custom = errors.get(selector);
  if (custom !== undefined) {
    // Each argument's head starts after the previous heads; a static array
    // occupies several head words, and a tuple an unknown number (the ABI
    // entry's components are not kept), after which nothing can be located.
    let head: number | undefined = 0;
    const args = custom.params.map((p, k) => {
      const value =
        head === undefined ? '?' : abiArg(body, head, p.solcType, p.typeLabel);
      const words = headWords(p.typeLabel);
      head =
        head === undefined || words === undefined ? undefined : head + words;
      return `${p.name || `arg${k}`}: ${value}`;
    });
    const summary = `${custom.name}(${args.join(', ')})`;
    return {
      id: custom.name,
      message: summary,
      summary,
      signature: custom.signature,
    };
  }
  const text = printableUtf8(hex);
  if (text !== undefined) {
    return {id: 'Revert', message: text, summary: text};
  }
  const message = `unrecognized revert data 0x${hex.length > 72 ? hex.slice(0, 72) + '…' : hex} (${hex.length / 2} bytes)`;
  return {id: 'Revert', message, summary: message};
}

/**
 * How many 32-byte head words an ABI type occupies: one for value and dynamic
 * types (a dynamic one's head is an offset), `n` × the element's for a static
 * `T[n]`, `undefined` for a tuple (its components are unknown here).
 */
function headWords(typeLabel: string): number | undefined {
  if (typeLabel.startsWith('tuple')) {
    return typeLabel.endsWith('[]') ? 1 : undefined;
  }
  const fixed = /^(.*)\[(\d+)\]$/.exec(typeLabel);
  if (fixed === null) return 1;
  const [, inner, n] = fixed;
  if (isDynamic(inner!)) return 1;
  const each = headWords(inner!);
  return each === undefined ? undefined : each * Number(n);
}

function isDynamic(typeLabel: string): boolean {
  if (typeLabel === 'string' || typeLabel === 'bytes') return true;
  if (typeLabel.endsWith('[]')) return true;
  const fixed = /^(.*)\[\d+\]$/.exec(typeLabel);
  return fixed !== null && isDynamic(fixed[1]!);
}

/** The ABI argument whose head is word `k` of `body` (the data after the selector), rendered. */
function abiArg(
  body: string,
  k: number,
  solcType: string,
  typeLabel: string
): string {
  if (typeLabel === 'string') return quoted(abiString(body, k));
  if (typeLabel === 'bytes') {
    const bytes = abiDynamicBytes(body, k);
    return bytes === undefined ? '<bytes>' : '0x' + bytes;
  }
  if (!isValueType(solcType, typeLabel)) return `<${typeLabel}>`;
  const word = wordAt(body, k);
  if (word === undefined) return '?';
  const nb = numberOfBytesForType(solcType, typeLabel);
  return decodeValue(fieldFromAbiWord(word, solcType, nb), solcType, nb, {
    label: typeLabel,
  }).value;
}

/** The 32-byte word at word index `k` of `hex`, or `undefined` past the end. */
function wordAt(hex: string, k: number): bigint | undefined {
  const w = hex.slice(k * 64, (k + 1) * 64);
  return w.length === 64 ? BigInt('0x' + w) : undefined;
}

/** The dynamic `bytes` whose head offset is word `k` of `body`, as bare hex. */
function abiDynamicBytes(body: string, k: number): string | undefined {
  const offset = wordAt(body, k);
  if (offset === undefined || offset * 2n + 64n > BigInt(body.length)) {
    return undefined;
  }
  const start = Number(offset) * 2;
  const length = wordAt(body.slice(start), 0);
  if (length === undefined) return undefined;
  const bytes = body.slice(start + 64, start + 64 + Number(length) * 2);
  return bytes.length === Number(length) * 2 ? bytes : undefined;
}

/** The dynamic `string` whose head offset is word `k` of `body`. */
function abiString(body: string, k: number): string | undefined {
  const bytes = abiDynamicBytes(body, k);
  return bytes === undefined ? undefined : utf8(bytes);
}

function quoted(text: string | undefined): string {
  return text === undefined ? '<string>' : JSON.stringify(text);
}

function utf8(hex: string): string {
  return new TextDecoder().decode(hexBytes(hex));
}

/** `hex` as text when it is valid, printable UTF-8; `undefined` otherwise. */
function printableUtf8(hex: string): string | undefined {
  let text: string;
  try {
    text = new TextDecoder('utf-8', {fatal: true}).decode(hexBytes(hex));
  } catch {
    return undefined;
  }
  // Reject control characters (other than whitespace): binary data that
  // happens to be valid UTF-8 is not a message.
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)
    ? undefined
    : text;
}

function hexBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  }
  return bytes;
}
