import {EventEmitter} from 'node:events';
import type {ChildProcess} from 'node:child_process';
import type {spawn} from 'node:child_process';
import {describe, expect, it, vi} from 'vitest';
import {
  KontrolNode,
  kontrolNodeLaunch,
  devcontainerLaunch,
  anvilLaunch,
  type FetchLike,
} from '../src/index.js';

const chainIdOk: FetchLike = vi.fn(
  async () => new Response('{"jsonrpc":"2.0","id":0,"result":"0x7a69"}', {status: 200}),
) as FetchLike;

const chainIdFails: FetchLike = vi.fn(async () => {
  throw new TypeError('fetch failed');
}) as FetchLike;

/** A ChildProcess stub with no real pid, so stop() never signals a real group. */
function fakeProc(exitCode: number | null): ChildProcess {
  return {pid: undefined, exitCode, kill: vi.fn()} as unknown as ChildProcess;
}

/**
 * An event-driven ChildProcess stub with `stdout`/`stderr` emitters and a real
 * `on`, so the 'error' listener and output forwarding can be exercised.
 */
function emittingProc(): ChildProcess & EventEmitter {
  const proc = new EventEmitter() as ChildProcess & EventEmitter;
  Object.assign(proc, {
    pid: undefined,
    exitCode: null,
    kill: vi.fn(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  return proc;
}

const spawnStub = (proc: ChildProcess) =>
  (vi.fn(() => proc) as unknown as typeof spawn);

describe('devcontainerLaunch', () => {
  it('builds the nix + venv run recipe with the chosen port', () => {
    const launch = devcontainerLaunch(8899, '/home/node/kontrol-node');
    expect(launch.command).toBe('nix');
    expect(launch.cwd).toBe('/home/node/kontrol-node');
    expect(launch.args.at(-1)).toContain('--port 8899');
    // Removed upstream (tracing is always on); the node rejects the flag.
    expect(launch.args.at(-1)).not.toContain('--steps-tracing');
  });

  it('points KDIST_DIR at the pre-built semantics so RPC calls resolve', () => {
    const launch = devcontainerLaunch(8899, '/home/node/kontrol-node');
    // Without this, every kontrol-node RPC fails with
    // "Target undefined or not built: kontrol-node.simbolik".
    expect(launch.env?.KDIST_DIR).toBe('/home/node/kontrol-node/.kdist');
  });
});

describe('kontrolNodeLaunch', () => {
  it('runs the installed binary on the chosen port', () => {
    const launch = kontrolNodeLaunch(
      8899,
      '/opt/kup/bin/kontrol-node',
      '/tmp/w',
    );
    expect(launch.command).toBe('/opt/kup/bin/kontrol-node');
    expect(launch.args).toEqual([
      'run',
      '--host',
      '127.0.0.1',
      '--port',
      '8899',
    ]);
    expect(launch.cwd).toBe('/tmp/w');
  });

  it('defaults the binary to the bare `kontrol-node` command on PATH', () => {
    expect(kontrolNodeLaunch(8899).command).toBe('kontrol-node');
  });
});

describe('devcontainerLaunch — work dir', () => {
  it('runs nix in the checkout but the node in the work dir', () => {
    const launch = devcontainerLaunch(
      8899,
      '/home/node/kontrol-node',
      "/tmp/it's",
    );
    // `nix develop` needs the checkout's flake; the node's io_dir* scratch
    // directories must land in the throwaway work dir instead.
    expect(launch.cwd).toBe('/home/node/kontrol-node');
    expect(launch.args.at(-1)).toBe(
      "cd '/tmp/it'\\''s' && '/home/node/kontrol-node'/.venv/bin/kontrol-node run --port 8899",
    );
  });
});

describe('KontrolNode', () => {
  it('start() resolves once the node answers eth_chainId', async () => {
    const node = new KontrolNode({
      port: 8899,
      launch: devcontainerLaunch(8899),
      fetch: chainIdOk,
      spawnFn: spawnStub(fakeProc(null)),
      readyPollMs: 1,
    });
    await expect(node.start()).resolves.toBeUndefined();
    expect(node.url).toBe('http://127.0.0.1:8899');
    await node.stop();
  });

  it('start() rejects if the process exits during startup', async () => {
    const node = new KontrolNode({
      port: 8899,
      launch: devcontainerLaunch(8899),
      fetch: chainIdOk,
      spawnFn: spawnStub(fakeProc(1)),
      readyPollMs: 1,
      readyTimeoutMs: 50,
    });
    await expect(node.start()).rejects.toThrow(/exited during startup/);
  });

  it('start() quotes the output of a node that dies during startup', async () => {
    const proc = emittingProc();
    const node = new KontrolNode({
      port: 8899,
      launch: kontrolNodeLaunch(8899),
      fetch: chainIdFails,
      spawnFn: spawnStub(proc),
      readyPollMs: 1,
      readyTimeoutMs: 5000,
    });
    const started = node.start();
    proc.stderr!.emit('data', 'Traceback (most recent call last):\n');
    proc.stderr!.emit('data', 'RuntimeError: K is not installed\n');
    (proc as {exitCode: number | null}).exitCode = 1;
    await expect(started).rejects.toThrow(
      /exited during startup \(code 1\):\n.*K is not installed/s,
    );
  });

  it('start() fails fast with the real reason when the binary is missing', async () => {
    const proc = emittingProc();
    const node = new KontrolNode({
      port: 8899,
      launch: anvilLaunch(8899, '/no/such/anvil'),
      fetch: chainIdFails, // never becomes ready on its own
      spawnFn: spawnStub(proc),
      readyPollMs: 1,
      readyTimeoutMs: 5000, // long: proves we fail on the error, not the timeout
    });
    const started = node.start();
    // Node emits the spawn error asynchronously (ENOENT).
    const enoent = Object.assign(new Error('spawn ENOENT'), {code: 'ENOENT'});
    proc.emit('error', enoent);
    await expect(started).rejects.toThrow(/failed to start node.*ENOENT/s);
  });

  it('start() forwards child stdout/stderr to onLog', async () => {
    const proc = emittingProc();
    const logs: string[] = [];
    const node = new KontrolNode({
      port: 8899,
      launch: anvilLaunch(8899),
      fetch: chainIdOk,
      spawnFn: spawnStub(proc),
      onLog: chunk => logs.push(chunk),
      readyPollMs: 1,
    });
    await node.start(); // becomes ready via chainIdOk
    proc.stdout!.emit('data', Buffer.from('listening on 127.0.0.1:8899\n'));
    proc.stderr!.emit('data', 'a warning\n');
    expect(logs).toContain('listening on 127.0.0.1:8899\n');
    expect(logs).toContain('a warning\n');
    await node.stop();
  });
});

describe('anvilLaunch', () => {
  it('builds an anvil run recipe with step-tracing on the chosen port', () => {
    const launch = anvilLaunch(8546, '/usr/local/bin/anvil');
    expect(launch.command).toBe('/usr/local/bin/anvil');
    expect(launch.args).toContain('--steps-tracing');
    expect(launch.args.join(' ')).toContain('--port 8546');
    expect(launch.cwd).toBeUndefined();
  });

  it('defaults the binary to the bare `anvil` command on PATH', () => {
    expect(anvilLaunch(8546).command).toBe('anvil');
  });
});
