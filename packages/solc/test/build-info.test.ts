import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {loadBuildInfo} from '../src/index.js';

/** Parse a JSON fixture from `test/fixtures`. */
function loadFixture(name: string): unknown {
  const url = new URL(`./fixtures/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as unknown;
}

describe('fixture resolution', () => {
  it('reads the real build-info fixture', () => {
    const json = loadFixture('counter-build-info.json') as {solcVersion: string};
    expect(json.solcVersion).toBe('0.8.35');
  });
});

describe('loadBuildInfo / CompilationUnit', () => {
  const cu = () => loadBuildInfo(loadFixture('counter-build-info.json'));

  it('exposes the solc version from the build-info', () => {
    expect(cu().solcVersion).toBe('0.8.35');
  });

  it('lists exactly the one source file with id 0 and path src/Counter.sol', () => {
    const sources = cu().sources();
    expect(sources).toHaveLength(1);
    expect(sources[0]!.id).toBe(0);
    expect(sources[0]!.path).toBe('src/Counter.sol');
  });

  it('resolves sourceById(0) to src/Counter.sol with its source content', () => {
    const file = cu().sourceById(0);
    expect(file).toBeDefined();
    expect(file!.id).toBe(0);
    expect(file!.path).toBe('src/Counter.sol');
    expect(file!.content).toContain('contract Counter {');
    expect(file!.content).toContain('function increment() public');
  });

  it('returns undefined for an unknown source id', () => {
    expect(cu().sourceById(99)).toBeUndefined();
  });

  it('lists exactly the one contract Counter', () => {
    const contracts = cu().contracts();
    expect(contracts).toHaveLength(1);
    expect(contracts[0]!.name).toBe('Counter');
    expect(contracts[0]!.sourcePath).toBe('src/Counter.sol');
  });

  it('resolves contract(sourcePath, name) to the Counter contract', () => {
    const c = cu().contract('src/Counter.sol', 'Counter');
    expect(c).toBeDefined();
    expect(c!.name).toBe('Counter');
    expect(c!.sourcePath).toBe('src/Counter.sol');
  });

  it('returns undefined for an unknown contract', () => {
    expect(cu().contract('src/Counter.sol', 'Nope')).toBeUndefined();
    expect(cu().contract('src/Other.sol', 'Counter')).toBeUndefined();
  });
});

describe('Contract bytecode accessors', () => {
  const json = () => loadFixture('counter-build-info.json') as {
    output: {
      contracts: Record<
        string,
        Record<
          string,
          {
            evm: {
              bytecode: {object: string};
              deployedBytecode: {object: string};
            };
          }
        >
      >;
    };
  };
  const contract = () =>
    loadBuildInfo(loadFixture('counter-build-info.json')).contract(
      'src/Counter.sol',
      'Counter',
    )!;

  it('returns 0x-prefixed init bytecode equal to evm.bytecode.object', () => {
    const raw = json().output.contracts['src/Counter.sol']!['Counter']!.evm
      .bytecode.object;
    const init = contract().initBytecode();
    expect(init.startsWith('0x')).toBe(true);
    expect(init.slice(2).toLowerCase()).toBe(raw.toLowerCase());
  });

  it('returns 0x-prefixed runtime bytecode equal to evm.deployedBytecode.object', () => {
    const raw = json().output.contracts['src/Counter.sol']!['Counter']!.evm
      .deployedBytecode.object;
    const runtime = contract().runtimeBytecode();
    expect(runtime.startsWith('0x')).toBe(true);
    expect(runtime.slice(2).toLowerCase()).toBe(raw.toLowerCase());
    // Known runtime opcode prefix: PUSH1 0x80 PUSH1 0x40 MSTORE ...
    expect(runtime.slice(0, 12).toLowerCase()).toBe('0x6080604052');
  });
});

describe('Contract.storageLayout', () => {
  const contract = () =>
    loadBuildInfo(loadFixture('counter-build-info.json')).contract(
      'src/Counter.sol',
      'Counter',
    )!;

  it('returns the single "number" slot', () => {
    const layout = contract().storageLayout();
    expect(layout).toHaveLength(1);
    const entry = layout[0]!;
    expect(entry.astId).toBe(3);
    expect(entry.label).toBe('number');
    expect(entry.offset).toBe(0);
    expect(entry.slot).toBe('0');
    expect(entry.type).toBe('t_uint256');
    expect(entry.contract).toBe('src/Counter.sol:Counter');
  });
});

// ## CompilationUnit.optimizer() from input.settings.optimizer

describe('CompilationUnit.optimizer', () => {
  const callerCU = () =>
    loadBuildInfo(loadFixture('caller-unopt-build-info.json'));
  const calleeCU = () =>
    loadBuildInfo(loadFixture('callee-opt-build-info.json'));

  it('reports the caller build-info as unoptimized (enabled === false)', () => {
    expect(callerCU().optimizer().enabled).toBe(false);
  });

  it('reports the callee build-info as optimized with runs === 200', () => {
    const opt = calleeCU().optimizer();
    expect(opt.enabled).toBe(true);
    expect(opt.runs).toBe(200);
  });

  it('defaults to {enabled:false} when input.settings.optimizer is absent', () => {
    // An absent optimizer section must not throw and defaults to disabled.
    const opt = loadBuildInfo({
      solcVersion: '0.8.35',
      input: {sources: {}, settings: {}},
      output: {sources: {}, contracts: {}},
    }).optimizer();
    expect(opt.enabled).toBe(false);
  });
});

describe('Contract.storageType', () => {
  const contract = () =>
    loadBuildInfo(loadFixture('counter-build-info.json')).contract(
      'src/Counter.sol',
      'Counter',
    )!;

  it('resolves t_uint256 with numberOfBytes coerced to a number', () => {
    const type = contract().storageType('t_uint256');
    expect(type).toEqual({
      label: 'uint256',
      numberOfBytes: 32,
      encoding: 'inplace',
    });
  });

  it('returns undefined for an unknown type id', () => {
    expect(contract().storageType('t_nope')).toBeUndefined();
  });
});
