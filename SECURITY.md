# Security Policy

## No telemetry

**The AEE SDK sends no telemetry of any kind.** It contains no analytics, no crash reporting, no usage beacon, and no phone-home behaviour. The SDK makes network calls **only** through a sink you explicitly configure. The `stdout`, `file`, and custom-function sinks bundled here are entirely local and make zero network calls. If you never configure a network sink, the SDK never opens a socket.

## Privacy by default

The capture layer records **metadata only** by default:

- `recordInput(name)` stores the input's **name/identifier**, not its content.
- `recordToolCall(name, meta)` stores the tool **name** and lightweight metadata (durations, token counts), not arguments or results.
- `recordContextRef(locator)` stores a **locator/ID**, not the referenced content.

Raw content is captured **only** when you explicitly pass `{ raw: true }` on a per-call basis. This is opt-in, per call, and documented at each call site. There is no global "capture everything" switch.

Decision-evidence objects are validated against `decision-evidence.schema.json`, which has `additionalProperties: false`. Unknown fields are dropped (and surfaced via your `onError` callback) rather than silently forwarded, so you cannot accidentally leak an unexpected field into an evidence record.

## Fail-safe emission

`emit()` is fire-and-forget and never throws. A failing sink cannot crash or block the wrapped agent; errors are routed to the configured `onError` callback.

## Reporting a vulnerability

Please report security issues privately to **security@quox.ai**. Do not open a public issue for undisclosed vulnerabilities. Reports are handled on a best-effort basis. There is no service-level agreement and no guaranteed response time.
