import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
// A dev-only spec (excluded from the extension build), so vitest may be unpublished.
// eslint-disable-next-line n/no-unpublished-import
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import type {Probe} from '@simbolik/engine';
import {checkNodeSetup, type SetupInputs} from './nodeSetup';

let tmp: string;
let bin: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'simbolik-setup-'));
  bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
});

afterEach(() => {
  fs.rmSync(tmp, {recursive: true, force: true});
});

function executable(dir: string, name: string): string {
  fs.mkdirSync(dir, {recursive: true});
  const file = path.join(dir, name);
  fs.writeFileSync(file, '#!/bin/sh\n');
  fs.chmodSync(file, 0o755);
  return file;
}

const works: Probe = {ok: true, output: 'kontrol-node 0.1.42'};

function inputs(over: Partial<SetupInputs> = {}): SetupInputs {
  return {
    kontrolNodePath: '',
    kontrolNodeDir: '',
    anvilPath: '',
    env: {PATH: bin},
    fallbackDirs: [],
    probe: async () => works,
    ...over,
  };
}

const actionKinds = (r: {actions?: {kind: string}[]}) =>
  (r.actions ?? []).map(a => a.kind);

describe('kontrol-node — installed (kup / PATH)', () => {
  it('uses kontrol-node from PATH and launches it in the work dir', async () => {
    const file = executable(bin, 'kontrol-node');
    const setup = await checkNodeSetup('kontrol-node', inputs());
    expect(setup).toMatchObject({
      ok: true,
      description: `kontrol-node 0.1.42 at ${file}`,
      needsWorkDir: true,
    });
    if (!setup.ok) throw new Error('unreachable');
    expect(setup.launch(8899, '/tmp/w')).toMatchObject({
      command: file,
      args: ['run', '--host', '127.0.0.1', '--port', '8899', '--steps-tracing'],
      cwd: '/tmp/w',
    });
  });

  it('finds a kup install outside the editor PATH and says so', async () => {
    const profile = path.join(tmp, '.nix-profile', 'bin');
    const file = executable(profile, 'kontrol-node');
    const setup = await checkNodeSetup(
      'kontrol-node',
      inputs({fallbackDirs: [profile]})
    );
    expect(setup).toMatchObject({
      ok: true,
      description: `kontrol-node 0.1.42 at ${file} (found outside the editor's PATH, in ${profile})`,
    });
  });

  it('tells a user without kup to install kup first', async () => {
    const setup = await checkNodeSetup('kontrol-node', inputs());
    expect(setup.ok).toBe(false);
    if (setup.ok) return;
    expect(setup.message).toBe(
      'Simbolik could not find kontrol-node, the execution engine it runs ' +
        'your code on. Install kup (`bash <(curl https://kframework.org/install)`), ' +
        'then run `kup install kontrol-node`. If it is already installed, set ' +
        '"simbolik.kontrol-node-path" to its location.'
    );
    expect(setup.details).toEqual(['Searched these directories:', `  ${bin}`]);
    expect(actionKinds(setup)).toEqual(['install-guide', 'open-setting']);
  });

  it('tells a user with kup to install the kontrol-node package', async () => {
    executable(bin, 'kup');
    const setup = await checkNodeSetup('kontrol-node', inputs());
    expect(setup.ok).toBe(false);
    if (setup.ok) return;
    expect(setup.message).toContain(
      'kup is installed, but kontrol-node is not: run `kup install kontrol-node`.'
    );
  });

  it('names a custom command that is not on PATH', async () => {
    const setup = await checkNodeSetup(
      'kontrol-node',
      inputs({kontrolNodePath: 'kontrol-node-dev'})
    );
    expect(setup).toMatchObject({
      ok: false,
      message:
        '"simbolik.kontrol-node-path" is set to "kontrol-node-dev", but no ' +
        'such command was found on your PATH. Set it to the full path of the ' +
        'kontrol-node executable.',
    });
  });

  it('explains a configured path that is missing, a directory, or not executable', async () => {
    const missing = path.join(tmp, 'nope', 'kontrol-node');
    expect(
      await checkNodeSetup('kontrol-node', inputs({kontrolNodePath: missing}))
    ).toMatchObject({
      ok: false,
      message: `"simbolik.kontrol-node-path" points to ${missing}, but that file does not exist.`,
    });

    expect(
      await checkNodeSetup('kontrol-node', inputs({kontrolNodePath: bin}))
    ).toMatchObject({
      ok: false,
      message:
        `"simbolik.kontrol-node-path" points to the directory ${bin}. Set it ` +
        `to the kontrol-node executable itself (e.g. ${path.join(bin, 'kontrol-node')}).`,
    });

    const plain = path.join(tmp, 'kontrol-node');
    fs.writeFileSync(plain, '');
    const r = await checkNodeSetup(
      'kontrol-node',
      inputs({kontrolNodePath: plain})
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain(`chmod +x ${plain}`);
  });

  it('reports a broken install with the failing line and the full output', async () => {
    const file = executable(bin, 'kontrol-node');
    const output =
      'Traceback (most recent call last):\n  File "…"\nRuntimeError: K is not installed';
    const setup = await checkNodeSetup(
      'kontrol-node',
      inputs({
        probe: async () => ({ok: false, exitCode: 1, output, timedOut: false}),
      })
    );
    expect(setup).toMatchObject({
      ok: false,
      message:
        `kontrol-node at ${file} does not run correctly: \`kontrol-node ` +
        'version` failed: RuntimeError: K is not installed. The installation ' +
        'may be incomplete — reinstall it with `kup install kontrol-node`.',
      details: [`$ ${file} version  (exit code 1)`, output],
    });
    expect(actionKinds(setup as {actions: {kind: string}[]})).toEqual([
      'show-output',
      'install-guide',
    ]);
  });

  it('reports a hanging install as a timeout', async () => {
    executable(bin, 'kontrol-node');
    const setup = await checkNodeSetup(
      'kontrol-node',
      inputs({
        probe: async () => ({
          ok: false,
          exitCode: null,
          output: '',
          timedOut: true,
        }),
      })
    );
    expect(setup.ok).toBe(false);
    if (!setup.ok) {
      expect(setup.message).toContain(
        'it did not answer `kontrol-node version` within a minute'
      );
    }
  });
});

describe('kontrol-node — development checkout', () => {
  function checkout(): string {
    const dir = path.join(tmp, 'kontrol-node');
    executable(path.join(dir, '.venv', 'bin'), 'kontrol-node');
    return dir;
  }

  it('prefers a configured checkout over PATH and runs it through nix', async () => {
    executable(bin, 'kontrol-node');
    const nix = executable(bin, 'nix');
    const dir = checkout();
    const setup = await checkNodeSetup(
      'kontrol-node',
      inputs({kontrolNodeDir: dir})
    );
    expect(setup).toMatchObject({
      ok: true,
      description: `kontrol-node development checkout at ${dir} (via ${nix})`,
    });
    if (setup.ok) {
      expect(setup.launch(8899, '/tmp/w')).toMatchObject({
        command: 'nix',
        cwd: dir,
      });
    }
  });

  it('honours KONTROL_NODE_DIR and names it as the source', async () => {
    const missing = path.join(tmp, 'gone');
    const setup = await checkNodeSetup(
      'kontrol-node',
      inputs({env: {PATH: bin, KONTROL_NODE_DIR: missing}})
    );
    expect(setup).toMatchObject({
      ok: false,
      message:
        'the KONTROL_NODE_DIR environment variable selects the kontrol-node ' +
        `development checkout ${missing}, but that directory does not exist. ` +
        'Clear it to use the installed kontrol-node (`kup install ' +
        'kontrol-node`) instead.',
    });
  });

  it('explains an unprovisioned checkout and a missing nix', async () => {
    const bare = path.join(tmp, 'bare');
    fs.mkdirSync(bare);
    const unprovisioned = await checkNodeSetup(
      'kontrol-node',
      inputs({kontrolNodeDir: bare})
    );
    expect(unprovisioned.ok).toBe(false);
    if (!unprovisioned.ok) {
      expect(unprovisioned.message).toContain('has not been set up');
    }

    const noNix = await checkNodeSetup(
      'kontrol-node',
      inputs({kontrolNodeDir: checkout()})
    );
    expect(noNix.ok).toBe(false);
    if (!noNix.ok) expect(noNix.message).toContain('"nix" was not found');
  });
});

describe('anvil', () => {
  it('uses anvil from PATH', async () => {
    const file = executable(bin, 'anvil');
    const setup = await checkNodeSetup('anvil', inputs());
    expect(setup).toMatchObject({ok: true, needsWorkDir: false});
    if (setup.ok) expect(setup.launch(8899, undefined).command).toBe(file);
  });

  it('points a user without anvil at Foundry and the setting', async () => {
    const setup = await checkNodeSetup('anvil', inputs());
    expect(setup).toMatchObject({
      ok: false,
      message:
        'Simbolik could not start anvil: it was not found on your PATH. ' +
        'Install Foundry (https://getfoundry.sh), or set ' +
        '"simbolik.anvil-path" to the anvil executable.',
    });
  });
});
