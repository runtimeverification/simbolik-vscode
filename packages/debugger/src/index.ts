/**
 * @simbolik/debugger — an in-process Solidity debug session over a recorded
 * trace, serving the DAP requests (`initialize → launch → threads → stackTrace
 * → scopes → variables`, stepping, breakpoints) with variables read through
 * `@ethdebug/pointers`.
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
export {
  CHEATCODE_ADDRESS,
  isCheatcodeCall,
  decodeCheatcodeCall,
  type DecodedCheatcode,
} from './cheatcodes.js';
export {SolidityDebugSession, type LaunchInputs} from './session.js';
export {
  disassembleBytecode,
  encodeInstructionAddress,
  decodeInstructionAddress,
  type EvmInstruction,
} from './disassemble.js';
