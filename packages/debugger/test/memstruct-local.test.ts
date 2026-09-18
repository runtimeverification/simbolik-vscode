/**
 * Regression: a MEMORY STRUCT local must show its field values under viaIR.
 *
 * Real trace of `MemStruct.run()` (viaIR), mirroring uniswap-v4-core
 * `Deployers.seedMoreLiquidity`'s `ModifyLiquidityParams memory params`:
 *   line 30  LiqParams memory params = LiqParams({ ... });
 *   line 37  return consume(params, 1);   // params read (last use)
 *
 * A memory struct local holds its memory offset in a stack slot; the debugger
 * reads the fields from memory through that slot. Under viaIR the slot is
 * scheduled per-instruction, so the legacy frame-relative slot model could not
 * find it and `params` showed NO value even while live and in scope. The per-pc
 * stack-provenance analyzer (already used for value types) now locates the
 * reference's stack slot too, so the struct's members decode.
 *
 * Ground truth: params = {tickLower:-120, tickUpper:120, liquidityDelta:1000,
 * salt:0x…07}. Stepping into `run` and over the constructor lands on line 37 with
 * `params` expandable to those four members.
 */
import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {SolidityDebugSession, type LaunchInputs} from '../src/index.js';

interface DapVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference?: number;
}

const BUILD_INFO_JSON: unknown = JSON.parse(
  readFileSync(
    new URL(
      '../../solc/test/fixtures/memstruct-viair-build-info.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const TRACE_RAW = readFileSync(
  new URL('./fixtures/memstruct-viair-run-trace.raw.json', import.meta.url),
  'utf8',
);
const META = JSON.parse(
  readFileSync(
    new URL('./fixtures/memstruct-viair-run-meta.json', import.meta.url),
    'utf8',
  ),
) as {contractAddress: string};

async function launched(): Promise<SolidityDebugSession> {
  const s = new SolidityDebugSession();
  const inputs: LaunchInputs = {
    buildInfoJson: BUILD_INFO_JSON,
    traceJson: TRACE_RAW,
    sourcePath: 'src/MemStruct.sol',
    contractName: 'MemStruct',
    methodName: 'run',
    codeAddress: META.contractAddress,
    dialect: 'kontrol',
  };
  await s.launch(inputs);
  return s;
}

const line = (s: SolidityDebugSession): number | undefined =>
  s.stackTrace().stackFrames[0]?.line;

/** Step forward (over) until stopped on `targetLine`, or throw. */
function stepToLine(s: SolidityDebugSession, targetLine: number): void {
  for (let k = 0; k < 8 && line(s) !== targetLine; k++) s.next();
  if (line(s) !== targetLine) {
    throw new Error(`never reached line ${targetLine} (at ${line(s)})`);
  }
}

async function localVar(
  s: SolidityDebugSession,
  name: string,
): Promise<DapVariable | undefined> {
  const frameId = s.stackTrace().stackFrames[0]!.id;
  const {scopes} = s.scopes(frameId);
  const scope = scopes.find((x) => x.name === 'Locals');
  if (scope === undefined) return undefined;
  const {variables} = await s.variables(scope.variablesReference);
  return (variables as DapVariable[]).find((v) => v.name === name);
}

describe('memory struct local located per-pc (viaIR)', () => {
  it('shows `params` with its four member values at its use (line 37)', async () => {
    const s = await launched();
    stepToLine(s, 37);
    const params = await localVar(s, 'params');
    expect(params).toBeDefined();
    expect(params!.variablesReference).toBeGreaterThan(0); // expandable struct

    const {variables} = await s.variables(params!.variablesReference!);
    const members = new Map(
      (variables as DapVariable[]).map((m) => [m.name, m.value]),
    );
    expect(BigInt(members.get('tickLower')!)).toBe(-120n);
    expect(BigInt(members.get('tickUpper')!)).toBe(120n);
    expect(BigInt(members.get('liquidityDelta')!)).toBe(1000n);
    expect(BigInt(members.get('salt')!)).toBe(7n);
  });
});
