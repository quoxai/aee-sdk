from unittest.mock import MagicMock

from quox_aee import (
    DECISION_EVIDENCE_SCHEMA,
    DecisionEvidenceBuilder,
    filter_evidence,
    validate_against_schema,
)


def full_builder(on_error=None):
    b = DecisionEvidenceBuilder(on_error)
    (
        b.record_input("backup-host-01 job log")
        .record_input("compute-node-02 health check")
        .record_context_ref("store://envelopes/abc")
        .record_tool_call("ssh.exec")
        .record_tool_call("pbs.job.list")
        .record_decision("PARTIAL_FAILURE", "compute-node-02 refused connection")
        .record_action("Returned failed node details")
        .set_confidence(0.92)
    )
    return b


class TestDecisionEvidenceBuilderLevels:
    def test_none_yields_none(self):
        assert full_builder().build("none") is None

    def test_minimal_yields_decision_and_reason_only(self):
        assert full_builder().build("minimal") == {
            "decision": "PARTIAL_FAILURE",
            "reason_summary": "compute-node-02 refused connection",
        }

    def test_standard_yields_all_except_context_refs(self):
        e = full_builder().build("standard")
        assert "context_refs" not in e
        assert e["inputs_used"] == ["backup-host-01 job log", "compute-node-02 health check"]
        assert e["tools_used"] == ["ssh.exec", "pbs.job.list"]
        assert e["decision"] == "PARTIAL_FAILURE"
        assert e["action_taken"] == "Returned failed node details"
        assert e["confidence"] == 0.92

    def test_full_yields_all_including_context_refs(self):
        e = full_builder().build("full")
        assert e["context_refs"] == ["store://envelopes/abc"]
        assert "inputs_used" in e

    def test_returns_none_when_nothing_recorded(self):
        assert DecisionEvidenceBuilder().build("full") is None
        assert DecisionEvidenceBuilder().is_empty() is True

    def test_drops_out_of_range_confidence_and_warns_stays_schema_valid(self):
        on_error = MagicMock()
        b = DecisionEvidenceBuilder(on_error)
        b.record_decision("d", "r").set_confidence(1.5)
        e = b.build("standard")
        on_error.assert_called()
        msg = str(on_error.call_args[0][0])
        assert "out-of-range" in msg or "dropped" in msg
        assert "confidence" not in e
        assert e["decision"] == "d"
        assert validate_against_schema(DECISION_EVIDENCE_SCHEMA, e).valid is True

    def test_rejects_nan_confidence_and_drops_it(self):
        on_error = MagicMock()
        b = DecisionEvidenceBuilder(on_error)
        b.record_decision("d", "r").set_confidence(float("nan"))
        e = b.build("standard")
        on_error.assert_called()
        assert "non-finite" in str(on_error.call_args[0][0]).lower() or "nan" in str(
            on_error.call_args[0][0]
        ).lower()
        assert "confidence" not in e
        assert validate_against_schema(DECISION_EVIDENCE_SCHEMA, e).valid is True

    def test_rejects_infinity_confidence_and_drops_it(self):
        on_error = MagicMock()
        b = DecisionEvidenceBuilder(on_error)
        b.record_decision("d", "r").set_confidence(float("inf"))
        e = b.build("standard")
        on_error.assert_called()
        assert "confidence" not in e
        assert validate_against_schema(DECISION_EVIDENCE_SCHEMA, e).valid is True

    def test_returns_none_when_lone_invalid_confidence(self):
        on_error = MagicMock()
        b = DecisionEvidenceBuilder(on_error)
        b.set_confidence(float("nan"))
        assert b.build("standard") is None
        on_error.assert_called()


class TestFilterEvidence:
    FULL = {
        "inputs_used": ["a"],
        "context_refs": ["c"],
        "tools_used": ["t"],
        "decision": "d",
        "reason_summary": "r",
        "action_taken": "act",
        "confidence": 0.5,
    }

    def test_none_yields_none(self):
        assert filter_evidence(dict(self.FULL), "none") is None

    def test_standard_drops_context_refs(self):
        e = filter_evidence(dict(self.FULL), "standard")
        assert "context_refs" not in e
        assert e["decision"] == "d"

    def test_drops_unknown_fields_and_warns(self):
        on_error = MagicMock()
        e = filter_evidence({**self.FULL, "bogus": "x"}, "full", on_error)
        assert "bogus" not in e
        on_error.assert_called()
        assert "dropped unknown field" in str(on_error.call_args[0][0])

    def test_returns_none_when_filtered_result_empty(self):
        assert filter_evidence({"context_refs": ["c"]}, "minimal") is None
