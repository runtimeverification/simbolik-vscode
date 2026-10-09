/**
 * DAP protocol dispatcher.
 *
 * Drives the ground-truth Counter.setNumber(42) handshake transcript through the
 * `DapDispatcher`, asserting the ordered outgoing message
 * stream (responses + events) produced by each `handle()` call, plus the global
 * invariants: strictly-increasing positive `seq`, `request_seq`/`command`
 * correlation, and single-emission of each session event across launch/continue.
 */
import type {DebugProtocol} from '@vscode/debugprotocol';
import {describe, expect, it} from 'vitest';

// `DapDispatcher` is the unit under test.
import {
  DapDispatcher,
  SolidityDebugSession,
  type LaunchInputs,
} from '../src/index.js';

import {toLaunchInputs, type Spec} from './support/harness.js';

// ## Fixtures + LaunchInputs

/** The Counter fixture bundle + entry coordinates the resolver launches. */
const counterSpec: Spec = {
  buildInfo: 'counter-build-info.json',
  trace: 'counter-setNumber-trace.raw.json',
  meta: 'counter-setNumber-meta.json',
  sourcePath: 'src/Counter.sol',
  contractName: 'Counter',
  methodName: 'setNumber',
};

function counterLaunchInputs(): LaunchInputs {
  return toLaunchInputs(counterSpec);
}

// ## Fake SessionResolver

/**
 * Build a fake resolver per the contract: it constructs a `SolidityDebugSession`,
 * `await`s `launch()` with the Counter inputs, and returns the already-launched
 * session (so the dispatcher must not re-launch — it drains the queued `stopped`
 * entry event instead). Tracks its call count so the pre-launch guard test can
 * assert it was never invoked.
 */
function makeFakeResolver(): {
  resolver: (
    args:
      | DebugProtocol.LaunchRequestArguments
      | DebugProtocol.AttachRequestArguments,
  ) => Promise<SolidityDebugSession>;
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    resolver: async () => {
      calls += 1;
      const session = new SolidityDebugSession();
      await session.launch(counterLaunchInputs());
      return session;
    },
  };
}

// ## Request builder + narrowing helpers

/** Monotonic client-side request seq (independent of the dispatcher's seq). */
let clientSeq = 0;
function request(command: string, args?: unknown): DebugProtocol.Request {
  return {seq: ++clientSeq, type: 'request', command, arguments: args};
}

function isResponse(m: DebugProtocol.ProtocolMessage): m is DebugProtocol.Response {
  return m.type === 'response';
}
function isEvent(m: DebugProtocol.ProtocolMessage): m is DebugProtocol.Event {
  return m.type === 'event';
}
function stoppedEvents(
  out: DebugProtocol.ProtocolMessage[],
): DebugProtocol.Event[] {
  return out.filter((m) => isEvent(m) && m.event === 'stopped');
}

// ## 1–11. The full handshake transcript

