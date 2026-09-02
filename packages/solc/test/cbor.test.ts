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
});
