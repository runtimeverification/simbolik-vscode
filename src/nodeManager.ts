import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ManagedNode,
  nixProfileBinDirs,
  probeKontrolNode,
  tailLines,
  type Probe,
} from '@simbolik/engine';
import {
  INSTALL_GUIDE_URL,
  checkNodeSetup,
  type NodeSetup,
  type NodeType,
  type SetupAction,
  type SetupProblem,
} from './nodeSetup';
import {getConfigValue} from './utils';

/** A node started for a session, plus the scratch directory it runs in. */
interface Running {
  node: ManagedNode;
  workDir: string | undefined;
}

/**
 * Owns the execution node (anvil / kontrol-node) for each debug session: one
 * fresh node per session, started automatically so the "Debug" code lens stays
 * one click. Follows VSCode conventions for third-party programs — the binary
 * path is configurable and defaults to the command on `PATH`, a missing or
 * broken install is detected BEFORE the session starts with an actionable
 * message (see `nodeSetup.ts`), and the node's output is streamed to a
 * dedicated OutputChannel.
 *
 * The chosen JSON-RPC URL flows back through the debug configuration, so the
 * server-side resolver (inline or tcp) simply connects to it — the manager needs
 * no knowledge of the adapter transport.
 */
export class DebugNodeManager {
  #channel: vscode.LogOutputChannel | undefined;
  /** sessionId → the node started for it. */
  readonly #nodes = new Map<string, Running>();

  /**
   * Check that `rpcNodeType` can be started, BEFORE a debug session exists. On
   * a problem, show it with buttons that fix it and return false; the caller
   * then cancels the launch, so this notification is the only one the user
   * sees. Always true when the user runs their own node (`auto-start-node` off).
   */
  async checkSetup(rpcNodeType: NodeType): Promise<boolean> {
    if (!getConfigValue<boolean>('auto-start-node', true)) return true;
    const setup = await this.#setup(rpcNodeType);
    if (setup.ok) return true;
    this.#report(setup);
    return false;
  }

  /**
   * Ensure a node is running for `sessionId` and return the JSON-RPC URL the
   * debug session should use. When `auto-start-node` is disabled the user
   * manages their own node, so the configured `json-rpc-url` is returned as-is.
   *
   * @throws a user-facing error (missing binary, bad config, failed startup) —
   *   the caller lets it abort the session, so VSCode shows it as a notification.
   */
  async ensureUrl(sessionId: string, rpcNodeType: NodeType): Promise<string> {
    if (!getConfigValue<boolean>('auto-start-node', true)) {
      return getConfigValue('json-rpc-url', 'http://localhost:8545');
    }

    // A restart reuses the session id; tear down any previous node first.
    await this.stop(sessionId);

    // Normally already checked (and cached) by `checkSetup`; a restart or a
    // setting changed since then is caught here.
    const setup = await this.#setup(rpcNodeType);
    if (!setup.ok) {
      this.#report(setup);
      throw new Error(setup.message);
    }

    const channel = this.#getChannel();
    const port = await freePort();
    const workDir = setup.needsWorkDir
      ? fs.mkdtempSync(path.join(os.tmpdir(), `simbolik-${rpcNodeType}-`))
      : undefined;
    channel.info(`[${rpcNodeType}] ${setup.description}`);
    channel.info(
      `[${rpcNodeType}] starting on 127.0.0.1:${port}` +
        (workDir === undefined ? ' …' : ` in ${workDir} …`)
    );
    const node = new ManagedNode({
      port,
      launch: setup.launch(port, workDir),
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
      removeLater(workDir);
      const reason = err instanceof Error ? err.message : String(err);
      channel.error(`[${rpcNodeType}] failed to start: ${reason}`);
      // The node's own output says why; put it in front of the user.
      channel.show(true);
      throw new Error(
        `Could not start ${rpcNodeType}: ${tailLines(reason, 1)}. See the ` +
          '"Simbolik Node" output for its full log.'
      );
    }

    this.#nodes.set(sessionId, {node, workDir});
    channel.info(`[${rpcNodeType}] ready at ${node.url}`);
    return node.url;
  }

  /** Stop and forget the node for `sessionId` (safe if none is running). */
  async stop(sessionId: string): Promise<void> {
    const running = this.#nodes.get(sessionId);
    if (running === undefined) return;
    this.#nodes.delete(sessionId);
    await running.node.stop();
    removeLater(running.workDir);
    this.#getChannel().info(`[node] stopped (session ${sessionId})`);
  }

  /** Kill every managed node — called when the extension deactivates. */
  dispose(): void {
    for (const {node, workDir} of this.#nodes.values()) {
      void node.stop();
      removeLater(workDir);
    }
    this.#nodes.clear();
    this.#channel?.dispose();
  }

  /** The launch recipe for `rpcNodeType` from the current settings, or why there is none. */
  async #setup(rpcNodeType: NodeType): Promise<NodeSetup | SetupProblem> {
    return checkNodeSetup(rpcNodeType, {
      kontrolNodePath: getConfigValue('kontrol-node-path', ''),
      kontrolNodeDir: getConfigValue('kontrol-node-dir', ''),
      anvilPath: getConfigValue('anvil-path', ''),
      env: process.env,
      fallbackDirs: nixProfileBinDirs(),
      probe: probeCache,
    });
  }

  /** Log a setup problem's details and show it with its fix-it buttons. */
  #report(problem: SetupProblem): void {
    const channel = this.#getChannel();
    channel.error(problem.message);
    for (const line of problem.details) channel.appendLine(line);

    const labels = new Map<string, SetupAction>();
    for (const action of problem.actions)
      labels.set(actionLabel(action), action);
    void vscode.window
      .showErrorMessage(problem.message, ...labels.keys())
      .then(choice => {
        const action = choice === undefined ? undefined : labels.get(choice);
        if (action !== undefined) void this.#run(action);
      });
  }

  async #run(action: SetupAction): Promise<void> {
    switch (action.kind) {
      case 'install-guide':
        await vscode.env.openExternal(vscode.Uri.parse(INSTALL_GUIDE_URL));
        return;
      case 'open-setting':
        await vscode.commands.executeCommand(
          'workbench.action.openSettings',
          action.setting
        );
        return;
      case 'show-output':
        this.#getChannel().show();
        return;
    }
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

function actionLabel(action: SetupAction): string {
  switch (action.kind) {
    case 'install-guide':
      return 'Installation Guide';
    case 'open-setting':
      return 'Open Settings';
    case 'show-output':
      return 'Show Output';
  }
}

/**
 * `kontrol-node version` takes about a second, and both `checkSetup` and
 * `ensureUrl` run it; a binary that passed is not re-probed until it changes.
 */
const passedProbes = new Map<string, {mtimeMs: number; probe: Probe}>();
async function probeCache(binary: string): Promise<Probe> {
  const {mtimeMs} = fs.statSync(binary);
  const cached = passedProbes.get(binary);
  if (cached?.mtimeMs === mtimeMs) return cached.probe;
  const probe = await probeKontrolNode(binary);
  if (probe.ok) passedProbes.set(binary, {mtimeMs, probe});
  return probe;
}

/**
 * Delete a node's scratch directory once its processes have had time to exit
 * (`stop()` only signals them): kontrol-node leaves a 28–250 MB `io_dir*` in
 * it on every run.
 */
function removeLater(workDir: string | undefined): void {
  if (workDir === undefined) return;
  setTimeout(() => {
    fs.rm(workDir, {recursive: true, force: true, maxRetries: 3}, () => {});
  }, 3000).unref();
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
