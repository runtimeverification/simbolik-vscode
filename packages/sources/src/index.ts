/**
 * `@simbolik/sources` — source repositories for remote-replay mode.
 *
 * Fetches verified contract sources + compiler settings (Sourcify, local build
 * artifacts) and recompiles them to a solc standard-json build-info that
 * `@simbolik/solc` can consume. This lets the debugger lift a remote contract's
 * trace when no local build-info is available.
 */
export type {
  ResolvedContract,
  SourceRepository,
  SourcifyRepositoryOptions,
  StandardJsonInput,
} from './sourcify.js';
export {SourcifyRepository} from './sourcify.js';
export type {
  BuildInfoObject,
  RecompileOptions,
  SolcCompiler,
} from './recompile.js';
export {recompile} from './recompile.js';
