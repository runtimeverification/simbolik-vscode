/**
 * Linear step model for a kontrol-node execution trace.
 *
 * `normalizeKontrolTrace` turns the raw, delta-encoded `KontrolStructLog[]` into
 * a positional `Step[]`. It performs exactly one transformation beyond copying:
 * it coerces the address / 256-bit scalar fields to `bigint`. Everything else —
 * in particular the `*Change` / `*Changes` delta fields — is preserved RAW
 * (`null` still means "unchanged this step", `[]`/`{}` still means "empty this
 * step"). Accumulating those deltas into full machine state is the job of
 * `StateCursor`, not of the step model.
 */
import type {Hex, KontrolStructLog, KontrolTrace} from '@simbolik/protocol';

/** One normalized step: per-step scalars plus the raw delta fields. */
export interface Step {
  /** 0-based position in the trace. */
  index: number;
  pc: number;
  op: string;
  depth: number;
  gas: number;
  isInitCode: boolean;
  codeAddress: bigint;
  targetAddress: bigint;
  msgSender: bigint;
  msgValue: bigint;
  txOrigin: bigint;
  statusCode: string;
  /** Stack as hex words, top-of-stack LAST (verbatim from the node). */
  stack: Hex[];

  // ── Raw delta fields, exactly as emitted ──────────────────────────────────
  // `null` means "unchanged this step" (carry the parent value forward);
  // `[]` / `{}` means "empty this step". `StateCursor` resolves carry-forward.
  memoryChange: Hex[] | null;
  programChange: Hex | null;
  callDataChange: Hex | null;
  returnDataChange: Hex | null;
  storageChanges: Record<string, Record<string, Hex>>;
  balanceChanges: Record<string, Hex>;
  nonceChanges: Record<string, Hex>;
  deployedCodeChanges: Record<string, Hex>;
  initCodeChanges: Record<string, Hex>;
}

/**
 * Coerce a numeric scalar to `bigint`. The lossless JSON parser leaves large
 * 160-/256-bit literals as `bigint` but small ones (e.g. `msgValue: 0`) as
 * `number`; the `Step` contract requires all of these fields to be `bigint`.
 */
function toBigInt(value: bigint | number): bigint {
  return BigInt(value);
}

/** Normalize a kontrol-node trace into a positional, bigint-coerced `Step[]`. */
export function normalizeKontrolTrace(trace: KontrolTrace): Step[] {
  return trace.structLogs.map((log: KontrolStructLog, index): Step => ({
    index,
    pc: log.pc,
    op: log.op,
    depth: log.depth,
    gas: log.gas,
    isInitCode: log.isInitCode,
    codeAddress: toBigInt(log.codeAddress),
    targetAddress: toBigInt(log.targetAddress),
    msgSender: toBigInt(log.msgSender),
    msgValue: toBigInt(log.msgValue),
    txOrigin: toBigInt(log.txOrigin),
    statusCode: log.statusCode,
    stack: log.stack,
    // Delta fields are carried through untouched.
    memoryChange: log.memoryChange,
    programChange: log.programChange,
    callDataChange: log.callDataChange,
    returnDataChange: log.returnDataChange,
    storageChanges: log.storageChanges,
    balanceChanges: log.balanceChanges,
    nonceChanges: log.nonceChanges,
    deployedCodeChanges: log.deployedCodeChanges,
    initCodeChanges: log.initCodeChanges,
  }));
}
