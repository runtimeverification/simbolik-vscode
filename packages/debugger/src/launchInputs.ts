/** The inputs a debug session is launched with. */
import type {GethTraceContext} from '@simbolik/lifting';
import type {Hex} from '@simbolik/protocol';

/** Inputs to launch a session against a recorded transaction. */
export interface LaunchInputs {
  /** solc standard-json build-info (single-CU back-compat). Optional. */
  buildInfoJson?: unknown;
  /** Order-independent array of standard-json build-infos. */
  buildInfos?: unknown[];
  /** The raw trace JSON-RPC response STRING (has `.result`). */
  traceJson: unknown;
  /** Source path within the build-info, e.g. `'src/Counter.sol'`. */
  sourcePath: string;
  /**
   * Absolute directory the build-info's RELATIVE source paths resolve against
   * (the project root, for a LOCAL launch). When set and a source file exists on
   * disk, frames reference the real file (VSCode opens the editable document and
   * gutter breakpoints work); otherwise frames fall back to a `sourceReference`
   * whose content is served via the `source` request (remote replay). Omit for
   * recompiled/remote sources that are not on the client's disk.
   */
  sourceRoot?: string;
  /** Contract name, e.g. `'Counter'`. */
  contractName: string;
  /** The invoked method name, e.g. `'setNumber'`. */
  methodName: string;
  /** The entry-frame contract address (hex), e.g. `'0x5fbd…aa3'`. */
  codeAddress: string;
  /** Trace dialect; defaults to `'kontrol'`. `'geth'` requires {@link txContext}. */
  dialect?: 'kontrol' | 'geth';
  /** The transaction context a geth trace lacks per-step (required for geth). */
  txContext?: GethTraceContext;
  /**
   * An explicit address→build-info map, keyed by LOWERCASE `0x` address.
   * Resolves each frame's CU BY ADDRESS, taking PRECEDENCE over the CBOR-from-trace
   * registry (the only workable path for geth, whose trace carries no per-step
   * code). Optional — omitting it preserves all existing behavior.
   */
  contractsByAddress?: Record<
    string,
    {
      buildInfoJson: unknown;
      contractName?: string;
      /**
       * The declaring source path. Contract names are NOT unique within a build
       * (forge-std and solmate both declare `MockERC20`), so a name alone can
       * select the wrong contract; with the path the pick is exact.
       */
      sourcePath?: string;
    }
  >;
  /**
   * PRE-TRACE storage to seed the cursor with, keyed `address(hex) → slot(hex) →
   * word(hex)` (minimal-hex slot keys, as the node emits and the lookup expects).
   * A delta-encoded trace omits slots that an EARLIER tx wrote and this one only
   * reads (SLOAD emits no delta), so fixture state established by `setUp()` would
   * otherwise read as zero. The resolver populates this from `eth_getStorageAt`
   * at the pre-trace block for each known contract's static layout slots.
   */
  initialStorage?: Record<string, Record<string, Hex>>;
}
