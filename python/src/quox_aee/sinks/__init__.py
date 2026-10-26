"""Sinks: where emitted envelopes go.

Mirrors the TypeScript ``sinks/index.ts``. A sink is any callable
``(envelope) -> None``. The capture layer's ``emit()`` wraps sink invocation so
it is fire-and-forget and NEVER raises: failures are routed to the configured
``on_error`` callback.

Bundled sinks (all local, zero network):
  - stdout: one JSON line per envelope to stdout
  - file:   NDJSON append to a path, creating the parent directory
  - custom: any user-supplied callable
"""

from __future__ import annotations

import json
import math
import os
import sys
from typing import Any, Callable

Sink = Callable[[dict], None]
OnError = Callable[[Exception], None]

DEFAULT_FILE_PATH = "./aee-envelopes.ndjson"


def _sanitise_non_finite(value: Any, on_error: OnError | None) -> Any:
    """Recursively replace non-finite numbers (NaN/Infinity) with ``None``.

    Matches TypeScript ``JSON.stringify`` semantics, which renders NaN/Infinity
    as ``null``. Each replacement fires an ``on_error`` warning. ``bool`` is left
    untouched (it is a valid JSON literal, not a non-finite number).
    """
    if isinstance(value, float) and not math.isfinite(value):
        if on_error:
            on_error(ValueError(f"non-finite number {value!r} replaced with null in NDJSON output"))
        return None
    if isinstance(value, dict):
        return {k: _sanitise_non_finite(v, on_error) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_sanitise_non_finite(v, on_error) for v in value]
    return value


def to_ndjson_line(envelope: dict, on_error: OnError | None = None) -> str:
    """Serialise an envelope to a single NDJSON line (trailing newline included).

    Any non-finite number anywhere in the envelope is replaced with ``null``
    (with an ``on_error`` warning), and ``allow_nan=False`` guarantees the output
    is never the invalid JSON ``NaN``/``Infinity`` literal. This matches the
    TypeScript ``JSON.stringify`` behaviour byte-for-byte.
    """
    sanitised = _sanitise_non_finite(envelope, on_error)
    return json.dumps(sanitised, separators=(",", ":"), allow_nan=False) + "\n"


def create_stdout_sink(
    write: Callable[[str], None] | None = None, on_error: OnError | None = None
) -> Sink:
    """Write each envelope as one JSON line to stdout (or a supplied writer)."""
    _write = write if write is not None else (lambda line: sys.stdout.write(line))

    def sink(envelope: dict) -> None:
        _write(to_ndjson_line(envelope, on_error))

    return sink


def create_file_sink(path: str | None = None, on_error: OnError | None = None) -> Sink:
    """Append each envelope as an NDJSON line, creating the parent dir if missing."""
    file_path = path or DEFAULT_FILE_PATH
    state = {"dir_ensured": False}

    def sink(envelope: dict) -> None:
        if not state["dir_ensured"]:
            directory = os.path.dirname(file_path)
            if directory and directory != ".":
                os.makedirs(directory, exist_ok=True)
            state["dir_ensured"] = True
        with open(file_path, "a", encoding="utf8") as f:
            f.write(to_ndjson_line(envelope, on_error))

    return sink


def create_custom_sink(fn: Sink) -> Sink:
    """Wrap a user-supplied callable as a sink (identity, for symmetry)."""
    if not callable(fn):
        raise ValueError("custom sink requires a callable")
    return fn
