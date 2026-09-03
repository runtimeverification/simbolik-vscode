/**
 * Fuller EVM State scope — decoded Calldata, Return Data leaf, and Accounts tree.
 *
 * TDD (RED): these tests drive `SolidityDebugSession` against recorded fixtures
 * and assert the three EVM-scope additions. They FAIL until `session.ts`:
 *   - makes the `calldata` row EXPANDABLE (selector + 32-byte chunk children);
 *   - APPENDS a `returnData` leaf; and
 *   - APPENDS an expandable `accounts` tree (address/balance/nonce/code/storage).
 *
 * Ground truth (read directly from the fixtures + the accumulated MachineState):
 *   - counter-setNumber (kontrol, single frame):
 *       calldata = 0x3fb5c1cb + 000…002a  → selector 0x3fb5c1cb,
 *         one 32-byte arg word …002a (setNumber(42)); byteLen = 36.
 *       returnData = 0x throughout (void setNumber).
 *       accounts (at the terminal step): acct0 0xf39f…92266 and the traced
 *         Counter 0x5fbd…0aa3; the Counter's storage slot 0x0 = 0x2a (`number`),
 *         its balance = 0x0 → "0", nonce = undefined → "Unavailable",
 *         code = undefined → "0 bytes".
 *   - mixed-go (kontrol, Caller.go → Callee.compute): the callee returns 43, so
 *       MachineState.returnData becomes 0x…002b at step 374 (op ISZERO, depth 1)
 *       and persists to the terminal step 487 → the `returnData` row shows it.
 */
import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {SolidityDebugSession, type LaunchInputs} from '../src/index.js';

// ---------------------------------------------------------------------------
// Fixture loaders (mirroring globals.test.ts / returns.test.ts)
// ---------------------------------------------------------------------------

function solcFixture(name: string): unknown {
  return JSON.parse(
    readFileSync(new URL(`../../solc/test/fixtures/${name}`, import.meta.url), 'utf8'),
  );
}
function dbgFixtureText(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}
function dbgFixtureJson<T>(name: string): T {
  return JSON.parse(dbgFixtureText(name)) as T;
}

/** A DAP variable as the session emits it. */
interface DapVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
}

// ---------------------------------------------------------------------------
// Launch inputs
// ---------------------------------------------------------------------------

const ACCT0 = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const COUNTER_ADDRESS = dbgFixtureJson<{contractAddress: string}>(
  'counter-setNumber-meta.json',
).contractAddress;
const COUNTER_SIG = '0x3fb5c1cb';
// setNumber(42) → the single ABI word, 42 == 0x2a.
const COUNTER_ARG_WORD =
  '0x000000000000000000000000000000000000000000000000000000000000002a';

function counterInputs(): LaunchInputs {
  return {
    buildInfoJson: solcFixture('counter-build-info.json'),
    traceJson: dbgFixtureText('counter-setNumber-trace.raw.json'),
    sourcePath: 'src/Counter.sol',
    contractName: 'Counter',
    methodName: 'setNumber',
    codeAddress: COUNTER_ADDRESS,
    dialect: 'kontrol',
  } as LaunchInputs;
}

const MIXED_META = dbgFixtureJson<{callerAddress: string; calleeAddress: string}>(
  'mixed-go-meta.json',
);
// Callee.compute(21) returns 43 == 0x2b; MachineState.returnData accumulates it.
const MIXED_RETURN_DATA =
  '0x000000000000000000000000000000000000000000000000000000000000002b';

function mixedInputs(): LaunchInputs {
  return {
    buildInfos: [
      solcFixture('caller-unopt-build-info.json'),
      solcFixture('callee-opt-build-info.json'),
    ],
    traceJson: dbgFixtureText('mixed-go-trace.raw.json'),
    sourcePath: 'src/Caller.sol',
    contractName: 'Caller',
    methodName: 'go',
    codeAddress: MIXED_META.callerAddress,
  } as LaunchInputs;
}

// Vars.setAll(7, 1000, true, 0x..aa, -5, 0x1122.., Blue) — 7 ABI word args, so
// the decoded calldata exercises the offset-naming rule beyond the first chunk.
const VARS_ADDRESS = dbgFixtureJson<{contractAddress: string}>(
  'vars-setall-meta.json',
).contractAddress;
const VARS_SIG = '0xa6c07be9';

function varsInputs(): LaunchInputs {
  return {
    buildInfoJson: solcFixture('vars-build-info.json'),
    traceJson: dbgFixtureText('vars-setall-trace.raw.json'),
    sourcePath: 'src/Vars.sol',
    contractName: 'Vars',
    methodName: 'setAll',
    codeAddress: VARS_ADDRESS,
    dialect: 'kontrol',
  } as LaunchInputs;
}

