import {
  ContractDefinition,
  Expression,
  ExpressionStatement,
  FunctionCall,
  FunctionDefinition,
} from '@solidity-parser/parser/dist/src/ast-types';
import * as vscode from 'vscode';
import {getConfigValue} from './utils';
import {
  forgeBuild,
  foundryRoot,
  getArtifact,
  getBuildInfoFileFromCache,
} from './foundry';
import {tuple} from '@metamask/abi-utils/dist/parsers';
import * as parser from '@solidity-parser/parser';

export type Credentials =
  | {
      provider: 'github';
      token: string;
    }
  | {
      provider: 'simbolik';
      token: string;
    };

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
  method: FunctionDefinition
) {
  const result = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: 'Simbolik',
    },
    async progress => {
      const workspaceFolder = vscode.workspace.getWorkspaceFolder(file);
      if (!workspaceFolder) {
        vscode.window.showErrorMessage(
          'Debugging can only be started from within a workspace folder.'
        );
        return;
      }

      let credentials: Credentials;
      let buildInfoFile: vscode.Uri;
      let methodSignature: string;
      let isTest: boolean;
      let payload: Uint8Array<ArrayBufferLike>;
      try {
        credentials = await getCredentials();
        progress.report({message: 'Compiling'});
        buildInfoFile = await compile(file);
        progress.report({increment: 100});
        ({methodSignature, isTest} = await getMethodSignature(
          file,
          contract,
          method
        ));
        if (isTest) {
          const hasPermission = await precheckPermission(credentials);
          if (!hasPermission) {
            throw new Error(
              'Debugging test functions is only available to users with "contributor" or "team player" roles.' +
                'Login into https://www.simbolik.dev/ for more information on how to get access, or contact support if you believe you should have access.'
            );
          }
        }
        payload = await getUserInput(methodSignature);
      } catch (e) {
        vscode.window.showErrorMessage((e as Error).message);
        return;
      }

      const contractName = contract['name'];
      const showSourcemaps = getConfigValue('show-sourcemaps', false);
      const jsonRpcUrl = getConfigValue(
        'json-rpc-url',
        'http://localhost:8545'
      );
      const sourcifyUrl = getConfigValue(
        'sourcify-url',
        'http://localhost:5555'
      );
      const rpcNodeType = isTest ? 'kontrol-node' : 'anvil';
      const debugConfigName = `${contractName}.${methodSignature}`;
      const clientVersion = vscode.extensions.getExtension(
        'runtimeverification.simbolik'
      )?.packageJSON.version;
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
        rpcNodeType: rpcNodeType,
      };
      return {workspaceFolder, debugConfig};
    }
  );
  if (!result) {
    return;
  }
  const {workspaceFolder, debugConfig} = result;
  await vscode.debug.startDebugging(workspaceFolder, debugConfig);
  return;
}

/**
 * Resolves credentials for the current user using the following priority order:
 * 1. Simbolik API key from extension configuration.
 * 2. An existing GitHub session (silent, no prompt).
 * 3. Interactive prompt asking the user to choose an authentication method.
 */
async function getCredentials(): Promise<Credentials> {
  const apiKey = getConfigValue<string>('api-key', 'valid-api-key');
  if (apiKey !== 'valid-api-key' && apiKey !== '') {
    return {provider: 'simbolik', token: apiKey};
  }

  const existingSession = await vscode.authentication.getSession(
    'github',
    ['user:email'],
    {createIfNone: false}
  );
  if (existingSession) {
    return {provider: 'github', token: existingSession.accessToken};
  }

  return promptForAuthentication();
}

/**
 * Asks the user to choose between signing in with GitHub or entering a Simbolik API key,
 * then delegates to the appropriate sign-in flow.
 * @throws if the user dismisses the prompt without making a choice.
 */
async function promptForAuthentication(): Promise<Credentials> {
  const choice = await vscode.window.showQuickPick(
    ['Sign in with GitHub', 'Enter Simbolik API Key'],
    {placeHolder: 'Choose authentication method'}
  );
  if (!choice) {
    throw new Error('Authentication required to start debugging.');
  }
  return choice === 'Enter Simbolik API Key'
    ? promptForSimbolikApiKey()
    : signInWithGitHub();
}

/**
 * Prompts the user to enter a Simbolik API key, saves it to the global extension
 * configuration for future use, and returns it as credentials.
 * @throws if the user dismisses the input box without entering a key.
 */
async function promptForSimbolikApiKey(): Promise<Credentials> {
  const input = await vscode.window.showInputBox({
    prompt: 'Enter your Simbolik API key',
    ignoreFocusOut: true,
    validateInput: value =>
      value.trim() === '' ? 'API key cannot be empty' : undefined,
  });
  if (!input) {
    throw new Error('Simbolik API key is required to start debugging.');
  }
  const token = input.trim();
  await vscode.workspace
    .getConfiguration()
    .update('simbolik.api-key', token, vscode.ConfigurationTarget.Global);
  return {provider: 'simbolik', token};
}

