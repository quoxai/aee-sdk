import asyncio
import threading

import pytest

from quox_aee import AEE, validate


def memory_aee(**overrides):
    emitted = []
    kwargs = dict(agent_id="tester", sink=emitted.append, decision_evidence="standard")
    kwargs.update(overrides)
    aee = AEE.init(**kwargs)
    return aee, emitted


class TestAEEInit:
    def test_requires_agent_id(self):
        with pytest.raises(ValueError, match="agent_id is required"):
            AEE.init(agent_id="")

    def test_creates_independent_instances(self):
        a = AEE.init(agent_id="a")
        b = AEE.init(agent_id="b")
        assert a.agent_id == "a"
        assert b.agent_id == "b"
        assert a is not b


class TestWrapContextManager:
    def test_emits_task_on_enter_and_result_on_success(self):
        aee, emitted = memory_aee()
        with aee.wrap(to="agent.b", intent="ops.do.thing") as ctx:
            ctx.record_decision("d", "r")
        assert len(emitted) == 2
        assert emitted[0]["type"] == "task"
        assert emitted[1]["type"] == "result"
        assert emitted[0]["from"] == "agent.tester"
        for e in emitted:
            assert validate(e).valid is True

    def test_threads_result_reply_to_and_shares_corr(self):
        aee, emitted = memory_aee()
        with aee.wrap(to="agent.b", intent="ops.do.thing"):
            pass
        task, result = emitted
        assert result["reply_to"] == task["id"]
        assert result["corr"] == task["corr"]

    def test_emits_error_on_exception_and_reraises(self):
        aee, emitted = memory_aee()
        with pytest.raises(RuntimeError, match="kaboom"):
            with aee.wrap(to="agent.b", intent="ops.do.thing"):
                raise RuntimeError("kaboom")
        assert len(emitted) == 2
        assert emitted[0]["type"] == "task"
        assert emitted[1]["type"] == "error"
        assert emitted[1]["reply_to"] == emitted[0]["id"]
        assert validate(emitted[1]).valid is True

    def test_attaches_recorded_decision_evidence(self):
        aee, emitted = memory_aee()
        with aee.wrap(to="agent.b", intent="ops.do.thing") as ctx:
            ctx.record_input("diff")
            ctx.record_tool_call("linter")
            ctx.record_decision("approve", "no blocking issues")
            ctx.record_action("merged")
            ctx.set_confidence(0.9)
        ev = emitted[1]["payload"]["decision_evidence"]
        assert ev["decision"] == "approve"
        assert ev["inputs_used"] == ["diff"]
        assert "context_refs" not in ev  # standard drops context_refs

    def test_omits_decision_evidence_when_level_none(self):
        aee, emitted = memory_aee(decision_evidence="none")
        with aee.wrap(to="agent.b", intent="ops.do.thing") as ctx:
            ctx.record_decision("x", "y")
        assert "decision_evidence" not in emitted[1]["payload"]

    def test_captures_raw_content_only_when_opted_in(self):
        aee, emitted = memory_aee()
        with aee.wrap(to="agent.b", intent="ops.do.thing") as ctx:
            ctx.record_input("secret", "super-secret-value")
            ctx.record_input("rawname", "raw-value", raw=True)
            ctx.record_decision("d", "r")
        inputs = emitted[1]["payload"]["decision_evidence"]["inputs_used"]
        assert "secret" in inputs  # metadata only
        assert any("raw-value" in i for i in inputs)  # raw opt-in
        assert not any("super-secret-value" in i for i in inputs)


class TestWrapDecorator:
    def test_wrap_used_as_decorator(self):
        aee, emitted = memory_aee()

        @aee.wrap(to="agent.b", intent="ops.compute")
        def handler(ctx, x, y):
            ctx.record_decision("sum", "added")
            return x + y

        assert handler(2, 3) == 5
        assert len(emitted) == 2
        assert emitted[0]["type"] == "task"
        assert emitted[1]["type"] == "result"
        assert emitted[1]["payload"]["decision_evidence"]["decision"] == "sum"

    def test_decorator_emits_error_on_exception(self):
        aee, emitted = memory_aee()

        @aee.wrap(to="agent.b", intent="ops.compute")
        def handler(ctx):
            raise ValueError("nope")

        with pytest.raises(ValueError, match="nope"):
            handler()
        assert emitted[1]["type"] == "error"

    def test_decorator_is_reentrant_fresh_wrap_per_call(self):
        aee, emitted = memory_aee()

        @aee.wrap(to="agent.b", intent="ops.compute")
        def handler(ctx):
            return 1

        handler()
        handler()
        assert len(emitted) == 4
        # Each call mints its own corr (no active session).
        assert emitted[0]["corr"] != emitted[2]["corr"]


