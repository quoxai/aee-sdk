"""Minimal, zero-dependency JSON Schema validator.

Mirrors the TypeScript ``schema.ts``. Supports exactly the keyword subset used
by the two AEE schemas (``aee-v1.schema.json`` and
``decision-evidence.schema.json``): ``type`` (string | list), ``const``,
``enum``, ``minLength``, ``minimum``, ``maximum``, ``required``, ``properties``,
``additionalProperties`` (boolean), ``items``, ``allOf``, ``if``/``then``/``else``.

This keeps the SDK core dependency-free while remaining genuinely schema-backed:
it evaluates the schema document itself, so the same JSON file that is the
cross-language contract is what drives validation. It is NOT a general-purpose
JSON Schema engine.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any


@dataclass
class ValidationResult:
    valid: bool
    errors: list[str] = field(default_factory=list)


def _json_type(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, list):
        return "array"
    if isinstance(value, str):
        return "string"
    if isinstance(value, int):
        return "integer"
    if isinstance(value, float):
        return "integer" if value.is_integer() else "number"
    if isinstance(value, dict):
        return "object"
    return type(value).__name__


def _matches_type(value: Any, expected: str) -> bool:
    actual = _json_type(value)
    if expected == "number":
        return actual in ("number", "integer")
    if expected == "object":
        return actual == "object"
    return actual == expected


def _type_ok(value: Any, type_: Any) -> bool:
    types = type_ if isinstance(type_, list) else [type_]
    return any(_matches_type(value, t) for t in types)


def _deep_equal(a: Any, b: Any) -> bool:
    if a is b:
        return True
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    if isinstance(a, (dict, list)) and isinstance(b, (dict, list)):
        return json.dumps(a) == json.dumps(b)
    if type(a) is not type(b):
        return False
    return a == b


def _satisfies(schema: dict, value: Any) -> bool:
    """Does ``value`` satisfy ``schema``? Used for if/then conditionals."""
    return _validate_node(schema, value, "").valid


def _validate_node(schema: dict, value: Any, path: str) -> ValidationResult:
    errors: list[str] = []
    at = path or "(root)"

    if "type" in schema:
        if not _type_ok(value, schema["type"]):
            errors.append(
                f"{at}: expected type {json.dumps(schema['type'])}, got {_json_type(value)}"
            )
            # Type mismatch: further keyword checks would be noise.
            return ValidationResult(False, errors)

    if "const" in schema and not _deep_equal(value, schema["const"]):
        errors.append(f"{at}: must equal {json.dumps(schema['const'])}")

    if "enum" in schema and isinstance(schema["enum"], list):
        if not any(_deep_equal(value, e) for e in schema["enum"]):
            errors.append(f"{at}: must be one of {json.dumps(schema['enum'])}")

    if isinstance(value, str):
        min_length = schema.get("minLength")
        if isinstance(min_length, (int, float)) and not isinstance(min_length, bool):
            if len(value) < min_length:
                errors.append(f"{at}: string shorter than minLength {min_length}")

    if isinstance(value, (int, float)) and not isinstance(value, bool):
        minimum = schema.get("minimum")
        if isinstance(minimum, (int, float)) and not isinstance(minimum, bool):
            if value < minimum:
                errors.append(f"{at}: {value} is below minimum {minimum}")
        maximum = schema.get("maximum")
        if isinstance(maximum, (int, float)) and not isinstance(maximum, bool):
            if value > maximum:
                errors.append(f"{at}: {value} is above maximum {maximum}")

    if isinstance(value, list) and isinstance(schema.get("items"), dict):
        for i, item in enumerate(value):
            r = _validate_node(schema["items"], item, f"{at}[{i}]")
            errors.extend(r.errors)

    if _json_type(value) == "object":
        obj = value
        props = schema.get("properties") or {}

        if isinstance(schema.get("required"), list):
            for key in schema["required"]:
                if key not in obj:
                    errors.append(f'{at}: missing required property "{key}"')

        for key, val in obj.items():
            if key in props:
                r = _validate_node(props[key], val, f"{path}.{key}" if path else key)
                errors.extend(r.errors)
            elif schema.get("additionalProperties") is False:
                errors.append(f'{at}: additional property "{key}" is not allowed')

    if isinstance(schema.get("allOf"), list):
        for sub in schema["allOf"]:
            # if/then/else within an allOf entry.
            if "if" in sub:
                condition = sub["if"]
                if _satisfies(condition, value):
                    if sub.get("then"):
                        r = _validate_node(sub["then"], value, path)
                        errors.extend(r.errors)
                elif sub.get("else"):
                    r = _validate_node(sub["else"], value, path)
                    errors.extend(r.errors)
            else:
                r = _validate_node(sub, value, path)
                errors.extend(r.errors)

    return ValidationResult(len(errors) == 0, errors)


def validate_against_schema(schema: dict, value: Any) -> ValidationResult:
    """Validate ``value`` against ``schema``, returning a ``ValidationResult``."""
    return _validate_node(schema, value, "")
