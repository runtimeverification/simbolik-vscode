import type {Hex} from '@simbolik/protocol';
import {bytesToHex, hexToBytes} from './hex.js';
import type {CompilationUnit, Contract} from './buildInfo.js';

/**
 * Extract the solc-appended CBOR metadata trailer from runtime bytecode. The
 * last two bytes (big-endian) give the CBOR blob length `L`; the trailer is the
 * final `L + 2` bytes. Returns `undefined` when the claimed length does not fit
 * in the code (so a stub like `0x6001` yields `undefined`).
 */
export function cborMetadataHash(runtimeBytecode: Hex): Hex | undefined {
  const bytes = hexToBytes(runtimeBytecode);
  if (bytes.length < 2) {
    return undefined;
  }
  const length = (bytes[bytes.length - 2]! << 8) | bytes[bytes.length - 1]!;
  const trailerLength = length + 2;
  if (trailerLength > bytes.length) {
    return undefined;
  }
  return bytesToHex(bytes.slice(bytes.length - trailerLength));
}

/**
 * Identify which contract in the compilation unit a deployed runtime code
 * belongs to. Returns `undefined` when the code cannot be attributed to exactly
 * one contract (the caller then falls back to the launch `contractName`, or
 * treats the code as foreign) — NEVER a guess, because a wrong identification
 * uses the wrong source map and silently corrupts all source/variable/stepping
 * resolution.
 *
 * Two matchers, most-reliable first:
 *  1. EXACT runtime-bytecode match. A kontrol trace carries the concrete deployed
 *     code, so an exact, unique match is definitive.
 *  2. CBOR metadata trailer, but ONLY when it uniquely identifies one contract.
 *     The trailer's IPFS/bzzr hash pins a source+settings compilation and is
 *     robust to differing immutable/library-address bytes — BUT with
 *     `bytecode_hash = "none"` (Foundry's default, and Uniswap's) it degrades to
 *     just `{solc: <version>}`, IDENTICAL across every contract that compiler
 *     produced. Matching the first such contract would return an arbitrary,
 *     usually WRONG contract (e.g. a forge-std library), so we require the
 *     trailer to match exactly one contract and otherwise give up.
 */
export function identifyContractByRuntimeCode(
  cu: CompilationUnit,
  runtimeCode: Hex,
): Contract | undefined {
  const norm = (h: Hex): string => h.toLowerCase().replace(/^0x/, '');
  const target = norm(runtimeCode);
  const contracts = cu.contracts();

  const exact = contracts.filter((c) => norm(c.runtimeBytecode()) === target);
  if (exact.length === 1) return exact[0];

  // Immutable-masked exact match: a DEPLOYED contract differs from its build-info
  // runtime code only in its immutable byte ranges (and linked-library address
  // bytes, reported the same way), which are filled at deploy time. Zeroing those
  // ranges in BOTH strings lets a contract WITH immutables (e.g. Uniswap's
  // PoolManager) still be identified when the CBOR trailer is non-discriminating
  // (bytecode_hash="none"). Same length is required (immutables never resize).
  const maskImmutables = (code: string, c: Contract): string => {
    const ranges = c.immutableRanges();
    if (ranges.length === 0) return code;
    const chars = code.split('');
    for (const {start, length} of ranges) {
      for (let i = start * 2; i < (start + length) * 2 && i < chars.length; i++) {
        chars[i] = '0';
      }
    }
    return chars.join('');
  };
  const masked = contracts.filter((c) => {
    const code = norm(c.runtimeBytecode());
    if (code.length !== target.length || c.immutableRanges().length === 0) {
      return false;
    }
    return maskImmutables(code, c) === maskImmutables(target, c);
  });
  if (masked.length === 1) return masked[0];

  const cborTarget = cborMetadataHash(runtimeCode);
  if (cborTarget === undefined) return undefined;
  const byCbor = contracts.filter(
    (c) => cborMetadataHash(c.runtimeBytecode()) === cborTarget,
  );
  return byCbor.length === 1 ? byCbor[0] : undefined;
}
