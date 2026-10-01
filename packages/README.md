# Simbolik debug server packages

The Solidity/EVM debug server that ships inside the VSCode extension. It runs a
transaction on `kontrol-node` (or replays one from an anvil/geth node), records the
whole execution trace, and then answers Debug Adapter Protocol (DAP) requests over
that trace. Stepping, breakpoints and reverse execution all happen client-side.

## Packages

| Package | Purpose |
|---|---|
| `@simbolik/protocol` | Shared wire types: JSON-RPC 2.0 and the kontrol/anvil trace formats. |
| `@simbolik/engine` | kontrol-node process lifecycle, JSON-RPC client, lossless (bigint-preserving) trace fetch, and the attach flow for remote transactions. |
| `@simbolik/lifting` | Normalizes either trace format into `Step[]`. `StateCursor` reconstructs the full machine state at any step by folding the per-step deltas. |
| `@simbolik/solc` | Model of solc standard-JSON output: source maps, PC↔instruction mapping, AST navigation, storage layout, events, and CBOR-based contract identification. |
| `@simbolik/ethdebug-gen` | Generates [ethdebug](https://ethdebug.github.io/format/) data from solc output: the instruction↔source program and, for every pc, the live variables with pointers to where their values are. Supports both the legacy and the `--via-ir` pipeline. |
| `@simbolik/sources` | Source acquisition for replaying remote transactions: fetches verified sources from Sourcify and recompiles them with solc-js. |
| `@simbolik/debugger` | `SolidityDebugSession` (the DAP requests), the `DapDispatcher` (DAP message protocol) and a TCP server (`startDapServer`). |

## How it fits together

1. The extension host (`src/resolver/`) builds `LaunchInputs`. For `launch` it reads
   the Foundry build-infos, deploys and calls the contract on kontrol-node, and fetches
   the trace. For `attach` it fetches an existing transaction's trace and gets each
   touched contract's sources from Sourcify.
2. `@simbolik/lifting` turns the trace into steps and a `StateCursor`.
3. The debugger resolves each step's code address to a compilation unit. It uses the
   CBOR metadata hash, or an explicit address → build-info map for geth traces, which
   don't record the executing code. Steps whose code can't be identified are shown as
   foreign frames (disassembly only).
4. `@simbolik/ethdebug-gen` statically answers "which variables are live at this pc and
   where are they?". The session only dereferences the pointers against the
   reconstructed machine state and decodes the values. It does no layout math of its
   own.

A single transaction may span compilation units with different optimizer and viaIR
settings. Every frame is resolved against its own CU.

### Module map

- **`debugger`**: `session.ts` is a thin DAP facade over the launch-time model in
  `trace.ts` (steps, cursor, stepping model) and `registry.ts` (address → contract/CU,
  or foreign). `contractAnalysis.ts` holds the per-contract static caches (pc → source,
  disassembly, ethdebug program, `variablesAt`). Supporting modules:
  - `stepping.ts`: statement and instruction stepping.
  - `frames.ts`: call-stack reconstruction, with internal-function and modifier
    frames.
  - `breakpoints.ts`: line, instruction and exception-filter breakpoints.
  - `exceptions.ts`: where each revert originates and whether it was caught.
  - `revertData.ts`: decodes `Error(string)`, `Panic` and custom errors.
  - `cheatcodes.ts`: Foundry cheatcode calls.
  - `sources.ts` and `handles.ts`: DAP `Source` objects and `variablesReference`
    handles.

  Each scope has its own renderer: `solidityVariables.ts`, `localsHistory.ts`,
  `evmScope.ts`, `globalsScope.ts`, `eventsScope.ts` and `disassemblyView.ts`.
- **`ethdebug-gen`**: `program.ts` generates the program and `variables.ts` the per-pc
  variable contexts. The stack analyses are `stackHeights.ts` (per-pc frame-relative
  height) and `stackProvenance.ts` (which stack slot holds which variable, needed for
  viaIR's reordered stacks). Both share the control-flow core in `cfg.ts`.
- **Extension host**: `src/server.ts` is the entry point of the separately bundled ESM
  server (`build/server.mjs`). The extension loads it through `src/serverBridge.ts`.
  `src/DebugAdapter.ts` runs the server inline (default) or over TCP, depending on
  `simbolik.adapterMode`.

## Known limitations

- Storage reads use the frame's code address. Under `DELEGATECALL` they should use the
  caller's storage instead.
- Mapping keys are recovered from `KECCAK256` preimages observed in the trace, so only
  keys the transaction actually touched are shown. Keys of type `string`/`bytes` are
  not enumerated.
- Storage arrays with sub-word (packed) elements, structs with packed members, and
  arrays whose elements are reference types are not expanded.
- Reference-type locals fall back to a frame-relative slot model when the
  stack-provenance analysis finds no evidence. viaIR needs this fallback for
  late-materialized memory structs and fixed-size memory arrays. It is best-effort,
  because a reused slot could hold an unrelated word.
- The first stop in a constructor (its header, before the arguments are decoded) shows
  no parameters.
- Breakpoints are keyed by source path, so two CUs that use the same path collide.

## Development

```bash
npm install
npm run typecheck    # all workspace packages + the extension host
npm test             # vitest; uses recorded fixtures, no kontrol-node needed
```

The tests run on recorded compiler output and traces, committed under each package's
`test/fixtures/`. The debugger tests share a harness (`debugger/test/support/harness.ts`)
that runs each scenario against both the legacy and the viaIR pipeline where the code
paths differ. [`debugger/test/COVERAGE.md`](debugger/test/COVERAGE.md) shows which
scenario is covered on which pipeline.

### Live tests

Tests that drive a real `kontrol-node` are gated behind `SIMBOLIK_LIVE=1`:

```bash
npm run test:live
```

The devcontainer provisions kontrol-node with `.devcontainer/setup-kontrol-node.sh`.
`@simbolik/engine`'s `devcontainerLaunch` starts it from there.

### Engine behavior the code relies on

- kontrol-node emits addresses and 256-bit values as decimal integers beyond
  `Number.MAX_SAFE_INTEGER`, so traces are parsed into `bigint`s, never with plain
  `JSON.parse`.
- kontrol-node traces a whole transaction eagerly: `eth_sendTransaction` executes and
  traces it, and `kontrol_traceTransaction` returns the precomputed trace. The node has
  no interactive stepping.
- Trace change fields are delta-encoded: they appear only on the step where the value
  changes.
- `eth_chainId` returns the decimal number `31337` instead of a hex string.
