import {readFileSync} from 'node:fs';

import {parseJsonLossless} from '@simbolik/engine';
import type {Hex, KontrolTrace} from '@simbolik/protocol';
import {describe, expect, it} from 'vitest';

import {
  normalizeKontrolTrace,
  StateCursor,
  type Step,
} from '../src/index.js';

const fixture = readFileSync(
  new URL(
    '../../engine/test/fixtures/debug_traceTransaction_0.expected.json',
    import.meta.url,
  ),
  'utf8',
);
const batch = parseJsonLossless(fixture) as [unknown, {result: KontrolTrace}];
const trace = batch[1].result;

const DEPLOY_ADDR = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
const SENDER_ADDR = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';

// ## StateCursor over the recorded fixture: length, carry-forward blobs, account
// seeding, terminality, and range checking.
describe('StateCursor (real fixture)', () => {
  const steps = normalizeKontrolTrace(trace);

  it('exposes a length equal to the number of steps', () => {
    const cursor = new StateCursor(steps);
    expect(cursor.length).toBe(17);
  });

  it('reconstructs step-0 scalars, blobs and accounts', () => {
    const cursor = new StateCursor(steps);
    const s = cursor.at(0);

    expect(s.index).toBe(0);
    expect(s.pc).toBe(0);
    expect(s.op).toBe('PUSH1');
    expect(s.depth).toBe(1);
    expect(s.gas).toBe(29942777);
    expect(s.stack).toEqual([]);

    // Blobs at step 0.
    expect(s.memory).toEqual([]); // memoryChange was []
    expect(s.bytecode).toMatch(/^0x6080604052/);
    expect(s.bytecode).toHaveLength(556);
    expect(s.calldata).toBe('0x');
    expect(s.returnData).toBe('0x');

    // Accounts seeded from step-0 balance / nonce / initCode deltas.
    expect(s.accounts).toBeInstanceOf(Map);
    expect(new Set(s.accounts.keys())).toEqual(
      new Set([DEPLOY_ADDR, SENDER_ADDR]),
    );

    const deploy = s.accounts.get(DEPLOY_ADDR);
    expect(deploy?.balance).toBe('0x0');
    expect(deploy?.nonce).toBe('0x1');
    expect(deploy?.initCode).toBe(s.bytecode); // init code === executing program
    expect(deploy?.storage).toEqual({}); // no SSTOREs in this trace

    const sender = s.accounts.get(SENDER_ADDR);
    expect(sender?.balance).toBe('0x21ad935f971201a2000');
    expect(sender?.nonce).toBe('0x1');
    expect(sender?.storage).toEqual({});

    expect(s.isTerminal).toBe(false);
  });

  it('carries memory forward when memoryChange is null (step 1 === step 0)', () => {
    const cursor = new StateCursor(steps);
    const m0 = cursor.at(0).memory;
    const m1 = cursor.at(1).memory;
    // step 1 has memoryChange === null, so memory must equal step 0's.
    expect(m1).toEqual(m0);
    expect(m1).toEqual([]);

    // bytecode also carries forward (programChange null after step 0).
    expect(cursor.at(1).bytecode).toBe(cursor.at(0).bytecode);
  });

  it('adopts a fresh memory image only when memoryChange is non-null', () => {
    const cursor = new StateCursor(steps);
    // steps 0..2 keep empty memory; step 3 is the first MSTORE result (3 words).
    expect(cursor.at(2).memory).toEqual([]);
    expect(cursor.at(3).memory).toHaveLength(3);
    // ...and the last memory image seen (step 15) has 8 words.
    expect(cursor.at(16).memory).toHaveLength(8);
  });

  it('never accumulates storage or deployed code for this fixture', () => {
    const cursor = new StateCursor(steps);
    const last = cursor.at(cursor.length - 1);
    // The trace writes no slots, so the accumulated storage map is empty and no
    // runtime code is set.
    for (const account of last.accounts.values()) {
      expect(account.storage).toEqual({});
      expect(account.code).toBeUndefined();
    }
  });

  it('flags only the last index as terminal', () => {
    const cursor = new StateCursor(steps);
    expect(cursor.at(0).isTerminal).toBe(false);
    expect(cursor.at(15).isTerminal).toBe(false);
    expect(cursor.at(16).isTerminal).toBe(true);
  });

  it('throws RangeError for out-of-range indices', () => {
    const cursor = new StateCursor(steps);
    expect(() => cursor.at(17)).toThrow(RangeError);
    expect(() => cursor.at(-1)).toThrow(RangeError);
    expect(() => cursor.at(100)).toThrow(RangeError);
  });
});

