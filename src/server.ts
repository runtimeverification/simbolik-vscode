/**
 * The ESM server ENTRY MODULE (bundled to `build/server.mjs`).
 *
 * This is the seam that lets the CJS VSCode extension use the bundled
 * TypeScript debug server (`@simbolik/debugger`) despite the top-level-await
 * blocker: `@simbolik/debugger` transitively imports `@ethdebug/pointers`,
 * which uses TOP-LEVEL AWAIT. esbuild refuses to emit TLA into a `cjs` bundle
 * ("Top-level await is not supported with the cjs output format"), so the
 * extension cannot statically import the server. Instead we bundle the server
 * SEPARATELY as ESM (`--format=esm`, which permits TLA) and the CJS extension
 * reaches it at runtime:
 *
 *   - inline mode: `await import('./server.mjs')` from the adapter factory
 *     (a dynamic import from CJS → local ESM, supported by Node 22).
 *   - tcp mode:    spawn `node <path>/server.mjs --port <p>` as a child process
 *     (this module's `main()`).
 *
 * IMPORTANT: this module MUST NOT import `vscode` — it runs both in-process in
 * the extension host AND as a standalone Node process, and `vscode` only exists
 * in the former. Keep the VSCode boundary in the extension (`src/`), not here.
 *
 * SCOPE: this module is the build/dynamic-import seam plus a thin entry. The
 * live `SessionResolver` (forge build → kontrol-node → trace →
 * `SolidityDebugSession`) is {@link productionResolver}, assembled from
 * `./resolver/*` and used by default; callers may inject their own via
 * `createDispatcher` / `startServer`.
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
 * An explicit "not wired" resolver: throws a clear, actionable error rather than
 * silently doing nothing, so a session that reaches `launch`/`attach` without a
 * real resolver fails loudly with the reason. The default resolver is
 * {@link productionResolver}; inject this only to deliberately disable resolution.
 */
export const notWiredResolver: SessionResolver = async () => {
  throw new Error(
    'Simbolik debug server: no live SessionResolver is wired yet ' +
      '(forge build → kontrol-node → trace). Inject a resolver via ' +
      'createDispatcher(resolve) / startServer({resolve}).'
  );
};

/**
 * The LIVE resolver: turn DAP launch/attach args into an already-launched
 * {@link SolidityDebugSession}. `launch` deploys the target contract, calls the
 * method and traces it (see `./resolver/launch`); `attach` replays an
 * already-mined tx from a generic node, resolving each frame's sources via
 * Sourcify + recompile (see `./resolver/attach`). Runs INSIDE the server
 * (inline or spawned) — hence `vscode`-free.
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
 * Create a {@link DapDispatcher} for INLINE (in-process) hosting. The extension
 * host calls this after `await import('./server.mjs')` and drives the returned
 * dispatcher's `handle()` directly (no socket).
 *
 * @param resolve resolves DAP launch/attach args into an already-launched
 *   {@link SolidityDebugSession}. Defaults to {@link productionResolver} (the
 *   live deploy → call → trace flow); inject a different resolver for tests.
 */
export function createDispatcher(
  resolve: SessionResolver = productionResolver
): DapDispatcher {
  return new DapDispatcher(resolve);
}

/**
 * Start the DAP TCP server for TCP (out-of-process) hosting. Wraps
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

// Run main() ONLY when executed directly as a script (ESM-safe detection),
// never on import. `import.meta.url` is the file URL of THIS module; `argv[1]`
// is the script Node was told to run — equal when run as `node server.mjs`.
const isMainModule =
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (isMainModule) {
  main().catch(err => {
    console.error(err);
    process.exitCode = 1;
  });
}
