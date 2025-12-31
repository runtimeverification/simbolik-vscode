import * as vscode from 'vscode';
import {getConfigValue} from './utils';
import {parse as parseToml} from 'smol-toml';
import { LcovRecord, parseLcov } from './lcov';

export
async function forgeBuildTask(file: vscode.Uri, force: boolean = false): Promise<vscode.Task> {
  const forgePath = getConfigValue('forge-path', 'forge');
  const cwd = file.with({path: file.path.split('/').slice(0, -1).join('/')}).fsPath;
  const projectRoot = await foundryRoot(file);
  const compilationTarget = relativePath(projectRoot, file);
  const task = new vscode.Task(
    {
      label: 'forge build',
      type: 'shell',
    },
    vscode.TaskScope.Workspace,
    'forge',
    'simbolik',
    new vscode.ShellExecution(forgePath, ['build', compilationTarget.fsPath.slice(1)], {
      cwd,
      env: {
        'FOUNDRY_OPTIMIZER': 'false',
        'FOUNDRY_BUILD_INFO': 'true',
        'FOUNDRY_EXTRA_OUTPUT': '["storageLayout", "evm.bytecode.generatedSources", "evm.bytecode.functionDebugData", "evm.deployedBytecode.functionDebugData", "evm.deployedBytecode.immutableReferences"]',
        'FOUNDRY_BYTECODE_HASH': 'ipfs',
        'FOUNDRY_CBOR_METADATA': 'true',
        'FOUNDRY_FORCE': force ? 'true' : 'false',
        'FOUNDRY_CACHE': 'true',
        'FOUNDRY_USE_LITERAL_CONTENT': 'false' // Literal content blows up the size of the build-info
      }
    })
  );
  task.isBackground = true;
  task.presentationOptions.reveal = vscode.TaskRevealKind.Silent;
  task.presentationOptions.clear = true;
  return task;
}

export
async function foundryRoot(file: vscode.Uri): Promise<vscode.Uri> {
  // Find the root of the project, which is the directory containing the foundry.toml file
  let base = file.with({'path': '/', 'query': '', 'authority': ''});
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
  const result = vscode.Uri.joinPath(base, ...pathSegments);
  return result;
}

/**
 * Get the build-info file associated with a given source file from the Foundry compiler cache.
 */
export
async function getBuildInfoFileFromCache(file: vscode.Uri): Promise<vscode.Uri> {
  const root = await foundryRoot(file);
  try {
    const cacheContent = await loadCacheFile(root);
    const relativeFilePath = relativePath(root, file);
    const cacheEntry = cacheContent.files[relativeFilePath.path.slice(1)];
    // Example entry:
    // "src/Counter.sol": {
    // 	...
    // 	"artifacts": {
    // 		"Counter": {
    // 			"0.8.27": {
    // 				"default": {
    // 					"path": "Counter.sol/Counter.json",
    // 					"build_id": "57e89cbb9e5b0219"
    // 				}
    // 			}
    // 		}
    // 	},
    // }
    if (!cacheEntry) {
      throw new Error(`No cache entry found for file: ${relativeFilePath.path.slice(1)}`);
    }
    const artifacts = cacheEntry.artifacts;
    if (!artifacts || typeof artifacts !== 'object' || Object.keys(artifacts).length === 0) {
      throw new Error(`No artifacts found in cache entry for file: ${relativeFilePath.path.slice(1)}`);
    }
    const firstContract = Object.keys(artifacts)[0];
    if (!firstContract || !artifacts[firstContract]) {
      throw new Error(`No contract found in artifacts for file: ${relativeFilePath.path.slice(1)}`);
    }
    const firstVersion = Object.keys(artifacts[firstContract])[0];
    if (!firstVersion || !artifacts[firstContract][firstVersion]) {
      throw new Error(`No version found in contract '${firstContract}' for file: ${relativeFilePath.path.slice(1)}`);
    }
    const defaultEntry = artifacts[firstContract][firstVersion].default;
    if (!defaultEntry || !defaultEntry.build_id) {
      throw new Error(`No 'default' entry or 'build_id' found for contract '${firstContract}' version '${firstVersion}' in file: ${relativeFilePath.path.slice(1)}`);
    }
    const buildId = defaultEntry.build_id;
    const buildInfoDir = await forgeBuildInfoDir(root);
    const buildInfoFile = vscode.Uri.joinPath(buildInfoDir, `${buildId}.json`);
    return buildInfoFile;
  } catch (e) {
    throw new Error(`Failed to get build info file from cache for ${file.toString()}: ${e}`);
  }
}

