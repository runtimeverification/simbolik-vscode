/**
 * @simbolik/solc — a model over solc standard-json build-info: source maps,
 * PC↔instruction indexing, AST navigation, storage layout, and CBOR-metadata
 * contract identification.
 */

export {
  AstNode,
  closestFunction,
  closestFunctionOrModifier,
  closestStatement,
  findAstNode,
  findInnermostNode,
} from './ast.js';
export {
  CompilationUnit,
  Contract,
  SourceFile,
  loadBuildInfo,
  sourceMapEntryAtPc,
  type EventInfo,
  type EventParam,
  type OptimizerSettings,
  type StorageEntry,
  type StorageType,
} from './buildInfo.js';
export {cborMetadataHash, identifyContractByRuntimeCode} from './cbor.js';
export {
  buildInstructionIndex,
  parseSourceMap,
  type Jump,
  type SourceMapEntry,
} from './sourceMap.js';
