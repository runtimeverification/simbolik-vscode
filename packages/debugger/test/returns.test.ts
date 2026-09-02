/**
 * Return parameters surface through the debugger's real dereference path, for
 * external AND internal functions.
 *
 * `Returns.calc(5)` returns two NAMED values, `(uint256 doubled, uint256 tripled)`,
 * and calls the INTERNAL `helper(uint256 y) returns (uint256 out)` with a body
 * local `local`. solc lays a frame out as [ params ][ return params ][ locals ];
 * once `variablesAt` emits the return params (kind 'return') and the session's
 * Locals scope admits that kind, they flow through `machineStateFor` +
 * `readPointerValue` like any other stack variable.
 *
 * Ground truth (recorded kontrol trace, established with the ethdebug-gen oracle):
 *   calc @ line 11: x=5, doubled=10, tripled=17, tmp=12.
 *   helper (internal) @ line 17: y=5, out=12, local=6.
 *
 * These pin the return-param handling: at line 11 the Locals scope shows
 * doubled/tripled alongside x & tmp; at line 17 `local` reads 6 (not the reserved
 * return slot's 12) and `out` is present — guarding the internal-return-slot bug.
 */
import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {SolidityDebugSession, type LaunchInputs} from '../src/index.js';

function readTrace(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}
function readBuildInfo(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../solc/test/fixtures/${name}`, import.meta.url), 'utf8'),
  );
}
function readAddress(metaName: string): string {
  const meta = JSON.parse(
    readFileSync(new URL(`./fixtures/${metaName}`, import.meta.url), 'utf8'),
  ) as {contractAddress: string};
  return meta.contractAddress;
}

interface DapVariable {
  name: string;
  value: string;
  type?: string;
}

function returnsInputs(): LaunchInputs {
  return {
    buildInfoJson: readBuildInfo('returns-build-info.json'),
    traceJson: readTrace('returns-calc-trace.raw.json'),
    sourcePath: 'src/Returns.sol',
    contractName: 'Returns',
    methodName: 'calc',
    dialect: 'kontrol',
    codeAddress: readAddress('returns-calc-meta.json'),
  };
}

function scopeRef(session: SolidityDebugSession): number {
  const frameId = session.stackTrace().stackFrames[0]!.id;
  const {scopes} = session.scopes(frameId);
  const scope =
    scopes.find((s) => s.name === 'Parameters') ??
    scopes.find((s) => s.name === 'Locals');
  if (scope === undefined) throw new Error('no parameter/locals scope');
  return scope.variablesReference;
}

async function varsAt(session: SolidityDebugSession): Promise<Map<string, DapVariable>> {
  const {variables} = await session.variables(scopeRef(session));
  return new Map((variables as DapVariable[]).map((v) => [v.name, v]));
}

async function breakAt(line: number): Promise<SolidityDebugSession> {
  const session = new SolidityDebugSession();
  await session.launch(returnsInputs());
  session.setBreakpoints({
    source: {path: 'src/Returns.sol'},
    breakpoints: [{line}],
  });
  session.continue();
  return session;
}

describe('Returns — named return params surface in the Locals scope', () => {
  it('calc @ line 11: doubled=10 and tripled=17 alongside x=5 and tmp=12', async () => {
    const session = await breakAt(11);
    expect(session.stackTrace().stackFrames[0]!.line).toBe(11);
    const v = await varsAt(session);

    expect(v.get('doubled')).toMatchObject({value: '10', type: 'uint256'});
    expect(v.get('tripled')).toMatchObject({value: '17', type: 'uint256'});
    expect(v.get('x')).toMatchObject({value: '5', type: 'uint256'});
    expect(v.get('tmp')).toMatchObject({value: '12', type: 'uint256'});
  });

  it('helper (INTERNAL) @ line 17: out=12 (return) and local=6 both correct', async () => {
    // The internal-return-slot discriminator through the session's real path:
    // `out` must appear (12) and `local` must read its own slot (6), NOT the
    // reserved return slot (which held 12 before the fix).
    const session = await breakAt(17);
    expect(session.stackTrace().stackFrames[0]!.line).toBe(17);
    expect(session.stackTrace().stackFrames[0]!.name).toBe('helper');
    const v = await varsAt(session);

    expect(v.get('y')).toMatchObject({value: '5', type: 'uint256'});
    expect(v.get('out')).toMatchObject({value: '12', type: 'uint256'});
    expect(v.get('local')).toMatchObject({value: '6', type: 'uint256'});
  });
});
