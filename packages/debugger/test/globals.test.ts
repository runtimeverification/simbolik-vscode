/**
 * Read-only "Globals" scope — Solidity global variables (`msg`, `tx`, `block`,
 * `gasleft()`) surfaced per-frame.
 *
 * TDD (RED): these tests drive `SolidityDebugSession` against recorded fixtures
 * and assert the Globals scope + its nested groups. They FAIL until the scope is
 * implemented (`scopes()` does not yet push 'Globals', and `variables()` has no
 * 'Globals'/'GlobalGroup' cases).
 *
 * Ground-truth (read directly from the fixtures):
 *   - counter-setNumber (kontrol, single frame): msgSender = txOrigin =
 *     1390849295786071768276380950238675083608645509734
 *     (= 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266); msgValue = 0;
 *     blockNumber = 2; blockTimestamp = 1768610547; coinbase = 0;
 *     difficulty(prevrandao) = 0; gasCost(gasprice) = 0; calldata =
 *     0x3fb5c1cb…002a (setNumber(42)) → sig = 0x3fb5c1cb; gas ∈ [29956304,29978796].
 *   - mixed-go (kontrol, multi-frame Caller.go → Callee.compute): depth-1
 *     msg.sender = 0xf39f…92266 (acct0); depth-2 msg.sender = the Caller address
 *     0xe7f1725e7734ce288f8367e1bb143e90bb3f0512 → proves per-frame resolution.
 *   - anvil-setNumber (geth): NO block context → `block` group + `tx.gasprice`
 *     omitted; `msg`(sender/value/data/sig), `tx.origin`, `gasleft()` present.
 */
import {readFileSync} from 'node:fs';

import {parseJsonLossless} from '@simbolik/engine';
import {normalizeKontrolTrace, type Step} from '@simbolik/lifting';
import {describe, expect, it} from 'vitest';

import {SolidityDebugSession, type LaunchInputs} from '../src/index.js';

// ---------------------------------------------------------------------------
// Fixture loaders (mirroring events.test.ts / mixed.test.ts)
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

/** The Globals scope rows for a frame; throws if the scope is absent. */
async function globalsRows(
  session: SolidityDebugSession,
  frameId: number,
): Promise<DapVariable[]> {
  const {scopes} = session.scopes(frameId);
  const globals = scopes.find((s) => s.name === 'Globals');
  expect(
    globals,
    `Globals scope missing; scopes were ${scopes.map((s) => s.name).join(', ')}`,
  ).toBeDefined();
  return (await session.variables(globals!.variablesReference))
    .variables as DapVariable[];
}

/** Expand a named group row into its children. */
async function groupChildren(
  session: SolidityDebugSession,
  rows: DapVariable[],
  group: string,
): Promise<DapVariable[]> {
  const row = rows.find((r) => r.name === group);
  expect(row, `Globals group '${group}' missing`).toBeDefined();
  expect(
    row!.variablesReference,
    `Globals group '${group}' must be expandable`,
  ).not.toBe(0);
  return (await session.variables(row!.variablesReference))
    .variables as DapVariable[];
}

function child(children: DapVariable[], name: string): DapVariable {
  const c = children.find((v) => v.name === name);
  expect(c, `child '${name}' missing`).toBeDefined();
  return c!;
}

// ===========================================================================
// A) kontrol, single frame — counter-setNumber
// ===========================================================================

const ACCT0 = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
const COUNTER_CALLDATA =
  '0x3fb5c1cb000000000000000000000000000000000000000000000000000000000000002a';
const COUNTER_SIG = '0x3fb5c1cb';

function counterInputs(): LaunchInputs {
  return {
    buildInfoJson: solcFixture('counter-build-info.json'),
    traceJson: dbgFixtureText('counter-setNumber-trace.raw.json'),
    sourcePath: 'src/Counter.sol',
    contractName: 'Counter',
    methodName: 'setNumber',
    codeAddress: dbgFixtureJson<{contractAddress: string}>(
      'counter-setNumber-meta.json',
    ).contractAddress,
    dialect: 'kontrol',
  } as LaunchInputs;
}

/** All distinct `gas` values in the kontrol counter trace (for gasleft() checks). */
function counterGasValues(): Set<number> {
  const parsed = parseJsonLossless(
    dbgFixtureText('counter-setNumber-trace.raw.json'),
  ) as {result: unknown};
  const steps: Step[] = normalizeKontrolTrace(parsed.result as never);
  return new Set(steps.map((s) => s.gas));
}

