import type {Hex} from '@simbolik/protocol';
import {hexToBytes} from './hex.js';

/** Jump kind of a source-map entry: into a function, out of one, or neither. */
export type Jump = 'i' | 'o' | '-';

/** One decoded solc source-map entry (`s:l:f:j:m`). */
export interface SourceMapEntry {
  /** Byte offset into the source file. */
  start: number;
  /** Byte length of the covered range. */
  length: number;
  /** Source file id (`-1` means "no associated source"). */
  fileId: number;
  /** Jump kind. */
  jump: Jump;
  /** Modifier depth. */
  modifierDepth: number;
}

/**
 * Decode solc's `;`-separated `s:l:f:j:m` source map.
 *
 * Any field may be **empty** — the empty string, or absent because trailing
 * fields were dropped — in which case it inherits from the previous entry.
 * Inheritance is by string emptiness, not numeric value: a literal `"0"` sets
 * `0` and a `"-1"` sets `-1`; only `""` (or a missing trailing field) inherits.
 */
export function parseSourceMap(sourceMap: string): SourceMapEntry[] {
  const entries: SourceMapEntry[] = [];
  let prev: SourceMapEntry = {
    start: 0,
    length: 0,
    fileId: 0,
    jump: '-',
    modifierDepth: 0,
  };
  if (sourceMap === '') {
    return entries;
  }
  for (const raw of sourceMap.split(';')) {
    const fields = raw.split(':');
    const present = (i: number): string | undefined => {
      const f = fields[i];
      return f !== undefined && f !== '' ? f : undefined;
    };
    const start = present(0);
    const length = present(1);
    const fileId = present(2);
    const jump = present(3);
    const modifierDepth = present(4);
    const entry: SourceMapEntry = {
      start: start !== undefined ? parseInt(start, 10) : prev.start,
      length: length !== undefined ? parseInt(length, 10) : prev.length,
      fileId: fileId !== undefined ? parseInt(fileId, 10) : prev.fileId,
      jump: jump !== undefined ? (jump as Jump) : prev.jump,
      modifierDepth:
        modifierDepth !== undefined
          ? parseInt(modifierDepth, 10)
          : prev.modifierDepth,
    };
    entries.push(entry);
    prev = entry;
  }
  return entries;
}

/**
 * Walk EVM bytecode and index instruction starts, skipping the immediate data
 * bytes of `PUSH1..PUSH32` (`0x60..0x7f`). The Nth instruction corresponds to
 * the Nth source-map entry. A PC pointing into push data (or past the end) is
 * absent from `pcToInstruction`.
 */
export function buildInstructionIndex(bytecode: Hex): {
  pcToInstruction: Map<number, number>;
  instructionToPc: number[];
} {
  const bytes = hexToBytes(bytecode);
  const pcToInstruction = new Map<number, number>();
  const instructionToPc: number[] = [];
  let pc = 0;
  let instruction = 0;
  while (pc < bytes.length) {
    pcToInstruction.set(pc, instruction);
    instructionToPc.push(pc);
    const op = bytes[pc]!;
    let size = 1;
    if (op >= 0x60 && op <= 0x7f) {
      size += op - 0x5f;
    }
    pc += size;
    instruction++;
  }
  return {pcToInstruction, instructionToPc};
}
