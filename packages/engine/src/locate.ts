/**
 * Find and sanity-check an execution node's binary before spawning it, so a
 * missing or broken install is reported with what was tried and how to fix it,
 * instead of surfacing later as an opaque spawn error or readiness timeout.
 */
import {execFile} from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Where {@link locateExecutable} found the binary, or why it did not. */
export type Located =
  | {kind: 'found'; path: string; via: 'explicit' | 'PATH' | 'fallback'}
  /** A bare command name found in none of `searched`. */
  | {kind: 'not-found'; searched: string[]}
  /** An explicit path (containing a separator) that does not exist. */
  | {kind: 'no-such-file'; path: string}
  | {kind: 'is-directory'; path: string}
  | {kind: 'not-executable'; path: string};

export interface LocateOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /**
   * Directories searched after `PATH` for a bare command name. An editor
   * launched from a desktop environment (e.g. the macOS Dock) often does not
   * inherit the login shell's `PATH`, so a binary the user can run from a
   * terminal may be missing from the extension host's `PATH`.
   */
  fallbackDirs?: string[];
}

/**
 * The per-user and system Nix profile `bin` directories, where `kup` (a Nix
 * front end) installs its packages.
 */
export function nixProfileBinDirs(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string[] {
  const user = env.USER ?? path.basename(home);
  return [
    path.join(home, '.nix-profile', 'bin'),
    path.join(home, '.local', 'state', 'nix', 'profile', 'bin'),
    `/etc/profiles/per-user/${user}/bin`,
    '/nix/var/nix/profiles/default/bin',
  ];
}

/**
 * Resolve `command` to an executable file. A value containing a path separator
 * is taken as an explicit path (relative ones against the current directory);
 * a bare name is searched on `PATH`, then in `fallbackDirs`.
 */
export function locateExecutable(
  command: string,
  opts: LocateOptions = {},
): Located {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const expanded = expandHome(command);

  if (
    expanded.includes('/') ||
    (platform === 'win32' && expanded.includes('\\'))
  ) {
    const file = path.resolve(expanded);
    if (!fs.existsSync(file)) return {kind: 'no-such-file', path: file};
    if (fs.statSync(file).isDirectory())
      return {kind: 'is-directory', path: file};
    if (!isExecutable(file, platform))
      return {kind: 'not-executable', path: file};
    return {kind: 'found', path: file, via: 'explicit'};
  }

  const pathDirs = (env.PATH ?? '').split(path.delimiter).filter(d => d !== '');
  const exts =
    platform === 'win32'
      ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')]
      : [''];
  const searched: string[] = [];
  const search = (
    dirs: string[],
    via: 'PATH' | 'fallback',
  ): Located | undefined => {
    for (const dir of dirs) {
      if (searched.includes(dir)) continue;
      searched.push(dir);
      for (const ext of exts) {
        const file = path.join(dir, expanded + ext);
        if (isFile(file) && isExecutable(file, platform)) {
          return {kind: 'found', path: file, via};
        }
      }
    }
    return undefined;
  };
  return (
    search(pathDirs, 'PATH') ??
    search(opts.fallbackDirs ?? [], 'fallback') ?? {kind: 'not-found', searched}
  );
}

/** The outcome of running a binary's self-check command. */
export type Probe =
  | {ok: true; output: string}
  | {ok: false; exitCode: number | null; output: string; timedOut: boolean};

/**
 * Run `kontrol-node version` — it exits non-zero when the install is broken
 * (e.g. `RuntimeError: K is not installed` when the K runtime it needs is
 * missing), which `--help` would not reveal.
 */
export function probeKontrolNode(
  binary: string,
  timeoutMs = 60_000,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Probe> {
  return new Promise<Probe>(resolve => {
    execFile(
      binary,
      ['version'],
      {timeout: timeoutMs, env, maxBuffer: 1024 * 1024},
      (err, stdout, stderr) => {
        const output = `${stdout}${stderr}`.trim();
        if (err === null) {
          resolve({ok: true, output});
          return;
        }
        const e = err as NodeJS.ErrnoException & {
          killed?: boolean;
          code?: unknown;
        };
        resolve({
          ok: false,
          exitCode: typeof e.code === 'number' ? e.code : null,
          output: output || e.message,
          timedOut: e.killed === true,
        });
      },
    );
  });
}

/** The last `n` non-empty lines of `text` (for quoting a failure's cause). */
export function tailLines(text: string, n: number): string {
  return text
    .split(/\r?\n/)
    .filter(l => l.trim() !== '')
    .slice(-n)
    .join('\n');
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isExecutable(file: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') return true; // no execute bit; PATHEXT decides.
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
