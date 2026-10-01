import {createRequire} from 'node:module';

import {keccak256} from 'ethereum-cryptography/keccak';
import {bytesToHex, utf8ToBytes} from 'ethereum-cryptography/utils';
import {describe, expect, it, vi} from 'vitest';

import {loadBuildInfo} from '@simbolik/solc';

/**
 * Tests for `recompile`.
 *
 * As in `sourcify.test.ts`, the public entry point is imported with a loose
 * dynamic-import cast plus a `toBeDefined` guard, so a missing export surfaces
 * as an assertion failure rather than a compile error.
 *
 * These tests are hermetic: they compile a tiny inline contract at the bundled
 * solc version (`solc.version()`), so no `loadRemoteVersion` / network is used.
 * The single live round-trip (Multicall3 @ 0.8.12) is gated behind
 * `SIMBOLIK_LIVE` and skipped by default.
 */

const require = createRequire(import.meta.url);

/** The bundled solc, loaded synchronously via `require`. */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const solc = require('solc') as {version: () => string; compile: (input: string) => string};

/** Full bundled version string, e.g. `0.8.36+commit.8a079791.Emscripten.clang`. */
const BUNDLED_FULL = solc.version();
/** Short bundled version, e.g. `0.8.36`. */
const BUNDLED_SHORT = BUNDLED_FULL.split('+')[0]!;

/**
 * A small contract that exercises everything the debugger pipeline reads:
 * a storage variable (`value` @ slot 0), a struct (`P`), and an event (`E`).
 */
const SAMPLE =
  '// SPDX-License-Identifier: MIT\n' +
  'pragma solidity ^0.8.0;\n' +
  'contract Sample { uint256 public value; struct P { uint256 x; } event E(uint256 indexed a); function set(uint256 v) public { value = v; } }';

/** Topic-0 selector for `event E(uint256 indexed a)`. */
const E_SELECTOR = '0x' + bytesToHex(keccak256(utf8ToBytes('E(uint256)')));

// ## Loose structural shapes (kept deliberately permissive)

type StandardJsonInputLike = {
  language: string;
  sources: Record<string, {content: string}>;
  settings: Record<string, unknown>;
};

type ResolvedContractLike = {
  chainId: number;
  address: string;
  name?: string;
  match?: string;
  compilerVersion: string;
  standardJsonInput: StandardJsonInputLike;
};

type RawContractLike = {
  abi?: unknown[];
  storageLayout?: {
    storage?: {label?: string; slot?: string | number}[];
    types?: Record<string, unknown>;
  };
  evm?: {
    bytecode?: {object?: string; sourceMap?: string};
    deployedBytecode?: {object?: string; sourceMap?: string};
  };
};

type BuildInfoLike = {
  solcVersion: string;
  input: {
    sources: Record<string, {content?: string}>;
    settings: Record<string, unknown>;
  };
  output: {
    sources: Record<string, {id?: number; ast?: unknown}>;
    contracts: Record<string, Record<string, RawContractLike>>;
  };
};

/** Shape of the injectable compiler and loader. */
type SolcCompilerLike = {version: () => string; compile: (input: string) => string};
type RecompileOpts = {loadCompiler?: (version: string) => Promise<SolcCompilerLike>};
type RecompileFn = (
  resolved: ResolvedContractLike,
  opts?: RecompileOpts,
) => Promise<BuildInfoLike>;

/** Loose dynamic import — resolves to `undefined` if `recompile` is not exported. */
async function loadRecompile(): Promise<RecompileFn | undefined> {
  const mod = (await import('../src/index.js')) as unknown as {
    recompile?: RecompileFn;
  };
  return mod.recompile;
}

/** Build a hermetic `ResolvedContract` for the inline SAMPLE at a given version. */
function resolvedSample(
  source: string = SAMPLE,
  compilerVersion: string = BUNDLED_FULL,
): ResolvedContractLike {
  return {
    chainId: 1,
    address: '0x0000000000000000000000000000000000000001',
    name: 'Sample',
    match: 'exact_match',
    compilerVersion,
    standardJsonInput: {
      language: 'Solidity',
      sources: {'Sample.sol': {content: source}},
      settings: {optimizer: {enabled: false}},
    },
  };
}