// ## Synthetic Step[] to pin the fine-grained accumulation semantics that the
// recorded fixture never exercises: per-slot storage merge, balance/nonce/code/
// initCode replacement, blob carry-forward, and default blob values.
function makeStep(index: number, over: Partial<Step> = {}): Step {
  return {
    index,
    pc: 0,
    op: 'STOP',
    depth: 1,
    gas: 0,
    isInitCode: false,
    codeAddress: 0n,
    targetAddress: 0n,
    msgSender: 0n,
    msgValue: 0n,
    txOrigin: 0n,
    statusCode: 'ok',
    stack: [],
    memoryChange: null,
    programChange: null,
    callDataChange: null,
    returnDataChange: null,
    storageChanges: {},
    balanceChanges: {},
    nonceChanges: {},
    deployedCodeChanges: {},
    initCodeChanges: {},
    ...over,
  };
}

const ACC = '0xaccount';

describe('StateCursor accumulation semantics (synthetic)', () => {
  const steps: Step[] = [
    // step 0: establish blobs + account with slot 0.
    makeStep(0, {
      memoryChange: ['0xaa'] as Hex[],
      programChange: '0xdead' as Hex,
      callDataChange: '0xca' as Hex,
      returnDataChange: '0xre' as Hex,
      balanceChanges: {[ACC]: '0x1'},
      nonceChanges: {[ACC]: '0x1'},
      initCodeChanges: {[ACC]: '0xicode'},
      storageChanges: {[ACC]: {'0x0': '0x11'}},
    }),
    // step 1: everything null/empty -> must carry the whole world forward.
    makeStep(1),
    // step 2: add slot 1, replace balance, set deployed runtime code.
    makeStep(2, {
      balanceChanges: {[ACC]: '0x2'},
      deployedCodeChanges: {[ACC]: '0xrun'},
      storageChanges: {[ACC]: {'0x1': '0x22'}},
    }),
    // step 3: overwrite slot 0, adopt a new memory image.
    makeStep(3, {
      memoryChange: ['0xbb', '0xcc'] as Hex[],
      storageChanges: {[ACC]: {'0x0': '0x99'}},
    }),
    // step 4: terminal, no changes.
    makeStep(4),
  ];

  it('carries blobs forward across a no-change step', () => {
    const cursor = new StateCursor(steps);
    const s1 = cursor.at(1);
    expect(s1.memory).toEqual(['0xaa']);
    expect(s1.bytecode).toBe('0xdead');
    expect(s1.calldata).toBe('0xca');
    expect(s1.returnData).toBe('0xre');
  });

  it('accumulates storage per slot (new slots add, do not replace the map)', () => {
    const cursor = new StateCursor(steps);
    const acc = cursor.at(2).accounts.get(ACC);
    expect(acc?.storage).toEqual({'0x0': '0x11', '0x1': '0x22'});
  });

  it('overwrites only the touched slot while earlier slots persist', () => {
    const cursor = new StateCursor(steps);
    const acc = cursor.at(3).accounts.get(ACC);
    expect(acc?.storage).toEqual({'0x0': '0x99', '0x1': '0x22'});
  });

  it('replaces balance/nonce/code/initCode and keeps unchanged fields', () => {
    const cursor = new StateCursor(steps);
    const acc = cursor.at(2).accounts.get(ACC);
    expect(acc?.balance).toBe('0x2'); // replaced at step 2
    expect(acc?.nonce).toBe('0x1'); // kept from step 0
    expect(acc?.initCode).toBe('0xicode'); // kept from step 0
    expect(acc?.code).toBe('0xrun'); // deployed runtime code set at step 2
  });

  it('adopts new memory images while keeping bytecode carried', () => {
    const cursor = new StateCursor(steps);
    const s3 = cursor.at(3);
    expect(s3.memory).toEqual(['0xbb', '0xcc']);
    expect(s3.bytecode).toBe('0xdead'); // still carried from step 0
  });

  it('reports length and terminal flag', () => {
    const cursor = new StateCursor(steps);
    expect(cursor.length).toBe(5);
    expect(cursor.at(4).isTerminal).toBe(true);
    expect(cursor.at(3).isTerminal).toBe(false);
  });

  it('defaults blobs to [] and "0x" when never set', () => {
    // A single step that sets no blobs at all.
    const cursor = new StateCursor([makeStep(0)]);
    const s = cursor.at(0);
    expect(s.memory).toEqual([]);
    expect(s.bytecode).toBe('0x');
    expect(s.calldata).toBe('0x');
    expect(s.returnData).toBe('0x');
    expect(s.accounts.size).toBe(0);
  });

  it('throws RangeError on the synthetic cursor too', () => {
    const cursor = new StateCursor(steps);
    expect(() => cursor.at(5)).toThrow(RangeError);
    expect(() => cursor.at(-1)).toThrow(RangeError);
  });

  // at(i) must support random access (reverse-stepping). A checkpoint/replay or
  // shared-mutable-accumulator implementation could pass every ascending test
  // above yet corrupt state when jumped around. Pin that at(i) depends only on
  // i, never on prior call order.
  it('returns call-order-independent results under random access', () => {
    const ascending = [0, 1, 2, 3, 4].map((i) => new StateCursor(steps).at(i));
    const shared = new StateCursor(steps);
    for (const i of [4, 0, 3, 1, 4, 2, 0]) {
      expect(shared.at(i)).toEqual(ascending[i]);
    }
  });
});