// ---------------------------------------------------------------------------
// EVM-scope helpers
// ---------------------------------------------------------------------------

/** The EVM scope rows for a frame; throws if the scope is absent. */
async function evmRows(
  session: SolidityDebugSession,
  frameId: number,
): Promise<DapVariable[]> {
  const {scopes} = session.scopes(frameId);
  const evm = scopes.find((s) => s.name === 'EVM');
  expect(
    evm,
    `EVM scope missing; scopes were ${scopes.map((s) => s.name).join(', ')}`,
  ).toBeDefined();
  return (await session.variables(evm!.variablesReference))
    .variables as DapVariable[];
}

function row(rows: DapVariable[], name: string): DapVariable {
  const r = rows.find((v) => v.name === name);
  expect(
    r,
    `EVM row '${name}' missing; rows were ${rows.map((v) => v.name).join(', ')}`,
  ).toBeDefined();
  return r!;
}

/** Expand a row into its children; asserts it is expandable. */
async function expand(
  session: SolidityDebugSession,
  r: DapVariable,
): Promise<DapVariable[]> {
  expect(r.variablesReference, `row '${r.name}' must be expandable`).not.toBe(0);
  return (await session.variables(r.variablesReference)).variables as DapVariable[];
}

function child(children: DapVariable[], name: string): DapVariable {
  const c = children.find((v) => v.name === name);
  expect(
    c,
    `child '${name}' missing; children were ${children.map((v) => v.name).join(', ')}`,
  ).toBeDefined();
  return c!;
}

// ===========================================================================
// 1. Decoded Calldata (counter-setNumber)
// ===========================================================================

describe('EVM scope — decoded Calldata (counter-setNumber)', () => {
  it('the calldata row is expandable into a selector + one 32-byte arg chunk', async () => {
    const session = new SolidityDebugSession();
    await session.launch(counterInputs());
    const frameId = session.stackTrace().stackFrames[0]!.id;

    const rows = await evmRows(session, frameId);
    const calldata = row(rows, 'calldata');

    // Was a raw leaf; must become expandable with a byte-count summary value.
    // 36-byte calldata (4 selector + one 32-byte word).
    expect(calldata.value).toBe('36 bytes');
    expect(calldata.variablesReference, 'calldata must be expandable').not.toBe(0);

    const parts = await expand(session, calldata);

    // First child: the 4-byte function selector, named by byte offset 0x00.
    const selector = child(parts, '0x00');
    expect(selector.value).toBe(COUNTER_SIG);
    expect(selector.type).toBe('bytes4');
    expect(selector.variablesReference).toBe(0);

    // Then one 32-byte chunk of the post-selector calldata, named by byte
    // offset 0x04 (= 4 + 0*32), whose word is the ABI-encoded arg 42 (…002a).
    const arg = child(parts, '0x04');
    expect(arg.value).toBe(COUNTER_ARG_WORD);
    expect(arg.value.endsWith('2a')).toBe(true);
    expect(arg.variablesReference).toBe(0);
  });

  it('names multi-word args by byte offset 4 + k*32 (vars-setall, 7 words)', async () => {
    const session = new SolidityDebugSession();
    await session.launch(varsInputs());
    const frameId = session.stackTrace().stackFrames[0]!.id;

    const calldata = row(await evmRows(session, frameId), 'calldata');
    // 4 selector + 7 * 32 = 228 bytes.
    expect(calldata.value).toBe('228 bytes');
    const parts = await expand(session, calldata);

    expect(child(parts, '0x00').value).toBe(VARS_SIG);
    // First arg word at 0x04 (=4), second at 0x24 (=4+32=36), last at 0xc4
    // (=4+6*32=196) — proving the offset formula, not a plain chunk index.
    expect(child(parts, '0x04').value.endsWith('07')).toBe(true); // a = 7
    expect(child(parts, '0x24').value).toBe(
      '0x00000000000000000000000000000000000000000000000000000000000003e8', // b = 1000
    );
    expect(child(parts, '0xc4').value).toBe(
      '0x0000000000000000000000000000000000000000000000000000000000000002', // g = Color.Blue (2)
    );
  });
});

// ===========================================================================
// 2. Return Data
// ===========================================================================

