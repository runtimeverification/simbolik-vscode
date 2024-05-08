import {
  ContractDefinition,
  FunctionDefinition,
  TypeName,
  VariableDeclaration,
} from '@solidity-parser/parser/dist/src/ast-types';
import * as vscode from 'vscode';
import {getConfigValue} from './utils';

export async function startDebugging(
  contract: ContractDefinition,
  method: FunctionDefinition
) {
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
  const myDebugConfig = debugConfig(
    debugConfigName,
    file,
    contractName,
    methodSignature,
    stopAtFirstOpcode,
    showSourcemaps,
    rpcUrl
  );

  const autobuild = getConfigValue('autobuild', true);

  if (autobuild) {
    const build = forgeBuildTask(activeTextEditor.document.uri.fsPath);
    const buildExecution = await vscode.tasks.executeTask(build);
    try {
      await completed(buildExecution);
      const session = await vscode.debug.startDebugging(
        workspaceFolder,
        myDebugConfig
      );
    } catch (e) {
      vscode.window.showErrorMessage('Failed to build project.');
    }
  } else {
    const session = await vscode.debug.startDebugging(
      workspaceFolder,
      myDebugConfig
    );
  }
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
  rpcUrl: string
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
    rpcUrl: rpcUrl
  };
}

function forgeBuildTask(file: string) {
  const incrementalBuild = getConfigValue('incremental-build', false);
  const forgePath = getConfigValue('forge-path', 'forge');
  const cwd = file.substring(0, file.lastIndexOf('/'));
  const task = new vscode.Task(
    {
      label: 'forge build',
      type: 'shell',
    },
    vscode.TaskScope.Workspace,
    'forge',
    'simbolik',
    new vscode.ShellExecution(forgePath, ['build'], {
      cwd,
      env: {
        'FOUNDRY_OPTIMIZER': 'false',
        'FOUNDRY_BUILD_INFO': 'true',
        'FOUNDRY_EXTRA_OUTPUT': '["storageLayout", "evm.bytecode.generatedSources"]',
        'FOUNDRY_BYTECODE_HASH': 'ipfs',
        'FOUNDRY_CBOR_METADATA': 'true',
        'FOUNDRY_CACHE': 'true',
      }
    })
  );
  task.isBackground = true;
  task.presentationOptions.reveal = vscode.TaskRevealKind.Always;
  return task;
}
