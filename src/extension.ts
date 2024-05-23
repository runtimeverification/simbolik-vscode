// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import {CodelensProvider} from './CodelensProvider';
import {SolidityDebugAdapterDescriptorFactory} from './DebugAdapter';
import {startDebugging} from './startDebugging';
import {KastProvider, viewKast} from './KastProvider';
import {Supervisor} from './supevervisor';
import {getConfigValue} from './utils';

const outputChannel = vscode.window.createOutputChannel(
  'Symbolic Solidity Debugger',
  {log: true}
);

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
  // Use the console to output diagnostic information (console.log) and errors (console.error)
  // This line of code will only be executed once when your extension is activated
  console.log('Congratulations, your extension "simbolik" is now active!');

  let disposable: vscode.Disposable;

  const supervisor = new Supervisor();
  if (getConfigValue('simbolik-autostart', true)) {
    supervisor.simbolik();
  }
  context.subscriptions.push(supervisor);

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
    startDebugging,
    supervisor
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
  });

  vscode.debug.onDidTerminateDebugSession(session => {
    supervisor.anvilTerminate();
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
          'simbolik.apiKey'
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
