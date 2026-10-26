# quox-aee

Framework-agnostic capture SDK for the **[AEE protocol](https://github.com/quoxai/aee)** (Agent Envelope Exchange): a tiny, canonical message envelope for agent-to-agent communication that is portable, machine-validated, human-debuggable, and observable.

This is the Python mirror of the [`@quox/aee-sdk`](../typescript) TypeScript package. Both packages share the cross-language conformance corpus in [`../conformance`](../conformance) and produce byte-shape-identical envelopes.

> **Publishing to PyPI at launch; until then pip install from source.**

## Zero dependencies

The core (`quox_aee`) has **no runtime dependencies**. Envelope create/validate, the decision-evidence builder, the JSON-schema-subset validator, and the local sinks are all self-contained pure Python (>= 3.10).

## Install (from source)

```bash
git clone https://github.com/quoxai/aee-sdk
cd aee-sdk/python
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"   # dev extras add pytest + pytest-cov
```

There is no registry install yet. `pip install quox-aee` will work only after the launch publish. Until then, install editable from this directory as above.

## Quickstart

Pure envelope functions (no I/O, no state):

```python
from quox_aee import create_task, create_result, validate

task = create_task("human.adam", "agent.reviewer", "code.review.query", {"pr": 42})
result = create_result(task, {"verdict": "approved"})

validate(task).valid    # True
validate(result).valid  # True
```

Every fully-formed envelope carries exactly these top-level keys: `v`, `id`, `ts`, `type`, `from`, `to`, `intent`, `corr`, `reply_to`, `priority`, `payload`.

Capture layer: emit a task on enter, a result/error on exit, and record structured decision evidence. `wrap()` works both as a **context manager** and a **decorator**:

```python
from quox_aee import AEE

aee = AEE.init(
    agent_id="reviewer",
    sink="file",
    sink_options={"path": "./aee-envelopes.ndjson"},
    decision_evidence="standard",
    on_error=lambda err, env: print("emit failed", err),
)

# Context-manager form
with aee.wrap(to="agent.linter", intent="code.review.query", payload={"pr": 42}) as ctx:
    ctx.record_input("diff")
    ctx.record_tool_call("linter.run")
    ctx.record_decision("approve", "No blocking lint errors found")
    ctx.record_action("Merged PR #42")
    ctx.set_confidence(0.92)

# Decorator form: the wrapped function receives the CaptureContext first
@aee.wrap(to="agent.linter", intent="code.review.query")
def review(ctx, pr):
    ctx.record_decision("approve", "clean")
    return {"merged": True}

review(42)
```

Every `emit()` is fire-and-forget and **never raises**. Failures are routed to your `on_error` callback so a broken sink can never crash the wrapped agent.

## Sessions and correlation

```python
session = aee.start_session()   # mints a shared corr
with aee.wrap(to="agent.a", intent="ops.one"):
    ...                          # nested wraps inherit the session/enclosing corr
session.end()
```

Nested wraps inherit the enclosing corr, forming a correlation tree. There is no global state; multiple `AEE` instances coexist independently.

## Privacy

`record_*` calls capture **names, locators, and metadata by default, never raw content**. Raw capture is an explicit per-call opt-in (`raw=True`). See [../SECURITY.md](../SECURITY.md).

## Orphan result/error reply_to fallback

`result`/`error` envelopes MUST carry a non-null `reply_to`. Building one with no predecessor (an orphan) falls back to the envelope's own id so it stays schema-valid. This is a last resort, not normal threading, and it fires your `on_error` warning every time so it is never silent. Prefer `create_result(task, ...)` / `create_error(task, ...)`, or pass an explicit `reply_to`.

## No telemetry

This SDK sends **no telemetry** of any kind. It makes no network calls except through a sink you explicitly configure. There is no analytics, no phone-home, no usage beacon.

## Decision-evidence levels

`decision_evidence` filters what the builder emits, per AEE spec section 13.2:

| Level | Fields emitted |
|-------|----------------|
| `none` | (no evidence block) |
| `minimal` | `decision`, `reason_summary` |
| `standard` | all except `context_refs` |
| `full` | all fields |

Unknown fields are dropped (and warned via `on_error`) because the decision-evidence schema is `additionalProperties: false`.

`wrap()` accepts a `decision_evidence` argument that overrides the instance default for that wrap only. Raise a single sensitive wrap to `full` to include `context_refs`, or drop one to `none` to suppress its evidence:

```python
with aee.wrap(to="agent.linter", intent="code.review.query", decision_evidence="full") as ctx:
    ctx.record_context_ref("store://envelopes/abc")  # included only because this wrap is 'full'
```

## Status and maturity

See the repo-level [STATUS_AND_LIMITS.md](../STATUS_AND_LIMITS.md) for the honest maturity map. 158 tests, all green as of the last verification pass.

## Conformance

The Python test suite consumes the shared fixture **files** in `../conformance/fixtures` directly (16 valid, 25 invalid, 5 evidence-level fixtures) plus the vendored `../conformance/aee-v1.schema.json`, so it proves conformance against the identical corpus the TypeScript suite uses.

```bash
pytest -q --cov=quox_aee --cov-report=term-missing
```

## License

Apache-2.0. See [../LICENSE](../LICENSE).
