/**
 * @simbolik/protocol — shared wire types for the Simbolik TypeScript debug server.
 *
 * This package holds pure type declarations (and small const tables) that are
 * shared across the engine, lifting, sources, and debugger packages: Ethereum
 * JSON-RPC requests/responses and the two execution-trace dialects
 * (kontrol-node and anvil).
 */

/** Execution-engine node dialects we support. */
export type RpcNodeType = 'anvil' | 'kontrol-node';

/** The supported node dialects. */
export const SUPPORTED_RPC_NODE_TYPES: readonly RpcNodeType[] = [
  'anvil',
  'kontrol-node',
] as const;

export * from './jsonrpc.js';
export * from './trace.js';
