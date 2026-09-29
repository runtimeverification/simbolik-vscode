/**
 * Which code runs at which address: the address → {contract, cu} registry a
 * session resolves every frame, step and emitter through.
 *
 * Addresses are identified by CBOR metadata of the code the trace executed
 * there; an explicit address → build-info map (the only workable path for geth,
 * whose trace carries no per-step code) wins over that. An address whose code
 * cannot be attributed to any compilation unit is FOREIGN.
 */
import type {StateCursor, Step} from '@simbolik/lifting';
import type {Hex} from '@simbolik/protocol';
import {
  identifyContractByRuntimeCode,
  loadBuildInfo,
  type CompilationUnit,
  type Contract,
} from '@simbolik/solc';

import {addressHex} from './hex.js';
import type {LaunchInputs} from './launchInputs.js';
import type {StepResolution} from './stepping.js';

/**
 * A FOREIGN code resolution: an address running bytecode that could not be
 * attributed to any compilation unit (etched raw bytecode, an unknown callee).
 * It carries NO contract/cu — its frame is rendered EVM-only (no Solidity
 * source, an address-derived name, non-descendable) and its steps are left
 * unmapped by the stepping model (raw EVM depth, no jump fold), so a foreign
 * subcall neither mis-maps onto the entry contract nor corrupts parent stepping.
 */
export interface ForeignResolution {
  kind: 'foreign';
  /** Lowercase hex code address whose bytecode is unidentifiable. */
  address: string;
}

/** A registry entry: a resolved contract CU, or a foreign (unidentifiable) code address. */
export type RegistryResolution = StepResolution | ForeignResolution;

/** Whether a registry resolution is a FOREIGN (unidentifiable) code address. */
export function isForeign(r: RegistryResolution): r is ForeignResolution {
  return (r as ForeignResolution).kind === 'foreign';
}

function resolutionOf(contract: Contract, cu: CompilationUnit): StepResolution {
  return {contract, cu, optimized: cu.optimizer().enabled};
}

export class CodeRegistry {
  readonly #byAddress: Map<string, RegistryResolution>;
  /** The launch/entry contract: the ultimate resolution fallback. */
  readonly entry: StepResolution;

  private constructor(
    byAddress: Map<string, RegistryResolution>,
    entry: StepResolution
  ) {
    this.#byAddress = byAddress;
    this.entry = entry;
  }

  /**
   * Build the registry over the DISTINCT code addresses in the trace. CUs loaded
   * from `inputs.contractsByAddress` are appended to `cus`.
   */
  static build(
    inputs: LaunchInputs,
    cus: CompilationUnit[],
    steps: readonly Step[],
    cursor: StateCursor
  ): CodeRegistry {
    const entryAddr = inputs.codeAddress.toLowerCase();
    const entry = resolveEntry(inputs, cus, steps, cursor);

    const firstSeen = new Map<string, number>();
    // A separate index of the first RUNTIME-code step per address. A contract
    // CREATE'd during THIS transaction first appears running its INIT (creation)
    // code, which never matches the build-info deployedBytecode — identifying from
    // it would mark the address foreign. Identify from a deployed-runtime step so
    // an in-tx `new C()` resolves to its CU (and its frame is steppable).
    const firstRuntimeSeen = new Map<string, number>();
    for (let i = 0; i < steps.length; i++) {
      const addr = addressHex(steps[i]!.codeAddress);
      if (!firstSeen.has(addr)) firstSeen.set(addr, i);
      if (!steps[i]!.isInitCode && !firstRuntimeSeen.has(addr)) {
        firstRuntimeSeen.set(addr, i);
      }
    }
    const sampleStep = (addr: string): number | undefined =>
      firstRuntimeSeen.get(addr) ?? firstSeen.get(addr);

    const byAddress = new Map<string, RegistryResolution>();
    for (const addr of firstSeen.keys()) {
      const identified = identify(cus, cursor.at(sampleStep(addr)!).bytecode);
      // The ENTRY address maps to the entry contract — that IS its own code,
      // even when CBOR-identification fails (e.g. metadata stripped). Any OTHER
      // address whose code does not identify is FOREIGN: falling back to the
      // entry CU would mis-map its PCs onto the entry contract's source.
      byAddress.set(
        addr,
        identified ??
          (addr === entryAddr ? entry : {kind: 'foreign', address: addr})
      );
    }

    // An explicit address→build-info map WINS over CBOR-from-trace; the CBOR
    // path above stays the fallback for addresses absent here.
    for (const [rawAddr, spec] of Object.entries(
      inputs.contractsByAddress ?? {}
    )) {
      const addr = rawAddr.toLowerCase();
      const cu = loadBuildInfo(spec.buildInfoJson);
      // Register the CU for cross-CU lookups, deduped by the parsed-CU identity.
      if (!cus.includes(cu)) cus.push(cu);
      const contract = pickContract(
        cu,
        spec.contractName,
        cursor,
        sampleStep(addr),
        spec.sourcePath
      );
      if (contract !== undefined)
        byAddress.set(addr, resolutionOf(contract, cu));
    }

    // Guarantee the entry address always resolves (single-CU back-compat).
    if (!byAddress.has(entryAddr)) byAddress.set(entryAddr, entry);
    return new CodeRegistry(byAddress, entry);
  }

