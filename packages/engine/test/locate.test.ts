import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {
  locateExecutable,
  nixProfileBinDirs,
  probeKontrolNode,
  tailLines,
} from '../src/index.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'simbolik-locate-'));
});

afterEach(() => {
  fs.rmSync(tmp, {recursive: true, force: true});
});

/** Create `dir/name` with `body`, executable unless `exec` is false. */
function script(dir: string, name: string, body: string, exec = true): string {
  fs.mkdirSync(dir, {recursive: true});
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, exec ? 0o755 : 0o644);
  return file;
}

describe('locateExecutable — bare command name', () => {
  it('finds the first match on PATH', () => {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    script(b, 'kontrol-node', 'exit 0');
    const file = script(a, 'kontrol-node', 'exit 0');
    const env = {PATH: [a, b].join(path.delimiter)};
    expect(locateExecutable('kontrol-node', {env})).toEqual({
      kind: 'found',
      path: file,
      via: 'PATH',
    });
  });

  it('skips a non-executable file on PATH', () => {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    script(a, 'kontrol-node', 'exit 0', false);
    const file = script(b, 'kontrol-node', 'exit 0');
    const env = {PATH: [a, b].join(path.delimiter)};
    expect(locateExecutable('kontrol-node', {env})).toMatchObject({
      kind: 'found',
      path: file,
    });
  });

  it('falls back to extra dirs when PATH misses it (e.g. a Dock-launched editor)', () => {
    const onPath = path.join(tmp, 'bin');
    fs.mkdirSync(onPath);
    const profile = path.join(tmp, 'profile', 'bin');
    const file = script(profile, 'kontrol-node', 'exit 0');
    expect(
      locateExecutable('kontrol-node', {
        env: {PATH: onPath},
        fallbackDirs: [profile],
      }),
    ).toEqual({kind: 'found', path: file, via: 'fallback'});
  });

  it('reports every directory it searched when nothing matches', () => {
    const onPath = path.join(tmp, 'bin');
    const profile = path.join(tmp, 'profile');
    expect(
      locateExecutable('kontrol-node', {
        env: {PATH: [onPath, onPath].join(path.delimiter)},
        fallbackDirs: [profile],
      }),
    ).toEqual({kind: 'not-found', searched: [onPath, profile]});
  });
});

describe('locateExecutable — explicit path', () => {
  it('accepts an executable file', () => {
    const file = script(tmp, 'kontrol-node', 'exit 0');
    expect(locateExecutable(file, {env: {PATH: ''}})).toEqual({
      kind: 'found',
      path: file,
      via: 'explicit',
    });
  });

  it('does not search PATH for a path with a separator', () => {
    const onPath = path.join(tmp, 'bin');
    script(onPath, 'kontrol-node', 'exit 0');
    const missing = path.join(tmp, 'elsewhere', 'kontrol-node');
    expect(locateExecutable(missing, {env: {PATH: onPath}})).toEqual({
      kind: 'no-such-file',
      path: missing,
    });
  });

  it('distinguishes a directory and a non-executable file', () => {
    expect(locateExecutable(tmp)).toEqual({kind: 'is-directory', path: tmp});
    const file = script(tmp, 'kontrol-node', 'exit 0', false);
    expect(locateExecutable(file)).toEqual({
      kind: 'not-executable',
      path: file,
    });
  });

  it('expands a leading ~', () => {
    const located = locateExecutable('~/no-such-simbolik-binary');
    expect(located).toEqual({
      kind: 'no-such-file',
      path: path.join(os.homedir(), 'no-such-simbolik-binary'),
    });
  });
});

describe('nixProfileBinDirs', () => {
  it('lists the user and system Nix profiles kup installs into', () => {
    expect(nixProfileBinDirs({USER: 'alice'}, '/home/alice')).toEqual([
      '/home/alice/.nix-profile/bin',
      '/home/alice/.local/state/nix/profile/bin',
      '/etc/profiles/per-user/alice/bin',
      '/nix/var/nix/profiles/default/bin',
    ]);
  });
});

describe('probeKontrolNode', () => {
  it('runs `version` and returns its output on success', async () => {
    const file = script(tmp, 'kontrol-node', 'echo "kontrol-node $1 0.1.0"');
    await expect(probeKontrolNode(file)).resolves.toEqual({
      ok: true,
      output: 'kontrol-node version 0.1.0',
    });
  });

  it('reports a broken install with its exit code and error output', async () => {
    const file = script(
      tmp,
      'kontrol-node',
      'echo "Traceback (most recent call last):" >&2\n' +
        'echo "RuntimeError: K is not installed" >&2\nexit 1',
    );
    const probe = await probeKontrolNode(file);
    expect(probe).toMatchObject({ok: false, exitCode: 1, timedOut: false});
    expect(probe.output).toContain('RuntimeError: K is not installed');
  });

  it('reports a hang as a timeout', async () => {
    const file = script(tmp, 'kontrol-node', 'sleep 5');
    await expect(probeKontrolNode(file, 100)).resolves.toMatchObject({
      ok: false,
      timedOut: true,
    });
  });
});

describe('tailLines', () => {
  it('keeps the last non-empty lines', () => {
    expect(tailLines('a\n\nb\nc\n\n', 2)).toBe('b\nc');
  });
});
