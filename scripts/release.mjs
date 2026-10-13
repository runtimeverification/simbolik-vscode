#!/usr/bin/env node
// Publish the extension to the Visual Studio Marketplace and Open VSX from a
// developer machine, then attach the .vsix to a GitHub release.
//
// Usage: npm run release -- [options]
//   --skip-marketplace   don't publish to the Visual Studio Marketplace
//   --skip-openvsx       don't publish to Open VSX
//   --skip-github        don't create the GitHub release
//   --allow-dirty        skip the clean-tree / pushed-to-origin checks
//   --dry-run            build and package, but publish nothing
//   -y, --yes            don't ask for confirmation before publishing
//
// Tokens are read from the terminal without echo. To feed them from a password
// manager instead, set VSCE_PAT and OVSX_PAT in the environment, e.g.
// VSCE_PAT="$(op read op://...)" npm run release

import {spawnSync} from 'node:child_process';
import {mkdirSync, readFileSync, rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {createInterface} from 'node:readline/promises';
import {fileURLToPath} from 'node:url';
import {parseArgs} from 'node:util';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);

const color = process.stdout.isTTY;
const bold = s => (color ? `\x1b[1m${s}\x1b[0m` : s);
const red = s => (color ? `\x1b[31m${s}\x1b[0m` : s);
const green = s => (color ? `\x1b[32m${s}\x1b[0m` : s);
const step = msg => console.log(`\n${bold(`==> ${msg}`)}`);

class ReleaseError extends Error {}
const die = msg => {
  throw new ReleaseError(msg);
};

let options;
try {
  ({values: options} = parseArgs({
    options: {
      'skip-marketplace': {type: 'boolean', default: false},
      'skip-openvsx': {type: 'boolean', default: false},
      'skip-github': {type: 'boolean', default: false},
      'allow-dirty': {type: 'boolean', default: false},
      'dry-run': {type: 'boolean', default: false},
      yes: {type: 'boolean', short: 'y', default: false},
      help: {type: 'boolean', short: 'h', default: false},
    },
  }));
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

if (options.help) {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const header = source.split('\n').slice(1, 16);
  console.log(header.map(line => line.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

const marketplace = !options['skip-marketplace'];
const openvsx = !options['skip-openvsx'];
const github = !options['skip-github'];
const dryRun = options['dry-run'];

// Tokens are kept out of process.env so child processes only see the one
// they need.
const tokens = {
  vsce: process.env.VSCE_PAT ?? '',
  ovsx: process.env.OVSX_PAT ?? '',
};
delete process.env.VSCE_PAT;
delete process.env.OVSX_PAT;

/** Run a command, inheriting stdio; throws if it exits non-zero. */
function run(cmd, args, {env = {}, label} = {}) {
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    env: {...process.env, ...env},
  });
  if (result.error) die(`could not run ${cmd}: ${result.error.message}`);
  if (result.status !== 0) {
    die(
      `${label ?? `${cmd} ${args[0] ?? ''}`} exited with code ${result.status}`
    );
  }
}

/** Run a command and return its trimmed stdout, or null if it fails. */
function capture(cmd, args) {
  const result = spawnSync(cmd, args, {encoding: 'utf8'});
  return result.status === 0 ? result.stdout.trim() : null;
}

/** npm through the npm that runs this script, so Windows needs no shell. */
function npm(...args) {
  const npmCli = process.env.npm_execpath;
  const label = `npm ${args.join(' ')}`;
  if (npmCli) return run(process.execPath, [npmCli, ...args], {label});
  return run('npm', args, {label});
}

/** Run a CLI from node_modules through node. Resolved lazily: `npm ci` reinstalls it. */
function nodeBin(pkg, name, args, env) {
  const require = createRequire(path.join(root, 'package.json'));
  const manifestPath = require.resolve(`${pkg}/package.json`);
  const {bin} = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const entry = typeof bin === 'string' ? bin : bin[name];
  return run(
    process.execPath,
    [path.join(path.dirname(manifestPath), entry), ...args],
    {
      env,
      label: `${name} ${args[0]}`,
    }
  );
}
const vsce = (args, env) => nodeBin('@vscode/vsce', 'vsce', args, env);
const ovsx = (args, env) => nodeBin('ovsx', 'ovsx', args, env);

/** Read a line from the terminal without echoing it. */
function readSecret(prompt) {
  const {stdin, stdout} = process;
  if (!stdin.isTTY)
    die(`no terminal to read the ${prompt} from; set it in the environment`);
  return new Promise((resolve, reject) => {
    let value = '';
    stdout.write(`${prompt}: `);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const finish = (err, result) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      stdout.write('\n');
      err ? reject(err) : resolve(result);
    };
    const onData = chunk => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          return value
            ? finish(null, value)
            : finish(new ReleaseError(`the ${prompt} is empty`));
        } else if (ch === '\u0003') {
          return finish(new ReleaseError('aborted'));
        } else if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1);
        } else if (ch >= ' ') {
          value += ch;
        }
      }
    };
    stdin.on('data', onData);
  });
}

