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
 * belongs to, by matching CBOR metadata trailers. The metadata hash uniquely
 * identifies a source+settings compilation, so this is robust to differing
 * immutable/library-address bytes. Returns `undefined` when nothing matches.
 */
export function identifyContractByRuntimeCode(
  cu: CompilationUnit,
  runtimeCode: Hex,
): Contract | undefined {
  const target = cborMetadataHash(runtimeCode);
  if (target === undefined) {
    return undefined;
  }
  for (const contract of cu.contracts()) {
    if (cborMetadataHash(contract.runtimeBytecode()) === target) {
      return contract;
    }
  }
  return undefined;
}
