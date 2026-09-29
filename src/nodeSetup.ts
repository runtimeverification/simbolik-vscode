/**
 * Decide how to launch the execution node for a debug session, or explain —
 * precisely and actionably — why it cannot be launched. Kept free of `vscode` so
 * the diagnosis and every message are unit-tested; `nodeManager.ts` only turns a
 * {@link SetupProblem} into a notification with buttons.
 *
 * kontrol-node is found the VSCode way: `simbolik.kontrol-node-path` (default:
 * `kontrol-node` on `PATH`, then the Nix profiles `kup` installs into). A
 * development checkout (`simbolik.kontrol-node-dir` / `KONTROL_NODE_DIR`, e.g.
 * the dev container's engine) takes precedence when set.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  anvilLaunch,
  devcontainerLaunch,
  kontrolNodeLaunch,
  locateExecutable,
  probeKontrolNode,
  tailLines,
  type Located,
  type NodeLaunch,
  type Probe,
} from '@simbolik/engine';

export type NodeType = 'anvil' | 'kontrol-node';

/** Where the README's installation instructions live. */
export const INSTALL_GUIDE_URL =
  'https://github.com/runtimeverification/simbolik-vscode#installation';

export const KUP_INSTALL = 'bash <(curl https://kframework.org/install)';
export const KONTROL_NODE_INSTALL = 'kup install kontrol-node';

/** A button offered with a {@link SetupProblem}. */
export type SetupAction =
  | {kind: 'install-guide'}
  | {kind: 'open-setting'; setting: string}
  | {kind: 'show-output'};

export interface SetupProblem {
  ok: false;
  /** The notification text: what is wrong and how to fix it. */
  message: string;
  /** Supporting detail for the output channel (searched dirs, command output). */
  details: string[];
  actions: SetupAction[];
}

export interface NodeSetup {
  ok: true;
  /** One line for the output channel, e.g. `kontrol-node 0.1.0 at /…/kontrol-node`. */
  description: string;
  /** Whether the node leaves scratch files in its working directory. */
  needsWorkDir: boolean;
  launch(port: number, workDir: string | undefined): NodeLaunch;
}

/** The settings (and environment) that determine how a node is launched. */
export interface SetupInputs {
  /** `simbolik.kontrol-node-path`; empty ⇒ the default `kontrol-node`. */
  kontrolNodePath: string;
  /** `simbolik.kontrol-node-dir`; empty ⇒ `env.KONTROL_NODE_DIR`, if set. */
  kontrolNodeDir: string;
  /** `simbolik.anvil-path`; empty ⇒ the default `anvil`. */
  anvilPath: string;
  env: NodeJS.ProcessEnv;
  /** Searched after `PATH` for a bare command name (see `nixProfileBinDirs`). */
  fallbackDirs: string[];
  /** Injectable for tests; defaults to running `kontrol-node version`. */
  probe?: (binary: string) => Promise<Probe>;
}

const PATH_SETTING = 'simbolik.kontrol-node-path';
const DIR_SETTING = 'simbolik.kontrol-node-dir';
const ANVIL_SETTING = 'simbolik.anvil-path';

/** Work out how to launch `type`, or why it cannot be launched. */
export async function checkNodeSetup(
  type: NodeType,
  inputs: SetupInputs
): Promise<NodeSetup | SetupProblem> {
  if (type === 'anvil') return checkAnvil(inputs);
  const dir = inputs.kontrolNodeDir || inputs.env.KONTROL_NODE_DIR || '';
  if (dir !== '') {
    const source = inputs.kontrolNodeDir
      ? `"${DIR_SETTING}"`
      : 'the KONTROL_NODE_DIR environment variable';
    return checkCheckout(dir, source, inputs);
  }
  return checkInstalled(inputs);
}

async function checkInstalled(
  inputs: SetupInputs
): Promise<NodeSetup | SetupProblem> {
  const configured = inputs.kontrolNodePath.trim();
  const command = configured || 'kontrol-node';
  const located = locate(command, inputs);
  if (located.kind !== 'found') {
    return notFound(located, configured, inputs);
  }

  const binary = located.path;
  const probe = await (inputs.probe ?? probeKontrolNode)(binary);
  if (!probe.ok) {
    const why = probe.timedOut
      ? 'it did not answer `kontrol-node version` within a minute'
      : `\`kontrol-node version\` failed${lastLine(probe.output)}`;
    return {
      ok: false,
      message:
        `kontrol-node at ${binary} does not run correctly: ${why}. The ` +
        `installation may be incomplete — reinstall it with \`${KONTROL_NODE_INSTALL}\`.`,
      details: [
        `$ ${binary} version  (exit code ${probe.exitCode ?? 'none'})`,
        probe.output,
      ],
      actions: [{kind: 'show-output'}, {kind: 'install-guide'}],
    };
  }

  const version = probe.output.split(/\r?\n/)[0]?.trim() || 'kontrol-node';
  const where =
    located.via === 'fallback'
      ? ` (found outside the editor's PATH, in ${path.dirname(binary)})`
      : '';
  return {
    ok: true,
    description: `${version} at ${binary}${where}`,
    needsWorkDir: true,
    launch: (port, workDir) => kontrolNodeLaunch(port, binary, workDir),
  };
}

