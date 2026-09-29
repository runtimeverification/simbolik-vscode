/**
 * The ESM server ENTRY MODULE (bundled to `build/server.mjs`).
 *
 * This is the seam that lets the CJS VSCode extension use the bundled
 * TypeScript debug server (`@simbolik/debugger`) despite the top-level-await
 * blocker: `@simbolik/debugger` transitively imports `@ethdebug/pointers`,
 * which uses TOP-LEVEL AWAIT. esbuild refuses to emit TLA into a `cjs` bundle
 * ("Top-level await is not supported with the cjs output format"), so the
 * extension cannot statically import the server. Instead we bundle the server
 * SEPARATELY as ESM (`--format=esm`, which permits TLA) and the CJS extension
 * reaches it at runtime:
 *
 *   - inline mode: `await import('./server.mjs')` from the adapter factory
 *     (a dynamic import from CJS → local ESM, supported by Node 22).
 *   - tcp mode:    spawn `node <path>/server.mjs --port <p>` as a child process
 *     (this module's `main()`).
 *
 * IMPORTANT: this module MUST NOT import `vscode` — it runs both in-process in
 * the extension host AND as a standalone Node process, and `vscode` only exists
 * in the former. Keep the VSCode boundary in the extension (`src/`), not here.
 *
 * SCOPE: this module is the build/dynamic-import seam plus a thin entry. The
 * live `SessionResolver` (forge build → kontrol-node → trace →
 * `SolidityDebugSession`) is {@link productionResolver}, defined below and used
 * by default; callers may inject their own via `createDispatcher` / `startServer`.
 */
import * as fs from 'node:fs';
import {fileURLToPath} from 'node:url';

import {
  DapDispatcher,
  startDapServer,
  SolidityDebugSession,
  type SessionResolver,
  type ResolveContext,
  type DapServerHandle,
  type LaunchInputs,
} from '@simbolik/debugger';
import {
  JsonRpcClient,
  fetchAttachContext,
  describeCause,
  parseJsonLossless,
  parseStateDump,
  type StateDump,
} from '@simbolik/engine';
import {normalizeGethTrace, normalizeKontrolTrace} from '@simbolik/lifting';
import {SourcifyRepository, recompile} from '@simbolik/sources';
import {
  loadBuildInfo,
  identifyContractByRuntimeCode,
  type Contract,
} from '@simbolik/solc';

// Re-export the pieces the host (extension) needs to reference by type/value.
export {
  DapDispatcher,
  startDapServer,
  SolidityDebugSession,
  type SessionResolver,
  type DapServerHandle,
  type LaunchInputs,
};

/**
 * An explicit "not wired" resolver: throws a clear, actionable error rather than
 * silently doing nothing, so a session that reaches `launch`/`attach` without a
 * real resolver fails loudly with the reason. The default resolver is
 * {@link productionResolver}; inject this only to deliberately disable resolution.
 */
export const notWiredResolver: SessionResolver = async () => {
  throw new Error(
    'Simbolik debug server: no live SessionResolver is wired yet ' +
      '(forge build → kontrol-node → trace). Inject a resolver via ' +
      'createDispatcher(resolve) / startServer({resolve}).'
  );
};

// ─── production SessionResolver ──────────────────────────────────────────────

/**
 * The Foundry/Anvil default (unlocked) sender — account #0 of the standard
 * test mnemonic. Used as `from` for the deploy + call transactions.
 */
const DEFAULT_ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

/**
 * The deterministic CREATE address of account #0's FIRST deployment (nonce 0):
 * `keccak256(rlp([sender, 0]))[12:]`. Used only as a fallback when a node does
 * not return a receipt (or omits `contractAddress`).
 */
const FIRST_DEPLOY_ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

/**
 * The gas cap for the deploy + setUp + call txs. Must be LARGE: like `forge
 * test`, we execute real transactions against a node, and test contracts are
 * routinely huge — a Foundry test that inherits `Test`/`Deployers` can have a
 * >180 KB runtime, whose code-deposit cost alone (200 gas/byte) exceeds 36M, and
 * its `setUp()` may deploy an entire protocol. The former 30M cap silently failed
 * such deploys (receipt status 0x0, no code), yielding a 0-step trace and a
 * debug session with no frames. kontrol-node ignores the block gas limit; the
 * anvil backend is launched with a matching `--gas-limit` (see `anvilLaunch`).
 * 10B mirrors Foundry's effectively-unbounded test gas and leaves ample headroom.
 */
const TX_GAS = '0x2540be400'; // 10_000_000_000

/**
 * The ETH balance to grant the test contract (and top up the sender) before
 * `setUp()`, mirroring `forge test`, which pre-funds the test contract. Foundry
 * projects routinely make value-bearing calls from the test contract — e.g.
 * seeding a NATIVE-currency Uniswap-v4 pool sends `1 ether` from `address(this)`
 * — which revert with a balance underflow when the contract is deployed with a
 * plain zero-value transaction (as we do) and thus starts with 0 ETH. `uint96`
 * max (~7.9e10 ETH) matches Foundry's default and is applied via
 * `anvil_setBalance` (supported by both anvil and kontrol-node); best-effort, so
 * a node without it simply keeps today's behavior.
 */
