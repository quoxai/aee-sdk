# STATUS_AND_LIMITS — AEE SDK

> Treat the README and CHANGELOG as marketing-adjacent. Treat this file as the source of truth for what works and what doesn't in this package.

**Repo:** `aee-sdk` (`@quox/aee-sdk` TypeScript, `quox-aee` Python). Apache-2.0 licensed, unpublished.
**Created:** 2026-07-25. **Last verified:** 2026-07-25 (tests run live against this checkout, not taken from CHANGELOG claims).
**Authoritative paths:** `typescript/src/` (`envelope.ts`, `evidence.ts`, `ulid.ts`, `capture.ts`, `sinks/index.ts`, `bin/aee-validate.ts`), `python/src/quox_aee/` (mirrors the same module names), `conformance/` (shared fixtures + vendored `aee-v1.schema.json`).

## How to read the tags

| Tag | Meaning |
|---|---|
| **Stable-candidate** | Fully implemented, spec-conformant, backed by an automated test suite with a live green run. Not yet "Stable" in the strict sense (production use ≥4 weeks) because the package has zero deployed consumers pre-launch — but there is no known gap between spec and implementation. |
| **Beta** | Works end-to-end, verified, but the corpus of real use is small. |
| **Experimental** | Exists but has known sharp edges or partial coverage. |
| **Not built** | Does not exist yet. If it has a name in a phase plan, that's noted; otherwise it's an idea, not a roadmap item. |

## Maturity table

| Capability | Status | Notes |
|---|---|---|
| Envelope create/validate (`createTask`, `createResult`, `createError`, `validate`) | Stable-candidate | Spec-conformant: `priority` emitted with default `'normal'`, `reply_to` conditionally enforced for result/error, unknown/extension fields preserved on the object. `envelope.ts` at 100% line/branch/function coverage. |
| Decision-evidence levels (none / minimal / standard / full) | Stable-candidate | Matches aee.md §13.2 field sets exactly (`none` = nothing, `minimal` = decision + reason_summary, `standard` = all fields except `context_refs`, `full` = everything). `evidence.ts` 97.48% line coverage. |
| ULID generation | Stable-candidate | Monotonic within the same millisecond via random-component increment, clamped. `ulid.ts` 95.42% line coverage. |
| Sinks (stdout, file NDJSON, custom function) | Stable-candidate | Fire-and-forget, documented to never throw; failures route to `onError`/`on_error`. `sinks/index.ts` 100% line coverage. |
| Capture layer (`AEE.init`, `wrap()`, `CaptureContext`) | Stable-candidate | Concurrency-safe correlation stack: `AsyncLocalStorage` in TypeScript, `contextvars.ContextVar` in Python, so overlapping/concurrent `wrap()` calls cannot steal each other's corr id. `capture.ts` 98.3% line coverage. |
| `aee-validate` CLI | Beta | Functionally covered by `test/cli.test.ts` (6 tests passing), but the file itself shows 0% coverage in the v8 instrumentation report because the CLI is invoked as a subprocess, not in-process. Works, but the coverage claim on this one file is not backed by direct instrumentation. |
| Dual ESM + CJS build | Stable-candidate | `test/dual-build.test.ts` builds both targets and asserts both are importable; 2 tests passing (slow: ~6s, it's a real build). |
| Cross-language conformance (TS <-> Python) | Stable-candidate | Both suites consume the same fixture files under `conformance/`, not inline copies. TS: 150 tests, 90.94% statement coverage (rounds to the ~91% the README implies). Python: 158 tests, 95% coverage. Both green as of this verification pass. |
| Orphan `reply_to` own-id fallback | Documented edge case | When a result/error has no predecessor, `reply_to` falls back to the envelope's own id and fires `onError`/`on_error` as a warning every time. This is a last-resort behaviour, not silent, and is called out in the README under "Orphan result/error reply_to fallback". |

## Not built (do not imply otherwise in a pitch)

- **Framework adapters** (LangChain, CrewAI, AutoGen). No code for these exists in this repo today. Referred to elsewhere as a "Phase 2" item; there is no adapter code, tests, or even stub files to point to.
- **HTTP collector sink** (`/v1/aee/envelopes` ingestion). Not implemented. The README's "Land and expand" section explicitly flags this as a later-phase item that would speak the QuoxCORE collector contract, and notes it is gated on separate security-hardening work (plugin trust boundary) before it ships. Nothing in the local-only sinks (stdout/file/custom) requires it.

## Known gaps

- CLI coverage instrumentation gap noted above (functional coverage via subprocess tests, not line coverage).
- The orphan `reply_to` fallback is a deliberate compromise to stay schema-valid, not a bug, but it does mean a caller who never threads `replyTo` will get a warning-spammed but "valid" envelope stream. Document this to consumers.

## What this SDK is NOT

- Not a message bus, not a transport. It mints and validates envelopes and gives you local sinks; it does not deliver anything over a network by itself unless you write a custom sink.
- Not a policy or decision engine. Decision *evidence* is captured (what was decided and why, at the level you choose); nothing in this package evaluates or enforces policy.
- Not connected to the QuoxCORE collector today. No network calls happen unless you configure one yourself.

## Cross-cutting (applies to all four SDK repos: aee-sdk, ward-sdk, volt-sdk, aocl-sdk)

- None of the four packages are published to npm or PyPI yet. Publishing is owner-gated, planned for launch.
- None of the four repos have a public GitHub remote configured yet (`git remote -v` returns empty in all four checkouts as of this verification). Publishing the remote is owner-gated.
- Install-from-source only today (`npm install`/`npm run build`, or `pip install -e .` for the Python package). Any `npm install @quox/...` or `pip install quox-...` instruction elsewhere is aspirational until launch.
- Zero runtime dependencies in every core package (`package.json` / `pyproject.toml` `dependencies` are empty; dev/test tooling like `ajv`, `vitest`, `pytest` are dev-only).
