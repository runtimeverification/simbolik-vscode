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
        const websocketAdapter = new WebsocketDebugAdapter(websocket);
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

class WebsocketDebugAdapter implements vscode.DebugAdapter {
  _onDidSendMessage = new vscode.EventEmitter<vscode.DebugProtocolMessage>();

  constructor(private websocket: WebSocket) {
    websocket.onmessage = (message: MessageEvent) => {
      message.data.text().then((payload: string) => {
        const json = JSON.parse(payload);
        this._onDidSendMessage.fire(json);
      });
    };
  }

  onDidSendMessage = this._onDidSendMessage.event;

  handleMessage(message: vscode.DebugProtocolMessage): void {
    this.websocket.send(JSON.stringify(message));
  }

  dispose() {
    this.websocket.close();
  }
}
