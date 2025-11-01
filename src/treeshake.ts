// Tree-shake a Foundry build-info object (Standard JSON input + output)
// to only include the entry-point contract and its transitive dependencies.
// Supports various size-saving operations to strip unneeded data from the
// build-info.

type Json = any;

/* ------------------------------- Entry Point ----------------------------- */

export interface EntryPoint {
  source: string;
  contract: string;
}

/* --------------------- Minimal Standard JSON (input) --------------------- */

export interface StandardJsonInput {
  language?: string; // "Solidity"
  sources?: {
    [sourcePath: string]: {
      content?: string;
      urls?: string[];
      keccak256?: string;
    };
  };
  settings?: {
    remappings?: string[];
    optimizer?: Json;
    evmVersion?: string;
    libraries?: {
      [sourcePath: string]: { [libraryName: string]: string };
    };
    outputSelection?: {
      [file: string]: {
        [contract: string]: string[];
      };
    };
    metadata?: Json;
  };
}

/* ----------------------- Minimal Standard JSON (output) ------------------ */

export interface SolcOutput {
  contracts?: {
    [sourcePath: string]: {
      [contractName: string]: {
        abi?: Json;
        evm?: {
          bytecode?: { object?: string; sourceMap?: string; linkReferences?: Json };
          deployedBytecode?: { object?: string; sourceMap?: string; immutableReferences?: Json };
          legacyAssembly?: Json;
          methodIdentifiers?: Json;
        };
        ir?: Json;
        irOptimized?: Json;
        ewasm?: Json;
        metadata?: string; // JSON string with { sources: { [path]: {...} }, ... }
        storageLayout?: Json;
        devdoc?: Json;
        userdoc?: Json;
      };
    };
  };
  sources?: {
    [sourcePath: string]: {
      id?: number;
      ast?: any;
      legacyAST?: any;
    };
  };
  errors?: Array<{
    sourceLocation?: { file?: string };
    formattedMessage?: string;
    message?: string;
    severity?: "error" | "warning";
    type?: string;
  }>;
  version?: string;
}

/* ----------------------------- Foundry build-info ------------------------ */

export interface FoundryBuildInfo {
  _format?: string;                // e.g. "etherscan-build-info-1"
  id: string;
  solcVersion?: string;
  solcLongVersion?: string;
  paths?: Json;                    // Foundry extras (kept untouched)
  input: StandardJsonInput;        // Standard JSON *input* (request)
  output: SolcOutput;              // Standard JSON *output* (result)
}


export interface TreeShakeResult {
  shaken: FoundryBuildInfo;
  stats: {
    originalBytes: number;
    shakenBytes: number;
    savingsPercent: number;
    keptSources: string[];
  };
}

/* -------------------------------- API ------------------------------------ */

/**
 * Tree-shake a Foundry build-info (standard input + output) given an entry
 * point tuple (source file + contract name). Returns the shaken build-info
 * along with statistics about the shaking process.
 */
export function treeShakeFoundryBuildInfo(
  buildInfo: FoundryBuildInfo,
  entry: EntryPoint
): TreeShakeResult {
  const originalBytes = bytesLength(buildInfo);

  // 1) Compute kept sources from OUTPUT
  const sourcesSet = resolveDependencies(buildInfo.output, entry);

  // 2) Prune OUTPUT with size-saving toggles.
  const prunedOutput = pruneOutput(buildInfo.output, sourcesSet);

  // 3) Prune INPUT to the same source set (+ optional narrowing).
  const prunedInput = pruneInput(buildInfo.input, sourcesSet);

  const shaken: FoundryBuildInfo = {
    _format: buildInfo._format,
    id: buildInfo.id,
    solcVersion: buildInfo.solcVersion,
    solcLongVersion: buildInfo.solcLongVersion,
    paths: buildInfo.paths,
    input: prunedInput,
    output: prunedOutput,
  };

  const shakenBytes = bytesLength(shaken);
  const savingsPercent =
    originalBytes > 0 ? Math.round((1 - shakenBytes / originalBytes) * 1000) / 10 : 0;

  return {
    shaken,
    stats: {
      originalBytes,
      shakenBytes,
      savingsPercent,
      keptSources: [...sourcesSet].sort(),
    },
  };
}

