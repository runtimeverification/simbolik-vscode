import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {parseJsonLossless} from '../src/lossless.js';

const fixture = readFileSync(
  new URL(
    './fixtures/debug_traceTransaction_0.expected.json',
    import.meta.url,
  ),
  'utf8',
);

// The real 160-bit deploy address from the recorded Counter trace.
const EXPECTED_CODE_ADDRESS =
  546584486846459126461364135121053344201067465379n;

describe('parseJsonLossless', () => {
  it('preserves kontrol-node 160-bit decimal addresses as exact bigint', () => {
    // Fixture is a JSON-RPC batch: [ {result: txHash}, {result: traceEnvelope} ].
    const batch = parseJsonLossless(fixture) as Array<{
      result: {structLogs: Array<{codeAddress: unknown}>};
    }>;
    const codeAddress = batch[1].result.structLogs[0].codeAddress;

    expect(typeof codeAddress).toBe('bigint');
    expect(codeAddress).toBe(EXPECTED_CODE_ADDRESS);
  });

  it('demonstrates that plain JSON.parse corrupts the same value', () => {
    const naive = JSON.parse(fixture) as Array<{
      result: {structLogs: Array<{codeAddress: number}>};
    }>;
    const naiveValue = naive[1].result.structLogs[0].codeAddress;

    expect(typeof naiveValue).toBe('number');
    // Round-tripping the corrupted float back to bigint does NOT match.
    expect(BigInt(naiveValue)).not.toBe(EXPECTED_CODE_ADDRESS);
  });

  it('keeps small integers as regular numbers', () => {
    const batch = parseJsonLossless(fixture) as Array<{
      result: {structLogs: Array<{pc: unknown; depth: unknown}>};
    }>;
    const step0 = batch[1].result.structLogs[0];
    expect(typeof step0.pc).toBe('number');
    expect(typeof step0.depth).toBe('number');
  });
});
