/**
 * Regression: the variables view must show a value-type local declared in an
 * INHERITED (base-contract) function, including a user-defined value type (UDVT)
 * whose only read is a last-use SWAP (move).
 *
 * Real trace of `InheritedUdvt.run()` (viaIR), which mirrors uniswap-v4-core
 * `Deployers.deployMintAndApprove2Currencies` (Currency = `type Currency is
 * address`). `run()` (in the derived `InheritedUdvt`) calls the inherited
 * `TokenBase.setupTokens()`:
 *   line 42  Token _a = mint(0x11);                       → _a
 *   line 43  Token _b = mint(0x22);                       → _b
 *   line 45  (a, b) = order(Token.unwrap(_a), Token.unwrap(_b), 1);
 *
 * Three defects this pins:
 *   1. Inheritance — the function's locals were looked up by name inside the
 *      DERIVED contract, so an inherited function resolved to nothing and the
 *      Locals view was empty. Now the source-map-resolved function node is used.
 *   2. UDVT — a `Token` (= address) local was classified as a reference type and
 *      shown without a value. Now it resolves to its underlying `address`.
 *   3. SWAP anchor — a value local's LAST use is a `SWAPn` (move) not a `DUPn`
 *      (copy); the DUP-only stack-provenance anchor never located it. A
 *      subordinate SWAP anchor now does.
 *
 * Ground truth: mint(0x11) → 0x12, mint(0x22) → 0x23. Stepping into `setupTokens`
 * and over line 42 shows `_a = 0x…12` (type Token); over line 43 shows both
 * `_a = 0x…12` and `_b = 0x…23`.
 */
import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {SolidityDebugSession, type LaunchInputs} from '../src/index.js';

interface DapVariable {
  name: string;
  value: string;
  type?: string;
}

const BUILD_INFO_JSON: unknown = JSON.parse(
  readFileSync(
    new URL(
      '../../solc/test/fixtures/inheritedudvt-viair-build-info.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const TRACE_RAW = readFileSync(
  new URL('./fixtures/inheritedudvt-viair-run-trace.raw.json', import.meta.url),
  'utf8',
);
const META = JSON.parse(
  readFileSync(
    new URL('./fixtures/inheritedudvt-viair-run-meta.json', import.meta.url),
    'utf8',
  ),
) as {contractAddress: string};

function inputs(): LaunchInputs {
  return {
    buildInfoJson: BUILD_INFO_JSON,
    traceJson: TRACE_RAW,
    sourcePath: 'src/InheritedUdvt.sol',
    contractName: 'InheritedUdvt',
    methodName: 'run',
    codeAddress: META.contractAddress,
    dialect: 'kontrol',
  };
}

async function launched(): Promise<SolidityDebugSession> {
  const s = new SolidityDebugSession();
  await s.launch(inputs());
  return s;
}

const line = (s: SolidityDebugSession): number | undefined =>
  s.stackTrace().stackFrames[0]?.line;

async function localsAt(
  s: SolidityDebugSession,
): Promise<Map<string, DapVariable>> {
  const frameId = s.stackTrace().stackFrames[0]!.id;
  const {scopes} = s.scopes(frameId);
  const scope =
    scopes.find((x) => x.name === 'Locals') ??
    scopes.find((x) => x.name === 'Parameters');
  if (scope === undefined) return new Map();
  const {variables} = await s.variables(scope.variablesReference);
  return new Map((variables as DapVariable[]).map((v) => [v.name, v]));
}

describe('inherited + UDVT value-type locals (SWAP-move reads)', () => {
  it('steps into the inherited base-contract function (line 42)', async () => {
    const s = await launched();
    s.stepIn();
    expect(line(s)).toBe(42);
  });

  it('shows the first UDVT local with its address value after line 42', async () => {
    const s = await launched();
    s.stepIn(); // -> line 42 (Token _a = mint(0x11))
    s.next(); //   -> line 43, _a now assigned
    const a = (await localsAt(s)).get('_a');
    expect(a).toBeDefined();
    expect(BigInt(a!.value)).toBe(0x12n); // mint(0x11) => 0x11 + 1
    expect(a!.type).toBe('Token'); // UDVT shown by its alias name
  });

  it('shows both UDVT locals once assigned (line 45)', async () => {
    const s = await launched();
    s.stepIn();
    s.next(); // -> line 43
    s.next(); // -> line 45 (tuple assign)
    const locals = await localsAt(s);
    expect(BigInt(locals.get('_a')!.value)).toBe(0x12n);
    expect(BigInt(locals.get('_b')!.value)).toBe(0x23n); // mint(0x22) => 0x22 + 1
  });
});
