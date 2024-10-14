import * as vscode from 'vscode';
import {getConfigValue} from './utils';
import {MessageEvent, WebSocket} from 'ws';
import { foundryRoot } from './foundry';

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
      const server = getConfigValue('server', 'ws://beta.simbolik.runtimeverification.com:3000');
      const websocket = new WebSocket(server);
      websocket.once('open', () => {
        const websocketAdapter = new WebsocketDebugAdapter(websocket, session.configuration);
        const implementation = new vscode.DebugAdapterInlineImplementation(websocketAdapter);
        resolve(implementation);
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

type WithApiKey = { apiKey: string };
type WithClientVersion = { clientVersion: string };

type DebugProtocolMessage = vscode.DebugProtocolMessage & WithApiKey & WithClientVersion;

class WebsocketDebugAdapter implements vscode.DebugAdapter {
  _onDidSendMessage = new vscode.EventEmitter<vscode.DebugProtocolMessage>();

  constructor(private websocket: WebSocket, private configuration: vscode.DebugConfiguration) {
    websocket.onmessage = (message: MessageEvent) => {
      const payload = message.data.toString();
      const data = JSON.parse(payload);
      const dataWithAbsolutePaht = this.prependPaths(data);
      this._onDidSendMessage.fire(dataWithAbsolutePaht);
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

  foundryRoot() : string {
    return this.configuration['clientMount']
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
          result[key] = stripPrefix(message[key], `${this.foundryRoot()}/`);
        } else if (key == 'file' && typeof message[key] === 'string') {
          result[key] = stripPrefix(message[key], `file://${this.foundryRoot()}/`);
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
          result[key] = `file://${this.foundryRoot()}/${message[key]}`;
        } else if (typeof message[key] === 'object') {
          result[key] = this.prependPaths(message[key]);
        }
      }
      return result;
    }
    return message;
  }

}

function stripPrefix(s: string, prefix: string): string {
  if (s.startsWith(prefix)) {
    return s.slice(prefix.length);
  }
  return s;
}