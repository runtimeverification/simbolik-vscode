/**
 * Last-known-value retention: a value-type local that is still in lexical scope
 * but has no live location (its stack slot was freed/reused after its last use —
 * common under viaIR) is shown with its last known value rather than
 * disappearing.
 *
 * Soundness contract (what this pins):
 *   - the stale value is the one the variable genuinely held — decoded at the most
 *     recent earlier step of the same frame invocation where it was located, never
 *     read from the current (reused) slot; so it equals the value seen while live;
 *   - it is rendered exactly like a live value (no marker, not read-only).
 *
 * Uses the `InheritedUdvt.run()` viaIR trace: `TokenBase.setupTokens` has
 *   line 42  Token _a = mint(0x11);
 *   line 43  Token _b = mint(0x22);
 *   line 45  (a, b) = order(Token.unwrap(_a), Token.unwrap(_b), 1);
 * `_a`/`_b` are consumed by the `order` call on line 45. Stepping into `order` and
 * back out lands on line 45 again, now past their last use — where they are still
 * in scope but their slots are gone. Ground truth: mint(0x11)=0x12, mint(0x22)=0x23.
 */
import {describe, expect, it} from 'vitest';

import type {SolidityDebugSession} from '../src/index.js';
import {launch, line, locals, type Spec} from './support/harness.js';

const spec: Spec = {
  buildInfo: 'inheritedudvt-viair-build-info.json',
  trace: 'inheritedudvt-viair-run-trace.raw.json',
  meta: 'inheritedudvt-viair-run-meta.json',
  sourcePath: 'src/InheritedUdvt.sol',
  contractName: 'InheritedUdvt',
  methodName: 'run',
  dialect: 'kontrol',
};

async function launched(): Promise<SolidityDebugSession> {
  return launch(spec);
}

/** Into `setupTokens`, forward to line 45 with `_a`/`_b` still live. */
function toLiveUse(s: SolidityDebugSession): void {
  s.stepIn(); // -> line 42
  s.next(); //   -> line 43
  s.next(); //   -> line 45 (order(...) call; _a/_b live)
  if (line(s) !== 45) throw new Error(`expected line 45, got ${line(s)}`);
}

describe('last-known value for a freed-but-in-scope local (viaIR)', () => {
  it('shows `_a`/`_b` live at their use', async () => {
    const s = await launched();
    toLiveUse(s);
    const live = await locals(s);
    expect(BigInt(live.get('_a')!.value)).toBe(0x12n);
    expect(BigInt(live.get('_b')!.value)).toBe(0x23n);
  });

  it('shows them after their last use, with the same values, unmarked', async () => {
    const s = await launched();
    toLiveUse(s);
    s.stepIn(); // into order(...)
    s.stepOut(); // back to line 45, past _a/_b's last use
    expect(line(s)).toBe(45);

    const after = await locals(s);
    const a = after.get('_a');
    const b = after.get('_b');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // Rendered like any live value: no marker, no read-only hint.
    expect(a!.value).not.toMatch(/last known/);
    expect(a!.presentationHint).toBeUndefined();
    // Sound: the stale value is the very value held while live (not a reused slot).
    expect(BigInt(a!.value)).toBe(0x12n);
    expect(BigInt(b!.value)).toBe(0x23n);
  });
});