describe('DapDispatcher — Counter.setNumber transcript', () => {
  it('produces the correct ordered outgoing stream + global seq/request_seq invariants', async () => {
    const {resolver, calls} = makeFakeResolver();
    const dispatcher = new DapDispatcher(resolver);

    // All outgoing messages, in emission order, and every request we sent.
    const allOut: DebugProtocol.ProtocolMessage[] = [];
    const sent: DebugProtocol.Request[] = [];
    async function send(
      req: DebugProtocol.Request,
    ): Promise<DebugProtocol.ProtocolMessage[]> {
      sent.push(req);
      const out = await dispatcher.handle(req);
      allOut.push(...out);
      return out;
    }

    // ## 1. initialize → [response(caps), event 'initialized']
    const out1 = await send(request('initialize', {adapterID: 'simbolik'}));
    expect(out1).toHaveLength(2);
    const [initResp, initEvt] = out1;
    expect(isResponse(initResp!)).toBe(true);
    expect((initResp as DebugProtocol.Response).command).toBe('initialize');
    expect((initResp as DebugProtocol.Response).success).toBe(true);
    const caps = (initResp as DebugProtocol.InitializeResponse).body!;
    expect(caps.supportsConfigurationDoneRequest).toBe(true);
    // Disassembly View support: instruction-granular stepping + breakpoints.
    expect(caps.supportsSteppingGranularity).toBe(true);
    expect(caps.supportsInstructionBreakpoints).toBe(true);
    expect(caps.supportsDisassembleRequest).toBe(true);
    // "Dynamic" breakpoint filters (stop-on-call/create/revert/…).
    const filterIds = (caps.exceptionBreakpointFilters ?? []).map((f) => f.filter);
    expect(filterIds).toContain('break-on-call');
    expect(filterIds).toContain('break-on-revert');
    expect(isEvent(initEvt!)).toBe(true);
    expect((initEvt as DebugProtocol.Event).event).toBe('initialized');

    // ## 2. launch → [response(success), event 'stopped' entry]
    const out2 = await send(request('launch', {program: 'Counter'}));
    expect(calls()).toBe(1); // resolver invoked exactly once by launch
    expect(out2).toHaveLength(2);
    const [launchResp, stoppedEvt] = out2;
    expect((launchResp as DebugProtocol.Response).command).toBe('launch');
    expect((launchResp as DebugProtocol.Response).success).toBe(true);
    expect((stoppedEvt as DebugProtocol.Event).event).toBe('stopped');
    expect((stoppedEvt as DebugProtocol.StoppedEvent).body.reason).toBe('entry');
    expect((stoppedEvt as DebugProtocol.StoppedEvent).body.threadId).toBe(1);
    // The queued entry `stopped` is drained exactly once (not duplicated).
    expect(stoppedEvents(out2)).toHaveLength(1);

    // ## 3. threads → one thread id 1
    const out3 = await send(request('threads'));
    expect(out3).toHaveLength(1);
    const threadsBody = (out3[0] as DebugProtocol.ThreadsResponse).body;
    expect(threadsBody.threads).toHaveLength(1);
    expect(threadsBody.threads[0]!.id).toBe(1);

    // ## 4. stackTrace → 1 frame, line 8, src/Counter.sol, setNumber
    const out4 = await send(request('stackTrace', {threadId: 1}));
    const stBody = (out4[0] as DebugProtocol.StackTraceResponse).body;
    expect(stBody.stackFrames).toHaveLength(1);
    expect(stBody.totalFrames).toBe(1);
    const frame = stBody.stackFrames[0]!;
    expect(frame.line).toBe(8);
    expect(frame.source?.path).toBe('src/Counter.sol');
    expect(frame.name).toBe('setNumber');
    const frameId = frame.id;

    // ## 5. scopes → ['Locals','State','Globals','Events','EVM']
    const out5 = await send(request('scopes', {frameId}));
    const scopes = (out5[0] as DebugProtocol.ScopesResponse).body.scopes;
    expect(scopes.map((s) => s.name)).toEqual([
      'Locals',
      'State',
      'Globals',
      'Events',
      'EVM',
    ]);
    // Capture the State scope ref; the session binds handles to frame identity,
    // so this same ref re-resolves against the current step after `continue` —
    // it is reused verbatim at step 6 (entry) and step 8 (terminal).
    const stateRef = scopes.find((s) => s.name === 'State')!.variablesReference;

    // ## 6. variables(State) → number = '0' at entry
    const out6 = await send(
      request('variables', {variablesReference: stateRef}),
    );
    const vars6 = (out6[0] as DebugProtocol.VariablesResponse).body.variables;
    expect(vars6).toContainEqual(
      expect.objectContaining({name: 'number', value: '0'}),
    );

    // ## 7. continue → [response(allThreadsContinued), event 'stopped']
    const out7 = await send(request('continue', {threadId: 1}));
    expect(out7).toHaveLength(2);
    const [contResp, contStopped] = out7;
    expect((contResp as DebugProtocol.Response).success).toBe(true);
    expect((contResp as DebugProtocol.ContinueResponse).body.allThreadsContinued).toBe(
      true,
    );
    expect((contStopped as DebugProtocol.Event).event).toBe('stopped');
    // Only the new stopped event is drained here — the entry event is not
    // re-emitted (drain cursor advances past already-sent events).
    expect(stoppedEvents(out7)).toHaveLength(1);

    // ## 8. variables(State) again → number = '42' post-continue
    const out8 = await send(
      request('variables', {variablesReference: stateRef}),
    );
    const vars8 = (out8[0] as DebugProtocol.VariablesResponse).body.variables;
    expect(vars8).toContainEqual(
      expect.objectContaining({name: 'number', value: '42'}),
    );

    // ## 9. disconnect → [response, event 'terminated']
    const out9 = await send(request('disconnect'));
    expect(out9).toHaveLength(2);
    const [discResp, termEvt] = out9;
    expect((discResp as DebugProtocol.Response).success).toBe(true);
    expect((termEvt as DebugProtocol.Event).event).toBe('terminated');

    // ## 10. unknown command → single error response, no throw
    const frob = request('frobnicate');
    sent.push(frob);
    const frobPromise = dispatcher.handle(frob);
    await expect(frobPromise).resolves.toBeDefined();
    const out10 = await frobPromise;
    allOut.push(...out10);
    expect(out10).toHaveLength(1);
    expect(isResponse(out10[0]!)).toBe(true);
    expect((out10[0] as DebugProtocol.Response).success).toBe(false);

    // ## 11a. seq strictly increasing positive integers across the run
    let prevSeq = 0;
    for (const m of allOut) {
      expect(typeof m.seq).toBe('number');
      expect(Number.isInteger(m.seq)).toBe(true);
      expect(m.seq).toBeGreaterThan(prevSeq);
      prevSeq = m.seq;
    }

    // ## 11b. every response correlates to its originating request
    for (const m of allOut) {
      if (!isResponse(m)) continue;
      const origin = sent.find((q) => q.seq === m.request_seq);
      expect(origin).toBeDefined();
      expect(m.command).toBe(origin!.command);
    }

    // ## 11c. each event is emitted exactly once across the whole stream
    // Guards the drain cursor globally: the entry `stopped` queued at launch
    // must not reappear on any intervening handler (threads/stackTrace/scopes/
    // variables) — the per-call length checks above only cover out2/out3/out7,
    // so a re-emission on e.g. stackTrace would otherwise slip through.
    const events = allOut.filter(isEvent);
    expect(events.filter((e) => e.event === 'initialized')).toHaveLength(1);
    expect(events.filter((e) => e.event === 'terminated')).toHaveLength(1);
    const allStopped = events.filter(
      (e) => e.event === 'stopped',
    ) as DebugProtocol.StoppedEvent[];
    // Exactly two across the transcript: the launch `entry` stop and the
    // single post-`continue` stop — no session event drained twice.
    expect(allStopped).toHaveLength(2);
    expect(
      allStopped.filter((e) => e.body.reason === 'entry'),
    ).toHaveLength(1);
  });
});

