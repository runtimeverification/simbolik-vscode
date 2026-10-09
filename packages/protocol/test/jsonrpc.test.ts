import {describe, expect, it} from 'vitest';
import {
  isJsonRpcFailure,
  JsonRpcErrorCode,
  type JsonRpcResponse,
} from '../src/jsonrpc.js';

describe('jsonrpc', () => {
  it('discriminates success from failure responses', () => {
    const ok: JsonRpcResponse<string> = {jsonrpc: '2.0', id: 1, result: '0x1'};
    const err: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: 1,
      error: {code: JsonRpcErrorCode.MethodNotFound, message: 'Method not found'},
    };
    expect(isJsonRpcFailure(ok)).toBe(false);
    expect(isJsonRpcFailure(err)).toBe(true);
  });

  it('exposes the error codes kontrol-node emits', () => {
    expect(JsonRpcErrorCode.MethodNotFound).toBe(-32601);
    expect(JsonRpcErrorCode.InternalError).toBe(-32603);
  });
});
