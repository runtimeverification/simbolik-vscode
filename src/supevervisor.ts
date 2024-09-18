import * as vscode from 'vscode';
import {getConfigValue} from './utils';
import {Server as SourcifyServer} from "sourcify-server";
import {ServerOptions} from "sourcify-server";
import { VerificationServiceOptions } from 'sourcify-server/dist/server/services/VerificationService';
import { StorageServiceOptions } from 'sourcify-server/dist/server/services/StorageService';

import { RWStorageIdentifiers } from 'sourcify-server/dist/server/services/storageServices/identifiers';
import { SourcifyChain, SourcifyChainMap } from '../vendor/sourcify/packages/lib-sourcify/build/main';

 import { SolcLocal } from "sourcify-server/dist/server/services/compiler/local/SolcLocal";
import { SessionOptions } from 'express-session';

export class Supervisor {
  private _simbolik: vscode.TaskExecution | undefined;
  private _anvil: vscode.TaskExecution | undefined;
  private _sourcify: SourcifyServer | undefined;

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

  public async sourcify(): Promise<void> {

    const chainMap : SourcifyChainMap = {
      '31337':  new SourcifyChain({
        name: "Anvil Localhost",
        shortName: "Anvil",
        chainId: 31337,
        faucets: [],
        infoURL: "localhost",
        nativeCurrency: { name: "localETH", symbol: "localETH", decimals: 18 },
        network: "testnet",
        networkId: 31337,
        rpc: [`http://localhost:8545`],
        supported: true,
      })
    }

    const sessionOptions : SessionOptions = {
      secret: '',
      name: "sourcify_vid",
      rolling: true,
      resave: false,
      saveUninitialized: true,
    }

    const solcRepoPath = getConfigValue('sourcify-solc-repo', '~/.local/bin');
    const serverOptions : ServerOptions = {
      port: 5555,
      maxFileSize: 30 * 1024 * 1024,
      rateLimit: {enabled: false},
      corsAllowedOrigins: ['*'],
      chains: chainMap,
      solc: new SolcLocal(solcRepoPath),
      verifyDeprecated: false,
      sessionOptions
    }
    const verifierOptions : VerificationServiceOptions = {
      initCompilers: false,
      supportedChainsMap: chainMap,
      repoPath: solcRepoPath
    }
    const storageOptions : StorageServiceOptions = {
      enabledServices: {
        read: RWStorageIdentifiers.RepositoryV1,
        writeOrWarn: [],
        writeOrErr: [RWStorageIdentifiers.RepositoryV1],
      },
      repositoryV1ServiceOptions: {
        ipfsApi: process.env.IPFS_API as string,
        repositoryPath: "/tmp/sourcify/repository", // TODO: use unique path
        repositoryServerUrl: "http://localhost:10000",
      },
      repositoryV2ServiceOptions: {
        ipfsApi: process.env.IPFS_API as string,
      },
    }

    this._sourcify = new SourcifyServer(serverOptions, verifierOptions, storageOptions);

    this._sourcify.app.listen(serverOptions.port, () => {
      console.log(`Sourcify server listening on port ${serverOptions.port}`);
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

  public anvilTerminate(): void {
    this._anvil?.terminate();
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
    new vscode.ShellExecution(simbolikPath, ['--port', port.toString()])
  );
  task.isBackground = true;
  task.presentationOptions.reveal = vscode.TaskRevealKind.Never;
  return task;
}
