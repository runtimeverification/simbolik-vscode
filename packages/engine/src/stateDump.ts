/**
 * Parse an `anvil_dumpState` result into a normalized pre-state snapshot.
 *
 * `anvil_dumpState` returns the FULL chain state in one call, letting the
 * resolver seed a traced transaction's pre-state (code + storage a prior tx like
 * `setUp()` wrote and the trace only reads) with a SINGLE request instead of
 * one `eth_getCode` per contract plus one `eth_getStorageAt` per storage slot.
 *
 * Two wire formats exist and BOTH are handled here (the caller does not need to
 * know which node it is talking to):
 *   - **kontrol-node**: the result is a raw JSON object
 *     `{accounts: {<addr>: {code, nonce, balance, storage}}}`. Storage values are
 *     MINIMAL hex; `nonce` is a number.
 *   - **anvil**: the result is a `0x`-prefixed, gzip-compressed hex string of the
 *     same JSON. Storage values are 32-byte PADDED hex; `nonce` is a string.
 *
 * The parser flattens both to the same {@link StateDump}: addresses lowercased,
 * storage keys and values normalized to MINIMAL hex (`0x` + `BigInt(...)` in
 * base 16 — the exact form the trace's SSTORE deltas and the session's storage
 * lookup use, so a later SSTORE to a seeded slot overwrites it cleanly), and
 * zero-valued slots dropped (an absent slot already reads as zero). Returns
 * `undefined` for anything it cannot parse (unsupported node, malformed blob) so
 * the caller can fall back to the per-slot path.
 */
import {gunzipSync} from 'node:zlib';

import type {Hex} from '@simbolik/protocol';

/** One account from a parsed state dump. */
export interface DumpedAccount {
  /** Runtime bytecode (`0x` when the account is an EOA / has none). */
  code: Hex;
  nonce: number;
  balance: Hex;
  /** slot(minimal hex) → value(minimal hex); zero-valued slots omitted. */
  storage: Record<string, Hex>;
}

/** A normalized whole-chain state snapshot keyed by lowercase address. */
export interface StateDump {
  accounts: Record<string, DumpedAccount>;
}

/** Coerce a nonce that may arrive as a number or a decimal/hex string. */
function toNonce(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const n = Number(value.startsWith('0x') ? BigInt(value) : value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** `'0x'` + `value` in minimal hex, or `undefined` if it is not a hex scalar. */
function minimalHex(value: string): Hex | undefined {
  try {
    return `0x${BigInt(value.startsWith('0x') ? value : `0x${value}`).toString(16)}`;
  } catch {
    return undefined;
  }
}

/**
 * Parse a raw `anvil_dumpState` result (JSON object OR gzip-hex string) into a
 * normalized {@link StateDump}, or `undefined` if it cannot be parsed.
 */
export function parseStateDump(rawResult: unknown): StateDump | undefined {
  let root: unknown = rawResult;

  // anvil: a `0x`-prefixed gzip-compressed hex blob of the JSON.
  if (typeof rawResult === 'string') {
    try {
      const hex = rawResult.startsWith('0x') ? rawResult.slice(2) : rawResult;
      root = JSON.parse(gunzipSync(Buffer.from(hex, 'hex')).toString('utf8'));
    } catch {
      return undefined;
    }
  }

  if (root === null || typeof root !== 'object') return undefined;
  const accountsRaw = (root as {accounts?: unknown}).accounts;
  if (accountsRaw === null || typeof accountsRaw !== 'object') return undefined;

  const accounts: Record<string, DumpedAccount> = {};
  for (const [addr, accRaw] of Object.entries(
    accountsRaw as Record<string, unknown>,
  )) {
    if (accRaw === null || typeof accRaw !== 'object') continue;
    const acc = accRaw as {
      code?: unknown;
      nonce?: unknown;
      balance?: unknown;
      storage?: unknown;
    };

    const storage: Record<string, Hex> = {};
    if (acc.storage !== null && typeof acc.storage === 'object') {
      for (const [slot, val] of Object.entries(
        acc.storage as Record<string, unknown>,
      )) {
        if (typeof val !== 'string') continue;
        const key = minimalHex(slot);
        const value = minimalHex(val);
        if (key === undefined || value === undefined || value === '0x0') continue;
        storage[key] = value;
      }
    }

    accounts[addr.toLowerCase()] = {
      code: typeof acc.code === 'string' ? (acc.code as Hex) : '0x',
      nonce: toNonce(acc.nonce),
      balance: typeof acc.balance === 'string' ? (acc.balance as Hex) : '0x0',
      storage,
    };
  }

  return {accounts};
}
