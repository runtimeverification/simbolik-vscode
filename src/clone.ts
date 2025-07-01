import * as vscode from 'vscode';
import * as path from 'path';

const fs = vscode.workspace.fs;
const textEncoder = new TextEncoder();

/**
 * Clones a static file tree served over HTTPS into VS Code's tmp:// scheme.
 * The server must expose each directory as a *flat JSON array* of names.
 *
 * @param source      Root URL to start cloning from (must end with a slash).
 * @param destination Where to write inside tmp:// (default: tmp:///).
 * @param concurrency How many HTTP requests to run in parallel (default: 5).
 */
export async function cloneStaticTree(
  source: vscode.Uri,
  destination: vscode.Uri = vscode.Uri.parse('tmp:///'),
  concurrency = 5,
): Promise<void> {

  const queue: Array<() => Promise<void>> = [];
  const visited = new Set<string>();

  function enqueue(task: () => Promise<void>) {
    queue.push(task);
  }

  async function worker() {
    while (queue.length) {
      const task = queue.shift()!;
      try {
        await task();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        vscode.window.showErrorMessage(`Clone error: ${msg}`);
      }
    }
  }

  function san(url: vscode.Uri) {
    return url.toString().replace(/\/$/, '');
  }

  function parentDir(uri: vscode.Uri) {
    return uri.with({ path: path.posix.dirname(uri.path) });
  }

  function cloneRecursive(src: vscode.Uri, dst: vscode.Uri) {
    enqueue(async () => {
      if (visited.has(san(src))) return;
      visited.add(san(src));

      const res = await fetch(src.toString(), {
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`${src} → HTTP ${res.status} ${res.statusText}`);

      const ct = res.headers.get('content-type') ?? '';
      const looksLikeJson = ct.includes('application/json');

      if (looksLikeJson) {
        const json = await res.json();

        // Case A: directory listing (flat string array)
        if (Array.isArray(json) && json.every((x) => typeof x === 'string')) {
          await fs.createDirectory(dst);
          for (const name of json as string[]) {
            const childSrc = vscode.Uri.joinPath(src, name);
            const childDst = vscode.Uri.joinPath(dst, name);
            cloneRecursive(childSrc, childDst);
          }
        } else {
          // Case B: "file served as JSON" – stringify & save
          await fs.createDirectory(parentDir(dst));
          await fs.writeFile(
            dst,
            textEncoder.encode(JSON.stringify(json, null, 2)),
          );
        }
      } else {
        // Binary / text file
        const arrayBuffer = await res.arrayBuffer();
        await fs.createDirectory(parentDir(dst));
        await fs.writeFile(dst, new Uint8Array(arrayBuffer));
      }
    });
  }

  cloneRecursive(source, destination);

  // Run N workers in parallel
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
}