const TEST_BALANCE = '0xffffffffffffffffffffffff';

/**
 * The DAP launch/attach argument fields the resolver reads. These are the
 * `FullDebugConfiguration` fields (see `src/startDebugging.ts`) injected by the
 * extension adapter into the launch/attach `arguments`. They arrive as plain
 * JSON over DAP (tcp mode) or as live objects (inline mode), so path-shaped
 * fields (`buildInfoFiles`) may be strings, `vscode.Uri` instances, or the
 * URI's serialized `{scheme,path,fsPath,…}` form — {@link toFsPath} normalizes.
 */
interface LaunchArgs {
  request?: 'launch' | 'attach';
  contractName?: string;
  methodSignature?: string;
  /** ABI-encoded method arguments (`0x…`), or `'0x'` for a no-arg method. */
  payload?: string;
  /** Build-info file(s): fs paths, `file://` URLs, or `vscode.Uri`-shaped. */
  buildInfoFiles?: unknown[];
  jsonRpcUrl?: string;
  rpcNodeType?: 'anvil' | 'kontrol-node';
  /** Source file (path/URI) of the contract under debug. */
  file?: string;
  /** attach: the transaction hash to replay. */
  txHash?: string;
  /** attach: the Sourcify server base URL (defaults to the public server). */
  sourcifyUrl?: string;
  /** attach: the chain id (overrides the node's `eth_chainId` when provided). */
  chainId?: number;
}

/**
 * Normalize a `buildInfoFiles` entry to a filesystem path. Handles a plain
 * string path, a `file://` URL string, a `vscode.Uri` instance (`.fsPath`), and
 * the URI's serialized JSON form (`{fsPath}` / `{path}` / `{external}`). We must
 * NOT import `vscode` here (this module is bundled ESM and also spawned as a
 * standalone node process), so the URI is read purely by duck-typing.
 */
function toFsPath(entry: unknown): string {
  if (typeof entry === 'string') {
    return entry.startsWith('file://') ? fileURLToPath(entry) : entry;
  }
  if (entry !== null && typeof entry === 'object') {
    const o = entry as Record<string, unknown>;
    if (typeof o['fsPath'] === 'string') return o['fsPath'];
    if (typeof o['path'] === 'string') return o['path'];
    if (
      typeof o['external'] === 'string' &&
      o['external'].startsWith('file://')
    ) {
      return fileURLToPath(o['external']);
    }
  }
  throw new Error(
    `buildInfoFiles: cannot resolve a filesystem path from ${JSON.stringify(entry)}`
  );
}

/** The subset of a solc build-info we navigate for the method selector. */
interface RawBuildInfo {
  output?: {contracts?: RawContracts};
  contracts?: RawContracts;
}
type RawContracts = Record<
  string,
  Record<string, {evm?: {methodIdentifiers?: Record<string, string>}}>
>;

/**
 * Look up a method's 4-byte selector from a build-info's `methodIdentifiers`
 * table (`output.contracts[sourcePath][contractName].evm.methodIdentifiers`),
 * so the selector is byte-identical to solc's own — no local keccak needed.
 */
function selectorFrom(
  raw: RawBuildInfo,
  sourcePath: string,
  contractName: string,
  methodSignature: string
): string | undefined {
  const contracts = raw.output?.contracts ?? raw.contracts;
  const ids = contracts?.[sourcePath]?.[contractName]?.evm?.methodIdentifiers;
  const sel = ids?.[methodSignature];
  return sel === undefined ? undefined : sel;
}

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

/** A transaction receipt, as far as this resolver cares about it. */
interface TxReceipt {
  contractAddress?: string;
  status?: string;
  /** Hex block number the tx was mined in (used to derive the pre-trace block). */
  blockNumber?: string;
}

/**
 * Poll `eth_getTransactionReceipt` until the tx is mined (or the timeout / an
 * unsupported-method error ends the wait). Essential before tracing: a call to
 * `debug_traceTransaction` on an unmined tx yields an EMPTY trace. Returns the
 * receipt, or `undefined` if none appeared (the caller proceeds best-effort —
 * e.g. a node without receipt support).
 */
async function waitForReceipt(
  client: JsonRpcClient,
  txHash: string,
  {timeoutMs = 30_000, pollMs = 50}: {timeoutMs?: number; pollMs?: number} = {}
): Promise<TxReceipt | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let receipt: TxReceipt | null;
    try {
      receipt = await client.call<TxReceipt | null>(
        'eth_getTransactionReceipt',
        [txHash]
      );
    } catch {
      // Receipt method unsupported — don't block; let the caller proceed.
      return undefined;
    }
    if (receipt !== null) return receipt;
    if (Date.now() >= deadline) return undefined;
    await sleep(pollMs);
  }
}

/**
 * A compact, one-line summary of an RPC call's params for the debug console —
 * long hex (bytecode, calldata) is truncated and a tx object is reduced to its
 * salient fields so the log stays readable.
 */
