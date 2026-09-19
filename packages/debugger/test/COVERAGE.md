# Debugger test coverage matrix (viaIR × legacy)

This suite must give **excellent UX on both compilation pipelines** — solc's classic
("legacy") codegen and the Yul `--via-ir` pipeline. The two produce very different
stack layouts and statement orderings, and the debugger's variable-location and
stepping logic has to handle both. This file is the living map of which scenario is
proven on which pipeline, so a coverage gap is visible rather than implicit.

## How the suite is built

- **Shared harness:** [`support/harness.ts`](./support/harness.ts) provides fixture
  readers, `launch(spec)` / `breakAt(spec, line)`, `stepToLine`, and scope/variable
  inspection (`locals`, `children`, …). A `Spec` names the build-info, trace and meta
  fixtures explicitly. Tests contain assertions, not plumbing.
- **Dual-mode:** `eachMode({viair, legacy}, (mode, spec) => …)` runs one shared test
  body against both pipeline fixtures. Used where the code path differs by pipeline.
- **Fixtures:** recorded live on kontrol-node (see the `kontrol-node-live` memory and
  `scratchpad/record-dualmode.mjs`). Build-infos live in `packages/solc/test/fixtures`;
  traces + metas in `./fixtures`. The new dual-mode legacy fixtures share one
  whole-project build-info, `newfixtures-legacy-build-info.json`.

## Why some scenarios are intentionally single-mode

Not every scenario needs both pipelines. Three code paths are **codegen-agnostic**, so a
second mode would test the same code twice:

- **Storage** references, mappings, fixed storage arrays — slot math from the storage
  layout, independent of how the function body was compiled.
- **Events** (LOG scanning), **cheatcodes** (CALL-to-address detection), **geth
  multi-frame** — driven by opcodes/addresses, not the source-level codegen.

And two scenarios are pipeline-*specific* by nature:

- **Out-of-order straight-line setup artifacts** are a `--via-ir` phenomenon. The viaIR
  fixture pins the fix; the legacy fixture (`stepstress`) pins that the heuristic does
  **not misfire** on classic codegen (the heuristic is gated to viaIR in `stepping.ts`).
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

## Dual-mode tests (added for symmetry)

- `memrefs-local.test.ts` — memory `uint256[]` / `string` / `uint256[3]`, both modes.
- `bytesarray-local.test.ts` — `bytes[]`, both modes.
- `inherited-udvt-locals.test.ts` — inheritance + UDVT value resolution, viaIR steps +
  a legacy value-at-line-45 block.
- `stepstress-local.test.ts` — legacy stepping is undisturbed by the viaIR heuristics.

## Known limitation (see `simbolik-ts-rewrite` memory)

Reference-type locals fall back to the frame-relative slot model when the per-pc
stack-provenance analyzer has no evidence. This fallback is **load-bearing under viaIR**
(late-materialised memory structs, fixed-size memory arrays have no DUP/SWAP-anchored
read) and is intentionally *not* gated off there. Its theoretical unsoundness under
viaIR — a reused slot could hold an unrelated word, yielding a garbage memory offset —
is a best-effort limitation; the sound fix is extending stack-provenance to reference
handles, tracked as a follow-up.
