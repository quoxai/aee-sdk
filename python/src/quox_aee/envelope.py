"""AEE envelope factory + validation.

Mirrors the TypeScript ``envelope.ts`` (itself a port of quox-dashboard
``src/lib/aee/envelope.js`` + ``types.js``), plus the spec deltas required for
the SDK to conform to the canonical spec schema (``aee-v1.schema.json``,
spec section 6):

  - ``priority`` is emitted with a default of ``"normal"`` (spec REQUIRED field
    the internal lib omitted).
  - ``reply_to`` is conditionally enforced: it MUST be a non-null string for
    ``result``/``error`` envelopes. A ``result``/``error`` with no explicit
    predecessor falls back to the envelope's OWN id (root of its own thread) so
    it is always schema-valid. For other types ``reply_to`` defaults to ``None``.
  - Unknown/extension fields are PRESERVED (spec section 5/7: unknown fields
    MUST NOT be stripped), via ``**ext``.

Every envelope produced here validates against BOTH the spec schema and the
stricter internal validators.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from .schema import ValidationResult, validate_against_schema
from .ulid import prefixed_ulid, ulid

PROTOCOL_VERSION = "1"
ENVELOPE_TYPES = ("task", "result", "event", "error", "stream")
PRIORITY_LEVELS = ("low", "normal", "high", "urgent")

# The canonical AEE v1 envelope schema (spec section 6), embedded so the SDK
# core is self-contained and dependency-free. Kept byte-for-byte in sync with
# ``conformance/aee-v1.schema.json``; a drift test asserts equality.
AEE_V1_SCHEMA: dict = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://example.org/aee/aee-v1.schema.json",
    "title": "AEE v1 Envelope",
    "type": "object",
    "additionalProperties": True,
    "required": ["v", "id", "ts", "type", "from", "to", "intent", "corr", "priority", "payload"],
    "properties": {
        "v": {"type": "string", "const": "1"},
        "id": {"type": "string", "minLength": 8},
        "ts": {"type": "string", "minLength": 10},
        "type": {"type": "string", "enum": ["task", "result", "event", "error", "stream"]},
        "from": {"type": "string", "minLength": 1},
        "to": {"type": "string", "minLength": 1},
        "intent": {"type": "string", "minLength": 3},
        "corr": {"type": "string", "minLength": 8},
        "reply_to": {"type": ["string", "null"]},
        "trace": {
            "type": ["object", "null"],
            "additionalProperties": True,
            "properties": {
                "trace_id": {"type": "string"},
                "span_id": {"type": "string"},
            },
        },
        "priority": {"type": "string", "enum": ["low", "normal", "high", "urgent"]},
        "requires": {"type": ["object", "null"], "additionalProperties": True},
        "payload": {"type": "object", "additionalProperties": True},
        "sig": {"type": ["object", "string", "null"], "additionalProperties": True},
    },
    "allOf": [
        {
            "if": {"properties": {"type": {"enum": ["result", "error"]}}},
            "then": {
                "required": ["reply_to"],
                "properties": {"reply_to": {"type": "string", "minLength": 8}},
            },
        }
    ],
}

_RESERVED_KEYS = {
    "type",
    "from_",
    "from",
    "to",
    "intent",
    "corr",
    "reply_to",
    "replyTo",
    "payload",
    "priority",
    "on_error",
}


def create_envelope(
    type: str,
    from_: str,
    to: str,
    intent: str,
    corr: str | None = None,
    reply_to: str | None = None,
    payload: dict | None = None,
    priority: str = "normal",
    on_error: Any = None,
    **ext: Any,
) -> dict:
    """Layer-1 primitive: build a fully-formed, spec-conformant envelope.

    Pure function: no I/O, no state. ``from_`` maps to the envelope's ``from``
    field (``from`` is a reserved word in Python). Any additional keyword
    arguments are preserved as extension fields. ``on_error`` is an optional
    warning hook (not part of the emitted envelope) fired when the last-resort
    own-id ``reply_to`` fallback is used.
    """
    if payload is None:
        payload = {}

    id_ = ulid()

    # Conditional reply_to: result/error MUST be non-null. Fall back to own id
    # when no explicit predecessor was supplied. This is a LAST RESORT for orphan
    # results/errors and is surfaced via on_error so it is never silent.
    if type in ("result", "error"):
        if reply_to is not None:
            resolved_reply_to: str | None = reply_to
        else:
            resolved_reply_to = id_
            if on_error:
                on_error(
                    ValueError(
                        f"aee: {type} envelope has no predecessor; reply_to fell back to its "
                        f"own id ({id_}) as a last resort for an orphan {type}. Supply "
                        f"reply_to to thread it correctly."
                    )
                )
    else:
        resolved_reply_to = reply_to if reply_to is not None else None

    envelope: dict = {
        "v": PROTOCOL_VERSION,
        "id": id_,
        "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "type": type,
        "from": from_,
        "to": to,
        "intent": intent,
        "corr": corr or prefixed_ulid("CONV"),
        "reply_to": resolved_reply_to,
        "priority": priority,
        "payload": payload,
    }

    # Preserve unknown/extension fields (spec: unknown fields MUST NOT be
    # stripped). Never let an extension key clobber a reserved envelope field.
    for k, val in ext.items():
        if k not in _RESERVED_KEYS and k not in envelope:
            envelope[k] = val

    return envelope


def create_task(
    from_: str,
    to: str,
    intent: str,
    payload: dict | None = None,
    corr: str | None = None,
    options: dict | None = None,
) -> dict:
    """Create a TASK envelope (request expecting a response)."""
    options = options or {}
    return create_envelope(
        type="task", from_=from_, to=to, intent=intent, corr=corr, payload=payload, **options
    )


def create_result(
    reply_to: dict,
    payload: dict | None = None,
    options: dict | None = None,
) -> dict:
    """Create a RESULT envelope (response to a task).

    Swaps from/to, threads ``reply_to`` to the task id, and inherits the task's
    corr. The result intent defaults to the task intent with a
    ``.query`` -> ``.response`` rewrite (a no-op for intents without ``.query``).
    """
    options = options or {}
    response_intent = reply_to["intent"].replace(".query", ".response", 1)
    return create_envelope(
        type="result",
        from_=reply_to["to"],
        to=reply_to["from"],
        intent=response_intent,
        corr=reply_to["corr"],
        reply_to=reply_to["id"],
        payload=payload,
        **options,
    )


def create_event(
    from_: str,
    intent: str,
    payload: dict | None = None,
    corr: str | None = None,
    options: dict | None = None,
) -> dict:
    """Create an EVENT envelope (broadcast notification, no reply)."""
    options = options or {}
    return create_envelope(
        type="event", from_=from_, to="system", intent=intent, corr=corr, payload=payload, **options
    )


def create_error(
    reply_to: dict,
    error: dict,
    options: dict | None = None,
) -> dict:
    """Create an ERROR envelope in reply to an envelope.

    ``error`` may carry ``code``, ``message``, and ``details``.
    """
    options = options or {}
    return create_envelope(
        type="error",
        from_=reply_to["to"],
        to=reply_to["from"],
        intent="aee.protocol.error",
        corr=reply_to["corr"],
        reply_to=reply_to["id"],
        payload={
            "error_code": error.get("code") or "UNKNOWN",
            "error_message": error.get("message") or "An unknown error occurred",
            "details": error.get("details") or {},
            "original_intent": reply_to["intent"],
        },
        **options,
    )


def validate(envelope: Any) -> ValidationResult:
    """Validate an envelope against the canonical AEE v1 schema (spec section 6).

    Includes the conditional ``reply_to`` requirement for result/error.
    """
    if envelope is None or not isinstance(envelope, dict):
        return ValidationResult(False, ["Envelope must be a non-null object"])
    return validate_against_schema(AEE_V1_SCHEMA, envelope)


def is_aee_envelope(obj: Any) -> bool:
    """Type guard: is ``obj`` a valid AEE envelope?"""
    return validate(obj).valid
