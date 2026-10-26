"""quox-aee - framework-agnostic capture SDK for the AEE protocol.

Layer 1 - pure envelope functions (no I/O, no state).
Layer 2 - capture (AEE.init / wrap / CaptureContext).
"""

from __future__ import annotations

from .capture import AEE, CaptureContext
from .envelope import (
    AEE_V1_SCHEMA,
    ENVELOPE_TYPES,
    PRIORITY_LEVELS,
    PROTOCOL_VERSION,
    create_envelope,
    create_error,
    create_event,
    create_result,
    create_task,
    is_aee_envelope,
    validate,
)
from .evidence import (
    DECISION_EVIDENCE_SCHEMA,
    DecisionEvidenceBuilder,
    filter_evidence,
)
from .schema import ValidationResult, validate_against_schema
from .sinks import (
    create_custom_sink,
    create_file_sink,
    create_stdout_sink,
    to_ndjson_line,
)
from .ulid import (
    compare_ulid,
    is_valid_ulid,
    prefixed_ulid,
    ulid,
    ulid_time,
)

__version__ = "0.1.0"

__all__ = [
    # ULID
    "ulid",
    "ulid_time",
    "is_valid_ulid",
    "prefixed_ulid",
    "compare_ulid",
    # Envelope factory + validation
    "PROTOCOL_VERSION",
    "ENVELOPE_TYPES",
    "PRIORITY_LEVELS",
    "AEE_V1_SCHEMA",
    "create_envelope",
    "create_task",
    "create_result",
    "create_event",
    "create_error",
    "validate",
    "is_aee_envelope",
    # Schema validation primitive
    "validate_against_schema",
    "ValidationResult",
    # Decision evidence
    "DecisionEvidenceBuilder",
    "filter_evidence",
    "DECISION_EVIDENCE_SCHEMA",
    # Sinks
    "create_stdout_sink",
    "create_file_sink",
    "create_custom_sink",
    "to_ndjson_line",
    # Capture layer
    "AEE",
    "CaptureContext",
    "__version__",
]
