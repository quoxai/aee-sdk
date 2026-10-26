"""Capture layer: the one stateful convenience over the pure envelope functions.

Mirrors the TypeScript ``capture.ts``. ``AEE.init(...)`` returns an instance
with NO global state, so multiple instances coexist. ``wrap()`` emits a ``task``
on enter and a ``result``/``error`` on exit, threading corr/reply_to
automatically. Nested wraps inherit the enclosing corr; ``start_session()``
groups a set of wraps under one corr.

``wrap()`` is usable BOTH as a context manager::

    with aee.wrap(to="agent.b", intent="ops.do.thing") as ctx:
        ctx.record_decision("approve", "looks good")

and as a decorator (the wrapped function receives the ``CaptureContext`` as its
first positional argument)::

    @aee.wrap(to="agent.b", intent="ops.do.thing")
    def handler(ctx, x):
        ctx.record_action("did thing")
        return x

Privacy: ``record_*`` captures names/locators/metadata only. Raw content is an
explicit per-call opt-in (``raw=True``).
"""

from __future__ import annotations

import contextvars
import functools
import json
from typing import Any, Callable

from .envelope import create_error, create_result, create_task
from .evidence import DecisionEvidenceBuilder
from .sinks import Sink, create_custom_sink, create_file_sink, create_stdout_sink
from .ulid import prefixed_ulid


def _safe_stringify(value: Any) -> str:
    try:
        return value if isinstance(value, str) else json.dumps(value, separators=(",", ":"))
    except (TypeError, ValueError):
        return str(value)


class CaptureContext:
    """Per-wrap recording surface. Feeds the decision-evidence builder."""

    def __init__(self, task: dict, builder: DecisionEvidenceBuilder, aee: "AEE") -> None:
        self.task = task
        self.corr = task["corr"]
        self._builder = builder
        self._aee = aee

    def record_input(
        self, name: str, descriptor: Any = None, raw: bool = False
    ) -> "CaptureContext":
        if raw and descriptor is not None:
            self._builder.record_input(f"{name}={_safe_stringify(descriptor)}")
        else:
            self._builder.record_input(name)
        return self

    def record_tool_call(self, name: str, meta: Any = None, raw: bool = False) -> "CaptureContext":
        if raw and meta is not None:
            self._builder.record_tool_call(f"{name}={_safe_stringify(meta)}")
        else:
            self._builder.record_tool_call(name)
        return self

    def record_context_ref(self, locator: str) -> "CaptureContext":
        self._builder.record_context_ref(locator)
        return self

    def record_decision(self, decision: str, reason_summary: str | None = None) -> "CaptureContext":
        self._builder.record_decision(decision, reason_summary)
        return self

    def record_action(self, action_taken: str) -> "CaptureContext":
        self._builder.record_action(action_taken)
        return self

    def set_confidence(self, confidence: float) -> "CaptureContext":
        self._builder.set_confidence(confidence)
        return self

    def emit(self, envelope: dict) -> None:
        """Escape hatch: emit an arbitrary envelope mid-wrap, sharing this corr."""
        shared = {**envelope, "corr": self.corr}
        self._aee.emit(shared)

    def build_evidence(self, level: str) -> dict | None:
        """Internal: build the level-filtered evidence for this wrap."""
        return self._builder.build(level)


class _Session:
    def __init__(self, aee: "AEE", corr: str, token: contextvars.Token) -> None:
        self.corr = corr
        self._aee = aee
        self._token = token
        self._ended = False

    def end(self) -> None:
        if self._ended:
            return
        self._ended = True
        # Restore the context-local stack to its pre-session value. Because the
        # stack lives in a ContextVar it is context-local (per thread AND per
        # asyncio task), so ending one session never disturbs another context.
        self._aee._corr_var.reset(self._token)


class _Wrap:
    """A single ``wrap()`` handle: usable as a context manager or a decorator."""

    def __init__(self, aee: "AEE", spec: dict) -> None:
        self._aee = aee
        self._spec = spec
        self._task: dict | None = None
        self._ctx: CaptureContext | None = None
        self._token: contextvars.Token | None = None
        self._level: str = aee.evidence_level

    def __enter__(self) -> CaptureContext:
        spec = self._spec
        aee = self._aee
        from_ = spec.get("from") or f"agent.{aee.agent_id}"
        parent = aee._corr_var.get()
        corr = spec.get("corr") or (parent[-1] if parent else None)
        self._level = spec.get("decision_evidence") or aee.evidence_level
        options = {"priority": spec["priority"]} if spec.get("priority") else {}

        task = create_task(from_, spec["to"], spec["intent"], spec.get("payload") or {}, corr, options)
        aee.emit(task)

        builder = DecisionEvidenceBuilder(lambda err: aee._report_error(err, task))
        ctx = CaptureContext(task, builder, aee)
        self._task = task
        self._ctx = ctx

        # Push this wrap's corr onto the CONTEXT-LOCAL stack. Because the stack
        # is a ContextVar, a concurrent wrap in another thread/task has its own
        # copy: a nested wrap here can only ever inherit THIS wrap's corr.
        self._token = aee._corr_var.set(parent + (task["corr"],))
        return ctx

    def __exit__(self, exc_type, exc, tb) -> bool:
        aee = self._aee
        task = self._task
        ctx = self._ctx
        try:
            evidence = ctx.build_evidence(self._level)
            if exc is None:
                payload: dict = {}
                if evidence:
                    payload["decision_evidence"] = evidence
                result = create_result(task, payload)
                aee.emit(result)
            else:
                message = str(exc)
                code = getattr(exc, "code", None) or "WRAP_ERROR"
                details = {"decision_evidence": evidence} if evidence else {}
                error_env = create_error(task, {"code": code, "message": message, "details": details})
                aee.emit(error_env)
        finally:
            if self._token is not None:
                aee._corr_var.reset(self._token)
        # Propagate any exception (mirrors the TS ``throw err``).
        return False

    def __call__(self, fn: Callable) -> Callable:
        aee = self._aee
        spec = self._spec

        @functools.wraps(fn)
        def wrapper(*args: Any, **kwargs: Any) -> Any:
            # Fresh wrap per invocation so decorated functions are re-entrant.
            with _Wrap(aee, spec) as ctx:
                return fn(ctx, *args, **kwargs)

        return wrapper


