/**
 * The Solidity-decoded variable scopes of a frame — State (storage variables)
 * and Locals (params/returns/locals) — and their nested complex values
 * (structs, arrays, mappings, expandable contract addresses).
 *
 * All variable LAYOUT comes from `@simbolik/ethdebug-gen` (the ethdebug program
 * for storage, `variablesAt` for params/locals); this module dereferences each
 * pointer through the real ethdebug path (`machineStateFor` + the pointer
 * readers) and decodes by solc type.
 */
import type {Machine} from '@ethdebug/pointers';
import type {DebugProtocol} from '@vscode/debugprotocol';

import {
  bytesLayoutAtMemoryOffset,
  type ArrayLayout,
  type ResolvedVariable,
  type EthdebugStorageVariable,
  type StructMember,
} from '@simbolik/ethdebug-gen';
import {findAstNode, type AstNode, type CompilationUnit} from '@simbolik/solc';

import {ethdebugProgram} from './contractAnalysis.js';
import {contractFrame, isSolidityFrame, type FrameInfo} from './frames.js';
import type {AllocHandle, ComplexKind} from './handles.js';
import {addressHex, bytesDisplay} from './hex.js';
import {isFrameLocal, LocalsHistory, variablesAtStep} from './localsHistory.js';
import {
  machineStateFor,
  readPointerBytes,
  readPointerRegions,
  readPointerValue,
  readStorageWords,
} from './machineState.js';
import {enumerateMappingKeys, mappingValueSlot} from './mappings.js';
import {isForeign} from './registry.js';
import type {Trace} from './trace.js';
import {
  decodeValue,
  describeValueTypeString,
  enumAstId,
  fieldFromAbiWord,
  type DecodeContext,
  type DecodedValue,
} from './values.js';

/** The static layout facts of a mapping storage var (from the producer). */
type MappingLayout = NonNullable<EthdebugStorageVariable['mapping']>;

/** A reference-type variable rendered as a nested DAP variable. */
interface ComplexLayout {
  array?: ArrayLayout;
  members?: StructMember[];
  mapping?: MappingLayout;
}

/** A value's solc type facts, as needed to decode it. */
interface ValueType {
  solcType: string;
  typeLabel: string | undefined;
  numberOfBytes: number;
}

/** Whether a solc type holds an address (a plain `address` or a contract ref). */
function isAddressType(solcType: string): boolean {
  return solcType.startsWith('t_address') || solcType.startsWith('t_contract');
}

/** Whether a layout is a nested array or struct value. */
function isArrayOrStruct(v: ComplexLayout): boolean {
  return (
    v.array !== undefined || (v.members !== undefined && v.members.length > 0)
  );
}

/**
 * A one-line summary shown as a nested struct's own `value` (its children carry
 * the fields). Strips solc's `struct Contract.` qualifier so `struct Locals.Point`
 * renders as `Point {…}`.
 */
function structSummary(typeLabel: string): string {
  return `${typeLabel.replace(/^struct\s+(?:.+\.)?/, '')} {…}`;
}

function leaf(
  name: string,
  value: string,
  type?: string
): DebugProtocol.Variable {
  return {name, value, type, variablesReference: 0};
}

/** Find an `EnumDefinition` by simple name anywhere in the CU's sources. */
function findEnumNode(cu: CompilationUnit, name: string): AstNode | undefined {
  for (const source of cu.sources()) {
    const node = findAstNode(
      source.ast(),
      n => n.nodeType === 'EnumDefinition' && n.name === name
    );
    if (node !== undefined) return node;
  }
  return undefined;
}

export class SolidityVariables {
  readonly #trace: Trace;
  readonly #alloc: AllocHandle;
  readonly #history: LocalsHistory;
  /**
   * Synthetic frames for EXPANDED contract addresses (an address-typed value
   * that resolves to a known contract is drilled into to show that contract's
   * storage at the current step). Keyed by a NEGATIVE frame id so it never
   * collides with a real frame; resolving a handle's frame from here first lets
   * the whole storage-rendering path work on the foreign contract unchanged.
   */
  readonly #contractFrames = new Map<number, FrameInfo>();
  #contractFrameSeq = -1;
  /** The current step, which a synthetic contract frame is positioned at. */
  readonly #currentStep: () => number;

