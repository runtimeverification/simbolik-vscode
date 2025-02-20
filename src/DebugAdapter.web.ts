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
      const websocket = new WebSocket(server);
      websocket.onopen = () => {
        const websocketAdapter = new WebsocketDebugAdapter(websocket, session.configuration);
        const implementation = new vscode.DebugAdapterInlineImplementation(websocketAdapter);
        resolve(implementation);
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

type WithApiKey = { apiKey: string };
type WithClientVersion = { clientVersion: string };

type DebugProtocolMessage = vscode.DebugProtocolMessage & WithApiKey & WithClientVersion;

class WebsocketDebugAdapter implements vscode.DebugAdapter {
  _onDidSendMessage = new vscode.EventEmitter<vscode.DebugProtocolMessage>();

  constructor(private websocket: WebSocket, private configuration: vscode.DebugConfiguration) {
    websocket.onmessage = (message: MessageEvent) => {
      const data = JSON.parse(message.data);
      const dataWithAbsolutePaths = this.prependPaths(data);
      this._onDidSendMessage.fire(dataWithAbsolutePaths);
    };
  }

  onDidSendMessage = this._onDidSendMessage.event;

  handleMessage(message: vscode.DebugProtocolMessage): void {
    const apiKey = getConfigValue('api-key', '');
    const clientVersion = vscode.extensions.getExtension('simbolik.simbolik')?.packageJSON.version;
    const messageWithApiKey : DebugProtocolMessage = Object.assign({}, message, {apiKey, clientVersion});
    const messageWithRelativePaths = this.trimPaths(messageWithApiKey);
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
  console.log('uri', uri);
  console.log('prefixUri', prefixUri);
  console.log('result', result);
  return result;
}

function stripPrefix(s: string, prefix: string): string {
  if (s.startsWith(prefix)) {
    return s.slice(prefix.length);
  }
  return s;
}