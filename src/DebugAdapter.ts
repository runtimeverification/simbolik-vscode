import {spawn, type ChildProcessByStdio} from 'child_process';
import type {Readable} from 'stream';
import * as path from 'path';
import * as vscode from 'vscode';
import type {DapDispatcher} from '@simbolik/debugger';
import {loadServer} from './serverBridge';
import {getConfigValue} from './utils';
import {DebugNodeManager} from './nodeManager';
import {
  FullDebugConfiguration,
  PartialDebugConfiguration,
  populateDebugConfiguration,
} from './startDebugging';

// How long to wait for a spawned tcp server to announce its port before giving up.
const SERVER_START_TIMEOUT = 10_000;

/**
 * The debug-adapter factory. It drives the bundled debug server
 * (`build/server.mjs`, source `src/server.ts`) in one of two hosting modes,
 * selected by `simbolik.adapterMode`:
 *
 *   - `inline` (default): dynamic-import the ESM server in-process
 *     ({@link loadServer}) and drive its {@link DapDispatcher} directly through a
 *     thin {@link DispatcherAdapter} (no socket).
 *   - `tcp`: spawn `node build/server.mjs --port 0` and connect over TCP via
 *     `vscode.DebugAdapterServer`.
 *
 * In both modes the launch configuration is first populated
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
    // Host-side diagnostics (compilation output, chosen backend) are produced
    // before the adapter exists, so buffer them here and flush to this session's
    // debug console once it starts. Server-side diagnostics (RPC traffic) flow
    // separately as DAP `output` events from the resolver.
    const hostLog: string[] = [];
    const log = (line: string) => hostLog.push(line);

    // Populate the launch config (build + method signature + payload). For
    // `attach` the configuration is already complete and passed through as-is.
    const config =
      session.configuration.request === 'launch'
        ? await populateDebugConfiguration(
            session.configuration as PartialDebugConfiguration,
            log
          )
        : session.configuration;

    // For `launch`, auto-start a fresh execution node for this session and point
    // the config at it (unless the user opted out via `auto-start-node`). Runs
    // after populating so a fast config error (e.g. build failure) short-circuits
    // before we spawn anything; a node failure throws, aborting the session with
    // a clear notification. `attach` replays a remote tx and needs no local node.
    if (config.request === 'launch') {
      const full = config as FullDebugConfiguration;
      full.jsonRpcUrl = await this.nodes.ensureUrl(
        session.id,
        full.rpcNodeType
      );
      log(`Execution node: ${full.rpcNodeType} at ${full.jsonRpcUrl}`);
    }

    const mode = getConfigValue<'inline' | 'tcp'>('adapterMode', 'inline');
    if (mode === 'tcp') {
      // VSCode sends `session.configuration` as the launch arguments and talks
      // to the socket directly (no per-message adapter wrapper in tcp mode), so
      // merge the populated fields onto it in place so they reach the resolver.
      // The host-side log can't be injected into the socket stream, so it falls
      // back to the debug console via `activeDebugConsole` on session start.
      Object.assign(session.configuration, config);
      this.#flushToDebugConsole(session.id, hostLog);
      return this.#createTcp();
    }
    // Inline: the adapter owns the emitter, so host logs stream through it as
    // `output` events — ordered ahead of the server-side launch diagnostics.
    return this.#createInline(config, hostLog);
  }

  /** Inline: load the ESM server in-process and wrap its dispatcher. */
  async #createInline(
    config: vscode.DebugConfiguration,
    hostLog: string[]
  ): Promise<vscode.DebugAdapterDescriptor> {
    const server = await loadServer();
    const dispatcher = server.createDispatcher();
    return new vscode.DebugAdapterInlineImplementation(
      new DispatcherAdapter(dispatcher, config, hostLog)
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

  /**
   * Flush buffered host-side diagnostics to the debug console of `sessionId`
   * once it starts. The console only exists after the session is live, so we
   * wait for `onDidStartDebugSession` (at which point the freshly-started session
   * is the active one) rather than writing during adapter creation. A timeout
   * disposes the listener if the session never starts (e.g. an early failure).
   */
  #flushToDebugConsole(sessionId: string, lines: string[]): void {
    if (lines.length === 0) return;
    const sub = vscode.debug.onDidStartDebugSession(started => {
      if (started.id !== sessionId) return;
      sub.dispose();
      clearTimeout(timer);
      const console = vscode.debug.activeDebugConsole;
      for (const line of lines) console.appendLine(line);
    });
    const timer = setTimeout(() => sub.dispose(), 30_000);
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
        reject(new Error(`Simbolik debug server exited early (code ${code}).`))
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
  /** Host-side diagnostics (compile output, chosen node), flushed once at launch. */
  #hostLog: string[];

  constructor(
    private readonly dispatcher: DapDispatcher,
    private readonly config: vscode.DebugConfiguration,
    hostLog: string[] = []
  ) {
    this.#hostLog = hostLog;
    // Let the dispatcher stream output events (live launch diagnostics) straight
    // to VSCode as they happen, rather than only in the handle() return batch.
    this.dispatcher.setEmitter(out =>
      this.#emitter.fire(out as unknown as vscode.DebugProtocolMessage)
    );
  }

  handleMessage(message: vscode.DebugProtocolMessage): void {
    const msg = message as {
      command?: string;
      arguments?: Record<string, unknown>;
    };
    const isLaunch = msg.command === 'launch' || msg.command === 'attach';
    if (isLaunch) {
      msg.arguments = Object.assign(msg.arguments ?? {}, this.config);
    }
    // Enqueue behind any in-flight dispatch. handle() never rejects (it maps
    // failures to error responses); the catch is a defensive backstop.
    this.#queue = this.#queue
      .then(() => {
        // Flush host-side diagnostics first (streamed via the dispatcher so they
        // share its seq sequence), so compile/node lines precede the server-side
        // RPC lines emitted during resolve.
        if (isLaunch && this.#hostLog.length > 0) {
          for (const line of this.#hostLog) this.dispatcher.emitConsole(line);
          this.#hostLog = [];
        }
        return this.dispatcher.handle(
          message as Parameters<DapDispatcher['handle']>[0]
        );
      })
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
