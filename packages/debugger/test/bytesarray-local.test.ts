/**
 * Regression: a DYNAMIC MEMORY ARRAY OF DYNAMIC BYTES (`bytes[] memory`) must
 * show its element values in the variables view — on BOTH pipelines.
 *
 * `BytesArray.run()`, mirroring uniswap-v4-core `PoolManager.clear.t.sol`'s
 * `bytes[] memory params`:
 *   line 26  bytes[] memory params = new bytes[](2);
 *   line 27  params[0] = abi.encode(uint256(0x1234)); // 32 bytes
 *   line 28  params[1] = hex"deadbeef";               //  4 bytes
 *   line 29  return consume(params, 1);               // params read (last use)
 *
 * Each element of a `bytes[]` is itself a reference type: the array's element
 * slot holds a MEMORY OFFSET to the element's bytes, not a value-type word. The
 * value-type array path could not render these, so `params` showed NO value even
 * while live and in scope. The per-pc analyzer locates the array's stack slot;
 * the element-bytes layout dereferences each element as raw `bytes`. The SAME
 * source is recorded viaIR AND legacy so the rendering is proven on each.
 *
 * Ground truth at line 29:
 *   params[0] = 0x0000…1234 (the 32-byte abi.encode of 0x1234)
 *   params[1] = 0xdeadbeef
 */
import {describe, expect, it} from 'vitest';

import {
  children,
  eachMode,
  launch,
  localVar,
  stepToLine,
  type Spec,
} from './support/harness.js';

const base = (mode: 'viair' | 'legacy'): Spec => ({
  buildInfo:
    mode === 'viair'
      ? 'bytesarray-viair-build-info.json'
      : 'newfixtures-legacy-build-info.json',
  trace: `bytesarray-${mode}-run-trace.raw.json`,
  meta: `bytesarray-${mode}-run-meta.json`,
  sourcePath: 'src/BytesArray.sol',
  contractName: 'BytesArray',
  methodName: 'run',
});

describe('bytes[] memory local located and rendered per-pc (both pipelines)', () => {
  eachMode({viair: base('viair'), legacy: base('legacy')}, (_mode, spec) => {
    it('shows `params` with both element byte-strings at its use (line 29)', async () => {
      const s = await launch(spec);
      stepToLine(s, 29, 20);

      const params = await localVar(s, 'params');
      expect(params).toBeDefined();
      expect(params!.type).toBe('bytes[]');
      expect(params!.variablesReference).toBeGreaterThan(0); // expandable array

      const elements = await children(s, params!.variablesReference);
      expect(elements).toHaveLength(2);
      // Element 0: the 32-byte abi.encode of 0x1234; element 1: 0xdeadbeef.
      expect(elements[0]!.name).toBe('0');
      expect(BigInt(elements[0]!.value)).toBe(0x1234n);
      expect(elements[0]!.value).toBe(
        '0x0000000000000000000000000000000000000000000000000000000000001234',
      );
      expect(elements[1]!.name).toBe('1');
      expect(elements[1]!.value).toBe('0xdeadbeef');
    });
  });
});
