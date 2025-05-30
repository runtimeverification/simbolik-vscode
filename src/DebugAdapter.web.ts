import * as vscode from 'vscode';
import {getConfigValue} from './utils';

// How long to wait for the server to respond before giving up
const CONNECTION_TIMEOUT = 3000;

export class SolidityDebugAdapterDescriptorFactory
implements vscode.DebugAdapterDescriptorFactory
{
  createDebugAdapterDescriptor(
    session: vscode.DebugSession,
    executable: vscode.DebugAdapterExecutable | undefined
  ): Promise<vscode.ProviderResult<vscode.DebugAdapterDescriptor>> {
    return new Promise((resolve, reject) => {
      const server = getConfigValue('server', 'wss://beta.simbolik.runtimeverification.com');
      const credentials = session.configuration.credentials;
      const encodedProvider = encodeURIComponent(credentials.provider);
      const encodedToken = encodeURIComponent(credentials.token);
      const url = `${server}?auth-provider=${encodedProvider}&auth-token=${encodedToken}`;
      const websocket = new WebSocket(url);
      const websocketAdapter = new WebsocketDebugAdapter(websocket, session.configuration);
      const implementation = new vscode.DebugAdapterInlineImplementation(websocketAdapter);
      websocket.onopen = async () => {
        // Create progress bar
        vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: 'Sending compilation data to the debugger…',
          cancellable: true
        }, async (progress, token) => {
          // Before the DAP communication starts we upload the build_info files
          // to the server. This is needed for the server to be able to
          // resolve the paths to the source files.
          const buildInfoFiles = session.configuration.buildInfoFiles ?? [];

          token.onCancellationRequested(() => {
            websocket.close();
            reject(new Error('Session cancelled'));
          });

          progress.report({ increment: 0 });
          // Get total file size for progress bar
          let totalFileSize = 0;
          for (const buildInfoFile of buildInfoFiles) {
            const uri = vscode.Uri.from(buildInfoFile);
            const stats = await vscode.workspace.fs.stat(uri);
            totalFileSize += stats.size;
          }

          for (const buildInfoFile of buildInfoFiles) {
            const uploadProgress = uploadFile(websocket, buildInfoFile);
            let totalTransferred = 0;
            for await (const bytesTransferred of uploadProgress) {
              const percentage = (bytesTransferred / totalFileSize) * 100;
              const increment = percentage - totalTransferred;
              totalTransferred = percentage;
              progress.report({ increment });
            }
          }
          websocket.send(JSON.stringify({ command: 'simbolik:finish' }));
          resolve(implementation);
        });
      };
      websocket.onerror = () => {
        if (websocket.readyState === WebSocket.OPEN) {
          return;
        }
        websocket.close();
        vscode.window.showWarningMessage(
          "Oops! Simbolik's servers are currently experiencing technical difficulties. We apologize for the inconvenience, but we'll be back online shortly."
        );
      };
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

async function* uploadFile(websocket: WebSocket, file: vscode.Uri): AsyncGenerator<number, void, void> {
  websocket.send(JSON.stringify({ command: 'simbolik:upload:start' }));
  const contents = await vscode.workspace.fs.readFile(file);
  const fileSize = contents.length;
  const chunkSize = 10 * 1024 * 1024; // 10MB
  let bytesTransferred = 0;
  for (let i = 0; i < fileSize; i += chunkSize) {
    const chunk = contents.slice(i, i + chunkSize);
    bytesTransferred += chunk.length;
    // Wait until the buffer is drained before sending the next chunk
    await new Promise((resolve) => {
      let t = setTimeout(function check () {
        if (websocket.bufferedAmount === 0) {
          clearTimeout(t);
          resolve(true);
        } else {
          t = setTimeout(check, 100);
        }
      }, 100);
    });
    websocket.send(chunk);
    yield bytesTransferred;
  }
  websocket.send(JSON.stringify({ command: 'simbolik:upload:finish' }));
}

class WebsocketDebugAdapter implements vscode.DebugAdapter {
  _onDidSendMessage = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  onDidSendMessage = this._onDidSendMessage.event;
  
  constructor(private websocket: WebSocket, private configuration: vscode.DebugConfiguration) {
    websocket.onmessage = (message: MessageEvent) => {
      const data = JSON.parse(message.data);
      const dataWithAbsolutePaths = this.prependPaths(data);
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
  
  foundryRoot() : vscode.Uri {
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
  trimPaths(message: {[key: string]: any} | any[] ) : {[key: string]: any} | any[] {
    if (Array.isArray(message)) {
      return message.map((item) => this.trimPaths(item));
    } else if (message instanceof Object) {
      const result = Object.assign({}, message);
      for (const key in message) {
        if (['path', 'symbolFilePath'].includes(key) && typeof message[key] === 'string') {
          const uri = vscode.Uri.parse(message[key]);
          result[key] = relativeTo(uri, this.foundryRoot());
        } else if (key == 'file' && typeof message[key] === 'string') {
          const uri = vscode.Uri.parse(message[key]);
          result[key] = relativeTo(uri, this.foundryRoot());
        } else if (typeof message[key] === 'object') {
          result[key] = this.trimPaths(message[key]);
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
  prependPaths(message: {[key: string]: any} | any[]) : {[key: string]: any} | any[] {
    if (Array.isArray(message)) {
      return message.map((item) => this.prependPaths(item));
    } else if (message instanceof Object) {
      const result = Object.assign({}, message);
      for (const key in message) {
        if (['path', 'symbolFilePath', 'file'].includes(key) && typeof message[key] === 'string') {
          result[key] = `${this.foundryRoot()}/${message[key]}`;
        } else if (key == 'file' && typeof message[key] === 'string') {
          result[key] = `${this.foundryRoot()}/${message[key]}`;
        } else if (typeof message[key] === 'object') {
          result[key] = this.prependPaths(message[key]);
        }
      }
      return result;
    }
    return message;
  }
}

function relativeTo(uri: vscode.Uri, prefixUri: vscode.Uri): string {
  const s = uri.path;
  const prefix = prefixUri.path;
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