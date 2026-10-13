import {describe, expect, it, vi} from 'vitest';
import {JsonRpcClient, JsonRpcError, type FetchLike} from '../src/jsonRpcClient.js';

function fakeFetch(bodies: string[]): FetchLike {
  let i = 0;
  return vi.fn(async () => new Response(bodies[i++], {status: 200})) as FetchLike;
}

describe('JsonRpcClient', () => {
  it('returns results with bigint fields preserved', async () => {
    const client = new JsonRpcClient({
      url: 'http://node',
      fetch: fakeFetch([
        '{"jsonrpc":"2.0","id":0,"result":{"codeAddress":546584486846459126461364135121053344201067465379}}',
      ]),
    });
    const result = await client.call<{codeAddress: bigint}>('debug_traceTransaction');
    expect(result.codeAddress).toBe(
      546584486846459126461364135121053344201067465379n,
    );
  });

  it('throws JsonRpcError on an error response', async () => {
    const client = new JsonRpcClient({
      url: 'http://node',
      fetch: fakeFetch([
        '{"jsonrpc":"2.0","id":0,"error":{"code":-32601,"message":"Method not found"}}',
      ]),
    });
    const err = await client.call('nope').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JsonRpcError);
    expect(err).toMatchObject({code: -32601, message: 'Method not found'});
  });

  it('increments request ids across calls', async () => {
    const fetchImpl = fakeFetch([
      '{"jsonrpc":"2.0","id":0,"result":"0x1"}',
      '{"jsonrpc":"2.0","id":1,"result":"0x2"}',
    ]);
    const client = new JsonRpcClient({url: 'http://node', fetch: fetchImpl});
    await client.call('eth_chainId');
    await client.call('eth_chainId');
    const secondBody = JSON.parse(
      (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[1][1].body as string,
    );
    expect(secondBody.id).toBe(1);
  });
});
