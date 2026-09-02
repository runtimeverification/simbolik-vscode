/**
 * DAP TCP server hosting a per-connection {@link DapDispatcher}.
 *
 * Drives the real `Content-Length: <n>\r\n\r\n<json>` wire format (LSP/DAP over a
 * socket) end to end against a `net.Socket` client: for each framed
 * `ProtocolMessage` request the server feeds a per-connection `DapDispatcher`
 * and writes every outgoing message (responses + events) framed the same way.
 *
 * The client-side framer here is deliberately independent of the server's:
 *  - `encodeFrame(msg)` renders one message to its wire bytes (byte length via
 *    `Buffer.byteLength`, header ASCII, body UTF-8);
 *  - `FrameReader` buffers arbitrary incoming chunks, splits on the header
 *    terminator `\r\n\r\n`, reads `Content-Length`, waits until the whole body
 *    has arrived, and yields one parsed JSON message at a time — so it is robust
 *    to BOTH several frames arriving in one packet and one frame split across
 *    packets, which are exactly the two server-side behaviours tests 7a/7b probe.
 */
import * as net from 'node:net';

import type {DebugProtocol} from '@vscode/debugprotocol';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {readFileSync} from 'node:fs';

// `startDapServer` + `DapServerHandle` are the units under test.
import {
  startDapServer,
  type DapServerHandle,
  SolidityDebugSession,
  type SessionResolver,
  type LaunchInputs,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Fixtures + fake SessionResolver (mirrors dispatcher.test.ts)
// ---------------------------------------------------------------------------

const TRACE_RAW = readFileSync(
  new URL('./fixtures/counter-setNumber-trace.raw.json', import.meta.url),
  'utf8',
);

const BUILD_INFO_JSON: unknown = JSON.parse(
  readFileSync(
    new URL('../../solc/test/fixtures/counter-build-info.json', import.meta.url),
    'utf8',
  ),
);

const META = JSON.parse(
  readFileSync(
    new URL('./fixtures/counter-setNumber-meta.json', import.meta.url),
    'utf8',
  ),
) as {contractAddress: string};

function counterLaunchInputs(): LaunchInputs {
  return {
    buildInfoJson: BUILD_INFO_JSON,
    traceJson: TRACE_RAW,
    sourcePath: 'src/Counter.sol',
    contractName: 'Counter',
    methodName: 'setNumber',
    codeAddress: META.contractAddress,
  };
}

/** Fake resolver: builds + launches a Counter session, ignoring the args. */
const fakeResolver: SessionResolver = async () => {
  const session = new SolidityDebugSession();
  await session.launch(counterLaunchInputs());
  return session;
};

// ---------------------------------------------------------------------------
// Client-side DAP framer (independent of the server's implementation)
// ---------------------------------------------------------------------------

type Msg = Record<string, unknown>;

/** Render one DAP message to `Content-Length: <byteLen>\r\n\r\n<json-utf8>`. */
function encodeFrame(msg: Msg): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.from(
    `Content-Length: ${body.length}\r\n\r\n`,
    'ascii',
  );
  return Buffer.concat([header, body]);
}

/**
 * Incremental reader: `push()` arbitrary socket chunks, `next()`/`take(n)` await
 * complete parsed messages. It buffers across chunk boundaries and drains as
 * many whole frames as the buffer currently holds — so multiple frames in one
 * chunk each surface, and a frame spanning several chunks surfaces once whole.
 */
class FrameReader {
  #buf: Buffer = Buffer.alloc(0);
  readonly #ready: Msg[] = [];
  readonly #waiters: Array<(m: Msg) => void> = [];

