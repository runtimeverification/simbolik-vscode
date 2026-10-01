import * as vscode from 'vscode';
import {CodelensProvider} from './CodelensProvider';
import {SolidityDebugAdapterDescriptorFactory} from './DebugAdapter';
import {DebugNodeManager} from './nodeManager';
import {startDebugging} from './startDebugging';
import {getConfigValue} from './utils';
import {forgeLintFile} from './foundry';
import {createTestController} from './TestAdapter';

const outputChannel = vscode.window.createOutputChannel(
  'Simbolik Solidity Debugger',
  {log: true}
);

export function activate(context: vscode.ExtensionContext) {
  console.log('Congratulations, your extension "simbolik" is now active!');

  const codelensProvider = new CodelensProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeLensProvider('solidity', codelensProvider)
  );

  // Owns the per-session execution node (auto-started for launch sessions).
  const nodeManager = new DebugNodeManager();
  context.subscriptions.push(nodeManager);

  const factory = new SolidityDebugAdapterDescriptorFactory(
    context,
    nodeManager
  );
  context.subscriptions.push(
    vscode.debug.registerDebugAdapterDescriptorFactory('solidity', factory)
  );

  // Check the execution node's install before a launch session exists: on a
  // problem, `checkSetup` shows it with fix-it buttons, and returning
  // `undefined` cancels the launch without a second, generic error.
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider('solidity', {
      async resolveDebugConfigurationWithSubstitutedVariables(_folder, config) {
        if (config.request !== 'launch') return config;
        // The same source `populateDebugConfiguration` takes the node type from.
        const rpcNodeType = getConfigValue<'anvil' | 'kontrol-node'>(
          'rpc-node-type',
          'kontrol-node'
        );
        return (await nodeManager.checkSetup(rpcNodeType)) ? config : undefined;
      },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'simbolik.startDebugging',
      (file, contract, method) => startDebugging(file, contract, method)
    )
  );

  createTestController().then(testController =>
    context.subscriptions.push(testController)
  );

  const diagnosticsCollection =
    vscode.languages.createDiagnosticCollection('solidity');
  context.subscriptions.push(diagnosticsCollection);
  const lintIfSolidity = async (document: vscode.TextDocument) => {
    if (document.languageId === 'solidity') {
      await forgeLintFile(document.uri, diagnosticsCollection);
    }
  };
  vscode.workspace.onDidChangeTextDocument(event =>
    lintIfSolidity(event.document)
  );
  vscode.workspace.onDidOpenTextDocument(lintIfSolidity);
  vscode.workspace.textDocuments.forEach(lintIfSolidity);

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
    // One fresh node per session: tear down the node started for this one.
    if (session.type === 'solidity') {
      void nodeManager.stop(session.id);
    }
  });
}

export function deactivate() {}
