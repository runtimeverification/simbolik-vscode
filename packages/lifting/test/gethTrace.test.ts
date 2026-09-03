/**
 * geth/anvil trace factory + dialect detection.
 *
 * These tests cover `normalizeGethTrace` and `detectTraceDialect`. `StateCursor`
 * is used to prove the geth-normalized steps feed the SAME accumulation pipeline
 * as the kontrol steps.
 *
 * Ground-truth (confirmed directly against the fixtures):
 *  - anvil envelope has 118 structLogs of shape {pc,op,gas,gasCost,depth,stack,
 *    storage?,refund}; NO codeAddress/isInitCode/memoryChange fields (geth).
 *  - the kontrol envelope's first structLog DOES carry codeAddress/isInitCode.
 *  - exactly one structLog (index 112, op SSTORE) carries `storage`, as a
 *    32-byte zero-padded slot key mapping to a 32-byte value (…002a).
 *  - the stack is hex words, top-of-stack LAST (same convention as kontrol).
 */
import {readFileSync} from 'node:fs';

import {parseJsonLossless} from '@simbolik/engine';
import {describe, expect, it} from 'vitest';

import {detectTraceDialect, normalizeGethTrace, StateCursor} from '../src/index.js';

// ── Fixtures ────────────────────────────────────────────────────────────────

/** REAL recorded anvil `debug_traceTransaction` (geth format), envelope at `.result`. */
const ANVIL_RAW = readFileSync(
  new URL(
    '../../debugger/test/fixtures/anvil-setNumber-trace.raw.json',
    import.meta.url,
  ),
  'utf8',
);

/** REAL recorded kontrol-node trace (rich structLogs), envelope at `.result`. */
const KONTROL_RAW = readFileSync(
  new URL(
    '../../debugger/test/fixtures/counter-setNumber-trace.raw.json',
    import.meta.url,
  ),
  'utf8',
);