describe('Globals scope — kontrol single frame (counter-setNumber)', () => {
  it('scopes() includes a read-only Globals scope', async () => {
    const session = new SolidityDebugSession();
    await session.launch(counterInputs());
    const frameId = session.stackTrace().stackFrames[0]!.id;

    const {scopes} = session.scopes(frameId);
    const names = scopes.map((s) => s.name);
    expect(names, `scopes were ${names.join(', ')}`).toContain('Globals');
    const globals = scopes.find((s) => s.name === 'Globals')!;
    expect(globals.expensive ?? false).toBe(false);
  });

  it('lists groups msg, tx, block and a scalar gasleft()', async () => {
    const session = new SolidityDebugSession();
    await session.launch(counterInputs());
    const frameId = session.stackTrace().stackFrames[0]!.id;

    const rows = await globalsRows(session, frameId);
    const names = rows.map((r) => r.name);
    expect(names).toEqual(['msg', 'tx', 'block', 'gasleft()']);

    // The three groups are expandable; gasleft() is a scalar leaf.
    for (const g of ['msg', 'tx', 'block']) {
      expect(rows.find((r) => r.name === g)!.variablesReference).not.toBe(0);
    }
    const gasleft = rows.find((r) => r.name === 'gasleft()')!;
    expect(gasleft.variablesReference).toBe(0);
    expect(gasleft.type).toBe('uint256');
    // gasleft() reflects the frame's step gas — a positive integer that is a
    // real gas value from the trace (not hard-coded to a step-dependent value).
    const gas = Number(gasleft.value);
    expect(Number.isInteger(gas)).toBe(true);
    expect(gas).toBeGreaterThan(0);
    expect(counterGasValues().has(gas)).toBe(true);
  });

  it('msg group: sender/value/data/sig from the fixture', async () => {
    const session = new SolidityDebugSession();
    await session.launch(counterInputs());
    const frameId = session.stackTrace().stackFrames[0]!.id;

    const msg = await groupChildren(session, await globalsRows(session, frameId), 'msg');
    expect(msg.map((v) => v.name)).toEqual(['sender', 'value', 'data', 'sig']);

    const sender = child(msg, 'sender');
    expect(sender.value).toBe(ACCT0);
    expect(sender.type).toBe('address');
    expect(sender.variablesReference).toBe(0);

    const value = child(msg, 'value');
    expect(value.value).toBe('0');
    expect(value.type).toBe('uint256');

    const data = child(msg, 'data');
    expect(data.value).toBe(COUNTER_CALLDATA);
    expect(data.type).toBe('bytes');

    const sig = child(msg, 'sig');
    expect(sig.value).toBe(COUNTER_SIG);
    expect(sig.type).toBe('bytes4');
  });

  it('tx group: origin + gasprice from the fixture', async () => {
    const session = new SolidityDebugSession();
    await session.launch(counterInputs());
    const frameId = session.stackTrace().stackFrames[0]!.id;

    const tx = await groupChildren(session, await globalsRows(session, frameId), 'tx');
    expect(tx.map((v) => v.name)).toEqual(['origin', 'gasprice']);

    const origin = child(tx, 'origin');
    expect(origin.value).toBe(ACCT0);
    expect(origin.type).toBe('address');

    const gasprice = child(tx, 'gasprice');
    expect(gasprice.value).toBe('0');
    expect(gasprice.type).toBe('uint256');
  });

  it('block group: number/timestamp/coinbase/prevrandao from the fixture', async () => {
    const session = new SolidityDebugSession();
    await session.launch(counterInputs());
    const frameId = session.stackTrace().stackFrames[0]!.id;

    const block = await groupChildren(
      session,
      await globalsRows(session, frameId),
      'block',
    );
    expect(block.map((v) => v.name)).toEqual([
      'number',
      'timestamp',
      'coinbase',
      'prevrandao',
    ]);

    expect(child(block, 'number').value).toBe('2');
    expect(child(block, 'number').type).toBe('uint256');
    expect(child(block, 'timestamp').value).toBe('1768610547');
    expect(child(block, 'timestamp').type).toBe('uint256');
    // coinbase = 0 → the zero address (40-hex, lowercase, 0x-prefixed).
    expect(child(block, 'coinbase').value).toBe('0x' + '0'.repeat(40));
    expect(child(block, 'coinbase').type).toBe('address');
    expect(child(block, 'prevrandao').value).toBe('0');
    expect(child(block, 'prevrandao').type).toBe('uint256');
  });
});

// ===========================================================================
// B) kontrol, multi-frame — mixed-go: Globals is PER-FRAME
// ===========================================================================

const MIXED_META = dbgFixtureJson<{callerAddress: string; calleeAddress: string}>(
  'mixed-go-meta.json',
);
const CALLER_PATH = 'src/Caller.sol';
const CALLEE_PATH = 'src/Callee.sol';

function mixedInputs(): LaunchInputs {
  return {
    buildInfos: [
      solcFixture('caller-unopt-build-info.json'),
      solcFixture('callee-opt-build-info.json'),
    ],
    traceJson: dbgFixtureText('mixed-go-trace.raw.json'),
    sourcePath: CALLER_PATH,
    contractName: 'Caller',
    methodName: 'go',
    codeAddress: MIXED_META.callerAddress,
  } as LaunchInputs;
}

async function msgSenderOf(
  session: SolidityDebugSession,
  frameId: number,
): Promise<string> {
  const msg = await groupChildren(session, await globalsRows(session, frameId), 'msg');
  return child(msg, 'sender').value;
}

