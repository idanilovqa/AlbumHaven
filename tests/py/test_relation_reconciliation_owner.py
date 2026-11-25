"""FTC-GALLERY-STARTUP-005Q: the background owner that replays journaled albums so tag edits work again.

It starts only from start-up readiness, retries a failure with backoff, stops for good on a case only the
explicit initialization reconciles, and is cancellable at shutdown.
"""
from __future__ import annotations

import logging
import threading
from types import SimpleNamespace

import pytest

from music_app.services import relation_projection_postgres as relations
from music_app.services.relation_reconciliation import RelationReconciliationOwner


def _owner(outcomes, reconciled, waits):
    outcomes = iter(outcomes)

    def run_once():
        outcome = next(outcomes)
        if isinstance(outcome, BaseException):
            raise outcome
        return True

    owner = RelationReconciliationOwner({}, reconciled=lambda: reconciled.append(True),
                                        logger=logging.getLogger("test"), backoff=(30.0, 60.0))
    owner.run_once = run_once
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


@pytest.mark.parametrize("message", [
    "Legacy publication is not ready for compatibility preparation.",
    "Legacy publication differs from the frozen legacy source rebuild; journal retained.",
])
def test_a_case_only_initialization_reconciles_is_parked_once_without_retrying(message):
    reconciled, waits, parked, failed = [], [], [], []
    owner = _owner([relations.RelationInitializationRequired(message), {"unreachable": True}], reconciled, waits)
    owner._parked, owner._failed = parked.append, failed.append

    owner._run()

    assert waits == [] and reconciled == [] and failed == [], "no retry and no readiness run"
    assert parked == [message], "parked once, distinct from retrying"


def test_a_pending_write_since_the_legacy_publication_classifies_as_needs_initialization():
    from music_app.services import scoped_relation_projection as scoped

    source = open(scoped.__file__, encoding="utf-8").read()
    marker = "Legacy publication differs from the frozen legacy source rebuild; journal retained."
    statement = source[source.rindex("raise", 0, source.index(marker)):source.index(marker)]
    assert "RelationInitializationRequired" in statement


def test_shutdown_cancels_a_running_replay_and_a_stopped_owner_never_starts():
    started, release = threading.Event(), threading.Event()

    def run_once():
        started.set()
        release.wait(5)
        raise InterruptedError("cancelled")

    owner = RelationReconciliationOwner({}, reconciled=lambda: None, logger=logging.getLogger("test"))
    owner.run_once = run_once
    assert owner.request() is True
    assert owner.request() is False, "one replay per process"
    assert started.wait(5)
    release.set()
    owner.stop(timeout=5)
    assert not owner._thread.is_alive()
    stopped = RelationReconciliationOwner({}, reconciled=lambda: None)
    stopped.run_once = run_once
    stopped.stop()
    assert stopped.request() is False


def test_start_up_readiness_requests_the_replay_only_when_edits_would_refuse(monkeypatch):
    from music_app.services import scoped_relation_projection as scoped
    from music_app.services import state

    requests = []
    reasons_at_request = []
    app = SimpleNamespace(config={}, logger=logging.getLogger("test"), library_state={})
    app.relation_reconciliation = SimpleNamespace(request=lambda: (
        requests.append(True), reasons_at_request.append(app.library_state.get("relation_projection_rebuild_reason"))))
    monkeypatch.setattr(state, "ensure_relation_projection_ready", lambda _config, **_kwargs: relations._projection_result(
        {"artists": ["A"]}, {}, startup_rebuilt=False, reason="healthy", duration_ms=1))
    monkeypatch.setattr(state, "PostgresLibraryBrowseRepository", lambda _config: SimpleNamespace(
        queue_settings_projection_prewarm=lambda: None))

    monkeypatch.setattr(scoped, "relation_reconciliation_due", lambda _config: False)
    state.ensure_runtime_relation_projection_ready(app)
    assert requests == []

    monkeypatch.setattr(scoped, "relation_reconciliation_due", lambda _config: True)
    state.ensure_runtime_relation_projection_ready(app)
    # The owner starts only after start-up wrote its state, so its own status (retrying, parked) is never
    # overwritten by start-up.
    assert requests == [True] and reasons_at_request == ["reconciliation_required"]


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


