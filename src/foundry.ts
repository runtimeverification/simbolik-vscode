import * as vscode from 'vscode';
import {getConfigValue} from './utils';
import {parse as parseToml} from 'smol-toml';
import {LcovRecord, parseLcov} from './lcov';
import {executeInTerminal} from './terminal';

/**
 * List all source files (excludings libs/tests/scripts) of the given Foundry project
 *
 * @param root The root URI of the Foundry project.
 * @returns An array of URIs of source files.
 */
export async function sourceFiles(root: vscode.Uri): Promise<vscode.Uri[]> {
  const srcDir = await forgeSrcDir(root);
  const files: vscode.Uri[] = [];
  const visit = async (dir: vscode.Uri) => {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    for (const [name, type] of entries) {
      const entryUri = vscode.Uri.joinPath(dir, name);
      if (type === vscode.FileType.File && name.endsWith('.sol')) {
        files.push(entryUri);
      } else if (type === vscode.FileType.Directory) {
        await visit(entryUri);
      }
    }
  };
  await visit(srcDir);
  return files;
}

/**
 * List all test files of the given Foundry project
 *
 * @param root The root URI of the Foundry project.
 * @returns An array of URIs of test files.
 */
export async function testFiles(root: vscode.Uri): Promise<vscode.Uri[]> {
  const testDir = await forgeTestDir(root);
  const files: vscode.Uri[] = [];
  const visit = async (dir: vscode.Uri) => {
    const entries = await vscode.workspace.fs.readDirectory(dir);
    for (const [name, type] of entries) {
      const entryUri = vscode.Uri.joinPath(dir, name);
      if (type === vscode.FileType.File && name.endsWith('.sol')) {
        files.push(entryUri);
      } else if (type === vscode.FileType.Directory) {
        await visit(entryUri);
      }
    }
  };
  await visit(testDir);
  return files;
}

/**
 * Build the given source file using Foundry's `forge build` command.
 *
 * @param file The source file to build.
 * @param force Whether to force a rebuild, ignoring the cache.
 * @returns The standard output of the `forge build` command.
 */
export async function forgeBuild(
  file: vscode.Uri,
  force = false
): Promise<string> {
  const forgePath = getConfigValue('forge-path', 'forge');
  const root = await foundryRoot(file);
  const compilationTarget = relativePath(root, file);
  const args = ['build', compilationTarget];
  const env: {[key: string]: string} = {
    FOUNDRY_OPTIMIZER: 'false',
    FOUNDRY_BUILD_INFO: 'true',
    FOUNDRY_EXTRA_OUTPUT:
      '["storageLayout", "evm.bytecode.generatedSources", "evm.bytecode.functionDebugData", "evm.deployedBytecode.functionDebugData", "evm.deployedBytecode.immutableReferences"]',
    FOUNDRY_BYTECODE_HASH: 'ipfs',
    FOUNDRY_CBOR_METADATA: 'true',
    FOUNDRY_FORCE: force ? 'true' : 'false',
    FOUNDRY_CACHE: 'true',
    FOUNDRY_USE_LITERAL_CONTENT: 'false', // Literal content blows up the size of the build-info
  };
  const cmd = `${forgePath} ${args.join(' ')}`;
  const result = await executeInTerminal(cmd, {cwd: root.path, env}, true);
  return result;
}

/**
 * Find the root directory of the given Foundry project by locating the directory containing the `foundry.toml` file.
 * @param file A file or directory within the Foundry project.
 * @returns The URI of the root directory of the Foundry project.
 */
