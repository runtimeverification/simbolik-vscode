import * as vscode from 'vscode';
import {getConfigValue} from './utils';

const DAP_CONNECTION_TIMEOUT_MILLISECONDS = 10000;

export class SolidityDebugAdapterDescriptorFactory
  implements vscode.DebugAdapterDescriptorFactory
{
  async createDebugAdapterDescriptor(
    session: vscode.DebugSession,
    executable: vscode.DebugAdapterExecutable | undefined
  ): Promise<vscode.ProviderResult<vscode.DebugAdapterDescriptor>> {
    const server = getConfigValue('server', 'ws://localhost:6789');
    const websocket = new WebSocket(server);
    const timeout = new Promise((_, reject) =>
      setTimeout(reject, DAP_CONNECTION_TIMEOUT_MILLISECONDS)
    );
    const connecting = new Promise((resolve, reject) => {
      websocket.onopen = resolve;
      websocket.onerror = reject;
    });
    const joinedPromises = Promise.race([connecting, timeout]);
    try {
      await joinedPromises;
    } catch (e: unknown) {
      vscode.window.showWarningMessage(
        "Oops! Simbolik's servers are currently experiencing technical difficulties. We apologize for the inconvenience, but we'll be back online shortly."
      );
    }
    const websocketAdapter = new WebsocketDebugAdapter(websocket);
    return new vscode.DebugAdapterInlineImplementation(websocketAdapter);
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
