/**
 * Shared test harness for the debugger suite: fixture loading, session launch
 * and variable inspection, so a test reads as intent, not plumbing.
 *
 * Not a test file (no `*.test.ts` suffix), so vitest's test glob never
 * collects it.
 *
 * Fixture names are never guessed: a {@link Spec} names the build-info, trace
 * and meta files explicitly (e.g. `locals-compute-trace.raw.json` vs
 * `bytesarray-viair-run-trace.raw.json`).
 *
 * {@link eachMode} runs one shared test body against both a viaIR and a legacy
 * fixture pair.
 */
import {readFileSync} from 'node:fs';

import {describe} from 'vitest';

import {parseJsonLossless} from '@simbolik/engine';
import {
  normalizeKontrolTrace,
  StateCursor,
  type Step,
} from '@simbolik/lifting';
import {loadBuildInfo, type CompilationUnit} from '@simbolik/solc';

import {machineStateFor} from '../../src/machineState.js';
import {
  SolidityDebugSession,
  type LaunchInputs,
} from '../../src/index.js';

// ## Fixture readers

/** Raw text of a build-info fixture in `packages/solc/test/fixtures`. */
export function readSolcFixture(name: string): string {
  return readFileSync(
    new URL(`../../../solc/test/fixtures/${name}`, import.meta.url),
    'utf8',
  );
}

/** Raw text of a debugger fixture in `packages/debugger/test/fixtures`. */
export function readDbgFixture(name: string): string {
  return readFileSync(
    new URL(`../fixtures/${name}`, import.meta.url),
    'utf8',
  );
}

/** Parsed build-info JSON (safe: build-infos have no 256-bit decimals). */
export function buildInfoOf(name: string): unknown {
  return JSON.parse(readSolcFixture(name));
}

/** A loaded compilation unit from a build-info fixture name. */
export function loadCu(buildInfoName: string): CompilationUnit {
  return loadBuildInfo(buildInfoOf(buildInfoName));
}

/**
 * Normalized steps from a raw kontrol `debug_traceTransaction` fixture. Parsed
 * losslessly — kontrol emits 256-bit values as decimals that plain `JSON.parse`
 * would corrupt.
 */
export function loadSteps(traceName: string): Step[] {
  const parsed = parseJsonLossless(readDbgFixture(traceName)) as {
    result: unknown;
  };
  return normalizeKontrolTrace(parsed.result as never);
}

/** A `StateCursor` over a raw trace fixture (plus the steps it folds). */
export function cursorFor(traceName: string): {steps: Step[]; cursor: StateCursor} {
  const steps = loadSteps(traceName);
  return {steps, cursor: new StateCursor(steps)};
}

/** The `contractAddress` recorded in a `*-meta.json` fixture. */
export function metaOf(name: string): {contractAddress: string} & Record<string, unknown> {
  return JSON.parse(readDbgFixture(name)) as {contractAddress: string} & Record<
    string,
    unknown
  >;
}

/** Lowercase, 20-byte zero-padded — matches how accounts are keyed in a trace. */
export function normAddr(a: string): string {
  return '0x' + BigInt(a).toString(16).padStart(40, '0');
}

/**
 * The ethdebug `Machine.State` at the first own-contract (non-init) step whose pc
 * is `pc`. Used by the raw `@ethdebug/pointers` dereference tests.
 */
export function machineStateAtPc(
  traceName: string,
  metaName: string,
  pc: number,
): import('@ethdebug/pointers').Machine.State {
  const {steps, cursor} = cursorFor(traceName);
  const addr = normAddr(metaOf(metaName).contractAddress);
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    if (s.isInitCode || s.codeAddress !== BigInt(addr)) continue;
    if (s.pc === pc) return machineStateFor(cursor.at(i), addr);
  }
  throw new Error(`no own-contract step at pc ${pc} in ${traceName}`);
}

// ## Launch

/** A fixture bundle + entry coordinates: everything a launch needs. */
export interface Spec {
  /** Build-info fixture name, e.g. `'locals-build-info.json'`. */
  buildInfo: string;
  /** Raw trace fixture name, e.g. `'locals-compute-trace.raw.json'`. */
  trace: string;
  /** Meta fixture name, e.g. `'locals-compute-meta.json'`. */
  meta: string;
  /** Source path within the build-info, e.g. `'src/Locals.sol'`. */
  sourcePath: string;
  /** Contract name, e.g. `'Locals'`. */
  contractName: string;
  /** The invoked method, e.g. `'compute'`. */
  methodName: string;
  /** Trace dialect; defaults to `'kontrol'`. */
  dialect?: 'kontrol' | 'geth';
  /** Optional pass-throughs for multi-frame / geth launches. */
  txContext?: LaunchInputs['txContext'];
  contractsByAddress?: LaunchInputs['contractsByAddress'];
  initialStorage?: LaunchInputs['initialStorage'];
  buildInfos?: LaunchInputs['buildInfos'];
}

