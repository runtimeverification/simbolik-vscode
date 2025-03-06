import * as vscode from 'vscode';
import {getConfigValue} from './utils';
import {MessageEvent, WebSocket} from 'ws';
import { Credentials } from './startDebugging';

// How long to wait for the server to respond before giving up
const CONNECTION_TIMEOUT = 3000;

export class SolidityDebugAdapterDescriptorFactory
  implements vscode.DebugAdapterDescriptorFactory
{
  _onDidCreateDebugAdapter = new vscode.EventEmitter<WebsocketDebugAdapter>();
  onDidCreateDebugAdapter = this._onDidCreateDebugAdapter.event;

  createDebugAdapterDescriptor(
    session: vscode.DebugSession,
    executable: vscode.DebugAdapterExecutable | undefined
  ): Promise<vscode.ProviderResult<vscode.DebugAdapterDescriptor>> {
    return new Promise((resolve, reject) => {
      const server = getConfigValue('server', 'wss://beta.simbolik.runtimeverification.com');
      const websocket = new WebSocket(server);
      websocket.once('open', () => {
        const websocketAdapter = new WebsocketDebugAdapter(websocket, session.configuration);
        const implementation = new vscode.DebugAdapterInlineImplementation(websocketAdapter);
        resolve(implementation);
        this._onDidCreateDebugAdapter.fire(websocketAdapter);
      });
      websocket.once('error', () =>{
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

type WithCredentias = { credentials: Credentials };
type WithClientVersion = { clientVersion: string };

type DebugProtocolMessage = vscode.DebugProtocolMessage & WithCredentias & WithClientVersion;

type ResponseEvent = { request: vscode.DebugProtocolMessage, response: vscode.DebugProtocolMessage };

class WebsocketDebugAdapter implements vscode.DebugAdapter {
  _onDidSendMessage = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  onDidSendMessage = this._onDidSendMessage.event;
  _onResponse = new vscode.EventEmitter<ResponseEvent>();
  onResponse = this._onResponse.event;
  _pendingRequests: Map<number, vscode.DebugProtocolMessage> = new Map();

  constructor(private websocket: WebSocket, private configuration: vscode.DebugConfiguration) {
    websocket.onmessage = (message: MessageEvent) => {
      const payload = message.data.toString();
      const data = JSON.parse(payload);
      const dataWithAbsolutePaths = this.prependPaths(data);
      this._onDidSendMessage.fire(dataWithAbsolutePaths);
      if (data.type === 'response') {
        const request = this._pendingRequests.get(data.request_seq);
        if (request) {
          this._onResponse.fire({ request, response: dataWithAbsolutePaths });
          this._pendingRequests.delete(data.request_seq);
        }
      }
    };
  }


  handleMessage(message: vscode.DebugProtocolMessage): void {
    const clientVersion = vscode.extensions.getExtension('simbolik.simbolik')?.packageJSON.version;
    const messageWithCredientials : DebugProtocolMessage = Object.assign({}, message, {
      credentials: this.configuration.credentials,
      clientVersion
    });
    const messageWithRelativePaths = this.trimPaths(messageWithCredientials);
    if ('seq' in message && typeof message.seq === 'number') {
      this._pendingRequests.set(message.seq, message);
    }
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