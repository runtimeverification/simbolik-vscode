// treeShakeFoundryBuildInfo.ts
// Tree-shake a Foundry build-info object (Standard JSON input + output)
// to only include the entry-point contract and its transitive dependencies.

type Json = any;

/* ----------------------- Minimal Standard JSON (input) ---------------------- */

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

/* ----------------------- Minimal Standard JSON (output) --------------------- */

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

/* ------------------------------ Foundry build-info -------------------------- */

export interface FoundryBuildInfo {
  _format?: string;                // e.g. "etherscan-build-info-1"
  id: string;
  solcVersion?: string;
  solcLongVersion?: string;
  paths?: Json;                    // Foundry extras (kept untouched)
  input: StandardJsonInput;        // Standard JSON *input* (request)
  output: SolcOutput;              // Standard JSON *output* (result)
}

/* --------------------------------- Options --------------------------------- */

export interface TreeShakeOptions {
  keepBytecode?: boolean;          // default: true
  keepSourceMaps?: boolean;        // default: false
  keepIr?: boolean;                // default: false
  keepLegacyAssembly?: boolean;    // default: false
  onlyEntryContractArtifact?: boolean; // default: false
  stripDocs?: boolean;             // default: false
  stripStorageLayout?: boolean;    // default: false

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
    entry: { source: string; contract: string };
    resolution: "metadata" | "ast" | "single-file";
  };
}

/* --------------------------------- API ------------------------------------- */

/**
 * Tree-shake a Foundry build-info (standard input + output) given an entry FQN.
 * `entryFQN` can be "path/File.sol:Contract" or just "Contract" if unique.
 */