/** Build `LaunchInputs` from a {@link Spec} (raw trace text; codeAddress from meta). */
export function toLaunchInputs(spec: Spec): LaunchInputs {
  return {
    buildInfoJson: buildInfoOf(spec.buildInfo),
    traceJson: readDbgFixture(spec.trace),
    sourcePath: spec.sourcePath,
    contractName: spec.contractName,
    methodName: spec.methodName,
    codeAddress: metaOf(spec.meta).contractAddress,
    dialect: spec.dialect ?? 'kontrol',
    ...(spec.txContext !== undefined ? {txContext: spec.txContext} : {}),
    ...(spec.contractsByAddress !== undefined
      ? {contractsByAddress: spec.contractsByAddress}
      : {}),
    ...(spec.initialStorage !== undefined
      ? {initialStorage: spec.initialStorage}
      : {}),
    ...(spec.buildInfos !== undefined ? {buildInfos: spec.buildInfos} : {}),
  };
}

/** A launched session paused at entry. */
export async function launch(spec: Spec): Promise<SolidityDebugSession> {
  const session = new SolidityDebugSession();
  await session.launch(toLaunchInputs(spec));
  return session;
}

/** Launch, set a line breakpoint, and `continue` to it. */
export async function breakAt(
  spec: Spec,
  line: number,
): Promise<SolidityDebugSession> {
  const session = await launch(spec);
  session.setBreakpoints({
    source: {path: spec.sourcePath},
    breakpoints: [{line}],
  });
  session.continue();
  return session;
}

// ## Navigation

/** The current top frame's 1-based line (undefined at the terminal step). */
export function line(session: SolidityDebugSession): number | undefined {
  return session.stackTrace().stackFrames[0]?.line;
}

/** The current top frame's id. */
export function topFrameId(session: SolidityDebugSession): number {
  return session.stackTrace().stackFrames[0]!.id;
}

/** Step over until stopped on `targetLine`, or throw after `max` steps. */
export function stepToLine(
  session: SolidityDebugSession,
  targetLine: number,
  max = 8,
): void {
  for (let k = 0; k < max && line(session) !== targetLine; k++) session.next();
  if (line(session) !== targetLine) {
    throw new Error(
      `never reached line ${targetLine} (stopped at ${line(session)})`,
    );
  }
}

// ## Variable inspection

/** A DAP variable as the session emits it. */
export interface DapVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
  presentationHint?: {attributes?: string[]};
}

/**
 * The `variablesReference` of a named scope on a frame (default: the top frame).
 * Throws if the scope is absent.
 */
export function scopeRef(
  session: SolidityDebugSession,
  scopeName: string,
  frameId: number = topFrameId(session),
): number {
  const scope = session
    .scopes(frameId)
    .scopes.find((s) => s.name === scopeName);
  if (scope === undefined) throw new Error(`no ${scopeName} scope`);
  return scope.variablesReference;
}

/** The children of a `variablesReference` handle. */
export async function children(
  session: SolidityDebugSession,
  ref: number,
): Promise<DapVariable[]> {
  const {variables} = await session.variables(ref);
  return variables as DapVariable[];
}

/** The variables in a named scope on the top frame, as an array. */
export async function scopeVars(
  session: SolidityDebugSession,
  scopeName: string,
): Promise<DapVariable[]> {
  return children(session, scopeRef(session, scopeName));
}

/** The top frame's `Locals` variables, keyed by name. */
export async function locals(
  session: SolidityDebugSession,
): Promise<Map<string, DapVariable>> {
  const vars = await scopeVars(session, 'Locals');
  return new Map(vars.map((v) => [v.name, v]));
}

/** A single named local on the top frame, or undefined. */
export async function localVar(
  session: SolidityDebugSession,
  name: string,
): Promise<DapVariable | undefined> {
  return (await locals(session)).get(name);
}

/** The top frame's `State` variables, keyed by name. */
export async function stateVars(
  session: SolidityDebugSession,
): Promise<Map<string, DapVariable>> {
  const vars = await scopeVars(session, 'State');
  return new Map(vars.map((v) => [v.name, v]));
}

// ## Pipeline-mode matrix

/** A compilation pipeline. */
export type Mode = 'viair' | 'legacy';

/**
 * Run a shared test body once per provided pipeline mode, each inside its own
 * `describe(mode)`. Give only the modes a fixture exists for — a scenario that is
 * intentionally single-mode (e.g. a viaIR-specific setup artifact) passes one.
 *
 *   eachMode({viair: viairSpec, legacy: legacySpec}, (mode, spec) => {
 *     it('renders the local', async () => { ... });
 *   });
 */
export function eachMode(
  specs: Partial<Record<Mode, Spec>>,
  body: (mode: Mode, spec: Spec) => void,
): void {
  for (const mode of Object.keys(specs) as Mode[]) {
    const spec = specs[mode];
    if (spec === undefined) continue;
    describe(mode, () => body(mode, spec));
  }
}
