/**
 * Value-type decoding + storage packing + EVM scope.
 *
 * Drives `SolidityDebugSession` against the REAL recorded
 * `Vars.setAll(7, 1000, true, 0x..aa, -5, 0x1122.., Blue)` trace (570 steps,
 * unoptimized solc 0.8.35). The debugger must:
 *   - expose THREE scopes: State, Locals, EVM (in that order);
 *   - decode every storage value type from the packed layout (uint8/uint16/bool
 *     packed in slot 0, int256, bytes32, enum member name);
 *   - decode the calldata value-type params as Locals;
 *   - expose a raw EVM scope (pc + storage word view).
 *
 * All ground-truth values below were verified against the real trace +
 * build-info fixtures (terminal step 569, pc 315 STOP; slot0 packed word
 * `0x…aa0103e807`).
 */
import {readFileSync} from 'node:fs';

import {describe, expect, it} from 'vitest';

import {SolidityDebugSession, type LaunchInputs} from '../src/index.js';

// ---------------------------------------------------------------------------
// Fixtures + LaunchInputs helper
// ---------------------------------------------------------------------------

const TRACE_RAW = readFileSync(
  new URL('./fixtures/vars-setall-trace.raw.json', import.meta.url),
  'utf8',
);

const BUILD_INFO_JSON: unknown = JSON.parse(
  readFileSync(
    new URL('../../solc/test/fixtures/vars-build-info.json', import.meta.url),
    'utf8',
  ),
);

const META = JSON.parse(
  readFileSync(
    new URL('./fixtures/vars-setall-meta.json', import.meta.url),
    'utf8',
  ),
) as {contractAddress: string};

const CODE_ADDRESS = META.contractAddress;

/** The confirmed packed word committed to slot 0 at the terminal step. */
const SLOT0_WORD =
  '0x00000000000000000000000000000000000000000000000000000000aa0103e807';

function launchInputs(): LaunchInputs {
  return {
    buildInfoJson: BUILD_INFO_JSON,
    traceJson: TRACE_RAW,
    sourcePath: 'src/Vars.sol',
    contractName: 'Vars',
    methodName: 'setAll',
    codeAddress: CODE_ADDRESS,
  };
}

/** Launch a fresh session positioned at entry. */
async function launchedSession(): Promise<SolidityDebugSession> {
  const session = new SolidityDebugSession();
  await session.launch(launchInputs());
  return session;
}

/**
 * The scope refs for the single frame, by name. `evmRef` is optional so the
 * State/Locals decode tests surface decoding failures independently of whether
 * the EVM scope is present.
 */
function scopeRefs(session: SolidityDebugSession): {
  stateRef: number;
  localsRef: number;
  evmRef: number;
} {
  const frameId = session.stackTrace().stackFrames[0]!.id;
  const {scopes} = session.scopes(frameId);
  return {
    stateRef: scopes.find((s) => s.name === 'State')!.variablesReference,
    localsRef: scopes.find((s) => s.name === 'Locals')!.variablesReference,
    evmRef: scopes.find((s) => s.name === 'EVM')?.variablesReference ?? -1,
  };
}

/** Normalize a hex-word to lowercase with no `0x` and no leading zeros. */
function normHex(value: string): string {
  return value.replace(/^0x/i, '').toLowerCase().replace(/^0+/, '');
}

// ---------------------------------------------------------------------------
// 1. scopes — now THREE: State, Locals, EVM
// ---------------------------------------------------------------------------

