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
 * Launch recipe for an installed `kontrol-node` (e.g. `kup install
 * kontrol-node`), which bundles the K runtime and the KEVM semantics:
 *   kontrol-node run --host 127.0.0.1 --port <p> --steps-tracing
 *
 * `binary` defaults to the bare command name (resolved on `PATH`). The node
 * writes an `io_dir*` scratch directory (28–250 MB) into its working directory
 * on every run and never removes it, so pass a throwaway `workDir` and delete
 * it after the node stops.
 */
export function kontrolNodeLaunch(
  port: number,
  binary = 'kontrol-node',
  workDir?: string,
  host = '127.0.0.1',
): KontrolNodeLaunch {
  return {
    command: binary,
    args: ['run', '--host', host, '--port', String(port), '--steps-tracing'],
    cwd: workDir,
    env: {...process.env},
  };
}

/**
 * Launch recipe for a development checkout of kontrol-node (the dev container's
 * provisioned engine):
 *   cd $KONTROL_NODE_DIR
 *   nix develop --command bash -c 'cd <workDir> && $KONTROL_NODE_DIR/.venv/bin/kontrol-node run --port <p> --steps-tracing'
 *
 * The nix dev shell supplies the K runtime (`kompile` etc.); the venv supplies
 * the `kontrol-node` CLI. `KDIST_DIR` must point at the pre-built KEVM
 * semantics (`<dir>/.kdist`), otherwise every RPC call fails with
 * "Target undefined or not built: kontrol-node.simbolik". We set it explicitly
 * rather than rely on ambient container env. See
 * `.devcontainer/setup-kontrol-node.sh`. `nix develop` must run in the checkout
 * (it holds the flake); the node itself runs in `workDir` when given, so its
 * `io_dir*` scratch directories do not pile up in the checkout (see
 * {@link kontrolNodeLaunch}).
 */
export function devcontainerLaunch(
  port: number,
  kontrolNodeDir = process.env.KONTROL_NODE_DIR ?? '/home/node/kontrol-node',
  workDir?: string,
): KontrolNodeLaunch {
  const run = `.venv/bin/kontrol-node run --port ${port} --steps-tracing`;
  const script =
    workDir === undefined
      ? run
      : `cd ${shellQuote(workDir)} && ${shellQuote(kontrolNodeDir)}/${run}`;
  return {
    command: 'nix',
    args: ['develop', '--command', 'bash', '-c', script],
    cwd: kontrolNodeDir,
    env: {
      ...process.env,
      NIX_CONFIG: 'experimental-features = nix-command flakes',
      KDIST_DIR: process.env.KDIST_DIR || `${kontrolNodeDir}/.kdist`,
    },
  };
}

/** Quote `s` as a single POSIX shell word. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Launch recipe for a local Foundry `anvil` node with opcode-step tracing:
 *   anvil --host 127.0.0.1 --port <p> --steps-tracing
 *     --gas-limit 10000000000 --disable-code-size-limit
 *
 * `--steps-tracing` is required or `debug_traceTransaction` returns empty
 * `structLogs`. `--gas-limit` (matching the server's `TX_GAS`) and
 * `--disable-code-size-limit` let anvil deploy the large test contracts Foundry
 * projects routinely produce (a `Test`/`Deployers` heir can have a >180 KB
 * runtime, over the 24576-byte EIP-170 limit, whose code-deposit gas exceeds the
 * default 30M block limit) — without them, the deploy silently fails and the
 * traced call has no code to execute. `anvilPath` defaults to the bare command
 * name (resolved on `PATH`); override it to point at a specific binary.
 */
export function anvilLaunch(
  port: number,
  anvilPath = 'anvil',
  host = '127.0.0.1',
): KontrolNodeLaunch {
  return {
    command: anvilPath,
    args: [
      '--host',
      host,
      '--port',
      String(port),
      '--steps-tracing',
      '--gas-limit',
      '10000000000',
      '--disable-code-size-limit',
    ],
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
   * Every stdout/stderr chunk of the child is forwarded here (e.g. to a VSCode
   * OutputChannel). The output is captured either way: its tail is quoted when
   * the node dies during startup.
   */
  onLog?: (chunk: string) => void;
}

/** How much of the child's latest output is kept for startup-failure reports. */
const OUTPUT_TAIL_CHARS = 4000;

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
  /** The latest {@link OUTPUT_TAIL_CHARS} of the child's stdout+stderr. */
  #outputTail = '';

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

  /**
   * The latest output of the node process (stdout and stderr interleaved,
   * truncated to the last few thousand characters).
   */
  get outputTail(): string {
    return this.#outputTail;
  }

  /** Spawn the process (detached, own group) and wait until it accepts RPC. */
  async start(): Promise<void> {
    this.#proc = this.#spawnFn(this.#launch.command, this.#launch.args, {
      cwd: this.#launch.cwd,
      env: this.#launch.env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // A missing binary / permission error surfaces asynchronously as an 'error'
    // event; capture it so #waitUntilReady fails fast with the real reason
    // instead of polling to the timeout. (Guarded: test stubs omit `.on`.)
    this.#proc.on?.('error', (err: Error) => {
      this.#spawnError = err;
    });
    const forward = (chunk: Buffer | string) => {
      const text = chunk.toString();
      this.#outputTail = (this.#outputTail + text).slice(-OUTPUT_TAIL_CHARS);
      this.#onLog?.(text);
    };
    this.#proc.stdout?.on('data', forward);
    this.#proc.stderr?.on('data', forward);
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
        const output = this.#outputTail.trim();
        throw new Error(
          `node exited during startup (code ${this.#proc.exitCode})` +
            (output === '' ? '' : `:\n${output}`),
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
          `${this.#launch.command} not ready after ${this.#readyTimeoutMs}ms: ${String(lastErr)}`,
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
