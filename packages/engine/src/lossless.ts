import {parse, isInteger, isSafeNumber} from 'lossless-json';

/**
 * Parse a numeric JSON token to `number` when it round-trips safely, or to
 * `bigint` when it is an integer that would lose precision as an IEEE-754
 * double. This is what keeps kontrol-node's decimal 160-bit addresses and
 * 256-bit values intact (see @simbolik/protocol KontrolStructLog precision note).
 */
function parseNumberOrBigInt(value: string): number | bigint {
  if (isInteger(value) && !isSafeNumber(value, {approx: false})) {
    return BigInt(value);
  }
  return Number(value);
}

/**
 * Lossless replacement for `JSON.parse`. Large integer literals become
 * `bigint`; everything else parses as normal JSON. Use this for every
 * kontrol-node RPC response — plain `JSON.parse` silently corrupts the trace.
 */
export function parseJsonLossless(text: string): unknown {
  return parse(text, undefined, parseNumberOrBigInt);
}
