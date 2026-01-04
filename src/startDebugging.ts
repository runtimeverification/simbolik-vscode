import {
  ContractDefinition,
  FunctionDefinition,
  TypeName,
  VariableDeclaration,
} from '@solidity-parser/parser/dist/src/ast-types';
import * as vscode from 'vscode';
import { getConfigValue } from './utils';
import { forgeBuild, foundryRoot, getArtifact, getBuildInfoFileFromCache } from './foundry';
import { compileFunction } from 'vm';

export
type Credentials = {
  provider: 'github',
  token: string
} | {
  provider: 'simbolik',
  token: string
}

/**
 * Start a debugging session for the given contract and method.
 * 
 * 1. Gather configuration and credentials
 * 2. Compile the project if necessary
 * 3. Prompt for input parameters if needed
 * 4. Create and start the debug configuration
 * 
 * @param contract The contract definition to debug.
 * @param method The method definition to debug.
 * @returns 
 */
export async function startDebugging(
  file: vscode.Uri,
  contract: ContractDefinition,
  method: FunctionDefinition,
) {
  const result = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "Simbolik"
  }, async (progress) => {

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(file);
    if (!workspaceFolder) {
      vscode.window.showErrorMessage('Debugging can only be started from within a workspace folder.');
      return;
    }

    let credentials: Credentials;
    let buildInfoFile: vscode.Uri;
    let methodSignature: string;
    let payload: string;
    try {
      credentials = await getCredentials();
      progress.report({ message: "Compiling" });
      buildInfoFile = await compile(file);
      progress.report({ increment: 100 });
      methodSignature = await getMethodSignature(file, contract, method);
      payload = await getUserInput(methodSignature);
    } catch (e) {
      vscode.window.showErrorMessage((e as Error).message);
      return;
    }

    const contractName = contract['name'];
    const showSourcemaps = getConfigValue('show-sourcemaps', false);
    const jsonRpcUrl = getConfigValue('json-rpc-url', 'http://localhost:8545');
    const sourcifyUrl = getConfigValue('sourcify-url', 'http://localhost:5555');
    const rpcNodeType = getConfigValue<'anvil'|'kontrol-node'>('rpc-node-type', 'anvil');
    const debugConfigName = `${contractName}.${methodSignature}`;
    const clientVersion = vscode.extensions.getExtension('runtimeverification.simbolik')?.packageJSON.version;
    const myFoundryRoot = await foundryRoot(file);

    const debugConfig = {
      name: debugConfigName,
      type: 'solidity',
      request: 'launch',
      file: file.toString(),
      contractName: contractName,
      methodSignature: methodSignature,
      stopAtFirstOpcode: false,
      showSourcemaps: showSourcemaps,
      jsonRpcUrl: jsonRpcUrl,
      sourcifyUrl: sourcifyUrl,
      buildInfoFiles: [buildInfoFile],
      clientMount: myFoundryRoot,
      credentials: credentials,
      clientVersion: clientVersion,
      rpcNodeType: rpcNodeType
    };
    return { workspaceFolder, debugConfig };
  });
  if (!result) {
    return;
  }
  const { workspaceFolder, debugConfig } = result;
  const debugSession = await vscode.debug.startDebugging(
    workspaceFolder,
    debugConfig
  );
  return;
}

async function getCredentials(): Promise<Credentials> {
  const apiKey = getConfigValue<string>('api-key', 'valid-api-key')
  let credentials: Credentials;
  if (apiKey !== 'valid-api-key' && apiKey !== '') {
    credentials = { provider: 'simbolik', token: apiKey };
  } else {
    const session = await vscode.authentication.getSession('github', ['user:email'], {
      createIfNone: true
    });
    if (!session) {
      throw new Error('Please sign in to GitHub or provide a Simbolik API key.');
    }
    credentials = { provider: 'github', token: session.accessToken };
  }
  return credentials;
}

async function compile(file: vscode.Uri): Promise<vscode.Uri> {
  const autobuild = getConfigValue<'always'|'on-change'|'never'>('autobuild', 'on-change');
 
  if (autobuild === 'always' || autobuild === 'on-change') {
    try {
      await forgeBuild(file, autobuild === 'always');
    } catch (e) {
      throw new Error('Failed to build project. Please check the terminal for build errors.');
    }
  }
  
  let buildInfoFile: vscode.Uri;
  try {
    buildInfoFile = await getBuildInfoFileFromCache(file);
  } catch (e) {
    if (autobuild === 'never') {
      throw new Error('Build info not found in cache. Autobuild is disabled; please build the project manually before debugging or enable autobuild.');
    } else {
      throw new Error('Build info not found in cache. Please check the terminal for build errors.');
    }
  }
  return buildInfoFile;
}

async function getMethodSignature(file: vscode.Uri, contract: ContractDefinition, method: FunctionDefinition): Promise<string> {
  const contractArtifact = await getArtifact(file, contract['name']);
  const content = await vscode.workspace.fs.readFile(contractArtifact);
  const textContent = new TextDecoder().decode(content);
  const artifact = JSON.parse(textContent);
  const methodSignature = Object.keys(artifact.methodIdentifiers ?? {}).find(sig => sig.startsWith(method['name'] + '('))!;
  return methodSignature;
}

async function getUserInput(methodSignature: string): Promise<string> {
  // Extract parameter types from method signature
  const abiParams = methodSignature.slice(methodSignature.indexOf('(') + 1, -1);
  if (abiParams === '') {
    return '';
  }
  // Prompt user for input parameters
  const userInput = await vscode.window.showInputBox({
    prompt: `Enter input parameters for ${methodSignature}.`,
    placeHolder: abiParams
  });
  if (userInput === undefined) {
    throw new Error('Debugging cancelled: input parameters required.');
  }
  return userInput;
}