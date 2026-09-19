import {keccak256} from 'ethereum-cryptography/keccak';
import {bytesToHex, utf8ToBytes} from 'ethereum-cryptography/utils';

import type {Hex} from '@simbolik/protocol';
import {AstNode, findAstNode} from './ast.js';
import {ensureHexPrefix} from './hex.js';
import {
  buildInstructionIndex,
  parseSourceMap,
  type SourceMapEntry,
} from './sourceMap.js';

/** One row of a solc `storageLayout.storage` table. */
export interface StorageEntry {
  astId: number;
  contract: string;
  label: string;
  offset: number;
  slot: string;
  type: string;
}

/** One entry of the solc `storageLayout.types` table (coerced to numbers). */
export interface StorageType {
  label: string;
  numberOfBytes: number;
  encoding: string;
  /** Element type id of a dynamic/fixed array (`encoding: 'dynamic_array'`). */
  base?: string;
  /** Struct members (`encoding: 'inplace'`), slot/offset RELATIVE to the base. */
  members?: {label: string; slot: number; offset: number; type: string}[];
  /** Key type id of a mapping (`encoding: 'mapping'`). */
  key?: string;
  /** Value type id of a mapping (`encoding: 'mapping'`). */
  value?: string;
}

/** The solc optimizer settings for a compilation unit. */
export interface OptimizerSettings {
  enabled: boolean;
  runs?: number;
}

/** Raw `storageLayout.types` entry as it appears in the build-info JSON. */
interface RawStorageType {
  label?: string;
  numberOfBytes?: string;
  encoding?: string;
  base?: string;
  members?: {
    label?: string;
    slot?: string | number;
    offset?: string | number;
    type?: string;
    astId?: number;
    contract?: string;
  }[];
  key?: string;
  value?: string;
}

/** Shape of the fields of the standard-json build-info we consume. */
interface RawBuildInfo {
  solcVersion?: string;
  input?: {
    sources?: Record<string, {content?: string}>;
    settings?: {
      optimizer?: {enabled?: boolean; runs?: number};
      viaIR?: boolean;
    };
  };
  output?: {
    sources?: Record<string, {id?: number; ast?: unknown}>;
    contracts?: Record<string, Record<string, RawContract>>;
  };
}

interface RawContract {
  abi?: RawAbiEntry[];
  storageLayout?: {
    storage?: StorageEntry[];
    types?: Record<string, RawStorageType>;
  };
  evm?: {
    bytecode?: {object?: string; sourceMap?: string};
    deployedBytecode?: {
      object?: string;
      sourceMap?: string;
      /** AST-id → byte ranges patched at deploy time (immutable values). */
      immutableReferences?: Record<string, {start: number; length: number}[]>;
    };
  };
}

/** A raw ABI input (event/function parameter) as it appears in build-info JSON. */
interface RawAbiInput {
  name?: string;
  /** ABI canonical type, e.g. `uint256`, `address`, `bytes32`, `tuple`, `uint8[]`. */
  type?: string;
  indexed?: boolean;
  /** Component types of a `tuple`/`tuple[]` ABI input. */
  components?: RawAbiInput[];
}

/** A raw ABI entry (only `type:'event'` is consumed by {@link Contract.events}). */
interface RawAbiEntry {
  type?: string;
  name?: string;
  inputs?: RawAbiInput[];
  anonymous?: boolean;
}

/** One parameter of a contract event: name, type, and indexed flag. */
export interface EventParam {
  name: string;
  /** A solc-style type id (e.g. `t_uint256`) mapped from the ABI canonical type. */
  solcType: string;
  /** The ABI canonical type label (e.g. `uint256`, `address`). */
  typeLabel: string;
  indexed: boolean;
}

/** A contract event: its name, topic-0 selector, and typed parameters. */
export interface EventInfo {
  name: string;
  /** `'0x'` + keccak256 of the canonical signature, or `''` for anonymous events. */
  selector: string;
  params: EventParam[];
}

/** A source file in the compilation unit, with its content and AST. */
export class SourceFile {
  readonly id: number;
  readonly path: string;
  readonly content: string;
  readonly #ast: unknown;
  #lineStarts: number[] | undefined;

  constructor(id: number, path: string, content: string, ast: unknown) {
    this.id = id;
    this.path = path;
    this.content = content;
    this.#ast = ast;
  }

