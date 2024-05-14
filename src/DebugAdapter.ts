import * as vscode from 'vscode';
import {getConfigValue} from './utils';
import {MessageEvent, WebSocket} from 'ws';

// How often to retry connecting to the server
const MAX_RETRIES = 4;
// How long to wait between retries
const RETRY_INTERVAL = 500;

export class SolidityDebugAdapterDescriptorFactory
  implements vscode.DebugAdapterDescriptorFactory
{
  async createDebugAdapterDescriptor(
    session: vscode.DebugSession,
    executable: vscode.DebugAdapterExecutable | undefined
  ): Promise<vscode.ProviderResult<vscode.DebugAdapterDescriptor>> {
    const server = getConfigValue('server', 'ws://localhost:6789');
    const websocket = new WebSocket(server);
    const tryConnect = () =>
      new Promise((resolve, reject) => {
        websocket.once('open', resolve);
        websocket.once('error', reject);
      });
    const connecting = retry(tryConnect, RETRY_INTERVAL, MAX_RETRIES);
    try {
      await connecting;
    } catch (e: unknown) {
      vscode.window.showWarningMessage(
        "Oops! Simbolik's servers are currently experiencing technical difficulties. We apologize for the inconvenience, but we'll be back online shortly."
      );
    }
    const websocketAdapter = new WebsocketDebugAdapter(websocket);
    return new vscode.DebugAdapterInlineImplementation(websocketAdapter);
  }
}

function retry<T>(
  fn: () => Promise<T>,
  retry_interval: number,
  max_retries: number
) {
  return new Promise<T>((resolve, reject) => {
    let retries = 0;
    const retry = () => {
      const timeout = new Promise<T>((resolve, reject) =>
        setTimeout(reject, retry_interval)
      );
      const task = fn();
      const race = Promise.race([timeout, task]);
      race.then(resolve).catch(e => {
        if (retries < max_retries) {
          retries++;
          setTimeout(retry, retry_interval);
        } else {
          reject(e);
        }
      });
    };
    retry();
  });
}

type WithApiKey = { apiKey: string };

class WebsocketDebugAdapter implements vscode.DebugAdapter {
  _onDidSendMessage = new vscode.EventEmitter<vscode.DebugProtocolMessage>();

  constructor(private websocket: WebSocket) {
    websocket.onmessage = (message: MessageEvent) => {
      const payload = message.data.toString();
      const json = JSON.parse(payload);
      this._onDidSendMessage.fire(json);
    };
  }

  onDidSendMessage = this._onDidSendMessage.event;

  handleMessage(message: vscode.DebugProtocolMessage): void {
    const messageWithApiKey : vscode.DebugProtocolMessage & WithApiKey = Object.assign({}, message, {apiKey: "valid-api-key"});
    this.websocket.send(JSON.stringify(messageWithApiKey));
  }

  dispose() {
    this.websocket.close();
  }
}
