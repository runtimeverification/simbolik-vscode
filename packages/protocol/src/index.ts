/**
 * @simbolik/protocol — shared wire types for the Simbolik TypeScript debug server.
 *
 * This package holds pure type declarations (and small const tables) that are
 * shared across the engine, lifting, sources, and debugger packages: the DAP
 * message shapes, Ethereum JSON-RPC requests/responses, solc standard-json
 * artifacts, and the two execution-trace dialects (kontrol-node and anvil).
 */

/** Execution-engine node dialects we support. See plan §"Remote replay trace". */
export type RpcNodeType = 'anvil' | 'kontrol-node';

/** The node dialects supported from the first release. */
export const SUPPORTED_RPC_NODE_TYPES: readonly RpcNodeType[] = [
  'anvil',
  'kontrol-node',
] as const;

export * from './jsonrpc.js';
export * from './trace.js';
