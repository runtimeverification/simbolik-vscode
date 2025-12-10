import * as vscode from 'vscode';
import {getConfigValue} from './utils';
import {parse as parseToml} from 'smol-toml';

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
    const artifacts = cacheEntry.artifacts;
    const firstContract = Object.keys(artifacts)[0];
    const firstVersion = Object.keys(artifacts[firstContract])[0];
    const buildId = artifacts[firstContract][firstVersion].default.build_id;
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
 * @returns A promise that resolves to the relative URI.
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