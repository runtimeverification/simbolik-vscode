/**
 * Entry module of the debug server, bundled separately as ESM to
 * `build/server.mjs`.
 *
 * `@simbolik/debugger` transitively imports `@ethdebug/pointers`, which uses
 * top-level await, and esbuild cannot emit that into the extension's CJS bundle.
 * The extension therefore reaches this module at runtime, in one of two ways:
 *
 *   - inline mode: a dynamic `import()` from the adapter factory (see
 *     `serverBridge.ts`);
 *   - tcp mode: `node <path>/server.mjs --port <p>` as a child process (this
 *     module's `main()`).
 *
 * This module must not import `vscode`: it also runs as a standalone Node
 * process, where `vscode` does not exist.
 *
 * The default `SessionResolver` is {@link productionResolver}, assembled from
 * `./resolver/*`; callers may inject their own via `createDispatcher` /
 * `startServer`.
 */
import {
  DapDispatcher,
  startDapServer,
  SolidityDebugSession,
  type SessionResolver,
  type DapServerHandle,
  type LaunchInputs,
} from '@simbolik/debugger';

import {attachInputs} from './resolver/attach';
import {launchInputs} from './resolver/launch';
import type {LaunchArgs} from './resolver/launchArgs';

// Re-export the pieces the host (extension) needs to reference by type/value.
export {
  DapDispatcher,
  startDapServer,
  SolidityDebugSession,
  type SessionResolver,
  type DapServerHandle,
  type LaunchInputs,
};

/**
 * A resolver that always throws, for deliberately disabling resolution: a
 * session that reaches `launch`/`attach` then fails with an explanatory error.
 */
export const notWiredResolver: SessionResolver = async () => {
  throw new Error(
    'Simbolik debug server: no live SessionResolver is wired yet ' +
      '(forge build → kontrol-node → trace). Inject a resolver via ' +
      'createDispatcher(resolve) / startServer({resolve}).'
  );
};

/**
 * Turn DAP launch/attach args into an already-launched
 * {@link SolidityDebugSession}. `launch` deploys the target contract, calls the
 * method and traces it (see `./resolver/launch`); `attach` replays an
 * already-mined tx from a generic node, resolving each frame's sources via
 * Sourcify (see `./resolver/attach`).
 */
export const productionResolver: SessionResolver = async (rawArgs, ctx) => {
  const args = (rawArgs ?? {}) as LaunchArgs;
  const inputs =
    args.request === 'attach'
      ? await attachInputs(args, ctx)
      : await launchInputs(args, ctx);
  const session = new SolidityDebugSession();
  await session.launch(inputs);
  ctx?.log('Session ready — paused at entry.');
  return session;
};

/**
 * Create a {@link DapDispatcher} for inline (in-process) hosting. The extension
 * host drives the returned dispatcher's `handle()` directly (no socket).
 *
 * @param resolve resolves DAP launch/attach args into an already-launched
 *   {@link SolidityDebugSession}. Defaults to {@link productionResolver}.
 */
export function createDispatcher(
  resolve: SessionResolver = productionResolver
): DapDispatcher {
  return new DapDispatcher(resolve);
}

/**
 * Start the DAP server for tcp (out-of-process) hosting. Wraps
 * {@link startDapServer} with the same default-resolver behavior as
 * {@link createDispatcher}.
 */
export function startServer(opts: {
  port: number;
  host?: string;
  resolve?: SessionResolver;
}): Promise<DapServerHandle> {
  return startDapServer({
    port: opts.port,
    host: opts.host,
    resolve: opts.resolve ?? productionResolver,
  });
}

/** Parse `--port <n>` (and optional `--host <h>`) from an argv tail. */
function parseArgs(argv: string[]): {port: number; host?: string} {
  let port = 0;
  let host: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') port = Number(argv[++i]);
    else if (argv[i] === '--host') host = argv[++i];
  }
  return {port, host};
}

/**
 * TCP-mode entry: `node server.mjs --port <p> [--host <h>]`. Starts the DAP TCP
 * server and keeps the process alive; prints the bound port so a parent process
 * can discover an OS-assigned port (`--port 0`).
 */
async function main(): Promise<void> {
  const {port, host} = parseArgs(process.argv.slice(2));
  const handle = await startServer({port, host});
  // A parent (the extension in tcp mode) reads this line to learn the port.
  console.log(`simbolik-debug-server listening port=${handle.port}`);
  const shutdown = () => {
    // A signal-driven CLI shutdown must end the process even if some handle
    // (a pending socket, a timer) would keep the event loop alive.
    // eslint-disable-next-line n/no-process-exit
    void handle.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Run main() only when executed directly as a script, never on import:
// `import.meta.url` equals the URL of `argv[1]` when run as `node server.mjs`.
const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMainModule) {
  main().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
