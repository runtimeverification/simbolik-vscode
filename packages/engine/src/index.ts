/**
 * @simbolik/engine — drive the kontrol-node execution engine.
 *
 * Responsibilities: spawn/own the kontrol-node process, speak Ethereum
 * JSON-RPC to it, and fetch execution traces losslessly. Trace *normalisation*
 * into the debugger's step model lives in @simbolik/lifting.
 */
export {parseJsonLossless} from './lossless.js';
export {
  JsonRpcClient,
  JsonRpcError,
  describeCause,
  type FetchLike,
  type JsonRpcClientOptions,
} from './jsonRpcClient.js';
export {
  KontrolNode,
  // `KontrolNode` manages ANY launch spec (it just spawns + polls eth_chainId),
  // so it drives anvil too; `ManagedNode` is the dialect-neutral alias.
  KontrolNode as ManagedNode,
  kontrolNodeLaunch,
  devcontainerLaunch,
  anvilLaunch,
  type KontrolNodeLaunch,
  type KontrolNodeLaunch as NodeLaunch,
  type KontrolNodeOptions,
} from './kontrolNode.js';
export {
  locateExecutable,
  nixProfileBinDirs,
  probeKontrolNode,
  tailLines,
  type Located,
  type LocateOptions,
  type Probe,
} from './locate.js';
export {fetchAttachContext, type AttachContext} from './attach.js';
export {
  parseStateDump,
  type StateDump,
  type DumpedAccount,
} from './stateDump.js';