  constructor(trace: Trace, alloc: AllocHandle, currentStep: () => number) {
    this.#trace = trace;
    this.#alloc = alloc;
    this.#history = new LocalsHistory(trace);
    this.#currentStep = currentStep;
  }

  /** The synthetic contract frame with id `frameId`, if one was expanded. */
  contractFrame(frameId: number): FrameInfo | undefined {
    return this.#contractFrames.get(frameId);
  }

  /**
   * The frame contract's storage variables: value types extracted from their
   * PACKED slot word, string/bytes decoded from their storage encoding, and
   * arrays/structs/mappings rendered nested.
   */
  async state(frame: FrameInfo): Promise<DebugProtocol.Variable[]> {
    if (!isSolidityFrame(frame)) return [];
    const {contract, cu} = frame;
    const ms = this.#machineState(frame, frame.stepIndex);
    const variables: DebugProtocol.Variable[] = [];
    for (const sv of ethdebugProgram(contract, cu).storageVariables) {
      const label = contract.storageType(sv.solcType)?.label;
      if (isArrayOrStruct(sv) || sv.mapping !== undefined) {
        variables.push(
          await this.#complex(
            frame,
            cu,
            sv.name,
            label ?? sv.solcType,
            sv,
            ms,
            'state'
          )
        );
      } else if (sv.bytesStorage !== undefined) {
        const value = await this.#storageBytes(sv.bytesStorage, ms);
        variables.push(leaf(sv.name, value, label));
      } else {
        // Value type: packed-word extraction (word >> offset & mask).
        const word = await readPointerValue(
          {location: 'storage', slot: sv.slot, offset: 0, length: 32},
          ms
        );
        const field =
          (word >> BigInt(8 * sv.offset)) &
          ((1n << BigInt(8 * sv.length)) - 1n);
        variables.push(
          this.#scalar(cu, sv.name, field, {
            solcType: sv.solcType,
            typeLabel: label,
            numberOfBytes: sv.length,
          })
        );
      }
    }
    return variables;
  }

  /**
   * A dynamic string/bytes storage value. The producer supplies the LAYOUT (flag
   * word + static keccak base); the runtime encoding rules live here: an even
   * low byte is SHORT (data inline in the HIGH `len` bytes, length = low/2),
   * odd is LONG (length = (flag-1)/2, data in consecutive words from the base).
   */
  async #storageBytes(
    layout: NonNullable<EthdebugStorageVariable['bytesStorage']>,
    ms: Machine.State
  ): Promise<string> {
    const {flagPointer, longBaseSlot, isString} = layout;
    const flagWord = await readPointerValue(flagPointer, ms);
    const lowByte = flagWord & 0xffn;
    let dataHex: string;
    if (lowByte % 2n === 0n) {
      const len = Number(lowByte / 2n);
      dataHex = flagWord
        .toString(16)
        .padStart(64, '0')
        .slice(0, len * 2);
    } else {
      const len = Number((flagWord - 1n) / 2n);
      const wordCount = Math.ceil(len / 32);
      const words =
        wordCount > 0
          ? await readStorageWords(BigInt(longBaseSlot), wordCount, ms)
          : [];
      dataHex = words
        .map(w => w.toString(16).padStart(64, '0'))
        .join('')
        .slice(0, len * 2);
    }
    return bytesDisplay(dataHex, isString);
  }

  /**
   * The current frame function's live params + locals. Each is decoded in
   * isolation: one undecodable value (e.g. a string whose length word is
   * garbage) must not blank the whole Locals scope.
   */
  async locals(frame: FrameInfo): Promise<DebugProtocol.Variable[]> {
    if (!isSolidityFrame(frame)) return [];
    const {steps} = this.#trace;
    // Read at the frame's live body position (see LocalsHistory.readStep).
    const step = this.#history.readStep(frame);
    const ms = this.#machineState(frame, step);
    const modelRef = this.#history.modelReference(frame, step);

    const variables: DebugProtocol.Variable[] = [];
    for (const v of variablesAtStep(frame, steps[step]!)) {
      if (!isFrameLocal(v)) continue; // storage lives in another scope.
      try {
        const variable = await this.#local(
          frame,
          frame.cu,
          v,
          ms,
          step,
          modelRef
        );
        if (variable !== undefined) variables.push(variable);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        variables.push(leaf(v.name, `<unreadable: ${message}>`, v.typeLabel));
      }
    }
    return variables;
  }

  /** Decode one live param/local `v`, or `undefined` when it has no known value. */
  async #local(
    frame: FrameInfo,
    cu: CompilationUnit,
    v: ResolvedVariable,
    ms: Machine.State,
    step: number,
    modelRef: number | undefined
  ): Promise<DebugProtocol.Variable | undefined> {
    // The static model's location is only trustworthy where the model matches
    // the executed path (see LocalsHistory.modelReference): otherwise treat it
    // as unlocated.
    if (!this.#history.modelMatches(v, step, modelRef)) {
      v = {
        ...v,
        pointer: undefined,
        members: undefined,
        array: undefined,
        bytes: undefined,
      };
    }
    if (isArrayOrStruct(v)) {
      const {array, members} = v;
      return this.#complex(
        frame,
        cu,
        v.name,
        v.typeLabel,
        {array, members},
        ms,
        'local'
      );
    }
    if (v.bytes !== undefined) {
      const hex = await readPointerBytes(v.bytes.pointer, ms);
      return leaf(v.name, bytesDisplay(hex, v.bytes.isString), v.typeLabel);
    }
    // Value numbering names a VALUE, so a leftover copy of a variable's OLD
    // value can still be named after the variable was reassigned (e.g. an
    // initializer `0` kept on the stack while `x -= …` ran in a loop). A stale
    // copy is not the variable — treat it as unlocated.
    if (v.pointer !== undefined && !this.#history.isStaleCopy(frame, v, step)) {
      return this.#scalar(cu, v.name, await readPointerValue(v.pointer, ms), v);
    }
    // Unavailable at the live pc: its stack slot has been freed/reused (common
    // under viaIR once a value local's LAST use has passed), yet it is still in
    // lexical scope. Show its LAST KNOWN value, decoded at the most recent
    // earlier step of THIS frame invocation where it was still locatable.
    const lastKnown = await this.#lastKnown(frame, cu, v.name, step, modelRef);
    if (lastKnown !== undefined) return lastKnown;
    // A NAMED RETURN variable starts at its type's zero value (a Solidity
    // guarantee). viaIR keeps no stack slot for it until its first assignment,
    // so before that — when the trace shows no write to it since the frame was
    // entered — its value is known without a location: the default.
    if (
      v.kind === 'return' &&
      v.isValueType &&
      this.#history.unwrittenSinceEntry(frame, cu, v, step)
    ) {
      return isAddressType(v.solcType)
        ? leaf(v.name, addressHex(0n), v.typeLabel)
        : {name: v.name, ...this.#decode(cu, 0n, v), variablesReference: 0};
    }
    return undefined;
  }

  /** The value of `name` at its most recent decodable earlier location. */
  async #lastKnown(
    frame: FrameInfo,
    cu: CompilationUnit,
    name: string,
    step: number,
    modelRef: number | undefined
  ): Promise<DebugProtocol.Variable | undefined> {
    for (const {v, step: j} of this.#history.earlierLocations(
      frame,
      cu,
      name,
      step,
      modelRef
    )) {
      const ms = this.#machineState(frame, j);
      if (v.bytes === undefined) {
        return this.#scalar(
          cu,
          v.name,
          await readPointerValue(v.pointer!, ms),
          v
        );
      }
      // A location that does not decode here (e.g. a slot read before the
      // variable was assigned) is not a value the variable held — keep looking.
      try {
        const hex = await readPointerBytes(v.bytes.pointer, ms);
        return leaf(v.name, bytesDisplay(hex, v.bytes.isString), v.typeLabel);
      } catch {
        continue;
      }
    }
    return undefined;
  }

  /**
   * Decode the children of a nested COMPLEX variable, re-resolving its static
   * layout against the CURRENT step (like every handle): for a `'local'` handle
   * from `variablesAt` at the live body read step; for a `'state'` handle from
   * the ethdebug program's storage vars (storage persists, so the frame's own
   * step suffices).
   */
  async children(
    frame: FrameInfo,
    varName: string,
    complexKind: ComplexKind
  ): Promise<DebugProtocol.Variable[]> {
    if (!isSolidityFrame(frame)) return [];
    const {contract, cu} = frame;
    let parent: ComplexLayout | undefined;
    let ms: Machine.State;
    if (complexKind === 'state') {
      parent = ethdebugProgram(contract, cu).storageVariables.find(
        sv => sv.name === varName
      );
      ms = this.#machineState(frame, frame.stepIndex);
    } else {
      const step = this.#history.readStep(frame);
      parent = variablesAtStep(frame, this.#trace.steps[step]!).find(
        v => v.name === varName
      );
      ms = this.#machineState(frame, step);
    }
    if (parent === undefined) return [];

    if (parent.array !== undefined) {
      const {array} = parent;
      const values = await this.#arrayElements(cu, array, ms);
      return values.map((e, i) => leaf(String(i), e.value, e.type));
    }
    if (parent.mapping !== undefined) {
      const entries = await this.#mappingEntries(frame, parent.mapping, ms);
      return entries.map(e => leaf(e.name, e.value, e.type));
    }
    const variables: DebugProtocol.Variable[] = [];
    for (const member of parent.members ?? []) {
      if (member.pointer === undefined) continue; // reference-type member
      const field = await readPointerValue(member.pointer, ms);
      variables.push({
        name: member.name,
        ...this.#decode(cu, field, member),
        variablesReference: 0,
      });
    }
    return variables;
  }

  /**
   * Render a reference-type COMPLEX variable as a NESTED DAP variable: a
   * `Complex` handle (children decoded on expansion via {@link children}) plus a
   * one-line preview decoded exactly like the children, so the two agree.
   */
  async #complex(
    frame: FrameInfo,
    cu: CompilationUnit,
    name: string,
    typeLabel: string,
    v: ComplexLayout,
    ms: Machine.State,
    complexKind: ComplexKind
  ): Promise<DebugProtocol.Variable> {
    const ref = this.#alloc({
      kind: 'Complex',
      frameId: frame.id,
      varName: name,
      complexKind,
    });
    let value: string;
    if (v.array !== undefined) {
      const elements = await this.#arrayElements(cu, v.array, ms);
      value = `[${elements.map(e => e.value).join(', ')}]`;
    } else if (v.mapping !== undefined) {
      const entries = await this.#mappingEntries(frame, v.mapping, ms);
      value = `{${entries.map(e => `${e.name}: ${e.value}`).join(', ')}}`;
    } else {
      value = structSummary(typeLabel);
    }
    return {name, value, type: typeLabel, variablesReference: ref};
  }

  /**
   * The decoded elements of an array. A `bytes[]` / `string[]` element region is
   * the element's MEMORY OFFSET, dereferenced as a raw byte string; any other
   * element region is a full 32-byte word, normalized to the element type's own
   * bytes before decoding (essential for narrow `intN` and LEFT-aligned `bytesN`).
   */
  async #arrayElements(
    cu: CompilationUnit,
    array: ArrayLayout,
    ms: Machine.State
  ): Promise<{value: string; type: string | undefined}[]> {
    const regions = await readPointerRegions(array.pointer, ms);
    if (array.elementBytes !== undefined) {
      const isString = array.elementBytes.isString === true;
      const values: {value: string; type: string | undefined}[] = [];
      for (const offset of regions) {
        const layout = bytesLayoutAtMemoryOffset(Number(offset), isString);
        const hex = await readPointerBytes(layout.pointer, ms);
        values.push({
          value: bytesDisplay(hex, isString),
          type: array.elementTypeLabel,
        });
      }
      return values;
    }
    const element: ValueType = {
      solcType: array.elementSolcType,
      typeLabel: array.elementTypeLabel,
      numberOfBytes: array.elementNumberOfBytes,
    };
    return regions.map(word =>
      this.#decode(
        cu,
        fieldFromAbiWord(word, element.solcType, element.numberOfBytes),
        element
      )
    );
  }

  /**
   * The OBSERVED entries of a storage mapping at the frame's step, each a decoded
   * `{name: key, value, type}` in first-seen order. Enumeration + keccak
   * arithmetic live in `./mappings.js`; this reads each value slot through the
   * real storage path and decodes by value type.
   */
  async #mappingEntries(
    frame: FrameInfo,
    mapping: MappingLayout,
    ms: Machine.State
  ): Promise<{name: string; value: string; type: string}[]> {
    if (!isSolidityFrame(frame)) return [];
    const {cu, contract} = frame;
    // Bounded by the frame's own step: a key touched later must not appear here.
    const keys = enumerateMappingKeys(
      this.#trace.steps,
      this.#trace.cursor,
      mapping.baseSlot,
      frame.stepIndex
    );
    const typeOf = (solcType: string): ValueType => {
      const t = contract.storageType(solcType);
      return {
        solcType,
        typeLabel: t?.label ?? solcType.replace(/^t_/, ''),
        numberOfBytes: t?.numberOfBytes ?? 32,
      };
    };
    const keyType = typeOf(mapping.keyType);
    const valueType = typeOf(mapping.valueType);
    const base = BigInt(mapping.baseSlot);
    const entries: {name: string; value: string; type: string}[] = [];
    for (const key of keys) {
      const word = await readPointerValue(
        {
          location: 'storage',
          // A `0x`-hex literal slot: pad to a full 32-byte word so the huge
          // keccak-derived slot parses (odd-length hex misparses) and matches
          // the account's storage key.
          slot: `0x${mappingValueSlot(key, base).toString(16).padStart(64, '0')}`,
          offset: 0,
          length: 32,
        },
        ms
      );
      const {value, type} = this.#decode(
        cu,
        fieldFromAbiWord(word, valueType.solcType, valueType.numberOfBytes),
        valueType
      );
      // The key is the raw preimage word0. Normalize it to the key type's own
      // bytes (exactly as the value) before decoding the child NAME: a no-op for
      // right-aligned key types, but a LEFT-aligned `bytesN` key must be sliced
      // to its high N bytes and a negative `intN` key masked to its width. (The
      // value slot above still hashes the RAW word0, which reproduces the trace
      // preimage verbatim for every 32-byte-padded key type.)
      const {value: name} = this.#decode(
        cu,
        fieldFromAbiWord(key, keyType.solcType, keyType.numberOfBytes),
        keyType
      );
      entries.push({name, value, type});
    }
    return entries;
  }

  /**
   * A scalar variable. An address/contract-typed value that resolves to a known
   * contract renders as `<ContractName> (0x…)` and is EXPANDABLE into that
   * contract's storage at the current step (via a synthetic frame); a plain,
   * unknown, foreign or zero address stays a scalar.
   */
  #scalar(
    cu: CompilationUnit,
    name: string,
    field: bigint,
    t: ValueType
  ): DebugProtocol.Variable {
    if (!isAddressType(t.solcType)) {
      return {name, ...this.#decode(cu, field, t), variablesReference: 0};
    }
    const addr = addressHex(field & ((1n << 160n) - 1n));
    const resolution =
      addr !== addressHex(0n) ? this.#trace.registry.get(addr) : undefined;
    if (resolution === undefined || isForeign(resolution)) {
      return leaf(name, addr, t.typeLabel);
    }
    const id = this.#contractFrameSeq--;
    this.#contractFrames.set(
      id,
      contractFrame(id, addr, resolution, this.#currentStep())
    );
    return {
      name,
      value: `${resolution.contract.name}(${addr})`,
      type: t.typeLabel,
      variablesReference: this.#alloc({kind: 'State', frameId: id}),
    };
  }

  /** Decode a value-type `field` by its solc type, resolving enum member names. */
  #decode(cu: CompilationUnit, field: bigint, t: ValueType): DecodedValue {
    const ctx: DecodeContext = {label: t.typeLabel};
    if (t.solcType === 't_enum') {
      // A bare `t_enum` (params/locals) names its enum only in the type label.
      const enumName =
        t.typeLabel !== undefined
          ? describeValueTypeString(t.typeLabel)?.enumName
          : undefined;
      if (enumName !== undefined) {
        const node = findEnumNode(cu, enumName);
        ctx.memberNames = node?.memberNames();
        ctx.enumName = node?.name ?? enumName;
      }
    } else if (t.solcType.startsWith('t_enum')) {
      // A storage type id `t_enum(Color)5` carries the enum's AST id.
      const enumId = enumAstId(t.solcType);
      const node = enumId !== undefined ? cu.nodeById(enumId) : undefined;
      ctx.memberNames = node?.memberNames();
      ctx.enumName = node?.name;
    }
    return decodeValue(field, t.solcType, t.numberOfBytes, ctx);
  }

  #machineState(frame: FrameInfo, step: number): Machine.State {
    return machineStateFor(this.#trace.cursor.at(step), frame.address);
  }
}
