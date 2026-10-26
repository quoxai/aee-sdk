# AEE SDK

Framework-agnostic capture SDK for the **[AEE protocol](https://github.com/quoxai/aee)** (Agent Envelope Exchange): a tiny, canonical message envelope for agent-to-agent communication that is portable, machine-validated, human-debuggable, and observable.

This monorepo ships:

- **`typescript/`**: [`@quox/aee-sdk`](#quickstart-typescript) (TypeScript / Node). Envelope create/validate, a decision-evidence builder, pluggable sinks, and a capture layer (`wrap()` / `CaptureContext`).
- **`python/`**: [`quox-aee`](#quickstart-python) (Python >= 3.10). The behaviour-for-behaviour mirror of the TypeScript package: same envelope semantics, same decision-evidence levels, same sinks, same capture layer. Zero runtime dependencies.
- **`conformance/`**: the cross-language contract: shared JSON fixtures (valid + invalid envelopes, decision-evidence levels) plus a vendored copy of the canonical `aee-v1.schema.json`. Any language binding validates against these same files.

> **Publishing to npm at launch; until then install from source.** The examples reference the package name `@quox/aee-sdk`, but the package is not yet on npm. Build it locally from `typescript/` (see below). There are no `npm install @quox/aee-sdk` commands that work today.

## Why AEE

AEE standardizes the **envelope** only: meaning lives in the `intent` namespace and the `payload`. The SDK gives you a zero-dependency way to mint spec-conformant envelopes and capture agent decisions as structured, auditable evidence, without wiring in a heavy observability stack.

## Land and expand

- **Local evidence is free, forever.** The `stdout`, `file` (NDJSON), and custom-function sinks in this SDK are Apache-2.0 licensed and self-contained. You can run the entire capture layer offline, write envelopes to a local file, and own your audit trail with zero network calls and zero account.
- **Collector / dashboard are the paid tier.** Streaming evidence to the QuoxCORE collector (org-scoped keys, provenance-enforced ingestion, tamper-evident WARD witnessing) and viewing it in the Quox dashboard are commercial features. The SDK's HTTP sink (a later phase) speaks that contract, but nothing in this package requires it. See [quox.ai](https://quox.ai).

## Quickstart (TypeScript)

Until the npm release, install from source:

```bash
git clone https://github.com/quoxai/aee-sdk
cd aee-sdk/typescript
npm install
npm run build
# then reference the built package from your project via a file: dependency or npm link
```

Pure envelope functions (no I/O, no state):

```ts
import { createTask, createResult, validate } from '@quox/aee-sdk'

const task = createTask('human.adam', 'agent.reviewer', 'code.review.request', { pr: 42 })
const result = createResult(task, { verdict: 'approved' })

validate(task)   // { valid: true, errors: [] }
validate(result) // { valid: true, errors: [] }
```

Capture layer: emit a task on enter, a result/error on exit, and record structured decision evidence:

```ts
import { AEE } from '@quox/aee-sdk'

const aee = AEE.init({
  agentId: 'reviewer',
  sink: 'file',
  sinkOptions: { path: './aee-envelopes.ndjson' },
  decisionEvidence: 'standard',
  onError: (err) => console.error('emit failed', err),
})

await aee.wrap(
  { to: 'agent.linter', intent: 'code.review.request', payload: { pr: 42 } },
  async (ctx) => {
    ctx.recordInput('diff')
    ctx.recordToolCall('linter.run')
    ctx.recordDecision('approve', 'No blocking lint errors found')
    ctx.recordAction('Merged PR #42')
    ctx.setConfidence(0.92)
    return { merged: true }
  }
)
```

Every `emit()` is fire-and-forget and **never throws**: failures are routed to your `onError` callback so a broken sink can never crash the wrapped agent.

## Quickstart (Python)

Publishing to PyPI at launch; until then pip install from source. See [`python/README.md`](./python/README.md) for the full guide.

```bash
git clone https://github.com/quoxai/aee-sdk
cd aee-sdk/python
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
```

Pure envelope functions and the capture layer (`wrap()` works as a context manager or a decorator):

```python
from quox_aee import AEE, create_task, create_result, validate

task = create_task("human.adam", "agent.reviewer", "code.review.query", {"pr": 42})
result = create_result(task, {"verdict": "approved"})
validate(task).valid  # True

aee = AEE.init(agent_id="reviewer", sink="file", sink_options={"path": "./aee-envelopes.ndjson"})
with aee.wrap(to="agent.linter", intent="code.review.query", payload={"pr": 42}) as ctx:
    ctx.record_decision("approve", "No blocking lint errors found")
    ctx.set_confidence(0.92)
```

Same guarantees as the TypeScript package: `emit()` is fire-and-forget and never raises; `record_*` captures metadata only unless you pass `raw=True`.

## CLI: aee-validate

Both language packages are paired with the `aee-validate` binary (built from `typescript/src/bin/aee-validate.ts`), which validates envelopes from a file argument or stdin. It accepts a single envelope object, a JSON array, or NDJSON (one envelope per line), and prints a per-envelope verdict plus a `summary: X/Y valid` line.

```bash
# Validate the NDJSON stream the file sink wrote
aee-validate aee-envelopes.ndjson

# Or pipe
cat aee-envelopes.ndjson | aee-validate
```

Exit codes: `0` all valid, `1` at least one invalid, `2` input unreadable or not valid JSON/NDJSON. Scriptable in CI.

## Orphan result/error reply_to fallback

The spec requires a non-null `reply_to` for every `result` and `error` envelope. When you build one with no predecessor (an orphan result/error), the SDK falls back to threading `reply_to` to the envelope's OWN id so it stays schema-valid. This is a **last resort**, not normal threading: pass an explicit `replyTo`/`reply_to` (or use `createResult`/`createError` against the originating task) whenever you can. The fallback is never silent, it fires your `onError`/`on_error` warning every time it triggers so orphan results are visible in your logs.

## Privacy

`record*` calls capture **names, locators, and metadata by default, never raw content**. Raw capture is an explicit per-call opt-in (`{ raw: true }`). See [SECURITY.md](./SECURITY.md).

## No telemetry

This SDK sends **no telemetry** of any kind. It makes no network calls except through a sink you explicitly configure (e.g. the optional HTTP sink). There is no analytics, no phone-home, no usage beacon. See [SECURITY.md](./SECURITY.md#no-telemetry).

## Status and maturity

**[STATUS_AND_LIMITS.md](./STATUS_AND_LIMITS.md) is the honest source of truth for what works and what doesn't.** Where this README and that file disagree, that file wins. Snapshot as of the last verification pass: 150 TypeScript tests and 158 Python tests, all green, run live against this checkout.

Not built yet (do not assume otherwise): framework adapters (LangChain, CrewAI, AutoGen) and the HTTP collector sink. Both are roadmap items with zero code in this repo today.

## Conformance

The `conformance/` directory holds the cross-language contract. The TypeScript test suite consumes those fixture **files** directly (not inline copies), so any additional language binding proves conformance against the identical corpus. The vendored `aee-v1.schema.json` is a copy of the canonical schema in the [aee spec repo](https://github.com/quoxai/aee); CI diffs the two.

## License

Apache-2.0. See [LICENSE](./LICENSE).
