import * as vscode from 'vscode';
import { TarLocalFile, untar } from '@andrewbranch/untar.js';
import { gunzipSync } from 'fflate';

const FILETYPE_DIRECTORY = '5';
const FILETYPE_FILE = '0';

export async function downloadAndExtract(url: string): Promise<void> {
  // 1. Download
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} – ${res.statusText}`);
  }
  const gzBuf = new Uint8Array(await res.arrayBuffer());

  // 2. Gunzip → get raw .tar bytes
  const tarBuf = gunzipSync(gzBuf); // ← new

  // 3. Untar in-memory
  const files: TarLocalFile[] = await untar(tarBuf);

  // 4. Persist into tmp://
  for (const entry of files) {
    const uri = vscode.Uri.parse(`tmp://${entry.name}`);

    if (entry.typeflag === FILETYPE_DIRECTORY) {
      // '5' indicates a directory in tar format
      await vscode.workspace.fs.createDirectory(uri);
    } else if (entry.typeflag === FILETYPE_FILE || entry.typeflag === '') {
      // '0' or '' indicates a file in tar format
      await vscode.workspace.fs.writeFile(uri, entry.fileData);
    }
  }
}