/** The message for a kontrol-node binary that could not be located. */
function notFound(
  located: Exclude<Located, {kind: 'found'}>,
  configured: string,
  inputs: SetupInputs
): SetupProblem {
  const fixSetting: SetupAction = {kind: 'open-setting', setting: PATH_SETTING};
  switch (located.kind) {
    case 'not-found': {
      const details = [
        'Searched these directories:',
        ...located.searched.map(d => `  ${d}`),
      ];
      if (configured !== '' && configured !== 'kontrol-node') {
        return {
          ok: false,
          message:
            `"${PATH_SETTING}" is set to "${configured}", but no such ` +
            'command was found on your PATH. Set it to the full path of the ' +
            'kontrol-node executable.',
          details,
          actions: [fixSetting, {kind: 'install-guide'}],
        };
      }
      const hasKup = locate('kup', inputs).kind === 'found';
      const install = hasKup
        ? `kup is installed, but kontrol-node is not: run \`${KONTROL_NODE_INSTALL}\`.`
        : `Install kup (\`${KUP_INSTALL}\`), then run \`${KONTROL_NODE_INSTALL}\`.`;
      return {
        ok: false,
        message:
          'Simbolik could not find kontrol-node, the execution engine it runs ' +
          `your code on. ${install} If it is already installed, set ` +
          `"${PATH_SETTING}" to its location.`,
        details,
        actions: [{kind: 'install-guide'}, fixSetting],
      };
    }
    case 'no-such-file':
      return {
        ok: false,
        message: `"${PATH_SETTING}" points to ${located.path}, but that file does not exist.`,
        details: [],
        actions: [fixSetting, {kind: 'install-guide'}],
      };
    case 'is-directory':
      return {
        ok: false,
        message:
          `"${PATH_SETTING}" points to the directory ${located.path}. Set it ` +
          `to the kontrol-node executable itself (e.g. ${path.join(located.path, 'kontrol-node')}).`,
        details: [],
        actions: [fixSetting],
      };
    case 'not-executable':
      return {
        ok: false,
        message:
          `"${PATH_SETTING}" points to ${located.path}, which is not ` +
          `executable. Make it executable (\`chmod +x ${located.path}\`) or ` +
          'point the setting at the kontrol-node executable.',
        details: [],
        actions: [fixSetting],
      };
  }
}

/** A development checkout of kontrol-node, run through its Nix dev shell. */
function checkCheckout(
  dir: string,
  source: string,
  inputs: SetupInputs
): NodeSetup | SetupProblem {
  const clearDir: SetupAction = {kind: 'open-setting', setting: DIR_SETTING};
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return {
      ok: false,
      message:
        `${source} selects the kontrol-node development checkout ${dir}, but ` +
        'that directory does not exist. Clear it to use the installed ' +
        `kontrol-node (\`${KONTROL_NODE_INSTALL}\`) instead.`,
      details: [],
      actions: [clearDir, {kind: 'install-guide'}],
    };
  }
  const venvBinary = path.join(dir, '.venv', 'bin', 'kontrol-node');
  if (!fs.existsSync(venvBinary)) {
    return {
      ok: false,
      message:
        `${source} selects the kontrol-node checkout ${dir}, but it has not ` +
        `been set up (${venvBinary} is missing). Run ` +
        '.devcontainer/setup-kontrol-node.sh, or clear it to use the ' +
        'installed kontrol-node instead.',
      details: [],
      actions: [clearDir, {kind: 'install-guide'}],
    };
  }
  const nix = locate('nix', inputs);
  if (nix.kind !== 'found') {
    return {
      ok: false,
      message:
        `The kontrol-node checkout ${dir} (selected by ${source}) runs through ` +
        'Nix, but "nix" was not found on your PATH. Install Nix, or clear ' +
        'the setting to use the installed kontrol-node instead.',
      details: [],
      actions: [clearDir, {kind: 'install-guide'}],
    };
  }
  return {
    ok: true,
    description: `kontrol-node development checkout at ${dir} (via ${nix.path})`,
    needsWorkDir: true,
    launch: (port, workDir) => devcontainerLaunch(port, dir, workDir),
  };
}

function checkAnvil(inputs: SetupInputs): NodeSetup | SetupProblem {
  const configured = inputs.anvilPath.trim();
  const located = locate(configured || 'anvil', inputs);
  if (located.kind !== 'found') {
    const where =
      located.kind === 'not-found'
        ? configured !== '' && configured !== 'anvil'
          ? `"${configured}" was not found on your PATH`
          : 'it was not found on your PATH'
        : `${located.path} ${
            located.kind === 'no-such-file'
              ? 'does not exist'
              : located.kind === 'is-directory'
                ? 'is a directory'
                : 'is not executable'
          }`;
    return {
      ok: false,
      message:
        `Simbolik could not start anvil: ${where}. Install Foundry ` +
        `(https://getfoundry.sh), or set "${ANVIL_SETTING}" to the anvil executable.`,
      details:
        located.kind === 'not-found'
          ? [
              'Searched these directories:',
              ...located.searched.map(d => `  ${d}`),
            ]
          : [],
      actions: [{kind: 'open-setting', setting: ANVIL_SETTING}],
    };
  }
  const binary = located.path;
  return {
    ok: true,
    description: `anvil at ${binary}`,
    needsWorkDir: false,
    launch: port => anvilLaunch(port, binary),
  };
}

function locate(command: string, inputs: SetupInputs): Located {
  return locateExecutable(command, {
    env: inputs.env,
    fallbackDirs: inputs.fallbackDirs,
  });
}

/** `: <the last line of output>`, or nothing when there is no output. */
function lastLine(output: string): string {
  const line = tailLines(output, 1);
  return line === '' ? '' : `: ${line}`;
}
