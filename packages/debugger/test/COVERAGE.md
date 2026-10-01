# Debugger test coverage matrix (viaIR × legacy)

The debugger has to work on both of solc's compilation pipelines: the classic
("legacy") codegen and the Yul `--via-ir` pipeline. They produce very different stack
layouts and statement orderings, so variable location and stepping must handle both.
This file maps each scenario to the pipelines it is tested on, so coverage gaps are
visible.

## How the suite is built

- **Shared harness:** [`support/harness.ts`](./support/harness.ts) provides fixture
  readers, `launch(spec)` / `breakAt(spec, line)`, `stepToLine`, and scope/variable
  inspection (`locals`, `children`, …). A `Spec` names the build-info, trace and meta
  fixtures.
- **Dual-mode:** `eachMode({viair, legacy}, (mode, spec) => …)` runs one shared test
  body against both pipeline fixtures. Used where the code path differs by pipeline.
- **Fixtures:** traces recorded on kontrol-node. Build-infos live in
  `packages/solc/test/fixtures`; traces and metas in `./fixtures`. The dual-mode legacy
  fixtures share one whole-project build-info, `newfixtures-legacy-build-info.json`.

## Why some scenarios are intentionally single-mode

Some code paths don't depend on the codegen, so a second mode would test the same code
twice:

- **Storage** references, mappings, fixed storage arrays — slot math from the storage
  layout, independent of how the function body was compiled.
- **Events** (LOG scanning), **cheatcodes** (CALL-to-address detection), **geth
  multi-frame** — driven by opcodes/addresses, not the source-level codegen.

And two scenarios are pipeline-*specific* by nature:

- **Out-of-order straight-line setup artifacts** only occur with `--via-ir`. The viaIR
  fixture covers their suppression; the legacy fixture (`stepstress`) checks that the
  heuristic does not fire on classic codegen (it is gated to viaIR in `stepping.ts`).
- **Last-known-value** retention is exercised under viaIR (where late slot reuse makes
  the freed-but-in-scope case natural); the feature code itself is codegen-agnostic.

## Matrix

Legend: ✅ covered · ➖ intentionally not covered (reason in the notes above).

### Variable location / rendering

| Scenario | viaIR | legacy | Fixtures (viaIR / legacy) |
|---|:--:|:--:|---|
| value-type locals | ✅ | ✅ | `varmove` / `locals`, `stepper` |
| value-type parameters | ✅ | ✅ | `varmoveparams` / `stepper`, `vars` |
| memory dynamic value array (`uint256[]`) | ✅ | ✅ | `memrefs` / `memrefs`, `locals` |
| memory `string` | ✅ | ✅ | `memrefs` / `memrefs`, `locals` |
| fixed-size memory array (`T[N]`) | ✅ | ✅ | `memrefs` / `memrefs`, `fixedarrays` |
| memory struct | ✅ | ✅ | `memstruct` / `locals` (structs) |
| `bytes[]` / `string[]` memory | ✅ | ✅ | `bytesarray` / `bytesarray` |
| inherited-function locals | ✅ | ✅ | `inheritedudvt` / `inheritedudvt` |
| user-defined value type (UDVT) | ✅ | ✅ | `inheritedudvt` / `inheritedudvt` |
| constructor (init-code) params/locals | ✅ | ✅ | `ctor`, `factory` / `ctor`, `factory` |
| last-known value (freed but in scope) | ✅ | ➖ | `inheritedudvt` / — |
| storage dyn array / struct / string / bytes | ➖ | ✅ | — / `storagerefs` |
| mappings | ➖ | ✅ | — / `storagerefs` |
| fixed storage array | ➖ | ✅ | — / `fixedarrays` |

### Stepping / frames

| Scenario | viaIR | legacy | Fixtures (viaIR / legacy) |
|---|:--:|:--:|---|
| step over / into, breakpoints | ✅ | ✅ | `twocalls`, `memrefs` / `stepper`, `stepstress` |
| out-of-order setup artifact | ✅ | ➖¹ | `twocalls` / `stepstress`¹ |
| step-over drift across revert | ➖ | ✅ | — / `revertstep` |
| internal-function frames | ➖ | ✅ | — / `stepper`, `returns`, `nestedcalls` |
| modifier frames | ➖ | ✅ | — / `modifiers` |
| cheatcode frames (detect / etch / prank) | ➖ | ✅ | — / `etch`, `etchraw`, `prank` |
| events (LOG decoding) | ➖ | ✅ | — / `storagerefs` |
| multi-frame geth / mixed-optimization | ➖ | ✅ | — / `caller`+`callee` |

¹ The artifact is viaIR-only; `stepstress-local.test.ts` (legacy) asserts the
suppression heuristic does not fire on classic codegen (`stepstress` fixture).

## Dual-mode tests

- `memrefs-local.test.ts` — memory `uint256[]` / `string` / `uint256[3]`, both modes.
- `bytesarray-local.test.ts` — `bytes[]`, both modes.
- `inherited-udvt-locals.test.ts` — inheritance + UDVT value resolution, viaIR steps +
  a legacy value-at-line-45 block.
- `stepstress-local.test.ts` — legacy stepping is undisturbed by the viaIR heuristics.

## Known limitation

Reference-type locals fall back to the frame-relative slot model when the per-pc
stack-provenance analysis has no evidence. Under viaIR this fallback is needed for
late-materialized memory structs and fixed-size memory arrays, which have no DUP/SWAP
read to anchor on, so it is deliberately not disabled there. It is best-effort: a
reused slot could hold an unrelated word and yield a garbage memory offset. The sound
fix is to extend stack provenance to reference handles.
