// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import {CodelensProvider} from './CodelensProvider';
import {SolidityDebugAdapterDescriptorFactory} from './DebugAdapter.web';
import {startDebugging} from './startDebugging';
import {getConfigValue} from './utils';
import { FileStat, FileType } from 'vscode';
import { MemFileSystemProvider, Directory } from './fsProvider';
import { NullWorkspaceWatcher } from './WorkspaceWatcher';
import { cloneStaticTree } from './clone';

console.log("Hello from Simbolik!");

const outputChannel = vscode.window.createOutputChannel(
  'Simbolik Solidity Debugger',
  {log: true}
);

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  // Use the console to output diagnostic information (console.log) and errors (console.error)
  // This line of code will only be executed once when your extension is activated
  console.log('Congratulations, your extension "simbolik" is now active!');
    
  const codelensProvider = new CodelensProvider();
  context.subscriptions.push(vscode.languages.registerCodeLensProvider(
    'solidity',
    codelensProvider
  ));
  
  const root : Directory = { type: FileType.Directory, name: 'root', stats: newFileStat(FileType.Directory, 0), entries: Promise.resolve(new Map()) }
  const memFsProvider = new MemFileSystemProvider('simbolik', root, context.extensionUri);
  context.subscriptions.push( vscode.workspace.registerFileSystemProvider('simbolik', memFsProvider));
  
  const factory = new SolidityDebugAdapterDescriptorFactory();
  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory(
    'solidity',
    factory
  ));

  const workspaceWatcher = new NullWorkspaceWatcher();

  context.subscriptions.push(vscode.commands.registerCommand(
    'simbolik.startDebugging',
    (contract, method) => startDebugging(contract, method, workspaceWatcher),
  ));
  
  vscode.debug.onDidStartDebugSession(session => {
    outputChannel.info(`Debug session started: ${session.id}`);
    if (session.type === 'solidity') {
      if (getConfigValue('auto-open-disassembly-view', false)) {
        vscode.commands.executeCommand('debug.action.openDisassemblyView');
      }
    }
  });
  
  vscode.debug.onDidTerminateDebugSession(session => {
    outputChannel.info(`Debug session ended: ${session.id}`);
  });

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder) {
    console.log(`Workspace folder: ${workspaceFolder.uri.toString()}`);
    const url = new URL(workspaceFolder.uri.query);
    console.log(`Parsed URL: ${url.toString()}`);
    const path = url.pathname;
    const authority = url.host;
    const ethereumPattern = '/tx/{txHash}';
    const traceTxPattern = '/{sandboxName}/tx/{txHash}';
    const traceCallPattern = '/from/{from}/to/{to}/value/{value}/data/{data}';
    const matchEthereumPattern = matchUri(ethereumPattern, path);
    const matchTraceTxPattern = matchUri(traceTxPattern, path);
    const matchTraceCallPattern = matchUri(traceCallPattern, path);
    if (matchEthereumPattern) {
      const debugConfig = {
        "name": "Debug Tx",
        "type": "solidity",
        "request": "attach",
        "txHash": matchEthereumPattern.txHash,
        "jsonRpcUrl": getConfigValue('json-rpc-url', ''),
        "sourcifyUrl": getConfigValue('sourcify-url', ''),
        "stopAtFirstOpcode": false,
        "credentials": {
          "provider": "simbolik",
          "token":  getConfigValue('api-key', 'junk')
        },
      }
      vscode.debug.startDebugging(
        workspaceFolder,
        debugConfig,
      );
    } else if (matchTraceTxPattern) {
      const txHash = matchTraceTxPattern.txHash;
      const sandboxName = matchTraceTxPattern.sandboxName;
      const debugConfig = {
        "name": "Debug Tx",
        "type": "solidity",
        "request": "attach",
        "txHash": txHash,
        "jsonRpcUrl": `https://${authority}/${sandboxName}`,
        "sourcifyUrl": `https://${authority}/verify/sourcify/server/${sandboxName}`,
        "stopAtFirstOpcode": false,
        "credentials": {
          "provider": "simbolik",
          "token": getConfigValue('api-key', 'junk'),
        },
      }
      vscode.debug.startDebugging(
        workspaceFolder,
        debugConfig,
      );
    } else if (matchTraceCallPattern) {
      const from = matchTraceCallPattern.from;
      const to = matchTraceCallPattern.to;
      const value = matchTraceCallPattern.value;
      const data = matchTraceCallPattern.data;
      const debugConfig = {
        "name": "Debug Call",
        "type": "solidity",
        "request": "attach",
        "from_": from,
        "to": to,
        "value": value,
        "data": data,
        "jsonRpcUrl": getConfigValue('json-rpc-url', ''),
        "sourcifyUrl": getConfigValue('sourcify-url', ''),
        "stopAtFirstOpcode": false,
      }
      vscode.debug.startDebugging(
        workspaceFolder,
        debugConfig,
      );
    } else if (workspaceFolder.uri.scheme === 'tmp') {
      // The browser url is attached as query parameter to the workspace folder URI.
      // For example, if the browser URL is: https://simbolik.dev
      // Then the workspace folder URI will be: tmp:///?location=https://simbolik.dev
      const queryParams = new URLSearchParams(workspaceFolder.uri.query);
      console.log('queryParams');
      console.dir(queryParams);
      const location = queryParams.get('location');
      console.log('location');
      console.dir(location);
      const uri = vscode.Uri.parse(location ?? '').with({ path: '/simbolik-examples/'});
      console.log('uri');
      console.dir(uri);
      cloneStaticTree(uri, workspaceFolder.uri).then(() => {
        console.log(`Cloned static tree from ${uri.toString()} to ${workspaceFolder.uri.toString()}`);
      });
    }
  }
}

// This method is called when your extension is deactivated
export function deactivate() {}


/**
* Math a URI path against a pattern.
* For example, if the pattern is /{sandboxname}/tx/{tx_hash}
* and the URI is /lorem-ipsum/tx/0xabcdef1234567890
* then the result should be {sandboxName: 'lorem-ipsum', tx_hash: '0xabcdef1234567890'}
* 
* Returns null if the URI does not match the pattern.
*/
function matchUri(pattern: string, path: string): { [key: string]: string } | null {
  const patternParts = pattern.split('/');
  const uriParts = path.split('/');
  if (patternParts.length !== uriParts.length) {
    return null;
  }
  const result: { [key: string]: string } = {};
  for (let i = 0; i < patternParts.length; i++) {
    const patternPart = patternParts[i];
    const uriPart = uriParts[i];
    if (patternPart.startsWith('{') && patternPart.endsWith('}')) {
      const key = patternPart.slice(1, -1);
      result[key] = uriPart;
    } else if (patternPart !== uriPart) {
      return null;
    }
  }
  return result;
}

function newFileStat(type: FileType, size: number): Promise<FileStat> {
	return Promise.resolve({ type, ctime: Date.now(), mtime: Date.now(), size });
}