// ## initialStorage seeding: pre-trace state a prior tx wrote (e.g. Foundry
// `setUp()`) and this trace only reads. A delta trace emits no SLOAD delta, so
// without seeding those slots read as absent/zero. Seeded state must be visible
// from step 0, be overwritten per-slot by a later SSTORE, and never leak into
// accounts the trace never touches beyond what was seeded.
describe('StateCursor initialStorage seeding', () => {
  const OTHER = '0xother';

  it('exposes a seeded slot the trace never touches from step 0', () => {
    // A trace that only reads (no storageChanges anywhere) still surfaces seed.
    const cursor = new StateCursor([makeStep(0), makeStep(1)], {
      [ACC]: {'0x0': '0xdead', '0x2': '0xbeef'},
    });
    expect(cursor.at(0).accounts.get(ACC)?.storage).toEqual({
      '0x0': '0xdead',
      '0x2': '0xbeef',
    });
    // ...and it persists to the last step untouched.
    expect(cursor.at(1).accounts.get(ACC)?.storage).toEqual({
      '0x0': '0xdead',
      '0x2': '0xbeef',
    });
  });

  it('lets a later SSTORE overwrite the seeded slot (same minimal-hex key)', () => {
    const steps: Step[] = [
      makeStep(0),
      // step 1 writes slot 0x0 (collides with the seed) and adds slot 0x1.
      makeStep(1, {storageChanges: {[ACC]: {'0x0': '0x99', '0x1': '0x22'}}}),
    ];
    const cursor = new StateCursor(steps, {[ACC]: {'0x0': '0x11'}});
    expect(cursor.at(0).accounts.get(ACC)?.storage).toEqual({'0x0': '0x11'});
    // The SSTORE wins on 0x0; the seeded key is not duplicated.
    expect(cursor.at(1).accounts.get(ACC)?.storage).toEqual({
      '0x0': '0x99',
      '0x1': '0x22',
    });
  });

  it('lowercases seed addresses so a checksummed key still resolves', () => {
    const cursor = new StateCursor([makeStep(0)], {
      '0xABCdef': {'0x0': '0x1'},
    });
    expect(cursor.at(0).accounts.get('0xabcdef')?.storage).toEqual({'0x0': '0x1'});
  });

  it('seeds multiple accounts independently', () => {
    const cursor = new StateCursor([makeStep(0)], {
      [ACC]: {'0x0': '0x1'},
      [OTHER]: {'0x5': '0x2'},
    });
    const accounts = cursor.at(0).accounts;
    expect(accounts.get(ACC)?.storage).toEqual({'0x0': '0x1'});
    expect(accounts.get(OTHER)?.storage).toEqual({'0x5': '0x2'});
  });

  it('is a no-op when initialStorage is omitted', () => {
    const cursor = new StateCursor([makeStep(0)]);
    expect(cursor.at(0).accounts.size).toBe(0);
  });
});
