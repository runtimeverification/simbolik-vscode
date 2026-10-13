import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import type {Hex} from '@simbolik/protocol';
import {
  cborMetadataHash,
  identifyContractByRuntimeCode,
  loadBuildInfo,
} from '../src/index.js';

function loadFixture(name: string): unknown {
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as unknown;
}

// The solc-appended CBOR trailer for this exact compilation: the last 2 bytes
// (0x0033 = 51) give the CBOR blob length, so the trailer is the final 53 bytes.
const EXPECTED_TRAILER =
  '0xa26469706673582212203fec369704df27b4fe6afd7044d79186211b564bb62fca8ca04999fcc96615b764736f6c63430008230033';

const cu = () => loadBuildInfo(loadFixture('counter-build-info.json'));
const counter = () => cu().contract('src/Counter.sol', 'Counter')!;

describe('cborMetadataHash', () => {
  it('extracts the defined CBOR metadata trailer from the runtime bytecode', () => {
    const hash = cborMetadataHash(counter().runtimeBytecode());
    expect(hash).toBeDefined();
    expect(hash).toBe(EXPECTED_TRAILER);
  });

  it('returns undefined when the code is too short to carry a metadata trailer', () => {
    // Last two bytes 0x6001 claim a 24577-byte blob that does not exist.
    expect(cborMetadataHash('0x6001' as Hex)).toBeUndefined();
  });
});

describe('identifyContractByRuntimeCode', () => {
  it('identifies the Counter contract from its own runtime code', () => {
    const match = identifyContractByRuntimeCode(cu(), counter().runtimeBytecode());
    expect(match).toBeDefined();
    expect(match!.name).toBe('Counter');
    expect(match!.sourcePath).toBe('src/Counter.sol');
  });

  it('returns undefined for clearly-unrelated runtime code', () => {
    expect(identifyContractByRuntimeCode(cu(), '0x6001' as Hex)).toBeUndefined();
  });

  // With `bytecode_hash = "none"` solc's CBOR trailer degrades to
  // `{solc: <version>}`, identical across every contract that compiler
  // produced, so matching the first contract with that trailer would pick an
  // arbitrary one (and with it the wrong source map). Here Foo and Bar share a
  // trailer (0xaa0001) but have distinct code.
  const sharedTrailerCU = () =>
    loadBuildInfo({
      output: {
        contracts: {
          'A.sol': {
            Foo: {evm: {deployedBytecode: {object: '1122aa0001'}}},
            Bar: {evm: {deployedBytecode: {object: '3344aa0001'}}},
            FooClone: {evm: {deployedBytecode: {object: '1122aa0001'}}},
          },
        },
      },
    });

  it('shared non-discriminating trailer: identifies by exact code, not the first match', () => {
    const cu2 = sharedTrailerCU();
    // Sanity: the two distinct contracts really do share a CBOR trailer.
    expect(cborMetadataHash('0x1122aa0001' as Hex)).toBe('0xaa0001');
    expect(cborMetadataHash('0x3344aa0001' as Hex)).toBe('0xaa0001');

    // Bar must resolve to Bar, not to Foo (the first contract sharing the trailer).
    const bar = identifyContractByRuntimeCode(cu2, '0x3344aa0001' as Hex);
    expect(bar?.name).toBe('Bar');
  });

  it('shared trailer and identical code is ambiguous → undefined (never a guess)', () => {
    // Foo and FooClone have identical runtime code, so an exact match is not
    // unique and the shared trailer matches all three — refuse to guess.
    const cu2 = sharedTrailerCU();
    expect(identifyContractByRuntimeCode(cu2, '0x1122aa0001' as Hex)).toBeUndefined();
  });

  // A deployed contract with immutables differs from its build-info runtime code
  // only in the immutable byte ranges (filled at deploy time), so an exact match
  // fails. With a non-discriminating CBOR trailer (bytecode_hash="none") the only
  // way to still identify it is to mask those ranges.
  // (Bytes: object 'aabb00000000cc', immutable = bytes 2..6.)
  const immutableCU = () =>
    loadBuildInfo({
      output: {
        contracts: {
          'A.sol': {
            PM: {
              evm: {
                deployedBytecode: {
                  object: 'aabb00000000cc',
                  immutableReferences: {'1': [{start: 2, length: 4}]},
                },
              },
            },
            Other: {evm: {deployedBytecode: {object: 'ffbb99999999cc'}}},
          },
        },
      },
    });

  it('identifies a deployed contract with filled immutables by masking them', () => {
    // Deployed PM has its immutable bytes filled (deadbeef) — exact match fails,
    // masked match succeeds; Other (no immutables, different bytes) must not match.
    const match = identifyContractByRuntimeCode(immutableCU(), '0xaabbdeadbeefcc' as Hex);
    expect(match?.name).toBe('PM');
  });

  it('does not mask-match when bytes outside the immutable range differ', () => {
    // Byte 0 differs (99 vs aa) — outside the immutable range — so no match.
    expect(identifyContractByRuntimeCode(immutableCU(), '0x99bbdeadbeefcc' as Hex)).toBeUndefined();
  });
});
