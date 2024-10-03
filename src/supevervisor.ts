import * as vscode from 'vscode';
import {getConfigValue} from './utils';

export class Supervisor {
  private _simbolik: vscode.TaskExecution | undefined;
  private _anvil: vscode.TaskExecution | undefined;
  private _kontrol: vscode.TaskExecution | undefined;

  public async anvil(): Promise<void> {
    this._anvil = await vscode.tasks.executeTask(anvilTask());
    if (this._anvil === undefined) {
      vscode.window.showErrorMessage('Anvil failed to start');
    }
    vscode.tasks.onDidEndTaskProcess(async e => {
      if (e.execution === this._anvil && e.exitCode !== undefined) {
        this._anvil?.terminate();
        this._anvil = undefined;
        const action = await vscode.window.showErrorMessage(
          'Anvil terminated unexpectedly',
          'Open Settings',
          'Try Again'
        );
        if (action === 'Open Settings') {
          vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'simbolik.anvil-port'
          );
        }
        if (action === 'Try Again') {
          this.anvil();
        }
      }
    });
  }

  public async kontrol(): Promise<void> {
    this._kontrol = await vscode.tasks.executeTask(kontrolNodeTask());
    if (this._kontrol === undefined) {
      vscode.window.showErrorMessage('Kontrol node failed to start');
    }
    vscode.tasks.onDidEndTaskProcess(async e => {
      if (e.execution === this._kontrol && e.exitCode !== undefined) {
        this._kontrol?.terminate();
        this._kontrol = undefined;
        const action = await vscode.window.showErrorMessage(
          'Kontrol node terminated unexpectedly',
          'Open Settings',
          'Try Again'
        );
        if (action === 'Open Settings') {
          vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'simbolik.kontrol-node-port'
          );
        }
        if (action === 'Try Again') {
          this.kontrol();
        }
      }
    });
  }

  public async simbolik(): Promise<void> {
    this._simbolik = await vscode.tasks.executeTask(simbolikTask());
    if (this._simbolik === undefined) {
      vscode.window.showErrorMessage('Simbolik failed to start');
    }
    vscode.tasks.onDidEndTaskProcess(async e => {
      if (e.execution === this._simbolik) {
        this._simbolik?.terminate();
        this._simbolik = undefined;
        const action = await vscode.window.showErrorMessage(
          'Simbolik terminated unexpectedly',
          'Open Settings',
          'Try Again'
        );
        if (action === 'Open Settings') {
          await vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'simbolik.server'
          );
        } else if (action === 'Try Again') {
          this.simbolik();
        }
      }
    });
  }

  public dispose(): void {
    this._anvil?.terminate();
    this._kontrol?.terminate();
    this._simbolik?.terminate();
  }

  public anvilTerminate(): void {
    this._anvil?.terminate();
  }

  public kontrolTerminate(): void {
    this._kontrol?.terminate();
  }
}

function anvilTask() {
  const port = getConfigValue('anvil-port', 8545);
  const anvilPath = getConfigValue('anvil-path', 'anvil');
  const task = new vscode.Task(
    {
      label: 'anvil',
      type: 'shell',
    },
    vscode.TaskScope.Workspace,
    'anvil',
    'simbolik',
    new vscode.ShellExecution(anvilPath, [
      '--steps-tracing',
      '--port',
      `${port}`,
      '--code-size-limit',
      `${2n ** 64n - 1n}`,
    ])
  );
  task.isBackground = true;
  task.presentationOptions.reveal = vscode.TaskRevealKind.Never;
  return task;
}

function kontrolNodeTask() {
  const port = getConfigValue('kontrol-node-port', 8081);
  const kontrolNodePath = getConfigValue('kontrol-node-path', 'kontrol-node');
  const task = new vscode.Task(
    {
      label: 'kontrol',
      type: 'shell',
    },
    vscode.TaskScope.Workspace,
    'kontrol',
    'simbolik',
    new vscode.ShellExecution('poetry', [
      'run',
      '-C',
      `${kontrolNodePath}`,
      'kontrol-node',
      'run',
      '--steps-tracing',
      '--port',
      `${port}`,
    ])
  );
  task.isBackground = true;
  task.presentationOptions.reveal = vscode.TaskRevealKind.Never;
  return task;
}

function simbolikTask() {
  const server = getConfigValue('server', 'ws://localhost:6789');
  const simbolikPath = getConfigValue('simbolik-path', 'simbolik');
  const port = server.split(':')[2];
  const task = new vscode.Task(
    {
      label: 'simbolik',
      type: 'shell',
    },
    vscode.TaskScope.Workspace,
    'simbolik',
    'simbolik',
    new vscode.ShellExecution(simbolikPath, ['--port', port.toString()])
  );
  task.isBackground = true;
  task.presentationOptions.reveal = vscode.TaskRevealKind.Never;
  return task;
}