  ast(): AstNode {
    return new AstNode(this.#ast as Record<string, unknown>);
  }

  /** Find the AST node with the given `id` anywhere in this source's tree. */
  nodeById(id: number): AstNode | undefined {
    return findAstNode(this.ast(), (n) => n.id === id);
  }

  /**
   * Map a UTF-8 byte offset to a 1-based line and 0-based column. Line starts
   * are computed over the UTF-8 byte encoding of the content.
   */
  offsetToPosition(offset: number): {line: number; column: number} {
    const starts = this.#lineStartTable();
    // Binary search for the greatest line start <= offset.
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return {line: lo + 1, column: offset - starts[lo]!};
  }

  #lineStartTable(): number[] {
    if (this.#lineStarts === undefined) {
      const bytes = new TextEncoder().encode(this.content);
      const starts = [0];
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] === 0x0a) {
          starts.push(i + 1);
        }
      }
      this.#lineStarts = starts;
    }
    return this.#lineStarts;
  }
}

/** A compiled contract: bytecode, source maps, and storage layout. */
export class Contract {
  readonly name: string;
  readonly sourcePath: string;
  readonly #raw: RawContract;

  constructor(name: string, sourcePath: string, raw: RawContract) {
    this.name = name;
    this.sourcePath = sourcePath;
    this.#raw = raw;
  }

