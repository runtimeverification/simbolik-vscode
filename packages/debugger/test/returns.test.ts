/**
 * Return parameters surface through the debugger's real dereference path, for
 * external and internal functions.
 *
 * `Returns.calc(5)` returns two named values, `(uint256 doubled, uint256 tripled)`,
 * and calls the internal `helper(uint256 y) returns (uint256 out)` with a body
 * local `local`. solc lays a frame out as [ params ][ return params ][ locals ];
 * `variablesAt` emits the return params (kind 'return') and the session's
 * Locals scope admits that kind, so they flow through `machineStateFor` +
 * `readPointerValue` like any other stack variable.
 *
 * Ground truth (recorded kontrol trace):
 *   calc @ line 11: x=5, doubled=10, tripled=17, tmp=12.
 *   helper (internal) @ line 17: y=5, out=12, local=6.
 *
 * These pin the return-param handling: at line 11 the Locals scope shows
 * doubled/tripled alongside x & tmp; at line 17 `local` reads 6 (not the reserved
 * return slot's 12) and `out` is present.
 */
import {describe, expect, it} from 'vitest';

import {type SolidityDebugSession} from '../src/index.js';
import {
  breakAt as breakAtSpec,
  scopeVars,
  type DapVariable,
  type Spec,
} from './support/harness.js';

const spec: Spec = {
  buildInfo: 'returns-build-info.json',
  trace: 'returns-calc-trace.raw.json',
  meta: 'returns-calc-meta.json',
  sourcePath: 'src/Returns.sol',
  contractName: 'Returns',
  methodName: 'calc',
  dialect: 'kontrol',
};

/** Read the current frame's parameter/locals scope (accepts either label). */
async function varsAt(session: SolidityDebugSession): Promise<Map<string, DapVariable>> {
  const frameId = session.stackTrace().stackFrames[0]!.id;
  const {scopes} = session.scopes(frameId);
  const scopeName =
    scopes.find((s) => s.name === 'Parameters')?.name ??
    scopes.find((s) => s.name === 'Locals')?.name;
  if (scopeName === undefined) throw new Error('no parameter/locals scope');
  const variables = await scopeVars(session, scopeName);
  return new Map(variables.map((v) => [v.name, v]));
}

const breakAt = (line: number) => breakAtSpec(spec, line);

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

  it('helper (internal) @ line 17: out=12 (return) and local=6 both correct', async () => {
    // Through the session's real path, `out` must appear (12) and `local` must
    // read its own slot (6), not the reserved return slot (which holds 12).
    const session = await breakAt(17);
    expect(session.stackTrace().stackFrames[0]!.line).toBe(17);
    expect(session.stackTrace().stackFrames[0]!.name).toBe('helper');
    const v = await varsAt(session);

    expect(v.get('y')).toMatchObject({value: '5', type: 'uint256'});
    expect(v.get('out')).toMatchObject({value: '12', type: 'uint256'});
    expect(v.get('local')).toMatchObject({value: '6', type: 'uint256'});
  });
});
