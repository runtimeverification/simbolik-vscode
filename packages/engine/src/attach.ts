/**
 * Attach fetch flow — obtain everything the debugger needs to replay a
 * transaction from a generic Ethereum node.
 *
 * `fetchAttachContext` issues the two JSON-RPC calls a remote replay requires:
 * `eth_getTransactionByHash` (for the per-step context geth traces omit) and
 * `debug_traceTransaction` (for the trace envelope), then classifies the
 * envelope's dialect. The result feeds straight into the debugger's launch.
 */
import {detectTraceDialect, type GethTraceContext} from '@simbolik/lifting';

import type {JsonRpcClient} from './jsonRpcClient.js';

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
}

/**
 * Fetch a transaction's context + trace from a node and classify the dialect.
 * Issues BOTH `eth_getTransactionByHash` and `debug_traceTransaction`, keyed off
 * the same `txHash`.
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
  const envelope = await client.call<unknown>('debug_traceTransaction', [
    txHash,
    {},
  ]);
  const dialect = detectTraceDialect(envelope);
  const txContext: GethTraceContext = {
    to: tx.to,
    from: tx.from,
    input: tx.input,
    value: tx.value,
  };
  return {dialect, envelope, txContext};
}