/* ------------------------------ OUTPUT pruning --------------------------- */

function pruneOutput(
  output: SolcOutput,
  sourcesSet: Set<string>
): SolcOutput {

  const pruned: SolcOutput = {};
  if (output.version) pruned.version = output.version;

  // contracts
  if (output.contracts) {
    pruned.contracts = {};
    for (const [src, contracts] of Object.entries(output.contracts)) {
      if (!sourcesSet.has(src)) continue;
      const kept: NonNullable<SolcOutput["contracts"]>[string] = {};
      for (const [name, artifact] of Object.entries(contracts || {})) {
        const cloned = deepClone(artifact);

        // size trims
        if (cloned?.evm?.legacyAssembly) delete cloned.evm.legacyAssembly;
        if (cloned.ir) delete cloned.ir;
        if (cloned.irOptimized) delete cloned.irOptimized;
        if (cloned.devdoc) delete cloned.devdoc;
        if (cloned.userdoc) delete cloned.userdoc;
        kept[name] = cloned;
      }
      if (Object.keys(kept).length > 0) pruned.contracts[src] = kept;
    }
  }

  // sources
  if (output.sources) {
    pruned.sources = {};
    for (const [src, srcObj] of Object.entries(output.sources)) {
      if (sourcesSet.has(src)) pruned.sources[src] = srcObj;
    }
  }

  // errors (keep global + kept files)
  if (output.errors) {
    pruned.errors = output.errors.filter((e) => {
      const file = e?.sourceLocation?.file;
      return !file || sourcesSet.has(file);
    });
  }

  return pruned;
}

/* ------------------------------ INPUT pruning ---------------------------- */

function pruneInput(
  input: StandardJsonInput,
  sourcesSet: Set<string>
): StandardJsonInput {

  const out: StandardJsonInput = {
    language: input.language,
    sources: {},
    settings: deepClone(input.settings ?? {}),
  };

  // sources
  for (const [src, srcObj] of Object.entries(input.sources ?? {})) {
    if (sourcesSet.has(src)) {
      (out.sources as any)[src] = srcObj;
    }
  }

  // settings.libraries
  if (out.settings?.libraries) {
    const libs: NonNullable<StandardJsonInput["settings"]>["libraries"] = {};
    for (const [src, libMap] of Object.entries(out.settings.libraries)) {
      if (sourcesSet.has(src)) libs[src] = libMap;
    }
    out.settings.libraries = libs;
  }

  // settings.outputSelection
  if (out.settings?.outputSelection) {
    out.settings.outputSelection = {};
  }

  return out;
}

/* ---------------------------- Dependency logic --------------------------- */

export class ContractNotFoundError extends Error {}

export class MissingSourcesInMetadataError extends Error {}

function resolveDependencies(
  output: SolcOutput,
  entry: EntryPoint
):  Set<string> {
  const contracts = output.contracts ?? {};
  const artifact = contracts[entry.source]?.[entry.contract];
  if (!artifact) {
    throw new ContractNotFoundError(`Contract not found in build info output: ${entry.source}:${entry.contract}`);
  }
  const meta = safeParseJSON(artifact?.metadata);
  if (meta?.sources && typeof meta.sources === "object") {
    return new Set(Object.keys(meta.sources));
  }
  throw new MissingSourcesInMetadataError(`Missing or invalid metadata.sources in artifact for ${entry.source}:${entry.contract}`);

}

/* -------------------------------- Utils ---------------------------------- */

function deepClone<T>(x: T): T {
  return x == null ? (x as any) : JSON.parse(JSON.stringify(x));
}

function bytesLength(obj: any): number {
  return Buffer.byteLength(JSON.stringify(obj));
}

function safeParseJSON(s?: string): any | undefined {
  if (!s || typeof s !== "string") return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