export function treeShakeFoundryBuildInfo(
  buildInfo: FoundryBuildInfo,
  entryFQN: string,
  opts: TreeShakeOptions = {}
): TreeShakeResult {
  const {
    keepBytecode = true,
    keepSourceMaps = false,
    keepIr = false,
    keepLegacyAssembly = false,
    onlyEntryContractArtifact = false,
    stripDocs = false,
    stripStorageLayout = false,
    narrowOutputSelection = true,
    pruneLibraries = true,
  } = opts;

  const originalBytes = byteLengthSafe(buildInfo);

  // 1) Resolve entry file/contract from OUTPUT (more reliable than input).
  const { entrySource, entryContract } = resolveEntry(buildInfo.output, entryFQN);

  // 2) Compute kept sources from OUTPUT (prefer metadata; fallback AST).
  const { sourcesSet, resolution } = resolveDependencies(buildInfo.output, entrySource, entryContract);

  // 3) Prune OUTPUT with size-saving toggles.
  const prunedOutput = pruneOutput(buildInfo.output, {
    sourcesSet,
    entrySource,
    entryContract,
    keepBytecode,
    keepSourceMaps,
    keepIr,
    keepLegacyAssembly,
    onlyEntryContractArtifact,
    stripDocs,
    stripStorageLayout,
  });

  // 4) Prune INPUT to the same source set (+ optional narrowing).
  const prunedInput = pruneInput(buildInfo.input, {
    sourcesSet,
    narrowOutputSelection,
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

  const shakenBytes = byteLengthSafe(shaken);
  const savingsPercent =
    originalBytes > 0 ? Math.round((1 - shakenBytes / originalBytes) * 1000) / 10 : 0;

  return {
    shaken,
    stats: {
      originalBytes,
      shakenBytes,
      savingsPercent,
      keptSources: [...sourcesSet].sort(),
      entry: { source: entrySource, contract: entryContract },
      resolution,
    },
  };
}

/* ------------------------------- OUTPUT pruning ----------------------------- */

function pruneOutput(
  output: SolcOutput,
  params: {
    sourcesSet: Set<string>;
    entrySource: string;
    entryContract: string;
    keepBytecode: boolean;
    keepSourceMaps: boolean;
    keepIr: boolean;
    keepLegacyAssembly: boolean;
    onlyEntryContractArtifact: boolean;
    stripDocs: boolean;
    stripStorageLayout: boolean;
  }
): SolcOutput {
  const {
    sourcesSet,
    entrySource,
    entryContract,
    keepBytecode,
    keepSourceMaps,
    keepIr,
    keepLegacyAssembly,
    onlyEntryContractArtifact,
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
        if (onlyEntryContractArtifact && src === entrySource && name !== entryContract) continue;
        const cloned = deepClone(artifact);

        // size trims
        if (!params.keepSourceMaps) {
          cloned?.evm?.bytecode && (cloned.evm.bytecode.sourceMap = undefined);
          cloned?.evm?.deployedBytecode && (cloned.evm.deployedBytecode.sourceMap = undefined);
        }
        if (!params.keepLegacyAssembly && cloned?.evm?.legacyAssembly) {
          delete cloned.evm.legacyAssembly;
        }
        if (!params.keepIr) {
          if (cloned.ir) delete cloned.ir;
          if (cloned.irOptimized) delete cloned.irOptimized;
        }
        if (!params.keepBytecode) {
          if (cloned?.evm?.bytecode?.object) cloned.evm.bytecode.object = "";
          if (cloned?.evm?.deployedBytecode?.object) cloned.evm.deployedBytecode.object = "";
        }
        if (params.stripDocs) {
          if (cloned.devdoc) delete cloned.devdoc;
          if (cloned.userdoc) delete cloned.userdoc;
        }
        if (params.stripStorageLayout && cloned.storageLayout) {
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
  params: { sourcesSet: Set<string>; narrowOutputSelection: boolean; pruneLibraries: boolean }
): StandardJsonInput {
  const { sourcesSet, narrowOutputSelection, pruneLibraries } = params;

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
  if (narrowOutputSelection && out.settings?.outputSelection) {
    const selIn = out.settings.outputSelection;
    const selOut: typeof selIn = {};
    for (const [file, perContract] of Object.entries(selIn)) {
      if (file === "*" || sourcesSet.has(file)) {
        selOut[file] = perContract;
      }
    }
    out.settings.outputSelection = selOut;
  }

  return out;
}

/* ------------------------------ Dependency logic --------------------------- */

export class ContractNotFoundError extends Error {}

function parseEntryFQN(entry: string): { file?: string; contract: string } {
  const i = entry.lastIndexOf(":");
  return i === -1 ? { contract: entry } : { file: entry.slice(0, i), contract: entry.slice(i + 1) };
}

function resolveEntry(
  output: SolcOutput,
  entryFQN: string
): { entrySource: string; entryContract: string } {
  const contracts = output.contracts ?? {};
  const { file: wantedFile, contract: wantedContract } = parseEntryFQN(entryFQN);

  if (wantedFile) {
    const fileContracts = contracts[wantedFile];
    if (!fileContracts) throw new ContractNotFoundError(`Entry file "${wantedFile}" not found in output.contracts.`);
    if (!(wantedContract in fileContracts)) {
      const available = Object.keys(fileContracts).join(", ");
      throw new Error(
        `Contract "${wantedContract}" not found in "${wantedFile}". Available: ${available}`
      );
    }
    return { entrySource: wantedFile, entryContract: wantedContract };
  }

  // find unique by name
  let found: string | undefined;
  for (const [src, fileContracts] of Object.entries(contracts)) {
    if (fileContracts && wantedContract in fileContracts) {
      if (found && found !== src) {
        throw new Error(
          `Contract "${wantedContract}" found in multiple files. Use "File.sol:${wantedContract}".`
        );
      }
      found = src;
    }
  }
  if (!found) {
    const sample = Object.entries(contracts)
      .flatMap(([src, cs]) => Object.keys(cs || {}).map((c) => `${src}:${c}`))
      .slice(0, 10);
    throw new Error(`Contract "${wantedContract}" not found. Sample: ${sample.join(", ")} ...`);
  }
  return { entrySource: found, entryContract: wantedContract };
}

function resolveDependencies(
  output: SolcOutput,
  entrySource: string,
  _entryContract: string
): { sourcesSet: Set<string>; resolution: "metadata" | "ast" | "single-file" } {
  const contracts = output.contracts ?? {};
  const artifact = contracts[entrySource]?.[_entryContract];
  const meta = safeParseJSON(artifact?.metadata);
  if (meta?.sources && typeof meta.sources === "object") {
    return { sourcesSet: new Set(Object.keys(meta.sources)), resolution: "metadata" };
  }

  const ast = output.sources?.[entrySource]?.ast;
  if (ast) {
    const set = new Set<string>();
    collectImportsDFS(output, entrySource, set);
    return { sourcesSet: set, resolution: "ast" };
  }

  return { sourcesSet: new Set([entrySource]), resolution: "single-file" };
}

function collectImportsDFS(output: SolcOutput, src: string, seen: Set<string>) {
  if (seen.has(src)) return;
  seen.add(src);

  const ast = output.sources?.[src]?.ast;
  if (!ast) return;

  const stack: any[] = [ast];
  while (stack.length) {
    const node = stack.pop();
    if (node && typeof node === "object") {
      if (node.nodeType === "ImportDirective") {
        // Different solc versions: absolutePath or file
        const abs = node.absolutePath || node.file;
        if (abs && typeof abs === "string") collectImportsDFS(output, abs, seen);
      }
      for (const v of Object.values(node)) {
        if (!v || typeof v !== "object") continue;
        if (Array.isArray(v)) for (const it of v) stack.push(it);
        else stack.push(v);
      }
    }
  }
}

/* --------------------------------- Utils ----------------------------------- */

function deepClone<T>(x: T): T {
  return x == null ? (x as any) : JSON.parse(JSON.stringify(x));
}

function byteLengthSafe(obj: any): number {
  try {
    return Buffer.byteLength(JSON.stringify(obj));
  } catch {
    return JSON.stringify(safeForStringify(obj)).length;
  }
}

function safeForStringify(obj: any): any {
  const seen = new WeakSet();
  const walk = (x: any): any => {
    if (x && typeof x === "object") {
      if (seen.has(x)) return "[[Circular]]";
      seen.add(x);
      if (Array.isArray(x)) return x.map(walk);
      const out: any = {};
      for (const [k, v] of Object.entries(x)) out[k] = walk(v);
      return out;
    }
    return x;
  };
  return walk(obj);
}

function safeParseJSON(s?: string): any | undefined {
  if (!s || typeof s !== "string") return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
