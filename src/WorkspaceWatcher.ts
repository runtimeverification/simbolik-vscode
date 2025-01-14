import * as vscode from 'vscode';

/**
 * Watches for changes to Solidity files in the workspace.
 * This is used to determine when a project needs to be recompiled.
 */
export
class WorkspaceWatcher {
    constructor(
        private _hasChanges : boolean = false
    ) {
        vscode.workspace.onDidSaveTextDocument(document => {
            if (document.languageId === 'solidity') {
                this._hasChanges = true;
            }
        });
        vscode.workspace.onDidCreateFiles(event => {
            if (event.files.some(uri => uri.fsPath.endsWith('.sol'))) {
                this._hasChanges = true;
            }
        });
        vscode.workspace.onDidRenameFiles(event => {
            if (event.files.some(uri => uri.newUri.fsPath.endsWith('.sol'))) {
                this._hasChanges = true;
            }
        });
    }
    hasChanges() : boolean {
        return this._hasChanges;
    }
    reset() {
        this._hasChanges = false;  
    }
}