/** Recorded anvil meta: {contractAddress, txFrom, txTo, txInput, storageSlot0, …}. */
const META = JSON.parse(
  readFileSync(
    new URL(
      '../../debugger/test/fixtures/anvil-setNumber-meta.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  contractAddress: string;
  txFrom: string;
  txTo: string;
  txInput: string;
  storageSlot0: string;
  traceStepCount: number;
};

/** Parse losslessly so hex stack/storage words stay strings and ids stay exact. */
const anvilEnvelope = (parseJsonLossless(ANVIL_RAW) as {result: unknown}).result;
const kontrolEnvelope = (parseJsonLossless(KONTROL_RAW) as {result: unknown})
  .result;

/** The tx context the geth factory needs (there is no per-step address in geth). */
const txContext = {
  to: META.txTo,
  from: META.txFrom,
  input: META.txInput,
};

// The 32-byte zero-padded slot-0 key anvil actually emits, plus its minimal form.
const PADDED_SLOT0 =
  '0x0000000000000000000000000000000000000000000000000000000000000000';
const MINIMAL_SLOT0 = '0x0';

// ── 1. dialect detection ──────────────────────────────────────────────────────

describe('detectTraceDialect', () => {
  it('classifies the anvil envelope as geth (no rich structLog fields)', () => {
    expect(detectTraceDialect(anvilEnvelope)).toBe('geth');
  });

  it('classifies the kontrol envelope as kontrol (rich structLog fields)', () => {
    expect(detectTraceDialect(kontrolEnvelope)).toBe('kontrol');
  });

  it('does not crash on an empty structLogs array (defaults to geth)', () => {
    // Degenerate trace: there is no first structLog to inspect for rich fields.
    // A naive `structLogs[0].isInitCode` read would throw here; the detector
    // must instead fall through to the "no rich fields" branch → 'geth'.
    expect(detectTraceDialect({structLogs: []})).toBe('geth');
  });

  it('does not throw on a null/undefined/non-object envelope (defaults to geth)', () => {
    // A node error or unexpected shape must not throw a TypeError on `.structLogs`.
    expect(detectTraceDialect(null)).toBe('geth');
    expect(detectTraceDialect(undefined)).toBe('geth');
    expect(detectTraceDialect(42)).toBe('geth');
    expect(detectTraceDialect('nope')).toBe('geth');
  });
});

// ── 2. normalizeGethTrace → Step[] ────────────────────────────────────────────

describe('normalizeGethTrace', () => {
  it('produces one Step per structLog (118)', () => {
    const steps = normalizeGethTrace(anvilEnvelope, txContext);
    expect(steps).toHaveLength(META.traceStepCount);
    expect(steps).toHaveLength(118);
  });

  it('threads the tx context onto step 0 (code addr, sender, calldata)', () => {
    const [s0] = normalizeGethTrace(anvilEnvelope, txContext);

    // Single-frame case: every step runs the tx's `to` as its code address.
    expect(s0!.codeAddress).toBe(BigInt(META.txTo));
    expect(s0!.msgSender).toBe(BigInt(META.txFrom));

    // Calldata is introduced on step 0, then carried forward by StateCursor.
    expect(s0!.callDataChange).toBe(META.txInput);
  });

  it('carries each structLog stack through verbatim (top-of-stack last)', () => {
    const steps = normalizeGethTrace(anvilEnvelope, txContext);
    const rawLogs = (anvilEnvelope as {structLogs: {stack: string[]}[]})
      .structLogs;

    // Step 0 starts with an empty stack; a mid-execution step carries real words.
    expect(steps[0]!.stack).toEqual(rawLogs[0]!.stack);
    expect(steps[50]!.stack).toEqual(rawLogs[50]!.stack);
    expect(steps[50]!.stack.length).toBeGreaterThan(0);
  });

  it('normalizes SSTORE storage keys/values to MINIMAL hex under ctx.to', () => {
    const steps = normalizeGethTrace(anvilEnvelope, txContext);

    // Locate the single storage-bearing structLog directly in the raw envelope.
    const rawLogs = (
      anvilEnvelope as {structLogs: {storage?: Record<string, string>}[]}
    ).structLogs;
    const storageIndex = rawLogs.findIndex((l) => l.storage !== undefined);
    expect(storageIndex).toBeGreaterThanOrEqual(0);

    const account =
      steps[storageIndex]!.storageChanges[META.txTo.toLowerCase()] ??
      steps[storageIndex]!.storageChanges[META.txTo];
    expect(account).toBeDefined();

    // The key is minimalized ('0x0'), NOT the 32-byte padded key anvil emitted.
    expect(account![MINIMAL_SLOT0]).toBeDefined();
    expect(account![PADDED_SLOT0]).toBeUndefined();

    // The value is minimal hex too and decodes to 42 (0x2a).
    expect(BigInt(account![MINIMAL_SLOT0]!)).toBe(42n);
  });
});

// ── 2b. account-key normalization for leading-zero addresses ───────────────────

describe('normalizeGethTrace account-key padding (leading-zero address)', () => {
  // Synthetic single-SSTORE geth trace whose `to` has a leading ZERO byte, so
  // minimal hex (`0xab…`, 38 nibbles) differs from the 20-byte padded form
  // (`0x00ab…`, 40 nibbles) the debugger looks accounts up by. The account key
  // MUST be the padded form or the StateCursor lookup silently reads absent.
  const LEADING_ZERO_TO = '0x00abcdef0000000000000000000000000000cdef';
  const PADDED_KEY = LEADING_ZERO_TO; // already 40 nibbles, lowercase
  const syntheticEnvelope = {
    structLogs: [
      {pc: 0, op: 'PUSH1', gas: 100, depth: 1, stack: []},
      {
        pc: 2,
        op: 'SSTORE',
        gas: 90,
        depth: 1,
        stack: [],
        storage: {
          '0x0000000000000000000000000000000000000000000000000000000000000000':
            '0x000000000000000000000000000000000000000000000000000000000000002a',
        },
      },
    ],
  };

  it('keys storageChanges by the ZERO-PADDED address, not minimal hex', () => {
    const steps = normalizeGethTrace(syntheticEnvelope, {
      to: LEADING_ZERO_TO,
      from: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
      input: '0x',
    });
    // The padded key is present; the minimal (leading-zero-stripped) key is not.
    expect(steps[1]!.storageChanges[PADDED_KEY]).toBeDefined();
    expect(
      steps[1]!.storageChanges['0xabcdef0000000000000000000000000000cdef'],
    ).toBeUndefined();
    expect(BigInt(steps[1]!.storageChanges[PADDED_KEY]!['0x0']!)).toBe(42n);
  });

  it('is found by a 20-byte padded StateCursor account lookup', () => {
    const steps = normalizeGethTrace(syntheticEnvelope, {
      to: LEADING_ZERO_TO,
      from: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
      input: '0x',
    });
    const cursor = new StateCursor(steps);
    // This is exactly `addressHex(codeAddress)` — the padded form the debugger's
    // `machineStateFor` / frame lookups use.
    const account = cursor.at(1).accounts.get(PADDED_KEY);
    expect(account).toBeDefined();
    expect(BigInt(account!.storage['0x0']!)).toBe(42n);
  });
});

// ── 3. geth steps feed StateCursor identically to kontrol steps ────────────────

describe('normalizeGethTrace → StateCursor', () => {
  it('accumulates storage so slot 0 reads back as 42 at the terminal step', () => {
    const steps = normalizeGethTrace(anvilEnvelope, txContext);
    const cursor = new StateCursor(steps);
    expect(cursor.length).toBe(118);

    const account = cursor.at(117).accounts.get(META.txTo);
    expect(account).toBeDefined();

    // The minimal-key normalization is what makes this lookup succeed.
    expect(account!.storage[MINIMAL_SLOT0]).toBeDefined();
    expect(BigInt(account!.storage[MINIMAL_SLOT0]!)).toBe(42n);
  });
});

// ── 4. Multi-frame CALL reconstruction ────────────────────────────────────────
//
// The geth dialect carries NO per-step codeAddress. In the single-frame case
// `normalizeGethTrace` sets codeAddress = targetAddress = ctx.to for EVERY step.
// For a tx that CALLs another contract, that is WRONG for the callee's steps:
// they must run the CALLEE's code/storage, with the caller as msg.sender.
//
// `normalizeGethTrace` reconstructs per-step frames from the CALL-family
// opcodes + `depth` transitions: a plain CALL pushes a
// frame {code: callee, storage: callee, sender: callerCode}; the callee address
// is `stack[len-2]` of the CALL op (top-of-stack LAST). Storage is then keyed
// under the TOP FRAME's storage account, not always ctx.to.
//
// These assertions FAIL today because every step's codeAddress is ctx.to (the
// caller) and all storage is keyed under the caller — the depth-2 (callee)
// expectations below currently resolve to the caller address instead.

/** REAL recorded anvil multi-frame trace: Caller.go(callee,7) → Callee.compute(7). */
const CALLER_GO_RAW = readFileSync(
  new URL(
    '../../debugger/test/fixtures/caller-go-anvil-trace.raw.json',
    import.meta.url,
  ),
  'utf8',
);

/** Recorded caller-go meta: caller/callee addresses, goCalldata, x, indices. */
const CALL_META = JSON.parse(
  readFileSync(
    new URL(
      '../../debugger/test/fixtures/caller-go-anvil-meta.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  callerAddress: string;
  calleeAddress: string;
  goCalldata: string;
  callTxHash: string;
  traceStepCount: number;
  x: number;
};

/** Parse losslessly so hex stack/storage words stay strings and ids stay exact. */
const callerGoEnvelope = (parseJsonLossless(CALLER_GO_RAW) as {result: unknown})
  .result;

// anvil account #0 — the tx origin / msg.sender of the top-level Caller frame.
const ACCT0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

/** The tx context: this tx is Caller.go(...), so ctx.to = the CALLER contract. */
const callTxContext = {
  to: CALL_META.callerAddress,
  from: ACCT0,
  input: CALL_META.goCalldata,
};

const CALLER = BigInt(CALL_META.callerAddress);
const CALLEE = BigInt(CALL_META.calleeAddress);

/** The 40-nibble zero-padded lowercase account key `normalizeGethTrace` uses. */
function accountKey(addr: string): string {
  return `0x${BigInt(addr).toString(16).padStart(40, '0')}`;
}

describe('normalizeGethTrace multi-frame CALL reconstruction', () => {
  it('sanity: fixture has the expected shape (677 logs, CALL@248, depth-2 [249..562])', () => {
    const logs = (callerGoEnvelope as {structLogs: {op: string; depth: number}[]})
      .structLogs;
    expect(logs).toHaveLength(CALL_META.traceStepCount);
    expect(logs).toHaveLength(677);
    // depth-1 CALL op that enters the Callee frame.
    expect(logs[248]!.op).toBe('CALL');
    expect(logs[248]!.depth).toBe(1);
    // first step of the Callee frame, and last before it returns.
    expect(logs[249]!.depth).toBe(2);
    expect(logs[562]!.depth).toBe(2);
    // returned to the Caller frame.
    expect(logs[563]!.depth).toBe(1);
  });

  it('reconstructs per-step codeAddress: depth-1 → caller, depth-2 → callee', () => {
    const steps = normalizeGethTrace(callerGoEnvelope, callTxContext);
    expect(steps).toHaveLength(677);

    // Steps preserve their raw op/depth.
    expect(steps[248]!.op).toBe('CALL');
    expect(steps[248]!.depth).toBe(1);
    expect(steps[249]!.depth).toBe(2);

    // A depth-1 step BEFORE the CALL runs the Caller's code.
    expect(steps[247]!.codeAddress).toBe(CALLER);
    // The CALL op itself is still in the Caller frame.
    expect(steps[248]!.codeAddress).toBe(CALLER);

    // Every depth-2 step runs the CALLEE's code — the first, a mid step, the last.
    expect(steps[249]!.codeAddress).toBe(CALLEE);
    expect(steps[300]!.codeAddress).toBe(CALLEE);
    expect(steps[562]!.codeAddress).toBe(CALLEE);

    // After the callee RETURNs, control is back in the Caller frame.
    expect(steps[563]!.codeAddress).toBe(CALLER);
    expect(steps[600]!.codeAddress).toBe(CALLER);

    // Full invariant: codeAddress is caller iff depth 1, callee iff depth 2.
    for (const s of steps) {
      if (s.depth === 1) expect(s.codeAddress).toBe(CALLER);
      else if (s.depth === 2) expect(s.codeAddress).toBe(CALLEE);
    }
  });

  it('reconstructs targetAddress (storage ctx) and msgSender per frame', () => {
    const steps = normalizeGethTrace(callerGoEnvelope, callTxContext);

    // Top-level Caller frame: storage = caller, msg.sender = the tx `from` (acct0).
    expect(steps[247]!.targetAddress).toBe(CALLER);
    expect(steps[247]!.msgSender).toBe(BigInt(ACCT0));

    // Plain CALL → Callee frame: storage = callee, msg.sender = the Caller code.
    expect(steps[300]!.targetAddress).toBe(CALLEE);
    expect(steps[300]!.msgSender).toBe(CALLER);
    // First callee step too.
    expect(steps[249]!.targetAddress).toBe(CALLEE);
    expect(steps[249]!.msgSender).toBe(CALLER);
  });

  it('attributes SSTORE to the executing frame: callee stored=14, caller result=15', () => {
    const steps = normalizeGethTrace(callerGoEnvelope, callTxContext);
    const calleeKey = accountKey(CALL_META.calleeAddress);
    const callerKey = accountKey(CALL_META.callerAddress);

    // Callee's SSTORE (stored = x*2 = 14 = 0xe) lands under the CALLEE account,
    // at slot 0 — NOT under the caller account (the single-frame behavior).
    const calleeStore = steps[439]!.storageChanges;
    expect(steps[439]!.depth).toBe(2);
    expect(steps[439]!.op).toBe('SSTORE');
    expect(calleeStore[calleeKey]).toBeDefined();
    expect(calleeStore[callerKey]).toBeUndefined();
    expect(BigInt(calleeStore[calleeKey]!['0x0']!)).toBe(14n);

    // Caller's SSTORE (result = x*2+1 = 15 = 0xf) lands under the CALLER account.
    const callerStore = steps[669]!.storageChanges;
    expect(steps[669]!.depth).toBe(1);
    expect(steps[669]!.op).toBe('SSTORE');
    expect(callerStore[callerKey]).toBeDefined();
    expect(callerStore[calleeKey]).toBeUndefined();
    expect(BigInt(callerStore[callerKey]!['0x0']!)).toBe(15n);

    // Whole-trace scan: no depth-2 storage step is ever keyed under the caller,
    // and no depth-1 storage step is ever keyed under the callee.
    for (const s of steps) {
      const keys = Object.keys(s.storageChanges);
      if (keys.length === 0) continue;
      if (s.depth === 2) {
        expect(keys).toContain(calleeKey);
        expect(keys).not.toContain(callerKey);
      } else if (s.depth === 1) {
        expect(keys).toContain(callerKey);
        expect(keys).not.toContain(calleeKey);
      }
    }
  });
});

// ── 5. Regression: single-frame geth path is unchanged ────────────────────────

describe('normalizeGethTrace single-frame regression (anvil setNumber)', () => {
  it('keeps every step at depth 1 with codeAddress = ctx.to (the counter)', () => {
    const steps = normalizeGethTrace(anvilEnvelope, txContext);
    expect(steps).toHaveLength(118);
    const counter = BigInt(META.txTo);
    for (const s of steps) {
      expect(s.depth).toBe(1);
      expect(s.codeAddress).toBe(counter);
      expect(s.targetAddress).toBe(counter);
      expect(s.msgSender).toBe(BigInt(META.txFrom));
    }
  });

  it('still lifts slot 0 = 42 through StateCursor (unchanged)', () => {
    const steps = normalizeGethTrace(anvilEnvelope, txContext);
    const cursor = new StateCursor(steps);
    const account = cursor.at(117).accounts.get(META.txTo);
    expect(account).toBeDefined();
    expect(BigInt(account!.storage[MINIMAL_SLOT0]!)).toBe(42n);
  });

  // A geth trace has NO block context / tx.gasprice: the optional Globals-scope
  // fields the kontrol path populates MUST stay undefined here (the "unavailable"
  // signal the debugger's availability rule reads to omit `block` / `tx.gasprice`).
  it('leaves the block/tx context fields undefined (unavailable in geth)', () => {
    for (const s of normalizeGethTrace(anvilEnvelope, txContext)) {
      expect(s.gasPrice).toBeUndefined();
      expect(s.difficulty).toBeUndefined();
      expect(s.blockNumber).toBeUndefined();
      expect(s.blockTimestamp).toBeUndefined();
      expect(s.coinbase).toBeUndefined();
    }
  });
});

describe('normalizeGethTrace CREATE frames (init code)', () => {
  // The address the CREATE deploys — pushed onto the creator's stack on return.
  const CREATED = '0x00000000000000000000000000000000000000ab';
  // A minimal trace: creator runs, executes CREATE (stack = value,offset,size),
  // the constructor's INIT code runs at depth 2, RETURNs, back to the creator.
  const CREATE_ENVELOPE = {
    failed: false,
    gas: 100000,
    returnValue: '',
    structLogs: [
      {pc: 0, op: 'PUSH1', gas: 100000, gasCost: 3, depth: 1, stack: []},
      // CREATE op at depth 1; its stack is (value, offset, size) — NOT an address.
      {
        pc: 2,
        op: 'CREATE',
        gas: 99997,
        gasCost: 32000,
        depth: 1,
        stack: ['0x0', '0x0', '0x20'],
      },
      // Constructor init code running at depth 2.
      {pc: 0, op: 'PUSH1', gas: 67000, gasCost: 3, depth: 2, stack: []},
      {pc: 2, op: 'RETURN', gas: 66997, gasCost: 0, depth: 2, stack: ['0x0', '0x0']},
      // Back in the creator: CREATE pushed the new address onto the stack top.
      {pc: 3, op: 'STOP', gas: 66000, gasCost: 0, depth: 1, stack: [CREATED]},
    ],
  };
  const ctx = {
    to: '0x' + '11'.repeat(20),
    from: '0x' + '22'.repeat(20),
    input: '0x',
  };

  it('marks the constructor (depth-2 CREATE) steps as isInitCode, others not', () => {
    const steps = normalizeGethTrace(CREATE_ENVELOPE as never, ctx);
    expect(steps.map((s) => s.isInitCode)).toEqual([
      false, // creator PUSH1
      false, // CREATE op (still creator frame)
      true, //  init code PUSH1 (depth 2)
      true, //  init code RETURN (depth 2)
      false, // back in creator (STOP)
    ]);
    // The constructor frame's codeAddress is the CREATED address (recovered from
    // the frame's return), so its INIT code resolves to the created contract.
    expect(steps[2]!.codeAddress).toBe(BigInt(CREATED));
    expect(steps[3]!.codeAddress).toBe(BigInt(CREATED));
    // The creator frame is unchanged.
    expect(steps[0]!.codeAddress).toBe(BigInt(ctx.to));
    expect(steps[4]!.codeAddress).toBe(BigInt(ctx.to));
  });
});
