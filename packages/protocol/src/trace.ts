/**
 * Execution-trace wire types for the two supported node dialects.
 *
 * kontrol-node emits a RICH, delta-encoded trace; anvil (and other geth-style
 * nodes) emit a MINIMAL trace that the lifting layer must reconstruct call
 * context/storage from. Keeping both here lets the engine's trace factories
 * (see plan §"Trace model") share one contract.
 */

/** A `0x`-prefixed hex string. */
export type Hex = `0x${string}`;

/**
 * One step of a kontrol-node trace.
 * Source of truth: kontrol-node `kdist/trace-json.md` (`traceItemToJson`),
 * example `test-data/output/kontrol_traceTransaction_0.expected.json`.
 *
 * ── Delta semantics (critical) ──────────────────────────────────────────────
 * The `*Change` / `*Changes` fields are populated ONLY on the step where the
 * value changes (`null` / `{}` otherwise). Consumers must ACCUMULATE them to
 * reconstruct full memory/storage/accounts at an arbitrary step — this is what
 * `@simbolik/lifting`'s `StateCursor` does.
 *
 * ── Numeric precision (critical) ────────────────────────────────────────────
 * Address and 256-bit fields are emitted by the node as *decimal integers* that
 * exceed `Number.MAX_SAFE_INTEGER`. They are typed as `bigint` here; the engine
 * MUST decode the trace with a lossless (bigint-preserving) JSON parser and
 * never plain `JSON.parse`, which would silently corrupt them.
 */
export interface KontrolStructLog {
  pc: number;
  op: string;
  /** Stack as hex words, top-of-stack LAST. */
  stack: Hex[];
  /** Full memory as 32-byte hex words on change; `[]` when empty; `null` when unchanged. */
  memoryChange: Hex[] | null;
  /** account → slot → value (all hex); only slots changed this step. */
  storageChanges: Record<string, Record<string, Hex>>;
  nonceChanges: Record<string, Hex>;
  balanceChanges: Record<string, Hex>;
  callDataChange: Hex | null;
  returnDataChange: Hex | null;
  /** Full bytecode when the executing program/context changed; `null` otherwise. */
  programChange: Hex | null;
  deployedCodeChanges: Record<string, Hex>;
  initCodeChanges: Record<string, Hex>;
  depth: number;
  gas: number;
  /** NOTE: despite the name the node emits gasPrice here, not per-op gas cost. */
  gasCost: bigint;
  difficulty: bigint;
  blockNumber: number;
  blockTimestamp: number;
  coinbase: bigint;
  targetAddress: bigint;
  codeAddress: bigint;
  msgSender: bigint;
  msgValue: bigint;
  txOrigin: bigint;
  isInitCode: boolean;
  statusCode: string;
}

/**
 * One step of a standard geth-style trace (anvil `--steps-tracing`).
 * Minimal: no call-context/account fields — the anvil trace factory
 * reconstructs those by decoding the CALL/CREATE/SSTORE opcode families
 * (see plan §1).
 */
export interface GethStructLog {
  pc: number;
  op: string;
  gas: number;
  gasCost: number;
  depth: number;
  stack?: Hex[];
  memory?: Hex[];
  storage?: Record<string, Hex>;
  error?: string;
  refund?: number;
}

/** `debug_traceTransaction` envelope, generic over the per-step log dialect. */
export interface DebugTraceResult<TLog> {
  failed: boolean;
  gas: number | bigint;
  returnValue: string;
  structLogs: TLog[];
}

export type KontrolTrace = DebugTraceResult<KontrolStructLog>;
export type GethTrace = DebugTraceResult<GethStructLog>;
