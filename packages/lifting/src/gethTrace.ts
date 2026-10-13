/**
 * geth/anvil trace factory — lift a generic Ethereum node's
 * `debug_traceTransaction` output (the "geth" struct-logger dialect) into the
 * same positional `Step[]` model that `normalizeKontrolTrace` produces, so the
 * whole downstream pipeline (StateCursor → ethdebug → variables/stepping) works
 * on either dialect unchanged.
 *
 * The geth dialect is intentionally lean: each structLog carries only
 * `{pc, op, gas, gasCost, depth, stack, storage?, refund}` — no per-step code
 * address, sender, calldata, memory, or delta fields. The transaction itself
 * ({@link GethTraceContext}) seeds the top-level frame, and the executing code
 * address of every deeper CALL/CREATE frame is reconstructed by driving a frame
 * stack off the `depth` transitions in the trace (see {@link normalizeGethTrace}).
 * A single-frame (depth-1) trace never pushes a frame, so every step simply runs
 * the tx's `to` as its code address.
 */
import type {Hex} from '@simbolik/protocol';

import type {Step} from './step.js';

/** The transaction context a geth trace lacks per-step; supplied from the tx. */
export type GethTraceContext = {
  to: string;
  from: string;
  input: string;
  value?: string;
};

/** One geth struct-logger entry (lean; rich kontrol fields absent). */
interface GethStructLog {
  pc: number;
  op: string;
  gas: number;
  depth: number;
  stack?: Hex[];
  /** 32-byte-padded slot-hex → 32-byte value-hex; only on storage-touching steps. */
  storage?: Record<string, string>;
}

/** A geth `debug_traceTransaction` envelope (the `.result` object). */
interface GethTrace {
  structLogs: GethStructLog[];
}

/** Minimal hex form of a scalar: `'0x'+BigInt(x).toString(16)` (no padding). */
function minimalHex(value: string): Hex {
  return `0x${BigInt(value).toString(16)}`;
}

/**
 * A 40-nibble, zero-padded, lowercase account key — the exact form the debugger
 * looks accounts up by (`addressHex(codeAddress)`), and what the kontrol dialect
 * emits. Minimal hex would drop a leading zero byte, so the map key would no
 * longer equal the padded lookup key and storage would silently read as absent.
 */
function accountKey(addr: bigint): string {
  return `0x${addr.toString(16).padStart(40, '0')}`;
}

/**
 * One reconstructed EVM call frame. The geth dialect carries no per-step code
 * address, so we rebuild the executing context from CALL-family opcodes + depth.
 * - `code`    = the executing contract (→ Step.codeAddress).
 * - `storage` = the account whose storage this frame reads/writes (→ targetAddress).
 * - `sender`  = msg.sender for this frame (→ Step.msgSender).
 */
interface Frame {
  code: bigint;
  storage: bigint;
  sender: bigint;
  /** `true` while this frame runs a contract's CREATE/CREATE2 *init* code. */
  initCode: boolean;
}

/**
 * Classify a trace envelope's dialect by inspecting its first structLog: the
 * rich kontrol dialect carries `isInitCode`/`codeAddress` fields, the geth
 * dialect does not. Guards an empty/absent `structLogs` (a degenerate trace has
 * no first log to inspect) → 'geth', never throwing.
 */
export function detectTraceDialect(envelope: unknown): 'kontrol' | 'geth' {
  // A null/undefined or non-object envelope (a node error, an unexpected shape)
  // has no structLogs to inspect — treat as the lean dialect rather than throw.
  if (envelope === null || typeof envelope !== 'object') {
    return 'geth';
  }
  const logs = (envelope as {structLogs?: unknown}).structLogs;
  const first = Array.isArray(logs) ? logs[0] : undefined;
  if (first !== null && typeof first === 'object') {
    if ('isInitCode' in first || 'codeAddress' in first) {
      return 'kontrol';
    }
  }
  return 'geth';
}

/**
 * Map each step index where a CREATE/CREATE2 frame begins to the address that
 * frame ultimately deploys. The EVM pushes the new address onto the creator's
 * stack when the frame returns, so we read the creator's stack top on the step
 * where depth drops back to the creator. Mirrors the frame stack's push/pop by
 * depth transitions (one marker per push; the `-1` marker tags non-create frames
 * so pops stay aligned). A zero result (CREATE failed) is not recorded.
 */
function createdAddressByBeginStep(logs: GethStructLog[]): Map<number, bigint> {
  const created = new Map<number, bigint>();
  const open: number[] = []; // begin-index per open frame (-1 = not a create)
  for (let i = 0; i < logs.length; i++) {
    const dCur = logs[i]!.depth;
    const dPrev = i === 0 ? 1 : logs[i - 1]!.depth;
    if (dCur > dPrev) {
      const op = logs[i - 1]!.op;
      open.push(op === 'CREATE' || op === 'CREATE2' ? i : -1);
    } else if (dCur < dPrev) {
      for (let p = 0; p < dPrev - dCur && open.length > 0; p++) {
        const begin = open.pop()!;
        // Only the outermost unwound frame lands back on this step; deeper pops
        // in the same transition returned earlier. geth drops depth by one per
        // step, so in practice `dPrev - dCur` is 1 and `begin` is that frame.
        if (begin >= 0) {
          const st = logs[i]!.stack ?? [];
          const topHex = st.length > 0 ? st[st.length - 1] : undefined;
          if (topHex !== undefined) {
            const addr = BigInt(topHex);
            if (addr !== 0n) created.set(begin, addr);
          }
        }
      }
    }
  }
  return created;
}

