/**
 * DAP TCP server hosting a per-connection {@link DapDispatcher}.
 *
 * Speaks the real `Content-Length: <n>\r\n\r\n<json>` wire format (LSP/DAP over a
 * socket). Each connection gets its own {@link DapDispatcher} (so session state
 * is per-client) and its own incremental frame parser that is robust to both
 * several frames arriving in one chunk and one frame split across chunks. Frames
 * are dispatched strictly in order per connection so responses + events never
 * interleave.
 */
import {createServer, type Socket} from 'node:net';
import type {AddressInfo} from 'node:net';

import type {DebugProtocol} from '@vscode/debugprotocol';

import {DapDispatcher, type SessionResolver} from './dispatcher.js';

/** Handle to a running DAP TCP server. */
export interface DapServerHandle {
  /** The actual OS-assigned port the server is listening on. */
  readonly port: number;
  /** Stop accepting, drop open sockets, and resolve once fully closed. */
  close(): Promise<void>;
}

/** Encode one outgoing DAP message as `Content-Length: <byteLen>\r\n\r\n<json>`. */
function encodeFrame(message: DebugProtocol.ProtocolMessage): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  return Buffer.concat([header, body]);
}

/**
 * Drive a single connection: buffer chunks, parse whole frames incrementally,
 * and feed each one through the connection's dispatcher in arrival order. A
 * one-slot promise chain (`queue`) serializes dispatch so overlapping frames
 * never call `handle()` out of order.
 */
function handleConnection(socket: Socket, resolve: SessionResolver): void {
  const dispatcher = new DapDispatcher(resolve);
  // Stream output events (live launch diagnostics) straight to the socket as
  // they happen, rather than only in the handle() return batch.
  dispatcher.setEmitter((out) => socket.write(encodeFrame(out)));
  let buf = Buffer.alloc(0);
  let queue: Promise<void> = Promise.resolve();

  const dispatch = (message: DebugProtocol.ProtocolMessage): void => {
    queue = queue.then(async () => {
      const outgoing = await dispatcher.handle(message);
      for (const out of outgoing) socket.write(encodeFrame(out));
    });
  };

  socket.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const sep = buf.indexOf('\r\n\r\n');
      if (sep === -1) return; // header not complete yet
      const header = buf.subarray(0, sep).toString('ascii');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        // Malformed header — cannot resync safely; drop the connection.
        socket.destroy();
        return;
      }
      const len = Number(m[1]);
      const bodyStart = sep + 4;
      if (buf.length < bodyStart + len) return; // body not complete yet
      const body = buf.subarray(bodyStart, bodyStart + len).toString('utf8');
      buf = buf.subarray(bodyStart + len);

      let message: DebugProtocol.ProtocolMessage;
      try {
        message = JSON.parse(body) as DebugProtocol.ProtocolMessage;
      } catch {
        // Malformed JSON body — skip this frame, keep the server alive.
        continue;
      }
      dispatch(message);
    }
  });

  // A socket error must never crash the process.
  socket.on('error', () => socket.destroy());
}

/** Start a DAP TCP server; resolves once listening on the assigned port. */
export async function startDapServer(opts: {
  port: number;
  host?: string;
  resolve: SessionResolver;
}): Promise<DapServerHandle> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    handleConnection(socket, opts.resolve);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  let closed: Promise<void> | undefined;

  return {
    port,
    close(): Promise<void> {
      // Idempotent: a second close() resolves the same result, never errors.
      closed ??= new Promise<void>((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        server.close((err) => (err ? reject(err) : resolve()));
      });
      return closed;
    },
  };
}
