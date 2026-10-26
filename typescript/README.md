# @quox/aee-sdk

Framework-agnostic capture SDK for the **[AEE protocol](https://github.com/quoxai/aee)** (Agent Envelope Exchange). Zero runtime dependencies. Envelope create/validate, a decision-evidence builder, pluggable sinks, and a capture layer (`wrap()` / `CaptureContext`).

> **Publishing to npm at launch; until then install from source.** The examples below reference the package name `@quox/aee-sdk`, but it is not yet on npm. Build it locally with `npm install && npm run build` from this directory.

Ships a dual build: `npm run build` emits ESM (`dist/esm`), CommonJS (`dist/cjs`), and shared type declarations (`dist/types`). Both `import '@quox/aee-sdk'` and `require('@quox/aee-sdk')` work via the package `exports` map, so CJS consumers no longer hit `ERR_PACKAGE_PATH_NOT_EXPORTED`.

## Envelope functions (Layer 1, no I/O, no state)

```ts
import { createTask, createResult, validate } from '@quox/aee-sdk'

const task = createTask('human.adam', 'agent.reviewer', 'code.review.request', { pr: 42 })
const result = createResult(task, { verdict: 'approved' })

validate(task)   // { valid: true, errors: [] }
validate(result) // { valid: true, errors: [] }
```

Every envelope conforms to the canonical `aee-v1.schema.json` (spec section 6): `priority` defaults to
`'normal'`, `reply_to` is enforced non-null for `result`/`error`, and unknown fields are preserved.

## Capture layer (Layer 2)

```ts
import { AEE } from '@quox/aee-sdk'

const aee = AEE.init({
  agentId: 'reviewer',
  sink: 'file',
  sinkOptions: { path: './aee-envelopes.ndjson' },
  decisionEvidence: 'standard',
})

await aee.wrap({ to: 'agent.linter', intent: 'code.review.request', payload: { pr: 42 } }, async (ctx) => {
  ctx.recordInput('diff')
  ctx.recordToolCall('linter.run')
  ctx.recordDecision('approve', 'No blocking lint errors')
  ctx.setConfidence(0.92)
  return { merged: true }
})
```

`emit()` is fire-and-forget and never throws, sink failures route to your `onError` callback. `record*`
captures metadata only by default; raw content is a per-call opt-in (`{ raw: true }`).

### Per-wrap evidence level

`wrap()` accepts a `decisionEvidence` option that overrides the instance default for that wrap only (spec
section 13.2). Raise a single sensitive wrap to `full` to include `context_refs`, or drop one to `none` to
suppress its evidence, without changing the instance-wide default:

```ts
await aee.wrap(
  { to: 'agent.linter', intent: 'code.review.request', decisionEvidence: 'full' },
  async (ctx) => {
    ctx.recordContextRef('store://envelopes/abc') // included only because this wrap is 'full'
  }
)
```

## Orphan result/error reply_to fallback

`result`/`error` envelopes MUST carry a non-null `reply_to`. Building one with no predecessor (an orphan) falls back to the envelope's own id so it stays schema-valid. This is a last resort, not normal threading, and it fires your `onError` warning every time so it is never silent. Prefer `createResult(task, ...)` / `createError(task, ...)`, or pass an explicit `replyTo`.

## CLI: aee-validate

The package ships an `aee-validate` binary that validates AEE envelopes from a file argument or stdin. It accepts a single envelope JSON object, a JSON array of envelopes, or NDJSON (one envelope per line), and prints a per-envelope result.

```bash
# Validate an NDJSON stream of emitted envelopes
aee-validate aee-envelopes.ndjson

# Or pipe from stdout
cat aee-envelopes.ndjson | aee-validate
```

Output is one line per envelope (`N: VALID` or `N: INVALID  <reasons>`) followed by a `summary: X/Y valid` line. Exit codes: `0` all valid, `1` at least one invalid, `2` input unreadable or not valid JSON/NDJSON. This makes it scriptable in CI and the quoxcli-parity surface for the SDK.

## Status and maturity

See the repo-level [STATUS_AND_LIMITS.md](../STATUS_AND_LIMITS.md) for the honest maturity map (what is Stable-candidate, what is Beta, what is not built). 150 tests, all green as of the last verification pass.

## No telemetry

This SDK sends no telemetry. It makes network calls only through a sink you configure. See the repo
[SECURITY.md](../SECURITY.md).

## License

Apache-2.0. See [../LICENSE](../LICENSE).