// ## Source request → serves frame source content

describe('DapDispatcher — source request', () => {
  it('returns the content for a frame sourceReference', async () => {
    const {resolver} = makeFakeResolver();
    const dispatcher = new DapDispatcher(resolver);
    await dispatcher.handle(request('initialize', {}));
    await dispatcher.handle(request('launch', {program: 'Counter'}));

    const st = await dispatcher.handle(request('stackTrace', {threadId: 1}));
    const frame = (st[0] as DebugProtocol.StackTraceResponse).body
      .stackFrames[0]!;
    const ref = frame.source!.sourceReference!;
    expect(ref).toBeGreaterThan(0);

    // VSCode sends the reference both top-level and nested under `source`.
    const out = await dispatcher.handle(
      request('source', {sourceReference: ref, source: {sourceReference: ref}}),
    );
    expect(out).toHaveLength(1);
    const resp = out[0] as DebugProtocol.SourceResponse;
    expect(resp.success).toBe(true);
    expect(resp.body.content).toContain('contract Counter');
  });

  it('answers source before launch with an error response (no session)', async () => {
    const {resolver, calls} = makeFakeResolver();
    const dispatcher = new DapDispatcher(resolver);
    const out = await dispatcher.handle(request('source', {sourceReference: 1}));
    expect((out[0] as DebugProtocol.Response).success).toBe(false);
    expect(calls()).toBe(0);
  });
});

// ## Exception / instruction breakpoint routing

