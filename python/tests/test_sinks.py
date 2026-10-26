import json
import os
import time
from unittest.mock import MagicMock

import pytest

from quox_aee import (
    AEE,
    create_custom_sink,
    create_file_sink,
    create_stdout_sink,
    create_task,
    to_ndjson_line,
)


def sample_envelope():
    return create_task("a", "b", "ops.ping.check", {"k": 1}, "CONV_sink_corr_value")


class TestToNdjsonLine:
    def test_serialises_one_envelope_per_line_with_newline(self):
        line = to_ndjson_line(sample_envelope())
        assert line.endswith("\n")
        assert json.loads(line.strip())["intent"] == "ops.ping.check"


class TestNaNPoisonedNdjsonParity:
    # Byte-identical to the TypeScript sinks.test.ts EXPECTED literal.
    EXPECTED = '{"v":"1","score":null,"nested":{"deep":null}}\n'

    def test_replaces_non_finite_with_null_and_stays_byte_parseable(self):
        on_error = MagicMock()
        env = {"v": "1", "score": float("nan"), "nested": {"deep": float("inf")}}
        line = to_ndjson_line(env, on_error=on_error)
        assert line == self.EXPECTED
        assert json.loads(line) == {"v": "1", "score": None, "nested": {"deep": None}}
        on_error.assert_called()

    def test_json_dumps_would_reject_raw_nan(self):
        # Guards the fix: without sanitisation, allow_nan=False raises rather
        # than emitting the invalid ``NaN`` JSON literal.
        with pytest.raises(ValueError):
            json.dumps({"score": float("nan")}, allow_nan=False)

    def test_stdout_sink_surfaces_warning_on_non_finite(self):
        on_error = MagicMock()
        lines = []
        sink = create_stdout_sink(write=lines.append, on_error=on_error)
        sink({"v": "1", "score": float("nan")})
        assert lines == ['{"v":"1","score":null}\n']
        on_error.assert_called()


class TestStdoutSink:
    def test_writes_json_line_via_supplied_writer(self):
        lines = []
        sink = create_stdout_sink(write=lines.append)
        sink(sample_envelope())
        assert len(lines) == 1
        assert json.loads(lines[0].strip())["type"] == "task"


class TestFileSink:
    def test_appends_ndjson_and_creates_missing_parent_dirs(self, tmp_path):
        file = tmp_path / "nested" / "envelopes.ndjson"
        sink = create_file_sink(path=str(file))
        sink(sample_envelope())
        sink(sample_envelope())
        rows = file.read_text(encoding="utf8").strip().split("\n")
        assert len(rows) == 2
        assert json.loads(rows[0])["intent"] == "ops.ping.check"


class TestCustomSink:
    def test_wraps_function_and_forwards_envelopes(self):
        seen = []
        sink = create_custom_sink(seen.append)
        sink(sample_envelope())
        assert len(seen) == 1

    def test_rejects_non_callable(self):
        with pytest.raises(ValueError, match="requires a callable"):
            create_custom_sink(None)


class TestEmitFireAndForget:
    def test_never_raises_when_sink_raises_routes_to_on_error(self):
        on_error = MagicMock()

        def boom(_e):
            raise RuntimeError("sync boom")

        aee = AEE.init(agent_id="x", sink=boom, on_error=on_error)
        # Must not raise.
        aee.emit(sample_envelope())
        assert on_error.call_count == 1
        assert str(on_error.call_args[0][0]) == "sync boom"

    def test_does_not_break_emission_when_on_error_itself_throws(self):
        def boom(_e):
            raise RuntimeError("boom")

        def bad_on_error(*_a):
            raise RuntimeError("on_error boom")

        aee = AEE.init(agent_id="x", sink=boom, on_error=bad_on_error)
        # Must not raise.
        aee.emit(sample_envelope())

    def test_resolves_sink_config_from_custom_name_and_function(self):
        seen = []
        aee = AEE.init(agent_id="x", sink="custom", sink_options={"fn": seen.append})
        aee.emit(sample_envelope())
        assert len(seen) == 1

    def test_throws_when_custom_sink_selected_without_fn(self):
        with pytest.raises(ValueError, match="requires sink_options"):
            AEE.init(agent_id="x", sink="custom")

    def test_unknown_sink_name_raises(self):
        with pytest.raises(ValueError, match="Unknown sink"):
            AEE.init(agent_id="x", sink="nope")

    def test_file_sink_via_name_writes_to_path(self, tmp_path):
        file = tmp_path / "out.ndjson"
        aee = AEE.init(agent_id="x", sink="file", sink_options={"path": str(file)})
        aee.emit(sample_envelope())
        assert os.path.exists(file)
        assert json.loads(file.read_text().strip())["type"] == "task"