function summarizeRpcParams(method: string, params: unknown[]): string {
  const short = (s: string): string =>
    s.length > 14 ? `${s.slice(0, 12)}…` : s;
  const first = params[0];
  if (
    (method === 'eth_sendTransaction' || method === 'eth_call') &&
    first !== null &&
    typeof first === 'object'
  ) {
    const tx = first as {to?: string; data?: string};
    const target = tx.to ? `to=${tx.to}` : 'deploy';
    const data =
      typeof tx.data === 'string' && tx.data.length >= 10
        ? ` data=${tx.data.slice(0, 10)}…`
        : '';
    return ` (${target}${data})`;
  }
  const scalars = params
    .filter(p => typeof p === 'string' || typeof p === 'number')
    .map(p => short(String(p)));
  return scalars.length > 0 ? ` (${scalars.join(', ')})` : '';
}

/** POST a JSON-RPC call and return the RAW response body STRING (unparsed). */
async function rawJsonRpc(
  url: string,
  method: string,
  params: unknown[]
): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params}),
    });
  } catch (err) {
    throw new Error(
      `JSON-RPC ${method}: cannot reach ${url} — ${describeCause(err)}`,
      {cause: err}
    );
  }
  if (!res.ok) {
    throw new Error(`JSON-RPC ${method}: HTTP ${res.status} ${res.statusText}`);
  }
  return res.text();
}

/**
 * The absolute project root the build-info's relative `sourcePath`s resolve
 * against: the prefix of the debugged source file for which
 * `root/sourcePath === file`. Returns `undefined` when `file` is absent or does
 * not end with `sourcePath` (then frames fall back to served content). Used so a
 * LOCAL launch opens the user's real, editable files.
 */
function deriveSourceRoot(
  file: string | undefined,
  sourcePath: string
): string | undefined {
  if (file === undefined) return undefined;
  let abs: string;
  try {
    abs = toFsPath(file);
  } catch {
    return undefined;
  }
  const normAbs = abs.replace(/\\/g, '/');
  const suffix = '/' + sourcePath;
  if (normAbs.endsWith(suffix)) {
    return normAbs.slice(0, normAbs.length - suffix.length);
  }
  return undefined;
}

/**
 * Resolve every distinct code address a trace executed to its build-info CU, by
 * CBOR-matching each address's runtime code against the loaded build-info(s).
 * Returns the address→{buildInfoJson, contractName} map the session uses to
 * resolve callee frames (a geth trace carries no per-step code, so this is the
 * only way to identify external calls) plus the full set of executed addresses
 * (used to scope pre-state seeding). Runtime code comes from `preState` (the one
 * `anvil_dumpState` snapshot) when available, else per-address `eth_getCode`.
 * Best-effort: an address whose code can't be resolved or matched is skipped
 * (that frame just won't map to source) — never throws.
 */
