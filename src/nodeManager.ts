import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as net from 'node:net';
import {execFile} from 'node:child_process';
import {
  ManagedNode,
  anvilLaunch,
  devcontainerLaunch,
  type NodeLaunch,
} from '@simbolik/engine';
import {getConfigValue} from './utils';

type RpcNodeType = 'anvil' | 'kontrol-node';

/** A launch recipe plus an early-detection pre-flight for its binary/config. */
interface Recipe {
  launch: NodeLaunch;
  /** Throw a clear, actionable error if the node cannot possibly start. */
  preflight: () => Promise<void>;
}

/**
 * Owns the execution node (anvil / kontrol-node) for each debug session: one
 * fresh node per session, started automatically so the "Debug" code lens stays
 * one click. Follows VSCode conventions for third-party programs — the binary
 * path is configurable, missing binaries / bad config are detected EARLY with an
 * actionable message (rather than surfacing later as an opaque "fetch failed"),
 * and the node's output is streamed to a dedicated OutputChannel.
 *
 * The chosen JSON-RPC URL flows back through the debug configuration, so the
 * server-side resolver (inline or tcp) simply connects to it — the manager needs
 * no knowledge of the adapter transport.
 */
export class DebugNodeManager {
  #channel: vscode.LogOutputChannel | undefined;
  /** sessionId → the node started for it. */
  readonly #nodes = new Map<string, ManagedNode>();

  /**
   * Ensure a node is running for `sessionId` and return the JSON-RPC URL the
   * debug session should use. When `auto-start-node` is disabled the user
   * manages their own node, so the configured `json-rpc-url` is returned as-is.
   *
   * @throws a user-facing error (missing binary, bad config, failed startup) —
   *   the caller lets it abort the session, so VSCode shows it as a notification.
   */
  async ensureUrl(
    sessionId: string,
    rpcNodeType: RpcNodeType
  ): Promise<string> {
    if (!getConfigValue<boolean>('auto-start-node', true)) {
      return getConfigValue('json-rpc-url', 'http://localhost:8545');
    }

    // A restart reuses the session id; tear down any previous node first.
    await this.stop(sessionId);

    const port = await freePort();
    const {launch, preflight} = this.#recipe(rpcNodeType, port);

    // EARLY detection: fail here (before spawning / waiting for readiness) with a
    // message that names the setting to fix.
    await preflight();

    const channel = this.#getChannel();
    channel.info(`[${rpcNodeType}] starting on 127.0.0.1:${port} …`);
    const node = new ManagedNode({
      port,
      launch,
      onLog: chunk => channel.append(chunk),
    });

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Simbolik: starting ${rpcNodeType} …`,
          cancellable: false,
        },
        () => node.start()
      );
    } catch (err) {
      await node.stop();
      const reason = err instanceof Error ? err.message : String(err);
      channel.error(`[${rpcNodeType}] failed to start: ${reason}`);
      throw new Error(
        `Could not start ${rpcNodeType}: ${reason}. See the "Simbolik Node" output for details.`
      );
    }

    this.#nodes.set(sessionId, node);
    channel.info(`[${rpcNodeType}] ready at ${node.url}`);
    return node.url;
  }

  /** Stop and forget the node for `sessionId` (safe if none is running). */
  async stop(sessionId: string): Promise<void> {
    const node = this.#nodes.get(sessionId);
    if (node === undefined) return;
    this.#nodes.delete(sessionId);
    await node.stop();
    this.#getChannel().info(`[node] stopped (session ${sessionId})`);
  }

  /** Kill every managed node — called when the extension deactivates. */
  dispose(): void {
    for (const node of this.#nodes.values()) void node.stop();
    this.#nodes.clear();
    this.#channel?.dispose();
  }

  /** Build the launch recipe + pre-flight check for the requested node type. */
  #recipe(rpcNodeType: RpcNodeType, port: number): Recipe {
    if (rpcNodeType === 'kontrol-node') {
      const dir =
        getConfigValue('kontrol-node-dir', '') ||
        process.env.KONTROL_NODE_DIR ||
        '/home/node/kontrol-node';
      return {
        launch: devcontainerLaunch(port, dir),
        preflight: async () => {
          if (!fs.existsSync(dir)) {
            throw new Error(
              `kontrol-node directory not found: "${dir}". Provision it with ` +
                '.devcontainer/setup-kontrol-node.sh, or set the ' +
                '"simbolik.kontrol-node-dir" setting.'
            );
          }
          await requireExecutable(
            'nix',
            'kontrol-node is launched through Nix, but "nix" was not found on ' +
              'PATH. Install Nix, or debug a non-test function (which uses anvil).'
          );
        },
      };
    }

    const anvilPath = getConfigValue('anvil-path', 'anvil');
    return {
      launch: anvilLaunch(port, anvilPath),
      preflight: () =>
        requireExecutable(
          anvilPath,
          `Anvil was not found (tried "${anvilPath}"). Install Foundry ` +
            '(https://getfoundry.sh), or set the "simbolik.anvil-path" setting.'
        ),
    };
  }

  #getChannel(): vscode.LogOutputChannel {
    if (this.#channel === undefined) {
      this.#channel = vscode.window.createOutputChannel('Simbolik Node', {
        log: true,
      });
    }
    return this.#channel;
  }
}

/** Ask the OS for a free TCP port by binding to 0 and reading it back. */
function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (addr === null || typeof addr === 'string') {
        srv.close(() => reject(new Error('could not determine a free port')));
        return;
      }
      const {port} = addr;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Verify `command` can be executed, throwing `message` if it is missing or not
 * executable. Probes `command --version`; a non-zero EXIT is fine (the binary
 * ran), only spawn-level failures (`ENOENT`/`EACCES`) mean it is unusable.
 */
function requireExecutable(command: string, message: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    execFile(command, ['--version'], {timeout: 5000}, err => {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT' || code === 'EACCES') {
        reject(new Error(message));
        return;
      }
      resolve();
    });
  });
}