export async function foundryRoot(file: vscode.Uri): Promise<vscode.Uri> {
  // Find the root of the project, which is the directory containing the foundry.toml file
  const base = file.with({path: '/', query: '', authority: ''});
  const pathSegments = file.path.split('/');
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
 * @param file The source file URI.
 * @returns The URI of the build-info file.
 * @throws An error if the build-info file cannot be found in the cache.
 */
export async function getBuildInfoFileFromCache(
  file: vscode.Uri
): Promise<vscode.Uri> {
  const root = await foundryRoot(file);
  try {
    const cacheContent = (await loadCacheFile(root)) as {
      files: {
        [key: string]: {
          artifacts: {[contractName: string]: {[version: string]: unknown}};
        };
      };
    };
    const relativeFilePath = relativePath(root, file);
    const cacheEntry = cacheContent.files[relativeFilePath];
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
      throw new Error(`No cache entry found for file: ${relativeFilePath}`);
    }
    const artifacts = cacheEntry.artifacts;
    if (
      !artifacts ||
      typeof artifacts !== 'object' ||
      Object.keys(artifacts).length === 0
    ) {
      throw new Error(
        `No artifacts found in cache entry for file: ${relativeFilePath}`
      );
    }
    const firstContract = Object.keys(artifacts)[0];
    if (!firstContract || !artifacts[firstContract]) {
      throw new Error(
        `No contract found in artifacts for file: ${relativeFilePath}`
      );
    }
    const firstVersion = Object.keys(artifacts[firstContract])[0];
    if (!firstVersion || !artifacts[firstContract][firstVersion]) {
      throw new Error(
        `No version found in contract '${firstContract}' for file: ${relativeFilePath}`
      );
    }
    const versionEntry = artifacts[firstContract][firstVersion] as {
      default?: {build_id?: string};
    };
    const defaultEntry = versionEntry.default;
    if (!defaultEntry || !defaultEntry.build_id) {
      throw new Error(
        `No 'default' entry or 'build_id' found for contract '${firstContract}' version '${firstVersion}' in file: ${relativeFilePath}`
      );
    }
    const buildId = defaultEntry.build_id;
    const buildInfoDir = await forgeBuildInfoDir(root);
    const buildInfoFile = vscode.Uri.joinPath(buildInfoDir, `${buildId}.json`);
    return buildInfoFile;
  } catch (e) {
    throw new Error(
      `Failed to get build info file from cache for ${file.toString()}: ${e}`
    );
  }
}

/**
 * Get the artifact file for a given contract.
 *
 * @param file The source file URI.
 * @param contractName The name of the contract.
 * @returns The URI of the artifact file.
 */
export async function getArtifact(
  file: vscode.Uri,
  contractName: string
): Promise<vscode.Uri> {
  const root = await foundryRoot(file);
  const outDir = await forgeOutDir(root);
  const fileName = file.path.split('/').pop();
  return vscode.Uri.joinPath(outDir, fileName!, contractName + '.json');
}

export type FoundryConfig = {
  profile?: {[profile: string]: {[key: string]: string}};
};

/**
 * Parse the Foundry configuration file (`foundry.toml`) located at the root of the project.
 *
 * @param root The root URI of the Foundry project.
 * @returns The parsed Foundry configuration.
 */
export async function foundryConfig(root: vscode.Uri): Promise<FoundryConfig> {
  const configPath = vscode.Uri.joinPath(root, 'foundry.toml');
  const config = await vscode.workspace.fs.readFile(configPath);
  const text = new TextDecoder().decode(config);
  return parseToml(text, {integersAsBigInt: true});
}

/**
 * Get the output directory for build artifacts as specified in the Foundry configuration.
 *
 * @param root The root URI of the Foundry project.
 * @returns The URI of the output directory.
 */
export async function forgeOutDir(root: vscode.Uri): Promise<vscode.Uri> {
  const config = await foundryConfig(root);
  const defaultProfile = config?.profile?.default ?? {};
  const outputDir = defaultProfile?.out || 'out';
  const outDir = vscode.Uri.joinPath(root, outputDir);
  return outDir;
}

/**
 * Get the source directory as specified in the Foundry configuration.
 *
 * @param root The root URI of the Foundry project.
 * @returns The URI of the source directory.
 */
export async function forgeSrcDir(root: vscode.Uri): Promise<vscode.Uri> {
  const config = await foundryConfig(root);
  const defaultProfile = config?.profile?.default ?? {};
  const srcDir = defaultProfile?.src || 'src';
  const sourceDir = vscode.Uri.joinPath(root, srcDir);
  return sourceDir;
}

/**
 * Get the test directory as specified in the Foundry configuration.
 *
 * @param root The root URI of the Foundry project.
 * @returns The URI of the test directory.
 */
export async function forgeTestDir(root: vscode.Uri): Promise<vscode.Uri> {
  const config = await foundryConfig(root);
  const defaultProfile = config?.profile?.default ?? {};
  const testDir = defaultProfile?.test || 'test';
  const testsDir = vscode.Uri.joinPath(root, testDir);
  return testsDir;
}