describe('DapDispatcher — setExceptionBreakpoints', () => {
  it('routes to the session and acknowledges the active filters', async () => {
    const {resolver} = makeFakeResolver();
    const dispatcher = new DapDispatcher(resolver);
    await dispatcher.handle(request('initialize', {}));
    await dispatcher.handle(request('launch', {program: 'Counter'}));

    const out = await dispatcher.handle(
      request('setExceptionBreakpoints', {filters: ['break-on-call']}),
    );
    expect(out).toHaveLength(1);
    expect((out[0] as DebugProtocol.Response).success).toBe(true);
  });

  it('errors before launch (session-guarded), leaving the resolver uncalled', async () => {
    const {resolver, calls} = makeFakeResolver();
    const dispatcher = new DapDispatcher(resolver);
    const out = await dispatcher.handle(
      request('setExceptionBreakpoints', {filters: []}),
    );
    expect((out[0] as DebugProtocol.Response).success).toBe(false);
    expect(calls()).toBe(0);
  });
});

describe('DapDispatcher — setInstructionBreakpoints', () => {
  it('routes to the session and echoes a verified breakpoint', async () => {
    const {resolver} = makeFakeResolver();
    const dispatcher = new DapDispatcher(resolver);
    await dispatcher.handle(request('initialize', {}));
    await dispatcher.handle(request('launch', {program: 'Counter'}));

    // Use the entry frame's own instruction pointer as a valid reference.
    const st = await dispatcher.handle(request('stackTrace', {threadId: 1}));
    const ref = (st[0] as DebugProtocol.StackTraceResponse).body.stackFrames[0]!
      .instructionPointerReference!;
    expect(ref).toBeTruthy();

    const out = await dispatcher.handle(
      request('setInstructionBreakpoints', {
        breakpoints: [{instructionReference: ref}],
      }),
    );
    const resp = out[0] as DebugProtocol.SetInstructionBreakpointsResponse;
    expect(resp.success).toBe(true);
    expect(resp.body.breakpoints[0]!.verified).toBe(true);
  });
});

// ## Pre-launch guard

describe('DapDispatcher — pre-launch guard', () => {
  it('answers stackTrace before launch with an error response (no session, no throw)', async () => {
    const {resolver, calls} = makeFakeResolver();
    const dispatcher = new DapDispatcher(resolver);

    const p = dispatcher.handle(request('stackTrace', {threadId: 1}));
    await expect(p).resolves.toBeDefined();
    const out = await p;

    expect(out).toHaveLength(1);
    expect(isResponse(out[0]!)).toBe(true);
    expect((out[0] as DebugProtocol.Response).command).toBe('stackTrace');
    expect((out[0] as DebugProtocol.Response).success).toBe(false);
    // No launch happened, so the resolver was never called.
    expect(calls()).toBe(0);
  });
});

// ## handle() never throws — a session method that throws (e.g. sparse args)
// becomes an error response.

describe('DapDispatcher — handle() never throws out', () => {
  it('turns a throwing session call (setBreakpoints w/ missing arguments) into an error response', async () => {
    const {resolver} = makeFakeResolver();
    const dispatcher = new DapDispatcher(resolver);
    await dispatcher.handle(request('launch', {program: 'Counter'}));

    // A DAP client sending setBreakpoints without `arguments` would make
    // session.setBreakpoints deref `undefined.breakpoints` and throw. handle()
    // must catch and answer with an error response, not reject.
    const p = dispatcher.handle({
      seq: ++clientSeq,
      type: 'request',
      command: 'setBreakpoints',
    } as DebugProtocol.Request);
    await expect(p).resolves.toBeDefined();
    const out = await p;
    expect(out).toHaveLength(1);
    expect(isResponse(out[0]!)).toBe(true);
    expect((out[0] as DebugProtocol.Response).command).toBe('setBreakpoints');
    expect((out[0] as DebugProtocol.Response).success).toBe(false);
    expect(typeof (out[0] as DebugProtocol.Response).message).toBe('string');
  });

  it('handles sparse scopes/variables args without throwing (empty, sane responses)', async () => {
    const {resolver} = makeFakeResolver();
    const dispatcher = new DapDispatcher(resolver);
    await dispatcher.handle(request('launch', {program: 'Counter'}));

    // scopes with no frameId falls back to the deepest frame → non-empty scopes.
    const sc = await dispatcher.handle(request('scopes'));
    expect((sc[0] as DebugProtocol.Response).success).toBe(true);

    // variables with no variablesReference → unknown handle → empty list, no throw.
    const va = await dispatcher.handle(request('variables'));
    expect((va[0] as DebugProtocol.Response).success).toBe(true);
    expect((va[0] as DebugProtocol.VariablesResponse).body.variables).toEqual([]);
  });
});

