import * as vscode from 'vscode';
import {getConfigValue} from './utils';
import {parse as parseToml} from 'smol-toml';

export
function forgeBuildTask(file: vscode.Uri) {
  const incrementalBuild = getConfigValue('incremental-build', false);
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
        'FOUNDRY_EXTRA_OUTPUT': '["storageLayout", "evm.bytecode.generatedSources", "evm.legacyAssembly"]',
        'FOUNDRY_BYTECODE_HASH': 'ipfs',
        'FOUNDRY_CBOR_METADATA': 'true',
        'FOUNDRY_FORCE': incrementalBuild ? 'false' : 'true',
      }
    })
  );
  task.isBackground = true;
  task.presentationOptions.reveal = vscode.TaskRevealKind.Always;
  return task;
}

export
async function loadBuildInfo(file: vscode.Uri): Promise<string> {
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

async function forgeBuildInfo(root: vscode.Uri): Promise<string> {
  const config = await foundryConfig(root);
  const out = config?.profile?.default?.out ?? 'out';

  // Get the contents of the youngest build-info file
  const buildInfoDir = vscode.Uri.joinPath(root, out, 'build-info');

  // Get list of build-info files
  const files = await vscode.workspace.fs.readDirectory(buildInfoDir);
  const buildInfoFiles = files.filter(([file, type]) => type === vscode.FileType.File && file.endsWith('.json'));

  if (buildInfoFiles.length === 0) {
    vscode.window.showErrorMessage('No build-info files found');
    return '';
  }

  // Retrieve file stats and sort by creation timestamp
  const sortedFiles = await getSortedFilesByCreationTime(buildInfoDir, buildInfoFiles);

  // Read the youngest build-info file
  const youngestBuildInfo = await vscode.workspace.fs.readFile(sortedFiles[0].uri);
  const text = new TextDecoder().decode(youngestBuildInfo);
  return text;
}

async function getSortedFilesByCreationTime(buildInfoDir: vscode.Uri, buildInfoFiles: [string, vscode.FileType][]): Promise<{ file: string, uri: vscode.Uri, ctime: number }[]> {
  const filesWithStats = await Promise.all(
    buildInfoFiles.map(async ([file]) => {
      const fileUri = vscode.Uri.joinPath(buildInfoDir, file);
      const fileStat = await vscode.workspace.fs.stat(fileUri);
      return { file, uri: fileUri, ctime: fileStat.ctime };
    })
  );

  // Sort files by creation time (ctime)
  return filesWithStats.sort((a, b) => b.ctime - a.ctime);
}