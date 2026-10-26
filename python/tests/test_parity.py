"""Cross-language parity check.

Generates an envelope in Python, validates it against the VENDORED
``aee-v1.schema.json`` (the same file the TypeScript suite validates against),
and asserts field-for-field shape parity with the documented TypeScript output
shape. Both languages MUST emit exactly these top-level keys:

    v, id, ts, type, from, to, intent, corr, reply_to, priority, payload
"""

from quox_aee import create_task, validate_against_schema

from conftest import CONFORMANCE_DIR, load_json

# The documented TS envelope output shape (envelope.ts createEnvelope): a
# fully-formed envelope always carries exactly these 11 top-level keys.
DOCUMENTED_TS_KEYS = [
    "v",
    "id",
    "ts",
    "type",
    "from",
    "to",
    "intent",
    "corr",
    "reply_to",
    "priority",
    "payload",
]


def test_python_envelope_validates_against_vendored_schema():
    schema = load_json(CONFORMANCE_DIR / "aee-v1.schema.json")
    envelope = create_task("human.adam", "agent.reviewer", "code.review.request", {"pr": 42})
    result = validate_against_schema(schema, envelope)
    assert result.errors == []
    assert result.valid is True


def test_python_envelope_shape_matches_documented_ts_output():
    envelope = create_task("human.adam", "agent.reviewer", "code.review.request", {"pr": 42})
    # Field-for-field: the base envelope has exactly the documented keys, no more.
    assert sorted(envelope.keys()) == sorted(DOCUMENTED_TS_KEYS)


def test_python_envelope_field_types_match_spec():
    envelope = create_task("human.adam", "agent.reviewer", "code.review.request", {"pr": 42})
    assert envelope["v"] == "1"
    assert isinstance(envelope["id"], str)
    assert isinstance(envelope["ts"], str)
    assert envelope["type"] == "task"
    assert envelope["from"] == "human.adam"
    assert envelope["to"] == "agent.reviewer"
    assert envelope["intent"] == "code.review.request"
    assert isinstance(envelope["corr"], str)
    # task has null reply_to; priority defaults to normal; payload is an object.
    assert envelope["reply_to"] is None
    assert envelope["priority"] == "normal"
    assert envelope["payload"] == {"pr": 42}


def test_result_envelope_also_carries_documented_keys():
    task = create_task("human.adam", "agent.reviewer", "code.review.query", {"pr": 42})
    from quox_aee import create_result

    result = create_result(task, {"verdict": "approved"})
    assert sorted(result.keys()) == sorted(DOCUMENTED_TS_KEYS)
    # result threads reply_to to the task id (non-null, unlike task).
    assert result["reply_to"] == task["id"]
