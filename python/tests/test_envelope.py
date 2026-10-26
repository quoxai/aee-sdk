import re

from quox_aee import (
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

ULID_RE = re.compile(r"^[0-9A-HJKMNP-TV-Z]{26}$")


class TestCreateEnvelope:
    def test_sets_v_id_ts_and_mints_corr(self):
        e = create_envelope(type="task", from_="a", to="b", intent="x.y")
        assert e["v"] == PROTOCOL_VERSION
        assert ULID_RE.match(e["id"])
        assert e["ts"]
        assert e["corr"].startswith("CONV_")

    def test_defaults_priority_to_normal(self):
        e = create_envelope(type="task", from_="a", to="b", intent="x.y")
        assert e["priority"] == "normal"

    def test_honours_explicit_priority(self):
        e = create_envelope(type="task", from_="a", to="b", intent="x.y", priority="urgent")
        assert e["priority"] == "urgent"

    def test_defaults_reply_to_null_for_task_event_stream(self):
        for t in ("task", "event", "stream"):
            e = create_envelope(type=t, from_="a", to="b", intent="x.y")
            assert e["reply_to"] is None

    def test_falls_back_reply_to_own_id_for_result_error(self):
        for t in ("result", "error"):
            e = create_envelope(type=t, from_="a", to="b", intent="x.y")
            assert e["reply_to"] == e["id"]
            assert validate(e).valid is True

    def test_uses_explicit_reply_to_for_result(self):
        e = create_envelope(
            type="result", from_="a", to="b", intent="x.y", reply_to="01JFB2R1JZKQ9V3K8W8Y9W1F2A"
        )
        assert e["reply_to"] == "01JFB2R1JZKQ9V3K8W8Y9W1F2A"

    def test_warns_via_on_error_when_own_id_fallback_fires(self):
        from unittest.mock import MagicMock

        for t in ("result", "error"):
            on_error = MagicMock()
            e = create_envelope(type=t, from_="a", to="b", intent="x.y", on_error=on_error)
            assert e["reply_to"] == e["id"]
            on_error.assert_called_once()
            msg = str(on_error.call_args[0][0])
            assert "reply_to" in msg or "own id" in msg or "orphan" in msg

    def test_no_warning_when_explicit_reply_to_supplied(self):
        from unittest.mock import MagicMock

        on_error = MagicMock()
        create_envelope(
            type="result",
            from_="a",
            to="b",
            intent="x.y",
            reply_to="01JFB2R1JZKQ9V3K8W8Y9W1F2A",
            on_error=on_error,
        )
        on_error.assert_not_called()

    def test_on_error_control_field_not_in_envelope(self):
        from unittest.mock import MagicMock

        e = create_envelope(type="result", from_="a", to="b", intent="x.y", on_error=MagicMock())
        assert "on_error" not in e

    def test_defaults_payload_to_empty_object(self):
        e = create_envelope(type="task", from_="a", to="b", intent="x.y")
        assert e["payload"] == {}

    def test_preserves_unknown_extension_fields(self):
        e = create_envelope(
            type="task", from_="a", to="b", intent="x.y", trace={"trace_id": "t"}, x_vendor=42
        )
        assert e["trace"] == {"trace_id": "t"}
        assert e["x_vendor"] == 42

    def test_extension_field_cannot_clobber_reserved_field(self):
        e = create_envelope(type="task", from_="a", to="b", intent="x.y", v="9", id="HACK")
        assert e["v"] == PROTOCOL_VERSION
        assert e["id"] != "HACK"

    def test_respects_explicit_corr(self):
        e = create_envelope(type="task", from_="a", to="b", intent="x.y", corr="CONV_explicit_corr_value")
        assert e["corr"] == "CONV_explicit_corr_value"

    def test_produces_schema_valid_envelopes_for_every_type(self):
        for t in ENVELOPE_TYPES:
            e = create_envelope(type=t, from_="a", to="b", intent="x.y")
            assert validate(e).valid is True


class TestCreateTask:
    def test_creates_a_valid_task(self):
        t = create_task("human.adam", "agent.b", "ops.do.thing", {"k": 1})
        assert t["type"] == "task"
        assert t["from"] == "human.adam"
        assert t["to"] == "agent.b"
        assert t["payload"] == {"k": 1}
        assert t["reply_to"] is None
        assert validate(t).valid is True

    def test_accepts_corr_and_options(self):
        t = create_task("a", "b", "ops.do.thing", {}, "CONV_shared_corr_val", {"priority": "high"})
        assert t["corr"] == "CONV_shared_corr_val"
        assert t["priority"] == "high"


class TestCreateResult:
    def _task(self):
        return create_task("human.adam", "agent.b", "ops.status.query", {"k": 1}, "CONV_result_corr_value")

    def test_swaps_from_to_and_threads_reply_to(self):
        task = self._task()
        r = create_result(task, {"done": True})
        assert r["type"] == "result"
        assert r["from"] == task["to"]
        assert r["to"] == task["from"]
        assert r["reply_to"] == task["id"]
        assert r["corr"] == task["corr"]
        assert validate(r).valid is True

    def test_rewrites_query_to_response(self):
        r = create_result(self._task(), {})
        assert r["intent"] == "ops.status.response"

    def test_keeps_non_query_intent_unchanged(self):
        t2 = create_task("a", "b", "ops.backup.status.check", {}, "CONV_result_corr_two")
        r = create_result(t2, {})
        assert r["intent"] == "ops.backup.status.check"


class TestCreateEvent:
    def test_broadcasts_to_system_with_null_reply_to(self):
        e = create_event("agent.monitor", "obs.metric.report", {"cpu": 10})
        assert e["type"] == "event"
        assert e["to"] == "system"
        assert e["reply_to"] is None
        assert validate(e).valid is True


class TestCreateError:
    def _task(self):
        return create_task("human.adam", "agent.b", "ops.status.query", {}, "CONV_error_corr_value")

    def test_builds_error_replying_to_task(self):
        err = create_error(self._task(), {"code": "E_TIMEOUT", "message": "timed out"})
        assert err["type"] == "error"
        assert err["intent"] == "aee.protocol.error"
        task = self._task()
        assert err["from"] == task["to"]
        assert err["to"] == task["from"]
        assert validate(err).valid is True

    def test_populates_standard_error_payload_shape(self):
        task = self._task()
        err = create_error(task, {"code": "E1", "message": "boom", "details": {"a": 1}})
        assert err["payload"]["error_code"] == "E1"
        assert err["payload"]["error_message"] == "boom"
        assert err["payload"]["details"] == {"a": 1}
        assert err["payload"]["original_intent"] == "ops.status.query"

    def test_applies_defaults_for_missing_code_message(self):
        err = create_error(self._task(), {})
        assert err["payload"]["error_code"] == "UNKNOWN"
        assert err["payload"]["error_message"] == "An unknown error occurred"

    def test_reply_to_points_to_task_id(self):
        task = self._task()
        err = create_error(task, {"code": "E", "message": "m"})
        assert err["reply_to"] == task["id"]


class TestValidate:
    def _good(self):
        return create_task("a", "b", "ops.ping.check", {}, "CONV_validate_corr_val")

    def test_accepts_well_formed_envelope(self):
        r = validate(self._good())
        assert r.valid is True
        assert r.errors == []

    def test_rejects_non_object(self):
        assert validate(None).valid is False
        assert validate([]).valid is False
        assert validate("x").valid is False

    def test_flags_missing_required_field(self):
        e = self._good()
        del e["priority"]
        r = validate(e)
        assert r.valid is False
        assert "priority" in " ".join(r.errors)

    def test_flags_bad_version_const(self):
        e = self._good()
        e["v"] = "2"
        assert validate(e).valid is False

    def test_flags_out_of_enum_type(self):
        e = self._good()
        e["type"] = "bogus"
        assert validate(e).valid is False

    def test_flags_out_of_enum_priority(self):
        e = self._good()
        e["priority"] = "critical"
        assert validate(e).valid is False

    def test_enforces_non_null_reply_to_for_result(self):
        e = self._good()
        e["type"] = "result"
        e["reply_to"] = None
        assert validate(e).valid is False

    def test_enforces_reply_to_min_length_for_error(self):
        e = self._good()
        e["type"] = "error"
        e["reply_to"] = "short"
        assert validate(e).valid is False

    def test_rejects_array_payload(self):
        e = self._good()
        e["payload"] = []
        assert validate(e).valid is False

    def test_rejects_too_short_corr_and_intent(self):
        e = self._good()
        e["corr"] = "short"
        assert validate(e).valid is False
        e2 = self._good()
        e2["intent"] = "ab"
        assert validate(e2).valid is False

    def test_rejects_empty_from_to(self):
        e = self._good()
        e["from"] = ""
        assert validate(e).valid is False
        e2 = self._good()
        e2["to"] = ""
        assert validate(e2).valid is False

    def test_is_aee_envelope_type_guard(self):
        assert is_aee_envelope(self._good()) is True
        assert is_aee_envelope({}) is False


class TestExportedConstants:
    def test_exposes_type_and_priority_vocabularies(self):
        assert list(ENVELOPE_TYPES) == ["task", "result", "event", "error", "stream"]
        assert list(PRIORITY_LEVELS) == ["low", "normal", "high", "urgent"]
