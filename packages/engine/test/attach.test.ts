/**
 * Attach fetch flow.
 *
 * `fetchAttachContext(client, txHash)`:
 *   1. `eth_getTransactionByHash(txHash)` → {to, from, input, value},
 *   2. `debug_traceTransaction(txHash, {})` → the trace envelope (falling back
 *      to `kontrol_traceTransaction` on "Method not found"),
 *   3. classify the envelope's dialect,
 * returning `{dialect, envelope, txContext, traceMethod}`.
 *
 * The client is driven with an injectable `fetch` that dispatches on the
 * JSON-RPC `method` in the POST body: the recorded anvil trace text for
 * `debug_traceTransaction`, and a synthesized (but valid) tx result for
 * `eth_getTransactionByHash` — there is no recorded raw tx JSON, so we build one
 * from the meta fixture.
 */
import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {JsonRpcClient, type FetchLike} from '../src/jsonRpcClient.js';
import {fetchAttachContext} from '../src/index.js';

// ## Fixtures

/** Recorded anvil `debug_traceTransaction` response text (envelope at `.result`). */
const ANVIL_TRACE_RAW = readFileSync(
  new URL(
    '../../debugger/test/fixtures/anvil-setNumber-trace.raw.json',
    import.meta.url,
  ),
  'utf8',
);

const META = JSON.parse(
  readFileSync(
    new URL(
      '../../debugger/test/fixtures/anvil-setNumber-meta.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  contractAddress: string;
  txFrom: string;
  txTo: string;
  txInput: string;
  callTxHash: string;
};

/**
 * Synthesized `eth_getTransactionByHash` result. No raw tx JSON was recorded, so
 * we construct a valid minimal one from the meta: {to, from, input, value, …}.
 */
const TX_RESULT = {
  hash: META.callTxHash,
  to: META.txTo,
  from: META.txFrom,
  input: META.txInput,
  value: '0x0',
  nonce: '0x0',
  gas: '0x30d40',
};

const TX_RESPONSE = JSON.stringify({jsonrpc: '2.0', id: 0, result: TX_RESULT});

/**
 * `fetch` that dispatches by the request `method` in the POST body: the tx
 * result for `eth_getTransactionByHash`, the raw trace text for `traceMethod`
 * (anvil's `debug_traceTransaction` by default). Any other method is a JSON-RPC
 * "Method not found". Every method seen is recorded in `calls` (with the params)
 * so a test can assert that both RPCs were actually issued — not that the result
 * was fabricated from one call.
 */
function fakeFetch(
  calls: {method: string; params: unknown[]}[],
  traceMethod = 'debug_traceTransaction',
): FetchLike {
  return (async (_url: string, init?: {body?: string}) => {
    const {method, params} = JSON.parse(init?.body ?? '{}') as {
      method: string;
      params: unknown[];
    };
    calls.push({method, params});
    if (method === 'eth_getTransactionByHash') {
      return new Response(TX_RESPONSE, {status: 200});
    }
    if (method === traceMethod) {
      return new Response(ANVIL_TRACE_RAW, {status: 200});
    }
    return new Response(
      '{"jsonrpc":"2.0","id":0,"error":{"code":-32601,"message":"Method not found"}}',
      {status: 200},
    );
  }) as unknown as FetchLike;
}

// ## fetchAttachContext

describe('fetchAttachContext', () => {
  it('fetches the tx + trace and returns {dialect, envelope, txContext}', async () => {
    const calls: {method: string; params: unknown[]}[] = [];
    const client = new JsonRpcClient({
      url: 'http://node',
      fetch: fakeFetch(calls),
    });

    const {dialect, envelope, txContext, traceMethod} =
      await fetchAttachContext(client, META.callTxHash);

    // It must issue both JSON-RPC calls: the tx lookup (for the context) and
    // the trace fetch (for the envelope).
    const methods = calls.map((c) => c.method);
    expect(methods).toContain('eth_getTransactionByHash');
    expect(methods).toContain('debug_traceTransaction');
    // Both are keyed off the same tx hash the caller passed in.
    const txCall = calls.find((c) => c.method === 'eth_getTransactionByHash');
    const traceCall = calls.find((c) => c.method === 'debug_traceTransaction');
    expect(txCall!.params[0]).toBe(META.callTxHash);
    expect(traceCall!.params[0]).toBe(META.callTxHash);
    // anvil answers the standard method, so kontrol's is never tried.
    expect(traceMethod).toBe('debug_traceTransaction');
    expect(methods).not.toContain('kontrol_traceTransaction');

    // The recorded anvil trace is the geth dialect, 118 structLogs.
    expect(dialect).toBe('geth');
    expect((envelope as {structLogs: unknown[]}).structLogs).toHaveLength(118);

    // The tx context is lifted straight from eth_getTransactionByHash.
    expect(txContext.to).toBe(META.contractAddress);
    expect(txContext.to).toBe(META.txTo);
    expect(txContext.from).toBe(META.txFrom);
    expect(txContext.input).toBe(META.txInput);
  });

  it('falls back to kontrol_traceTransaction on a kontrol-node', async () => {
    const calls: {method: string; params: unknown[]}[] = [];
    const client = new JsonRpcClient({
      url: 'http://node',
      fetch: fakeFetch(calls, 'kontrol_traceTransaction'),
    });

    const {envelope, traceMethod} = await fetchAttachContext(
      client,
      META.callTxHash,
    );

    expect(traceMethod).toBe('kontrol_traceTransaction');
    expect(calls.map((c) => c.method)).toEqual([
      'eth_getTransactionByHash',
      'debug_traceTransaction',
      'kontrol_traceTransaction',
    ]);
    expect((envelope as {structLogs: unknown[]}).structLogs).toHaveLength(118);
  });

  it('fails clearly when the node supports no trace method', async () => {
    const client = new JsonRpcClient({
      url: 'http://node',
      fetch: fakeFetch([], 'none'),
    });

    await expect(fetchAttachContext(client, META.callTxHash)).rejects.toThrow(
      /supports none of debug_traceTransaction, kontrol_traceTransaction/,
    );
  });

  it('throws a clear error when the tx hash is unknown (node returns null)', async () => {
    // A node returns `{result: null}` for an unknown tx hash. Without a guard
    // that surfaces as an opaque "cannot read properties of null" on `tx.to`.
    const nullTxFetch = (async () =>
      new Response(
        JSON.stringify({jsonrpc: '2.0', id: 0, result: null}),
        {status: 200},
      )) as unknown as FetchLike;
    const client = new JsonRpcClient({url: 'http://node', fetch: nullTxFetch});

    await expect(fetchAttachContext(client, '0xdead')).rejects.toThrow(
      /transaction not found/,
    );
  });
});
