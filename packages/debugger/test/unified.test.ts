/**
 * Session-level FORCING test for the unified param/local read path.
 *
 * The Locals scope (params + locals) is routed through `variablesAt` +
 * `readPointerValue`/`machineStateFor` rather than ad-hoc layout math. This test
 * pins the end-to-end guarantee: `Vars.setAll`'s `_b` parameter reads as 1000
 * through the session's `Locals` scope.
 *
 * Why `_b` specifically: 1000 lives on the stack as the ODD-LENGTH minimal-hex
 * word `0x3e8` — the exact value that the `machineStateFor` fix (pad to a full
 * 32-byte word before `Data.fromHex`, honor the slice) makes decode correctly.
 * Because Locals routes through `variablesAt` + the real dereference, this
 * assertion exercises that stack path end-to-end.
 *
 * This is the GUARD that the Locals scope keeps `_b` correct when reading through
 * the real dereference stack path.
 */
import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {SolidityDebugSession} from '../src/index.js';

interface DapVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference?: number;
}

function readTrace(name: string): string {
  return readFileSync(
    new URL(`./fixtures/${name}`, import.meta.url),
    'utf8',
  );
}

function readBuildInfo(name: string): unknown {
  return JSON.parse(
    readFileSync(
      new URL(`../../solc/test/fixtures/${name}`, import.meta.url),
      'utf8',
    ),
  );
}

function readAddress(metaName: string): string {
  const meta = JSON.parse(
    readFileSync(new URL(`./fixtures/${metaName}`, import.meta.url), 'utf8'),
  ) as {contractAddress: string};
  return meta.contractAddress;
}

describe('unified path — Vars.setAll _b reads 1000 through the Locals scope', () => {
  it('exposes _b = 1000 (uint16) via scopes → Locals → variables', async () => {
    const session = new SolidityDebugSession();
    await session.launch({
      buildInfoJson: readBuildInfo('vars-build-info.json'),
      traceJson: readTrace('vars-setall-trace.raw.json'),
      sourcePath: 'src/Vars.sol',
      contractName: 'Vars',
      methodName: 'setAll',
      codeAddress: readAddress('vars-setall-meta.json'),
    });

    // Navigate the DAP surface the same way a client would: top frame →
    // scopes → the Locals scope's variablesReference → variables.
    const frameId = session.stackTrace().stackFrames[0]!.id;
    const {scopes} = session.scopes(frameId);
    const locals = scopes.find((s) => s.name === 'Locals');
    expect(locals, 'a Locals scope must be exposed').toBeDefined();

    const {variables} = await session.variables(locals!.variablesReference);
    const _b = (variables as DapVariable[]).find((v) => v.name === '_b');
    expect(_b).toBeDefined();
    // 1000 is the odd-length stack word 0x3e8 — the Part A discriminator.
    expect(_b!.value).toBe('1000');
    expect(_b!.type).toBe('uint16');
  });
});
