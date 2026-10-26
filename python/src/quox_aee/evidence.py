"""Decision-evidence builder (AEE spec section 13).

Mirrors the TypeScript ``evidence.ts``. Collects the decision-evidence fragment
fields, then emits an object filtered by the configured level per the spec
section 13.2 table:

  none     -> no evidence at all
  minimal  -> decision, reason_summary
  standard -> all fields EXCEPT context_refs
  full     -> all fields, including context_refs

The result is validated against ``decision-evidence.schema.json`` (embedded
below), which has ``additionalProperties: false``. Unknown fields are dropped
(never forwarded) and each drop is surfaced via the ``on_error`` callback.
"""

from __future__ import annotations

import math
from typing import Any, Callable

from .schema import validate_against_schema

EvidenceErrorHandler = Callable[[Exception], None]

# Embedded copy of ``decision-evidence.schema.json`` (kept in sync via drift test).
DECISION_EVIDENCE_SCHEMA: dict = {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "$id": "https://quox.ai/aee/schemas/decision-evidence.schema.json",
    "title": "AEE Decision Evidence Fragment",
    "description": (
        "Reusable schema fragment for structured decision evidence in AEE result "
        "payloads. See AEE spec Section 13."
    ),
    "type": "object",
    "properties": {
        "inputs_used": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Names or identifiers of inputs the agent considered",
        },
        "context_refs": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Locators or IDs of referenced context (envelopes, documents, tools)",
        },
        "tools_used": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Tool names invoked during decision-making",
        },
        "decision": {
            "type": "string",
            "description": "The decision reached (concise statement)",
        },
        "reason_summary": {
            "type": "string",
            "description": "Why this decision was made (1-3 sentences)",
        },
        "action_taken": {
            "type": "string",
            "description": "What the agent did as a result",
        },
        "confidence": {
            "type": "number",
            "minimum": 0,
            "maximum": 1,
            "description": "Agent self-assessed confidence (0 = no confidence, 1 = certain)",
        },
    },
    "additionalProperties": False,
}

# The known evidence fields, in canonical order.
KNOWN_FIELDS = (
    "inputs_used",
    "context_refs",
    "tools_used",
    "decision",
    "reason_summary",
    "action_taken",
    "confidence",
)

# Fields permitted at each level (section 13.2).
LEVEL_FIELDS: dict[str, set[str]] = {
    "none": set(),
    "minimal": {"decision", "reason_summary"},
    "standard": {
        "inputs_used",
        "tools_used",
        "decision",
        "reason_summary",
        "action_taken",
        "confidence",
    },
    "full": set(KNOWN_FIELDS),
}


def _sanitise_confidence(obj: dict, on_error: EvidenceErrorHandler | None) -> None:
    """Remove an invalid ``confidence`` in place, warning via ``on_error``.

    Non-finite (NaN/Infinity) or out-of-range (outside 0..1) values are dropped
    so the object always validates against the decision-evidence schema.
    """
    if "confidence" not in obj:
        return
    c = obj["confidence"]
    if isinstance(c, bool) or not isinstance(c, (int, float)) or not math.isfinite(c):
        del obj["confidence"]
        if on_error:
            on_error(ValueError(f"decision-evidence: dropped non-finite confidence ({c!r})"))
    elif c < 0 or c > 1:
        del obj["confidence"]
        if on_error:
            on_error(
                ValueError(
                    f"decision-evidence: dropped out-of-range confidence {c} (must be 0..1)"
                )
            )


