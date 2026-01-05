import {createReadStream} from 'fs';
import * as vscode from 'vscode';
import {MessageEvent, WebSocket} from 'ws';
import {getConfigValue} from './utils';

// How long to wait for the server to respond before giving up
const CONNECTION_TIMEOUT = 3000;

export class SolidityDebugAdapterDescriptorFactory
  implements vscode.DebugAdapterDescriptorFactory
{
  createDebugAdapterDescriptor(
    session: vscode.DebugSession,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    executable: vscode.DebugAdapterExecutable | undefined
  ): Promise<vscode.ProviderResult<vscode.DebugAdapterDescriptor>> {
    return new Promise((resolve, reject) => {
      const server = getConfigValue('server', 'wss://code.simbolik.dev');
      const credentials = session.configuration.credentials;
      const encodedProvider = encodeURIComponent(credentials.provider);
      const encodedToken = encodeURIComponent(credentials.token);
      const url = `${server}?auth-provider=${encodedProvider}&auth-token=${encodedToken}`;
      const websocket = new WebSocket(url);
      const websocketAdapter = new WebsocketDebugAdapter(
        websocket,
        session.configuration
      );
      const implementation = new vscode.DebugAdapterInlineImplementation(
        websocketAdapter
      );
      websocket.once('open', async () => {
        // Create progress bar
        vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: 'Sending compilation data to the debugger…',
            cancellable: true,
          },
          async (progress, token) => {
            // Before the DAP communication starts we upload the build_info files
            // to the server. This is needed for the server to be able to
            // resolve the paths to the source files.
            const buildInfoFiles = session.configuration.buildInfoFiles ?? [];

            token.onCancellationRequested(() => {
              websocket.close();
              reject(new Error('Debugging session cancelled'));
            });

            progress.report({increment: 0});
            // Get total file size for progress bar
            let totalFileSize = 0;
            for (const buildInfoFile of buildInfoFiles) {
              const uri = vscode.Uri.from(buildInfoFile);
              const stats = await vscode.workspace.fs.stat(uri);
              totalFileSize += stats.size;
            }

            for (const buildInfoFile of buildInfoFiles) {
              const uploadProgress = uploadFile(
                websocket,
                buildInfoFile,
                token
              );
              let totalTransferred = 0;
              for await (const bytesTransferred of uploadProgress) {
                const percentage = (bytesTransferred / totalFileSize) * 100;
                const increment = percentage - totalTransferred;
                totalTransferred = percentage;
                progress.report({increment});
              }
            }
            websocket.send(JSON.stringify({command: 'simbolik:finish'}));
            resolve(implementation);
          }
        );
      });
      websocket.once('error', () => {
        if (websocket.readyState === WebSocket.OPEN) {
          return;
        }
        websocket.close();
        vscode.window.showWarningMessage(
          "Oops! Simbolik's servers are currently experiencing technical difficulties. We apologize for the inconvenience, but we'll be back online shortly."
        );
      });
      setTimeout(() => {
        if (websocket.readyState === WebSocket.OPEN) {
          return;
        }
        websocket.close();
        reject(new Error('Connection timed out'));
        vscode.window.showWarningMessage(
          "Oops! Simbolik's servers are currently experiencing technical difficulties. We apologize for the inconvenience, but we'll be back online shortly."
        );
      }, CONNECTION_TIMEOUT);
    });
  }
}

function sendAsync(ws: WebSocket, data: Buffer | string): Promise<void> {
  return new Promise((resolve, reject) => {
    ws.send(data, (err?: Error) => (err ? reject(err) : resolve()));
  });
}

/**
 * File upload via WebSocket, yielding progress.
 *
 * Automatically handles backpressure.
 */