describe('SolidityDebugSession.scopes (includes EVM)', () => {
  it('returns State, Locals, EVM in order with distinct positive refs', async () => {
    const session = await launchedSession();
    const frameId = session.stackTrace().stackFrames[0]!.id;
    const {scopes} = session.scopes(frameId);

    expect(scopes).toHaveLength(5);
    expect(scopes.map((s) => s.name)).toEqual([
      'Locals',
      'State',
      'Globals',
      'Events',
      'EVM',
    ]);

    const refs = scopes.map((s) => s.variablesReference);
    for (const ref of refs) {
      expect(ref).toBeGreaterThan(0);
    }
    expect(new Set(refs).size).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// 2. variables(State) — all 7 value types, decoded from packed storage
// ---------------------------------------------------------------------------

describe('SolidityDebugSession.variables(State) — value-type decoding', () => {
  /** Reach the terminal step (all storage committed), then read State. */
  async function terminalState(): Promise<DebugProtocolVariable[]> {
    const session = await launchedSession();
    await session.continue(); // no breakpoints → run to terminal
    const {stateRef} = scopeRefs(session);
    const {variables} = await session.variables(stateRef);
    return variables as DebugProtocolVariable[];
  }

  it('exposes the 7 storage vars in storageLayout order', async () => {
    const vars = await terminalState();
    expect(vars.map((v) => v.name)).toEqual([
      'a',
      'b',
      'flag',
      'owner',
      'delta',
      'h',
      'color',
    ]);
  });

  it('decodes packed uint8 a = 7', async () => {
    const a = (await terminalState()).find((v) => v.name === 'a')!;
    expect(a.value).toBe('7');
    expect(a.type).toBe('uint8');
  });

  it('decodes packed uint16 b = 1000 (offset 1, len 2 → shift/mask)', async () => {
    const b = (await terminalState()).find((v) => v.name === 'b')!;
    expect(b.value).toBe('1000');
    expect(b.type).toBe('uint16');
  });

  it('decodes packed bool flag = true', async () => {
    const flag = (await terminalState()).find((v) => v.name === 'flag')!;
    expect(flag.value).toBe('true');
    expect(flag.type).toBe('bool');
  });

  it('decodes packed address owner = 0x..aa', async () => {
    const owner = (await terminalState()).find((v) => v.name === 'owner')!;
    expect(owner.value).toBe(
      '0x00000000000000000000000000000000000000aa',
    );
    expect(owner.type).toBe('address');
  });

  it('decodes signed int256 delta = -5 (two’s complement)', async () => {
    const delta = (await terminalState()).find((v) => v.name === 'delta')!;
    expect(delta.value).toBe('-5');
    expect(delta.type).toBe('int256');
  });

  it('decodes bytes32 h as the full 32-byte word', async () => {
    const h = (await terminalState()).find((v) => v.name === 'h')!;
    expect(h.value).toBe(
      '0x1122334455667788990011223344556677889900112233445566778899001122',
    );
    expect(h.type).toBe('bytes32');
  });

  it('decodes enum color to its member NAME (Blue)', async () => {
    const color = (await terminalState()).find((v) => v.name === 'color')!;
    expect(color.value).toBe('Blue');
    // Type is the enum simple name; accept either `Color` or `enum Vars.Color`.
    expect(color.type).toContain('Color');
  });
});

// ---------------------------------------------------------------------------
// 3. variables(Locals) — value-type params decoded from calldata
// ---------------------------------------------------------------------------

describe('SolidityDebugSession.variables(Locals) — calldata params', () => {
  /** Locals are readable at entry: calldata is constant through the call. */
  async function entryLocals(): Promise<DebugProtocolVariable[]> {
    const session = await launchedSession();
    const {localsRef} = scopeRefs(session);
    const {variables} = await session.variables(localsRef);
    return variables as DebugProtocolVariable[];
  }

  it('decodes _a, _b, _flag, _owner, _delta by type from calldata', async () => {
    const locals = await entryLocals();
    const byName = new Map(locals.map((v) => [v.name, v]));

    expect(byName.get('_a')).toMatchObject({value: '7', type: 'uint8'});
    expect(byName.get('_b')).toMatchObject({value: '1000', type: 'uint16'});
    expect(byName.get('_flag')).toMatchObject({value: 'true', type: 'bool'});
    expect(byName.get('_owner')).toMatchObject({
      value: '0x00000000000000000000000000000000000000aa',
      type: 'address',
    });
    expect(byName.get('_delta')).toMatchObject({
      value: '-5',
      type: 'int256',
    });
  });

  it('decodes the enum param _color to member NAME (Blue)', async () => {
    const color = (await entryLocals()).find((v) => v.name === '_color')!;
    expect(color).toBeDefined();
    expect(color.value).toBe('Blue');
    expect(color.type).toContain('Color');
  });
});

// ---------------------------------------------------------------------------
// 4. variables(EVM) — raw machine state (pc + storage word view)
// ---------------------------------------------------------------------------

describe('SolidityDebugSession.variables(EVM) — raw machine scope', () => {
  /**
   * Collect the EVM scope entries plus one level of nested children (EVM
   * sub-views like `storage` may carry their own variablesReference).
   */
  async function evmEntries(
    session: SolidityDebugSession,
  ): Promise<DebugProtocolVariable[]> {
    const {evmRef} = scopeRefs(session);
    const top = (await session.variables(evmRef))
      .variables as DebugProtocolVariable[];
    const all = [...top];
    for (const entry of top) {
      if (entry.variablesReference && entry.variablesReference > 0) {
        const nested = (await session.variables(entry.variablesReference))
          .variables as DebugProtocolVariable[];
        all.push(...nested);
      }
    }
    return all;
  }

  it('exposes a numeric pc entry', async () => {
    const session = await launchedSession();
    await session.continue();
    const entries = await evmEntries(session);
    const pc = entries.find((v) => v.name === 'pc');
    expect(pc).toBeDefined();
    expect(Number.isFinite(Number(pc!.value))).toBe(true);
    // Terminal step is the STOP at pc 315.
    expect(Number(pc!.value)).toBe(315);
  });

  it('exposes slot 0 as the packed word 0x..aa0103e807 at the terminal step', async () => {
    const session = await launchedSession();
    await session.continue();
    const entries = await evmEntries(session);
    // Pragmatic: find any EVM entry whose value carries the slot-0 packed word,
    // regardless of whether it is zero-padded to a full 32-byte word.
    const wordEntry = entries.find(
      (v) => typeof v.value === 'string' && normHex(v.value) === normHex(SLOT0_WORD),
    );
    expect(wordEntry).toBeDefined();
  });

  it('exposes an expandable memory view of 32-byte words keyed by byte offset', async () => {
    const session = await launchedSession();
    await session.continue();
    const {evmRef} = scopeRefs(session);
    const top = (await session.variables(evmRef))
      .variables as DebugProtocolVariable[];

    const memory = top.find((v) => v.name === 'memory');
    expect(memory, 'EVM scope must expose a memory row').toBeDefined();
    const wordCount = Number(/^(\d+) words$/.exec(memory!.value)?.[1]);
    expect(Number.isInteger(wordCount)).toBe(true);
    // The Counter run uses memory (free pointer, hashing), so it is non-empty and
    // therefore expandable.
    expect(wordCount).toBeGreaterThan(0);
    expect(memory!.variablesReference).toBeGreaterThan(0);

    const words = (await session.variables(memory!.variablesReference!))
      .variables as DebugProtocolVariable[];
    expect(words).toHaveLength(wordCount);
    // First two rows are the standard free-memory-pointer scratch space at byte
    // offsets 0x0000 and 0x0020 (4-hex-digit, zero-padded for alignment), each a
    // full 32-byte (0x + 64 hex) word.
    expect(words[0]!.name).toBe('0x0000');
    expect(words[1]!.name).toBe('0x0020');
    for (const w of words) {
      expect(w.value).toMatch(/^0x[0-9a-f]{64}$/);
      expect(w.variablesReference).toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Focused packed-extraction pin for `b` (offset 1, len 2 → 1000)
// ---------------------------------------------------------------------------

describe('storage packed extraction pins the shift/mask for b', () => {
  it('b (offset 1, length 2) extracts to 1000 from the shared slot-0 word', async () => {
    const session = await launchedSession();
    await session.continue();
    const {stateRef} = scopeRefs(session);
    const {variables} = await session.variables(stateRef);
    const vars = variables as DebugProtocolVariable[];

    // a and b share slot 0; the packing must isolate b at byte offset 1.
    expect(vars.find((v) => v.name === 'a')!.value).toBe('7');
    expect(vars.find((v) => v.name === 'b')!.value).toBe('1000');
  });
});

/** Minimal DAP Variable shape used by the assertions above. */
interface DebugProtocolVariable {
  name: string;
  value: string;
  type?: string;
  variablesReference?: number;
}
