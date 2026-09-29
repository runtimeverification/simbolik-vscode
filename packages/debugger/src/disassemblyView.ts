/** The DAP `disassemble` request (the Disassembly View). */
import type {DebugProtocol} from '@vscode/debugprotocol';

import {
  contractDisassembly,
  disassemble as disassembleCode,
  resolvePosition,
  type Disassembly,
} from './contractAnalysis.js';
import {
  decodeInstructionAddress,
  encodeInstructionAddress,
} from './disassemble.js';
import {addressHex, strip0x} from './hex.js';
import type {SourceRegistry} from './sources.js';
import type {Trace} from './trace.js';

export interface DisassembleArgs {
  memoryReference: string;
  offset?: number;
  instructionOffset?: number;
  instructionCount: number;
}

/** Render `0x6080…` instruction bytes as space-separated pairs (`60 80 …`). */
function spacedHex(bytes: string): string {
  return (strip0x(bytes).match(/.{2}/g) ?? []).join(' ');
}

/**
 * Disassemble around `memoryReference`, which packs `(codeAddress, pc, isInit)`
 * (see {@link encodeInstructionAddress}): recover the contract's code image,
 * anchor at the requested pc, and return exactly `instructionCount`
 * instructions from `anchor + instructionOffset`, each carrying its source
 * location when mapped. Out-of-range positions are padded with `invalid`
 * placeholders so the count (and VSCode's paging) stays consistent at code
 * boundaries.
 */
export function disassembleView(
  trace: Trace,
  sources: SourceRegistry,
  foreignCache: Map<string, Disassembly>,
  args: DisassembleArgs
): DebugProtocol.DisassembledInstruction[] {
  const {
    codeAddress,
    pc: refPc,
    isInit,
  } = decodeInstructionAddress(args.memoryReference);
  const pc0 = refPc + (args.offset ?? 0);
  const resolution = trace.registry.contractAt(codeAddress);
  const {list, pcToIndex} =
    resolution !== undefined
      ? contractDisassembly(resolution.contract, isInit)
      : foreignDisassembly(trace, foreignCache, codeAddress);

  // Anchor = the instruction at pc0, else the last instruction starting ≤ pc0.
  let anchor = pcToIndex.get(pc0);
  if (anchor === undefined) {
    anchor = 0;
    for (let i = 0; i < list.length && list[i]!.pc <= pc0; i++) anchor = i;
  }

  const start = anchor + (args.instructionOffset ?? 0);
  const instructions: DebugProtocol.DisassembledInstruction[] = [];
  for (let k = 0; k < args.instructionCount; k++) {
    const i = start + k;
    const instr = list[i];
    if (instr === undefined) {
      // Before the first / past the last instruction — synthesize an ordered
      // address so paging stays monotonic, marked invalid.
      const firstPc = list[0]?.pc ?? 0;
      const lastPc = list.at(-1)?.pc ?? 0;
      const virtualPc = i < 0 ? firstPc + i : lastPc + (i - (list.length - 1));
      instructions.push({
        address: encodeInstructionAddress(codeAddress, virtualPc, isInit),
        instruction: '(unknown)',
        presentationHint: 'invalid',
      });
      continue;
    }
    const entry: DebugProtocol.DisassembledInstruction = {
      address: encodeInstructionAddress(codeAddress, instr.pc, isInit),
      instructionBytes: spacedHex(instr.bytes),
      instruction: instr.asm,
    };
    // Source locations only exist for a resolved contract; a foreign frame
    // shows bare instructions.
    if (resolution !== undefined) {
      const {contract, cu} = resolution;
      const pos = resolvePosition(contract, cu, instr.pc, isInit);
      const src =
        pos !== undefined ? sources.sourceFor(cu, pos.path) : undefined;
      if (pos !== undefined && src !== undefined) {
        entry.location = src;
        entry.line = pos.line;
        entry.column = pos.col + 1;
      }
    }
    instructions.push(entry);
  }
  return instructions;
}

/**
 * The RAW bytecode a FOREIGN address executed, disassembled (cached by
 * address). A foreign frame has no compilation unit, so there is no contract
 * image — we take the code the node executed there. Empty when the address
 * never appears in the trace.
 */
function foreignDisassembly(
  trace: Trace,
  cache: Map<string, Disassembly>,
  codeAddress: string
): Disassembly {
  let cached = cache.get(codeAddress);
  if (cached === undefined) {
    const idx = trace.steps.findIndex(
      s => addressHex(s.codeAddress) === codeAddress
    );
    cached = disassembleCode(idx >= 0 ? trace.cursor.at(idx).bytecode : '0x');
    cache.set(codeAddress, cached);
  }
  return cached;
}
