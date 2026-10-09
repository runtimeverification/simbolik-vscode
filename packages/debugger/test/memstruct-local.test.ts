/**
 * A memory struct local shows its field values under viaIR.
 *
 * Real trace of `MemStruct.run()` (viaIR), modelled on uniswap-v4-core
 * `Deployers.seedMoreLiquidity`'s `ModifyLiquidityParams memory params`:
 *   line 30  LiqParams memory params = LiqParams({ ... });
 *   line 37  return consume(params, 1);   // params read (last use)
 *
 * A memory struct local holds its memory offset in a stack slot; the debugger
 * reads the fields from memory through that slot. Under viaIR the slot is
 * scheduled per-instruction, so the legacy frame-relative slot model cannot find
 * it; the per-pc stack-provenance analyzer (also used for value types) locates
 * the reference's stack slot, so the struct's members decode.
 *
 * Ground truth: params = {tickLower:-120, tickUpper:120, liquidityDelta:1000,
 * salt:0x…07}. Stepping into `run` and over the constructor lands on line 37 with
 * `params` expandable to those four members.
 */
import {describe, expect, it} from 'vitest';

import {
  children,
  launch,
  localVar,
  stepToLine,
  type Spec,
} from './support/harness.js';

const spec: Spec = {
  buildInfo: 'memstruct-viair-build-info.json',
  trace: 'memstruct-viair-run-trace.raw.json',
  meta: 'memstruct-viair-run-meta.json',
  sourcePath: 'src/MemStruct.sol',
  contractName: 'MemStruct',
  methodName: 'run',
  dialect: 'kontrol',
};

describe('memory struct local located per-pc (viaIR)', () => {
  it('shows `params` with its four member values at its use (line 37)', async () => {
    const s = await launch(spec);
    stepToLine(s, 37);
    const params = await localVar(s, 'params');
    expect(params).toBeDefined();
    expect(params!.variablesReference).toBeGreaterThan(0); // expandable struct

    const members = new Map(
      (await children(s, params!.variablesReference)).map((m) => [
        m.name,
        m.value,
      ]),
    );
    expect(BigInt(members.get('tickLower')!)).toBe(-120n);
    expect(BigInt(members.get('tickUpper')!)).toBe(120n);
    expect(BigInt(members.get('liquidityDelta')!)).toBe(1000n);
    expect(BigInt(members.get('salt')!)).toBe(7n);
  });
});