/**
 * The frame entered by the CALL-family op `prev` (the log just before a depth
 * increase), run from `caller`. `created` is the address a CREATE/CREATE2 frame
 * deploys, when {@link createdAddressByBeginStep} recovered it.
 */
function enteredFrame(
  prev: GethStructLog,
  caller: Frame,
  created: bigint | undefined,
): Frame {
  // Callee is `stack[len-2]` (top of stack last). Guard a malformed stack (a
  // call op with <2 items): fall back to best-effort.
  const prevStack = prev.stack ?? [];
  const calleeHex =
    prevStack.length >= 2 ? prevStack[prevStack.length - 2] : undefined;
  const callee = calleeHex !== undefined ? BigInt(calleeHex) : caller.code;

  switch (prev.op) {
    case 'CALLCODE':
      // Runs callee code on the caller's storage; msg.sender = caller code.
      return {code: callee, storage: caller.storage, sender: caller.code, initCode: false};
    case 'DELEGATECALL':
      // Runs callee code on caller storage, preserving the caller's sender.
      return {code: callee, storage: caller.storage, sender: caller.sender, initCode: false};
    case 'CREATE':
    case 'CREATE2':
      // The running code is the constructor's init bytecode. Its address is
      // not on the stack before execution; the pre-pass recovers it from the
      // frame's return, so the debugger can identify the contract and resolve
      // these steps against its init source map (`initCode` selects that map).
      // Fall back to the creator's address only if the address is unknown.
      return {
        code: created ?? caller.code,
        storage: created ?? caller.storage,
        sender: caller.code,
        initCode: true,
      };
    default:
      // CALL / STATICCALL: runs callee code on callee storage; msg.sender = the
      // caller's code. An unrecognized op that still increased depth (shouldn't
      // happen for a well-formed trace) is treated the same, with the
      // best-effort stack callee. CREATE/CREATE2 are handled above, so this
      // never turns a memory offset into a code address.
      return {code: callee, storage: callee, sender: caller.code, initCode: false};
  }
}

/**
 * Normalize a geth/anvil trace into a positional `Step[]`, in the same shape
 * `normalizeKontrolTrace` yields. One Step per structLog; the tx context fills
 * in the fields geth omits per-step.
 */
export function normalizeGethTrace(
  envelope: unknown,
  ctx: GethTraceContext,
): Step[] {
  const to = BigInt(ctx.to);
  const from = BigInt(ctx.from);
  const value = BigInt(ctx.value ?? 0);
  const input = ctx.input as Hex;

  const logs = (envelope as GethTrace).structLogs;

  // ## Multi-frame reconstruction
  // The geth dialect has no per-step codeAddress. Rebuild the executing context
  // by driving a frame stack off actual `depth` transitions (a call to an
  // EOA/precompile does not increase depth, so we key on depth, not the op).
  // Frame 0 is the top-level tx frame; txOrigin is the tx's `from` throughout.
  // A depth-1-only trace never pushes or pops, so every step runs {to,to,from}.

  // Pre-pass: the address a CREATE/CREATE2 deploys is not known until the frame
  // returns (the EVM pushes it onto the creator's stack). Recording it per
  // create-frame begin step gives constructor frames their real code address,
  // so their init code resolves to the created contract.
  const createdAt = createdAddressByBeginStep(logs);

  const stack: Frame[] = [{code: to, storage: to, sender: from, initCode: false}];

  return logs.map((log, index): Step => {
    const dCur = log.depth;
    const dPrev = index === 0 ? 1 : logs[index - 1]!.depth;

    if (dCur > dPrev) {
      // Entered a call: the previous log was the CALL-family op. The pushed frame
      // applies from this step on; the CALL op itself (i-1) stays in the caller
      // frame.
      stack.push(
        enteredFrame(logs[index - 1]!, stack[stack.length - 1]!, createdAt.get(index)),
      );
    } else if (dCur < dPrev) {
      // Returned: pop one frame per depth level unwound (guard underflow).
      const pops = dPrev - dCur;
      for (let p = 0; p < pops && stack.length > 1; p += 1) stack.pop();
    }

    const top = stack[stack.length - 1]!;

    // Storage: geth emits cumulative touched slots for the currently executing
    // contract as 32-byte-padded keys/values; minimalize both so `machineStateFor`'s
    // `'0x'+slot.asUint().toString(16)` lookup matches, and key the account under
    // the top frame's storage address (not always ctx.to) so callee-frame storage
    // is attributed to the callee.
    let storageChanges: Record<string, Record<string, Hex>> = {};
    if (log.storage !== undefined) {
      const slots: Record<string, Hex> = {};
      for (const [rawSlot, rawVal] of Object.entries(log.storage)) {
        slots[minimalHex(rawSlot)] = minimalHex(rawVal);
      }
      storageChanges = {[accountKey(top.storage)]: slots};
    }

    return {
      index,
      pc: log.pc,
      op: log.op,
      depth: log.depth,
      gas: log.gas,
      isInitCode: top.initCode,
      codeAddress: top.code,
      targetAddress: top.storage,
      msgSender: top.sender,
      msgValue: value,
      txOrigin: from,
      statusCode: 'EVMC_SUCCESS',
      stack: log.stack ?? [],
      // geth omits memory; calldata is introduced once on step 0 then carried
      // forward by StateCursor. Program/returndata are not delta-encoded here.
      memoryChange: null,
      programChange: null,
      callDataChange: index === 0 ? input : null,
      returnDataChange: null,
      storageChanges,
      balanceChanges: {},
      nonceChanges: {},
      deployedCodeChanges: {},
      initCodeChanges: {},
    };
  });
}
