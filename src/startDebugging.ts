import {
  ContractDefinition,
  Expression,
  ExpressionStatement,
  FunctionCall,
  FunctionDefinition,
} from '@solidity-parser/parser/dist/src/ast-types';
import * as vscode from 'vscode';
import { getConfigValue } from './utils';
import { forgeBuild, foundryRoot, getArtifact, getBuildInfoFileFromCache } from './foundry';
import { tuple } from '@metamask/abi-utils/dist/parsers';
import * as parser from '@solidity-parser/parser';

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
    let payload: Uint8Array<ArrayBufferLike>;
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
      payload: uint8ArrayToHex(payload),
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

async function getUserInput(methodSignature: string): Promise<Uint8Array<ArrayBufferLike>> {
  // Extract parameter types from method signature
  const abiParams = methodSignature.slice(methodSignature.indexOf('('));
  if (abiParams === '()') {
    return new Uint8Array();
  }
  // Prompt user for input parameters
  let encoded: Uint8Array<ArrayBufferLike> | undefined;
  let userInput = await vscode.window.showInputBox({
    prompt: `Enter input parameters for ${methodSignature}.`,
    placeHolder: abiParams.slice(1, -1),
    validateInput: (value) => {
      try {
        const parsed = parse(value);
        encoded = tuple.encode({
          type: abiParams,
          value: parsed,
          buffer: new Uint8Array(),
          packed: false,
          tight: false,
        })
      } catch (e) {
        return {
          message: `Invalid input parameters. Expecting types: ${abiParams.slice(1, -1)}. Provide parameters in Solidity literal syntax.`,
          severity: vscode.InputBoxValidationSeverity.Error
        };
      }
      return undefined;
    }
  });
  if (userInput === undefined || !encoded) {
    throw new Error('Debugging cancelled: input parameters required.');
  }
  return encoded;
}

type Param = BigInt | string | boolean | Param[];

function parse(input: string) : Param[] {
  const parsed = parser.parse(`
    contract Dummy {
      function dummy() {
        foo(${input});
      }
    }
  `);
  const contract = parsed.children[0] as ContractDefinition;
  const method = contract.subNodes[0] as FunctionDefinition;
  const stmt = method.body!.statements[0]! as ExpressionStatement;
  const call = stmt.expression! as FunctionCall;
  const args = call.arguments;
  const result = args.map(arg => toParam(arg as Expression));
  return result;
}

function toParam(expr: Expression) : Param {
  switch (expr.type) {
    case 'TupleExpression':
      return expr.components.map(e => toParam(e as Expression));
    case 'NumberLiteral':
      if (expr.subdenomination) {
        const base = BigInt(expr.number);
        const factor = denominationMap[expr.subdenomination]!;
        return base * factor;
      }
      return BigInt(expr.number);
    case 'BooleanLiteral':
      return expr.value;
    case 'StringLiteral':
      return expr.value;
    default:
      throw new Error();
  }
}

const denominationMap: { [key: string]: bigint } = {
  'wei':          1n,
  'kwei':         1000n,
  'ada':          1000n,
  'femtoether':   1000n,
  'mwei':         1000000n,
  'babbage':      1000000n,
  'picoether':    1000000n,
  'gwei':         1000000000n,
  'shannon':      1000000000n,
  'nanoether':    1000000000n,
  'nano':         1000000000n,
  'szabo':        1000000000000n,
  'microether':   1000000000000n,
  'micro':        1000000000000n,
  'finney':       1000000000000000n,
  'milliether':   1000000000000000n,
  'milli':        1000000000000000n,
  'ether':        1000000000000000000n,
  'kether':       1000000000000000000000n,
  'grand':        1000000000000000000000n,
  'einstein':     1000000000000000000000n,
  'mether':       1000000000000000000000000n,
  'gether':       1000000000000000000000000000n,
  'tether':       1000000000000000000000000000000n
};

function uint8ArrayToHex(bytes: Uint8Array<ArrayBufferLike>): string {
  return '0x' + Array.from(bytes)
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}