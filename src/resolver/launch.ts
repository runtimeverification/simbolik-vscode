/**
 * The LIVE launch flow: deploy the target contract on a node, run `setUp()`,
 * call the method, fetch the raw trace, and assemble {@link LaunchInputs}.
 * Build-info is read via `node:fs`; the node is driven via `@simbolik/engine`'s
 * JSON-RPC client.
 */
import * as fs from 'node:fs';

import type {LaunchInputs, ResolveContext} from '@simbolik/debugger';
import type {JsonRpcClient} from '@simbolik/engine';
import type {Contract} from '@simbolik/solc';

import {
  executedAddresses,
  findContract,
  identifyLocalContracts,
  loadBuildInfos,
  methodNameOf,
  methodSelector,
  parseTraceEnvelope,
} from './contracts';
import {
  deriveSourceRoot,
  toFsPath,
  toPosixFsPath,
  type LaunchArgs,
} from './launchArgs';
import {fetchStateDump, initialStorageFor} from './preState';
import {
  fetchRawTrace,
  loggingClient,
  waitForReceipt,
  type TxReceipt,
} from './rpc';

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

/** Resolve DAP `launch` args into the inputs of a fresh debug session. */
export async function launchInputs(
  args: LaunchArgs,
  ctx?: ResolveContext
): Promise<LaunchInputs> {
  const {contractName, methodSignature, jsonRpcUrl, rpcNodeType} = args;
  if (!contractName) throw new Error('launch: missing contractName');
  if (!methodSignature) throw new Error('launch: missing methodSignature');
  if (!jsonRpcUrl) throw new Error('launch: missing jsonRpcUrl');
  const paths = (args.buildInfoFiles ?? []).map(toFsPath);
  if (paths.length === 0) {
    throw new Error('launch: no buildInfoFiles provided');
  }

  const buildInfoJsons = paths.map(
    p => JSON.parse(fs.readFileSync(p, 'utf8')) as unknown
  );
  const buildInfos = loadBuildInfos(buildInfoJsons);
  const launchedFile =
    args.file === undefined ? undefined : toPosixFsPath(args.file);
  const found = findContract(buildInfos, contractName, launchedFile);
  if (found === undefined) {
    throw new Error(
      `launch: contract "${contractName}" not found in the provided build-info(s)`
    );
  }
  const {contract, buildInfo} = found;
  if (contract.initBytecode().length <= 2) {
    throw new Error(
      `launch: contract "${contractName}" has no creation bytecode (abstract/interface?)`
    );
  }

  const selector = methodSelector(buildInfo, contract, methodSignature);
  if (selector === undefined) {
    throw new Error(
      `launch: method "${methodSignature}" not found in ${contractName}'s methodIdentifiers`
    );
  }
  const payloadHex = (args.payload ?? '0x').replace(/^0x/, '');
  const calldata = `0x${selector}${payloadHex}`;
  const methodName = methodNameOf(methodSignature);

  const dialect: 'kontrol' | 'geth' =
    rpcNodeType === 'kontrol-node' ? 'kontrol' : 'geth';
  ctx?.log(
    `Backend: ${rpcNodeType} (${dialect} trace dialect) at ${jsonRpcUrl}`
  );
  const client = loggingClient(jsonRpcUrl, ctx);

  ctx?.log(`Deploying ${contractName} …`);
  const contractAddress = await deploy(client, contract);
  await fundAccounts(client, [contractAddress, DEFAULT_ACCOUNT]);

  // Foundry semantics: `setUp()` establishes the fixture state a test/debug
  // method depends on (deploy tokens, fund actors, …). Our launch calls ONE
  // method, so — like `forge test` — run `setUp()` first (a separate tx; the
  // node persists state between txs) whenever the contract declares it and it is
  // not itself the method being debugged. Without this, a method reading fixture
  // state reverts immediately (e.g. calling a token that was never deployed).
  const setUpSelector = methodSelector(buildInfo, contract, 'setUp()');
  if (setUpSelector !== undefined && methodSignature !== 'setUp()') {
    ctx?.log('Running setUp() …');
    await runSetUp(client, contractAddress, setUpSelector, ctx);
  }

  // Snapshot the PRE-CALL state (after deploy + setUp, before the traced call) in
  // ONE `anvil_dumpState` request — the source for both contract identification
  // (runtime code) and pre-trace storage seeding, replacing N × eth_getCode +
  // M × eth_getStorageAt. Must be taken HERE, before the call, since the dump is
  // of the CURRENT state. `undefined` on an unsupported node → per-slot fallback.
  const preState = await fetchStateDump(client);

  ctx?.log(`Calling ${methodName}() at ${contractAddress} …`);
  // Waiting for the receipt is CRITICAL: `debug_traceTransaction` on an unmined
  // hash returns empty `structLogs` (a 0-step trace), which then has no frames.
  // The receipt's block number also anchors the fallback pre-trace storage read.
  const call = await transact(client, {to: contractAddress, data: calldata});
  const traceJson = await fetchRawTrace(client, call.hash);

  // Resolve every EXTERNAL contract the tx touched to its CU. A geth trace has
  // no per-step code, so without this the debugger can't identify a callee (e.g.
  // an ERC20 reached via a `mint` call) and mis-maps its steps onto the ENTRY
  // contract's source — the cursor jumps into unrelated lines, and the bogus
  // source-map jumps corrupt step-over too.
  const txContext = {
    to: contractAddress,
    from: DEFAULT_ACCOUNT,
    input: calldata,
  };
  let traceAddresses: string[];
  try {
    traceAddresses = executedAddresses(
      parseTraceEnvelope(traceJson),
      dialect,
      txContext
    );
  } catch {
    traceAddresses = []; // Unparseable trace — leave the error to the session.
  }
  const contractsByAddress = await identifyLocalContracts(
    client,
    traceAddresses,
    buildInfos,
    preState
  );

  const initialStorage = await initialStorageFor({
    client,
    preState,
    entry: {address: contractAddress, contract},
    traceAddresses,
    contractsByAddress,
    callBlockNumber: call.receipt?.blockNumber,
  });

  // Derive the project root so frames can reference the REAL on-disk files.
  const sourceRoot = deriveSourceRoot(args.file, contract.sourcePath);

  return {
    buildInfos: buildInfoJsons,
    traceJson,
    sourcePath: contract.sourcePath,
    contractName,
    methodName,
    codeAddress: contractAddress,
    dialect,
    ...(sourceRoot !== undefined ? {sourceRoot} : {}),
    ...(Object.keys(contractsByAddress).length > 0 ? {contractsByAddress} : {}),
    ...(initialStorage !== undefined ? {initialStorage} : {}),
    // geth traces carry no per-step tx context — supply it explicitly.
    ...(dialect === 'geth' ? {txContext} : {}),
  };
}

