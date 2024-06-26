import {
  ContractDefinition,
  FunctionDefinition,
  TypeName,
  VariableDeclaration,
} from '@solidity-parser/parser/dist/src/ast-types';
import * as vscode from 'vscode';
import { getConfigValue } from './utils';
import { Supervisor } from './supevervisor';
import { forgeBuildTask, foundryRoot, loadBuildInfo } from './foundry';

export async function startDebugging(
  this: Supervisor,
  contract: ContractDefinition,
  method: FunctionDefinition
) {
  if (getConfigValue('anvil-autostart', true)) {
    this.anvilTerminate();
    this.anvil();
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
  const stopAtFirstOpcode = getConfigValue('stop-at-first-opcode', false);
  const showSourcemaps = getConfigValue('show-sourcemaps', false);
  const debugConfigName = `${contractName}.${methodSignature}`;
  const anvilPort = getConfigValue('anvil-port', '8545');
  const rpcUrl = `http://localhost:${anvilPort}`;
  const autobuild = getConfigValue('autobuild', true);
  if (autobuild) {
    const build = forgeBuildTask(activeTextEditor.document.uri.fsPath);
    const buildExecution = await vscode.tasks.executeTask(build);
    try {
      await completed(buildExecution);
    } catch (e) {
      vscode.window.showErrorMessage('Failed to build project.');
    }
  }
  const myFoundryRoot = await foundryRoot(activeTextEditor.document.uri.fsPath);
  const buildInfo = await loadBuildInfo(activeTextEditor.document.uri.fsPath);
  const myDebugConfig = debugConfig(
    debugConfigName,
    file,
    contractName,
    methodSignature,
    stopAtFirstOpcode,
    showSourcemaps,
    rpcUrl,
    buildInfo,
    myFoundryRoot
  );
  const session = await vscode.debug.startDebugging(
    workspaceFolder,
    myDebugConfig
  );
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
  rpcUrl: string,
  buildInfo: string,
  clientMount: string
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
    rpcUrl: rpcUrl,
    buildInfo: buildInfo,
    clientMount: clientMount,
  };
}
