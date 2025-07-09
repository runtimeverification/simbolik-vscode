// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import {CodelensProvider} from './CodelensProvider';
import {SolidityDebugAdapterDescriptorFactory} from './DebugAdapter.web';
import {startDebugging} from './startDebugging';
import {getConfigValue} from './utils';
import { NullWorkspaceWatcher } from './WorkspaceWatcher';
import { downloadAndExtract } from './clone';

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
    let url;
    try {
      url = new URL(workspaceFolder.uri.query);
    } catch (error) {
      // If the workspace folder URI query is not a valid URL, we
      vscode.window.showErrorMessage('Failed to initialize workspace folder.');
      return;
    }
    // Fallback for old URL format:
    // Example: simbolik.dev/?folder=simbolik://buildbear.io/{sandboxName}/tx/{txHash}
    if (url.searchParams.has('folder')) {
      try {
        url = new URL(url.searchParams.get('folder') || '');
      } catch (error) {
        vscode.window.showErrorMessage('Failed to initialize workspace folder.');
        return;
      }
    }

    const path = url.pathname;
    const ethereumPattern = '/tx/{txHash}';
    const traceTxPattern = '/{sandboxName}/tx/{txHash}';
    const traceTxPatternDev = '/dev/{sandboxName}/tx/{txHash}';
    const traceCallPattern = '/from/{from}/to/{to}/value/{value}/data/{data}';
    const matchEthereumPattern = matchUri(ethereumPattern, path);
    const matchTraceTxPattern = matchUri(traceTxPattern, path);
    const matchTraceTxPatternDev = matchUri(traceTxPatternDev, path);
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
      // Handles the following URL patterns:
      // https://simbolik.dev/{sandboxName}/tx/{txHash}
      // https://simbolik.dev/?folder=simbolik://rpc.buildbear.io/{sandboxName}/tx/{txHash}
      // https://simbolik.dev/?folder=simbolik://dev.rpc.buildbear.io/{sandboxName}/tx/{txHash}
      const sandboxName = matchTraceTxPattern.sandboxName;
      const sourcifyUrl = (url.host.endsWith('simbolik.dev'))
        ? `https://api.buildbear.io/v1/sourcify/${sandboxName}`
        : `https://${url.host.replace(/^rpc/, 'api').replace(/^dev\.rpc/, 'api.dev')}/v1/sourcify/${sandboxName}`;
      const rpcUrl = (url.host.endsWith('simbolik.dev'))
        ? `https://rpc.buildbear.io/${sandboxName}`
        : `https://${url.host}/${sandboxName}`;
      const txHash = matchTraceTxPattern.txHash;
      const debugConfig = {
        "name": "Debug Tx",
        "type": "solidity",
        "request": "attach",
        "txHash": txHash,
        "jsonRpcUrl": rpcUrl,
        "sourcifyUrl": sourcifyUrl,
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
    } else if (matchTraceTxPatternDev) {
      // Handles the following URL patterns:
      // https://simbolik.dev/dev/{sandboxName}/tx/{txHash}
      const txHash = matchTraceTxPatternDev.txHash;
      const sandboxName = matchTraceTxPatternDev.sandboxName;
      const sourcifyUrl = `https://api.dev.buildbear.io/v1/sourcify/${sandboxName}`;
      const rpcUrl = `https://dev.rpc.buildbear.io/${sandboxName}`;
      const debugConfig = {
        "name": "Debug Tx",
        "type": "solidity",
        "request": "attach",
        "txHash": txHash,
        "jsonRpcUrl": rpcUrl,
        "sourcifyUrl": sourcifyUrl,
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
      // The browser url is attached as a query string to the workspace folder URI.
      // For example, if the browser URL is: https://simbolik.dev
      // Then the workspace folder URI will be: tmp:///?https://simbolik.dev
      let url;
      try {
        url = new URL(workspaceFolder.uri.query);
      } catch (error) {
        vscode.window.showErrorMessage('Failed to initialize demo project');
        return;
      }
      url.pathname = 'simbolik-examples';
      downloadAndExtract(url.toString()).then(() => {
        vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
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
