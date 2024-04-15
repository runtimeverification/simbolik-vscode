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
  if (getConfigValue('anvil-autostart', true)) {
    supervisor.anvil();
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
    startDebugging
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
}

// This method is called when your extension is deactivated
export function deactivate() {}