/** Send a tx from the default account and wait until it is mined. */
async function transact(
  client: JsonRpcClient,
  tx: {to?: string; data: string}
): Promise<{hash: string; receipt: TxReceipt | undefined}> {
  const hash = await client.call<string>('eth_sendTransaction', [
    {from: DEFAULT_ACCOUNT, gas: TX_GAS, ...tx},
  ]);
  return {hash, receipt: await waitForReceipt(client, hash)};
}

/** Deploy `contract` and return its address. */
async function deploy(
  client: JsonRpcClient,
  contract: Contract
): Promise<string> {
  const creationBytecode = contract.initBytecode();
  // Waiting also guarantees the deploy is MINED before the calls that follow.
  const {receipt} = await transact(client, {data: creationBytecode});
  // A FAILED deploy (status 0x0) still returns a receipt AND a contractAddress,
  // but deposits no code — a call to it then traces as a 0-step no-op, which used
  // to surface only as a frameless, un-steppable session. Fail fast with an
  // actionable message instead. The usual cause is an oversized contract whose
  // code-deposit gas exceeds the tx gas (see TX_GAS) — report the sizes so the
  // fix is obvious.
  if (receipt?.status === '0x0') {
    const runtimeBytes = (contract.runtimeBytecode().length - 2) / 2;
    const initBytes = (creationBytecode.length - 2) / 2;
    throw new Error(
      `Deploying ${contract.name} failed (transaction reverted, status 0x0). ` +
        `Its runtime bytecode is ${runtimeBytes} bytes (init ${initBytes} bytes); ` +
        'depositing that much code can exceed the transaction gas limit. If you ' +
        'are on a node that enforces the 24576-byte contract-size limit, raise ' +
        'or disable it (anvil: --disable-code-size-limit).'
    );
  }
  // Prefer the receipt's contractAddress; fall back to the deterministic
  // first-deploy address if the node returns no receipt / omits the field.
  return typeof receipt?.contractAddress === 'string'
    ? receipt.contractAddress
    : FIRST_DEPLOY_ADDRESS;
}

/**
 * Pre-fund the test contract (and top up the sender), like `forge test`. A
 * Foundry test contract is deployed by us with a zero-value tx, so it holds 0
 * ETH — yet its `setUp()`/method may make value-bearing calls (a native-currency
 * pool seed sends `1 ether` from `address(this)`), which revert with a balance
 * underflow. Foundry avoids this by giving the test contract a large balance; we
 * mirror that via `anvil_setBalance`. Best-effort: a node lacking the method
 * leaves balances unchanged (the setUp-revert warning still fires). Cannot use a
 * value-bearing transfer instead — a test contract is rarely `payable`, so a
 * plain send would itself revert.
 */
async function fundAccounts(
  client: JsonRpcClient,
  accounts: string[]
): Promise<void> {
  for (const acct of accounts) {
    try {
      await client.call('anvil_setBalance', [acct, TEST_BALANCE]);
    } catch {
      // Node without anvil_setBalance — skip (non-fatal).
    }
  }
}

/** Run `setUp()` on the deployed contract, warning if it reverts. */
async function runSetUp(
  client: JsonRpcClient,
  contractAddress: string,
  setUpSelector: string,
  ctx?: ResolveContext
): Promise<void> {
  // Waiting ensures setUp is mined (state committed) before the debugged call.
  const {receipt} = await transact(client, {
    to: contractAddress,
    data: `0x${setUpSelector}`,
  });
  // A REVERTED setUp leaves the fixture state incomplete, so the debugged
  // method will typically revert early (or read zeros). This is not fatal — we
  // still trace the call — but the user must know their session is running
  // against a half-initialized fixture rather than a clean one.
  if (receipt?.status === '0x0') {
    ctx?.log(
      '⚠ setUp() reverted (status 0x0): the test fixture is only partially ' +
        'initialized, so the debugged method may revert early or read zeroed ' +
        'state. This often means the node does not support a cheatcode or ' +
        'deployment the setUp relies on.'
    );
  }
}