class AEE:
    """A capture instance. Created via :meth:`init`. No global state."""

    def __init__(
        self,
        agent_id: str,
        sink: Any = "stdout",
        sink_options: dict | None = None,
        decision_evidence: str = "standard",
        on_error: Callable[..., None] | None = None,
    ) -> None:
        if not agent_id:
            raise ValueError("AEE.init: agent_id is required")
        self.agent_id = agent_id
        self.evidence_level = decision_evidence or "standard"
        self._on_error = on_error or (lambda *a: None)
        # Context-local corr stack: a ``contextvars.ContextVar`` so the active
        # corr is per-thread AND per-asyncio-task. Concurrent/overlapping wraps
        # never steal each other's corr. Default is the empty tuple (no active
        # corr). Immutable tuples so a snapshot captured by a child context can
        # never be mutated out from under it.
        self._corr_var: contextvars.ContextVar[tuple[str, ...]] = contextvars.ContextVar(
            f"aee_corr_stack_{id(self)}", default=()
        )
        # Route sink-side warnings (e.g. non-finite NDJSON sanitisation) through
        # the exception-safe reporter so the user's 2-arg on_error contract and
        # never-throw guarantee both hold.
        self._sink = _resolve_sink(sink, sink_options or {}, self._report_error)

    @classmethod
    def init(
        cls,
        agent_id: str,
        sink: Any = "stdout",
        sink_options: dict | None = None,
        decision_evidence: str = "standard",
        on_error: Callable[..., None] | None = None,
    ) -> "AEE":
        """Create a new, independent AEE instance. No global state."""
        return cls(agent_id, sink, sink_options, decision_evidence, on_error)

    @property
    def active_corr(self) -> str | None:
        """The corr currently in effect (session or enclosing wrap), if any."""
        stack = self._corr_var.get()
        return stack[-1] if stack else None

    def emit(self, envelope: dict) -> None:
        """Emit an envelope through the configured sink.

        Fire-and-forget: this NEVER raises. Sink failures go to ``on_error``.
        """
        try:
            self._sink(envelope)
        except Exception as err:  # noqa: BLE001 - emit must never propagate
            self._report_error(err, envelope)

    def start_session(self, corr: str | None = None) -> _Session:
        """Open a correlation session. Wraps created while open inherit its corr."""
        session_corr = corr or prefixed_ulid("CONV")
        parent = self._corr_var.get()
        token = self._corr_var.set(parent + (session_corr,))
        return _Session(self, session_corr, token)

    def wrap(
        self,
        to: str,
        intent: str,
        payload: dict | None = None,
        from_: str | None = None,
        corr: str | None = None,
        priority: str | None = None,
        decision_evidence: str | None = None,
    ) -> _Wrap:
        """Return a wrap handle usable as a context manager or decorator.

        Emits a ``task`` on enter and a ``result`` (or ``error`` on exception)
        on exit. The wrap's corr is inherited by any nested wraps.

        ``decision_evidence`` overrides the instance default evidence level for
        this wrap only (spec section 13.2).
        """
        spec: dict = {"to": to, "intent": intent}
        if payload is not None:
            spec["payload"] = payload
        if from_ is not None:
            spec["from"] = from_
        if corr is not None:
            spec["corr"] = corr
        if priority is not None:
            spec["priority"] = priority
        if decision_evidence is not None:
            spec["decision_evidence"] = decision_evidence
        return _Wrap(self, spec)

    def _report_error(self, err: Any, envelope: dict | None = None) -> None:
        try:
            error = err if isinstance(err, Exception) else Exception(str(err))
            self._on_error(error, envelope)
        except Exception:  # noqa: BLE001 - an on_error that throws must not break emission
            pass


def _resolve_sink(sink: Any, opts: dict, on_error: Callable[..., None] | None = None) -> Sink:
    if callable(sink):
        return sink
    if sink == "stdout":
        return create_stdout_sink(opts.get("write"), on_error)
    if sink == "file":
        return create_file_sink(opts.get("path"), on_error)
    if sink == "custom":
        fn = opts.get("fn")
        if not fn:
            raise ValueError("sink 'custom' requires sink_options['fn']")
        return create_custom_sink(fn)
    raise ValueError(f"Unknown sink: {sink}")
