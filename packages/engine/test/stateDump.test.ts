/**
 * `parseStateDump` — normalize a state-dump result from BOTH wire formats
 * (kontrol-node `kontrol_dumpState` raw JSON; anvil `anvil_dumpState` gzip-hex)
 * into one snapshot.
 *
 * The two formats were captured empirically (2026-09-03) from live nodes:
 *   - kontrol-node: raw JSON object; `nonce` a NUMBER; storage VALUES minimal hex;
 *     storage KEYS full 32-byte hex (mapping slots included).
 *   - anvil 1.7.1: a `0x`-prefixed gzip-compressed hex string of the same JSON;
 *     `nonce` a STRING; storage VALUES 32-byte PADDED hex; KEYS full 32-byte hex.
 * Both must flatten to identical output: lowercase address, MINIMAL-hex storage
 * keys+values, zero slots dropped.
 */
import {gzipSync} from 'node:zlib';

import {describe, expect, it} from 'vitest';

import {parseStateDump} from '../src/stateDump.js';

// A contract address (mixed-case → must be lowercased) and a full 32-byte slot
// key as the nodes emit (here slot 0), plus a keccak-style mapping slot key.
const ADDR = '0xB7A5bd0345EF1Cc5E66bf61BdeC17D2461fBd968';
const SLOT0 =
  '0x0000000000000000000000000000000000000000000000000000000000000000';
const SLOT_MAP =
  '0x6203dd68657862fa26bd7c4a12a3a2b3bbf2220be739d51860c5d12e036c38ec';
const SLOT_ZERO =
  '0x0000000000000000000000000000000000000000000000000000000000000005';

/** The kontrol-node shape: object, numeric nonce, minimal-hex storage values. */
function kontrolDump(): unknown {
  return {
    best_block_number: 3,
    accounts: {
      [ADDR]: {
        balance: '0x0',
        code: '0x6080604052',
        nonce: 1,
        storage: {
          [SLOT0]: '0x2a',
          [SLOT_MAP]: '0xc9f2c9c9a10ab402461600000',
          [SLOT_ZERO]: '0x0', // zero → dropped
        },
      },
      // An EOA: no code, no storage.
      '0x70997970c51812dc3a010c7d01b50e0d17dc79c8': {
        balance: '0x21e19e0c9bab2400000',
        code: '0x',
        nonce: 0,
        storage: {},
      },
    },
  };
}

/** The anvil shape: gzip-hex string, STRING nonce, 32-byte PADDED storage values. */
function anvilDump(): string {
  const pad = (h: string): string =>
    `0x${BigInt(h).toString(16).padStart(64, '0')}`;
  const json = {
    best_block_number: 3,
    accounts: {
      [ADDR]: {
        balance: '0x0',
        code: '0x6080604052',
        nonce: '1',
        storage: {
          [SLOT0]: pad('0x2a'),
          [SLOT_MAP]: pad('0xc9f2c9c9a10ab402461600000'),
          [SLOT_ZERO]: pad('0x0'), // zero → dropped
        },
      },
      '0x70997970c51812dc3a010c7d01b50e0d17dc79c8': {
        balance: '0x21e19e0c9bab2400000',
        code: '0x',
        nonce: '0',
        storage: {},
      },
    },
  };
  return `0x${gzipSync(Buffer.from(JSON.stringify(json), 'utf8')).toString('hex')}`;
}

describe('parseStateDump — kontrol-node raw-JSON format', () => {
  it('normalizes accounts, minimal-hex storage, drops zero slots, lowercases addr', () => {
    const dump = parseStateDump(kontrolDump());
    expect(dump).toBeDefined();
    const acct = dump!.accounts[ADDR.toLowerCase()];
    expect(acct).toBeDefined();
    expect(acct!.code).toBe('0x6080604052');
    expect(acct!.nonce).toBe(1);
    // Storage keys AND values normalized to minimal hex; zero slot omitted.
    expect(acct!.storage).toEqual({
      '0x0': '0x2a',
      [`0x${BigInt(SLOT_MAP).toString(16)}`]: '0xc9f2c9c9a10ab402461600000',
    });
    // The EOA survives with empty storage.
    expect(
      dump!.accounts['0x70997970c51812dc3a010c7d01b50e0d17dc79c8']!.storage,
    ).toEqual({});
  });
});

describe('parseStateDump — anvil gzip-hex format', () => {
  it('gunzips, then normalizes to the SAME output as the kontrol format', () => {
    const fromAnvil = parseStateDump(anvilDump());
    const fromKontrol = parseStateDump(kontrolDump());
    expect(fromAnvil).toEqual(fromKontrol);
  });

  it('coerces a string nonce to a number', () => {
    const dump = parseStateDump(anvilDump());
    expect(dump!.accounts[ADDR.toLowerCase()]!.nonce).toBe(1);
  });
});

describe('parseStateDump — malformed / unsupported input', () => {
  it('returns undefined for a non-dump string (unsupported node / garbage)', () => {
    expect(parseStateDump('not a gzip blob')).toBeUndefined();
    expect(parseStateDump('0xdeadbeef')).toBeUndefined(); // valid hex, not gzip
  });
  it('returns undefined when there is no accounts object', () => {
    expect(parseStateDump({best_block_number: 3})).toBeUndefined();
    expect(parseStateDump(null)).toBeUndefined();
    expect(parseStateDump(42)).toBeUndefined();
  });
  it('tolerates an account missing fields (defaults code/balance/storage)', () => {
    const dump = parseStateDump({accounts: {[ADDR]: {nonce: 2}}});
    const acct = dump!.accounts[ADDR.toLowerCase()]!;
    expect(acct).toEqual({code: '0x', nonce: 2, balance: '0x0', storage: {}});
  });
});
