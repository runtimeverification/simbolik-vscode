/**
 * DAP protocol dispatcher.
 *
 * Consumes raw DAP `ProtocolMessage`s and produces the correct ordered
 * response + event stream, wrapping the typed {@link SolidityDebugSession}. This
 * is the single component both adapter transports (in-process inline and
 * standalone TCP) host. Pure w.r.t. its own state: it owns the monotonic `seq`
 * counter, the current session, and a drain cursor over the session's
 * append-only `events` array — no globals.
 */
import type {DebugProtocol} from '@vscode/debugprotocol';

import {
  SolidityDebugSession,
  EXCEPTION_BREAKPOINT_FILTERS,
} from './session.js';

/** DAP `output` event categories the resolver may log into. */
export type OutputCategory = 'console' | 'stdout' | 'stderr';

/**
 * Side channel the dispatcher hands the resolver so it can surface diagnostics
 * (compilation, chosen backend, RPC traffic) in the client's debug console. Each
 * `log` line is turned into an `output` event emitted alongside the launch
 * response.
 */
export interface ResolveContext {
  log: (output: string, category?: OutputCategory) => void;
}

/**
 * Resolves DAP launch/attach args into a READY (already-launched) session
 * (production: run the engine; tests: build from a recorded fixture). The
 * dispatcher does NOT call `launch()` itself — the resolver returns a session
 * that has already queued its entry `stopped` event. The optional {@link
 * ResolveContext} lets the resolver stream diagnostics to the debug console.
 */
export type SessionResolver = (
  args:
    | DebugProtocol.LaunchRequestArguments
    | DebugProtocol.AttachRequestArguments,
  ctx?: ResolveContext,
) => Promise<SolidityDebugSession>;

/** Commands that require a live session; rejected with an error before launch. */
const SESSION_COMMANDS = new Set<string>([
  'configurationDone',
  'threads',
  'stackTrace',
  'scopes',
  'variables',
  'source',
  'disassemble',
  'next',
  'stepIn',
  'stepOut',
  'stepBack',
  'stepInstruction',
  'stepBackInstruction',
  'continue',
  'reverseContinue',
  'setBreakpoints',
  'setInstructionBreakpoints',
  'setExceptionBreakpoints',
  'disconnect',
]);

export class DapDispatcher {
  readonly #resolve: SessionResolver;
  /** Monotonic seq assigned to every outgoing message, across all handle() calls. */
  #seq = 1;
  #session: SolidityDebugSession | undefined;
  /** Cursor into the current session's append-only `events` array. */
  #cursor = 0;
  /**
   * Optional sink for messages emitted OUTSIDE a `handle()` return value — used
   * to STREAM `output` events while a long-running `launch` is still resolving
   * (deploy → call → trace), so diagnostics appear live instead of arriving in
   * one batch when the session finally stops. Wired by each transport (the
   * inline adapter's event emitter / the TCP socket). When unset, launch
   * diagnostics fall back to being batched into the launch response array.
   */
  #emit: ((message: DebugProtocol.ProtocolMessage) => void) | undefined;

  constructor(resolve: SessionResolver) {
    this.#resolve = resolve;
  }

  /**
   * Register the streaming sink (see {@link #emit}). The transport calls this
   * once, right after constructing the dispatcher, before any `handle()`.
   */
  setEmitter(emit: (message: DebugProtocol.ProtocolMessage) => void): void {
    this.#emit = emit;
  }

  /**
   * Emit one `output`-event line to the debug console immediately via the
   * streaming sink (no-op if no sink is wired). Used by the transport to flush
   * host-side diagnostics (compile output, chosen backend) ahead of the
   * server-side launch diagnostics, sharing the dispatcher's `seq` sequence.
   */
  emitConsole(output: string, category: OutputCategory = 'console'): void {
    this.#emit?.(this.#outputEvent(output, category));
  }

