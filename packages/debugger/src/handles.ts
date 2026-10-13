/**
 * DAP `variablesReference` handles. A handle is bound to a frame identity (by
 * id) + what it expands; the concrete frame is re-resolved against the current
 * step at read time, so a scope ref captured before stepping (`scopes()`, then
 * `continue()`, then `variables(ref)`) reads the up-to-date position.
 */

/** Where a nested complex variable's parent descriptor is re-resolved from. */
export type ComplexKind = 'local' | 'state';

/** A Solidity global namespace of the Globals scope. */
export type GlobalGroup = 'msg' | 'tx' | 'block';

export type Handle =
  | {
      kind:
        | 'State'
        | 'Locals'
        | 'Globals'
        | 'EVMStorage'
        | 'EVMMemory'
        | 'EVMCalldata'
        | 'EVMAccounts';
      frameId: number;
    }
  /** The EVM scope, with its nested storage + memory sub-view refs. */
  | {kind: 'EVM'; frameId: number; storageRef: number; memoryRef: number}
  /** One account (by its raw account-map key, as emitted by the node). */
  | {
      kind: 'EVMAccount' | 'EVMAccountStorage';
      frameId: number;
      accountAddress: string;
    }
  /** A nested struct/array/mapping variable, re-resolved by name. */
  | {
      kind: 'Complex';
      frameId: number;
      varName: string;
      complexKind: ComplexKind;
    }
  | {kind: 'GlobalGroup'; frameId: number; group: GlobalGroup}
  /** Events are global (all contracts, up to the current step) — frameless. */
  | {kind: 'Events'}
  | {kind: 'Event'; eventIndex: number};

/** Allocates handles; each reference is fresh and stays valid until cleared. */
export type AllocHandle = (handle: Handle) => number;

export class HandleTable {
  readonly #handles = new Map<number, Handle>();
  #seq = 100;

  readonly alloc: AllocHandle = handle => {
    const ref = this.#seq++;
    this.#handles.set(ref, handle);
    return ref;
  };

  get(ref: number): Handle | undefined {
    return this.#handles.get(ref);
  }

  clear(): void {
    this.#handles.clear();
  }
}
