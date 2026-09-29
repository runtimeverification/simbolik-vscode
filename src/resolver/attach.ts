/**
 * The attach / remote-replay flow: replay an ALREADY-MINED tx from a generic
 * Ethereum node, resolving each frame's sources via Sourcify.
 *
 * Flow: `fetchAttachContext` (tx context + trace envelope + dialect) → the RAW
 * trace STRING (precision-safe, see {@link fetchRawTrace}) → reconstruct the
 * step model to enumerate the distinct executing code addresses → per address,
 * resolve verified sources on Sourcify + recompile to a build-info (concurrent,
 * per-address failures are NON-FATAL: an unverified frame simply won't map to
 * source) → assemble {@link LaunchInputs}. The ENTRY contract (`txContext.to`)
 * MUST be verified (else a clear throw).
 */
import type {LaunchInputs, ResolveContext} from '@simbolik/debugger';
import {fetchAttachContext} from '@simbolik/engine';
import {loadBuildInfo, type Contract} from '@simbolik/solc';
import {SourcifyRepository, recompile} from '@simbolik/sources';

import {
  executedAddresses,
  methodNameFromInput,
  type ContractsByAddress,
} from './contracts';
import type {LaunchArgs} from './launchArgs';
import {fetchRawTrace, loggingClient, toChainId} from './rpc';

/** Resolve DAP `attach` args into the inputs of a fresh debug session. */
export async function attachInputs(
  args: LaunchArgs,
  ctx?: ResolveContext
): Promise<LaunchInputs> {
  const {jsonRpcUrl, txHash} = args;
  if (!jsonRpcUrl) throw new Error('attach: missing jsonRpcUrl');
  if (!txHash) throw new Error('attach: missing txHash');

  ctx?.log(`Attaching to ${txHash} at ${jsonRpcUrl} …`);
  const client = loggingClient(jsonRpcUrl, ctx);

  const {dialect, envelope, txContext} = await fetchAttachContext(
    client,
    txHash
  );
  ctx?.log(`Backend: ${dialect} trace dialect`);
  // Re-fetch the trace unparsed rather than re-stringifying the parsed
  // envelope, so kontrol's decimal-bigint fields keep full precision.
  const traceJson = await fetchRawTrace(client, txHash);

  // An explicit arg wins; else the node's, robust to hex/decimal.
  const chainId = args.chainId ?? toChainId(await client.call('eth_chainId'));

  const contractsByAddress = await resolveViaSourcify(
    new SourcifyRepository(
      args.sourcifyUrl !== undefined ? {baseUrl: args.sourcifyUrl} : {}
    ),
    chainId,
    executedAddresses(envelope, dialect, txContext)
  );

  // The debugger launches from the entry contract (the tx's `to`), so an
  // unverified entry is a hard error.
  const entryAddr = txContext.to.toLowerCase();
  const entry = contractsByAddress[entryAddr];
  if (entry === undefined) {
    throw new Error(
      `attach: entry contract ${entryAddr} is not verified on Sourcify`
    );
  }
  const entryContract = pickEntryContract(
    entry.buildInfoJson,
    entry.contractName
  );
  if (entryContract === undefined) {
    throw new Error(
      `attach: entry build-info for ${entryAddr} declares no contracts`
    );
  }

  ctx?.log(
    `Resolved ${Object.keys(contractsByAddress).length} contract(s) via Sourcify.`
  );
  return {
    buildInfos: Object.values(contractsByAddress).map(c => c.buildInfoJson),
    traceJson,
    sourcePath: entryContract.sourcePath,
    contractName: entryContract.name,
    methodName: methodNameFromInput(
      entry.buildInfoJson,
      entryContract,
      txContext.input
    ),
    codeAddress: entryAddr,
    dialect,
    // Only geth traces need the per-step tx context supplied explicitly.
    ...(dialect === 'geth' ? {txContext} : {}),
    contractsByAddress,
  };
}

/**
 * Per address: resolve verified sources on Sourcify and recompile them to a
 * build-info. Concurrent; an unverified / failing address is skipped (that
 * frame just won't map to source).
 */
async function resolveViaSourcify(
  repo: SourcifyRepository,
  chainId: number,
  addresses: string[]
): Promise<ContractsByAddress> {
  const result: ContractsByAddress = {};
  await Promise.all(
    addresses.map(async addr => {
      try {
        const resolved = await repo.resolve(chainId, addr);
        if (resolved === undefined) return; // unverified — skip, non-fatal.
        const buildInfoJson = await recompile(resolved);
        result[addr] = {buildInfoJson, contractName: resolved.name};
      } catch {
        // A per-address Sourcify/recompile failure is non-fatal: skip it.
      }
    })
  );
  return result;
}

/** Prefer the resolved name; else the sole deployable contract; else the first. */
function pickEntryContract(
  buildInfoJson: unknown,
  contractName: string | undefined
): Contract | undefined {
  const contracts = loadBuildInfo(buildInfoJson).contracts();
  return (
    (contractName !== undefined
      ? contracts.find(c => c.name === contractName)
      : undefined) ??
    contracts.find(c => c.runtimeBytecode().length > 2) ??
    contracts[0]
  );
}
