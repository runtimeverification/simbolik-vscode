/**
 * Attach fetch flow — obtain everything the debugger needs to replay a
 * transaction from a generic Ethereum node.
 *
 * `fetchAttachContext` issues the two JSON-RPC calls a remote replay requires:
 * `eth_getTransactionByHash` (for the per-step context geth traces omit) and a
 * trace call (for the trace envelope), then classifies the envelope's dialect.
 * The result feeds straight into the debugger's launch.
 */
import {detectTraceDialect, type GethTraceContext} from '@simbolik/lifting';

import {JsonRpcError, type JsonRpcClient} from './jsonRpcClient.js';
import {TRACE_METHODS} from './rpcMethods.js';

/** JSON-RPC "Method not found". */
const METHOD_NOT_FOUND = -32601;

/** The tx shape we read out of `eth_getTransactionByHash`. */
interface TransactionResult {
  to: string;
  from: string;
  input: string;
  value?: string;
}

/** Everything the debugger launch needs to replay a remote transaction. */
export interface AttachContext {
  dialect: 'kontrol' | 'geth';
  envelope: unknown;
  txContext: GethTraceContext;
  /** The trace method the node answered, for re-fetching the raw trace. */
  traceMethod: string;
}

/**
 * Fetch a transaction's context + trace from a node and classify the dialect.
 * Issues BOTH `eth_getTransactionByHash` and a trace call, keyed off the same
 * `txHash`. The node type is unknown, so the trace methods of
 * {@link TRACE_METHODS} are tried in order until one is not "Method not found"
 * (`debug_traceTransaction` on anvil/geth, `kontrol_traceTransaction` on
 * kontrol-node).
 */
export async function fetchAttachContext(
  client: JsonRpcClient,
  txHash: string,
): Promise<AttachContext> {
  const tx = await client.call<TransactionResult | null>(
    'eth_getTransactionByHash',
    [txHash],
  );
  // A node returns `null` for an unknown tx hash; surface that as a clear error
  // rather than a downstream "cannot read properties of null" on `tx.to`.
  if (tx === null || tx === undefined) {
    throw new Error(`fetchAttachContext: transaction not found: ${txHash}`);
  }
  const {envelope, traceMethod} = await traceWithAnyMethod(client, txHash);
  const dialect = detectTraceDialect(envelope);
  const txContext: GethTraceContext = {
    to: tx.to,
    from: tx.from,
    input: tx.input,
    value: tx.value,
  };
  return {dialect, envelope, txContext, traceMethod};
}

async function traceWithAnyMethod(
  client: JsonRpcClient,
  txHash: string,
): Promise<{envelope: unknown; traceMethod: string}> {
  let lastErr: unknown;
  for (const traceMethod of TRACE_METHODS) {
    try {
      const envelope = await client.call<unknown>(traceMethod, [txHash, {}]);
      return {envelope, traceMethod};
    } catch (err) {
      if (!(err instanceof JsonRpcError) || err.code !== METHOD_NOT_FOUND) {
        throw err;
      }
      lastErr = err;
    }
  }
  throw new Error(
    `fetchAttachContext: the node supports none of ${TRACE_METHODS.join(', ')}`,
    {cause: lastErr},
  );
}
