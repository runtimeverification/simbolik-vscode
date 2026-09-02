/**
 * Random-access reconstruction of full EVM machine state from a delta-encoded
 * `Step[]`.
 *
 * The trace only records what CHANGED on each step; to answer "what did memory /
 * storage / the account set look like at step i?" a consumer must ACCUMULATE
 * every delta from step 0 through step i. `StateCursor.at(i)` does exactly that,
 * and — crucially for a debugger that jumps around while reverse-stepping — its
 * result is a pure function of `i`: it never shares a mutable accumulator
 * between calls. To keep random access cheap it snapshots the accumulated state
 * at periodic checkpoints and replays only the tail from the nearest checkpoint.
 */
import type {Hex} from '@simbolik/protocol';

import type {Step} from './step.js';

/** Accumulated per-account state at a given step. */
export interface AccountState {
  /** Hex key exactly as emitted by the node. */
  address: string;
  balance?: Hex;
  nonce?: Hex;
  /** Deployed runtime code (from `deployedCodeChanges`). */
  code?: Hex;
  /** Init code (from `initCodeChanges`). */
  initCode?: Hex;
  /** slot(hex) -> value(hex), accumulated per-slot across steps. */
  storage: Record<string, Hex>;
}

/** Full reconstructed machine state at one step. */
export interface MachineState {
  index: number;
  pc: number;
  op: string;
  depth: number;
  gas: number;
  stack: Hex[];
  /** 32-byte words; `[]` when empty. */
  memory: Hex[];
  /** Current executing program. */
  bytecode: Hex;
  calldata: Hex;
  returnData: Hex;
  accounts: Map<string, AccountState>;
  /** `true` when this step runs CREATE/CREATE2 init (constructor) code. */
  isInitCode: boolean;
  /** `true` when this is the last step of the trace. */
  isTerminal: boolean;
}

/** The mutable carry-forward accumulator; snapshotted / replayed internally. */
interface Accumulator {
  memory: Hex[];
  bytecode: Hex;
  calldata: Hex;
  returnData: Hex;
  accounts: Map<string, AccountState>;
}

/** How often to snapshot the accumulator so random access stays sub-O(n). */
const CHECKPOINT_INTERVAL = 64;

/** Deep-copy an accumulator so snapshots never alias the running state. */
function cloneAccumulator(source: Accumulator): Accumulator {
  const accounts = new Map<string, AccountState>();
  for (const [address, account] of source.accounts) {
    accounts.set(address, {...account, storage: {...account.storage}});
  }
  return {
    memory: [...source.memory],
    bytecode: source.bytecode,
    calldata: source.calldata,
    returnData: source.returnData,
    accounts,
  };
}

/** Apply one step's deltas to `accum` in place. */
function applyStep(accum: Accumulator, step: Step): void {
  // Blobs: adopt a fresh image only when the change is non-null; otherwise the
  // previous image carries forward untouched.
  if (step.memoryChange !== null) accum.memory = step.memoryChange;
  if (step.programChange !== null) accum.bytecode = step.programChange;
  if (step.callDataChange !== null) accum.calldata = step.callDataChange;
  if (step.returnDataChange !== null) accum.returnData = step.returnDataChange;

  // Accounts: every address touched by any account-flavoured delta this step.
  const addresses = new Set<string>([
    ...Object.keys(step.balanceChanges),
    ...Object.keys(step.nonceChanges),
    ...Object.keys(step.deployedCodeChanges),
    ...Object.keys(step.initCodeChanges),
    ...Object.keys(step.storageChanges),
  ]);

  for (const address of addresses) {
    let account = accum.accounts.get(address);
    if (account === undefined) {
      account = {address, storage: {}};
      accum.accounts.set(address, account);
    }
    // Scalar fields are REPLACED when present this step, else kept.
    if (address in step.balanceChanges) account.balance = step.balanceChanges[address];
    if (address in step.nonceChanges) account.nonce = step.nonceChanges[address];
    if (address in step.deployedCodeChanges) account.code = step.deployedCodeChanges[address];
    if (address in step.initCodeChanges) account.initCode = step.initCodeChanges[address];
    // Storage is a PER-SLOT merge: earlier slots persist, touched slots win.
    const storageDelta = step.storageChanges[address];
    if (storageDelta !== undefined) {
      account.storage = {...account.storage, ...storageDelta};
    }
  }
}