export async function* uploadFile(
  ws: WebSocket,
  file: vscode.Uri,
  token: vscode.CancellationToken
): AsyncGenerator<number, void, void> {
  const CHUNK_SIZE = 512 * 1024; // 512 KB chunks
  const HIGH_WM = 32 * 1024 * 1024; // pause if > 32 MB queued
  const LOW_WM = 16 * 1024 * 1024; // resume when < 16 MB
  const TICK_MS = 150; // report progress at least every 150 ms

  const rs = createReadStream(file.path, {highWaterMark: CHUNK_SIZE});
  let bytesTransferred = 0;
  let lastTick = 0;

  await sendAsync(ws, JSON.stringify({command: 'simbolik:upload:start'}));
  try {
    for await (const chunk of rs) {
      if (token.isCancellationRequested) return;
      await sendAsync(ws, chunk);
      bytesTransferred += (chunk as Buffer).length;
      // Backpressure: keep socket reasonably full, not flooded
      while (ws.bufferedAmount && ws.bufferedAmount > HIGH_WM) {
        if (token.isCancellationRequested) return;
        await new Promise<void>(r => setTimeout(r, 5));
        if (ws.bufferedAmount < LOW_WM) break;
        if (Date.now() - lastTick > TICK_MS) {
          lastTick = Date.now();
          yield bytesTransferred;
        }
      }
      if (Date.now() - lastTick > TICK_MS) {
        lastTick = Date.now();
        yield bytesTransferred;
      }
    }
    // Final tick to reach 100%
    yield bytesTransferred;
    await sendAsync(ws, JSON.stringify({command: 'simbolik:upload:finish'}));
  } finally {
    /* empty */
  }
}

class WebsocketDebugAdapter implements vscode.DebugAdapter {
  _onDidSendMessage = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  onDidSendMessage = this._onDidSendMessage.event;

  constructor(
    private websocket: WebSocket,
    private configuration: vscode.DebugConfiguration
  ) {
    websocket.onmessage = (message: MessageEvent) => {
      const payload = message.data.toString();
      const data = JSON.parse(payload);
      const dataWithAbsolutePaths = this.prependPaths(
        data
      ) as vscode.DebugProtocolMessage;
      this._onDidSendMessage.fire(dataWithAbsolutePaths);
    };
  }

  handleMessage(message: vscode.DebugProtocolMessage): void {
    const messageWithRelativePaths = this.trimPaths(message);
    this.websocket.send(JSON.stringify(messageWithRelativePaths));
  }

  dispose() {
    this.websocket.close();
  }

  foundryRoot(): vscode.Uri {
    if (!this.configuration['clientMount']) {
      return vscode.Uri.parse('file:///');
    }
    const uri = vscode.Uri.from(this.configuration['clientMount']);
    return uri;
  }

  /**
   * Recursively walk over all object properties and for each property
   * named `path` and type `string`, remove the foundry root from the path.
   * @param message
   */
  trimPaths(message: unknown): unknown {
    if (Array.isArray(message)) {
      return message.map(item => this.trimPaths(item));
    } else if (message instanceof Object && message !== null) {
      const result = Object.assign({}, message) as Record<string, unknown>;
      const msg = message as Record<string, unknown>;
      for (const key in msg) {
        if (
          ['path', 'symbolFilePath'].includes(key) &&
          typeof msg[key] === 'string'
        ) {
          const uri = vscode.Uri.parse(msg[key] as string);
          result[key] = relativeTo(uri, this.foundryRoot());
        } else if (key === 'file' && typeof msg[key] === 'string') {
          const uri = vscode.Uri.parse(msg[key] as string);
          result[key] = relativeTo(uri, this.foundryRoot());
        } else if (typeof msg[key] === 'object') {
          result[key] = this.trimPaths(msg[key]);
        }
      }
      return result;
    }
    return message;
  }

  /**
   * Recursively walk over all object properties and for each property
   * named `path` and type `string`, prepend the foundry root to the path.
   * @param message
   */
  prependPaths(message: unknown): unknown {
    if (Array.isArray(message)) {
      return message.map(item => this.prependPaths(item));
    } else if (message instanceof Object && message !== null) {
      const result = Object.assign({}, message) as Record<string, unknown>;
      const msg = message as Record<string, unknown>;
      for (const key in msg) {
        if (
          ['path', 'symbolFilePath', 'file'].includes(key) &&
          typeof msg[key] === 'string'
        ) {
          result[key] = `${this.foundryRoot()}/${msg[key]}`;
        } else if (typeof msg[key] === 'object') {
          result[key] = this.prependPaths(msg[key]);
        }
      }
      return result;
    }
    return message;
  }
}

function relativeTo(uri: vscode.Uri, prefixUri: vscode.Uri): string {
  const s = uri.path;
  const prefix = prefixUri.path + '/';
  const relative = stripPrefix(s, prefix);
  const result = stripPrefix(relative, '/');
  return result;
}

function stripPrefix(s: string, prefix: string): string {
  if (s.startsWith(prefix)) {
    return s.slice(prefix.length);
  }
  return s;
}
