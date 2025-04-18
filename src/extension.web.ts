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


  // Wait 3 seconds for the filesystem to be ready before starting the debug session
  // Is there a better way to do this?
  setTimeout(() => {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (workspaceFolder) {
      const path = workspaceFolder.uri.path;
      const authority = workspaceFolder.uri.authority;
      const traceTxPattern = '/{sandboxName}/tx/{txHash}';
      const traceCallPattern = '/from/{from}/to/{to}/value/{value}/data/{data}';
      const matchTraceTxPattern = matchUri(traceTxPattern, path);
      const matchTraceCallPattern = matchUri(traceCallPattern, path);
      if (matchTraceTxPattern) {
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
      }
    }
  }, 3000);
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