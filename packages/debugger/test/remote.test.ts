/**
 * Geth-dialect launch through the full debugger pipeline.
 *
 * The session must accept `dialect: 'geth'` + a `txContext` on `LaunchInputs`
 * and drive the SAME pipeline it uses for kontrol traces, reading `number = 42`
 * (storage slot 0) and `newNumber = 42` (calldata[4:36]) from a REAL recorded
 * anvil (geth-format) trace — identically to the kontrol Counter path.
 *
 * The geth envelope has none of the rich fields `normalizeKontrolTrace` reads, so
 * `launch` routes geth traces through the geth normalizer to produce a valid step
 * model from them.
 *
 * A light back-compat test confirms a kontrol launch (no `dialect`) still works.
 */
import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {SolidityDebugSession, type LaunchInputs} from '../src/index.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** REAL recorded anvil (geth) `debug_traceTransaction` response STRING. */
const ANVIL_TRACE_RAW = readFileSync(
  new URL('./fixtures/anvil-setNumber-trace.raw.json', import.meta.url),
  'utf8',
);

/** REAL recorded kontrol Counter trace STRING (back-compat). */
const KONTROL_TRACE_RAW = readFileSync(
  new URL('./fixtures/counter-setNumber-trace.raw.json', import.meta.url),
  'utf8',
);

/** solc standard-json build-info — Counter compiled from the SAME bytecode. */
const BUILD_INFO_JSON: unknown = JSON.parse(
  readFileSync(
    new URL('../../solc/test/fixtures/counter-build-info.json', import.meta.url),
    'utf8',
  ),
);

const ANVIL_META = JSON.parse(
  readFileSync(
    new URL('./fixtures/anvil-setNumber-meta.json', import.meta.url),
    'utf8',
  ),
) as {contractAddress: string; txFrom: string; txTo: string; txInput: string};

const KONTROL_META = JSON.parse(
  readFileSync(
    new URL('./fixtures/counter-setNumber-meta.json', import.meta.url),
    'utf8',
  ),
) as {contractAddress: string};

// ── LaunchInputs builders ─────────────────────────────────────────────────────

/** A geth-dialect launch driven by the tx context from the anvil meta. */
function gethLaunchInputs(): LaunchInputs {
  return {
    dialect: 'geth',
    txContext: {
      to: ANVIL_META.txTo,
      from: ANVIL_META.txFrom,
      input: ANVIL_META.txInput,
    },
    buildInfoJson: BUILD_INFO_JSON,
    traceJson: ANVIL_TRACE_RAW,
    sourcePath: 'src/Counter.sol',
    contractName: 'Counter',
    methodName: 'setNumber',
    // Entry frame code address == txContext.to for geth.
    codeAddress: ANVIL_META.txTo,
  } as LaunchInputs;
}

/** A kontrol launch (no dialect) — the back-compat shape. */
function kontrolLaunchInputs(): LaunchInputs {
  return {
    buildInfoJson: BUILD_INFO_JSON,
    traceJson: KONTROL_TRACE_RAW,
    sourcePath: 'src/Counter.sol',
    contractName: 'Counter',
    methodName: 'setNumber',
    codeAddress: KONTROL_META.contractAddress,
  };
}

/** Read a single scope's variables for the sole (entry) frame. */
async function scopeVars(
  session: SolidityDebugSession,
  scopeName: 'State' | 'Locals',
): Promise<{name: string; value: string}[]> {
  const frameId = session.stackTrace().stackFrames[0]!.id;
  const {scopes} = session.scopes(frameId);
  const scope = scopes.find((s) => s.name === scopeName)!;
  const {variables} = await session.variables(scope.variablesReference);
  return variables.map((v) => ({name: v.name, value: v.value}));
}

// ── geth-dialect launch ───────────────────────────────────────────────────────

describe('SolidityDebugSession geth-dialect launch (anvil trace)', () => {
  it('stops at the entry statement (line 8) with reason "entry"', async () => {
    const session = new SolidityDebugSession();
    await session.launch(gethLaunchInputs());

    const stopped = session.events.find((e) => e.event === 'stopped') as
      | {body: {reason: string}}
      | undefined;
    expect(stopped?.body.reason).toBe('entry');

    const {stackFrames} = session.stackTrace();
    expect(stackFrames).toHaveLength(1);
    expect(stackFrames[0]!.name).toBe('setNumber');
    expect(stackFrames[0]!.source?.path).toBe('src/Counter.sol');
    expect(stackFrames[0]!.line).toBe(8);
  });

  it('reads number = 42 (State) and newNumber = 42 (Locals) after continue()', async () => {
    const session = new SolidityDebugSession();
    await session.launch(gethLaunchInputs());
    await session.continue();

    const state = await scopeVars(session, 'State');
    expect(state).toContainEqual({name: 'number', value: '42'});

    const locals = await scopeVars(session, 'Locals');
    expect(locals).toContainEqual({name: 'newNumber', value: '42'});
  });
});

// ── back-compat: kontrol launch still works ────────────────────────────────────

describe('SolidityDebugSession kontrol launch (back-compat, no dialect)', () => {
  it('still reads number = 42 after continue()', async () => {
    const session = new SolidityDebugSession();
    await session.launch(kontrolLaunchInputs());
    await session.continue();

    const state = await scopeVars(session, 'State');
    expect(state).toContainEqual({name: 'number', value: '42'});
  });
});
