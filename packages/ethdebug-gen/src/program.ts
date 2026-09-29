/**
 * The ethdebug PROGRAM of one contract: instruction→source mapping + storage
 * (state) variable pointers, from an UNOPTIMIZED solc standard-json compilation.
 */
import type {Pointer} from '@ethdebug/pointers';
import {
  buildInstructionIndex,
  type CompilationUnit,
  type Contract,
} from '@simbolik/solc';

import {codeImage, type CodeKind} from './cfg.js';
import type {
  ArrayLayout,
  BytesStorageLayout,
  MappingLayout,
  StructMember,
} from './layouts.js';
import {storageReferenceLayout} from './storageLayouts.js';

/** One runtime instruction with its resolved source range (from the source map). */
export interface EthdebugInstruction {
  /** Program counter of the instruction start. */
  pc: number;
  /** Index into the source map / instruction stream. */
  instructionIndex: number;
  /** Opcode byte. */
  op: number;
  /** Absent when the source-map fileId is -1 or the file is not in the output. */
  source?: {
    fileId: number;
    start: number;
    length: number;
    line: number;
    column: number;
  };
}

/** A state (storage) variable with an ethdebug pointer to its bytes. */
export interface EthdebugStorageVariable {
  name: string;
  astId: number;
  solcType: string;
  slot: number;
  offset: number;
  length: number;
  pointer: Pointer;
  /**
   * For a dynamic-array storage var, its element layout + a
   * dereferenceable storage `List` pointer (element regions named `'element'`),
   * mirroring the memory {@link ArrayLayout} so the session reuses one path.
   */
  array?: ArrayLayout;
  /**
   * For a value-struct storage var, its per-member descriptors, each
   * with a concrete storage pointer at the consecutive absolute slot — mirroring
   * the memory {@link StructMember} shape.
   */
  members?: StructMember[];
  /**
   * For a dynamic-`bytes`-encoded (`string`/`bytes`) storage var, the
   * layout facts the session parity-selects on — the inline/flag word pointer, the
   * STATIC keccak base slot for long-form data words, and string-vs-bytes decode.
   * The session owns the encoding RULES (parity, high-byte slice, multi-word trim).
   */
  bytesStorage?: BytesStorageLayout;
  /**
   * For a `mapping`-encoded storage var, the STATIC layout facts —
   * the base slot and the solc key/value type ids. Mapping keys are NOT
   * enumerable from the layout (only the base slot is fixed); the debugger
   * enumerates observed keys from the trace's `keccak256(key‖slot)` preimages
   * and computes each entry slot as `keccak256(key32 ‖ baseSlot32)`.
   */
  mapping?: MappingLayout;
}

/** An ethdebug program for one contract's runtime (or init) code. */
export interface EthdebugProgram {
  contract: string;
  kind: CodeKind;
  instructions: EthdebugInstruction[];
  storageVariables: EthdebugStorageVariable[];
}

/** Generate an ethdebug program for one contract's runtime (or init) code. */
export function generateEthdebugProgram(
  cu: CompilationUnit,
  sourcePath: string,
  contractName: string,
  kind: CodeKind = 'runtime'
): EthdebugProgram {
  const contract = cu.contract(sourcePath, contractName);
  if (contract === undefined) {
    throw new Error(`contract not found: ${sourcePath}:${contractName}`);
  }
  return {
    contract: `${sourcePath}:${contractName}`,
    kind,
    instructions: instructions(cu, contract, kind),
    storageVariables: storageVariables(contract),
  };
}

/** The contract's instructions, each with its source range where it has one. */
function instructions(
  cu: CompilationUnit,
  contract: Contract,
  kind: CodeKind
): EthdebugInstruction[] {
  const {bytecode, sourceMap} = codeImage(contract, kind);
  const {instructionToPc} = buildInstructionIndex(bytecode);

  // The instruction stream aligns 1:1 with the source map, NOT with the raw
  // disassembly (which runs past the source map into the CBOR metadata trailer).
  return sourceMap.map((entry, i) => {
    const pc = instructionToPc[i]!;
    const instruction: EthdebugInstruction = {
      pc,
      instructionIndex: i,
      op: opAt(bytecode, pc),
    };
    // Omit `source` when fileId is -1 (no source) or when the file is not part
    // of the output (e.g. a solc-internal source absent from output.sources).
    const file = entry.fileId >= 0 ? cu.sourceById(entry.fileId) : undefined;
    if (file !== undefined) {
      const {line, column} = file.offsetToPosition(entry.start);
      instruction.source = {
        fileId: entry.fileId,
        start: entry.start,
        length: entry.length,
        line,
        column,
      };
    }
    return instruction;
  });
}

/** Read the opcode byte at `pc` from a `0x`-prefixed bytecode hex string. */
function opAt(bytecode: string, pc: number): number {
  return parseInt(bytecode.slice(2 + pc * 2, 2 + pc * 2 + 2), 16);
}

/**
 * The contract's state variables. The scalar slot pointer is always emitted;
 * the reference layout (arrays, value structs, string/bytes, mappings) is
 * additive — see `storageLayouts.ts`.
 */
function storageVariables(contract: Contract): EthdebugStorageVariable[] {
  const out: EthdebugStorageVariable[] = [];
  for (const entry of contract.storageLayout()) {
    const type = contract.storageType(entry.type);
    if (type === undefined) continue;
    const slot = Number(entry.slot);
    const offset = entry.offset;
    const length = type.numberOfBytes;
    out.push({
      name: entry.label,
      astId: entry.astId,
      solcType: entry.type,
      slot,
      offset,
      length,
      pointer: {location: 'storage', slot, offset, length},
      ...storageReferenceLayout(contract, slot, entry.type, type),
    });
  }
  return out;
}