async function gasleftOf(
  session: SolidityDebugSession,
  frameId: number,
): Promise<number> {
  const rows = await globalsRows(session, frameId);
  return Number(rows.find((r) => r.name === 'gasleft()')!.value);
}

describe('Globals scope — kontrol multi-frame (mixed-go), per-frame msg.sender', () => {
  it('inner (callee) msg.sender differs from outer (caller) msg.sender', async () => {
    const session = new SolidityDebugSession();
    await session.launch(mixedInputs());
    // Drive to a depth-2 position inside the Callee frame.
    session.setBreakpoints({source: {path: CALLEE_PATH}, breakpoints: [{line: 8}]});
    await session.continue();

    const frames = session.stackTrace().stackFrames;
    expect(frames).toHaveLength(2);
    expect(frames[0]!.source?.path).toBe(CALLEE_PATH); // inner (top)
    expect(frames[1]!.source?.path).toBe(CALLER_PATH); // outer (bottom)

    const innerSender = await msgSenderOf(session, frames[0]!.id);
    const outerSender = await msgSenderOf(session, frames[1]!.id);

    // Outer frame: the tx sender (acct0). Inner frame (callee): the Caller
    // contract address — proving Globals is resolved per-frame, not tx-wide.
    expect(outerSender).toBe(ACCT0);
    expect(innerSender).toBe(MIXED_META.callerAddress.toLowerCase());
    expect(innerSender).not.toBe(outerSender);

    // gasleft() is also per-frame: the two frames are paused at different steps,
    // so their remaining gas differs. A tx-wide (single-step) implementation
    // would report the same value for both.
    const innerGas = await gasleftOf(session, frames[0]!.id);
    const outerGas = await gasleftOf(session, frames[1]!.id);
    expect(innerGas).toBeGreaterThan(0);
    expect(outerGas).toBeGreaterThan(0);
    expect(innerGas).not.toBe(outerGas);

    // msg.data is per-frame too: the callee sees Callee.compute(..) calldata,
    // the caller sees Caller.go(..) calldata — different selectors.
    const innerMsg = await groupChildren(
      session,
      await globalsRows(session, frames[0]!.id),
      'msg',
    );
    const outerMsg = await groupChildren(
      session,
      await globalsRows(session, frames[1]!.id),
      'msg',
    );
    const innerData = child(innerMsg, 'data').value;
    const outerData = child(outerMsg, 'data').value;
    expect(innerData.startsWith('0x')).toBe(true);
    expect(outerData.startsWith('0x')).toBe(true);
    expect(innerData).not.toBe(outerData);
  });
});

// ===========================================================================
// C) geth/anvil — anvil-setNumber: block group + tx.gasprice OMITTED
// ===========================================================================

const ANVIL_META = dbgFixtureJson<{
  contractAddress: string;
  txFrom: string;
  txTo: string;
  txInput: string;
}>('anvil-setNumber-meta.json');

function anvilInputs(): LaunchInputs {
  return {
    dialect: 'geth',
    txContext: {to: ANVIL_META.txTo, from: ANVIL_META.txFrom, input: ANVIL_META.txInput},
    buildInfoJson: solcFixture('counter-build-info.json'),
    traceJson: dbgFixtureText('anvil-setNumber-trace.raw.json'),
    sourcePath: 'src/Counter.sol',
    contractName: 'Counter',
    methodName: 'setNumber',
    codeAddress: ANVIL_META.txTo,
  } as unknown as LaunchInputs;
}

describe('Globals scope — geth/anvil (anvil-setNumber) omits unavailable data', () => {
  it('omits the block group and tx.gasprice; keeps msg, tx.origin, gasleft()', async () => {
    const session = new SolidityDebugSession();
    await session.launch(anvilInputs());
    const frameId = session.stackTrace().stackFrames[0]!.id;

    const rows = await globalsRows(session, frameId);
    const names = rows.map((r) => r.name);

    // No block group (geth carries no block context).
    expect(names).not.toContain('block');
    // Present: msg, tx, gasleft().
    expect(names).toEqual(['msg', 'tx', 'gasleft()']);

    // msg is fully available from the tx context.
    const msg = await groupChildren(session, rows, 'msg');
    expect(msg.map((v) => v.name)).toEqual(['sender', 'value', 'data', 'sig']);
    expect(child(msg, 'sender').value).toBe(ACCT0);
    expect(child(msg, 'value').value).toBe('0');
    expect(child(msg, 'data').value).toBe(ANVIL_META.txInput);
    expect(child(msg, 'sig').value).toBe(COUNTER_SIG);

    // tx has origin but NO gasprice (unavailable in geth).
    const tx = await groupChildren(session, rows, 'tx');
    expect(tx.map((v) => v.name)).toEqual(['origin']);
    expect(child(tx, 'origin').value).toBe(ACCT0);

    // gasleft() is always present (both dialects).
    const gasleft = rows.find((r) => r.name === 'gasleft()')!;
    expect(gasleft.variablesReference).toBe(0);
    expect(Number(gasleft.value)).toBeGreaterThan(0);
  });
});
