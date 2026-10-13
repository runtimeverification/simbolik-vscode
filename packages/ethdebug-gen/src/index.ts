/**
 * @simbolik/ethdebug-gen: generate ethdebug-format debug info from a solc
 * standard-json compilation. Covers the program's instruction→source mapping,
 * storage (state) variable pointers, and the static per-pc variable context
 * (params/locals with stack pointers).
 */

export {
  generateEthdebugProgram,
  type EthdebugInstruction,
  type EthdebugProgram,
  type EthdebugStorageVariable,
} from './program.js';
export type {CodeKind} from './cfg.js';
export {describeValueTypeString} from './valueTypes.js';
export {
  functionParameters,
  type ParamDescriptor,
} from './functionParameters.js';
export {functionLocals, type LocalDescriptor} from './functionLocals.js';
export {stackHeights, type StackHeights} from './stackHeights.js';
export {variablesAt, type ResolvedVariable} from './variables.js';
export {
  bytesLayoutAtMemoryOffset,
  type StructMember,
  type ArrayLayout,
  type BytesLayout,
  type BytesStorageLayout,
} from './layouts.js';
