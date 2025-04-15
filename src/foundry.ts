import * as vscode from 'vscode';
import {getConfigValue} from './utils';
import {parse as parseToml} from 'smol-toml';

export
function forgeBuildTask(file: vscode.Uri) {
  const forgePath = getConfigValue('forge-path', 'forge');
  const cwd = file.with({path: file.path.split('/').slice(0, -1).join('/')}).fsPath;
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
        'FOUNDRY_EXTRA_OUTPUT': '["storageLayout", "evm.bytecode.generatedSources", "evm.bytecode.functionDebugData", "evm.legacyAssembly", "evm.deployedBytecode.functionDebugData", "evm.deployedBytecode.immutableReferences"]',
        'FOUNDRY_BYTECODE_HASH': 'ipfs',
        'FOUNDRY_CBOR_METADATA': 'true',
        'FOUNDRY_FORCE': 'true',
      }
    })
  );
  task.isBackground = true;
  task.presentationOptions.reveal = vscode.TaskRevealKind.Silent;
  task.presentationOptions.clear = true;
  return task;
}

export
async function loadBuildInfo(file: vscode.Uri): Promise<string[]> {
  const root = await foundryRoot(file);
  const buildInfo = await forgeBuildInfo(root);
  return buildInfo;
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

async function forgeBuildInfo(root: vscode.Uri): Promise<string[]> {
  const config = await foundryConfig(root);
  // Extract configuration values for build-info and output directory
  const defaultProfile = config?.profile?.default ?? {};
  const outputDir = defaultProfile?.out || 'out';
  const buildInfo = defaultProfile?.build_info_path || outputDir + '/build-info';

  // Determine the build-info directory based on configuration
  const buildInfoDir = vscode.Uri.joinPath(root, buildInfo)

  // Get list of build-info files
  const files = await vscode.workspace.fs.readDirectory(buildInfoDir);
  const buildInfoFiles = files.filter(([file, type]) => type === vscode.FileType.File && file.endsWith('.json'));

  if (buildInfoFiles.length === 0) {
    vscode.window.showErrorMessage('No build-info files found');
    return [];
  }

  // Read the contents of all build-info files
  const result = await Promise.all(buildInfoFiles.map(async ([file, type]) => {
    const fileUri = vscode.Uri.joinPath(buildInfoDir, file);
    const youngestBuildInfo = await vscode.workspace.fs.readFile(fileUri);
    const text = new TextDecoder().decode(youngestBuildInfo);
    return text;
  }));
  return result;
}
