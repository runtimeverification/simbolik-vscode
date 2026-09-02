import {spawn, type ChildProcess} from 'node:child_process';
import {JsonRpcClient, describeCause, type FetchLike} from './jsonRpcClient.js';

/** How to launch the `kontrol-node` process. */
export interface KontrolNodeLaunch {
  command: string;
  args: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Launch recipe for the dev-container-provisioned engine:
 *   cd $KONTROL_NODE_DIR
 *   nix develop --command bash -c '.venv/bin/kontrol-node run --port <p> --steps-tracing'
 *
 * The nix dev shell supplies the K runtime (`kompile` etc.); the venv supplies
 * the `kontrol-node` CLI. `KDIST_DIR` must point at the pre-built KEVM
 * semantics (`<dir>/.kdist`), otherwise every RPC call fails with
 * "Target undefined or not built: kontrol-node.simbolik". We set it explicitly
 * rather than rely on ambient container env. See
 * `.devcontainer/setup-kontrol-node.sh`.
 */
export function devcontainerLaunch(
  port: number,
  kontrolNodeDir = process.env.KONTROL_NODE_DIR ?? '/home/node/kontrol-node',
): KontrolNodeLaunch {
  return {
    command: 'nix',
    args: [
      'develop',
      '--command',
      'bash',
      '-c',
      `.venv/bin/kontrol-node run --port ${port} --steps-tracing`,
    ],
    cwd: kontrolNodeDir,
    env: {
      ...process.env,
      NIX_CONFIG: 'experimental-features = nix-command flakes',
      KDIST_DIR: process.env.KDIST_DIR || `${kontrolNodeDir}/.kdist`,
    },
  };
}

/**
 * Launch recipe for a local Foundry `anvil` node with opcode-step tracing:
 *   anvil --host 127.0.0.1 --port <p> --steps-tracing
 *
 * `--steps-tracing` is required or `debug_traceTransaction` returns empty
 * `structLogs`. `anvilPath` defaults to the bare command name (resolved on
 * `PATH`); override it to point at a specific binary.
 */
export function anvilLaunch(
  port: number,
  anvilPath = 'anvil',
  host = '127.0.0.1',
): KontrolNodeLaunch {
  return {
    command: anvilPath,
    args: ['--host', host, '--port', String(port), '--steps-tracing'],
    env: {...process.env},
  };
}

export interface KontrolNodeOptions {
  port: number;
  host?: string;
  launch: KontrolNodeLaunch;
  /** Max time to wait for the node to accept RPC before failing `start()`. */
  readyTimeoutMs?: number;
  /** Poll interval while waiting for readiness. */
  readyPollMs?: number;
  /** Injectable for tests. */
  spawnFn?: typeof spawn;
  /** Injectable for tests (passed through to the readiness client). */
  fetch?: FetchLike;
  /**
   * When set, the child is spawned with piped stdio and every stdout/stderr
   * chunk is forwarded here (e.g. to a VSCode OutputChannel). When omitted the
   * child's output is discarded (`stdio: 'ignore'`).
   */
  onLog?: (chunk: string) => void;
}

const sleep = (ms: number) =>
  new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Owns a `kontrol-node` child process and exposes an RPC client to it.
 *
 * kontrol-node prints no "listening" banner, so readiness is detected by
 * polling `eth_chainId` until it answers (or `readyTimeoutMs` elapses).
 */
export class KontrolNode {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly client: JsonRpcClient;

  readonly #launch: KontrolNodeLaunch;
  readonly #readyTimeoutMs: number;
  readonly #readyPollMs: number;
  readonly #spawnFn: typeof spawn;
  readonly #onLog?: (chunk: string) => void;
  #proc?: ChildProcess;
  /** A spawn-level failure (e.g. `ENOENT` — binary not found), captured async. */
  #spawnError?: Error;

  constructor(opts: KontrolNodeOptions) {
    this.host = opts.host ?? '127.0.0.1';
    this.port = opts.port;
    this.url = `http://${this.host}:${this.port}`;
    this.client = new JsonRpcClient({url: this.url, fetch: opts.fetch});
    this.#launch = opts.launch;
    this.#readyTimeoutMs = opts.readyTimeoutMs ?? 120_000;
    this.#readyPollMs = opts.readyPollMs ?? 500;
    this.#spawnFn = opts.spawnFn ?? spawn;
    this.#onLog = opts.onLog;
  }

  /** Spawn the process (detached, own group) and wait until it accepts RPC. */
  async start(): Promise<void> {
    const piped = this.#onLog !== undefined;
    this.#proc = this.#spawnFn(this.#launch.command, this.#launch.args, {
      cwd: this.#launch.cwd,
      env: this.#launch.env,
      detached: true,
      stdio: piped ? ['ignore', 'pipe', 'pipe'] : 'ignore',
    });
    // A missing binary / permission error surfaces asynchronously as an 'error'
    // event; capture it so #waitUntilReady fails fast with the real reason
    // instead of polling to the timeout. (Guarded: test stubs omit `.on`.)
    this.#proc.on?.('error', (err: Error) => {
      this.#spawnError = err;
    });
    if (piped) {
      const forward = (chunk: Buffer | string) =>
        this.#onLog?.(chunk.toString());
      this.#proc.stdout?.on('data', forward);
      this.#proc.stderr?.on('data', forward);
    }
    await this.#waitUntilReady();
  }

  async #waitUntilReady(): Promise<void> {
    const deadline = Date.now() + this.#readyTimeoutMs;
    let lastErr: unknown;
    // Poll until the node answers eth_chainId, the deadline passes, or the
    // child exits early / fails to spawn.
    for (;;) {
      if (this.#spawnError !== undefined) {
        throw new Error(
          `failed to start node (${this.#launch.command}): ${describeCause(this.#spawnError)}`,
        );
      }
      if (this.#proc?.exitCode != null) {
        throw new Error(
          `node exited during startup (code ${this.#proc.exitCode})`,
        );
      }
      try {
        await this.client.call('eth_chainId');
        return;
      } catch (err) {
        lastErr = err;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `kontrol-node not ready after ${this.#readyTimeoutMs}ms: ${String(lastErr)}`,
        );
      }
      await sleep(this.#readyPollMs);
    }
  }

  /** Kill the process group. Safe to call more than once. */
  async stop(): Promise<void> {
    const proc = this.#proc;
    this.#proc = undefined;
    if (!proc || proc.pid == null || proc.exitCode != null) return;
    try {
      process.kill(-proc.pid, 'SIGTERM');
    } catch {
      // Group already gone; try the direct pid as a fallback.
      try {
        proc.kill('SIGTERM');
      } catch {
        /* already dead */
      }
    }
  }
}
