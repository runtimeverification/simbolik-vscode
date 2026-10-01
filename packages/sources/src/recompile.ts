/**
 * Recompile a {@link ResolvedContract} to a solc standard-json build-info.
 *
 * Given a verified contract (from Sourcify or a local repository), compile its
 * `standardJsonInput` with solc-js at the contract's exact compiler version and
 * emit a build-info object that `@simbolik/solc.loadBuildInfo` consumes — so a
 * remote contract's trace can be lifted.
 *
 * `solc` is a multi-MB emscripten blob, so it is lazily `import()`-ed only when
 * recompiling (keeps the extension bundle lean).
 */

import type {ResolvedContract, StandardJsonInput} from './sourcify.js';

/** The minimal solc-js surface {@link recompile} drives. */
export interface SolcCompiler {
  version(): string;
  compile(input: string): string;
}

/** The bundled solc module (adds the remote-version loader). */
interface SolcModule extends SolcCompiler {
  loadRemoteVersion(
    versionString: string,
    callback: (err: Error | null, compiler?: SolcCompiler) => void,
  ): void;
}

/** A single solc diagnostic entry (the subset we read). */
interface SolcError {
  severity?: string;
  formattedMessage?: string;
  message?: string;
}

/** The subset of the solc standard-json output we read. */
interface SolcOutput {
  errors?: SolcError[];
  sources?: Record<string, {id?: number; ast?: unknown}>;
  contracts?: Record<string, Record<string, unknown>>;
}

/**
 * A solc standard-json build-info, in the `ethers-rs` shape that
 * `@simbolik/solc.loadBuildInfo` consumes.
 */
export interface BuildInfoObject {
  /** Short compiler version, e.g. `0.8.36`. */
  solcVersion: string;
  /** Full compiler version, e.g. `0.8.36+commit.8a079791.Emscripten.clang`. */
  solcLongVersion: string;
  /** Build-info format tag (parity with ethers-rs / foundry). */
  _format: string;
  /** The exact standard-json input fed to solc (with `outputSelection` added). */
  input: StandardJsonInput & {settings: Record<string, unknown>};
  /** The relevant slices of the solc standard-json output. */
  output: {
    sources: Record<string, {id?: number; ast?: unknown}>;
    contracts: Record<string, Record<string, unknown>>;
  };
  /** `{String(source.id): path}` map (parity field, loader-ignored). */
  source_id_to_path: Record<string, string>;
  /** A stable identifier for this build-info (parity field). */
  id: string;
}

/** Options for {@link recompile}. */
export interface RecompileOptions {
  /**
   * Injectable compiler loader — lets tests pass a stub compiler (avoids the
   * network and makes the bundled path deterministic). Receives the contract's
   * compiler version. Defaults to the bundled/remote logic in
   * {@link defaultLoadCompiler}.
   */
  loadCompiler?: (version: string) => Promise<SolcCompiler>;
}

/**
 * The `outputSelection` that yields everything `loadBuildInfo` needs: the AST
 * per file, plus ABI, storage layout and (creation + runtime) bytecode with
 * source maps per contract.
 */
const OUTPUT_SELECTION = {
  '*': {
    '': ['ast'],
    '*': [
      'abi',
      'storageLayout',
      'evm.bytecode.object',
      'evm.bytecode.sourceMap',
      'evm.deployedBytecode.object',
      'evm.deployedBytecode.sourceMap',
    ],
  },
} as const;

/**
 * Default compiler loader: use the bundled solc when its short version matches
 * the contract's, otherwise fetch the exact version via `loadRemoteVersion`
 * (network). `solc` is imported lazily here so it only loads when recompiling.
 */
async function defaultLoadCompiler(
  compilerVersion: string,
): Promise<SolcCompiler> {
  const solc = (await import('solc')).default as SolcModule;

  if (compilerVersion.split('+')[0] === solc.version().split('+')[0]) {
    // The bundled compiler matches; no network needed.
    return solc;
  }

  // Non-bundled version — fetch it. `loadRemoteVersion` wants the full
  // `v<version>+commit.<hash>` string (a bare `v0.8.12` 404s).
  const versionString = 'v' + compilerVersion;
  return new Promise<SolcCompiler>((resolve, reject) => {
    solc.loadRemoteVersion(versionString, (err, compiler) => {
      if (err) {
        reject(err);
      } else if (!compiler) {
        reject(
          new Error(`solc.loadRemoteVersion(${versionString}) returned no compiler`),
        );
      } else {
        resolve(compiler);
      }
    });
  });
}

/**
 * Recompile a resolved contract's standard-json input at its exact compiler
 * version and return a build-info that `@simbolik/solc.loadBuildInfo` consumes.
 *
 * @throws if solc reports any error-severity diagnostic (a compilation failure
 *   is a real error, surfaced with solc's messages — never silent/undefined).
 */
export async function recompile(
  resolved: ResolvedContract,
  opts?: RecompileOptions,
): Promise<BuildInfoObject> {
  const loadCompiler = opts?.loadCompiler ?? defaultLoadCompiler;
  const compiler = await loadCompiler(resolved.compilerVersion);

  // Feed the standard-json verbatim (unchanged paths and settings keep the CBOR
  // trailer and source maps aligned); only add outputSelection.
  const input: StandardJsonInput & {settings: Record<string, unknown>} = {
    ...resolved.standardJsonInput,
    settings: {
      ...resolved.standardJsonInput.settings,
      outputSelection: OUTPUT_SELECTION,
    },
  };

  const out = JSON.parse(compiler.compile(JSON.stringify(input))) as SolcOutput;

  const errors = (out.errors ?? []).filter((e) => e.severity === 'error');
  if (errors.length > 0) {
    const messages = errors
      .map((e) => e.formattedMessage ?? e.message ?? 'unknown solc error')
      .join('\n');
    throw new Error(`solc compilation failed:\n${messages}`);
  }

  const outSources = out.sources ?? {};
  const source_id_to_path: Record<string, string> = {};
  for (const [path, source] of Object.entries(outSources)) {
    if (source.id !== undefined) {
      source_id_to_path[String(source.id)] = path;
    }
  }

  const longVersion = compiler.version();
  return {
    solcVersion: longVersion.split('+')[0]!,
    solcLongVersion: longVersion,
    _format: 'ethers-rs-sol-build-info-1',
    input,
    output: {
      sources: outSources,
      contracts: out.contracts ?? {},
    },
    source_id_to_path,
    id: `${resolved.name ?? 'contract'}@${longVersion}`,
  };
}
