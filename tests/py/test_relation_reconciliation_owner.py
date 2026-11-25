"""FTC-GALLERY-STARTUP-005Q: the background owner that replays journaled albums so tag edits work again.

It starts only from start-up readiness, retries a failure with backoff, stops for good on a case only the
explicit initialization reconciles, and is cancellable at shutdown.
"""
from __future__ import annotations

import logging
import threading
from types import SimpleNamespace

from music_app.services import relation_projection_postgres as relations
from music_app.services.relation_reconciliation import RelationReconciliationOwner


def _owner(outcomes, reconciled, waits):
    outcomes = iter(outcomes)

    def prepare(_config, *, cancel_requested):
        assert cancel_requested is not None, "shutdown can cancel the replay"
        outcome = next(outcomes)
        if isinstance(outcome, BaseException):
            raise outcome
        return outcome

    owner = RelationReconciliationOwner({}, reconciled=lambda: reconciled.append(True), prepare=prepare,
                                        logger=logging.getLogger("test"), backoff=(30.0, 60.0))
    owner._stop = SimpleNamespace(is_set=lambda: False, wait=lambda seconds: waits.append(seconds) or False,
                                  set=lambda: None)
    return owner


def test_a_failed_replay_retries_with_backoff_then_readiness_runs_again():
    reconciled, waits, reported = [], [], []
    owner = _owner([RuntimeError("busy"), RuntimeError("busy"), RuntimeError("busy"), {"compatibility_prepared": True}],
                   reconciled, waits)
    owner._failed = reported.append

    owner._run()

    assert waits == [30.0, 60.0, 60.0]
    # Each failure shows outside the log (the app puts it in /status) with its retry time.
    assert len(reported) == 3 and "attempt 3 failed" in reported[-1] and "retrying in 60 s" in reported[-1]
    assert reconciled == [True], "readiness runs again once the journal is replayed"


def test_a_case_only_initialization_reconciles_is_parked_without_retrying():
    reconciled, waits = [], []
    owner = _owner([relations.RelationInitializationRequired("Legacy publication is not ready.")], reconciled, waits)

    owner._run()

    assert waits == [] and reconciled == []


def test_shutdown_cancels_a_running_replay_and_a_stopped_owner_never_starts():
    started, release = threading.Event(), threading.Event()

    def prepare(_config, *, cancel_requested):
        started.set()
        release.wait(5)
        raise InterruptedError("cancelled")

    owner = RelationReconciliationOwner({}, reconciled=lambda: None, prepare=prepare, logger=logging.getLogger("test"))
    assert owner.request() is True
    assert owner.request() is False, "one replay per process"
    assert started.wait(5)
    release.set()
    owner.stop(timeout=5)
    assert not owner._thread.is_alive()
    stopped = RelationReconciliationOwner({}, reconciled=lambda: None, prepare=prepare)
    stopped.stop()
    assert stopped.request() is False


def test_start_up_readiness_requests_the_replay_only_when_edits_would_refuse(monkeypatch):
    from music_app.services import scoped_relation_projection as scoped
    from music_app.services import state

    requests = []
    app = SimpleNamespace(config={}, logger=logging.getLogger("test"),
                          relation_reconciliation=SimpleNamespace(request=lambda: requests.append(True)))

    monkeypatch.setattr(scoped, "relation_reconciliation_due", lambda _config: False)
    assert state._request_relation_reconciliation(app, {"rebuild_reason": "healthy"}) is False
    assert requests == []

    monkeypatch.setattr(scoped, "relation_reconciliation_due", lambda _config: True)
    assert state._request_relation_reconciliation(app, {"rebuild_reason": "healthy"}) is True
    assert state._request_relation_reconciliation(app, {"rebuild_reason": "reconciliation_required"}) is True
    assert requests == [True, True]


def test_a_start_up_refusal_with_no_stored_rows_hands_the_replay_to_the_owner(monkeypatch):
    import pytest

    from music_app.services import state

    def refuse(_config, **_kwargs):
        raise relations.RelationReconciliationRequired("Relation compatibility preparation is required before editing tags.")

    requests = []
    monkeypatch.setattr(state, "ensure_relation_projection_ready", refuse)
    app = SimpleNamespace(config={}, library_state={}, logger=logging.getLogger("test"),
                          relation_reconciliation=SimpleNamespace(request=lambda: requests.append(True)))

    with pytest.raises(relations.RelationReconciliationRequired):
        state.ensure_runtime_relation_projection_ready(app)

    assert requests == [True]
    assert app.library_state["relation_projection_rebuild_reason"] == "reconciliation_required"
    assert "before editing tags" in app.library_state["last_error"]
