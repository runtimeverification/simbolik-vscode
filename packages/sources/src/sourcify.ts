/**
 * Sourcify-backed {@link SourceRepository}.
 *
 * Given a `(chainId, address)` pair, {@link SourcifyRepository.resolve} fetches a
 * verified contract's sources + compiler settings from Sourcify's v2 API and
 * returns them as a solc standard-json input ready to recompile (the recompile
 * itself lands in a later cycle). Fetch + parse only.
 */

/** A solc standard-json input (sources + settings), ready to recompile. */
export interface StandardJsonInput {
  language: string;
  sources: Record<string, {content: string}>;
  settings: Record<string, unknown>;
}

/** A verified contract resolved from a {@link SourceRepository}. */
export interface ResolvedContract {
  chainId: number;
  address: string;
  name?: string;
  match?: string;
  compilerVersion: string;
  standardJsonInput: StandardJsonInput;
}

/** Resolves verified contract sources for a `(chainId, address)` pair. */
export interface SourceRepository {
  resolve(
    chainId: number,
    address: string,
  ): Promise<ResolvedContract | undefined>;
}

/** Options for {@link SourcifyRepository}. */
export interface SourcifyRepositoryOptions {
  /** Base URL of the Sourcify server. */
  baseUrl?: string;
  /** Injectable `fetch` (defaults to the global one) — lets tests avoid the network. */
  fetch?: typeof fetch;
}

/** The subset of the Sourcify v2 `compilation` object we consume. */
interface SourcifyCompilation {
  language: string;
  compilerVersion: string;
  compilerSettings: Record<string, unknown>;
  name?: string;
}

/** The subset of the Sourcify v2 contract response we consume. */
interface SourcifyV2Response {
  match?: string | null;
  compilation?: SourcifyCompilation;
  sources?: Record<string, {content: string}>;
}

const DEFAULT_BASE_URL = 'https://sourcify.dev/server';

/** {@link SourceRepository} backed by the Sourcify v2 HTTP API. */
export class SourcifyRepository implements SourceRepository {
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;

  constructor({
    baseUrl = DEFAULT_BASE_URL,
    fetch = globalThis.fetch,
  }: SourcifyRepositoryOptions = {}) {
    this.baseUrl = baseUrl;
    this.fetch = fetch;
  }

  async resolve(
    chainId: number,
    address: string,
  ): Promise<ResolvedContract | undefined> {
    const url = `${this.baseUrl}/v2/contract/${chainId}/${address}?fields=sources,compilation`;
    const res = await this.fetch(url);
    if (!res.ok) {
      return undefined;
    }

    const body = (await res.json()) as SourcifyV2Response | null | undefined;
    if (!body || !body.match || !body.compilation || !body.sources) {
      return undefined;
    }

    const {compilation, sources} = body;
    return {
      chainId,
      address,
      name: compilation.name,
      match: body.match,
      compilerVersion: compilation.compilerVersion,
      standardJsonInput: {
        language: compilation.language,
        sources,
        settings: compilation.compilerSettings,
      },
    };
  }
}
