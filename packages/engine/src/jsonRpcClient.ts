import {
  isJsonRpcFailure,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from '@simbolik/protocol';
import {parseJsonLossless} from './lossless.js';

/** Thrown when a JSON-RPC call returns an `error` object. */
export class JsonRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'JsonRpcError';
  }
}

/** A `fetch`-compatible function; injectable so the client is testable offline. */
export type FetchLike = typeof fetch;

/**
 * Flatten an error (and its `cause` chain, where undici stashes the real network
 * reason such as `ECONNREFUSED` / `ENOTFOUND`) into a single readable string.
 */
export function describeCause(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  const seen = new Set<unknown>();
  while (cur !== undefined && cur !== null && !seen.has(cur)) {
    seen.add(cur);
    if (cur instanceof Error) {
      const code = (cur as {code?: unknown}).code;
      parts.push(code !== undefined ? `${cur.message} (${String(code)})` : cur.message);
      cur = (cur as {cause?: unknown}).cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  return parts.join(': ');
}

export interface JsonRpcClientOptions {
  url: string;
  fetch?: FetchLike;
  /**
   * Optional observer invoked just before each request is sent. Purely for
   * diagnostics (e.g. surfacing traffic in the debug console); it must not throw
   * and cannot alter the request.
   */
  onRequest?: (method: string, params: unknown[]) => void;
}

/**
 * Minimal Ethereum JSON-RPC client over HTTP. Responses are parsed losslessly
 * so `bigint` fields (addresses, 256-bit values) survive intact.
 */
export class JsonRpcClient {
  readonly #url: string;
  readonly #fetch: FetchLike;
  readonly #onRequest?: (method: string, params: unknown[]) => void;
  #nextId = 0;

  constructor(opts: JsonRpcClientOptions) {
    this.#url = opts.url;
    this.#fetch = opts.fetch ?? fetch;
    this.#onRequest = opts.onRequest;
  }

  async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
    this.#onRequest?.(method, params);
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id: this.#nextId++,
      method,
      params,
    };
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.#fetch(this.#url, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body: JSON.stringify(request),
      });
    } catch (err) {
      // A transport-level failure (node down, wrong URL, DNS, TLS) throws a bare
      // `TypeError: fetch failed` whose actionable reason hides in `.cause`.
      // Surface the URL + method + flattened cause so it is diagnosable.
      throw new Error(
        `JSON-RPC ${method}: cannot reach ${this.#url} — ${describeCause(err)}`,
        {cause: err},
      );
    }
    if (!res.ok) {
      throw new Error(`JSON-RPC ${method}: HTTP ${res.status} ${res.statusText}`);
    }
    const parsed = parseJsonLossless(await res.text()) as JsonRpcResponse<T>;
    if (isJsonRpcFailure(parsed)) {
      throw new JsonRpcError(
        parsed.error.code,
        parsed.error.message,
        parsed.error.data,
      );
    }
    return parsed.result;
  }
}
