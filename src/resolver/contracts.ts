/**
 * Contract lookups the resolver needs beyond `@simbolik/solc`'s model: method
 * selectors from the raw build-info, and which contracts a trace executed.
 */
import type {LaunchInputs} from '@simbolik/debugger';
import {
  normalizeGethTrace,
  normalizeKontrolTrace,
  type GethTraceContext,
  type Step,
} from '@simbolik/lifting';
import {
  parseJsonLossless,
  type JsonRpcClient,
  type StateDump,
} from '@simbolik/engine';
import {
  identifyContractByRuntimeCode,
  loadBuildInfo,
  type CompilationUnit,
  type Contract,
} from '@simbolik/solc';

export type ContractsByAddress = NonNullable<
  LaunchInputs['contractsByAddress']
>;

/** A build-info JSON together with its parsed compilation unit. */
export interface LoadedBuildInfo {
  json: unknown;
  cu: CompilationUnit;
}

// ─── method identifiers ──────────────────────────────────────────────────────

/** The subset of a solc build-info we navigate for method selectors. */
interface RawBuildInfo {
  output?: {contracts?: RawContracts};
  contracts?: RawContracts;
}
type RawContracts = Record<
  string,
  Record<string, {evm?: {methodIdentifiers?: Record<string, string>}}>
>;

/**
 * A contract's `methodIdentifiers` table (signature → 4-byte selector hex), from
 * `output.contracts[sourcePath][contractName].evm.methodIdentifiers`, so
 * selectors are byte-identical to solc's own — no local keccak needed.
 * Recompiled build-infos omit it.
 */
function methodIdentifiers(
  buildInfo: unknown,
  sourcePath: string,
  contractName: string
): Record<string, string> | undefined {
  const raw = buildInfo as RawBuildInfo;
  const contracts = raw.output?.contracts ?? raw.contracts;
  return contracts?.[sourcePath]?.[contractName]?.evm?.methodIdentifiers;
}

/** A method's 4-byte selector (unprefixed hex), or `undefined` if not declared. */
export function methodSelector(
  buildInfo: unknown,
  contract: Contract,
  methodSignature: string
): string | undefined {
  return methodIdentifiers(buildInfo, contract.sourcePath, contract.name)?.[
    methodSignature
  ];
}

/** The bare name of a method signature: `transfer(address,uint256)` → `transfer`. */
export function methodNameOf(signature: string): string {
  return signature.slice(0, signature.indexOf('('));
}

/**
 * Best-effort human method name for a replayed tx: reverse-look the tx input's
 * 4-byte selector in the entry contract's `methodIdentifiers` table. Purely
 * informational (the frame name falls back to this); returns the selector hex
 * when the table is absent or has no match, and a generic tag when the tx
 * carries no selector (a plain value transfer).
 */
export function methodNameFromInput(
  buildInfo: unknown,
  contract: Contract,
  input: string | undefined
): string {
  const inputHex = (input ?? '').replace(/^0x/, '');
  if (inputHex.length < 8) return 'fallback';
  const selector = inputHex.slice(0, 8).toLowerCase();
  const ids = methodIdentifiers(buildInfo, contract.sourcePath, contract.name);
  for (const [signature, sel] of Object.entries(ids ?? {})) {
    if (sel.toLowerCase() === selector) return methodNameOf(signature);
  }
  return `0x${selector}`;
}

// ─── trace → executed contracts ──────────────────────────────────────────────

/** Parse a raw `debug_traceTransaction` response STRING to its trace envelope. */
export function parseTraceEnvelope(traceJson: string): unknown {
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
 * The distinct code addresses a trace executed (each frame's contract), as
 * lowercase 20-byte hex, in first-execution order.
 */
export function executedAddresses(
  envelope: unknown,
  dialect: 'kontrol' | 'geth',
  txContext: GethTraceContext
): string[] {
  const steps: Step[] =
    dialect === 'geth'
      ? normalizeGethTrace(envelope, txContext)
      : normalizeKontrolTrace(envelope as never);
  return [...new Set(steps.map(step => addressHex(step.codeAddress)))];
}

/**
 * Resolve each executed address to its contract in the LOCAL build-info(s), by
 * matching the address's runtime code (see `identifyContractByRuntimeCode`).
 * The session resolves callee frames through this map — a geth trace carries no
 * per-step code, so this is the only way to identify external calls. Runtime
 * code comes from `preState` (the one `anvil_dumpState` snapshot) when
 * available, else per-address `eth_getCode`. Best-effort: an address whose code
 * can't be fetched or matched is skipped (that frame just won't map to source).
 */
export async function identifyLocalContracts(
  client: JsonRpcClient,
  addresses: string[],
  buildInfos: LoadedBuildInfo[],
  preState: StateDump | undefined
): Promise<ContractsByAddress> {
  const result: ContractsByAddress = {};
  await Promise.all(
    addresses.map(async addr => {
      // Prefer the pre-state dump (no extra request); a contract CREATEd during
      // the traced call won't be in the pre-call dump, so fall back to
      // eth_getCode there.
      let code: string | undefined =
        preState?.accounts[addr.toLowerCase()]?.code;
      if (code === undefined || code.length <= 2) {
        try {
          code = await client.call<string>('eth_getCode', [addr, 'latest']);
        } catch {
          return; // Node without eth_getCode (skip) — non-fatal.
        }
      }
      if (typeof code !== 'string' || code.length <= 2) return; // EOA / empty.
      for (const {json, cu} of buildInfos) {
        const contract = identifyContractByRuntimeCode(
          cu,
          code as `0x${string}`
        );
        if (contract !== undefined) {
          result[addr] = {
            buildInfoJson: json,
            contractName: contract.name,
            sourcePath: contract.sourcePath,
          };
          return;
        }
      }
    })
  );
  return result;
}

/**
 * Find the contract named `contractName` and the build-info declaring it.
 * Contract names are NOT unique within a project (e.g. uniswap-v4 has both
 * `src/test/HooksTest.sol` and `test/libraries/Hooks.t.sol` declaring
 * `HooksTest`), so when several match, prefer the one declared in
 * `launchedFile`; the first match is only the fallback.
 */
export function findContract(
  buildInfos: LoadedBuildInfo[],
  contractName: string,
  launchedFile: string | undefined
): {contract: Contract; buildInfo: unknown} | undefined {
  let match: {contract: Contract; buildInfo: unknown} | undefined;
  for (const {json, cu} of buildInfos) {
    for (const contract of cu.contracts()) {
      if (contract.name !== contractName) continue;
      const inFile =
        launchedFile !== undefined &&
        launchedFile.endsWith('/' + contract.sourcePath);
      if (inFile) return {contract, buildInfo: json};
      match ??= {contract, buildInfo: json};
    }
  }
  return match;
}

/** Parse each build-info once, for the lookups above. */
export function loadBuildInfos(jsons: unknown[]): LoadedBuildInfo[] {
  return jsons.map(json => ({json, cu: loadBuildInfo(json)}));
}
