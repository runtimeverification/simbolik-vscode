/**
 * Minimal Ethereum JSON-RPC 2.0 wire types.
 *
 * kontrol-node speaks JSON-RPC 2.0 over HTTP (single + batch). See the
 * kontrol-node reference `src/kontrol_node/rpc.py` / `kdist/node.md`.
 */

export type JsonRpcId = number | string | null;

export interface JsonRpcRequest<TParams = unknown[]> {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params: TParams;
}

export interface JsonRpcSuccess<TResult = unknown> {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: TResult;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: JsonRpcErrorObject;
}

export type JsonRpcResponse<TResult = unknown> =
  | JsonRpcSuccess<TResult>
  | JsonRpcFailure;

/** Standard JSON-RPC error codes, plus the ones kontrol-node emits. */
export const JsonRpcErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

export function isJsonRpcFailure(
  res: JsonRpcResponse,
): res is JsonRpcFailure {
  return 'error' in res;
}
