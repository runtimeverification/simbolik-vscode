import * as vscode from 'vscode';
import {getConfigValue} from './utils';
import {parse as parseToml} from 'toml';

export
async function forgeBuild(
  activeTextEditor: vscode.TextEditor,
) {
  const build = forgeBuildTask(activeTextEditor.document.uri.fsPath);
  const buildExecution = await vscode.tasks.executeTask(build);
  try {
    await completed(buildExecution);
  } catch (e) {
    const action = await vscode.window.showErrorMessage(
      'Failed to build project.',
      'Open Settings',
      'Help'
    );
    if (action === 'Open Settings') {
      vscode.commands.executeCommand(
        'workbench.action.openSettings',
        'forge-path'
      );
    }
    if (action === 'Help') {
      vscode.commands.executeCommand(
        'vscode.open',
        vscode.Uri.parse('https://docs.runtimeverification.com/simbolik/overview/troubleshooting#failed-to-build-project')
      );
    }
    throw new Error('Failed to build project');
  }
}

function completed(tastkExecution: vscode.TaskExecution): Promise<void> {
  return new Promise((resolve, reject) => {
    const disposable = vscode.tasks.onDidEndTaskProcess(e => {
      if ((e.execution as any)._id !== (tastkExecution as any)._id) return;
      if (e.exitCode !== 0) {
        reject();
      } else {
        resolve();
      }
      disposable.dispose();
    });
  });
}

export
function forgeBuildTask(file: string) {
  const incrementalBuild = getConfigValue('incremental-build', false);
  const forgePath = getConfigValue('forge-path', 'forge');
  const cwd = file.substring(0, file.lastIndexOf('/'));
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
        'FOUNDRY_EXTRA_OUTPUT': '["storageLayout", "evm.bytecode.generatedSources"]',
        'FOUNDRY_BYTECODE_HASH': 'ipfs',
        'FOUNDRY_CBOR_METADATA': 'true',
        'FOUNDRY_CACHE': incrementalBuild ? 'true' : 'false',
      }
    })
  );
  task.isBackground = true;
  task.presentationOptions.reveal = vscode.TaskRevealKind.Always;
  return task;
}

export
async function loadBuildInfo(file: string): Promise<string> {
  const root = await foundryRoot(file);
  const buildInfo = await forgeBuildInfo(root);
  return buildInfo;
}

export
async function foundryRoot(file: string) {
  // Find the root of the project, which is the directory containing the foundry.toml file
  let root = file;
  let stat;
  try {
    stat = await vscode.workspace.fs.stat(vscode.Uri.file(`${root}/foundry.toml`));
  } catch (e) {
    stat = false;
  }
  while (!stat) {
    const lastSlash = root.lastIndexOf('/');
    if (lastSlash === -1) {
      throw new Error('Could not find foundry.toml');
    }
    root = root.substring(0, lastSlash);
    try {
      stat = await vscode.workspace.fs.stat(vscode.Uri.file(`${root}/foundry.toml`));
    } catch (e) {
      stat = false;
    }
  }
  return root;
}

export
type FoundryConfig = { 'profile'?: { [profile: string]: { [key: string]: string } } };

export
async function foundryConfig(root: string): Promise<FoundryConfig> {
  const configPath = `${root}/foundry.toml`;
  const config = await vscode.workspace.fs.readFile(vscode.Uri.file(configPath));
  return parseToml(config.toString());
}

async function forgeBuildInfo(root: string): Promise<string> {
  const config = await foundryConfig(root);
  const out = config?.profile?.default?.out ?? 'out';

  // Get the contents of the youngest build-info file
  const buildInfoDir = `${root}/${out}/build-info`;

  // Get list of build-info files
  const files = await vscode.workspace.fs.readDirectory(vscode.Uri.file(buildInfoDir));
  const buildInfoFiles = files.filter(([file, type]) => type === vscode.FileType.File && file.endsWith('.json'));

  if (buildInfoFiles.length === 0) {
    vscode.window.showErrorMessage('No build-info files found');
    return '';
  }

  // Retrieve file stats and sort by creation timestamp
  const sortedFiles = await getSortedFilesByCreationTime(buildInfoDir, buildInfoFiles);

  // Read the youngest build-info file
  const youngestBuildInfo = await vscode.workspace.fs.readFile(sortedFiles[0].uri);
  return youngestBuildInfo.toString();
}

async function getSortedFilesByCreationTime(buildInfoDir: string, buildInfoFiles: [string, vscode.FileType][]): Promise<{ file: string, uri: vscode.Uri, ctime: number }[]> {
  const filesWithStats = await Promise.all(
    buildInfoFiles.map(async ([file]) => {
      const fileUri = vscode.Uri.file(`${buildInfoDir}/${file}`);
      const fileStat = await vscode.workspace.fs.stat(fileUri);
      return { file, uri: fileUri, ctime: fileStat.ctime };
    })
  );

  // Sort files by creation time (ctime)
  return filesWithStats.sort((a, b) => b.ctime - a.ctime);
}