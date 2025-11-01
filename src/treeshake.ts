// treeShakeFoundryBuildInfo.ts
// Tree-shake a Foundry build-info object (Standard JSON input + output)
// to only include the entry-point contract and its transitive dependencies.

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

/* ------------------------------- Options --------------------------------- */

export interface TreeShakeOptions {
  keepBytecode?: boolean;              // default: true
  keepSourceMaps?: boolean;            // default: false
  keepIr?: boolean;                    // default: false
  keepLegacyAssembly?: boolean;        // default: false
  keepOutputSelection?: boolean;       // default: false
  keepAst?: boolean;                   // default: false
  stripDocs?: boolean;                 // default: false
  stripStorageLayout?: boolean;        // default: false

  // Input-specific tweaks:
  narrowOutputSelection?: boolean; // default: true (limits to kept files)
  pruneLibraries?: boolean;        // default: true (drop libraries for removed files)
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

/* --------------------------------- API ------------------------------------- */

/**
 * Tree-shake a Foundry build-info (standard input + output) given an entry FQN.
 * `entryFQN` can be "path/File.sol:Contract" or just "Contract" if unique.
 */
export function treeShakeFoundryBuildInfo(
  buildInfo: FoundryBuildInfo,
  entry: EntryPoint,
  opts: TreeShakeOptions = {}
): TreeShakeResult {
  const {
    keepBytecode = true,
    keepSourceMaps = false,
    keepIr = false,
    keepLegacyAssembly = false,
    keepOutputSelection = false,
    keepAst = false,
    stripDocs = false,
    stripStorageLayout = false,
    narrowOutputSelection = true,
    pruneLibraries = true,
  } = opts;

  const originalBytes = bytesLength(buildInfo);

  // 1) Compute kept sources from OUTPUT (prefer metadata; fallback AST).
  const sourcesSet = resolveDependencies(buildInfo.output, entry);

  // 2) Prune OUTPUT with size-saving toggles.
  const prunedOutput = pruneOutput(buildInfo.output, {
    sourcesSet,
    keepBytecode,
    keepSourceMaps,
    keepIr,
    keepLegacyAssembly,
    keepAst,
    stripDocs,
    stripStorageLayout,
  });

  // 3) Prune INPUT to the same source set (+ optional narrowing).
  const prunedInput = pruneInput(buildInfo.input, {
    sourcesSet,
    narrowOutputSelection,
    keepOutputSelection,
    pruneLibraries,
  });

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

/* ------------------------------- OUTPUT pruning ----------------------------- */

function pruneOutput(
  output: SolcOutput,
  params: {
    sourcesSet: Set<string>;
    keepBytecode: boolean;
    keepSourceMaps: boolean;
    keepIr: boolean;
    keepLegacyAssembly: boolean;
    keepAst: boolean;
    stripDocs: boolean;
    stripStorageLayout: boolean;
  }
): SolcOutput {
  const {
    sourcesSet,
    keepBytecode,
    keepSourceMaps,
    keepIr,
    keepLegacyAssembly,
    keepAst,
    stripDocs,
    stripStorageLayout,
  } = params;

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
        if (!keepSourceMaps) {
          cloned?.evm?.bytecode && (cloned.evm.bytecode.sourceMap = undefined);
          cloned?.evm?.deployedBytecode && (cloned.evm.deployedBytecode.sourceMap = undefined);
        }
        if (!keepLegacyAssembly && cloned?.evm?.legacyAssembly) {
          delete cloned.evm.legacyAssembly;
        }
        if (!keepIr) {
          if (cloned.ir) delete cloned.ir;
          if (cloned.irOptimized) delete cloned.irOptimized;
        }
        if (!keepBytecode) {
          if (cloned?.evm?.bytecode?.object) cloned.evm.bytecode.object = "";
          if (cloned?.evm?.deployedBytecode?.object) cloned.evm.deployedBytecode.object = "";
        }
        if (stripDocs) {
          if (cloned.devdoc) delete cloned.devdoc;
          if (cloned.userdoc) delete cloned.userdoc;
        }
        if (stripStorageLayout && cloned.storageLayout) {
          delete cloned.storageLayout;
        }
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
      // prune ast if present
      if (pruned.sources[src]?.ast && !keepAst) {
        delete pruned.sources[src].ast;
      }
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

/* -------------------------------- INPUT pruning ----------------------------- */

function pruneInput(
  input: StandardJsonInput,
  params: {
    sourcesSet: Set<string>;
    narrowOutputSelection: boolean;
    keepOutputSelection: boolean;
    pruneLibraries: boolean
  }
): StandardJsonInput {
  const { sourcesSet, narrowOutputSelection, keepOutputSelection, pruneLibraries } = params;

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
  if (pruneLibraries && out.settings?.libraries) {
    const libs: NonNullable<StandardJsonInput["settings"]>["libraries"] = {};
    for (const [src, libMap] of Object.entries(out.settings.libraries)) {
      if (sourcesSet.has(src)) libs[src] = libMap;
    }
    out.settings.libraries = libs;
  }

  // settings.outputSelection
  // Option A (default): keep only entries for kept files, plus wildcard rules.
  // This keeps the structure valid for re-compilation while narrowing scope.
  if (keepOutputSelection &&narrowOutputSelection && out.settings?.outputSelection) {
    const selIn = out.settings.outputSelection;
    const selOut: typeof selIn = {};
    for (const [file, perContract] of Object.entries(selIn)) {
      if (file === "*" || sourcesSet.has(file)) {
        selOut[file] = perContract;
      }
    }
    out.settings.outputSelection = selOut;
  } else if (!keepOutputSelection) {
    // Option B: drop entirely.
    if (out.settings) out.settings.outputSelection = {};
  }

  return out;
}

/* ------------------------------ Dependency logic --------------------------- */

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

/* --------------------------------- Utils ----------------------------------- */

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