export
type FoundryConfig = { 'profile'?: { [profile: string]: { [key: string]: string } } };

export
async function foundryConfig(root: vscode.Uri): Promise<FoundryConfig> {
  const configPath = vscode.Uri.joinPath(root, 'foundry.toml');
  const config = await vscode.workspace.fs.readFile(configPath);
  const text = new TextDecoder().decode(config);
  return parseToml(text, { integersAsBigInt: true });
}

async function forgeBuildInfoDir(root: vscode.Uri): Promise<vscode.Uri> {
  const config = await foundryConfig(root);
  const defaultProfile = config?.profile?.default ?? {};
  const outputDir = defaultProfile?.out || 'out';
  const buildInfo = defaultProfile?.build_info_path || outputDir + '/build-info';
  const buildInfoDir = vscode.Uri.joinPath(root, buildInfo)
  return buildInfoDir;
}

/**
 * Determine the path to the Solidity compiler cache file used by Foundry.
 *
 * @param root The root URI of the Foundry project.
 * @returns A promise that resolves to the URI of the compiler cache file.
 */
async function getCacheFile(root: vscode.Uri): Promise<vscode.Uri> {
  const config = await foundryConfig(root);
  const defaultProfile = config?.profile?.default ?? {};
  const cachePath = defaultProfile?.cache_path || 'cache';
  const cacheFile = vscode.Uri.joinPath(root, cachePath, 'solidity-files-cache.json');
  return cacheFile;
}

/**
 * Get the contents of the Foundry Solidity compiler cache file.
 *
 * @param root The root URI of the Foundry project.
 * @returns A promise that resolves to the parsed JSON contents of the cache file.
 */
async function loadCacheFile(root: vscode.Uri): Promise<any> {
  const cacheFile = await getCacheFile(root);
  const cacheContent = await vscode.workspace.fs.readFile(cacheFile);
  const text = new TextDecoder().decode(cacheContent);
  return JSON.parse(text);
}

/**
 * Strip the base path from an absolute path to create a relative path.
 *
 * @param base The base URI to strip from.
 * @param absolute The absolute URI to convert.
 * @returns The relative URI.
 * @throws An error if the absolute path does not start with the base path.
 */
function relativePath(base: vscode.Uri, absolute: vscode.Uri): vscode.Uri {
  const basePath = base.path;
  const absolutePath = absolute.path;
  if (!absolutePath.startsWith(basePath)) {
    throw new Error(`Path ${absolutePath} does not start with base path ${basePath}`);
  }
  const relative = absolutePath.slice(basePath.length);
  return absolute.with({path: relative});
}

export
type ForgeTestSuite = { [fileName: string]: { [contractName: string]: string[] } };

/**
 * List all Foundry tests in the given workspace folder.
 */
export
async function forgeListTests(cwd: vscode.Uri): Promise<ForgeTestSuite> {
  const forgePath = getConfigValue('forge-path', 'forge');
  const output = await executeInTerminal(`${forgePath} test --list --json`, { cwd });
  const result: ForgeTestSuite = JSON.parse(output);
  return result;
}

export type ForgeTestSuiteReport = Record<string, ForgeTestReport>; // keyed by filename.sol

export interface ForgeTestReport {
    duration: string; // e.g. "9ms 823µs 544ns"
    test_results: Record<string, ForgeTestCaseResult>; // keyed by filename.sol:ContractName
    warnings: unknown[];
}

export interface ForgeTestCaseResult {
    status: "Success" | "Failure" | string;
    reason: string | null;
    counterexample: unknown | null;
    logs: unknown[];
    decoded_logs: unknown[];
    kind: ForgeTestKind;
    traces: unknown[];
    labeled_addresses: Record<string, unknown>;
    duration: string;
    breakpoints: Record<string, unknown>;
    gas_snapshots: Record<string, unknown>;
}

export type ForgeTestKind =
    | { Fuzz: ForgeFuzzKind }
    | { Unit: ForgeUnitKind }
    // allow forwards-compat for other kinds
    | Record<string, unknown>;

export interface ForgeFuzzKind {
    first_case: ForgeFuzzFirstCase;
    runs: number;
    mean_gas: number;
    median_gas: number;
    failed_corpus_replays: number;
}

export interface ForgeFuzzFirstCase {
    calldata: string; // hex string
    gas: number;
    stipend: number;
}

export interface ForgeUnitKind {
    gas: number;
}


