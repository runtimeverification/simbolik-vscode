/**
 * Pre-trace state for a local launch: the `anvil_dumpState` snapshot and the
 * `initialStorage` seed derived from it (or, on nodes without the dump, from
 * per-slot `eth_getStorageAt` reads).
 *
 * WHY: a delta-encoded trace omits slots that an earlier tx (e.g. `setUp()`)
 * wrote and this one only READS — SLOAD emits no delta — so fixture state would
 * otherwise read as zero at the entry step.
 */
import type {LaunchInputs} from '@simbolik/debugger';
import {
  parseStateDump,
  type JsonRpcClient,
  type StateDump,
} from '@simbolik/engine';
import {loadBuildInfo, type Contract} from '@simbolik/solc';

import type {ContractsByAddress} from './contracts';

type StorageSeed = NonNullable<LaunchInputs['initialStorage']>;

/**
 * Fetch the whole-chain pre-state in ONE `anvil_dumpState` call (supported by
 * both kontrol-node and anvil, with different wire formats — see
 * {@link parseStateDump}). Returns `undefined` on any failure (unsupported node,
 * malformed blob) so the caller falls back to the per-slot `eth_getStorageAt`
 * path. MUST be called at the desired pre-state point (after `setUp()`, before
 * the traced call), since `anvil_dumpState` snapshots the CURRENT state.
 */
export async function fetchStateDump(
  client: JsonRpcClient
): Promise<StateDump | undefined> {
  try {
    const raw = await client.call<unknown>('anvil_dumpState', []);
    return parseStateDump(raw);
  } catch {
    return undefined;
  }
}

/**
 * The `initialStorage` seed for a launch, or `undefined` when there is nothing
 * to seed. Preferred path: the single `anvil_dumpState` snapshot (full storage,
 * incl. mapping / dynamic-array slots the static-layout reader cannot
 * enumerate), restricted to the entry contract + every address the trace
 * executed. Fallback (unsupported node): read each known contract's static
 * layout slots via `eth_getStorageAt` at the block BEFORE the traced tx
 * (= post-`setUp()`).
 */
export async function initialStorageFor(opts: {
  client: JsonRpcClient;
  preState: StateDump | undefined;
  entry: {address: string; contract: Contract};
  traceAddresses: string[];
  contractsByAddress: ContractsByAddress;
  /** Hex block number the traced tx was mined in, from its receipt. */
  callBlockNumber: string | undefined;
}): Promise<StorageSeed | undefined> {
  const {client, preState, entry, callBlockNumber} = opts;
  let seed: StorageSeed = {};
  if (preState !== undefined) {
    seed = seedFromDump(preState, [entry.address, ...opts.traceAddresses]);
  } else {
    const block = parseBlockNumber(callBlockNumber);
    if (block !== undefined && block > 0n) {
      seed = await readInitialStorage(
        client,
        storageTargets(entry, opts.contractsByAddress),
        `0x${(block - 1n).toString(16)}`
      );
    }
  }
  return Object.keys(seed).length > 0 ? seed : undefined;
}

function parseBlockNumber(hex: string | undefined): bigint | undefined {
  if (hex === undefined) return undefined;
  try {
    return BigInt(hex);
  } catch {
    return undefined;
  }
}

/**
 * Build the seed from a pre-state dump: for each address the trace executed,
 * take that account's non-zero storage (already minimal-hex normalized by
 * {@link parseStateDump}).
 */
function seedFromDump(
  dump: StateDump,
  traceAddresses: Iterable<string>
): StorageSeed {
  const out: StorageSeed = {};
  for (const addr of traceAddresses) {
    const acct = dump.accounts[addr.toLowerCase()];
    if (acct === undefined) continue;
    if (Object.keys(acct.storage).length > 0) {
      out[addr.toLowerCase()] = {...acct.storage};
    }
  }
  return out;
}

/** The entry contract plus every identified callee, keyed by lowercase address. */
function storageTargets(
  entry: {address: string; contract: Contract},
  contractsByAddress: ContractsByAddress
): Array<{address: string; contract: Contract}> {
  const targets = new Map<string, Contract>();
  targets.set(entry.address.toLowerCase(), entry.contract);
  for (const [addr, {buildInfoJson, contractName}] of Object.entries(
    contractsByAddress
  )) {
    const key = addr.toLowerCase();
    if (contractName === undefined || targets.has(key)) continue;
    const found = loadBuildInfo(buildInfoJson)
      .contracts()
      .find(c => c.name === contractName);
    if (found !== undefined) targets.set(key, found);
  }
  return [...targets].map(([address, contract]) => ({address, contract}));
}

/** Cap on slots read per storage variable (guards against huge fixed arrays). */
const MAX_SLOTS_PER_VAR = 64;

/**
 * The STATIC top-level storage slots a contract occupies, from its solc storage
 * layout: each variable's base slot, plus the extra slots an inplace value type /
 * struct / fixed array spans (from `numberOfBytes`), capped. Mapping / dynamic-
 * array ELEMENTS live at computed (keccak) slots we cannot enumerate blindly, so
 * only their base slot is included — those stay lazily populated by the trace.
 */
function staticStorageSlots(contract: Contract): bigint[] {
  const slots = new Set<bigint>();
  for (const entry of contract.storageLayout()) {
    let base: bigint;
    try {
      base = BigInt(entry.slot);
    } catch {
      continue;
    }
    const type = contract.storageType(entry.type);
    let span = 1;
    if (
      type !== undefined &&
      type.encoding !== 'mapping' &&
      type.encoding !== 'dynamic_array'
    ) {
      const bytes = type.numberOfBytes > 0 ? type.numberOfBytes : 32;
      span = Math.min(Math.max(1, Math.ceil(bytes / 32)), MAX_SLOTS_PER_VAR);
    }
    for (let i = 0; i < span; i++) slots.add(base + BigInt(i));
  }
  return [...slots];
}

/**
 * Read the PRE-TRACE storage of each target via `eth_getStorageAt` at
 * `blockTag`. Keyed `address(lowercase) → slot(minimalHex) → word(minimalHex)`,
 * the exact form the node's own deltas and the storage lookup use, so a later
 * SSTORE to a seeded slot overwrites it cleanly. Best-effort: on the first RPC
 * failure (e.g. a node without `eth_getStorageAt`) it returns what it has so far.
 */
async function readInitialStorage(
  client: JsonRpcClient,
  targets: Array<{address: string; contract: Contract}>,
  blockTag: string
): Promise<StorageSeed> {
  const out: StorageSeed = {};
  for (const {address, contract} of targets) {
    const acct: StorageSeed[string] = {};
    for (const slot of staticStorageSlots(contract)) {
      const slotHex = `0x${slot.toString(16)}`;
      let raw: string;
      try {
        raw = await client.call<string>('eth_getStorageAt', [
          address,
          slotHex,
          blockTag,
        ]);
      } catch {
        return out; // Unsupported / errored — keep the best-effort seed so far.
      }
      if (typeof raw !== 'string') continue;
      let value: bigint;
      try {
        value = BigInt(raw);
      } catch {
        continue;
      }
      // Skip zero slots — the storage lookup defaults absent slots to zero, so
      // seeding them adds nothing but noise.
      if (value !== 0n) acct[slotHex] = `0x${value.toString(16)}`;
    }
    if (Object.keys(acct).length > 0) out[address.toLowerCase()] = acct;
  }
  return out;
}
