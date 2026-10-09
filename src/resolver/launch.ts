/**
 * The launch flow: deploy the target contract on a node, run `setUp()`,
 * call the method, fetch the raw trace, and assemble {@link LaunchInputs}.
 * Build-info is read via `node:fs`; the node is driven via `@simbolik/engine`'s
 * JSON-RPC client.
 */
import * as fs from 'node:fs';

import type {LaunchInputs, ResolveContext} from '@simbolik/debugger';
import {NODE_RPC_METHODS, type JsonRpcClient} from '@simbolik/engine';
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
 * The deterministic CREATE address of account #0's first deployment (nonce 0):
 * `keccak256(rlp([sender, 0]))[12:]`. Used only as a fallback when a node does
 * not return a receipt (or omits `contractAddress`).
 */
const FIRST_DEPLOY_ADDRESS = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

/**
 * The gas cap for the deploy + setUp + call txs. It must be large: test
 * contracts are routinely huge (a Foundry test inheriting `Test` can have a
 * >180 KB runtime, whose code-deposit cost alone at 200 gas/byte exceeds 36M),
 * and `setUp()` may deploy an entire protocol. Too low a cap makes the deploy
 * fail with status 0x0 and no code. 10B approximates Foundry's effectively
 * unbounded test gas. kontrol-node ignores the block gas limit; anvil is
 * launched with a matching `--gas-limit` (see `anvilLaunch`).
 */
const TX_GAS = '0x2540be400'; // 10_000_000_000

/**
 * The ETH balance granted to the test contract and sender before `setUp()`
 * (see {@link fundAccounts}). `uint96` max (~7.9e10 ETH) matches Foundry's
 * default.
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
  const methods =
    NODE_RPC_METHODS[rpcNodeType === 'kontrol-node' ? 'kontrol-node' : 'anvil'];
  ctx?.log(
    `Backend: ${rpcNodeType} (${dialect} trace dialect) at ${jsonRpcUrl}`
  );
  const client = loggingClient(jsonRpcUrl, ctx);

  ctx?.log(`Deploying ${contractName} …`);
  const contractAddress = await deploy(client, contract);
  await fundAccounts(client, methods.setBalance, [
    contractAddress,
    DEFAULT_ACCOUNT,
  ]);

  // Like `forge test`, run `setUp()` first (as a separate tx) whenever the
  // contract declares it and it is not itself the method being debugged: it
  // establishes the fixture state the method depends on.
  const setUpSelector = methodSelector(buildInfo, contract, 'setUp()');
  if (setUpSelector !== undefined && methodSignature !== 'setUp()') {
    ctx?.log('Running setUp() …');
    await runSetUp(client, contractAddress, setUpSelector, ctx);
  }

  // Snapshot the pre-call state (after deploy + setUp, before the traced call)
  // in one state-dump request. It serves both contract identification (runtime
  // code) and pre-trace storage seeding. It must be taken here, since the dump
  // reflects the current state. `undefined` on an unsupported node, in which
  // case both fall back to per-address / per-slot RPC reads.
  const preState = await fetchStateDump(client, methods.dumpState);

  ctx?.log(`Calling ${methodName}() at ${contractAddress} …`);
  // `transact` waits for the receipt: tracing an unmined hash returns empty
  // `structLogs`. The receipt's block number also anchors the fallback
  // pre-trace storage read.
  const call = await transact(client, {to: contractAddress, data: calldata});
  const traceJson = await fetchRawTrace(
    client,
    methods.traceTransaction,
    call.hash
  );

  // Resolve every contract the tx executed to its compilation unit. A geth
  // trace has no per-step code, so without this map a callee's steps would be
  // mapped onto the entry contract's source, which also breaks step-over.
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

  // Derive the project root so frames can reference the real on-disk files.
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
  const {receipt} = await transact(client, {data: creationBytecode});
  // A failed deploy (status 0x0) still returns a receipt and a contractAddress
  // but deposits no code, so the call would trace as a 0-step no-op. Fail fast
  // instead. The usual cause is an oversized contract whose code-deposit gas
  // exceeds the tx gas (see TX_GAS), so report the sizes.
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
 * Pre-fund the test contract (and top up the sender), like `forge test`. The
 * contract is deployed with a zero-value tx, yet its `setUp()` or method may
 * make value-bearing calls from `address(this)`, which would revert with a
 * balance underflow. Uses the node's `setBalanceMethod` rather than a transfer,
 * because test contracts are rarely `payable`. Best-effort: a node lacking the
 * method leaves balances unchanged.
 */
async function fundAccounts(
  client: JsonRpcClient,
  setBalanceMethod: string,
  accounts: string[]
): Promise<void> {
  for (const acct of accounts) {
    try {
      await client.call(setBalanceMethod, [acct, TEST_BALANCE]);
    } catch {
      // Node without the method — skip (non-fatal).
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
  const {receipt} = await transact(client, {
    to: contractAddress,
    data: `0x${setUpSelector}`,
  });
  // A reverted setUp leaves the fixture half-initialized. Not fatal (the call
  // is still traced), but the user should know.
  if (receipt?.status === '0x0') {
    ctx?.log(
      '⚠ setUp() reverted (status 0x0): the test fixture is only partially ' +
        'initialized, so the debugged method may revert early or read zeroed ' +
        'state. This often means the node does not support a cheatcode or ' +
        'deployment the setUp relies on.'
    );
  }
}
