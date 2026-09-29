import {
  ContractDefinition,
  FunctionDefinition,
} from '@solidity-parser/parser/dist/src/ast-types';
import * as vscode from 'vscode';
import {getConfigValue} from './utils';
import {forgeBuild, getArtifact, getBuildInfoFileFromCache} from './foundry';
import {abiEncode} from './abi';

export interface PartialDebugConfiguration extends vscode.DebugConfiguration {
  file: string;
  contractName: string;
  methodName: string;
}

export interface FullDebugConfiguration {
  name: string;
  type: 'solidity';
  request: 'launch' | 'attach';
  file: string;
  contractName: string;
  methodSignature: string;
  payload: string;
  jsonRpcUrl: string;
  sourcifyUrl: string;
  buildInfoFiles: vscode.Uri[];
  rpcNodeType: 'anvil' | 'kontrol-node';
}

/**
 * Start a debugging session for the given file, contract and method.
 */
export async function startDebugging(
  file: vscode.Uri,
  contract: ContractDefinition,
  method: FunctionDefinition
) {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(file);
  if (!workspaceFolder) {
    vscode.window.showErrorMessage(
      'Debugging can only be started from within a workspace folder.'
    );
    return;
  }
  const name = `${contract.name}.${method.name}`;
  await vscode.debug.startDebugging(workspaceFolder, {
    type: 'solidity',
    name,
    request: 'launch',
    file: file.toString(),
    contractName: contract.name,
    methodName: method.name,
  });
}

/**
 * Populate the debug configuration by performing the necessary preparation steps.
 * The two-phase approach of first creating a partial configuration with the basic
 * info, then populating it with the rest of the details is needed, so that we can
 * run the preparation steps again when the user hits the "restart" button in the
 * debug view.
 *
 * 1. Compile the project if necessary
 * 2. Prompt for input parameters if needed
 * 3. Create and start the debug configuration
 *
 * @param config The partial configuration identifying the contract and method.
 * @returns The fully populated debug configuration.
 */
export async function populateDebugConfiguration(
  config: PartialDebugConfiguration,
  log: (line: string) => void = () => {}
): Promise<FullDebugConfiguration> {
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Simbolik',
    },
    async progress => {
      let buildInfoFile: vscode.Uri;
      let methodSignature: string;
      let payload: string;
      try {
        progress.report({message: 'Compiling'});
        buildInfoFile = await compile(vscode.Uri.parse(config.file), log);
        progress.report({increment: 100});
        methodSignature = await getMethodSignature(
          vscode.Uri.parse(config.file),
          config.contractName,
          config.methodName
        );
        payload = await getUserInput(methodSignature);
      } catch (e) {
        vscode.window.showErrorMessage((e as Error).message);
        return;
      }

      const contractName = config.contractName;
      const jsonRpcUrl = getConfigValue(
        'json-rpc-url',
        'http://localhost:8545'
      );
      const sourcifyUrl = getConfigValue(
        'sourcify-url',
        'http://localhost:5555'
      );
      // kontrol-node (the KEVM engine) is the default backend for every session;
      // users can switch to anvil via the "simbolik.rpc-node-type" setting.
      const rpcNodeType = getConfigValue<'anvil' | 'kontrol-node'>(
        'rpc-node-type',
        'kontrol-node'
      );
      const debugConfigName = `${contractName}.${methodSignature}`;

      const debugConfig: FullDebugConfiguration = {
        name: debugConfigName,
        type: 'solidity',
        request: 'launch',
        file: config.file,
        contractName,
        methodSignature: methodSignature,
        payload: payload,
        jsonRpcUrl: jsonRpcUrl,
        sourcifyUrl: sourcifyUrl,
        buildInfoFiles: [buildInfoFile],
        rpcNodeType: rpcNodeType,
      };
      return debugConfig;
    }
  );
  if (!result) {
    throw new Error(
      'Failed to start debugging session due to previous errors.'
    );
  }
  return result;
}

async function compile(
  file: vscode.Uri,
  log: (line: string) => void = () => {}
): Promise<vscode.Uri> {
  const autobuild = getConfigValue<'always' | 'on-change' | 'never'>(
    'autobuild',
    'on-change'
  );

  if (autobuild === 'always' || autobuild === 'on-change') {
    try {
      log(`Compiling (forge build, autobuild: ${autobuild}) …`);
      const output = await forgeBuild(
        file,
        autobuild === 'always',
        'simbolik',
        'simbolik'
      );
      const trimmed = output.trim();
      if (trimmed.length > 0) {
        log(trimmed);
      }
    } catch (e) {
      throw new Error(
        'Failed to build project. Please check the terminal for build errors.'
      );
    }
  } else {
    log('Autobuild disabled; using cached build-info.');
  }

  let buildInfoFile: vscode.Uri;
  try {
    buildInfoFile = await getBuildInfoFileFromCache(file, 'simbolik');
  } catch (e) {
    if (autobuild === 'never') {
      throw new Error(
        'Build info not found in cache. Autobuild is disabled; please build the project manually before debugging or enable autobuild.'
      );
    } else {
      throw new Error(
        'Build info not found in cache. Please check the terminal for build errors.'
      );
    }
  }
  return buildInfoFile;
}

async function getMethodSignature(
  file: vscode.Uri,
  contractName: string,
  methodName: string
): Promise<string> {
  const contractArtifact = await getArtifact(file, contractName, 'simbolik');
  const content = await vscode.workspace.fs.readFile(contractArtifact);
  const textContent = new TextDecoder().decode(content);
  const artifact = JSON.parse(textContent);
  const methodSignature = Object.keys(artifact.methodIdentifiers ?? {}).find(
    sig => sig.startsWith(methodName + '(')
  )!;
  return methodSignature;
}

async function getUserInput(methodSignature: string): Promise<string> {
  // Extract parameter types from method signature
  const abiParams = methodSignature.slice(methodSignature.indexOf('('));
  if (abiParams === '()') {
    return '0x';
  }
  // Prompt user for input parameters
  let encoded: string | undefined;
  const userInput = await vscode.window.showInputBox({
    prompt: `Enter input parameters for ${methodSignature}.`,
    placeHolder: abiParams.slice(1, -1),
    validateInput: value => {
      try {
        const type = methodSignature.slice(methodSignature.indexOf('('));
        encoded = abiEncode(type, `(${value})`);
      } catch (e) {
        return {
          message: `Invalid input parameters. Expecting types: ${abiParams.slice(1, -1)}. Provide parameters in Solidity literal syntax.`,
          severity: vscode.InputBoxValidationSeverity.Error,
        };
      }
      return undefined;
    },
  });
  if (userInput === undefined || !encoded) {
    throw new Error('Debugging cancelled: input parameters required.');
  }
  return encoded;
}
