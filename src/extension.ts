// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import {CodelensProvider} from './CodelensProvider';
import {SolidityDebugAdapterDescriptorFactory} from './DebugAdapter';
import {startAIDebugging, startDebugging} from './startDebugging';
import {KastProvider, viewKast} from './KastProvider';
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

  const workspaceWatcher = new WorkspaceWatcher();

  disposable = vscode.commands.registerCommand(
    'simbolik.startDebugging',
    (contract, method) => startDebugging(contract, method, workspaceWatcher),
  );
  context.subscriptions.push(disposable);

  disposable = vscode.commands.registerCommand(
    'simbolik.startAIDebugging',
    (contract, method) => startAIDebugging(contract, method),
  );

  disposable = vscode.commands.registerCommand('simbolik.viewKast', viewKast);
  context.subscriptions.push(disposable);

  disposable = vscode.commands.registerCommand('simbolik.toNextJump', () => {
    const debugSession = vscode.debug.activeDebugSession;
    const threadId = vscode.debug.activeStackItem?.threadId;
    if (debugSession != null && threadId != null) {
      debugSession.customRequest('simbolik/stepToNextJumpdest', { threadId });
    }
  });
  context.subscriptions.push(disposable);
  disposable = vscode.commands.registerCommand('simbolik.toNextCall', () => {
    const debugSession = vscode.debug.activeDebugSession;
    const threadId = vscode.debug.activeStackItem?.threadId;
    if (debugSession != null && threadId != null) {
      debugSession.customRequest('simbolik/stepToNextCall', { threadId });
    }
  });
  context.subscriptions.push(disposable);
  disposable = vscode.commands.registerCommand('simbolik.outInternalCall', () => {
    const debugSession = vscode.debug.activeDebugSession;
    const threadId = vscode.debug.activeStackItem?.threadId;
    if (debugSession != null && threadId != null) {
      debugSession.customRequest('simbolik/stepOutInternalCall', { threadId });
    }
  });
  context.subscriptions.push(disposable);
  disposable = vscode.commands.registerCommand('simbolik.outExternalCall', () => {
    const debugSession = vscode.debug.activeDebugSession;
    const threadId = vscode.debug.activeStackItem?.threadId;
    if (debugSession != null && threadId != null) {
      debugSession.customRequest('simbolik/stepOutExterncallCall', { threadId });
    }
  });
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