describe('recompile', () => {
  it('is exported from the package entry point', async () => {
    const recompile = await loadRecompile();
    expect(recompile).toBeDefined();
    expect(typeof recompile).toBe('function');
  });

  describe('hermetic recompile at the bundled version (no network)', () => {
    it('produces a build-info with the shape loadBuildInfo requires', async () => {
      const recompile = await loadRecompile();
      expect(recompile).toBeDefined();

      const bi = await recompile!(resolvedSample());

      // solcVersion is the short bundled version.
      expect(bi.solcVersion).toBe(BUNDLED_SHORT);

      // input carries the source content through verbatim.
      const inputSource = bi.input.sources['Sample.sol'];
      expect(inputSource).toBeDefined();
      expect(inputSource!.content).toContain('contract Sample');

      // output.sources: numeric id + present AST.
      const outSource = bi.output.sources['Sample.sol'];
      expect(outSource).toBeDefined();
      expect(typeof outSource!.id).toBe('number');
      expect(outSource!.ast).toBeDefined();

      // output.contracts: the compiled artifact the debugger reads.
      const contract = bi.output.contracts['Sample.sol']?.Sample;
      expect(contract).toBeDefined();
      expect(contract!.abi).toBeDefined();

      const deployed = contract!.evm?.deployedBytecode;
      expect(deployed?.object).toBeTruthy();
      expect(deployed?.sourceMap).toBeTruthy();

      const labels = (contract!.storageLayout?.storage ?? []).map(
        (s) => s.label,
      );
      expect(labels).toContain('value');
    });
  });

  describe('round-trips through @simbolik/solc.loadBuildInfo', () => {
    it('drives the CompilationUnit accessors the debugger uses', async () => {
      const recompile = await loadRecompile();
      expect(recompile).toBeDefined();

      const bi = await recompile!(resolvedSample());
      const cu = loadBuildInfo(bi);

      const contract = cu.contract('Sample.sol', 'Sample');
      expect(contract).toBeDefined();

      // storageLayout: `value` at slot 0.
      const value = contract!
        .storageLayout()
        .find((s) => s.label === 'value');
      expect(value).toBeDefined();
      expect(value!.slot).toBe('0');

      // runtime source map is populated.
      expect(contract!.runtimeSourceMap().length).toBeGreaterThan(0);

      // events: `E` with its keccak topic-0 selector.
      const event = contract!.events().find((e) => e.name === 'E');
      expect(event).toBeDefined();
      expect(event!.selector).toBe(E_SELECTOR);

      // AST is navigable and rooted at a SourceUnit.
      const sourceFile = cu.sources().find((s) => s.path === 'Sample.sol');
      expect(sourceFile).toBeDefined();
      expect(sourceFile!.ast().nodeType).toBe('SourceUnit');
    });
  });

  describe('compilation failure', () => {
    it('rejects with the solc error (not undefined/silent)', async () => {
      const recompile = await loadRecompile();
      expect(recompile).toBeDefined();

      const broken = resolvedSample(
        '// SPDX-License-Identifier: MIT\n' +
          'pragma solidity ^0.8.0;\n' +
          'contract X { function',
      );
      await expect(recompile!(broken)).rejects.toThrow();
    });
  });

  describe('version selection (injectable loadCompiler)', () => {
    it('honours an injected loadCompiler and does not load remotely', async () => {
      const recompile = await loadRecompile();
      expect(recompile).toBeDefined();

      // The stub is the bundled compiler, so when `opts.loadCompiler` is used
      // there is no default bundled/remote decision and no network at all.
      const loadCompiler = vi.fn(async (_version: string) => solc);

      const bi = await recompile!(resolvedSample(), {loadCompiler});

      // The injected loader was invoked with the requested version.
      expect(loadCompiler).toHaveBeenCalled();
      const arg = String(loadCompiler.mock.calls[0]?.[0] ?? '');
      expect(arg).toContain(BUNDLED_SHORT);

      // And it drove a valid recompile through the injected compiler.
      expect(bi.solcVersion).toBe(BUNDLED_SHORT);
      expect(bi.output.contracts['Sample.sol']?.Sample).toBeDefined();
    });
  });

  // ## Gated live test: real Sourcify fetch + arbitrary-version recompile
  describe.skipIf(!process.env.SIMBOLIK_LIVE)('live round-trip (network)', () => {
    it('fetches Multicall3, recompiles @ 0.8.12, round-trips', async () => {
      const recompile = await loadRecompile();
      expect(recompile).toBeDefined();

      const mod = (await import('../src/index.js')) as unknown as {
        SourcifyRepository?: new (opts?: unknown) => {
          resolve: (
            chainId: number,
            address: string,
          ) => Promise<ResolvedContractLike | undefined>;
        };
      };
      expect(mod.SourcifyRepository).toBeDefined();

      const repo = new mod.SourcifyRepository!();
      const resolved = await repo.resolve(
        1,
        '0xcA11bde05977b3631167028862bE2a173976CA11',
      );
      expect(resolved).toBeDefined();

      const bi = await recompile!(resolved!);
      const cu = loadBuildInfo(bi);

      const contract = cu.contract('Multicall3.sol', 'Multicall3');
      expect(contract).toBeDefined();
      expect(contract!.storageLayout()).toBeDefined();
      expect(contract!.runtimeSourceMap().length).toBeGreaterThan(0);
    });
  });
});
