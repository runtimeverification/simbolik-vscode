/**
 * Enumerate + decode the events (LOG records) emitted by a frame's own
 * contract from an execution trace.
 *
 * A Solidity `emit` compiles to a `LOG0`…`LOG4` op: `topic0` is the event
 * selector (keccak of the canonical signature), `topic1..` carry the INDEXED
 * value-type args, and the LOG data (memory[offset..offset+size]) carries the
 * NON-INDEXED args as sequential 32-byte ABI words. Matching `topic0` to a
 * contract's ABI event inventory (see `Contract.events()` in `@simbolik/solc`)
 * lets us decode each record back into `{name, args}`.
 *
 * This is a TRACE-AWARE step (like `enumerateMappingKeys`): the enumeration +
 * ABI decoding live here so the session render stays thin. Scope is VALUE-TYPE
 * args only this cycle — an indexed reference-type arg (string/bytes/array/
 * struct) is hashed into its topic and only rendered as `<indexed 0x…>`, and
 * anonymous / unmatched-selector logs are skipped.
 */
import type {StateCursor, Step} from '@simbolik/lifting';

import {decodeValue, fieldFromAbiWord} from './values.js';

/** One typed parameter of an event definition (the `Contract.events()` shape). */
export interface EventParamDef {
  name: string;
  /** A solc-style type id (e.g. `t_uint256`) used to drive decoding. */
  solcType?: string;
  /** The ABI canonical type label (e.g. `uint256`). */
  typeLabel?: string;
  indexed: boolean;
}

/** An event definition: name, topic-0 selector, and typed params. */
export interface EventDef {
  name: string;
  selector: string;
  params: EventParamDef[];
}

/** One decoded event argument. */
export interface DecodedEventArg {
  name: string;
  value: string;
  typeLabel?: string;
}

/** A decoded event record: its name and decoded args in declaration order. */
export interface DecodedEvent {
  name: string;
  args: DecodedEventArg[];
  /**
   * The name of the contract that emitted it. Set by the cross-contract
   * {@link enumerateAllEvents}; omitted by the single-contract
   * {@link enumerateEvents}.
   */
  emitter?: string;
}

/** The ABI (event defs) + display name of the contract executing a LOG. */
export interface EventEmitter {
  defs: EventDef[];
  name?: string;
}

/**
 * Decode every event emitted by `codeAddress` at trace `index <= uptoStepIndex`,
 * matched against `eventDefs` by selector, in emission order.
 *
 * `codeAddress` is a lowercase, zero-padded 20-byte hex string (the frame's own
 * contract). For a `LOG<n>` op the stack (top-of-stack LAST) gives
 * `offset = stack[len-1]`, `size = stack[len-2]`, and `topic_j = stack[len-3-j]`
 * (n topics); the data bytes are the folded memory byte-slice
 * `[offset, offset+size)`. Args are decoded in DECLARATION order: indexed value
 * types consume `topics[1..]` sequentially, non-indexed value types consume the
 * data 32-byte words sequentially.
 */
export function enumerateEvents(
  steps: Step[],
  cursor: StateCursor,
  codeAddress: string,
  uptoStepIndex: number,
  eventDefs: EventDef[],
): DecodedEvent[] {
  const owner = BigInt(codeAddress);
  const bySelector = selectorMap(eventDefs);
  const events: DecodedEvent[] = [];
  const last = Math.min(uptoStepIndex, steps.length - 1);
  for (let index = 0; index <= last; index++) {
    const step = steps[index]!;
    if (step.codeAddress !== owner) continue;
    const decoded = decodeLogStep(step, cursor, index, bySelector);
    if (decoded !== undefined) events.push(decoded);
  }
  return events;
}

/**
 * Decode EVERY event across ALL contracts in emission (chronological) order, up
 * to `uptoStepIndex`. Each LOG is decoded against the ABI of the contract that
 * EMITTED it — resolved by its executing code address via `resolveEmitter`; a LOG
 * from an unresolved contract (or with no matching selector) is skipped. Powers
 * the frame-independent "Events" view.
 */
export function enumerateAllEvents(
  steps: Step[],
  cursor: StateCursor,
  uptoStepIndex: number,
  resolveEmitter: (codeAddress: bigint) => EventEmitter | undefined,
): DecodedEvent[] {
  const emitterCache = new Map<bigint, EventEmitter | undefined>();
  const selectorCache = new Map<bigint, Map<bigint, EventDef>>();
  const events: DecodedEvent[] = [];
  const last = Math.min(uptoStepIndex, steps.length - 1);
  for (let index = 0; index <= last; index++) {
    const step = steps[index]!;
    if (!/^LOG[1-4]$/.test(step.op)) continue;
    const addr = step.codeAddress;
    let emitter = emitterCache.get(addr);
    if (emitter === undefined && !emitterCache.has(addr)) {
      emitter = resolveEmitter(addr);
      emitterCache.set(addr, emitter);
    }
    if (emitter === undefined) continue;
    let bySelector = selectorCache.get(addr);
    if (bySelector === undefined) {
      bySelector = selectorMap(emitter.defs);
      selectorCache.set(addr, bySelector);
    }
    const decoded = decodeLogStep(step, cursor, index, bySelector);
    if (decoded !== undefined) events.push({...decoded, emitter: emitter.name});
  }
  return events;
}

