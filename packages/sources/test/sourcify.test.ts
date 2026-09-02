import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';

/**
 * Tests for `SourcifyRepository`.
 *
 * We import the public entry point with a LOOSE dynamic-import cast: that keeps
 * the suite type-clean (no "has no exported member" compile error) and surfaces
 * a missing export as a runtime/assertion failure rather than a compile error.
 */

const ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

/** Load a fixture JSON resolved relative to this test's src/ location. */
function loadFixture(name: string): unknown {
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as unknown;
}

// Minimal structural shape of what we exercise on the (future) exports. Kept
// loose on purpose so importing symbols that don't exist yet is not a TS error.
type ResolvedContractLike = {
  chainId: number;
  address: string;
  name?: string;
  match?: string;
  compilerVersion: string;
  standardJsonInput: {
    language: string;
    sources: Record<string, {content: string}>;
    settings: Record<string, unknown>;
  };
};

type SourceRepositoryLike = {
  resolve(
    chainId: number,
    address: string,
  ): Promise<ResolvedContractLike | undefined>;
};

type SourcifyOptions = {baseUrl?: string; fetch?: unknown};
type SourcifyCtor = new (opts?: SourcifyOptions) => SourceRepositoryLike;

/** Loose dynamic import — resolves to `undefined` if `SourcifyRepository` is not exported. */
async function loadSourcify(): Promise<SourcifyCtor | undefined> {
  const mod = (await import('../src/index.js')) as unknown as {
    SourcifyRepository?: SourcifyCtor;
  };
  return mod.SourcifyRepository;
}

/**
 * A `Response`-like fake fetch that records the URL(s) it was called with and
 * returns the given `{ok, status, json}` body. Shape matches what `resolve`
 * needs from a real `fetch` Response (ok / status / json()).
 */
function makeFakeFetch(opts: {ok: boolean; status: number; body?: unknown}) {
  const calls: string[] = [];
  const fetch = async (input: unknown): Promise<unknown> => {
    calls.push(String(input));
    return {
      ok: opts.ok,
      status: opts.status,
      json: async () => opts.body,
    };
  };
  return {fetch, calls};
}

describe('SourcifyRepository', () => {
  it('is exported from the package entry point', async () => {
    const SourcifyRepository = await loadSourcify();
    expect(SourcifyRepository).toBeDefined();
    expect(typeof SourcifyRepository).toBe('function');
  });

  describe('happy path (injected fetch → recorded fixture)', () => {
    const fixture = loadFixture('multicall3-sourcify-v2.json');

    async function resolveOnce() {
      const SourcifyRepository = await loadSourcify();
      const {fetch, calls} = makeFakeFetch({
        ok: true,
        status: 200,
        body: fixture,
      });
      const repo = new SourcifyRepository!({fetch});
      const r = await repo.resolve(1, ADDRESS);
      return {r, calls};
    }

    it('returns a defined ResolvedContract', async () => {
      const {r} = await resolveOnce();
      expect(r).toBeDefined();
    });

    it('parses compilerVersion, name and match from compilation', async () => {
      const {r} = await resolveOnce();
      expect(r!.compilerVersion).toBe('0.8.12+commit.f00d7308');
      expect(r!.name).toBe('Multicall3');
      expect(r!.match).toBe('exact_match');
    });

    it('exposes the standard-json language and inline source content', async () => {
      const {r} = await resolveOnce();
      expect(r!.standardJsonInput.language).toBe('Solidity');
      const source = r!.standardJsonInput.sources['Multicall3.sol'];
      expect(source).toBeDefined();
      expect(source!.content).toContain('contract Multicall3');
    });

    it('carries Sourcify compilerSettings through as standard-json settings', async () => {
      const {r} = await resolveOnce();
      expect(r!.standardJsonInput.settings.optimizer).toEqual({
        enabled: true,
        runs: 10000000,
      });
      expect(r!.standardJsonInput.settings.evmVersion).toBe('london');
      // Wrong-path guard. The fixture carries an identical optimizer/evmVersion
      // under BOTH `compilation.compilerSettings` and the top-level solc
      // `metadata.settings`, so the two assertions above alone cannot tell the
      // paths apart. The distinguishing key is `compilationTarget`: it exists
      // only in `metadata.settings`, never in `compilation.compilerSettings`.
      // An impl that mistakenly parses `metadata.settings` would leak it here.
      expect(r!.standardJsonInput.settings.compilationTarget).toBeUndefined();
    });
  });

  it('builds the v2 URL with the chainId, address and fields query', async () => {
    const SourcifyRepository = await loadSourcify();
    const {fetch, calls} = makeFakeFetch({
      ok: true,
      status: 200,
      body: loadFixture('multicall3-sourcify-v2.json'),
    });
    const repo = new SourcifyRepository!({fetch});
    await repo.resolve(1, ADDRESS);

    expect(calls).toHaveLength(1);
    const url = calls[0]!;
    expect(url).toContain(`/v2/contract/1/${ADDRESS}`);
    expect(url).toContain('fields=sources,compilation');
  });

  it('returns undefined (no throw) on a 404 not-found', async () => {
    const SourcifyRepository = await loadSourcify();
    const {fetch} = makeFakeFetch({ok: false, status: 404});
    const repo = new SourcifyRepository!({fetch});
    const r = await repo.resolve(1, ADDRESS);
    expect(r).toBeUndefined();
  });

  it('returns undefined for a 200 body whose match is null', async () => {
    const SourcifyRepository = await loadSourcify();
    const {fetch} = makeFakeFetch({
      ok: true,
      status: 200,
      body: {match: null, chainId: '1', address: ADDRESS},
    });
    const repo = new SourcifyRepository!({fetch});
    const r = await repo.resolve(1, ADDRESS);
    expect(r).toBeUndefined();
  });

  it('returns undefined for a 200 body with a match but no compilation', async () => {
    const SourcifyRepository = await loadSourcify();
    const {fetch} = makeFakeFetch({
      ok: true,
      status: 200,
      body: {match: 'exact_match', chainId: '1', address: ADDRESS},
    });
    const repo = new SourcifyRepository!({fetch});
    const r = await repo.resolve(1, ADDRESS);
    expect(r).toBeUndefined();
  });

  it('honours a baseUrl override when building the request URL', async () => {
    const SourcifyRepository = await loadSourcify();
    const {fetch, calls} = makeFakeFetch({
      ok: true,
      status: 200,
      body: loadFixture('multicall3-sourcify-v2.json'),
    });
    const repo = new SourcifyRepository!({baseUrl: 'http://x', fetch});
    await repo.resolve(1, ADDRESS);

    expect(calls).toHaveLength(1);
    expect(calls[0]!).toContain('http://x/v2/contract/1/');
  });
});