  push(chunk: Buffer): void {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    for (;;) {
      const sep = this.#buf.indexOf('\r\n\r\n');
      if (sep === -1) return; // header not complete yet
      const header = this.#buf.subarray(0, sep).toString('ascii');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) throw new Error(`no Content-Length header in: ${header}`);
      const len = Number(m[1]);
      const bodyStart = sep + 4;
      if (this.#buf.length < bodyStart + len) return; // body not complete yet
      const body = this.#buf
        .subarray(bodyStart, bodyStart + len)
        .toString('utf8');
      this.#buf = this.#buf.subarray(bodyStart + len);
      const msg = JSON.parse(body) as Msg;
      const waiter = this.#waiters.shift();
      if (waiter) waiter(msg);
      else this.#ready.push(msg);
    }
  }

  next(): Promise<Msg> {
    const queued = this.#ready.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  async take(n: number): Promise<Msg[]> {
    const out: Msg[] = [];
    for (let i = 0; i < n; i += 1) out.push(await this.next());
    return out;
  }
}

// ---------------------------------------------------------------------------
// Server + socket lifecycle (no leaked ports/sockets between tests)
// ---------------------------------------------------------------------------

let handle: DapServerHandle;
const openSockets: net.Socket[] = [];

beforeEach(async () => {
  handle = await startDapServer({port: 0, resolve: fakeResolver});
});

afterEach(async () => {
  for (const s of openSockets.splice(0)) s.destroy();
  await handle?.close();
});

/** Connect a socket + attach a FrameReader; resolves once connected. */
async function connect(): Promise<{socket: net.Socket; reader: FrameReader}> {
  const socket = net.connect(handle.port, '127.0.0.1');
  openSockets.push(socket);
  const reader = new FrameReader();
  socket.on('data', (d: Buffer) => reader.push(d));
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  return {socket, reader};
}

function req(seq: number, command: string, args?: unknown): Msg {
  return {seq, type: 'request', command, arguments: args};
}

const isResponse = (m: Msg): boolean => m['type'] === 'response';
const isEvent = (m: Msg): boolean => m['type'] === 'event';

// ---------------------------------------------------------------------------
// 1. Port assignment
// ---------------------------------------------------------------------------

describe('startDapServer — lifecycle', () => {
  it('assigns a real OS port when passed port 0', () => {
    expect(handle.port).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // 6. close() resolves and the server stops accepting connections
  // -------------------------------------------------------------------------
  it('close() resolves and the server then refuses new connections', async () => {
    const {port} = handle;
    await expect(handle.close()).resolves.toBeUndefined();

    // A subsequent connect to the (now closed) port must fail.
    await expect(
      new Promise<void>((resolve, reject) => {
        const s = net.connect(port, '127.0.0.1');
        s.once('connect', () => {
          s.destroy();
          resolve();
        });
        s.once('error', reject);
      }),
    ).rejects.toBeDefined();
  }, 10000);
});

// ---------------------------------------------------------------------------
// 3–5. Framed handshake over TCP: initialize → launch → disconnect
// ---------------------------------------------------------------------------

describe('startDapServer — framed DAP handshake', () => {
  it('answers initialize, launch and disconnect with framed responses + events', async () => {
    const {socket, reader} = await connect();

    // --- 3. initialize (seq 1) → response(caps) then event 'initialized' ----
    socket.write(encodeFrame(req(1, 'initialize', {adapterID: 'simbolik'})));
    const [initResp, initEvt] = await reader.take(2);
    expect(isResponse(initResp!)).toBe(true);
    expect(initResp!['command']).toBe('initialize');
    expect(initResp!['success']).toBe(true);
    expect(initResp!['request_seq']).toBe(1);
    expect(
      (initResp!['body'] as DebugProtocol.Capabilities)
        .supportsConfigurationDoneRequest,
    ).toBe(true);
    expect(isEvent(initEvt!)).toBe(true);
    expect(initEvt!['event']).toBe('initialized');

    // --- 4. launch (seq 2) → response(success) then event 'stopped' entry ---
    socket.write(encodeFrame(req(2, 'launch', {})));
    const [launchResp, stoppedEvt] = await reader.take(2);
    expect(isResponse(launchResp!)).toBe(true);
    expect(launchResp!['command']).toBe('launch');
    expect(launchResp!['success']).toBe(true);
    expect(launchResp!['request_seq']).toBe(2);
    expect(isEvent(stoppedEvt!)).toBe(true);
    expect(stoppedEvt!['event']).toBe('stopped');
    expect((stoppedEvt!['body'] as DebugProtocol.StoppedEvent['body']).reason).toBe(
      'entry',
    );

    // --- 5. disconnect (seq 3) → response then event 'terminated' -----------
    socket.write(encodeFrame(req(3, 'disconnect', {})));
    const [discResp, termEvt] = await reader.take(2);
    expect(isResponse(discResp!)).toBe(true);
    expect(discResp!['command']).toBe('disconnect');
    expect(discResp!['success']).toBe(true);
    expect(discResp!['request_seq']).toBe(3);
    expect(isEvent(termEvt!)).toBe(true);
    expect(termEvt!['event']).toBe('terminated');
  }, 10000);
});

// ---------------------------------------------------------------------------
// 7. Frame parser robustness (buffer boundaries)
// ---------------------------------------------------------------------------

describe('startDapServer — frame parser robustness', () => {
  // 7a. MULTIPLE FRAMES IN ONE PACKET: two requests concatenated into a single
  // socket.write must both be parsed and answered — proving the server's parser
  // loops over the buffer rather than assuming one frame per chunk.
  it('parses two concatenated frames delivered in a single write', async () => {
    const {socket, reader} = await connect();

    const packet = Buffer.concat([
      encodeFrame(req(1, 'initialize', {adapterID: 'simbolik'})),
      encodeFrame(req(2, 'launch', {})),
    ]);
    socket.write(packet); // both frames in ONE TCP write

    // initialize → response + 'initialized'; launch → response + 'stopped'.
    const out = await reader.take(4);
    const responses = out.filter(isResponse);
    expect(responses.map((r) => r['command']).sort()).toEqual([
      'initialize',
      'launch',
    ]);
    expect(responses.every((r) => r['success'] === true)).toBe(true);
    // Both requests were answered (correlated by request_seq).
    expect(responses.map((r) => r['request_seq']).sort()).toEqual([1, 2]);
    // The launch entry event still arrives too.
    expect(
      out.some((m) => isEvent(m) && m['event'] === 'stopped'),
    ).toBe(true);
  }, 10000);

  // 7b. ONE FRAME SPLIT ACROSS WRITES: header bytes in one write, body bytes in
  // a later write. The server must buffer the partial frame and only dispatch
  // once the whole body has arrived — proving it never parses a half-read frame.
  it('parses a single frame split across two writes (header, then body)', async () => {
    const {socket, reader} = await connect();

    const frame = encodeFrame(req(1, 'initialize', {adapterID: 'simbolik'}));
    const sep = frame.indexOf('\r\n\r\n') + 4; // end of header
    const headerPart = frame.subarray(0, sep);
    const bodyPart = frame.subarray(sep);

    socket.write(headerPart); // header only — server must NOT answer yet
    // Give the header its own event-loop turn so it lands in a separate packet.
    await new Promise((r) => setImmediate(r));
    socket.write(bodyPart); // now the body completes the frame

    const [initResp, initEvt] = await reader.take(2);
    expect(isResponse(initResp!)).toBe(true);
    expect(initResp!['command']).toBe('initialize');
    expect(initResp!['success']).toBe(true);
    expect(initResp!['request_seq']).toBe(1);
    expect(isEvent(initEvt!)).toBe(true);
    expect(initEvt!['event']).toBe('initialized');
  }, 10000);
});