/** Index event defs by their topic-0 selector (bigint). */
function selectorMap(eventDefs: EventDef[]): Map<bigint, EventDef> {
  const bySelector = new Map<bigint, EventDef>();
  for (const def of eventDefs) {
    if (def.selector) bySelector.set(BigInt(def.selector), def);
  }
  return bySelector;
}

/**
 * Decode ONE `LOG1..LOG4` step against `bySelector`, or `undefined` when it is
 * not a selector'd log or its selector is unmatched. See the module header for
 * the topic/data layout.
 */
function decodeLogStep(
  step: Step,
  cursor: StateCursor,
  index: number,
  bySelector: Map<bigint, EventDef>,
): DecodedEvent | undefined {
  const match = /^LOG([0-4])$/.exec(step.op);
  if (match === null) return undefined;
  const n = Number(match[1]);
  if (n === 0) return undefined; // anonymous (no selector topic) — out of scope.

  const st = step.stack;
  const len = st.length;
  if (len < 2 + n) return undefined;
  const offset = Number(BigInt(st[len - 1]!));
  const size = Number(BigInt(st[len - 2]!));
  const topics: bigint[] = [];
  for (let j = 0; j < n; j++) topics.push(BigInt(st[len - 3 - j]!));

  const def = bySelector.get(topics[0]!);
  if (def === undefined) return undefined; // unmatched selector — out of scope.

  // LOG data = folded memory byte-slice [offset, offset+size). Memory is a
  // 32-byte-WORD array: flatten (each word padded to a full word) then slice.
  const flat = cursor
    .at(index)
    .memory.map((w) => w.replace(/^0x/, '').padStart(64, '0'))
    .join('');
  const dataHex = flat.slice(offset * 2, (offset + size) * 2);

  let topicIndex = 1; // topic0 is the selector.
  let dataWord = 0;
  const args: DecodedEventArg[] = [];
  for (const param of def.params) {
    const solcType = param.solcType ?? '';
    const typeLabel = param.typeLabel ?? solcType.replace(/^t_/, '');
    if (param.indexed) {
      const topic = topics[topicIndex++] ?? 0n;
      if (isValueType(solcType, typeLabel)) {
        const nb = numberOfBytesForType(solcType, typeLabel);
        const field = fieldFromAbiWord(topic, solcType, nb);
        const {value, type} = decodeValue(field, solcType, nb, {label: typeLabel});
        args.push({name: param.name, value, typeLabel: type});
      } else {
        // Indexed reference type: only the keccak hash is in the topic.
        args.push({
          name: param.name,
          value: `<indexed 0x${topic.toString(16).padStart(64, '0')}>`,
          typeLabel,
        });
      }
    } else {
      // Non-indexed: consume ONE head data word. Every param occupies exactly
      // one 32-byte head word; for a dynamic/reference type that word is an ABI
      // OFFSET into the tail, not the value — tail decoding is out of scope this
      // cycle, so render a placeholder rather than the raw offset (a wrong
      // number). Advancing the cursor by one word regardless keeps any later
      // value-type args aligned to their own head words.
      const wordHex = dataHex.slice(dataWord * 64, (dataWord + 1) * 64);
      dataWord++;
      if (!isValueType(solcType, typeLabel)) {
        args.push({name: param.name, value: `<${typeLabel}>`, typeLabel});
        continue;
      }
      const word = wordHex.length > 0 ? BigInt('0x' + wordHex.padEnd(64, '0')) : 0n;
      const nb = numberOfBytesForType(solcType, typeLabel);
      const field = fieldFromAbiWord(word, solcType, nb);
      const {value, type} = decodeValue(field, solcType, nb, {label: typeLabel});
      args.push({name: param.name, value, typeLabel: type});
    }
  }
  return {name: def.name, args};
}

/** Whether a solc type id / ABI label denotes a value type (not a hashed ref). */
export function isValueType(solcType: string, typeLabel: string): boolean {
  if (solcType === 't_string' || typeLabel === 'string') return false;
  if (solcType === 't_bytes' || typeLabel === 'bytes') return false; // dynamic
  if (typeLabel.includes('[') || typeLabel.startsWith('tuple')) return false;
  if (
    solcType.startsWith('t_array') ||
    solcType.startsWith('t_struct') ||
    solcType.startsWith('t_mapping')
  ) {
    return false;
  }
  return true;
}

/** The byte width of a value type, for ABI-word normalization + decoding. */
export function numberOfBytesForType(solcType: string, typeLabel: string): number {
  let m: RegExpExecArray | null;
  if ((m = /^t_uint(\d+)$/.exec(solcType)) || (m = /^uint(\d+)$/.exec(typeLabel))) {
    return Number(m[1]) / 8;
  }
  if ((m = /^t_int(\d+)$/.exec(solcType)) || (m = /^int(\d+)$/.exec(typeLabel))) {
    return Number(m[1]) / 8;
  }
  if ((m = /^t_bytes(\d+)$/.exec(solcType)) || (m = /^bytes(\d+)$/.exec(typeLabel))) {
    return Number(m[1]);
  }
  if (solcType === 't_bool' || typeLabel === 'bool') return 1;
  if (
    solcType === 't_address' ||
    solcType.startsWith('t_contract') ||
    typeLabel === 'address'
  ) {
    return 20;
  }
  if (solcType.startsWith('t_enum') || typeLabel.startsWith('enum ')) return 1;
  return 32;
}
