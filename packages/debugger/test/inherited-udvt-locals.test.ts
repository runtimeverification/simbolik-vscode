/**
 * The variables view shows a value-type local declared in an inherited
 * (base-contract) function, including a user-defined value type (UDVT) whose
 * only read is a last-use SWAP (move).
 *
 * Real trace of `InheritedUdvt.run()` (viaIR), modelled on uniswap-v4-core
 * `Deployers.deployMintAndApprove2Currencies` (Currency = `type Currency is
 * address`). `run()` (in the derived `InheritedUdvt`) calls the inherited
 * `TokenBase.setupTokens()`:
 *   line 42  Token _a = mint(0x11);                       → _a
 *   line 43  Token _b = mint(0x22);                       → _b
 *   line 45  (a, b) = order(Token.unwrap(_a), Token.unwrap(_b), 1);
 *
 * What this pins:
 *   1. Inheritance — a function's locals are found via the source-map-resolved
 *      function node, not by name lookup inside the derived contract (which
 *      finds nothing for an inherited function).
 *   2. UDVT — a `Token` (= address) local resolves to its underlying `address`
 *      value type rather than being treated as a reference type without a value.
 *   3. SWAP anchor — a value local's last use is a `SWAPn` (move), not a `DUPn`
 *      (copy), so a DUP-only stack-provenance anchor never locates it; a
 *      subordinate SWAP anchor does.
 *
 * Ground truth: mint(0x11) → 0x12, mint(0x22) → 0x23. Stepping into `setupTokens`
 * and over line 42 shows `_a = 0x…12` (type Token); over line 43 shows both
 * `_a = 0x…12` and `_b = 0x…23`.
 */
import {describe, expect, it} from 'vitest';

import {
  breakAt,
  launch,
  line,
  locals as localsAt,
  type Spec,
} from './support/harness.js';

const spec: Spec = {
  buildInfo: 'inheritedudvt-viair-build-info.json',
  trace: 'inheritedudvt-viair-run-trace.raw.json',
  meta: 'inheritedudvt-viair-run-meta.json',
  sourcePath: 'src/InheritedUdvt.sol',
  contractName: 'InheritedUdvt',
  methodName: 'run',
  dialect: 'kontrol',
};

/** Same source, compiled legacy (no --via-ir). */
const legacySpec: Spec = {
  buildInfo: 'newfixtures-legacy-build-info.json',
  trace: 'inheritedudvt-legacy-run-trace.raw.json',
  meta: 'inheritedudvt-legacy-run-meta.json',
  sourcePath: 'src/InheritedUdvt.sol',
  contractName: 'InheritedUdvt',
  methodName: 'run',
  dialect: 'kontrol',
};

async function launched() {
  return launch(spec);
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

// The inheritance lookup + UDVT->address resolution are codegen-agnostic; prove
// they render the same values on the legacy pipeline. Navigation is via a source
// breakpoint (robust across pipelines), not the viaIR-specific step sequence.
describe('inherited + UDVT value-type locals (legacy)', () => {
  it('shows both UDVT locals with their address values at line 45', async () => {
    const s = await breakAt(legacySpec, 45);
    expect(line(s)).toBe(45);
    const locals = await localsAt(s);
    expect(locals.get('_a'), '_a surfaced on legacy').toBeDefined();
    expect(BigInt(locals.get('_a')!.value)).toBe(0x12n);
    expect(locals.get('_a')!.type).toBe('Token');
    expect(BigInt(locals.get('_b')!.value)).toBe(0x23n);
  });
});
