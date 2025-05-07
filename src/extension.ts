// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import {CodelensProvider} from './CodelensProvider';
import {SolidityDebugAdapterDescriptorFactory} from './DebugAdapter';
import {startDebugging} from './startDebugging';
import {getConfigValue} from './utils';
import { WorkspaceWatcher } from './WorkspaceWatcher';

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

  const workspaceWatcher = new WorkspaceWatcher();

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

  vscode.debug.onDidReceiveDebugSessionCustomEvent(async event => {
    if (event.event === 'api-key-validation-failed') {
      const action = await vscode.window.showErrorMessage(
        'API key validation failed',
        'Open Settings',
        'Learn More'
      );
      if (action === 'Open Settings') {
        vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'simbolik.api-key'
        );
      }
      if (action === 'Learn More') {
        vscode.env.openExternal(
          vscode.Uri.parse('https://simbolik.runtimeverification.com')
        );
      }
    }
    if (event.event === 'api-key-sessions-limit-exceeded') {
      const action = await vscode.window.showErrorMessage(
        'Too many debugging sessions running in parallel'
      );
    }
    console.log(event);
  });
}

// This method is called when your extension is deactivated
export function deactivate() {}