describe('EVM scope — Return Data leaf', () => {
  it('shows the callee return value hex (mixed-go, after the call returns)', async () => {
    const session = new SolidityDebugSession();
    await session.launch(mixedInputs());
    // Run to the end: the callee has returned 43, so MachineState.returnData
    // (accumulated) holds 0x…002b at the terminal step.
    session.continue();

    const frameId = session.stackTrace().stackFrames[0]!.id;
    const rows = await evmRows(session, frameId);
    const returnData = row(rows, 'returnData');

    expect(returnData.value).toBe(MIXED_RETURN_DATA);
    // A leaf — Return Data is NOT expandable.
    expect(returnData.variablesReference).toBe(0);
  });

  it('is 0x for a void call at entry (counter-setNumber)', async () => {
    const session = new SolidityDebugSession();
    await session.launch(counterInputs());
    const frameId = session.stackTrace().stackFrames[0]!.id;

    const rows = await evmRows(session, frameId);
    const returnData = row(rows, 'returnData');
    expect(returnData.value).toBe('0x');
    expect(returnData.variablesReference).toBe(0);
  });
});

// ===========================================================================
// 3. Accounts tree (counter-setNumber)
// ===========================================================================

describe('EVM scope — Accounts tree (counter-setNumber)', () => {
  it('lists the touched accounts and drills into the Counter account', async () => {
    const session = new SolidityDebugSession();
    await session.launch(counterInputs());
    // Run past the SSTORE so the Counter's `number` slot (0x0) holds 0x2a.
    session.continue();

    const frameId = session.stackTrace().stackFrames[0]!.id;
    const rows = await evmRows(session, frameId);
    const accounts = row(rows, 'accounts');

    // Expandable; two accounts were touched (acct0 sender + the Counter).
    expect(accounts.variablesReference, 'accounts must be expandable').not.toBe(0);
    const accountRows = await expand(session, accounts);
    expect(accountRows.length).toBeGreaterThanOrEqual(1);
    const names = accountRows.map((r) => r.name);
    expect(names).toContain(ACCT0);
    expect(names).toContain(COUNTER_ADDRESS.toLowerCase());

    // Drill into the traced Counter contract's account.
    const counterAcct = child(accountRows, COUNTER_ADDRESS.toLowerCase());
    const fields = await expand(session, counterAcct);
    expect(fields.map((f) => f.name)).toEqual([
      'address',
      'balance',
      'nonce',
      'code',
      'storage',
    ]);

    const address = child(fields, 'address');
    expect(address.value).toBe(COUNTER_ADDRESS.toLowerCase());
    expect(address.type).toBe('address');
    expect(address.variablesReference).toBe(0);

    // balance/nonce are EITHER a decimal string OR exactly 'Unavailable'.
    const balance = child(fields, 'balance');
    expect(balance.value).toMatch(/^(\d+|Unavailable)$/);
    // The fixture records a balanceChange to 0x0 → decimal "0".
    expect(balance.value).toBe('0');
    const nonce = child(fields, 'nonce');
    expect(nonce.value).toMatch(/^(\d+|Unavailable)$/);
    // No nonceChange for the Counter → 'Unavailable'.
    expect(nonce.value).toBe('Unavailable');

    // code is a size summary (a leaf), not the raw runtime hex.
    const code = child(fields, 'code');
    expect(code.value).toMatch(/^\d+ bytes$/);
    // No deployedCodeChange for the Counter in this trace → 0 bytes.
    expect(code.value).toBe('0 bytes');
    expect(code.variablesReference).toBe(0);

    // storage is expandable and includes the `number` slot written by setNumber.
    const storage = child(fields, 'storage');
    expect(storage.variablesReference, 'storage must be expandable').not.toBe(0);
    const slots = await expand(session, storage);
    const numberSlot = child(slots, '0x0');
    expect(numberSlot.value).toBe('0x2a');
    expect(numberSlot.variablesReference).toBe(0);
  });

  it('renders each account its OWN storage, not the frame/shared storage (mixed-go)', async () => {
    const session = new SolidityDebugSession();
    await session.launch(mixedInputs());
    session.continue();

    const frameId = session.stackTrace().stackFrames[0]!.id;
    const accounts = row(await evmRows(session, frameId), 'accounts');
    const accountRows = await expand(session, accounts);

    const caller = MIXED_META.callerAddress.toLowerCase();
    const callee = MIXED_META.calleeAddress.toLowerCase();

    // Same slot 0 in both contracts, DIFFERENT values: caller stored 0x2b,
    // callee stored 0x2a. A renderer that leaks the frame's (or a shared)
    // storage into every account would show the same word for both.
    const callerSlots = await expand(
      session,
      child(await expand(session, child(accountRows, caller)), 'storage'),
    );
    const calleeSlots = await expand(
      session,
      child(await expand(session, child(accountRows, callee)), 'storage'),
    );
    expect(child(callerSlots, '0x0').value).toBe('0x2b');
    expect(child(calleeSlots, '0x0').value).toBe('0x2a');
  });
});
