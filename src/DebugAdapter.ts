import {spawn, type ChildProcessByStdio} from 'child_process';
import type {Readable} from 'stream';
import * as path from 'path';
import * as vscode from 'vscode';
import type {DapDispatcher} from '@simbolik/debugger';
import {loadServer} from './serverBridge';
import {getConfigValue} from './utils';
import {DebugNodeManager} from './nodeManager';
import {
  PartialDebugConfiguration,
  populateDebugConfiguration,
} from './startDebugging';

// How long to wait for a spawned tcp server to announce its port before giving up.
const SERVER_START_TIMEOUT = 10_000;

/**
 * The local debug-adapter factory. It drives the BUNDLED TypeScript
 * debug server (`build/server.mjs`, source `src/server.ts`) instead of the old
 * remote WebSocket service. Two hosting modes, selected by
 * `simbolik.adapterMode`:
 *
 *   - `inline` (default): dynamic-import the ESM server in-process
 *     ({@link loadServer}) and drive its {@link DapDispatcher} directly through a
 *     thin {@link DispatcherAdapter} (no socket).
 *   - `tcp`: spawn `node build/server.mjs --port 0` and connect over TCP via
 *     `vscode.DebugAdapterServer`.
 *
 * In BOTH modes the launch configuration is first populated
 * ({@link populateDebugConfiguration}: forge build → method signature → payload)
 * and flows to the server's `productionResolver` as the DAP launch arguments.
 */
export class SolidityDebugAdapterDescriptorFactory
  implements vscode.DebugAdapterDescriptorFactory
{
  #outputChannel: vscode.OutputChannel | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly nodes: DebugNodeManager
  ) {}

  async createDebugAdapterDescriptor(
    session: vscode.DebugSession,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    executable: vscode.DebugAdapterExecutable | undefined
  ): Promise<vscode.ProviderResult<vscode.DebugAdapterDescriptor>> {
    // Populate the launch config (build + method signature + payload). For
    // `attach` the configuration is already complete and passed through as-is.
    const config =
      session.configuration.request === 'launch'
        ? await populateDebugConfiguration(
            session.configuration as PartialDebugConfiguration
          )
        : session.configuration;

    // For `launch`, auto-start a fresh execution node for this session and point
    // the config at it (unless the user opted out via `auto-start-node`). Runs
    // AFTER populate so a fast config error (e.g. build failure) short-circuits
    // before we spawn anything; a node failure throws, aborting the session with
    // a clear notification. `attach` replays a remote tx and needs no local node.
    if (config.request === 'launch') {
      const full = config as import('./startDebugging').FullDebugConfiguration;
      full.jsonRpcUrl = await this.nodes.ensureUrl(
        session.id,
        full.rpcNodeType
      );
    }

    const mode = getConfigValue<'inline' | 'tcp'>('adapterMode', 'inline');
    if (mode === 'tcp') {
      // VSCode sends `session.configuration` as the launch arguments and talks
      // to the socket directly (no per-message adapter wrapper in tcp mode), so
      // merge the populated fields onto it in place so they reach the resolver.
      Object.assign(session.configuration, config);
      return this.#createTcp();
    }
    return this.#createInline(config);
  }

  /** Inline: load the ESM server in-process and wrap its dispatcher. */
  async #createInline(
    config: vscode.DebugConfiguration
  ): Promise<vscode.DebugAdapterDescriptor> {
    const server = await loadServer();
    const dispatcher = server.createDispatcher();
    return new vscode.DebugAdapterInlineImplementation(
      new DispatcherAdapter(dispatcher, config)
    );
  }

  /**
   * TCP: spawn the bundled server as a standalone node process and connect over
   * a socket. VSCode talks to the socket directly, so the populated config is
   * merged onto `session.configuration` (the object VSCode sends as the launch
   * arguments) rather than intercepted per-message.
   */
  async #createTcp(): Promise<vscode.DebugAdapterDescriptor> {
    const serverPath = path.join(
      this.context.extensionPath,
      'build',
      'server.mjs'
    );
    const channel = this.#channel();
    const child = spawn(process.execPath, [serverPath, '--port', '0'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const port = await waitForPort(child, channel);
    return new vscode.DebugAdapterServer(port);
  }

  #channel(): vscode.OutputChannel {
    if (this.#outputChannel === undefined) {
      this.#outputChannel = vscode.window.createOutputChannel(
        'Simbolik Debug Server'
      );
      this.context.subscriptions.push(this.#outputChannel);
    }
    return this.#outputChannel;
  }
}

/**
 * Wait until the spawned server prints its `listening port=<n>` line, then
 * resolve the bound port. stderr is streamed to the output channel; an early
 * exit or timeout rejects.
 */
function waitForPort(
  child: ChildProcessByStdio<null, Readable, Readable>,
  channel: vscode.OutputChannel
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      done(() => {
        child.kill();
        reject(new Error('Timed out starting the Simbolik debug server.'));
      });
    }, SERVER_START_TIMEOUT);

    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const match = buffer.match(/listening port=(\d+)/);
      if (match) {
        done(() => resolve(Number(match[1])));
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => channel.append(chunk));
    child.once('error', err => done(() => reject(err)));
    child.once('exit', code =>
      done(() =>
        reject(
          new Error(`Simbolik debug server exited early (code ${code}).`)
        )
      )
    );
  });
}

/**
 * Adapts a {@link DapDispatcher} to the `vscode.DebugAdapter` interface for
 * inline hosting: incoming DAP messages are handed to `dispatcher.handle()` and
 * each outgoing message it returns is fired back to VSCode. The populated launch
 * configuration is merged into the `launch`/`attach` request arguments so it
 * reaches the server's resolver (VSCode sends only the partial configuration).
 */
class DispatcherAdapter implements vscode.DebugAdapter {
  #emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  onDidSendMessage = this.#emitter.event;
  /**
   * One-slot promise chain serializing dispatch, mirroring the tcp server's
   * per-connection queue (`tcpServer.ts`). VSCode pipelines several requests on a
   * stop (`stackTrace`/`scopes`/multiple async `variables`), and a step command's
   * response + `stopped` event must not interleave with a still-pending async
   * `variables` from the previous stop — all of which share the dispatcher's
   * `seq`/`session`/`cursor` state. Serializing guarantees each `handle()` runs to
   * completion, and its outputs fire, in arrival order.
   */
  #queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly dispatcher: DapDispatcher,
    private readonly config: vscode.DebugConfiguration
  ) {}

  handleMessage(message: vscode.DebugProtocolMessage): void {
    const msg = message as {
      command?: string;
      arguments?: Record<string, unknown>;
    };
    if (msg.command === 'launch' || msg.command === 'attach') {
      msg.arguments = Object.assign(msg.arguments ?? {}, this.config);
    }
    // Enqueue behind any in-flight dispatch. handle() never rejects (it maps
    // failures to error responses); the catch is a defensive backstop.
    this.#queue = this.#queue
      .then(() =>
        this.dispatcher.handle(
          message as Parameters<DapDispatcher['handle']>[0]
        )
      )
      .then(outs => {
        for (const out of outs) {
          this.#emitter.fire(out as unknown as vscode.DebugProtocolMessage);
        }
      })
      .catch((err: unknown) => {
        console.error('Simbolik dispatcher error:', err);
      });
  }

  dispose(): void {
    this.#emitter.dispose();
  }
}
