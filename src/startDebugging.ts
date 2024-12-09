import {
  ContractDefinition,
  FunctionDefinition,
  TypeName,
  VariableDeclaration,
} from '@solidity-parser/parser/dist/src/ast-types';
import * as vscode from 'vscode';
import { getConfigValue } from './utils';
import { forgeBuildTask, foundryRoot, loadBuildInfo } from './foundry';

export async function startDebugging(
  contract: ContractDefinition,
  method: FunctionDefinition
) {
  return await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Simbolik"
  }, async (progress) => {

    let email;
    try {
      const session = await vscode.authentication.getSession('github', ['user:email'])
      if (!session) { throw new Error('Failed to login'); }

      const response = await fetch('https://api.github.com/user/emails', {
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${session.accessToken}`,
          'X-GitHub-Api-Version': '2022-11-28'
        }
      });

      if (!response.ok) {
        throw new Error('Failed to fetch public emails');
      }

      const emails = await response.json();
      if (!Array.isArray(emails)) {
        throw new Error('Unexpected response from GitHub');
      }

      email = emails.filter(entry => entry.primary)[0].email;
      //
      //
    } catch (e) {
      vscode.window.showErrorMessage('Please sign in to GitHub');
      return;
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
    const stopAtFirstOpcode = getConfigValue('stop-at-first-opcode', true);
    const showSourcemaps = getConfigValue('show-sourcemaps', false);
    const debugConfigName = `${contractName}.${methodSignature}`;
    const jsonRpcUrl = getConfigValue('json-rpc-url', 'http://localhost:8545');
    const sourcifyUrl = getConfigValue('sourcify-url', 'http://localhost:5555');
    const autobuild = getConfigValue('autobuild', true);
    if (autobuild) {
      progress.report({ message: "Compiling" });
      const build = forgeBuildTask(activeTextEditor.document.uri);
      const buildExecution = await vscode.tasks.executeTask(build);
      try {
        await completed(buildExecution);
      } catch (e) {
        vscode.window.showErrorMessage('Failed to build project.');
        return;
      }
    }
    const myFoundryRoot = await foundryRoot(activeTextEditor.document.uri);
    const buildInfo = await loadBuildInfo(activeTextEditor.document.uri);
    const myDebugConfig = debugConfig(
      debugConfigName,
      file,
      contractName,
      methodSignature,
      stopAtFirstOpcode,
      showSourcemaps,
      jsonRpcUrl,
      sourcifyUrl,
      buildInfo,
      myFoundryRoot
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
  stopAtFirstOpcode: boolean,
  showSourcemaps: boolean,
  jsonRpcUrl: string,
  sourcifyUrl: string,
  buildInfo: string,
  clientMount: vscode.Uri
) {
  return {
    name: name,
    type: 'solidity',
    request: 'launch',
    file: file,
    contractName: contractName,
    methodSignature: methodSignature,
    stopAtFirstOpcode: stopAtFirstOpcode,
    showSourcemaps: showSourcemaps,
    jsonRpcUrl: jsonRpcUrl,
    sourcifyUrl: sourcifyUrl,
    buildInfo: buildInfo,
    clientMount: clientMount,
  };
}
