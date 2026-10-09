/**
 * @simbolik/lifting — lift a raw kontrol-node execution trace into a step model
 * with random-access machine state.
 *
 * `normalizeKontrolTrace` produces the positional `Step[]`; `StateCursor`
 * reconstructs full EVM state (memory, blobs, accounts) at any step index by
 * accumulating the trace's delta-encoded fields. This is the foundation the
 * stepping engine and variable lifting build on.
 */
export {normalizeKontrolTrace, type Step} from './step.js';
export {
  detectTraceDialect,
  normalizeGethTrace,
  type GethTraceContext,
} from './gethTrace.js';
export {
  StateCursor,
  type AccountState,
  type MachineState,
} from './stateCursor.js';
