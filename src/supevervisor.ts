import * as vscode from 'vscode';
import {getConfigValue} from './utils';

export class Supervisor {
  private _simbolik: vscode.TaskExecution | undefined;
  private _anvil: vscode.TaskExecution | undefined;

  public async anvil(): Promise<void> {
    this._anvil = await vscode.tasks.executeTask(anvilTask());
    if (this._anvil === undefined) {
      vscode.window.showErrorMessage('Anvil failed to start');
    }
    vscode.tasks.onDidEndTaskProcess(async e => {
      if (e.execution === this._anvil) {
        this._anvil?.terminate();
        this._anvil = undefined;
        let action = await vscode.window.showErrorMessage(
          'Anvil terminated unexpectedly.',
          'Open Settings',
          'Try Again',
          'Help'
        );
        if (action === 'Open Settings') {
          vscode.commands.executeCommand(
            'workbench.action.openSettings',
            'anvil-path'
          );
          this.anvil();
        }
        if (action === 'Try Again') {
          this.anvil();
        }
        if (action === 'Help') {
          vscode.commands.executeCommand(
            'vscode.open',
            vscode.Uri.parse('https://docs.runtimeverification.com/simbolik')
          );
          this.anvil();
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
    this._simbolik?.terminate();
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
    new vscode.ShellExecution(
      simbolikPath,
      ['--port', port.toString()],
    )
  );
  task.isBackground = true;
  task.presentationOptions.reveal = vscode.TaskRevealKind.Never;
  return task;
}
