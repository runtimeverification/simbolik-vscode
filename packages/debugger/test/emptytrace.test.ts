/**
 * A 0-step trace fails fast at `launch` with a clear, actionable error instead
 * of building a degenerate stepping model that later throws a cryptic
 * "Cannot destructure property 'stmtId' of undefined" on the first step command.
 *
 * A typical trigger is an oversized test contract (>180 KB runtime) whose
 * deploy fails for want of gas, leaving the entry address code-less, so the
 * traced call executes zero EVM instructions. The launch resolver rejects a
 * failed deploy earlier; this guard covers every other 0-step path (geth
 * attach, a call to an EOA, …).
 */
import {describe, expect, it} from 'vitest';

import {SolidityDebugSession, type LaunchInputs} from '../src/index.js';

import {buildInfoOf} from './support/harness.js';

const BUILD_INFO_JSON: unknown = buildInfoOf('counter-build-info.json');

/** A well-formed `debug_traceTransaction` response whose execution has 0 steps. */
const EMPTY_TRACE_RAW = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  result: {structLogs: [], gas: 0, failed: false, returnValue: ''},
});

function emptyLaunchInputs(): LaunchInputs {
  return {
    buildInfoJson: BUILD_INFO_JSON,
    traceJson: EMPTY_TRACE_RAW,
    sourcePath: 'src/Counter.sol',
    contractName: 'Counter',
    methodName: 'setNumber',
    codeAddress: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
  };
}

describe('SolidityDebugSession.launch with a 0-step trace', () => {
  it('rejects with an explanatory error (not a stmtId destructure crash)', async () => {
    const session = new SolidityDebugSession();
    await expect(session.launch(emptyLaunchInputs())).rejects.toThrow(
      /executed no instructions/i,
    );
  });

  it('names the code-less entry address in the error', async () => {
    const session = new SolidityDebugSession();
    await expect(session.launch(emptyLaunchInputs())).rejects.toThrow(
      /0x5fbdb2315678afecb367f032d93f642f64180aa3/,
    );
  });

  it('does not leak the low-level "stmtId" destructure failure', async () => {
    const session = new SolidityDebugSession();
    await expect(session.launch(emptyLaunchInputs())).rejects.not.toThrow(
      /stmtId/,
    );
  });
});
