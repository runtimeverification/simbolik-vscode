import {fileURLToPath} from 'node:url';

/**
 * The DAP launch/attach argument fields the resolver reads. These are the
 * `FullDebugConfiguration` fields (see `src/startDebugging.ts`) injected by the
 * extension adapter into the launch/attach `arguments`. They arrive as plain
 * JSON over DAP (tcp mode) or as live objects (inline mode), so path-shaped
 * fields (`buildInfoFiles`) may be strings, `vscode.Uri` instances, or the
 * URI's serialized `{scheme,path,fsPath,…}` form — {@link toFsPath} normalizes.
 */
export interface LaunchArgs {
  request?: 'launch' | 'attach';
  contractName?: string;
  methodSignature?: string;
  /** ABI-encoded method arguments (`0x…`), or `'0x'` for a no-arg method. */
  payload?: string;
  /** Build-info file(s): fs paths, `file://` URLs, or `vscode.Uri`-shaped. */
  buildInfoFiles?: unknown[];
  jsonRpcUrl?: string;
  rpcNodeType?: 'anvil' | 'kontrol-node';
  /** Source file (path/URI) of the contract under debug. */
  file?: string;
  /** attach: the transaction hash to replay. */
  txHash?: string;
  /** attach: the Sourcify server base URL (defaults to the public server). */
  sourcifyUrl?: string;
  /** attach: the chain id (overrides the node's `eth_chainId` when provided). */
  chainId?: number;
}

/**
 * Normalize a `buildInfoFiles` entry to a filesystem path. Handles a plain
 * string path, a `file://` URL string, a `vscode.Uri` instance (`.fsPath`), and
 * the URI's serialized JSON form (`{fsPath}` / `{path}` / `{external}`). We must
 * NOT import `vscode` here (this module is bundled ESM and also spawned as a
 * standalone node process), so the URI is read purely by duck-typing.
 */
export function toFsPath(entry: unknown): string {
  if (typeof entry === 'string') {
    return entry.startsWith('file://') ? fileURLToPath(entry) : entry;
  }
  if (entry !== null && typeof entry === 'object') {
    const o = entry as Record<string, unknown>;
    if (typeof o['fsPath'] === 'string') return o['fsPath'];
    if (typeof o['path'] === 'string') return o['path'];
    if (
      typeof o['external'] === 'string' &&
      o['external'].startsWith('file://')
    ) {
      return fileURLToPath(o['external']);
    }
  }
  throw new Error(
    `buildInfoFiles: cannot resolve a filesystem path from ${JSON.stringify(entry)}`
  );
}

/** {@link toFsPath} with `/` separators, for suffix-matching `sourcePath`s. */
export function toPosixFsPath(entry: unknown): string {
  return toFsPath(entry).replace(/\\/g, '/');
}

/**
 * The absolute project root the build-info's relative `sourcePath`s resolve
 * against: the prefix of the debugged source file for which
 * `root/sourcePath === file`. Returns `undefined` when `file` is absent or does
 * not end with `sourcePath` (then frames fall back to served content). Used so a
 * LOCAL launch opens the user's real, editable files.
 */
export function deriveSourceRoot(
  file: string | undefined,
  sourcePath: string
): string | undefined {
  if (file === undefined) return undefined;
  let abs: string;
  try {
    abs = toPosixFsPath(file);
  } catch {
    return undefined;
  }
  const suffix = '/' + sourcePath;
  return abs.endsWith(suffix) ? abs.slice(0, -suffix.length) : undefined;
}
