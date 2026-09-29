/**
 * A recorded transaction loaded for debugging: its lossless trace steps, the
 * state cursor over them, which code runs at each address, and the stepping
 * model. Immutable once loaded — the session's position lives elsewhere.
 */
import {parseJsonLossless} from '@simbolik/engine';
import {
  normalizeGethTrace,
  normalizeKontrolTrace,
  StateCursor,
  type Step,
} from '@simbolik/lifting';
import {loadBuildInfo, type CompilationUnit} from '@simbolik/solc';

import {addressHex} from './hex.js';
import type {LaunchInputs} from './launchInputs.js';
import {CodeRegistry} from './registry.js';
import {SteppingModel} from './stepping.js';

export interface Trace {
  /** Every loaded compilation unit (launch build-infos + address-mapped ones). */
  cus: CompilationUnit[];
  registry: CodeRegistry;
  steps: Step[];
  cursor: StateCursor;
  model: SteppingModel;
}

/** Load and wire a recorded transaction per `inputs`. */
export function loadTrace(inputs: LaunchInputs): Trace {
  const cus = (inputs.buildInfos ?? [inputs.buildInfoJson])
    .filter(j => j !== undefined)
    .map(j => loadBuildInfo(j));
  if (cus.length === 0) {
    throw new Error('launch: no build-info provided');
  }
  const steps = parseSteps(inputs);
  const cursor = new StateCursor(steps, inputs.initialStorage);
  const registry = CodeRegistry.build(inputs, cus, steps, cursor);
  // Foreign code has no source map — leave its steps UNMAPPED so the stepping
  // model keeps their raw EVM depth and contributes no jump fold (strictly
  // safer than mis-mapping the foreign PCs onto the entry contract's map).
  const model = new SteppingModel(cursor, i =>
    registry.contractAt(addressHex(steps[i]!.codeAddress))
  );
  return {cus, registry, steps, cursor, model};
}

/** Parse the raw `debug_traceTransaction` response into steps, per dialect. */
function parseSteps(inputs: LaunchInputs): Step[] {
  const parsed = parseJsonLossless(inputs.traceJson as string) as {
    result: unknown;
  };
  let steps: Step[];
  if (inputs.dialect === 'geth') {
    if (inputs.txContext === undefined) {
      throw new Error(
        'launch: dialect "geth" requires a txContext (tx to/from/input)'
      );
    }
    steps = normalizeGethTrace(parsed.result, inputs.txContext);
  } else {
    steps = normalizeKontrolTrace(parsed.result as never);
  }
  // A trace with no steps means the traced transaction executed no EVM
  // instructions — the target address has no code (a failed/oversized deploy,
  // or a call to an EOA). Proceeding would build an empty stepping model whose
  // entry points past its own metadata, so the first step command throws a
  // cryptic error. Fail fast here with an explanation instead; the launch
  // resolver's deploy-status check catches the common cause earlier, but this
  // guards every other 0-step path.
  if (steps.length === 0) {
    const addr = inputs.codeAddress ?? 'the entry contract';
    throw new Error(
      `launch: the traced transaction executed no instructions — ${addr} ` +
        'has no code (the deploy may have failed, e.g. an oversized contract, ' +
        'or the call targeted an account with no code). There is nothing to debug.'
    );
  }
  return steps;
}