// ## Resolver diagnostics → `output` events in the debug console

function outputEvents(
  out: DebugProtocol.ProtocolMessage[],
): DebugProtocol.OutputEvent[] {
  return out.filter(
    (m) => isEvent(m) && m.event === 'output',
  ) as DebugProtocol.OutputEvent[];
}

describe('DapDispatcher — resolver ctx.log surfaces as output events', () => {
  it('emits one output event per logged line, before the launch response, in order', async () => {
    const dispatcher = new DapDispatcher(async (_args, ctx) => {
      ctx?.log('Compiling …');
      ctx?.log('  → eth_sendTransaction (deploy)');
      const session = new SolidityDebugSession();
      await session.launch(counterLaunchInputs());
      return session;
    });

    const out = await dispatcher.handle(request('launch', {program: 'Counter'}));

    const outputs = outputEvents(out);
    expect(outputs.map((e) => e.body.output)).toEqual([
      'Compiling …\n',
      '  → eth_sendTransaction (deploy)\n',
    ]);
    // Category defaults to 'console'; a trailing newline is ensured.
    expect(outputs[0]!.body.category).toBe('console');

    // Ordering: both output events precede the launch response, which precedes
    // the drained `stopped` entry event.
    const kinds = out.map((m) =>
      isEvent(m) ? `event:${m.event}` : `response:${(m as DebugProtocol.Response).command}`,
    );
    expect(kinds).toEqual([
      'event:output',
      'event:output',
      'response:launch',
      'event:stopped',
    ]);

    // Global invariant: strictly-increasing positive seq across the batch.
    const seqs = out.map((m) => m.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs[0]).toBeGreaterThan(0);
  });

  it('streams logged lines via the emitter sink (not in the return array) when one is wired', async () => {
    const dispatcher = new DapDispatcher(async (_args, ctx) => {
      ctx?.log('Compiling …');
      ctx?.log('  → eth_sendTransaction (deploy)');
      const session = new SolidityDebugSession();
      await session.launch(counterLaunchInputs());
      return session;
    });

    // Wire a streaming sink before handling launch.
    const streamed: DebugProtocol.ProtocolMessage[] = [];
    dispatcher.setEmitter(m => streamed.push(m));
    // Host-side diagnostics flushed via emitConsole share the same stream + seq.
    dispatcher.emitConsole('Execution node: kontrol-node');

    const out = await dispatcher.handle(request('launch', {program: 'Counter'}));

    // The output events were streamed (fired via the sink), in order, and are
    // therefore not duplicated in the launch return array.
    expect(streamed.map(m => (m as DebugProtocol.OutputEvent).body.output)).toEqual([
      'Execution node: kontrol-node\n',
      'Compiling …\n',
      '  → eth_sendTransaction (deploy)\n',
    ]);
    expect(outputEvents(out)).toHaveLength(0);
    expect(out.map(m => (isEvent(m) ? `event:${m.event}` : `response:${(m as DebugProtocol.Response).command}`))).toEqual([
      'response:launch',
      'event:stopped',
    ]);

    // seq is shared across streamed + returned messages and strictly increasing.
    const allSeqs = [...streamed, ...out].map(m => m.seq);
    expect(allSeqs).toEqual([...allSeqs].sort((a, b) => a - b));
  });

  it('still emits the logged lines before the error response when the resolver fails', async () => {
    const dispatcher = new DapDispatcher(async (_args, ctx) => {
      ctx?.log('Compiling …');
      ctx?.log('  → eth_sendTransaction (deploy)');
      throw new Error('node unreachable');
    });

    const out = await dispatcher.handle(request('launch', {program: 'Counter'}));

    expect(outputEvents(out).map((e) => e.body.output)).toEqual([
      'Compiling …\n',
      '  → eth_sendTransaction (deploy)\n',
    ]);
    const resp = out.find(isResponse) as DebugProtocol.Response;
    expect(resp.command).toBe('launch');
    expect(resp.success).toBe(false);
    expect(resp.message).toContain('node unreachable');
  });
});