/**
 * Triggers the VS Code GitHub authentication flow and returns the resulting credentials.
 * @throws if authentication fails or the user cancels the sign-in.
 */
async function signInWithGitHub(): Promise<Credentials> {
  const session = await vscode.authentication.getSession(
    'github',
    ['user:email'],
    {createIfNone: true}
  );
  if (!session) {
    throw new Error('GitHub authentication failed. Please try again.');
  }
  return {provider: 'github', token: session.accessToken};
}

async function compile(file: vscode.Uri): Promise<vscode.Uri> {
  const autobuild = getConfigValue<'always' | 'on-change' | 'never'>(
    'autobuild',
    'on-change'
  );

  if (autobuild === 'always' || autobuild === 'on-change') {
    try {
      await forgeBuild(file, autobuild === 'always', 'simbolik', 'simbolik');
    } catch (e) {
      throw new Error(
        'Failed to build project. Please check the terminal for build errors.'
      );
    }
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
  contract: ContractDefinition,
  method: FunctionDefinition
): Promise<{methodSignature: string; isTest: boolean}> {
  const contractArtifact = await getArtifact(
    file,
    contract['name'],
    'simbolik'
  );
  const content = await vscode.workspace.fs.readFile(contractArtifact);
  const textContent = new TextDecoder().decode(content);
  const artifact = JSON.parse(textContent);
  const methodSignature = Object.keys(artifact.methodIdentifiers ?? {}).find(
    sig => sig.startsWith(method['name'] + '(')
  )!;
  const isTest = Object.keys(artifact.methodIdentifiers ?? {}).some(
    sig => sig === 'IS_TEST()'
  );
  return {methodSignature, isTest};
}

async function getUserInput(
  methodSignature: string
): Promise<Uint8Array<ArrayBufferLike>> {
  // Extract parameter types from method signature
  const abiParams = methodSignature.slice(methodSignature.indexOf('('));
  if (abiParams === '()') {
    return new Uint8Array();
  }
  // Prompt user for input parameters
  let encoded: Uint8Array<ArrayBufferLike> | undefined;
  const userInput = await vscode.window.showInputBox({
    prompt: `Enter input parameters for ${methodSignature}.`,
    placeHolder: abiParams.slice(1, -1),
    validateInput: value => {
      try {
        const parsed = parse(value);
        encoded = tuple.encode({
          type: abiParams,
          value: parsed,
          buffer: new Uint8Array(),
          packed: false,
          tight: false,
        });
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

type Param = BigInt | string | boolean | Param[];

function parse(input: string): Param[] {
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

function toParam(expr: Expression): Param {
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

const denominationMap: {[key: string]: bigint} = {
  wei: 1n,
  kwei: 1000n,
  ada: 1000n,
  femtoether: 1000n,
  mwei: 1000000n,
  babbage: 1000000n,
  picoether: 1000000n,
  gwei: 1000000000n,
  shannon: 1000000000n,
  nanoether: 1000000000n,
  nano: 1000000000n,
  szabo: 1000000000000n,
  microether: 1000000000000n,
  micro: 1000000000000n,
  finney: 1000000000000000n,
  milliether: 1000000000000000n,
  milli: 1000000000000000n,
  ether: 1000000000000000000n,
  kether: 1000000000000000000000n,
  grand: 1000000000000000000000n,
  einstein: 1000000000000000000000n,
  mether: 1000000000000000000000000n,
  gether: 1000000000000000000000000000n,
  tether: 1000000000000000000000000000000n,
};

function uint8ArrayToHex(bytes: Uint8Array<ArrayBufferLike>): string {
  return (
    '0x' +
    Array.from(bytes)
      .map(b => b.toString(16).padStart(2, '0'))
      .join('')
  );
}

/**
 * Checks whether the authenticated user has permission to debug test functions,
 * which is a feature exclusive to Simbolik supporters.
 *
 * Queries the `/permissions` endpoint of the configured Simbolik server. Returns
 * `true` if the user has the `kontrol-node` permission, or if the check cannot be
 * completed (e.g. network error, unexpected response) — failing open to avoid
 * blocking users unnecessarily.
 *
 * @param credentials - The credentials to authenticate the request with.
 * @returns `true` if the user is authorized (or authorization could not be verified), `false` otherwise.
 */
async function precheckPermission(credentials: Credentials): Promise<boolean> {
  const api = getConfigValue('server', 'wss://code.simbolik.dev');
  const endpoint = api.replace('ws', 'http') + '/permissions';
  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        'x-auth-provider': credentials.provider,
        'x-auth-token': credentials.token,
      },
      signal: AbortSignal.timeout(2000), // Set a timeout to avoid hanging if the server is unresponsive
    });
    if (!response.ok) {
      return true;
    }
    const data = await response.json();
    return !Array.isArray(data) || data.includes('kontrol-node');
  } catch (e) {
    // If the request fails (e.g., network error), we don't want to block debugging, so we return true.
    return true;
  }
}