async function buildContractsByAddress(
  client: JsonRpcClient,
  traceJson: string,
  dialect: 'kontrol' | 'geth',
  buildInfos: unknown[],
  txContext: {to: string; from: string; input: string},
  preState: StateDump | undefined
): Promise<{
  contractsByAddress: Record<
    string,
    {buildInfoJson: unknown; contractName?: string; sourcePath?: string}
  >;
  addresses: string[];
}> {
  const result: Record<
    string,
    {buildInfoJson: unknown; contractName?: string; sourcePath?: string}
  > = {};
  let steps: {codeAddress: bigint}[];
  try {
    const envelope = parseTraceEnvelope(traceJson);
    steps =
      dialect === 'geth'
        ? normalizeGethTrace(envelope, txContext)
        : normalizeKontrolTrace(envelope as never);
  } catch {
    return {contractsByAddress: result, addresses: []}; // leave to the session.
  }

  const addresses = new Set<string>();
  for (const step of steps) addresses.add(addressHex(step.codeAddress));

  // Parse each build-info once for CBOR matching.
  const cus = buildInfos.map(bi => ({bi, cu: loadBuildInfo(bi)}));

  await Promise.all(
    [...addresses].map(async addr => {
      // Runtime code: prefer the pre-state dump (no extra request); a contract
      // CREATEd during the traced call won't be in the pre-call dump, so fall
      // back to eth_getCode there.
      let code = preState?.accounts[addr.toLowerCase()]?.code;
      if (code === undefined || code.length <= 2) {
        try {
          code = await client.call<string>('eth_getCode', [addr, 'latest']);
        } catch {
          return; // Node without eth_getCode (skip) — non-fatal.
        }
      }
      if (typeof code !== 'string' || code.length <= 2) return; // EOA / empty.
      for (const {bi, cu} of cus) {
        const contract = identifyContractByRuntimeCode(
          cu,
          code as `0x${string}`
        );
        if (contract !== undefined) {
          result[addr] = {
            buildInfoJson: bi,
            contractName: contract.name,
            sourcePath: contract.sourcePath,
          };
          return;
        }
      }
    })
  );
  return {contractsByAddress: result, addresses: [...addresses]};
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
 * Read the PRE-TRACE storage of each known contract via `eth_getStorageAt` at
 * `blockTag` (the block BEFORE the traced tx — i.e. after `setUp()`), so state a
 * prior tx wrote and this trace only reads (SLOAD emits no delta) is visible from
 * step 0. Keyed `address(lowercase) → slot(minimalHex) → word(minimalHex)`, the
 * exact form the node's own deltas and the storage lookup use, so a later SSTORE
 * to a seeded slot overwrites it cleanly. Best-effort: on the first RPC failure
 * (e.g. a node without `eth_getStorageAt`) it returns what it has so far.
 */
async function readInitialStorage(
  client: JsonRpcClient,
  targets: Array<{address: string; contract: Contract}>,
  blockTag: string
): Promise<Record<string, Record<string, `0x${string}`>>> {
  const out: Record<string, Record<string, `0x${string}`>> = {};
  for (const {address, contract} of targets) {
    const slots = staticStorageSlots(contract);
    const acct: Record<string, `0x${string}`> = {};
    for (const slot of slots) {
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

/**
 * Fetch the whole-chain pre-state in ONE `anvil_dumpState` call (supported by
 * both kontrol-node and anvil, with different wire formats — see
 * {@link parseStateDump}). Returns `undefined` on any failure (unsupported node,
 * malformed blob) so the caller falls back to the per-slot `eth_getStorageAt`
 * path. MUST be called at the desired pre-state point (after `setUp()`, before
 * the traced call), since `anvil_dumpState` snapshots the CURRENT state.
 */
async function fetchStateDump(
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
 * Build the `initialStorage` seed from a pre-state dump: for each address the
 * trace executed, take that account's non-zero storage (already minimal-hex
 * normalized by {@link parseStateDump}). This replaces per-slot `eth_getStorageAt`
 * and, unlike the static-layout reader, also seeds mapping / dynamic-array slots
 * (they are in the dump). Restricting to trace addresses keeps the seed small.
 */
function seedFromDump(
  dump: StateDump,
  traceAddresses: Iterable<string>
): Record<string, Record<string, `0x${string}`>> {
  const out: Record<string, Record<string, `0x${string}`>> = {};
  for (const addr of traceAddresses) {
    const acct = dump.accounts[addr.toLowerCase()];
    if (acct === undefined) continue;
    if (Object.keys(acct.storage).length > 0) {
      out[addr.toLowerCase()] = {...acct.storage};
    }
  }
  return out;
}

/** Parse a raw `debug_traceTransaction` response STRING to its trace envelope. */
function parseTraceEnvelope(traceJson: string): unknown {
  const parsed = parseJsonLossless(traceJson) as {result?: unknown};
  return parsed !== null && typeof parsed === 'object' && 'result' in parsed
    ? parsed.result
    : parsed;
}

/** Format a `bigint` EVM address as a lowercase, zero-padded 20-byte hex string. */
function addressHex(addr: bigint): string {
  return '0x' + addr.toString(16).padStart(40, '0');
}

/**
 * Coerce an `eth_chainId` result to a number, robust to a hex string (`'0x7a69'`,
 * geth/public), a decimal string (`'31337'`, kontrol) or a numeric/bigint value
 * (the lossless JSON-RPC client can yield a `bigint`). `BigInt(str)` handles both
 * hex and decimal string forms.
 */
function toChainId(raw: unknown): number {
  if (typeof raw === 'bigint') return Number(raw);
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string' && raw.length > 0) return Number(BigInt(raw));
  throw new Error(
    `attach: unexpected eth_chainId result: ${JSON.stringify(raw)}`
  );
}

/**
 * Best-effort human method name for a replayed tx: reverse-look the tx input's
 * 4-byte selector in the entry contract's `methodIdentifiers` table. Purely
 * informational (the frame name falls back to this); returns the selector hex
 * when the table is absent (recompiled build-infos omit it) or has no match, and
 * a generic tag when the tx carries no selector (a plain value transfer).
 */
function methodNameFromInput(
  raw: RawBuildInfo,
  sourcePath: string,
  contractName: string,
  input: string | undefined
): string {
  const inputHex = (input ?? '').replace(/^0x/, '');
  if (inputHex.length < 8) return 'fallback';
  const selector = inputHex.slice(0, 8).toLowerCase();
  const contracts = raw.output?.contracts ?? raw.contracts;
  const ids = contracts?.[sourcePath]?.[contractName]?.evm?.methodIdentifiers;
  if (ids !== undefined) {
    for (const [signature, sel] of Object.entries(ids)) {
      if (sel.toLowerCase() === selector) {
        return signature.slice(0, signature.indexOf('('));
      }
    }
  }
  return `0x${selector}`;
}

/**
 * The attach / remote-replay resolver: replay an ALREADY-MINED tx from
 * a generic Ethereum node, resolving each frame's sources via Sourcify.
 *
 * Flow: `fetchAttachContext` (tx context + trace envelope + dialect) → the RAW
 * trace STRING (precision-safe, via {@link rawJsonRpc} — NOT `JSON.stringify` of
 * the losslessly-parsed envelope, which would round-trip kontrol's decimal
 * bigints through `number`) → reconstruct the step model to enumerate the
 * distinct executing code addresses → per address, resolve verified sources on
 * Sourcify + recompile to a build-info (concurrent, per-address failures are
 * NON-FATAL: an unverified frame simply won't map to source) → build the
 * address→build-info registry → assemble {@link LaunchInputs} and launch. The
 * ENTRY contract (`txContext.to`) MUST be verified (else a clear throw).
 */
async function attachResolver(
  args: LaunchArgs,
  ctx?: ResolveContext
): Promise<SolidityDebugSession> {
  const {jsonRpcUrl, txHash} = args;
  if (!jsonRpcUrl) throw new Error('attach: missing jsonRpcUrl');
  if (!txHash) throw new Error('attach: missing txHash');

  ctx?.log(`Attaching to ${txHash} at ${jsonRpcUrl} …`);
  const client = new JsonRpcClient({
    url: jsonRpcUrl,
    onRequest: (method, params) =>
      ctx?.log(`  → ${method}${summarizeRpcParams(method, params)}`),
  });

  // 1. Fetch the tx context + trace envelope and classify the dialect.
  const {dialect, envelope, txContext} = await fetchAttachContext(
    client,
    txHash
  );

  // 2. The RAW trace response STRING (precision-safe) is what LaunchInputs wants:
  //    re-fetch it unparsed rather than re-stringifying the parsed envelope, so
  //    kontrol's decimal-bigint fields keep full precision.
  ctx?.log(`Backend: ${dialect} trace dialect`);
  ctx?.log(`  → debug_traceTransaction (${txHash.slice(0, 12)}…)`);
  const traceJson = await rawJsonRpc(jsonRpcUrl, 'debug_traceTransaction', [
    txHash,
    {},
  ]);

  // 3. chainId — an explicit arg wins; else the node's, robust to hex/decimal.
  const chainId = args.chainId ?? toChainId(await client.call('eth_chainId'));

  // 4. Reconstruct the step model to enumerate the distinct executing code
  //    addresses (each frame's contract), as lowercase 20-byte hex.
  const steps =
    dialect === 'geth'
      ? normalizeGethTrace(envelope, txContext)
      : normalizeKontrolTrace(envelope as never);
  const addresses = new Set<string>();
  for (const step of steps) addresses.add(addressHex(step.codeAddress));

  // 5. Per-address: resolve verified sources on Sourcify + recompile to a
  //    build-info. Concurrent, with a per-address try/catch so an unverified /
  //    failing address is skipped (that frame just won't map to source).
  const repo = new SourcifyRepository(
    args.sourcifyUrl !== undefined ? {baseUrl: args.sourcifyUrl} : {}
  );
  const contractsByAddress: Record<
    string,
    {buildInfoJson: unknown; contractName?: string; sourcePath?: string}
  > = {};
  await Promise.all(
    [...addresses].map(async addr => {
      try {
        const resolved = await repo.resolve(chainId, addr);
        if (resolved === undefined) return; // unverified — skip, non-fatal.
        const buildInfoJson = await recompile(resolved);
        contractsByAddress[addr] = {buildInfoJson, contractName: resolved.name};
      } catch {
        // A per-address Sourcify/recompile failure is non-fatal: skip it.
      }
    })
  );

  // 6. Entry contract = the tx's `to` (lowercased). It MUST be verified — the
  //    debugger launches from it, so an unverified entry is a hard error.
  const entryAddr = txContext.to.toLowerCase();
  const entry = contractsByAddress[entryAddr];
  if (entry === undefined) {
    throw new Error(
      `attach: entry contract ${entryAddr} is not verified on Sourcify`
    );
  }
  const entryCu = loadBuildInfo(entry.buildInfoJson);
  // Prefer the resolved name; else the sole deployable contract; else the first.
  const entryContract =
    (entry.contractName !== undefined
      ? entryCu.contracts().find(c => c.name === entry.contractName)
      : undefined) ??
    entryCu.contracts().find(c => c.runtimeBytecode().length > 2) ??
    entryCu.contracts()[0];
  if (entryContract === undefined) {
    throw new Error(
      `attach: entry build-info for ${entryAddr} declares no contracts`
    );
  }
  const contractName = entryContract.name;
  const sourcePath = entryContract.sourcePath;
  const methodName = methodNameFromInput(
    entry.buildInfoJson as RawBuildInfo,
    sourcePath,
    contractName,
    txContext.input
  );

  // 7. Assemble LaunchInputs and launch the session.
  const inputs: LaunchInputs = {
    buildInfos: Object.values(contractsByAddress).map(c => c.buildInfoJson),
    traceJson,
    sourcePath,
    contractName,
    methodName,
    codeAddress: entryAddr,
    dialect,
    // Only geth traces need the per-step tx context supplied explicitly.
    ...(dialect === 'geth' ? {txContext} : {}),
    contractsByAddress,
  };

  ctx?.log(
    `Resolved ${Object.keys(contractsByAddress).length} contract(s) via Sourcify.`
  );
  const session = new SolidityDebugSession();
  await session.launch(inputs);
  ctx?.log('Session ready — paused at entry.');
  return session;
}

/**
 * The LIVE resolver: turn DAP launch args into an already-launched
 * {@link SolidityDebugSession} by deploying the target contract, calling the
 * method, fetching the raw trace, and building {@link LaunchInputs}. Runs INSIDE
 * the server (inline or spawned) — hence `vscode`-free: build-info is read via
 * `node:fs`, the node is driven via `@simbolik/engine`'s JSON-RPC client.
 *
 * `attach` replays an already-mined tx from a generic node, resolving
 * each frame's sources via Sourcify + recompile — see {@link attachResolver}.
 */
export const productionResolver: SessionResolver = async (rawArgs, ctx) => {
  const args = (rawArgs ?? {}) as LaunchArgs;

  if (args.request === 'attach') {
    return attachResolver(args, ctx);
  }

  // ── validate + normalize inputs ──────────────────────────────────────────
  const {contractName, methodSignature, jsonRpcUrl, rpcNodeType} = args;
  if (!contractName) throw new Error('launch: missing contractName');
  if (!methodSignature) throw new Error('launch: missing methodSignature');
  if (!jsonRpcUrl) throw new Error('launch: missing jsonRpcUrl');
  const paths = (args.buildInfoFiles ?? []).map(toFsPath);
  if (paths.length === 0) {
    throw new Error('launch: no buildInfoFiles provided');
  }

  // ── read + parse the build-info(s) ───────────────────────────────────────
  const rawJsons = paths.map(p => fs.readFileSync(p, 'utf8'));
  const buildInfos = rawJsons.map(s => JSON.parse(s) as unknown);

  // Find the CU + contract that declares `contractName`, and remember which raw
  // build-info it came from (for the selector lookup). Contract names are NOT
  // unique within a project (e.g. uniswap-v4 has both `src/test/HooksTest.sol`
  // and `test/libraries/Hooks.t.sol` declaring `HooksTest`), so when several
  // match, prefer the one declared in the launched `file`; the first match is
  // only the fallback.
  const launchedFile =
    args.file === undefined
      ? undefined
      : toFsPath(args.file).replace(/\\/g, '/');
  let contract: import('@simbolik/solc').Contract | undefined;
  let rawForContract: RawBuildInfo | undefined;
  search: for (let i = 0; i < buildInfos.length; i++) {
    const cu = loadBuildInfo(buildInfos[i]);
    for (const found of cu.contracts()) {
      if (found.name !== contractName) continue;
      const inFile =
        launchedFile !== undefined &&
        launchedFile.endsWith('/' + found.sourcePath);
      if (contract === undefined || inFile) {
        contract = found;
        rawForContract = buildInfos[i] as RawBuildInfo;
      }
      if (inFile) break search;
    }
  }
  if (contract === undefined || rawForContract === undefined) {
    throw new Error(
      `launch: contract "${contractName}" not found in the provided build-info(s)`
    );
  }
  const sourcePath = contract.sourcePath;

  const creationBytecode = contract.initBytecode();
  if (creationBytecode.length <= 2) {
    throw new Error(
      `launch: contract "${contractName}" has no creation bytecode (abstract/interface?)`
    );
  }

  // ── build the calldata (selector + abi-encoded payload) ──────────────────
  const selector = selectorFrom(
    rawForContract,
    sourcePath,
    contractName,
    methodSignature
  );
  if (selector === undefined) {
    throw new Error(
      `launch: method "${methodSignature}" not found in ${contractName}'s methodIdentifiers`
    );
  }
  const payloadHex = (args.payload ?? '0x').replace(/^0x/, '');
  const calldata = `0x${selector}${payloadHex}`;
  const methodName = methodSignature.slice(0, methodSignature.indexOf('('));

  const dialect: 'kontrol' | 'geth' =
    rpcNodeType === 'kontrol-node' ? 'kontrol' : 'geth';
  ctx?.log(
    `Backend: ${rpcNodeType} (${dialect} trace dialect) at ${jsonRpcUrl}`
  );

  // ── deploy + call + trace ────────────────────────────────────────────────
  // The RPC observer streams every request to the debug console for diagnostics.
  const client = new JsonRpcClient({
    url: jsonRpcUrl,
    onRequest: (method, params) =>
      ctx?.log(`  → ${method}${summarizeRpcParams(method, params)}`),
  });

  ctx?.log(`Deploying ${contractName} …`);
  const deployTxHash = await client.call<string>('eth_sendTransaction', [
    {from: DEFAULT_ACCOUNT, gas: TX_GAS, data: creationBytecode},
  ]);

  // Prefer the receipt's contractAddress; fall back to the deterministic
  // first-deploy address if the node returns no receipt / omits the field.
  // Waiting also guarantees the deploy is MINED before the calls below.
  let contractAddress = FIRST_DEPLOY_ADDRESS;
  const deployReceipt = await waitForReceipt(client, deployTxHash);
  if (deployReceipt && typeof deployReceipt.contractAddress === 'string') {
    contractAddress = deployReceipt.contractAddress;
  }
  // A FAILED deploy (status 0x0) still returns a receipt AND a contractAddress,
  // but deposits no code — a call to it then traces as a 0-step no-op, which used
  // to surface only as a frameless, un-steppable session. Fail fast with an
  // actionable message instead. The usual cause is an oversized contract whose
  // code-deposit gas exceeds the tx gas (see TX_GAS) — report the sizes so the
  // fix is obvious.
  if (deployReceipt?.status === '0x0') {
    const runtimeBytes = (contract.runtimeBytecode().length - 2) / 2;
    const initBytes = (creationBytecode.length - 2) / 2;
    throw new Error(
      `Deploying ${contractName} failed (transaction reverted, status 0x0). ` +
        `Its runtime bytecode is ${runtimeBytes} bytes (init ${initBytes} bytes); ` +
        'depositing that much code can exceed the transaction gas limit. If you ' +
        'are on a node that enforces the 24576-byte contract-size limit, raise ' +
        'or disable it (anvil: --disable-code-size-limit).'
    );
  }

  // Pre-fund the test contract (and top up the sender), like `forge test`. A
  // Foundry test contract is deployed by us with a zero-value tx, so it holds 0
  // ETH — yet its `setUp()`/method may make value-bearing calls (a native-
  // currency pool seed sends `1 ether` from `address(this)`), which revert with a
  // balance underflow. Foundry avoids this by giving the test contract a large
  // balance; we mirror that via `anvil_setBalance`. Best-effort: a node lacking
  // the method leaves balances unchanged (the setUp-revert warning below still
  // fires). Cannot use a value-bearing transfer instead — a test contract is
  // rarely `payable`, so a plain send would itself revert.
  for (const acct of [contractAddress, DEFAULT_ACCOUNT]) {
    try {
      await client.call('anvil_setBalance', [acct, TEST_BALANCE]);
    } catch {
      // Node without anvil_setBalance — skip (non-fatal).
    }
  }

  // Foundry semantics: `setUp()` establishes the fixture state a test/debug
  // method depends on (deploy tokens, fund actors, …). Our launch calls ONE
  // method, so — like `forge test` — run `setUp()` first (a separate tx; the
  // node persists state between txs) whenever the contract declares it and it is
  // not itself the method being debugged. Without this, a method reading fixture
  // state reverts immediately (e.g. calling a token that was never deployed).
  const setUpSelector = selectorFrom(
    rawForContract,
    sourcePath,
    contractName,
    'setUp()'
  );
  if (setUpSelector !== undefined && methodSignature !== 'setUp()') {
    ctx?.log('Running setUp() …');
    const setUpTxHash = await client.call<string>('eth_sendTransaction', [
      {
        from: DEFAULT_ACCOUNT,
        to: contractAddress,
        gas: TX_GAS,
        data: `0x${setUpSelector}`,
      },
    ]);
    // Ensure setUp is mined (state committed) before the debugged call runs.
    const setUpReceipt = await waitForReceipt(client, setUpTxHash);
    // A REVERTED setUp leaves the fixture state incomplete, so the debugged
    // method will typically revert early (or read zeros). This is not fatal — we
    // still trace the call — but the user must know their session is running
    // against a half-initialized fixture rather than a clean one.
    if (setUpReceipt?.status === '0x0') {
      ctx?.log(
        '⚠ setUp() reverted (status 0x0): the test fixture is only partially ' +
          'initialized, so the debugged method may revert early or read zeroed ' +
          'state. This often means the node does not support a cheatcode or ' +
          'deployment the setUp relies on.'
      );
    }
  }

  // Snapshot the PRE-CALL state (after deploy + setUp, before the traced call) in
  // ONE `anvil_dumpState` request — the source for both contract identification
  // (runtime code) and pre-trace storage seeding, replacing N × eth_getCode +
  // M × eth_getStorageAt. Must be taken HERE, before the call, since the dump is
  // of the CURRENT state. `undefined` on an unsupported node → per-slot fallback.
  const preState = await fetchStateDump(client);

  ctx?.log(`Calling ${methodName}() at ${contractAddress} …`);
  const callTxHash = await client.call<string>('eth_sendTransaction', [
    {from: DEFAULT_ACCOUNT, to: contractAddress, gas: TX_GAS, data: calldata},
  ]);
  // CRITICAL: the tx MUST be mined before we trace it — `debug_traceTransaction`
  // on an unmined hash returns empty `structLogs` (a 0-step trace), which then
  // has no frames. Waiting here makes tracing deterministic. The receipt's block
  // number also anchors the pre-trace storage read below.
  const callReceipt = await waitForReceipt(client, callTxHash);

  // The RAW JSON-RPC response STRING is what LaunchInputs.traceJson wants (it
  // re-parses losslessly), so bypass the parsing client for this one call.
  ctx?.log(`  → debug_traceTransaction (${callTxHash.slice(0, 12)}…)`);
  const traceJson = await rawJsonRpc(jsonRpcUrl, 'debug_traceTransaction', [
    callTxHash,
    {},
  ]);

  // Derive the project root so frames can reference the REAL on-disk files:
  // the root is the prefix for which `root/sourcePath === <the source file>`.
  const sourceRoot = deriveSourceRoot(args.file, sourcePath);

  // ── assemble LaunchInputs + launch the session ───────────────────────────
  // Resolve every EXTERNAL contract the tx touched to its CU. A geth trace has
  // no per-step code, so without this the debugger can't identify a callee (e.g.
  // an ERC20 reached via a `mint` call) and mis-maps its steps onto the ENTRY
  // contract's source — the cursor jumps into unrelated lines, and the bogus
  // source-map jumps corrupt step-over too. We enumerate the distinct code
  // addresses, fetch each one's on-chain runtime code, and CBOR-match it to a
  // contract in the build-info(s) → an address→CU map the session resolves by.
  const {contractsByAddress, addresses: traceAddresses} =
    await buildContractsByAddress(
      client,
      traceJson,
      dialect,
      buildInfos,
      {to: contractAddress, from: DEFAULT_ACCOUNT, input: calldata},
      preState
    );

  // Seed pre-trace storage: a delta-encoded trace omits slots that an earlier tx
  // (e.g. `setUp()`) wrote and this one only READS — SLOAD emits no delta — so
  // fixture state would otherwise read as zero at the entry step. Preferred path:
  // the single `anvil_dumpState` snapshot (full storage, incl. mapping / dynamic-
  // array slots the static-layout reader cannot enumerate). Fallback (unsupported
  // node): read each known contract's static layout slots via `eth_getStorageAt`
  // at the block BEFORE the traced tx (= post-`setUp()`).
  let initialStorage: Record<string, Record<string, `0x${string}`>> | undefined;
  if (preState !== undefined) {
    // Seed the entry contract + every address the trace executed.
    const seed = seedFromDump(preState, [contractAddress, ...traceAddresses]);
    if (Object.keys(seed).length > 0) initialStorage = seed;
  } else if (callReceipt?.blockNumber !== undefined) {
    let block: bigint | undefined;
    try {
      block = BigInt(callReceipt.blockNumber);
    } catch {
      block = undefined;
    }
    if (block !== undefined && block > 0n) {
      const seedTargets = new Map<string, Contract>();
      seedTargets.set(contractAddress.toLowerCase(), contract);
      for (const [addr, {buildInfoJson, contractName: cn}] of Object.entries(
        contractsByAddress
      )) {
        const key = addr.toLowerCase();
        if (cn === undefined || seedTargets.has(key)) continue;
        const found = loadBuildInfo(buildInfoJson)
          .contracts()
          .find(c => c.name === cn);
        if (found !== undefined) seedTargets.set(key, found);
      }
      const blockTag = `0x${(block - 1n).toString(16)}`;
      const seed = await readInitialStorage(
        client,
        [...seedTargets].map(([address, c]) => ({address, contract: c})),
        blockTag
      );
      if (Object.keys(seed).length > 0) initialStorage = seed;
    }
  }

  const inputs: LaunchInputs = {
    buildInfos,
    traceJson,
    sourcePath,
    contractName,
    methodName,
    codeAddress: contractAddress,
    dialect,
    ...(sourceRoot !== undefined ? {sourceRoot} : {}),
    ...(Object.keys(contractsByAddress).length > 0 ? {contractsByAddress} : {}),
    ...(initialStorage !== undefined ? {initialStorage} : {}),
    // geth traces carry no per-step tx context — supply it explicitly.
    ...(dialect === 'geth'
      ? {
          txContext: {
            to: contractAddress,
            from: DEFAULT_ACCOUNT,
            input: calldata,
          },
        }
      : {}),
  };

  const session = new SolidityDebugSession();
  await session.launch(inputs);
  ctx?.log('Session ready — paused at entry.');
  return session;
};

/**
 * Create a {@link DapDispatcher} for INLINE (in-process) hosting. The extension
 * host calls this after `await import('./server.mjs')` and drives the returned
 * dispatcher's `handle()` directly (no socket).
 *
 * @param resolve resolves DAP launch/attach args into an already-launched
 *   {@link SolidityDebugSession}. Defaults to {@link productionResolver} (the
 *   live deploy → call → trace flow); inject a different resolver for tests.
 */
export function createDispatcher(
  resolve: SessionResolver = productionResolver
): DapDispatcher {
  return new DapDispatcher(resolve);
}

/**
 * Start the DAP TCP server for TCP (out-of-process) hosting. Wraps
 * {@link startDapServer} with the same default-resolver behavior as
 * {@link createDispatcher}.
 */
export function startServer(opts: {
  port: number;
  host?: string;
  resolve?: SessionResolver;
}): Promise<DapServerHandle> {
  return startDapServer({
    port: opts.port,
    host: opts.host,
    resolve: opts.resolve ?? productionResolver,
  });
}

/** Parse `--port <n>` (and optional `--host <h>`) from an argv tail. */
function parseArgs(argv: string[]): {port: number; host?: string} {
  let port = 0;
  let host: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') port = Number(argv[++i]);
    else if (argv[i] === '--host') host = argv[++i];
  }
  return {port, host};
}

/**
 * TCP-mode entry: `node server.mjs --port <p> [--host <h>]`. Starts the DAP TCP
 * server and keeps the process alive; prints the bound port so a parent process
 * can discover an OS-assigned port (`--port 0`).
 */
async function main(): Promise<void> {
  const {port, host} = parseArgs(process.argv.slice(2));
  const handle = await startServer({port, host});
  // A parent (the extension in tcp mode) reads this line to learn the port.
  console.log(`simbolik-debug-server listening port=${handle.port}`);
  const shutdown = () => {
    // A signal-driven CLI shutdown must end the process even if some handle
    // (a pending socket, a timer) would keep the event loop alive.
    // eslint-disable-next-line n/no-process-exit
    void handle.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Run main() ONLY when executed directly as a script (ESM-safe detection),
// never on import. `import.meta.url` is the file URL of THIS module; `argv[1]`
// is the script Node was told to run — equal when run as `node server.mjs`.
const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMainModule) {
  main().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
