import type {ResolveContext} from '@simbolik/debugger';
import {JsonRpcClient} from '@simbolik/engine';

/** A JSON-RPC client that streams every request to the debug console. */
export function loggingClient(
  url: string,
  ctx?: ResolveContext
): JsonRpcClient {
  return new JsonRpcClient({
    url,
    onRequest: (method, params) =>
      ctx?.log(`  → ${method}${summarizeRpcParams(method, params)}`),
  });
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

/**
 * Fetch a `debug_traceTransaction` response as the RAW JSON-RPC body STRING —
 * what `LaunchInputs.traceJson` wants. The session re-parses it losslessly;
 * re-stringifying a parsed envelope instead would round-trip kontrol's decimal
 * bigints through `number`.
 */
export function fetchRawTrace(
  client: JsonRpcClient,
  txHash: string
): Promise<string> {
  return client.callRaw('debug_traceTransaction', [txHash, {}]);
}

/** A transaction receipt, as far as the resolver cares about it. */
export interface TxReceipt {
  contractAddress?: string;
  status?: string;
  /** Hex block number the tx was mined in (used to derive the pre-trace block). */
  blockNumber?: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

/**
 * Poll `eth_getTransactionReceipt` until the tx is mined (or the timeout / an
 * unsupported-method error ends the wait). Essential before tracing: a call to
 * `debug_traceTransaction` on an unmined tx yields an EMPTY trace. Returns the
 * receipt, or `undefined` if none appeared (the caller proceeds best-effort —
 * e.g. a node without receipt support).
 */
export async function waitForReceipt(
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
 * Coerce an `eth_chainId` result to a number, robust to a hex string (`'0x7a69'`,
 * geth/public), a decimal string (`'31337'`, kontrol) or a numeric/bigint value
 * (the lossless JSON-RPC client can yield a `bigint`). `BigInt(str)` handles both
 * hex and decimal string forms.
 */
export function toChainId(raw: unknown): number {
  if (typeof raw === 'bigint') return Number(raw);
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string' && raw.length > 0) return Number(BigInt(raw));
  throw new Error(
    `attach: unexpected eth_chainId result: ${JSON.stringify(raw)}`
  );
}