async function confirm(question) {
  if (options.yes) return true;
  const rl = createInterface({input: process.stdin, output: process.stdout});
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function main() {
  step('Checking preconditions');
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 22)
    die(`Node.js 22 or newer is required (found ${process.version})`);
  const {name, version, publisher} = JSON.parse(
    readFileSync('package.json', 'utf8')
  );
  const vsix = path.join('dist', `${name}-${version}.vsix`);
  console.log(`Releasing ${name} ${version}`);

  const changelog = readFileSync('CHANGELOG.md', 'utf8');
  const heading = changelog.match(
    new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\](.*)$`, 'm')
  );
  if (!heading) die(`CHANGELOG.md has no '## [${version}]' entry`);
  if (/unreleased/i.test(heading[1])) {
    if (!dryRun)
      die(
        `CHANGELOG.md still marks ${version} as Unreleased; set the release date`
      );
    console.log(`warning: CHANGELOG.md still marks ${version} as Unreleased`);
  }

  if (!options['allow-dirty']) {
    if (
      capture('git', ['status', '--porcelain', '--untracked-files=no']) !== ''
    ) {
      die(
        'working tree has uncommitted changes (use --allow-dirty to override)'
      );
    }
    run('git', ['fetch', '--quiet', 'origin']);
    const head = capture('git', ['rev-parse', 'HEAD']);
    if (!capture('git', ['branch', '-r', '--contains', head])) {
      die(
        `HEAD ${head} is not pushed to origin (use --allow-dirty to override)`
      );
    }
    const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (
      branch !== 'master' &&
      !(await confirm(`You are on '${branch}', not master. Continue?`))
    ) {
      return 1;
    }
  }

  if (github && !dryRun) {
    if (capture('gh', ['--version']) === null) {
      die(
        'the GitHub CLI (gh) is required for the release (or pass --skip-github)'
      );
    }
    if (capture('gh', ['auth', 'status']) === null) {
      die("gh is not logged in; run 'gh auth login' (or pass --skip-github)");
    }
  }

  // Ask for all tokens up front and verify them before the slow build, so a
  // typo doesn't surface after half the registries are already published.
  if (!dryRun) {
    step('Reading deployment tokens');
    if (marketplace) {
      tokens.vsce ||= await readSecret('Visual Studio Marketplace PAT');
      vsce(['verify-pat', publisher], {VSCE_PAT: tokens.vsce});
    }
    if (openvsx) {
      tokens.ovsx ||= await readSecret('Open VSX access token');
      ovsx(['verify-pat', publisher], {OVSX_PAT: tokens.ovsx});
    }
  }

  step('Installing dependencies');
  npm('ci');

  step('Building');
  npm('run', 'build');

  step(`Packaging ${vsix}`);
  mkdirSync('dist', {recursive: true});
  rmSync(vsix, {force: true});
  vsce(['package', '--out', vsix]);

  if (dryRun) {
    console.log(`\n${green(`Dry run: packaged ${vsix}, nothing published.`)}`);
    return 0;
  }

  const targets = [
    marketplace && 'Visual Studio Marketplace',
    openvsx && 'Open VSX',
    github && `GitHub release ${version}`,
  ].filter(Boolean);
  if (targets.length === 0) die('nothing to publish');
  console.log(
    `\nAbout to publish ${vsix} to:\n${targets.map(t => `  - ${t}`).join('\n')}`
  );
  if (!(await confirm('Proceed?'))) return 1;

  if (marketplace) {
    step('Publishing to the Visual Studio Marketplace');
    vsce(['publish', '--skip-duplicate', '--packagePath', vsix], {
      VSCE_PAT: tokens.vsce,
    });
  }

  if (openvsx) {
    step('Publishing to Open VSX');
    ovsx(['publish', '--skip-duplicate', '--packagePath', vsix], {
      OVSX_PAT: tokens.ovsx,
    });
  }

  if (github) {
    step(`Creating GitHub release ${version}`);
    if (capture('gh', ['release', 'view', version]) !== null) {
      console.log(
        `Release ${version} already exists; uploading the .vsix to it`
      );
      run('gh', ['release', 'upload', version, vsix, '--clobber']);
    } else {
      const head = capture('git', ['rev-parse', 'HEAD']);
      run('gh', [
        'release',
        'create',
        version,
        vsix,
        '--target',
        head,
        '--title',
        version,
        '--notes',
        `Publish ${version}`,
      ]);
    }
  }

  console.log(`\n${green(`Released ${name} ${version}.`)}`);
  return 0;
}

try {
  process.exitCode = await main();
} catch (e) {
  if (!(e instanceof ReleaseError)) throw e;
  console.error(`${red('error:')} ${e.message}`);
  process.exitCode = 1;
}
