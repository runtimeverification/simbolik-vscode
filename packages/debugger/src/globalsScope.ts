/**
 * The read-only Globals scope: Solidity `msg`/`tx`/`block` namespaces and
 * `gasleft()` at a frame's step. A child is rendered only when its source is
 * defined (kontrol carries `tx.gasprice` + all `block.*`; geth leaves them
 * `undefined`).
 */
import type {DebugProtocol} from '@vscode/debugprotocol';

import type {MachineState, Step} from '@simbolik/lifting';

import type {AllocHandle, GlobalGroup} from './handles.js';
import {addressHex} from './hex.js';

type Variable = DebugProtocol.Variable;

const address = (name: string, value: bigint): Variable => ({
  name,
  value: addressHex(value),
  type: 'address',
  variablesReference: 0,
});

/** A `uint256` row, or none when the value is unavailable. */
const uint = (name: string, value: bigint | number | undefined): Variable[] =>
  value === undefined
    ? []
    : [{name, value: String(value), type: 'uint256', variablesReference: 0}];

/** The children of one global namespace; `[]` when none is available. */
export function globalGroupVariables(
  step: Step,
  ms: MachineState,
  group: GlobalGroup
): Variable[] {
  switch (group) {
    case 'msg':
      return [
        address('sender', step.msgSender),
        ...uint('value', step.msgValue),
        {
          name: 'data',
          value: ms.calldata,
          type: 'bytes',
          variablesReference: 0,
        },
        {
          name: 'sig',
          value: '0x' + ms.calldata.slice(2, 10).padEnd(8, '0'),
          type: 'bytes4',
          variablesReference: 0,
        },
      ];
    case 'tx':
      return [
        address('origin', step.txOrigin),
        ...uint('gasprice', step.gasPrice),
      ];
    case 'block':
      return [
        ...uint('number', step.blockNumber),
        ...uint('timestamp', step.blockTimestamp),
        ...(step.coinbase !== undefined
          ? [address('coinbase', step.coinbase)]
          : []),
        ...uint('prevrandao', step.difficulty),
      ];
  }
}

/**
 * The top-level Globals rows: the `msg`/`tx`/`block` groups with ≥1 available
 * child (each an expandable handle), then the `gasleft()` leaf (always present).
 */
export function globalsVariables(
  step: Step,
  ms: MachineState,
  frameId: number,
  alloc: AllocHandle
): Variable[] {
  const groups = (['msg', 'tx', 'block'] as const)
    .filter(group => globalGroupVariables(step, ms, group).length > 0)
    .map(group => ({
      name: group,
      value: '',
      variablesReference: alloc({kind: 'GlobalGroup', frameId, group}),
    }));
  return [
    ...groups,
    {
      name: 'gasleft()',
      value: String(ms.gas),
      type: 'uint256',
      variablesReference: 0,
    },
  ];
}
