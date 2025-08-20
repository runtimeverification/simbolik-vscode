import {
  ContractDefinition,
  FunctionDefinition,
  TypeName,
  VariableDeclaration,
} from '@solidity-parser/parser/dist/src/ast-types';
import * as vscode from 'vscode';
import { getConfigValue } from './utils';
import { forgeBuildTask, foundryRoot, loadBuildInfo } from './foundry';
import { IWorkspaceWatcher } from './WorkspaceWatcher';

export type Credentials =
  | {
      provider: 'github';
      token: string;
    }
  | {
      provider: 'simbolik';
      token: string;
    };

export async function startDebugging(
  contract: ContractDefinition,
  method: FunctionDefinition,
  workspaceWatcher: IWorkspaceWatcher,
) {
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Simbolik',
    },
    async (progress) => {
      const apiKey = getConfigValue<string>('api-key', 'valid-api-key');

      let credentials: Credentials;
      if (apiKey !== 'valid-api-key' && apiKey !== '') {
        credentials = { provider: 'simbolik', token: apiKey };
      } else {
        const session = await vscode.authentication.getSession(
          'github',
          ['user:email'],
          {
            createIfNone: true,
          },
        );
        if (!session) {
          vscode.window.showErrorMessage(
            'Please sign in to GitHub or provide a Simbolik API key.',
          );
          return;
        }
        credentials = { provider: 'github', token: session.accessToken };
      }

      const activeTextEditor = vscode.window.activeTextEditor;
      if (!activeTextEditor) {
        throw new Error('No active text editor.');
      }

      const workspaceFolder = vscode.workspace.getWorkspaceFolder(
        activeTextEditor.document.uri,
      );
      if (!workspaceFolder) {
        throw new Error('No workspace folder.');
      }

      const parameters = method.parameters.flatMap(
        (param: VariableDeclaration) => {
          if (param.typeName === null) {
            console.error(
              `Missing TypeName for parameter ${param} in method ${method} in contract ${contract}`,
            );
            return [];
          }
          const typeName: TypeName = param.typeName;
          if (!('name' in typeName)) {
            console.error(
              `Missing name for TypeName for parameter ${param} in method ${method} in contract ${contract}`,
            );
            return [];
          }
          if (typeof typeName.name !== 'string') {
            console.error(
              `Unexpected type for name of TypeName for parameter ${param} in method ${method} in contract ${contract}`,
            );
            return [];
          }
          return [typeName.name];
        },
      );

      const file = activeTextEditor.document.uri.toString();
      const contractName = contract['name'];
      const methodSignature = `${method['name']}(${parameters.join(',')})`;
      const showSourcemaps = getConfigValue('show-sourcemaps', false);
      const debugConfigName = `${contractName}.${methodSignature}`;
      const jsonRpcUrl = getConfigValue(
        'json-rpc-url',
        'http://localhost:8545',
      );
      const sourcifyUrl = getConfigValue(
        'sourcify-url',
        'http://localhost:5555',
      );
      const autobuild = getConfigValue<'always' | 'on-change' | 'never'>(
        'autobuild',
        'on-change',
      );
      const rpcNodeType = getConfigValue<'anvil' | 'kontrol-node'>(
        'rpc-node-type',
        'anvil',
      );

      // Auto build if needed
      // Notice, that if autobuild is set to 'on-change' and the project is not built, the project will be built
      // This case is handled after this block
      if (
        autobuild == 'always' ||
        (autobuild == 'on-change' && workspaceWatcher.hasChanges())
      ) {
        progress.report({ message: 'Compiling' });
        const build = forgeBuildTask(activeTextEditor.document.uri);
        const buildExecution = await vscode.tasks.executeTask(build);
        try {
          await completed(buildExecution);
          workspaceWatcher.reset();
        } catch {
          vscode.window.showErrorMessage('Failed to build project.');
          return;
        }
      }

      let buildInfoFiles;
      try {
        buildInfoFiles = await loadBuildInfo(activeTextEditor.document.uri);
      } catch {
        if (autobuild == 'never') {
          vscode.window.showErrorMessage(
            'Failed to load build info. Please build the project first.',
          );
          return;
        }
        progress.report({ message: 'Compiling' });
        const build = forgeBuildTask(activeTextEditor.document.uri);
        const buildExecution = await vscode.tasks.executeTask(build);
        try {
          await completed(buildExecution);
          workspaceWatcher.reset();
          buildInfoFiles = await loadBuildInfo(activeTextEditor.document.uri);
        } catch {
          vscode.window.showErrorMessage('Failed to build project.');
          return;
        }
      }

      progress.report({ increment: 100 });

      const clientVersion = vscode.extensions.getExtension(
        'runtimeverification.simbolik',
      )?.packageJSON.version;
      const myFoundryRoot = await foundryRoot(activeTextEditor.document.uri);
      const debugConfig = createDebugConfig(
        debugConfigName,
        file,
        contractName,
        methodSignature,
        showSourcemaps,
        jsonRpcUrl,
        sourcifyUrl,
        buildInfoFiles,
        myFoundryRoot,
        credentials,
        clientVersion,
        rpcNodeType,
      );
      return { workspaceFolder, debugConfig };
    },
  );
  if (!result) {
    return;
  }
  const { workspaceFolder, debugConfig } = result;
  const debugSession = await vscode.debug.startDebugging(
    workspaceFolder,
    debugConfig,
  );
  return;
}

function completed(tastkExecution: vscode.TaskExecution): Promise<void> {
  return new Promise((resolve, reject) => {
    const disposable = vscode.tasks.onDidEndTaskProcess((e) => {
      if ((e.execution as any)._id !== (tastkExecution as any)._id) return;
      if (e.exitCode === 0) {
        resolve();
      } else {
        reject();
      }
      disposable.dispose();
    });
  });
}

function createDebugConfig(
  name: string,
  file: string,
  contractName: string,
  methodSignature: string,
  showSourcemaps: boolean,
  jsonRpcUrl: string,
  sourcifyUrl: string,
  buildInfoFiles: vscode.Uri[],
  clientMount: vscode.Uri,
  credentials: Credentials,
  clientVersion: string,
  rpcNodeType: string,
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
    buildInfoFiles: buildInfoFiles,
    clientMount: clientMount,
    credentials: credentials,
    clientVersion: clientVersion,
    rpcNodeType: rpcNodeType,
  };
}