  /**
   * Handle one incoming DAP message; return the ordered messages to send back
   * (a response, possibly followed by events). Never throws out of here — a
   * failure becomes an error response.
   */
  async handle(
    message: DebugProtocol.ProtocolMessage,
  ): Promise<DebugProtocol.ProtocolMessage[]> {
    const request = message as DebugProtocol.Request;
    const command = request.command;
    const args = request.arguments as Record<string, unknown> | undefined;

    // Guard: session-requiring commands received before launch → error, no throw,
    // and the resolver is never called.
    if (this.#session === undefined && SESSION_COMMANDS.has(command)) {
      return [this.#error(request, `no active session for request: ${command}`)];
    }

    // Backstop the documented invariant: any failure in a session call (e.g. a
    // DAP client sending sparse/missing `arguments`) becomes an error response
    // — handle() never rejects/throws out.
    try {
      return await this.#dispatch(request, command, args);
    } catch (err) {
      return [
        this.#error(request, err instanceof Error ? err.message : String(err)),
      ];
    }
  }

  /** Route one (session-guarded) request to the matching session call. */
  async #dispatch(
    request: DebugProtocol.Request,
    command: string,
    args: Record<string, unknown> | undefined,
  ): Promise<DebugProtocol.ProtocolMessage[]> {
    switch (command) {
      case 'initialize': {
        const capabilities: DebugProtocol.Capabilities = {
          supportsConfigurationDoneRequest: true,
          supportsStepBack: true,
          supportsSteppingGranularity: true,
          supportsDisassembleRequest: true,
          supportsInstructionBreakpoints: true,
          // "Dynamic" breakpoints (stop-on-call/create/revert/…) shown as
          // toggles in the Breakpoints panel; matched during continue.
          exceptionBreakpointFilters: EXCEPTION_BREAKPOINT_FILTERS.map((f) => ({
            filter: f.filter,
            label: f.label,
            description: f.description,
            default: false,
          })),
        };
        return [
          this.#response(request, capabilities),
          this.#dispatcherEvent('initialized'),
        ];
      }

      case 'launch':
      case 'attach': {
        // Diagnostics the resolver logs (chosen backend, RPC traffic) become
        // `output` events. With a streaming sink wired they are emitted LIVE as
        // they happen — so the console fills DURING the deploy → call → trace,
        // not all at once when the session stops. Without a sink (e.g. unit
        // tests) they fall back to being batched ahead of the response.
        const outputs: DebugProtocol.Event[] = [];
        const ctx: ResolveContext = {
          log: (output, category = 'console') => {
            const evt = this.#outputEvent(output, category);
            if (this.#emit) this.#emit(evt);
            else outputs.push(evt);
          },
        };
        let session: SolidityDebugSession;
        try {
          session = await this.#resolve(
            (args ?? {}) as DebugProtocol.LaunchRequestArguments,
            ctx,
          );
        } catch (err) {
          return [
            ...outputs,
            this.#error(request, err instanceof Error ? err.message : String(err)),
          ];
        }
        this.#session = session;
        this.#cursor = 0;
        return [...outputs, this.#response(request, {}), ...this.#drain()];
      }

      case 'configurationDone':
        return [this.#response(request, {})];

      case 'threads':
        return [this.#response(request, this.#requireSession().threads())];

      case 'stackTrace':
        return [this.#response(request, this.#requireSession().stackTrace())];

      case 'scopes':
        return [
          this.#response(
            request,
            this.#requireSession().scopes(args?.['frameId'] as number),
          ),
        ];

      case 'variables':
        return [
          this.#response(
            request,
            await this.#requireSession().variables(
              args?.['variablesReference'] as number,
            ),
          ),
        ];

      case 'disassemble':
        return [
          this.#response(
            request,
            this.#requireSession().disassemble(
              args as unknown as Parameters<
                SolidityDebugSession['disassemble']
              >[0],
            ),
          ),
        ];

      case 'source': {
        // VSCode may send the reference top-level or nested under `source`.
        const sourceArg = args?.['source'] as
          | {sourceReference?: number}
          | undefined;
        const ref =
          (args?.['sourceReference'] as number | undefined) ??
          sourceArg?.sourceReference;
        return [
          this.#response(request, this.#requireSession().source(ref as number)),
        ];
      }

      case 'next':
        this.#requireSession().next(args);
        return [this.#response(request, {}), ...this.#drain()];

      case 'stepIn':
        this.#requireSession().stepIn(args);
        return [this.#response(request, {}), ...this.#drain()];

      case 'stepOut':
        this.#requireSession().stepOut(args);
        return [this.#response(request, {}), ...this.#drain()];

      case 'stepBack':
        this.#requireSession().stepBack(args);
        return [this.#response(request, {}), ...this.#drain()];

      case 'continue':
        this.#requireSession().continue(args);
        return [
          this.#response(request, {allThreadsContinued: true}),
          ...this.#drain(),
        ];

      case 'reverseContinue':
        this.#requireSession().reverseContinue(args);
        return [
          this.#response(request, {allThreadsContinued: true}),
          ...this.#drain(),
        ];

      case 'setBreakpoints':
        return [
          this.#response(
            request,
            this.#requireSession().setBreakpoints(
              args as unknown as Parameters<
                SolidityDebugSession['setBreakpoints']
              >[0],
            ),
          ),
        ];

      case 'setInstructionBreakpoints':
        return [
          this.#response(
            request,
            this.#requireSession().setInstructionBreakpoints(
              args as unknown as Parameters<
                SolidityDebugSession['setInstructionBreakpoints']
              >[0],
            ),
          ),
        ];

      case 'setExceptionBreakpoints':
        return [
          this.#response(
            request,
            this.#requireSession().setExceptionBreakpoints(
              (args ?? {}) as unknown as Parameters<
                SolidityDebugSession['setExceptionBreakpoints']
              >[0],
            ),
          ),
        ];

      case 'disconnect':
        this.#requireSession().disconnect();
        return [this.#response(request, {}), this.#dispatcherEvent('terminated')];

      default:
        return [this.#error(request, `unsupported request: ${command}`)];
    }
  }

  // ─── outgoing message builders ─────────────────────────────────────────────

  /** Build a success response for `request` carrying `body`. */
  #response(
    request: DebugProtocol.Request,
    body: unknown,
  ): DebugProtocol.Response {
    return {
      seq: this.#seq++,
      type: 'response',
      request_seq: request.seq,
      command: request.command,
      success: true,
      body,
    };
  }

  /** Build a failure response for `request` with a human-readable `message`. */
  #error(
    request: DebugProtocol.Request,
    message: string,
  ): DebugProtocol.Response {
    return {
      seq: this.#seq++,
      type: 'response',
      request_seq: request.seq,
      command: request.command,
      success: false,
      message,
    };
  }

  /** Build a dispatcher-generated event (`initialized`/`terminated`) with no body. */
  #dispatcherEvent(event: string): DebugProtocol.Event {
    return {seq: this.#seq++, type: 'event', event};
  }

  /** Build an `output` event that renders one line in the client's debug console. */
  #outputEvent(output: string, category: OutputCategory): DebugProtocol.Event {
    return {
      seq: this.#seq++,
      type: 'event',
      event: 'output',
      body: {category, output: output.endsWith('\n') ? output : `${output}\n`},
    } as DebugProtocol.OutputEvent;
  }

  /**
   * Drain the session's newly-queued events (`events[cursor..]`), reassigning a
   * fresh dispatcher `seq` to each, and advance the cursor so each session event
   * is emitted exactly once.
   */
  #drain(): DebugProtocol.Event[] {
    const session = this.#requireSession();
    const pending = session.events.slice(this.#cursor);
    this.#cursor = session.events.length;
    return pending.map((e) => ({
      seq: this.#seq++,
      type: 'event',
      event: e.event,
      body: e.body,
    }));
  }

  #requireSession(): SolidityDebugSession {
    if (this.#session === undefined) {
      throw new Error('no active session');
    }
    return this.#session;
  }
}
