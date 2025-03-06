// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import {CodelensProvider} from './CodelensProvider';
import {SolidityDebugAdapterDescriptorFactory} from './DebugAdapter.web';
import {startDebugging} from './startDebugging';
import {KastProvider, viewKast} from './KastProvider';
import {getConfigValue} from './utils';
import { Uri, FileStat, FileType, FileSystemError } from 'vscode';
import { Entry, MemFileSystemProvider, File, Directory } from './fsProvider';

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
  
  let disposable: vscode.Disposable;
  
  const codelensProvider = new CodelensProvider();
  disposable = vscode.languages.registerCodeLensProvider(
    'solidity',
    codelensProvider
  );
  context.subscriptions.push(disposable);
  
  const factory = new SolidityDebugAdapterDescriptorFactory();
  disposable = vscode.debug.registerDebugAdapterDescriptorFactory(
    'solidity',
    factory
  );
  context.subscriptions.push(disposable);
  
  disposable = vscode.commands.registerCommand(
    'simbolik.startDebugging',
    (contract, method) => startDebugging(contract, method),
  );
  context.subscriptions.push(disposable);
  
  disposable = vscode.commands.registerCommand('simbolik.viewKast', viewKast);
  context.subscriptions.push(disposable);
  
  const kastProvider = new KastProvider();
  disposable = vscode.workspace.registerTextDocumentContentProvider(
    KastProvider.scheme,
    kastProvider
  );
  
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
  
  const emptyDirectory = new EmptyDirectory('');
  const memFsProvider = new MemFileSystemProvider('buildbear', emptyDirectory, context.extensionUri);
  disposable = vscode.workspace.registerFileSystemProvider('buildbear', memFsProvider);
  context.subscriptions.push(disposable);

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder) {
    const path = workspaceFolder.uri.path;
    const sandboxName = workspaceFolder.uri.authority;
    const pattern = '/chain/{chainId}/tx/{txHash}';
    const match = matchUri(pattern, path);
    if (match) {
      const chainId = match.chainId;
      const txHash = match.txHash;
      const debugConfig = {
        "name": "Debug Tx",
        "type": "solidity",
        "request": "attach",
        "txHash": txHash,
        "jsonRpcUrl": `https://rpc.buildbear.io/${sandboxName}`,
        "sourcifyUrl": `https://rpc.buildbear.io/verify/sourcify/server/${sandboxName}`,
        "stopAtFirstOpcode": false,
        "chainId": chainId,
      }
      vscode.debug.startDebugging(
        workspaceFolder,
        debugConfig,
      );
    }
  }
  
}

// This method is called when your extension is deactivated
export function deactivate() {}


/**
* Math a URI path against a pattern.
* For example, if the pattern is /build-bear/{sandbox_name}/{tx_hash}
* and the URI is /build-bear/lorem-ipsum/0xabcdef1234567890
* then the result should be {sandbox_name: 'lorem-ipsum', tx_hash: '0xabcdef1234567890'}
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

class EmptyDirectory implements Directory {
  readonly type = FileType.Directory;
  constructor(public name: string) {
  }
  get stats(): Promise<FileStat> {
    return Promise.resolve({ type: FileType.Directory, ctime: Date.now(), mtime: Date.now(), size: 0 });
  }
  get entries(): Promise<Map<string, Entry>> {
    return Promise.resolve(new Map());
  }
}