class DecisionEvidenceBuilder:
    def __init__(self, on_error: EvidenceErrorHandler | None = None) -> None:
        self._inputs: list[str] = []
        self._contexts: list[str] = []
        self._tools: list[str] = []
        self._decision: str | None = None
        self._reason: str | None = None
        self._action: str | None = None
        self._conf: float | None = None
        self._on_error = on_error

    def record_input(self, name: str) -> "DecisionEvidenceBuilder":
        if name:
            self._inputs.append(name)
        return self

    def record_context_ref(self, locator: str) -> "DecisionEvidenceBuilder":
        if locator:
            self._contexts.append(locator)
        return self

    def record_tool_call(self, name: str) -> "DecisionEvidenceBuilder":
        if name:
            self._tools.append(name)
        return self

    def record_decision(
        self, decision: str, reason_summary: str | None = None
    ) -> "DecisionEvidenceBuilder":
        self._decision = decision
        if reason_summary is not None:
            self._reason = reason_summary
        return self

    def record_action(self, action_taken: str) -> "DecisionEvidenceBuilder":
        self._action = action_taken
        return self

    def set_confidence(self, confidence: float) -> "DecisionEvidenceBuilder":
        self._conf = confidence
        return self

    def is_empty(self) -> bool:
        """True if nothing has been recorded yet."""
        return (
            len(self._inputs) == 0
            and len(self._contexts) == 0
            and len(self._tools) == 0
            and self._decision is None
            and self._reason is None
            and self._action is None
            and self._conf is None
        )

    def _assemble(self) -> dict:
        """Assemble the full (unfiltered) evidence object from what was recorded."""
        e: dict = {}
        if self._inputs:
            e["inputs_used"] = list(self._inputs)
        if self._contexts:
            e["context_refs"] = list(self._contexts)
        if self._tools:
            e["tools_used"] = list(self._tools)
        if self._decision is not None:
            e["decision"] = self._decision
        if self._reason is not None:
            e["reason_summary"] = self._reason
        if self._action is not None:
            e["action_taken"] = self._action
        if self._conf is not None:
            e["confidence"] = self._conf
        return e

    def build(self, level: str) -> dict | None:
        """Build the level-filtered, schema-valid evidence object.

        Returns ``None`` for level ``none`` (or when nothing was recorded).
        Unknown fields are dropped and warned via ``on_error``; a schema
        violation (e.g. a confidence outside 0..1) also warns via ``on_error``
        but the object is still returned so a bad confidence does not silently
        discard real evidence.
        """
        if level == "none":
            return None

        full = self._assemble()
        allowed = LEVEL_FIELDS[level]
        filtered: dict = {}

        for key, val in full.items():
            if key in allowed:
                filtered[key] = val

        # Drop unknown fields against the schema (defence in depth).
        for key in list(filtered.keys()):
            if key not in KNOWN_FIELDS:
                del filtered[key]
                self._warn(ValueError(f'decision-evidence: dropped unknown field "{key}"'))

        # Confidence integrity: emitted evidence MUST validate. Non-finite or
        # out-of-range confidence is DROPPED (never emitted) with an on_error
        # warning, so one bad confidence cannot yield schema-invalid evidence.
        _sanitise_confidence(filtered, self._on_error)

        if len(filtered) == 0:
            return None

        check = validate_against_schema(DECISION_EVIDENCE_SCHEMA, filtered)
        if not check.valid:
            self._warn(
                ValueError("decision-evidence: schema violation - " + "; ".join(check.errors))
            )

        return filtered

    def _warn(self, err: Exception) -> None:
        if self._on_error:
            self._on_error(err)


def filter_evidence(
    evidence: dict,
    level: str,
    on_error: EvidenceErrorHandler | None = None,
) -> dict | None:
    """Filter a plain evidence object down to a level and validate it.

    Drops unknown fields (warning via ``on_error``). Convenience for callers
    who already hold a complete evidence object rather than building it
    incrementally.
    """
    if level == "none":
        return None
    allowed = LEVEL_FIELDS[level]
    filtered: dict = {}

    for key, val in evidence.items():
        if key not in KNOWN_FIELDS:
            if on_error:
                on_error(ValueError(f'decision-evidence: dropped unknown field "{key}"'))
            continue
        if key in allowed:
            filtered[key] = val

    _sanitise_confidence(filtered, on_error)

    if len(filtered) == 0:
        return None
    check = validate_against_schema(DECISION_EVIDENCE_SCHEMA, filtered)
    if not check.valid and on_error:
        on_error(ValueError("decision-evidence: schema violation - " + "; ".join(check.errors)))
    return filtered
