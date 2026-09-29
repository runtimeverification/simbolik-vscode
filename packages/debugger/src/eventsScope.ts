/**
 * The read-only Events scope: ALL events emitted across ALL contracts, in
 * emission order, up to the CURRENT step — not tied to the selected frame, so an
 * event emitted later never appears while paused earlier (and reverse-stepping
 * hides it again). Each LOG is decoded against the ABI of the contract whose
 * code emitted it.
 */
import type {DebugProtocol} from '@vscode/debugprotocol';

import {enumerateAllEvents, type DecodedEvent} from './events.js';
import type {AllocHandle} from './handles.js';
import {addressHex} from './hex.js';
import type {Trace} from './trace.js';

/** The events decoded up to (and including) step `step`. */
export function decodedEvents(trace: Trace, step: number): DecodedEvent[] {
  return enumerateAllEvents(trace.steps, trace.cursor, step, codeAddress => {
    // A FOREIGN emitter has no ABI to decode its logs against.
    const resolution = trace.registry.contractAt(addressHex(codeAddress));
    return resolution === undefined
      ? undefined
      : {defs: resolution.contract.events(), name: resolution.contract.name};
  });
}

/**
 * The event log as nested variables: each event's name (a `Name #k` suffix
 * disambiguates repeats), a one-line preview over its decoded args (prefixed
 * with the emitting contract), and an `Event` handle for the args.
 */
export function eventsVariables(
  events: DecodedEvent[],
  alloc: AllocHandle
): DebugProtocol.Variable[] {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  return events.map((e, i) => {
    let name = e.name;
    if ((counts.get(e.name) ?? 0) > 1) {
      const k = seen.get(e.name) ?? 0;
      seen.set(e.name, k + 1);
      name = `${e.name} #${k}`;
    }
    const signature = `${e.name}(${e.args.map(a => `${a.name}: ${a.value}`).join(', ')})`;
    return {
      name,
      value: e.emitter ? `${e.emitter}.${signature}` : signature,
      variablesReference: alloc({kind: 'Event', eventIndex: i}),
    };
  });
}

/** The decoded args of one event as leaf variables. */
export function eventArgVariables(
  event: DecodedEvent | undefined
): DebugProtocol.Variable[] {
  return (event?.args ?? []).map(a => ({
    name: a.name,
    value: String(a.value),
    type: a.typeLabel,
    variablesReference: 0,
  }));
}
