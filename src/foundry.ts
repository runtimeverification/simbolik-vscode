import * as vscode from 'vscode';
import {getConfigValue} from './utils';
import {parse as parseToml} from 'smol-toml';
import { execSync } from 'child_process';

const SOLC = __dirname + '/../bin/solc.js';

export
type CompilerInput = {
  metadata: string,
  stdin: string,
}

export
async function forgeStdInput(file: vscode.Uri) : Promise<CompilerInput> {
  const forgePath = getConfigValue('forge-path', 'forge');
  const cwd = await foundryRoot(file);
  try {
    execSync(`${forgePath} build --use ${SOLC}`,{
      cwd: cwd.fsPath,
      encoding: 'utf-8',
      env: {
        ...process.env,
        'FOUNDRY_OPTIMIZER': 'false',
        'FOUNDRY_BUILD_INFO': 'true',
        'FOUNDRY_EXTRA_OUTPUT': '["storageLayout", "evm.bytecode.generatedSources", "evm.legacyAssembly", "evm.deployedBytecode.immutableReferences"]',
        'FOUNDRY_BYTECODE_HASH': 'ipfs',
        'FOUNDRY_CBOR_METADATA': 'true',
        'FOUNDRY_FORCE': 'true',
      }
    });
  } catch (e) {
    // The build always fails, because we're intercepting the solc command
    // We only need the solc version and standard input
    if (e instanceof Error) {
      if ('stderr' in e) {
        if (e.stderr !== 'Error: expected value at line 1 column 1\n') {
          vscode.window.showErrorMessage('Failed to compile contract');
        }
      }
    } else {
      vscode.window.showErrorMessage('Failed to compile contract');
    }
  }
  const stdin = await readFile(vscode.Uri.joinPath(cwd, '.simbolik/stdin.json'));
  const metadata = await readFile(vscode.Uri.joinPath(cwd, '.simbolik/metadata.json'));
  return {stdin, metadata};
}

async function readFile(uri: vscode.Uri): Promise<string> {
  const data = await vscode.workspace.fs.readFile(uri);
  return new TextDecoder('utf-8').decode(data);
}

export
async function foundryRoot(file: vscode.Uri): Promise<vscode.Uri> {
  // Find the root of the project, which is the directory containing the foundry.toml file
  let base = file.with({'path': '/'})
  let pathSegments = file.path.split('/');
  let stat;
  try {
    const uri = vscode.Uri.joinPath(base, ...pathSegments, 'foundry.toml');
    stat = await vscode.workspace.fs.stat(uri);
  } catch (e) {
    stat = false;
  }
  while (!stat) {
    if (pathSegments.length === 0) {
      throw new Error('No foundry.toml found');
    }
    pathSegments.pop();
    try {
      const uri = vscode.Uri.joinPath(base, ...pathSegments, 'foundry.toml');
      stat = await vscode.workspace.fs.stat(uri);
    } catch (e) {
      stat = false;
    }
  }
  return vscode.Uri.joinPath(base, ...pathSegments);
}

export
type FoundryConfig = { 'profile'?: { [profile: string]: { [key: string]: string } } };

export
async function foundryConfig(root: vscode.Uri): Promise<FoundryConfig> {
  const configPath = vscode.Uri.joinPath(root, 'foundry.toml');
  const config = await vscode.workspace.fs.readFile(configPath);
  const text = new TextDecoder().decode(config);
  return parseToml(text);
}