  /** The registered resolution of `address` (lowercase hex), if any. */
  get(address: string): RegistryResolution | undefined {
    return this.#byAddress.get(address);
  }

  /** The resolution of `address`, falling back to the entry contract. */
  resolve(address: string): RegistryResolution {
    return this.#byAddress.get(address) ?? this.entry;
  }

  /** The contract `address` resolves to, or `undefined` for foreign code. */
  contractAt(address: string): StepResolution | undefined {
    const r = this.resolve(address);
    return isForeign(r) ? undefined : r;
  }
}

/** Identify a runtime code across all CUs (CBOR metadata), first match wins. */
function identify(
  cus: CompilationUnit[],
  code: Hex
): StepResolution | undefined {
  for (const cu of cus) {
    const contract = identifyContractByRuntimeCode(cu, code);
    if (contract !== undefined) return resolutionOf(contract, cu);
  }
  return undefined;
}

/**
 * Resolve the entry/launch contract: by CBOR against the entry frame's runtime
 * code, else by the launch `contractName` scanned across the loaded CUs.
 */
function resolveEntry(
  inputs: LaunchInputs,
  cus: CompilationUnit[],
  steps: readonly Step[],
  cursor: StateCursor
): StepResolution {
  const entryAddr = inputs.codeAddress.toLowerCase();
  const entryStep = steps.findIndex(
    s => addressHex(s.codeAddress) === entryAddr
  );
  if (entryStep >= 0) {
    const byCbor = identify(cus, cursor.at(entryStep).bytecode);
    if (byCbor !== undefined) return byCbor;
  }
  for (const cu of cus) {
    const contract = cu.contract(inputs.sourcePath, inputs.contractName);
    if (contract !== undefined) return resolutionOf(contract, cu);
  }
  throw new Error(
    `contract not found: ${inputs.sourcePath}:${inputs.contractName}`
  );
}

/**
 * Pick the contract within a single (address-mapped) CU. Prefer the
 * caller-supplied `contractName` (narrowed by `sourcePath`: names are not unique
 * within a build); else the SOLE contract with non-empty runtime bytecode
 * (interfaces/abstracts have empty bytecode → skipped); else CBOR-match the
 * trace's per-step code at `traceIdx` if one is available (kontrol).
 */
function pickContract(
  cu: CompilationUnit,
  contractName: string | undefined,
  cursor: StateCursor,
  traceIdx: number | undefined,
  sourcePath?: string
): Contract | undefined {
  if (contractName !== undefined) {
    const byName = cu
      .contracts()
      .filter(
        c =>
          c.name === contractName &&
          (sourcePath === undefined || c.sourcePath === sourcePath)
      );
    if (byName.length === 1) return byName[0];
    // Ambiguous name (same-named contracts in different files): the running
    // code decides — never an arbitrary first match, whose source map would
    // silently mis-map every step of the frame.
    if (byName.length > 1 && traceIdx !== undefined) {
      const code = cursor.at(traceIdx).bytecode;
      const identified =
        code.length > 2 ? identifyContractByRuntimeCode(cu, code) : undefined;
      if (identified !== undefined && byName.includes(identified)) {
        return identified;
      }
    }
    if (byName.length > 0) return byName[0];
  }
  const deployable = cu.contracts().filter(c => c.runtimeBytecode().length > 2);
  if (deployable.length === 1) return deployable[0];
  if (traceIdx !== undefined) {
    return identifyContractByRuntimeCode(cu, cursor.at(traceIdx).bytecode);
  }
  return undefined;
}
