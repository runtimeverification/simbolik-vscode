/**
 * @simbolik/debugger — an in-process Solidity debug session over a recorded
 * trace. It wires the core DAP request sequence
 * (`initialize → launch → threads → stackTrace → scopes → variables`) end to
 * end, culminating in variables read through the real `@ethdebug/pointers` path.
 */
export {
  DapDispatcher,
  type SessionResolver,
  type ResolveContext,
  type OutputCategory,
} from './dispatcher.js';
export {startDapServer, type DapServerHandle} from './tcpServer.js';
export {machineStateFor, readPointerValue} from './machineState.js';
export {enumerateMappingKeys, mappingValueSlot} from './mappings.js';
export {
  enumerateEvents,
  type DecodedEvent,
  type DecodedEventArg,
  type EventDef,
  type EventParamDef,
} from './events.js';
export {SolidityDebugSession, type LaunchInputs} from './session.js';
export {
  disassembleBytecode,
  encodeInstructionAddress,
  decodeInstructionAddress,
  type EvmInstruction,
} from './disassemble.js';