/**
 * Run all Foundry tests in the given workspace folder.
 */
export
async function forgeTest(cwd: vscode.Uri) : Promise<ForgeTestSuiteReport> {
  const forgePath = getConfigValue('forge-path', 'forge');
  const output = await executeInTerminal(`${forgePath} test --json`, { cwd });
  const result: ForgeTestSuiteReport = JSON.parse(output);
  return result;
}

/**
 * Run a single Foundry test.
 */
export
async function forgeTestSingle(fileName: string, contractName: string, testMethod: string) : Promise<ForgeTestSuiteReport> {
  const forgePath = getConfigValue('forge-path', 'forge');
  const output = await executeInTerminal(`${forgePath} test --json --match-path ${fileName} --match-contract ${contractName} --match-test ${testMethod}`);
  const result: ForgeTestSuiteReport = JSON.parse(output);
  return result;
}

/**
 * Run Foundry coverage for a single test. 
 */
export
async function forgeCoverageSingle(fileName: string, contractName: string, testMethod: string) : Promise<[ForgeTestSuiteReport, LcovRecord[]]> {
  const forgePath = getConfigValue('forge-path', 'forge');
  const output = await executeInTerminal(`${forgePath} coverage --json --match-path ${fileName} --match-contract ${contractName} --match-test ${testMethod}`);

  // `forge coverage --json` outputs some logging info before and after the JSON object.
  const firstBrace = output.indexOf('{');
  const lastBrace = output.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error('Failed to parse forge coverage output: no JSON object found');
  }
  const jsonString = output.slice(firstBrace, lastBrace + 1);
  const result: ForgeTestSuiteReport = JSON.parse(jsonString);

  // The lcov report is not written to stdout, but to a file named "lcov.info" in the current working directory.
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]; // TODO: the workspace folder should be a function parameter
  if (!workspaceFolder) {
    throw new Error('No workspace folder is open; cannot locate lcov.info output file.');
  }
  const lcovUri = vscode.Uri.joinPath(workspaceFolder.uri, 'lcov.info');
  const lcovContent = await vscode.workspace.fs.readFile(lcovUri);
  const lcovText = new TextDecoder().decode(lcovContent);
  const lcovRecords = parseLcov(lcovText);
  return [result, lcovRecords];
}

// Why are we using the Terminal API here, instead of child_process or vscode.Task?
// vscode.Task is not designed to capture command output.
// child_process spawns a separate process that may not have the same environment as the integrated VSCode terminal.
// The Terminal API allows us to run the command in the same environment as the user would in the integrated terminal.
async function executeInTerminal(cmd: string, options: vscode.TerminalOptions = {}): Promise<string> {
  const terminal = vscode.window.createTerminal({ name: cmd, hideFromUser: true, ...options });
  const done = new Promise<string>((resolve, reject) => {
    const disposible = vscode.window.onDidChangeTerminalShellIntegration(async (e) => {
      if (e.terminal !== terminal) {
        return;
      }    
      disposible.dispose();
      const execution = e.shellIntegration.executeCommand(`${cmd}`);
      const outputStream = execution.read();
      const didStop = vscode.window.onDidEndTerminalShellExecution(async (e) => {
        if (e.execution !== execution) {
          return;
        }
        didStop.dispose();
        if (e.exitCode !== 0) {
          reject(new Error(`${cmd} failed with exit code ${e.exitCode}`));
          return;
        }
        const rawOutput = await streamToString(outputStream);
        const filteredOutput = stripTerminalControlSequences(rawOutput);
        resolve(filteredOutput);
      });
    });
  });
  done.finally(() => { terminal.dispose(); });
  return done;
}

async function streamToString(stream: AsyncIterable<string>): Promise<string> {
  let result = '';
  for await (const chunk of stream) {
    result += chunk;
  }
  return result;
}

function stripTerminalControlSequences(input: string): string {
  // OSC: ESC ] ... BEL  OR  ESC ] ... ESC \
  const osc = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

  // CSI: ESC [ ... (covers colors, cursor moves, erase, etc.)
  const csi = /\x1b\[[0-?]*[ -/]*[@-~]/g;

  // DCS: ESC P ... ESC \
  const dcs = /\x1bP[^\x1b]*(?:\x1b\\)/g;

  // Other single-char ESC sequences (less common, but cheap to remove)
  const esc = /\x1b[@-Z\\-_]/g;

  return input
    .replace(osc, '')
    .replace(dcs, '')
    .replace(csi, '')
    .replace(esc, '');
}