/**
 * Get the build-info directory as specified in the Foundry configuration.
 *
 * @param root The root URI of the Foundry project.
 * @returns The URI of the build-info directory.
 */
export async function forgeBuildInfoDir(root: vscode.Uri): Promise<vscode.Uri> {
  const config = await foundryConfig(root);
  const defaultProfile = config?.profile?.default ?? {};
  const outputDir = defaultProfile?.out || 'out';
  const buildInfo =
    defaultProfile?.build_info_path || outputDir + '/build-info';
  const buildInfoDir = vscode.Uri.joinPath(root, buildInfo);
  return buildInfoDir;
}

/**
 * Get the path to the Foundry Solidity compiler cache file.
 *
 * @param root The root URI of the Foundry project.
 * @returns The URI of the cache file.
 */
async function getCacheFile(root: vscode.Uri): Promise<vscode.Uri> {
  const config = await foundryConfig(root);
  const defaultProfile = config?.profile?.default ?? {};
  const cachePath = defaultProfile?.cache_path || 'cache';
  const cacheFile = vscode.Uri.joinPath(
    root,
    cachePath,
    'solidity-files-cache.json'
  );
  return cacheFile;
}

/**
 * Get the contents of the Foundry Solidity compiler cache file.
 *
 * @param root The root URI of the Foundry project.
 * @returns A promise that resolves to the parsed JSON contents of the cache file.
 */
