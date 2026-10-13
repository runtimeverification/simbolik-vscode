/**
 * The raw EVM scope of a frame: pc/op/stack scalars plus expandable memory,
 * storage, calldata and touched-account views of the machine state at the
 * frame's step.
 */
import type {DebugProtocol} from '@vscode/debugprotocol';

import type {MachineState} from '@simbolik/lifting';

import type {AllocHandle} from './handles.js';
import {addressHex, strip0x} from './hex.js';

type Variable = DebugProtocol.Variable;

function leaf(name: string, value: string, type?: string): Variable {
  return {name, value, type, variablesReference: 0};
}

/** The EVM scope's top-level rows. */
export function evmVariables(
  ms: MachineState,
  frameId: number,
  address: string,
  refs: {storageRef: number; memoryRef: number},
  alloc: AllocHandle
): Variable[] {
  const calldataBytes = strip0x(ms.calldata).length / 2;
  return [
    leaf('pc', String(ms.pc)),
    leaf('op', ms.op),
    leaf('stack', `${ms.stack.length} items`),
    {
      name: 'memory',
      value: `${ms.memory.length} words`,
      variablesReference: ms.memory.length > 0 ? refs.memoryRef : 0,
    },
    {
      name: 'storage',
      value: `${accountStorageVariables(ms, address).length} slots`,
      variablesReference: refs.storageRef,
    },
    {
      name: 'calldata',
      value: calldataBytes > 0 ? `${calldataBytes} bytes` : '0x',
      variablesReference:
        calldataBytes > 0 ? alloc({kind: 'EVMCalldata', frameId}) : 0,
    },
    leaf('returnData', ms.returnData),
    {
      name: 'accounts',
      value: `${ms.accounts.size} accounts`,
      variablesReference:
        ms.accounts.size > 0 ? alloc({kind: 'EVMAccounts', frameId}) : 0,
    },
  ];
}

/**
 * The calldata as a 4-byte function selector plus one row per 32-byte ABI word
 * after the selector, each named by its byte offset: `0x00` (selector), then
 * `0x04`, `0x24`, `0x44`, …. Short calldata degrades gracefully — a
 * selector-only calldata yields just the `0x00` row, and calldata shorter than
 * 4 bytes yields whatever selector bytes are present.
 */
export function calldataVariables(ms: MachineState): Variable[] {
  const hex = strip0x(ms.calldata);
  if (hex.length === 0) return [];
  const variables = [leaf('0x00', '0x' + hex.slice(0, 8), 'bytes4')];
  const rest = hex.slice(8);
  for (let k = 0; k * 64 < rest.length; k++) {
    const offset = 4 + k * 32;
    variables.push(
      leaf(
        '0x' + offset.toString(16).padStart(2, '0'),
        '0x' + rest.slice(k * 64, k * 64 + 64)
      )
    );
  }
  return variables;
}

/**
 * One row per touched account, named by its display address (tolerating
 * decimal or 0x-hex node keys) and expandable into the account's fields.
 */
export function accountsVariables(
  ms: MachineState,
  frameId: number,
  alloc: AllocHandle
): Variable[] {
  return [...ms.accounts.keys()].map(key => ({
    name: addressHex(BigInt(key)),
    value: '',
    variablesReference: alloc({
      kind: 'EVMAccount',
      frameId,
      accountAddress: key,
    }),
  }));
}

/**
 * The fields of one account: `address`, `balance`, `nonce`, `code` (a size
 * summary) and an expandable `storage` row. Balance/nonce show `Unavailable`
 * when the node emitted no change for them.
 */
export function accountVariables(
  ms: MachineState,
  frameId: number,
  accountAddress: string,
  alloc: AllocHandle
): Variable[] {
  const account = ms.accounts.get(accountAddress);
  const codeByteLen =
    account?.code === undefined ? 0 : (account.code.length - 2) / 2;
  const slotCount = Object.keys(account?.storage ?? {}).length;
  const uint = (v: string | undefined): string =>
    v === undefined ? 'Unavailable' : String(BigInt(v));
  return [
    leaf('address', addressHex(BigInt(accountAddress)), 'address'),
    leaf('balance', uint(account?.balance), 'uint256'),
    leaf('nonce', uint(account?.nonce), 'uint256'),
    leaf('code', `${codeByteLen} bytes`),
    {
      name: 'storage',
      value: `${slotCount} slots`,
      variablesReference:
        slotCount > 0
          ? alloc({kind: 'EVMAccountStorage', frameId, accountAddress})
          : 0,
    },
  ];
}

/** One account's touched storage slots, as `slot → 0x…word`. */
export function accountStorageVariables(
  ms: MachineState,
  accountAddress: string
): Variable[] {
  const storage = ms.accounts.get(accountAddress)?.storage ?? {};
  return Object.entries(storage).map(([slot, word]) =>
    leaf(slot, '0x' + strip0x(word))
  );
}

/**
 * The memory as one row per 32-byte word, named by its byte offset zero-padded
 * to 4 hex digits for column alignment (`0x0000`, `0x0020`, …). Kontrol emits
 * bare (no-`0x`) words, so the prefix is normalized.
 */
export function memoryVariables(ms: MachineState): Variable[] {
  return ms.memory.map((word, i) =>
    leaf(
      '0x' + (i * 32).toString(16).padStart(4, '0'),
      '0x' + strip0x(word).padStart(64, '0')
    )
  );
}
