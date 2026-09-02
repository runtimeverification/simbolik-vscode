import {readFileSync} from 'node:fs';

import {parseJsonLossless} from '@simbolik/engine';
import type {KontrolTrace} from '@simbolik/protocol';
import {describe, expect, it} from 'vitest';

import {normalizeKontrolTrace} from '../src/index.js';

// The REAL recorded Counter-deploy trace shared with the engine package.
const fixture = readFileSync(
  new URL(
    '../../engine/test/fixtures/debug_traceTransaction_0.expected.json',
    import.meta.url,
  ),
  'utf8',
);

// The fixture is a JSON-RPC *batch*: [ {result: txHash}, {result: traceEnvelope} ].
// Parse losslessly so 160-bit addresses / 256-bit values stay `bigint`.
const batch = parseJsonLossless(fixture) as [
  unknown,
  {result: KontrolTrace},
];
const trace = batch[1].result;

// Ground-truth constants confirmed directly against the fixture.
const DEPLOY_ADDR = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
const SENDER_ADDR = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const CODE_ADDRESS = 546584486846459126461364135121053344201067465379n;
const MSG_SENDER = 1390849295786071768276380950238675083608645509734n;

describe('normalizeKontrolTrace', () => {
  it('produces exactly 17 Steps from the real fixture', () => {
    const steps = normalizeKontrolTrace(trace);
    expect(steps).toHaveLength(17);
    expect(trace.structLogs).toHaveLength(17);
  });

  it('assigns a 0-based sequential index to every Step', () => {
    const steps = normalizeKontrolTrace(trace);
    steps.forEach((step, i) => expect(step.index).toBe(i));
  });

  it('decodes step 0 scalar fields with correct values and types', () => {
    const [s0] = normalizeKontrolTrace(trace);

    expect(s0.index).toBe(0);
    expect(s0.pc).toBe(0);
    expect(s0.op).toBe('PUSH1');
    expect(s0.depth).toBe(1);
    expect(s0.gas).toBe(29942777);
    expect(s0.isInitCode).toBe(true);
    expect(s0.statusCode).toBe('empty');

    // Addresses / 256-bit values MUST be bigint (lossless), not number.
    expect(typeof s0.codeAddress).toBe('bigint');
    expect(s0.codeAddress).toBe(CODE_ADDRESS);
    expect(s0.targetAddress).toBe(CODE_ADDRESS);
    expect(typeof s0.msgSender).toBe('bigint');
    expect(s0.msgSender).toBe(MSG_SENDER);
    expect(s0.txOrigin).toBe(MSG_SENDER);

    // A small value (0) must still be coerced to bigint per the Step contract.
    expect(typeof s0.msgValue).toBe('bigint');
    expect(s0.msgValue).toBe(0n);
  });

  it('carries the stack through wholesale, top-of-stack last', () => {
    const steps = normalizeKontrolTrace(trace);
    expect(steps[0].stack).toEqual([]);
    expect(steps[1].stack).toEqual(['0x80']);
  });

  it('preserves step 0 delta fields RAW (non-null program + populated accounts)', () => {
    const [s0] = normalizeKontrolTrace(trace);

    // memoryChange at step 0 is an EMPTY array (not null): memory is empty here.
    expect(s0.memoryChange).toEqual([]);

    // The init bytecode is present verbatim on step 0.
    expect(s0.programChange).not.toBeNull();
    expect(s0.programChange).toMatch(/^0x6080604052/);
    expect(s0.programChange).toHaveLength(556);

    // calldata / returndata start empty ("0x"), not null, on step 0.
    expect(s0.callDataChange).toBe('0x');
    expect(s0.returnDataChange).toBe('0x');

    // Account deltas populated exactly as emitted.
    expect(s0.balanceChanges).toEqual({
      [DEPLOY_ADDR]: '0x0',
      [SENDER_ADDR]: '0x21ad935f971201a2000',
    });
    expect(s0.nonceChanges).toEqual({
      [DEPLOY_ADDR]: '0x1',
      [SENDER_ADDR]: '0x1',
    });

    // The deploy address gets its init code; program === that init code.
    expect(Object.keys(s0.initCodeChanges)).toEqual([DEPLOY_ADDR]);
    expect(s0.initCodeChanges[DEPLOY_ADDR]).toBe(s0.programChange);

    // No storage or deployed-runtime-code changes on step 0.
    expect(s0.storageChanges).toEqual({});
    expect(s0.deployedCodeChanges).toEqual({});
  });

  it('preserves memoryChange === null RAW on step 1 (unchanged this step)', () => {
    const steps = normalizeKontrolTrace(trace);
    const s1 = steps[1];

    expect(s1.pc).toBe(2);
    expect(s1.op).toBe('PUSH1');
    expect(s1.depth).toBe(1);
    expect(s1.gas).toBe(29942774);
    expect(s1.stack).toEqual(['0x80']);

    // The heart of the delta contract: unchanged blobs stay null, not [].
    expect(s1.memoryChange).toBeNull();
    expect(s1.programChange).toBeNull();
    expect(s1.callDataChange).toBeNull();
    expect(s1.returnDataChange).toBeNull();
  });

  it('marks the final step as RETURN at index 16', () => {
    const steps = normalizeKontrolTrace(trace);
    const last = steps[steps.length - 1];
    expect(last.index).toBe(16);
    expect(last.op).toBe('RETURN');
  });

  // The whole fixture never emits a storage or deployed-code delta; assert that
  // ground truth so accumulation tests below can rely on it.
  it('emits no storage or deployed-code changes anywhere in this fixture', () => {
    const steps = normalizeKontrolTrace(trace);
    for (const step of steps) {
      expect(step.storageChanges).toEqual({});
      expect(step.deployedCodeChanges).toEqual({});
    }
  });
});