def test_a_parked_owner_is_never_requested_again_in_this_process():
    """No loop once parked: neither a later save's hand-over nor a readiness check runs it again."""
    from music_app.services import relation_reconciliation

    runs = []

    def run_once():
        runs.append(True)
        raise relations.RelationInitializationRequired(
            "Legacy publication differs from the frozen legacy source rebuild; journal retained.")

    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://parked-owner"}
    owner = RelationReconciliationOwner(config, reconciled=lambda: None, logger=logging.getLogger("test"))
    owner.run_once = run_once
    try:
        assert owner.request() is True
        owner._thread.join(5)
        assert relation_reconciliation.request_relation_reconciliation(config) is False
        assert owner.request() is False
        assert runs == [True]
    finally:
        owner.stop()
    # A restart builds a new owner, which may park again (once).
    restarted = RelationReconciliationOwner(config, reconciled=lambda: None, logger=logging.getLogger("test"))
    restarted.run_once = run_once
    try:
        assert restarted.request() is True
        restarted._thread.join(5)
        assert runs == [True, True]
    finally:
        restarted.stop()


def test_current_evidence_replays_the_journal_by_key_and_never_runs_the_backfill(monkeypatch):
    from music_app.services import scoped_relation_projection as scoped

    replays = []
    monkeypatch.setattr(scoped, "relation_reconciliation_plan", lambda _config: {"action": "replay"})
    monkeypatch.setattr(scoped, "ensure_pending_relation_projection_ready",
                        lambda _config, **kwargs: replays.append(kwargs["keyed_only"]))
    monkeypatch.setattr(scoped, "run_relation_compatibility_backfill",
                        lambda *_args, **_kwargs: pytest.fail("current evidence never runs the backfill"))

    assert RelationReconciliationOwner({}, reconciled=lambda: None).run_once()
    assert replays == [True], "the job's replay refuses rather than prove the legacy contract itself"


def test_a_failed_backfill_parks_without_a_backoff_retry(monkeypatch):
    from music_app.services import scoped_relation_projection as scoped

    evidence = {"source_fingerprint": "f", "publication_xid": "1"}
    backfills, waits, parked = [], [], []
    monkeypatch.setattr(scoped, "relation_reconciliation_plan",
                        lambda _config: {"action": "backfill", "evidence": evidence, "attempted": None})

    def backfill(_config, seen, **kwargs):
        backfills.append((seen, kwargs["attempted"]))
        raise relations.RelationInitializationRequired("The compatibility backfill failed (RuntimeError: x).")

    monkeypatch.setattr(scoped, "run_relation_compatibility_backfill", backfill)
    owner = RelationReconciliationOwner({}, reconciled=lambda: pytest.fail("not reconciled"), parked=parked.append,
                                        failed=lambda _message: pytest.fail("a backfill is never retried"),
                                        logger=logging.getLogger("test"))
    owner._stop = SimpleNamespace(is_set=lambda: False, wait=lambda seconds: waits.append(seconds) or False,
                                  set=lambda: None)

    owner._run()

    assert backfills == [(evidence, None)] and waits == []
    assert parked == ["The compatibility backfill failed (RuntimeError: x)."]


def test_a_backfill_already_recorded_for_the_state_parks_without_work_and_a_cancel_forgets_it(monkeypatch):
    from music_app.services import scoped_relation_projection as scoped

    evidence = {"source_fingerprint": "f", "publication_xid": "1"}
    monkeypatch.setattr(scoped, "prepare_relation_compatibility",
                        lambda *_args, **_kwargs: pytest.fail("an attempted state never prepares again"))
    with pytest.raises(relations.RelationInitializationRequired, match="already ran.*differs"):
        scoped.run_relation_compatibility_backfill(
            {}, evidence, attempted={**evidence, "status": "parked", "error": "Legacy publication differs"})

    records, forgotten, reported = [], [], []
    monkeypatch.setattr(scoped, "_record_compatibility_backfill",
                        lambda _config, _connect, _evidence, **kwargs: records.append(kwargs["status"]) or True)
    monkeypatch.setattr(scoped, "_forget_compatibility_backfill",
                        lambda _config, _connect, seen: forgotten.append(seen))

    def cancelled(_config, *, progress, **_kwargs):
        progress("Building current relations")
        raise InterruptedError("cancelled")

    monkeypatch.setattr(scoped, "prepare_relation_compatibility", cancelled)
    with pytest.raises(InterruptedError):
        scoped.run_relation_compatibility_backfill({}, evidence, progress=reported.append)
    assert records == ["running"] and forgotten == [evidence], "a shutdown leaves the state to the next start"
    assert [update["state"] for update in reported] == ["running", "cancelled"]
