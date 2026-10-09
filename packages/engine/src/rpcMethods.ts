/**
 * The non-standard JSON-RPC methods the debugger needs, per node type.
 *
 * Tracing, state dumps and balance overrides are not part of the Ethereum
 * JSON-RPC standard, so each node names them differently: anvil follows geth
 * (`debug_traceTransaction`) and its own `anvil_*` namespace, while kontrol-node
 * puts all three under `kontrol_*`.
 */
import type {RpcNodeType} from '@simbolik/protocol';

export interface NodeRpcMethods {
  /** `(txHash, options)` → the tx's step trace. */
  traceTransaction: string;
  /** `()` → the whole-chain state (see `parseStateDump`). */
  dumpState: string;
  /** `(address, balance)` → overwrite an account's balance. */
  setBalance: string;
}

export const NODE_RPC_METHODS: Readonly<Record<RpcNodeType, NodeRpcMethods>> = {
  anvil: {
    traceTransaction: 'debug_traceTransaction',
    dumpState: 'anvil_dumpState',
    setBalance: 'anvil_setBalance',
  },
  'kontrol-node': {
    traceTransaction: 'kontrol_traceTransaction',
    dumpState: 'kontrol_dumpState',
    setBalance: 'kontrol_setBalance',
  },
};

/**
 * The trace methods to try, in order, against a node of unknown type (attach to
 * a remote node): the geth-standard name every Ethereum client uses first, then
 * kontrol-node's.
 */
export const TRACE_METHODS: readonly string[] = [
  NODE_RPC_METHODS.anvil.traceTransaction,
  NODE_RPC_METHODS['kontrol-node'].traceTransaction,
];