/** A fresh, empty accumulator (defaults: `[]` memory, `"0x"` blobs). */
function emptyAccumulator(): Accumulator {
  return {
    memory: [],
    bytecode: '0x',
    calldata: '0x',
    returnData: '0x',
    accounts: new Map<string, AccountState>(),
  };
}

export class StateCursor {
  readonly length: number;
  readonly #steps: Step[];
  /** Snapshots keyed by step index: accumulated state THROUGH that step. */
  readonly #checkpoints = new Map<number, Accumulator>();

  /**
   * @param steps the normalized trace steps.
   * @param initialStorage PRE-TRACE storage to seed step 0 with, keyed
   *   `address(hex) → slot(hex) → word(hex)`. A delta-encoded trace only records
   *   what CHANGED during THIS transaction, so a slot written by an earlier tx
   *   (e.g. Foundry's `setUp()`) and merely READ here never appears — SLOAD emits
   *   no delta. Seeding lets the resolver supply that pre-state (read via
   *   `eth_getStorageAt` at the pre-trace block) so it is visible from step 0 and
   *   is correctly OVERWRITTEN per-slot by any later SSTORE (same minimal-hex key
   *   the node and the storage lookup use).
   */
  constructor(
    steps: Step[],
    initialStorage?: Record<string, Record<string, Hex>>,
  ) {
    this.#steps = steps;
    this.length = steps.length;

    // Precompute checkpoints in a single forward pass. Each stored snapshot is
    // a deep copy, so it can never be mutated by a later replay.
    const accum = emptyAccumulator();
    if (initialStorage !== undefined) {
      for (const [rawAddress, slots] of Object.entries(initialStorage)) {
        const address = rawAddress.toLowerCase();
        accum.accounts.set(address, {address, storage: {...slots}});
      }
    }
    for (let i = 0; i < steps.length; i++) {
      applyStep(accum, steps[i]);
      if (i % CHECKPOINT_INTERVAL === 0) {
        this.#checkpoints.set(i, cloneAccumulator(accum));
      }
    }
  }

  /**
   * Reconstruct the full machine state at `index`. Pure in `index`: the result
   * depends only on the argument, never on prior call order.
   */
  at(index: number): MachineState {
    if (!Number.isInteger(index) || index < 0 || index >= this.length) {
      throw new RangeError(
        `StateCursor.at(${index}): index out of range [0, ${this.length})`,
      );
    }

    // Replay from the nearest checkpoint at or before `index` into a private
    // clone, so nothing shared is ever mutated.
    const checkpointIndex = Math.floor(index / CHECKPOINT_INTERVAL) * CHECKPOINT_INTERVAL;
    const snapshot = this.#checkpoints.get(checkpointIndex);
    const accum = snapshot ? cloneAccumulator(snapshot) : emptyAccumulator();
    for (let i = checkpointIndex + 1; i <= index; i++) {
      applyStep(accum, this.#steps[i]);
    }

    const step = this.#steps[index];
    return {
      index: step.index,
      pc: step.pc,
      op: step.op,
      depth: step.depth,
      gas: step.gas,
      // Defensive copy: like `memory`, never hand out a reference into the
      // underlying Step, so a caller mutating the result can't corrupt future
      // `at()` calls for this index.
      stack: [...step.stack],
      memory: [...accum.memory],
      bytecode: accum.bytecode,
      calldata: accum.calldata,
      returnData: accum.returnData,
      accounts: accum.accounts,
      isInitCode: step.isInitCode,
      isTerminal: index === this.length - 1,
    };
  }
}