class TestSessionAndCorrInheritance:
    def test_groups_wraps_under_one_session_corr(self):
        aee, emitted = memory_aee()
        session = aee.start_session()
        with aee.wrap(to="agent.b", intent="ops.one"):
            pass
        with aee.wrap(to="agent.c", intent="ops.two"):
            pass
        session.end()
        corrs = {e["corr"] for e in emitted}
        assert len(corrs) == 1
        assert next(iter(corrs)) == session.corr

    def test_nested_wraps_inherit_enclosing_corr(self):
        aee, emitted = memory_aee()
        with aee.wrap(to="agent.b", intent="ops.parent"):
            with aee.wrap(to="agent.c", intent="ops.child"):
                pass
        # task(parent), task(child), result(child), result(parent)
        assert len(emitted) == 4
        corrs = {e["corr"] for e in emitted}
        assert len(corrs) == 1
        assert emitted[1]["corr"] == emitted[0]["corr"]

    def test_explicit_corr_on_wrap_overrides_inheritance(self):
        aee, emitted = memory_aee()
        aee.start_session("CONV_session_corr_val")
        with aee.wrap(to="agent.b", intent="ops.x", corr="CONV_explicit_wrap_corr"):
            pass
        assert emitted[0]["corr"] == "CONV_explicit_wrap_corr"

    def test_ending_session_is_idempotent(self):
        aee, _ = memory_aee()
        session = aee.start_session()
        assert aee.active_corr == session.corr
        session.end()
        session.end()
        assert aee.active_corr is None


class TestPerWrapEvidenceLevel:
    def test_raising_to_full_includes_context_refs(self):
        aee, emitted = memory_aee(decision_evidence="standard")
        with aee.wrap(to="agent.b", intent="ops.x", decision_evidence="full") as ctx:
            ctx.record_decision("d", "r")
            ctx.record_context_ref("store://envelopes/abc")
        ev = emitted[1]["payload"]["decision_evidence"]
        assert ev["context_refs"] == ["store://envelopes/abc"]

    def test_dropping_to_none_suppresses_evidence(self):
        aee, emitted = memory_aee(decision_evidence="standard")
        with aee.wrap(to="agent.b", intent="ops.x", decision_evidence="none") as ctx:
            ctx.record_decision("d", "r")
        assert "decision_evidence" not in emitted[1]["payload"]

    def test_falls_back_to_instance_default(self):
        aee, emitted = memory_aee(decision_evidence="standard")
        with aee.wrap(to="agent.b", intent="ops.x") as ctx:
            ctx.record_decision("d", "r")
            ctx.record_context_ref("store://envelopes/abc")
        ev = emitted[1]["payload"]["decision_evidence"]
        assert "context_refs" not in ev


class TestConcurrencyCorrIsolation:
    """The audit scenario: overlapping wraps must not steal each other's corr."""

    def test_threading_nested_wrap_under_a_keeps_a_corr(self):
        aee, _ = memory_aee()
        b_entered = threading.Event()
        a_can_finish = threading.Event()
        captured: dict[str, str] = {}

        def task_a():
            with aee.wrap(to="agent.b", intent="ops.a") as ctx:
                captured["a"] = ctx.corr
                b_entered.wait(timeout=2)
                with aee.wrap(to="agent.c", intent="ops.a.child") as nctx:
                    captured["nested"] = nctx.corr
                a_can_finish.set()

        def task_b():
            with aee.wrap(to="agent.d", intent="ops.b") as ctx:
                captured["b"] = ctx.corr
                b_entered.set()
                a_can_finish.wait(timeout=2)

        ta = threading.Thread(target=task_a)
        tb = threading.Thread(target=task_b)
        ta.start()
        tb.start()
        ta.join(timeout=3)
        tb.join(timeout=3)

        assert captured["nested"] == captured["a"]
        assert captured["nested"] != captured["b"]

    def test_asyncio_nested_wrap_under_a_keeps_a_corr(self):
        aee, _ = memory_aee()
        captured: dict[str, str] = {}

        async def scenario():
            b_entered = asyncio.Event()
            a_can_finish = asyncio.Event()

            async def task_a():
                with aee.wrap(to="agent.b", intent="ops.a") as ctx:
                    captured["a"] = ctx.corr
                    await b_entered.wait()
                    with aee.wrap(to="agent.c", intent="ops.a.child") as nctx:
                        captured["nested"] = nctx.corr
                    a_can_finish.set()

            async def task_b():
                with aee.wrap(to="agent.d", intent="ops.b") as ctx:
                    captured["b"] = ctx.corr
                    b_entered.set()
                    await a_can_finish.wait()

            await asyncio.gather(task_a(), task_b())

        asyncio.run(scenario())

        assert captured["nested"] == captured["a"]
        assert captured["nested"] != captured["b"]


class TestCaptureContextEmitEscapeHatch:
    def test_emits_arbitrary_envelope_sharing_wrap_corr(self):
        aee, emitted = memory_aee()
        with aee.wrap(to="agent.b", intent="ops.do.thing") as ctx:
            base = dict(emitted[0])
            base.update(type="event", corr="CONV_will_be_overridden")
            ctx.emit(base)
        mid = next((e for e in emitted if e["type"] == "event"), None)
        assert mid is not None
        assert mid["corr"] == emitted[0]["corr"]


class TestWrapFromOverride:
    def test_from_override_sets_sender(self):
        aee, emitted = memory_aee()
        with aee.wrap(to="agent.b", intent="ops.x", from_="agent.custom"):
            pass
        assert emitted[0]["from"] == "agent.custom"

    def test_priority_passthrough(self):
        aee, emitted = memory_aee()
        with aee.wrap(to="agent.b", intent="ops.x", priority="high"):
            pass
        assert emitted[0]["priority"] == "high"
