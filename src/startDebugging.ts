import {
  ContractDefinition,
  FunctionDefinition,
  TypeName,
  VariableDeclaration,
} from '@solidity-parser/parser/dist/src/ast-types';
import * as vscode from 'vscode';
import { getConfigValue } from './utils';
import { forgeBuild, foundryRoot, getArtifact, getBuildInfoFileFromCache } from './foundry';

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
) {
  const result = await vscode.window.withProgress({
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

    const file = activeTextEditor.document.uri.toString();
    const contractName = contract['name'];
    const showSourcemaps = getConfigValue('show-sourcemaps', false);
    const jsonRpcUrl = getConfigValue('json-rpc-url', 'http://localhost:8545');
    const sourcifyUrl = getConfigValue('sourcify-url', 'http://localhost:5555');
    const autobuild = getConfigValue<'always'|'on-change'|'never'>('autobuild', 'on-change');
    const rpcNodeType = getConfigValue<'anvil'|'kontrol-node'>('rpc-node-type', 'anvil');

    // Compile the project if necessary
    // Caching logic is handled by Foundry itself
    // If autobuild is 'always', we always force a rebuild
    if (autobuild === 'always' || autobuild === 'on-change') {
      progress.report({ message: "Compiling" });
      try {
        await forgeBuild(activeTextEditor.document.uri, autobuild === 'always');
      } catch (e) {
        vscode.window.showErrorMessage('Failed to build project. Please check the terminal for build errors.');
        return;
      }
    }
    
    let buildInfoFiles;
    try {
      buildInfoFiles = [await getBuildInfoFileFromCache(activeTextEditor.document.uri)];
    } catch (e) {
      if (autobuild === 'never') {
        vscode.window.showErrorMessage('Build info not found in cache. Autobuild is disabled; please build the project manually before debugging or enable autobuild.');
      } else {
        vscode.window.showErrorMessage('Build info not found in cache. Please check the terminal for build errors.');
      }
      return;
    }

    const contractArtifact = await getArtifact(activeTextEditor.document.uri, contractName);
    const content = await vscode.workspace.fs.readFile(contractArtifact);
    const textContent = new TextDecoder().decode(content);
    const artifact = JSON.parse(textContent);
    const methodSignature = Object.keys(artifact.methodIdentifiers ?? {}).find(sig => sig.startsWith(method['name'] + '('))!;
    const abiParams = methodSignature.slice(method['name']!.length + 1, - 1);
    if (abiParams !== '') {
      // Prompt user for input parameters
      const userInputs = await vscode.window.showInputBox({
        prompt: `Enter input parameters for ${methodSignature}.`,
        placeHolder: abiParams
      });
    }


    progress.report({ increment: 100 });

    const debugConfigName = `${contractName}.${methodSignature}`;
    const clientVersion = vscode.extensions.getExtension('runtimeverification.simbolik')?.packageJSON.version;
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
      rpcNodeType
    );
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
  rpcNodeType: string
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
    rpcNodeType: rpcNodeType
  };
}
