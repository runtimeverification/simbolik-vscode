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

import {CAPABILITIES, SolidityDebugSession} from './session.js';

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
  ctx?: ResolveContext
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
  'exceptionInfo',
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
    message: DebugProtocol.ProtocolMessage
  ): Promise<DebugProtocol.ProtocolMessage[]> {
    const request = message as DebugProtocol.Request;
    const command = request.command;
    const args = request.arguments as Record<string, unknown> | undefined;

    // Guard: session-requiring commands received before launch → error, no throw,
    // and the resolver is never called.
    if (this.#session === undefined && SESSION_COMMANDS.has(command)) {
      return [
        this.#error(request, `no active session for request: ${command}`),
      ];
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
    args: Record<string, unknown> | undefined
  ): Promise<DebugProtocol.ProtocolMessage[]> {
    switch (command) {
      case 'initialize':
        return [
          this.#response(request, CAPABILITIES),
          this.#dispatcherEvent('initialized'),
        ];

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
            ctx
          );
        } catch (err) {
          return [
            ...outputs,
            this.#error(
              request,
              err instanceof Error ? err.message : String(err)
            ),
          ];
        }
        this.#session = session;
        this.#cursor = 0;
        return [...outputs, this.#response(request, {}), ...this.#drain()];
      }

      case 'configurationDone':
        return [this.#response(request, {})];
    }

    if (!SESSION_COMMANDS.has(command)) {
      return [this.#error(request, `unsupported request: ${command}`)];
    }
    // Every remaining command runs against the live session. `args` is the
    // untyped DAP `arguments` object, passed through as each request's own
    // argument type (`a`).
    const session = this.#requireSession();
    const a = (args ?? {}) as never;
    const reply = (body: unknown): DebugProtocol.ProtocolMessage[] => [
      this.#response(request, body),
    ];
    /** A stepping command: acknowledge, then emit the session's stop event(s). */
    const moved = (body: unknown = {}): DebugProtocol.ProtocolMessage[] => [
      this.#response(request, body),
      ...this.#drain(),
    ];
    switch (command) {
      case 'threads':
        return reply(session.threads());
      case 'stackTrace':
        return reply(session.stackTrace());
      case 'scopes':
        return reply(session.scopes(args?.['frameId'] as number));
      case 'variables':
        return reply(
          await session.variables(args?.['variablesReference'] as number)
        );
      case 'disassemble':
        return reply(session.disassemble(a));
      case 'source': {
        // VSCode may send the reference top-level or nested under `source`.
        const sourceArg = args?.['source'] as
          | {sourceReference?: number}
          | undefined;
        const ref =
          (args?.['sourceReference'] as number | undefined) ??
          sourceArg?.sourceReference;
        return reply(session.source(ref as number));
      }
      case 'next':
        session.next(args);
        return moved();
      case 'stepIn':
        session.stepIn(args);
        return moved();
      case 'stepOut':
        session.stepOut(args);
        return moved();
      case 'stepBack':
        session.stepBack(args);
        return moved();
      case 'continue':
        session.continue(args);
        return moved({allThreadsContinued: true});
      case 'reverseContinue':
        session.reverseContinue(args);
        return moved({allThreadsContinued: true});
      case 'setBreakpoints':
        return reply(session.setBreakpoints(a));
      case 'setInstructionBreakpoints':
        return reply(session.setInstructionBreakpoints(a));
      case 'setExceptionBreakpoints':
        return reply(session.setExceptionBreakpoints(a));
      case 'exceptionInfo':
        return reply(session.exceptionInfo(a));
      case 'disconnect':
        session.disconnect();
        return [
          this.#response(request, {}),
          this.#dispatcherEvent('terminated'),
        ];

      default:
        return [this.#error(request, `unsupported request: ${command}`)];
    }
  }

  // ─── outgoing message builders ─────────────────────────────────────────────

  /** Build a success response for `request` carrying `body`. */
  #response(
    request: DebugProtocol.Request,
    body: unknown
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
    message: string
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
    return pending.map(e => ({
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
