import * as vscode from 'vscode';

export class KastProvider implements vscode.TextDocumentContentProvider {
  static scheme = 'simbolik-kast';

  provideTextDocumentContent(uri: vscode.Uri): string | Thenable<string> {
    const frame_id = uri.path;
    const debugSession = vscode.debug.activeDebugSession;
    if (debugSession === undefined) {
      return Promise.reject('No active debug session');
    }
    return debugSession
      .customRequest('simbolik/viewKast', {frameId: frame_id})
      .then((response: any) => {
        return response.internalRepresentation;
      });
  }
}

export async function viewKast(file: string, frame: any) {
  const frame_id = frame.frameId ?? '';
  const debugSession = vscode.debug.activeDebugSession;
  if (debugSession === undefined) {
    throw new Error('No active debug session');
  }
  const doc = await vscode.workspace.openTextDocument(
    vscode.Uri.parse(`${KastProvider.scheme}:///${frame_id}`)
  );
  await vscode.window.showTextDocument(doc, {preview: true});
}
