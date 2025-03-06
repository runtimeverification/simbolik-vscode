import {
  ContractDefinition,
  FunctionDefinition,
  TypeName,
  VariableDeclaration,
} from '@solidity-parser/parser/dist/src/ast-types';
import * as vscode from 'vscode';
import { getConfigValue } from './utils';
import { forgeBuildTask, foundryRoot, loadBuildInfo } from './foundry';
import { WorkspaceWatcher } from './WorkspaceWatcher';

export
type Credentials = {
  provider: 'github',
  token: string
} | {
  provider: 'simbolik',
  token: string
}

export async function startDebugging(
  contract: ContractDefinition,
  method: FunctionDefinition,
  workspaceWatcher: WorkspaceWatcher
) {
  return await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Simbolik"
  }, async (progress) => {
    const apiKey = getConfigValue<string>('api-key', 'valid-api-key')

    let credentials: Credentials;
    if (apiKey !== 'valid-api-key' && apiKey !== '') {
      credentials = { provider: 'simbolik', token: apiKey };
    } else {
      const session = await vscode.authentication.getSession('github', ['user:email'], {
        createIfNone: true
      });
      if (!session) {
        vscode.window.showErrorMessage('Please sign in to GitHub or provide a Simbolik API key.');
        return;
      }
      credentials = { provider: 'github', token: session.accessToken };
    }

    const activeTextEditor = vscode.window.activeTextEditor;
    if (!activeTextEditor) {
      throw new Error('No active text editor.');
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(
      activeTextEditor.document.uri
    );
    if (!workspaceFolder) {
      throw new Error('No workspace folder.');
    }

    const parameters = method.parameters.flatMap((param: VariableDeclaration) => {
      if (param.typeName === null) {
        console.error(
          `Missing TypeName for parameter ${param} in method ${method} in contract ${contract}`
        );
        return [];
      }
      const typeName: TypeName = param.typeName;
      if (!('name' in typeName)) {
        console.error(
          `Missing name for TypeName for parameter ${param} in method ${method} in contract ${contract}`
        );
        return [];
      }
      if (typeof typeName.name !== 'string') {
        console.error(
          `Unexpected type for name of TypeName for parameter ${param} in method ${method} in contract ${contract}`
        );
        return [];
      }
      return [typeName.name];
    });

    const file = activeTextEditor.document.uri.toString();
    const contractName = contract['name'];
    const methodSignature = `${method['name']}(${parameters.join(',')})`;
    const showSourcemaps = getConfigValue('show-sourcemaps', false);
    const debugConfigName = `${contractName}.${methodSignature}`;
    const jsonRpcUrl = getConfigValue('json-rpc-url', 'http://localhost:8545');
    const sourcifyUrl = getConfigValue('sourcify-url', 'http://localhost:5555');
    const autobuild = getConfigValue<'always'|'on-change'|'never'>('autobuild', 'on-change');

    // Auto build if needed
    // Notice, that if autobuild is set to 'on-change' and the project is not built, the project will be built
    // This case is handled after this block
    if (autobuild == 'always' || (autobuild == 'on-change' && workspaceWatcher.hasChanges())) {
      progress.report({ message: "Compiling" });
      const build = forgeBuildTask(activeTextEditor.document.uri);
      const buildExecution = await vscode.tasks.executeTask(build);
      try {
        await completed(buildExecution);
        workspaceWatcher.reset();
      } catch (e) {
        vscode.window.showErrorMessage('Failed to build project.');
        return;
      }
    }
    
    let buildInfo;
    try {
      buildInfo = await loadBuildInfo(activeTextEditor.document.uri);
    } catch (e) {
      if (autobuild == 'never') {
        vscode.window.showErrorMessage('Failed to load build info. Please build the project first.');
        return;
      }
      progress.report({ message: "Compiling" });
      const build = forgeBuildTask(activeTextEditor.document.uri);
      const buildExecution = await vscode.tasks.executeTask(build);
      try {
        await completed(buildExecution);
        workspaceWatcher.reset();
        buildInfo = await loadBuildInfo(activeTextEditor.document.uri);
      } catch (e) {
        vscode.window.showErrorMessage('Failed to build project.');
        return;
      }
    }

    const myFoundryRoot = await foundryRoot(activeTextEditor.document.uri);
    const myDebugConfig = debugConfig(
      debugConfigName,
      file,
      contractName,
      methodSignature,
      showSourcemaps,
      jsonRpcUrl,
      sourcifyUrl,
      buildInfo,
      myFoundryRoot,
      credentials
    );
    console.log(myDebugConfig);
    progress.report({message: "Launching testnet"});
    const debugSession = await vscode.debug.startDebugging(
      workspaceFolder,
      myDebugConfig
    );
  });
}

function completed(tastkExecution: vscode.TaskExecution): Promise<void> {
  return new Promise((resolve, reject) => {
    const disposable = vscode.tasks.onDidEndTaskProcess(e => {
      if ((e.execution as any)._id !== (tastkExecution as any)._id) return;
      if (e.exitCode !== 0) {
        reject();
      } else {
        resolve();
      }
      disposable.dispose();
    });
  });
}

function debugConfig(
  name: string,
  file: string,
  contractName: string,
  methodSignature: string,
  showSourcemaps: boolean,
  jsonRpcUrl: string,
  sourcifyUrl: string,
  buildInfo: string,
  clientMount: vscode.Uri,
  credentials: Credentials,
) {
  return {
    name: name,
    type: 'solidity',
    request: 'launch',
    file: file,
    contractName: contractName,
    methodSignature: methodSignature,
    stopAtFirstOpcode: false,
    showSourcemaps: showSourcemaps,
    jsonRpcUrl: jsonRpcUrl,
    sourcifyUrl: sourcifyUrl,
    buildInfo: buildInfo,
    clientMount: clientMount,
    credentials: credentials
  };
}