async function loadCacheFile(root: vscode.Uri): Promise<unknown> {
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
 * @returns The relative path as a string.
 * @throws An error if the absolute path does not start with the base path.
 */
function relativePath(base: vscode.Uri, absolute: vscode.Uri): string {
  const basePath = base.path;
  const absolutePath = absolute.path;
  if (!absolutePath.startsWith(basePath)) {
    throw new Error(
      `Path ${absolutePath} does not start with base path ${basePath}`
    );
  }
  const relative = absolutePath.slice(basePath.length);
  return absolute.with({path: relative}).path.slice(1);
}

export type ForgeTestSuite = {
  [fileName: string]: {[contractName: string]: string[]};
};

/**
 * List all Foundry tests in the given workspace folder.
 *
 * @param root The root URI of the Foundry project.
 */
export async function forgeListTests(
  root: vscode.Uri
): Promise<ForgeTestSuite> {
  const forgePath = getConfigValue('forge-path', 'forge');
  const output = await executeInTerminal(`${forgePath} test --list --json`, {
    cwd: root,
  });
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
  status: 'Success' | 'Failure' | string;
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
  | {Fuzz: ForgeFuzzKind}
  | {Unit: ForgeUnitKind}
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

export type ForgeTestOptions = {
  path?: string;
  contract?: string;
  test?: string;
};

/**
 * Run all Foundry tests in the given workspace folder.
 *
 * @param root The root URI of the Foundry project.
 * @param options Options to filter which tests to run.
 * @returns The test suite report.
 */
export async function forgeTest(
  root: vscode.Uri,
  options: ForgeTestOptions
): Promise<ForgeTestSuiteReport> {
  const forgePath = getConfigValue('forge-path', 'forge');
  const args = [];
  if (options.path) {
    args.push(`--match-path ${options.path}`);
  }
  if (options.contract) {
    args.push(`--match-contract ${options.contract}`);
  }
  if (options.test) {
    args.push(`--match-test ${options.test}`);
  }
  const argsString = args.join(' ');
  const output = await executeInTerminal(
    `${forgePath} test --json --allow-failure ${argsString}`,
    {cwd: root}
  );
  const result: ForgeTestSuiteReport = JSON.parse(output);
  return result;
}

/**
 * Run all Foundry tests with coverage in the given workspace folder.
 *
 * @param root The root URI of the Foundry project.
 * @param options Options to filter which tests to run.
 * @returns A tuple containing the test suite report and the lcov records.
 */
export async function forgeCoverage(
  root: vscode.Uri,
  options: ForgeTestOptions
): Promise<[ForgeTestSuiteReport, LcovRecord[]]> {
  const forgePath = getConfigValue('forge-path', 'forge');
  const args = [];
  if (options.path) {
    args.push(`--match-path ${options.path}`);
  }
  if (options.contract) {
    args.push(`--match-contract ${options.contract}`);
  }
  if (options.test) {
    args.push(`--match-test ${options.test}`);
  }
  const argsString = args.join(' ');
  const output = await executeInTerminal(
    `${forgePath} coverage --json --allow-failure --report=lcov --exclude-tests ${argsString}`,
    {cwd: root}
  );

  // `forge coverage --json` outputs some logging info before and after the JSON object.
  const firstBrace = output.indexOf('{');
  const lastBrace = output.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error(
      'Failed to parse forge coverage output: no JSON object found'
    );
  }
  const jsonString = output.slice(firstBrace, lastBrace + 1);
  const result: ForgeTestSuiteReport = JSON.parse(jsonString);

  // The lcov report is not written to stdout, but to a file named "lcov.info" in the current working directory.
  if (!root) {
    throw new Error(
      'No workspace folder is open; cannot locate lcov.info output file.'
    );
  }
  const lcovUri = vscode.Uri.joinPath(root, 'lcov.info');
  const lcovContent = await vscode.workspace.fs.readFile(lcovUri);
  const lcovText = new TextDecoder().decode(lcovContent);
  const lcovRecords = parseLcov(lcovText);
  return [result, lcovRecords];
}

/**
 * Lint the given source file using Foundry's `forge lint` command and populate the given diagnostic collection.
 *
 * @param file The URI of the source file to lint.
 * @param collection The diagnostic collection to populate with linting results.
 */
export async function forgeLintFile(
  file: vscode.Uri,
  collection: vscode.DiagnosticCollection
): Promise<void> {
  collection.delete(file);
  const cwd = await foundryRoot(file);
  const forgePath = getConfigValue('forge-path', 'forge');
  const out = await forgeOutDir(cwd);
  const lintOut = vscode.Uri.joinPath(out, 'lint');
  const lintOutPath = relativePath(cwd, lintOut);
  // `forge lint` will build the file if needed and write the artifacts to the out folder.
  // The build is not suitable for debugging because it uses different compiler settings.
  // Hence, we use a different out folder for linting.
  const output = await executeInTerminal(
    `${forgePath} lint --json ${file.fsPath} --out='${lintOutPath}'`,
    {cwd}
  );
  const diagnistics = output
    .split('\n')
    .map(line => {
      try {
        const entry: ForgeLintDiagnostic = JSON.parse(line);
        const diagnostic = new vscode.Diagnostic(
          new vscode.Range(
            new vscode.Position(
              entry.spans[0].line_start - 1,
              entry.spans[0].column_start - 1
            ),
            new vscode.Position(
              entry.spans[0].line_end - 1,
              entry.spans[0].column_end - 1
            )
          ),
          entry.rendered ?? entry.message,
          entry.level === 'error'
            ? vscode.DiagnosticSeverity.Error
            : entry.level === 'warning'
              ? vscode.DiagnosticSeverity.Warning
              : vscode.DiagnosticSeverity.Information
        );
        return diagnostic;
      } catch (e) {
        return null;
      }
    })
    .filter((diag): diag is vscode.Diagnostic => diag !== null);
  collection.set(file, diagnistics);
}

export interface ForgeLintDiagnostic {
  $message_type: 'diagnostic' | string;
  message: string;
  code: ForgeLintCode | null;
  level: ForgeLintLevel | string;
  spans: ForgeLintSpan[];
  children: ForgeLintChild[];
  rendered: string | null;
}

export interface ForgeLintCode {
  code: string;
  explanation: string | null;
}

export type ForgeLintLevel = 'error' | 'warning' | 'note' | 'help';

export interface ForgeLintSpan {
  file_name: string;
  byte_start: number;
  byte_end: number;
  line_start: number;
  line_end: number;
  column_start: number;
  column_end: number;
  is_primary: boolean;
  text: ForgeLintSpanText[];
  label: string | null;
  suggested_replacement: string | null;
}

export interface ForgeLintSpanText {
  text: string;
  highlight_start: number;
  highlight_end: number;
}

export interface ForgeLintChild {
  message: string;
  code: ForgeLintCode | null;
  level: ForgeLintLevel | string;
  spans: ForgeLintSpan[];
  children: ForgeLintChild[];
  rendered: string | null;
}
