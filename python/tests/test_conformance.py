"""Full conformance sweep against the SHARED cross-language fixture files.

These consume the identical JSON files under ``../conformance/fixtures`` that
the TypeScript suite consumes, proving cross-language parity of validation
semantics.
"""

import pytest

from quox_aee import (
    AEE_V1_SCHEMA,
    DECISION_EVIDENCE_SCHEMA,
    filter_evidence,
    validate,
)

from conftest import CONFORMANCE_DIR, FIXTURES_DIR, files_in, load_json

VALID_DIR = FIXTURES_DIR / "valid"
INVALID_DIR = FIXTURES_DIR / "invalid"
EVIDENCE_DIR = FIXTURES_DIR / "evidence-levels"

VALID_FILES = files_in(VALID_DIR)
INVALID_FILES = files_in(INVALID_DIR)
EVIDENCE_FILES = files_in(EVIDENCE_DIR)


def test_has_at_least_15_valid_fixtures():
    assert len(VALID_FILES) >= 15


@pytest.mark.parametrize("path", VALID_FILES, ids=lambda p: p.name)
def test_valid_fixture_validates(path):
    fixture = load_json(path)
    result = validate(fixture["envelope"])
    assert result.errors == []
    assert result.valid is True


def test_has_at_least_20_invalid_fixtures():
    assert len(INVALID_FILES) >= 20


@pytest.mark.parametrize("path", INVALID_FILES, ids=lambda p: p.name)
def test_invalid_fixture_rejected(path):
    fixture = load_json(path)
    assert fixture.get("violates"), f"{path.name} must name the violated rule"
    assert validate(fixture["envelope"]).valid is False


def test_has_evidence_level_fixtures():
    assert len(EVIDENCE_FILES) >= 4


@pytest.mark.parametrize("path", EVIDENCE_FILES, ids=lambda p: p.name)
def test_evidence_level_fixture_filters_to_expected(path):
    fx = load_json(path)
    got = filter_evidence(dict(fx["input"]), fx["level"])
    assert got == fx["expected"]


class TestSpecConformanceBullets:
    def test_accepts_sample_messages_from_spec_section_4(self):
        for name in (
            "01-spec-section-4.1-task.json",
            "02-spec-section-4.2-result.json",
            "03-spec-section-4.3-error.json",
        ):
            fx = load_json(VALID_DIR / name)
            assert validate(fx["envelope"]).valid is True

    def test_rejects_messages_missing_required_fields(self):
        fx = load_json(INVALID_DIR / "09-missing-priority.json")
        assert validate(fx["envelope"]).valid is False

    def test_enforces_reply_to_for_result_and_error(self):
        for name in ("14-result-reply_to-null.json", "15-error-reply_to-null.json"):
            fx = load_json(INVALID_DIR / name)
            assert validate(fx["envelope"]).valid is False

    def test_documents_orphan_own_id_reply_to_fallback_edge_case(self):
        fx = load_json(VALID_DIR / "12-error-orphan-reply_to-self-fallback.json")
        # The renamed fixture carries a _comment explaining the edge-case nature.
        assert fx.get("_comment")
        assert fx["envelope"]["type"] == "error"
        # Self-referential reply_to: the last-resort fallback for an orphan error.
        assert fx["envelope"]["reply_to"] == fx["envelope"]["id"]
        assert validate(fx["envelope"]).valid is True

    def test_preserves_unknown_fields(self):
        fx = load_json(VALID_DIR / "09-task-with-unknown-extension-field.json")
        assert "x_vendor_field" in fx["envelope"]
        assert validate(fx["envelope"]).valid is True


class TestSchemaDrift:
    def test_embedded_aee_v1_schema_matches_vendored_copy(self):
        vendored = load_json(CONFORMANCE_DIR / "aee-v1.schema.json")
        assert AEE_V1_SCHEMA == vendored

    def test_embedded_decision_evidence_schema_matches_vendored_copy(self):
        vendored = load_json(CONFORMANCE_DIR / "decision-evidence.schema.json")
        assert DECISION_EVIDENCE_SCHEMA == vendored