  initBytecode(): Hex {
    return ensureHexPrefix(this.#raw.evm?.bytecode?.object ?? '');
  }

  runtimeBytecode(): Hex {
    return ensureHexPrefix(this.#raw.evm?.deployedBytecode?.object ?? '');
  }

  /**
   * Byte ranges in the RUNTIME bytecode that hold immutable values (patched at
   * deploy time). The deployed code differs from {@link runtimeBytecode} only in
   * these ranges, so masking them lets identification match a deployed contract
   * to its build-info even when immutables (and library addresses) are filled in.
   * Flattened across all AST ids; offsets/lengths are in bytes.
   */
  immutableRanges(): {start: number; length: number}[] {
    const refs = this.#raw.evm?.deployedBytecode?.immutableReferences ?? {};
    return Object.values(refs).flat();
  }

  initSourceMap(): SourceMapEntry[] {
    return parseSourceMap(this.#raw.evm?.bytecode?.sourceMap ?? '');
  }

  runtimeSourceMap(): SourceMapEntry[] {
    return parseSourceMap(this.#raw.evm?.deployedBytecode?.sourceMap ?? '');
  }

  storageLayout(): StorageEntry[] {
    return this.#raw.storageLayout?.storage ?? [];
  }

  /** The `storageLayout.types` table, keyed by solc type id (e.g. `t_uint256`). */
  storageTypes(): Record<string, StorageType> {
    const raw = this.#raw.storageLayout?.types ?? {};
    const types: Record<string, StorageType> = {};
    for (const [id, t] of Object.entries(raw)) {
      const type: StorageType = {
        label: t.label ?? '',
        numberOfBytes: Number(t.numberOfBytes),
        encoding: t.encoding ?? '',
      };
      // Additive reference-layout fields. Members are projected to
      // EXACTLY {label, slot, offset, type} with slot/offset coerced to numbers
      // (dropping solc's astId/contract).
      if (t.base !== undefined) type.base = t.base;
      if (t.members !== undefined) {
        type.members = t.members.map((m) => ({
          label: m.label ?? '',
          slot: Number(m.slot),
          offset: Number(m.offset),
          type: m.type ?? '',
        }));
      }
      if (t.key !== undefined) type.key = t.key;
      if (t.value !== undefined) type.value = t.value;
      types[id] = type;
    }
    return types;
  }

  /** Resolve a single solc storage type by id, or `undefined` if absent. */
  storageType(typeId: string): StorageType | undefined {
    return this.storageTypes()[typeId];
  }

  /**
   * The contract's declared events, each with its topic-0 selector and typed
   * parameters, sourced from the build-info ABI. The selector is `'0x'` +
   * keccak256 of the canonical signature `Name(type1,type2,…)` built over ALL
   * inputs in declaration order (indexed + non-indexed) using ABI canonical type
   * names; anonymous events carry no topic-0 selector (`selector: ''`).
   */
  events(): EventInfo[] {
    const abi = this.#raw.abi ?? [];
    const out: EventInfo[] = [];
    for (const entry of abi) {
      if (entry.type !== 'event') continue;
      const inputs = entry.inputs ?? [];
      const params: EventParam[] = inputs.map((i) => ({
        name: i.name ?? '',
        solcType: canonicalToSolcType(i.type ?? ''),
        typeLabel: i.type ?? '',
        indexed: i.indexed ?? false,
      }));
      const signature = `${entry.name ?? ''}(${inputs
        .map(abiCanonicalType)
        .join(',')})`;
      const selector =
        entry.anonymous === true
          ? ''
          : '0x' + bytesToHex(keccak256(utf8ToBytes(signature)));
      out.push({name: entry.name ?? '', selector, params});
    }
    return out;
  }
}

/**
 * The canonical ABI type of an input for signature building — the input's own
 * `type`, except a `tuple`/`tuple[]` expands to `(comp1,comp2,…)` over its
 * components (preserving any trailing array suffix).
 */
function abiCanonicalType(input: RawAbiInput): string {
  const type = input.type ?? '';
  if (type.startsWith('tuple')) {
    const inner = `(${(input.components ?? []).map(abiCanonicalType).join(',')})`;
    return inner + type.slice('tuple'.length);
  }
  return type;
}

/** Map an ABI canonical type name to a solc-style type id (e.g. `t_uint256`). */
function canonicalToSolcType(type: string): string {
  if (/^(u?int)\d+$/.test(type) || /^bytes\d+$/.test(type)) return `t_${type}`;
  if (type === 'uint') return 't_uint256';
  if (type === 'int') return 't_int256';
  if (type === 'address') return 't_address';
  if (type === 'bool') return 't_bool';
  if (type === 'bytes') return 't_bytes';
  if (type === 'string') return 't_string';
  return `t_${type}`;
}

/** The parsed compilation unit backing one build-info. */
export class CompilationUnit {
  readonly solcVersion: string;
  readonly #sources: SourceFile[];
  readonly #contracts: Contract[];
  readonly #optimizer: OptimizerSettings;
  readonly #viaIR: boolean;

  constructor(
    solcVersion: string,
    sources: SourceFile[],
    contracts: Contract[],
    optimizer: OptimizerSettings = {enabled: false},
    viaIR = false,
  ) {
    this.solcVersion = solcVersion;
    this.#sources = sources;
    this.#contracts = contracts;
    this.#optimizer = optimizer;
    this.#viaIR = viaIR;
  }

  /**
   * Whether this build-info was compiled through the Yul IR pipeline
   * (`input.settings.viaIR === true`). Under viaIR the stack scheduler reorders/
   * reuses slots per instruction, so the "height − declarationRank" fixed-slot
   * model is invalid; consumers use it to decide whether that positional model is
   * a safe completeness fallback (legacy only).
   */
  viaIR(): boolean {
    return this.#viaIR;
  }

  /**
   * The optimizer settings this build-info was compiled with, taken from
   * `input.settings.optimizer`. Defaults to `{enabled: false}` when absent.
   */
  optimizer(): OptimizerSettings {
    return this.#optimizer;
  }

  sources(): SourceFile[] {
    return [...this.#sources];
  }

  sourceById(id: number): SourceFile | undefined {
    return this.#sources.find((s) => s.id === id);
  }

  sourceByPath(path: string): SourceFile | undefined {
    return this.#sources.find((s) => s.path === path);
  }

  /** Lazy id → AST node index across ALL sources (built once, then reused). */
  #nodeIndex: Map<number, AstNode> | undefined;

  /**
   * The AST node with `id` anywhere in the compilation unit (any source). Solc AST
   * ids are unique across the whole build, so a cross-source lookup resolves a
   * reference (`referencedDeclaration`) that points into another file — e.g. a
   * user-defined value type's definition, or an inherited declaration. The index
   * is built lazily on first use and cached.
   */
  nodeById(id: number): AstNode | undefined {
    if (this.#nodeIndex === undefined) {
      const index = new Map<number, AstNode>();
      const visit = (n: AstNode): void => {
        index.set(n.id, n);
        for (const c of n.children()) visit(c);
      };
      for (const s of this.#sources) visit(s.ast());
      this.#nodeIndex = index;
    }
    return this.#nodeIndex.get(id);
  }

  contracts(): Contract[] {
    return [...this.#contracts];
  }

  contract(sourcePath: string, name: string): Contract | undefined {
    return this.#contracts.find(
      (c) => c.sourcePath === sourcePath && c.name === name,
    );
  }

  /**
   * The members of a struct type — `{name, typeString}` in declaration order —
   * resolved from a struct TYPE IDENTIFIER, or an empty array if unresolved.
   *
   * Accepts either the AST structural id (`t_struct$_Point_$10_memory_ptr`, which
   * embeds the `StructDefinition` AST id between `$_…_$` and the next `_`) or the
   * storage-style id (`t_struct(Point)10_storage`). It resolves the definition by
   * that embedded AST id (like an enum's trailing id), falling back to the
   * struct's simple name — mirroring the enum accessor pattern in the debugger.
   */
  structMembers(typeId: string): {name: string; typeString: string}[] {
    // Embedded AST id: `…$_Point_$10_memory_ptr` or `t_struct(Point)10_storage`.
    const idMatch = /\$(\d+)_/.exec(typeId) ?? /\)(\d+)/.exec(typeId);
    if (idMatch) {
      const id = Number(idMatch[1]);
      for (const source of this.#sources) {
        const node = source.nodeById(id);
        if (node?.nodeType === 'StructDefinition') {
          return node.structMembers();
        }
      }
    }
    // Fallback: resolve by the struct's simple name (`$_Point_$` / `(Point)`).
    const nameMatch =
      /\$_(\w+)_\$/.exec(typeId) ?? /t_struct\((\w+)\)/.exec(typeId);
    if (nameMatch) {
      const name = nameMatch[1];
      for (const source of this.#sources) {
        const node = findAstNode(
          source.ast(),
          (n) => n.nodeType === 'StructDefinition' && n.name === name,
        );
        if (node !== undefined) {
          return node.structMembers();
        }
      }
    }
    return [];
  }

  /**
   * The `FunctionDefinition` AST node for `methodName` inside `contractName`
   * within `sourcePath`, or `undefined`. Exposed so consumers navigate typed
   * AST accessors instead of reaching into the raw build-info JSON.
   */
  functionDefinition(
    sourcePath: string,
    contractName: string,
    methodName: string,
  ): AstNode | undefined {
    const source = this.#sources.find((s) => s.path === sourcePath);
    if (source === undefined) {
      return undefined;
    }
    const contractNode = findAstNode(
      source.ast(),
      (n) => n.nodeType === 'ContractDefinition' && n.name === contractName,
    );
    const scope = contractNode ?? source.ast();
    return findAstNode(
      scope,
      (n) => n.nodeType === 'FunctionDefinition' && n.name === methodName,
    );
  }
}

/** Parse a solc standard-json build-info into a {@link CompilationUnit}. */
export function loadBuildInfo(json: unknown): CompilationUnit {
  const build = json as RawBuildInfo;
  const inputSources = build.input?.sources ?? {};
  const outputSources = build.output?.sources ?? {};
  const outputContracts = build.output?.contracts ?? {};

  const sources: SourceFile[] = [];
  for (const [path, out] of Object.entries(outputSources)) {
    sources.push(
      new SourceFile(
        out.id ?? -1,
        path,
        inputSources[path]?.content ?? '',
        out.ast,
      ),
    );
  }

  const contracts: Contract[] = [];
  for (const [path, byName] of Object.entries(outputContracts)) {
    for (const [name, raw] of Object.entries(byName)) {
      contracts.push(new Contract(name, path, raw));
    }
  }

  const rawOpt = build.input?.settings?.optimizer;
  const optimizer: OptimizerSettings = {
    enabled: rawOpt?.enabled ?? false,
    ...(rawOpt?.runs !== undefined ? {runs: rawOpt.runs} : {}),
  };

  return new CompilationUnit(
    build.solcVersion ?? '',
    sources,
    contracts,
    optimizer,
    build.input?.settings?.viaIR ?? false,
  );
}

/** The source-map entry active at a runtime/init PC, or `undefined`. */
export function sourceMapEntryAtPc(
  contract: Contract,
  pc: number,
  kind: 'init' | 'runtime',
): SourceMapEntry | undefined {
  const bytecode =
    kind === 'init' ? contract.initBytecode() : contract.runtimeBytecode();
  const {pcToInstruction} = buildInstructionIndex(bytecode);
  const instruction = pcToInstruction.get(pc);
  if (instruction === undefined) {
    return undefined;
  }
  const entries =
    kind === 'init' ? contract.initSourceMap() : contract.runtimeSourceMap();
  return entries[instruction];
}
