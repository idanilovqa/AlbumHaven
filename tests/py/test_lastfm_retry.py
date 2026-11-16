"""Background, batched Last.fm scrobble submission: per-listen policy, batches, and the worker."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import math
import queue
import threading
from types import SimpleNamespace

import pytest

from music_app.services import lastfm_retry, listen_history, listen_history_postgres
from music_app.services.lastfm import LastfmError, LastfmSubmissionOutcome
from music_app.services.lastfm_sync_bridge import (
    failed_batch_disposition,
    plan_pending_scrobble,
    scrobble_attempt_updates,
    scrobble_retry_delay_seconds,
)
from music_app.services.log_history import HistoryScope
from tests.py.bounded_interactions import OperationCounts, measure_scale_pair
from tests.py.lastfm_scrobble_ledger import (
    ACCOUNT_ID,
    LIBRARY_ID,
    FakeLastfm,
    ScrobbleLedger,
    listen_entry,
    transient_failure,
)

_NOW = datetime(2026, 11, 16, 12, tzinfo=timezone.utc)
_CONFIG = {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://isolated.invalid/lastfm-retry", "LASTFM_API_ENABLED": True}
_WORKER_ID = "py:services/lastfm_retry.py#start_lastfm_retry_worker.<locals>.worker"


@pytest.fixture
def scrobble_ledger(monkeypatch):
    """Installs a fresh ledger at the listen-history connection seam; returns a factory."""
    monkeypatch.setattr(listen_history, "select_runtime_persistence_adapter",
                        lambda _seam, _config: SimpleNamespace(effective_backend="postgres"))
    monkeypatch.setattr(listen_history_postgres, "Jsonb", None)
    monkeypatch.setattr(lastfm_retry, "record_retry_results", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(lastfm_retry, "log_app_event", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(lastfm_retry, "_REQUESTS", {})
    monkeypatch.setattr(lastfm_retry, "_SUBMISSIONS", {})

    def install(counts: OperationCounts | None = None, *, answer=None) -> tuple[ScrobbleLedger, FakeLastfm]:
        ledger = ScrobbleLedger(counts)
        ledger.sessions[ACCOUNT_ID] = "fixture-session"
        provider = FakeLastfm(ledger, answer)
        monkeypatch.setattr(listen_history_postgres, "_connect", ledger.connect)
        monkeypatch.setattr(lastfm_retry, "scrobble_tracks", provider)
        return ledger, provider

    return install


# Per-listen policy ---------------------------------------------------------

@pytest.mark.parametrize("changes", [
    {"scrobbled": True},
    {"scrobble_eligible": False},
    {"scrobble_retryable": False},
    {"scrobble_retry_exhausted": True},
    *({"scrobble_submission_state": state} for state in ("attempting", "sent", "uncertain", "accepted")),
])
def test_plan_leaves_listens_another_submitter_owns_or_that_cannot_retry(changes):
    assert plan_pending_scrobble(listen_entry(1, **changes), now=_NOW, bypass_backoff=True) is None


def test_plan_waits_for_backoff_unless_submit_or_reconnect_asks():
    # A second failure waits 60 s.
    entry = listen_entry(1, scrobble_retry_count=2, last_scrobble_attempt_at=(_NOW - timedelta(seconds=30)).isoformat())

    assert plan_pending_scrobble(entry, now=_NOW) is None
    assert plan_pending_scrobble(entry, now=_NOW + timedelta(seconds=31)).payload["track"] == "Song 1"
    assert plan_pending_scrobble(entry, now=_NOW, bypass_backoff=True).payload["track"] == "Song 1"
    assert plan_pending_scrobble(entry, now=_NOW, reauthenticated=True).payload["track"] == "Song 1"


def test_an_outage_never_exhausts_a_listen_so_it_is_sent_once_last_fm_answers():
    entry = listen_entry(1, scrobble_retry_count=40, last_scrobble_attempt_at=(_NOW - timedelta(minutes=16)).isoformat())

    assert plan_pending_scrobble(entry, now=_NOW).payload["track"] == "Song 1"
    failed = scrobble_attempt_updates(entry, attempted_at=_NOW, error="Offline", retryable=True,
                                      submission_state="not_sent")
    assert (failed["scrobble_retryable"], failed["scrobble_retry_count"]) == (True, 41)
    assert failed["sync_problem"]["status"] == "pending_retry"


def test_backoff_doubles_from_thirty_seconds_to_a_fifteen_minute_cap_with_bounded_jitter():
    assert [scrobble_retry_delay_seconds(attempts) for attempts in range(1, 9)] == [
        30, 60, 120, 240, 480, 900, 900, 900]
    delays = [lastfm_retry.retry_delay_with_jitter(900) for _sample in range(200)]
    assert 900 <= min(delays) and max(delays) <= 1080


def test_plan_fails_an_invalid_listen_without_sending():
    plan = plan_pending_scrobble(listen_entry(1, artist=""), now=_NOW)

    assert plan.payload is None
    assert plan.updates["scrobble_error"] == "Missing artist for queued scrobble."
    assert plan.updates["scrobble_retryable"] is False
    assert plan.updates["scrobble_retry_count"] == 1
    assert plan.updates["sync_problem"]["status"] == "permanent_failure"


def test_plan_holds_a_listen_that_needs_reauthentication_until_reconnect():
    entry = listen_entry(1, scrobble_reauthentication_required=True, scrobble_retry_count=1)

    assert plan_pending_scrobble(entry, now=_NOW, bypass_backoff=True) is None
    assert plan_pending_scrobble(entry, now=_NOW, reauthenticated=True).payload is not None


@pytest.mark.parametrize(("error", "measured", "expected"), [
    (LastfmError("Service Offline", code=11, retryable=True), True, (True, "not_sent")),
    (LastfmError("Invalid session key", code=9, reauthentication_required=True), True, (True, "not_sent")),
    (LastfmError("Network error contacting Last.fm", retryable=True, error_kind="network_error"), True,
     (False, "uncertain")),
    (LastfmError("Malformed", retryable=True, error_kind="malformed_response"), True, (False, "uncertain")),
    (LastfmError("Invalid parameters", code=6), True, (False, "uncertain")),
    (LastfmError("Network error contacting Last.fm", retryable=True, error_kind="network_error"), False,
     (True, "not_sent")),
    (LastfmError("Invalid parameters", code=6), False, (False, "uncertain")),
])
def test_failed_batch_is_resent_only_when_last_fm_cannot_have_recorded_a_measured_listen(error, measured, expected):
    assert failed_batch_disposition(error, measured=measured) == expected


def test_attempt_result_counts_the_attempt():
    accepted = scrobble_attempt_updates(listen_entry(1, scrobble_retry_count=2), attempted_at=_NOW,
                                        submission_state="accepted")
    ignored = scrobble_attempt_updates(listen_entry(1), attempted_at=_NOW, error="Ignored", submission_state="sent")

    assert (accepted["scrobbled"], accepted["scrobble_retry_count"], accepted["sync_problem"]) == (True, 3, None)
    assert (ignored["scrobbled"], ignored["scrobble_retryable"]) == (False, False)
    assert ignored["sync_problem"]["status"] == "permanent_failure"


# Batches -------------------------------------------------------------------

def test_batch_records_accepted_and_ignored_listens_one_by_one(scrobble_ledger):
    ledger, provider = scrobble_ledger(answer=lambda payloads: [
        LastfmSubmissionOutcome(sent=True, accepted=1, outcome="accepted"),
        LastfmSubmissionOutcome(sent=True, ignored=1, outcome="ignored", ignored_code=3, message="Timestamp too old"),
        LastfmSubmissionOutcome(sent=True, accepted=1, outcome="accepted"),
    ])
    ledger.add_pending(3)

    result = lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG, account_id=ACCOUNT_ID, bypass_backoff=True)

    assert [call.tracks for call in provider.calls] == [["Song 0", "Song 1", "Song 2"]]
    assert provider.calls[0].claimed_states == {"attempting"}, "listens are claimed before Last.fm sees them"
    assert provider.calls[0].session_key == "fixture-session"
    first, ignored, third = ledger.entries()
    assert (first["scrobbled"], first["scrobble_submission_state"]) == (True, "accepted")
    assert (third["scrobbled"], third["scrobble_submission_state"]) == (True, "accepted")
    assert (ignored["scrobbled"], ignored["scrobble_submission_state"], ignored["scrobble_retryable"]) == (
        False, "sent", False)
    assert ignored["sync_problem"] == {"provider": "lastfm", "kind": "scrobble", "status": "permanent_failure",
                                       "message": "Timestamp too old"}
    assert result.summary == {"pending_before": 3, "attempted": 3, "succeeded": 2, "failed": 1, "pending_after": 0}
    assert result.retry_in_seconds is None
    assert ledger.counts.transactions == 2
    assert ledger.unknown == []


def test_transient_failure_returns_the_batch_to_the_queue_with_backoff(scrobble_ledger):
    ledger, provider = scrobble_ledger(answer=transient_failure)
    ledger.add_pending(3)

    result = lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG, account_id=ACCOUNT_ID, bypass_backoff=True)

    assert len(provider.calls) == 1
    assert result.retry_in_seconds == 30
    assert result.summary == {"pending_before": 3, "attempted": 3, "succeeded": 0, "failed": 3, "pending_after": 3}
    for entry in ledger.entries():
        assert (entry["scrobble_submission_state"], entry["scrobble_retryable"], entry["scrobble_retry_count"]) == (
            "not_sent", True, 1)
        assert entry["sync_problem"]["status"] == "pending_retry"
    # The periodic pass honours the backoff; Submit sends the batch again at once.
    assert lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG).summary["attempted"] == 0
    provider.answer = FakeLastfm(ledger).answer
    assert lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG, bypass_backoff=True).summary["succeeded"] == 3
    assert [len(call.tracks) for call in provider.calls] == [3, 3]


def test_a_failing_provider_stops_the_pass_so_later_batches_keep_their_attempts(scrobble_ledger):
    ledger, provider = scrobble_ledger(answer=transient_failure)
    ledger.add_pending(120)

    result = lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG, bypass_backoff=True)

    assert len(provider.calls) == 1
    assert result.summary["attempted"] == 50
    assert sum(entry.get("scrobble_retry_count", 0) for entry in ledger.entries()) == 50


def test_permanent_rejection_marks_the_batch_without_resending(scrobble_ledger):
    ledger, provider = scrobble_ledger(answer=lambda _payloads: LastfmError("Invalid parameters (Last.fm error 6)", code=6))
    ledger.add_pending(2)

    lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG, bypass_backoff=True)
    lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG, bypass_backoff=True)

    assert len(provider.calls) == 1
    for entry in ledger.entries():
        assert (entry["scrobble_submission_state"], entry["scrobble_retryable"]) == ("uncertain", False)
        assert entry["sync_problem"]["status"] == "permanent_failure"
        assert not listen_history.is_pending_scrobble_entry(entry)


def test_a_crash_after_the_claim_never_sends_the_batch_twice(scrobble_ledger):
    ledger, provider = scrobble_ledger(answer=lambda _payloads: RuntimeError("worker died mid-request"))
    ledger.add_pending(2)

    with pytest.raises(lastfm_retry.LastfmRetryBatchError):
        lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG, bypass_backoff=True)
    provider.answer = FakeLastfm(ledger).answer
    after_restart = lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG, bypass_backoff=True)

    assert len(provider.calls) == 1
    assert after_restart.summary["pending_before"] == 0
    assert {entry["scrobble_submission_state"] for entry in ledger.entries()} == {"attempting"}


def test_a_listen_claimed_by_another_submitter_after_loading_is_not_sent(scrobble_ledger, monkeypatch):
    ledger, provider = scrobble_ledger()
    ledger.add_pending(2)
    lock = listen_history_postgres.lock_pending_entries

    def claimed_by_live_submission(connection, batch):
        ledger.entry(1)["scrobble_submission_state"] = "attempting"
        return lock(connection, batch)

    monkeypatch.setattr(lastfm_retry, "lock_pending_entries", claimed_by_live_submission)
    lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG, bypass_backoff=True)

    assert [call.tracks for call in provider.calls] == [["Song 1"]]


def test_batches_hold_one_account_and_at_most_fifty_listens(scrobble_ledger):
    ledger, provider = scrobble_ledger()
    ledger.sessions[8] = "other-session"
    ledger.add_pending(120)
    ledger.add_pending(3, account_id=8, start=500)
    ledger.add_pending(2, account_id=99, start=900)

    result = lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG)

    assert [(len(call.tracks), call.session_key) for call in provider.calls] == [
        (50, "fixture-session"), (50, "fixture-session"), (20, "fixture-session"), (3, "other-session"),
    ]
    assert result.summary["pending_before"] == 123, "an account without a Last.fm session is not in scope"


def test_legacy_listens_update_the_sync_state_once_per_pass(scrobble_ledger, monkeypatch):
    ledger, _provider = scrobble_ledger(answer=lambda payloads: [
        LastfmSubmissionOutcome(sent=True, ignored=1, outcome="ignored", ignored_code=1, message="Artist ignored")
        if payload["track"] == "Song 1"
        else LastfmSubmissionOutcome(sent=True, accepted=1, outcome="accepted")
        for payload in payloads
    ])
    ledger.add_pending(2, measured=False)
    ledger.add_pending(1, start=10)
    recorded = []
    monkeypatch.setattr(lastfm_retry, "record_retry_results", lambda _config, **kwargs: recorded.append(kwargs))

    summary = lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG).summary

    assert recorded == [{"pending_changes": {"listen-0": None, "listen-1": None}, "summary": summary}]


def test_a_legacy_listen_waiting_for_retry_stays_in_the_sync_state(scrobble_ledger, monkeypatch):
    ledger, _provider = scrobble_ledger(answer=transient_failure)
    ledger.add_pending(1, measured=False)
    recorded = []
    monkeypatch.setattr(lastfm_retry, "record_retry_results", lambda _config, **kwargs: recorded.append(kwargs))

    lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG, account_id=ACCOUNT_ID, bypass_backoff=True)

    [record] = recorded
    assert record["summary"] is None, "only an unscoped pass replaces the last retry summary"
    waiting = record["pending_changes"]["listen-0"]
    assert (waiting["scrobble_retry_count"], waiting["scrobble_retryable"]) == (1, True)


def test_each_library_gets_one_history_event_holding_counts_only(scrobble_ledger, monkeypatch):
    ledger, _provider = scrobble_ledger()
    # The row's provenance scopes the event, never a scope forged into the stored payload.
    ledger.add_pending(60, account_id=ACCOUNT_ID, library_id=88)
    events = []
    monkeypatch.setattr(lastfm_retry, "log_app_event", lambda _config, _logger, action, **fields: events.append(
        (action, fields)))

    lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG)

    [(action, fields)] = events
    assert action == "Last.fm scrobble retry pass completed"
    assert fields["history_scope"] == HistoryScope(library_id=LIBRARY_ID, account_id=ACCOUNT_ID, origin_kind="retry")
    assert {key: fields[key] for key in ("attempted", "succeeded", "failed")} == {
        "attempted": 60, "succeeded": 60, "failed": 0}
    assert not {"artist", "album", "title", "track", "session_key"} & set(fields)


# Requests and the worker ---------------------------------------------------

def _submit_scope() -> HistoryScope:
    return HistoryScope(library_id=LIBRARY_ID, account_id=ACCOUNT_ID, origin_kind="request")


def test_submit_while_the_accounts_pass_runs_starts_nothing(monkeypatch):
    monkeypatch.setattr(lastfm_retry, "_REQUESTS", {})
    monkeypatch.setattr(lastfm_retry, "_SUBMISSIONS", {})
    wake = threading.Event()
    monkeypatch.setattr(lastfm_retry, "_WORKER_WAKE_EVENT", wake)

    assert lastfm_retry.request_lastfm_submission(_submit_scope()) == "queued"
    assert lastfm_retry.request_lastfm_submission(_submit_scope()) == "queued"
    assert len(lastfm_retry._REQUESTS) == 1 and wake.is_set()
    assert lastfm_retry._take_request()[0] == ACCOUNT_ID
    assert lastfm_retry.request_lastfm_submission(_submit_scope()) == "running"
    assert lastfm_retry._REQUESTS == {}
    # A reconnection still runs after the current pass, for every library of the account.
    assert lastfm_retry.request_lastfm_reconnect_retry(ACCOUNT_ID) == "running"
    assert lastfm_retry._REQUESTS[ACCOUNT_ID].library_ids is None
    assert lastfm_retry._REQUESTS[ACCOUNT_ID].reauthenticated is True


class _WorkerProbe:
    """Starts the real worker and reports each pending check and each pass it runs."""

    def __init__(self, monkeypatch) -> None:
        self.events: queue.Queue = queue.Queue()
        check = lastfm_retry.has_sendable_scrobbles
        send = lastfm_retry.retry_pending_lastfm_scrobbles

        def observed_check(config):
            found = check(config)
            self.events.put(("check", found))
            return found

        def observed_pass(config, **scope):
            try:
                result = send(config, **scope)
            except Exception as exc:
                self.events.put(("pass", exc))
                raise
            self.events.put(("pass", result))
            return result

        monkeypatch.setattr(lastfm_retry, "has_sendable_scrobbles", observed_check)
        monkeypatch.setattr(lastfm_retry, "retry_pending_lastfm_scrobbles", observed_pass)
        self.app = SimpleNamespace(config={**_CONFIG, "DATA_DIR": "lastfm-retry-worker-test"},
                                   logger=SimpleNamespace(log=lambda *_args, **_kwargs: None))

    def __enter__(self):
        lastfm_retry.start_lastfm_retry_worker(self.app)
        return self

    def __exit__(self, *_exc):
        lastfm_retry.stop_lastfm_retry_worker(self.app, wait=True, timeout=5)

    def next(self, kind: str, timeout: float = 30):
        event_kind, value = self.events.get(timeout=timeout)
        assert event_kind == kind, (event_kind, value)
        return value


@pytest.fixture
def fast_backoff(monkeypatch):
    """Backoff in hundredths of a second, so an outage and its recovery run in a test."""
    from music_app.services import lastfm_sync_bridge
    monkeypatch.setattr(lastfm_sync_bridge, "_BASE_RETRY_DELAY_SECONDS", 0.02)
    monkeypatch.setattr(lastfm_sync_bridge, "_MAX_RETRY_DELAY_SECONDS", 0.08)


def test_the_worker_sends_listens_waiting_at_start_up_without_any_request(scrobble_ledger, monkeypatch):
    ledger, provider = scrobble_ledger()
    ledger.add_pending(3)
    monkeypatch.setattr(lastfm_retry, "_IDLE_CHECK_SECONDS", 3600)

    with _WorkerProbe(monkeypatch) as worker:
        assert worker.next("check") is True
        assert worker.next("pass").summary["succeeded"] == 3

    assert len(provider.calls) == 1
    assert all(entry["scrobbled"] for entry in ledger.entries())


def test_a_disconnected_account_is_never_retried(scrobble_ledger, monkeypatch):
    ledger, provider = scrobble_ledger()
    ledger.add_pending(3, account_id=99)
    monkeypatch.setattr(lastfm_retry, "_IDLE_CHECK_SECONDS", 3600)

    with _WorkerProbe(monkeypatch) as worker:
        assert worker.next("check") is False
        lastfm_retry.wake_lastfm_retry_worker()
        assert worker.next("check") is False

    assert provider.calls == []


def test_one_worker_sends_while_submit_is_clicked_again_and_records_a_failed_batch(
    scrobble_ledger, monkeypatch, fast_backoff,
):
    sending = threading.Event()
    release = threading.Event()

    def held_failure(payloads):
        sending.set()
        assert release.wait(5)
        return transient_failure(payloads)

    ledger, provider = scrobble_ledger(answer=held_failure)
    events = []
    monkeypatch.setattr(lastfm_retry, "log_app_event", lambda _config, _logger, action, **fields: events.append(
        (action, fields)))
    monkeypatch.setattr(lastfm_retry, "_IDLE_CHECK_SECONDS", 3600)
    with _WorkerProbe(monkeypatch) as worker:
        assert worker.next("check") is False  # start-up, before anything is waiting
        ledger.add_pending(3)
        assert lastfm_retry.request_lastfm_submission(_submit_scope()) == "queued"
        assert sending.wait(5)
        assert lastfm_retry.request_lastfm_submission(_submit_scope()) == "running"
        assert lastfm_retry.lastfm_submission_status(ACCOUNT_ID) == {"state": "running", "error": ""}
        failed_status = None
        # Hold every automatic retry too, so exactly one call is made while the status is read.
        provider.answer = lambda payloads: transient_failure(payloads)
        release.set()
        assert worker.next("pass").summary["failed"] == 3
        for _attempt in range(100):
            failed_status = lastfm_retry.lastfm_submission_status(ACCOUNT_ID)
            if failed_status["state"] != "running":
                break
            threading.Event().wait(0.01)

    assert provider.calls[0].tracks == ["Song 0", "Song 1", "Song 2"]
    assert failed_status == {"state": "failed", "error": "Some pending scrobbles could not be submitted to Last.fm."}
    failure = [fields for action, fields in events if action == "Last.fm pending scrobble submission failed"]
    assert len(failure) == 1
    assert failure[0]["history_scope"] == _submit_scope()
    assert {key: failure[0][key] for key in ("attempted", "succeeded", "failed", "pending_before", "pending_after")} == {
        "attempted": 3, "succeeded": 0, "failed": 3, "pending_before": 3, "pending_after": 3,
    }


def test_lastfm_retry_worker_contract_recovers_from_an_outage_in_batches_of_fifty_and_idles_on_one_query(
    scrobble_ledger, monkeypatch, fast_backoff,
):
    from tests.py.test_library_route_bounded_contracts import _registered

    monkeypatch.setattr(lastfm_retry, "_IDLE_CHECK_SECONDS", 3600)

    def run(pending: int) -> OperationCounts:
        counts = OperationCounts()
        outage = {"calls": 1}

        def last_fm_down_once(payloads):
            if outage["calls"]:
                outage["calls"] -= 1
                return transient_failure(payloads)
            return [LastfmSubmissionOutcome(sent=True, accepted=1, outcome="accepted") for _payload in payloads]

        ledger, provider = scrobble_ledger(counts, answer=last_fm_down_once)
        ledger.add_pending(pending)
        with _WorkerProbe(monkeypatch) as worker:
            # Start-up finds waiting listens; the first call meets the outage and the pass stops.
            assert worker.next("check") is True
            during_outage = worker.next("pass")
            assert during_outage.summary["attempted"] == min(pending, 50)
            assert during_outage.retry_in_seconds == pytest.approx(0.02)
            # After the backoff the worker retries on its own and sends everything.
            assert worker.next("check") is True
            recovered = worker.next("pass")
            converged = OperationCounts(**vars(counts))
            # A listen left unsent wakes the worker; with nothing waiting that costs one query.
            lastfm_retry.wake_lastfm_retry_worker()
            assert worker.next("check") is False
            with pytest.raises(queue.Empty):
                worker.events.get(timeout=0.3)
        batches = math.ceil(pending / 50)
        assert recovered.summary == {"pending_before": pending, "attempted": pending, "succeeded": pending,
                                     "failed": 0, "pending_after": 0}
        assert recovered.retry_in_seconds is None
        assert all(entry["scrobbled"] for entry in ledger.entries())
        assert converged.provider_calls == 1 + batches
        assert converged.transactions == 2 + 2 * batches, "one claim and one result transaction per batch"
        # Two checks, two passes of 3 reads each, and 4 statements per batch.
        assert converged.sql_statements == 2 + 3 + 4 + 3 + 4 * batches
        assert counts.provider_calls == converged.provider_calls, "Last.fm calls stop once the queue is empty"
        assert counts.transactions == converged.transactions
        assert counts.sql_statements - converged.sql_statements == 1
        assert ledger.unknown == []
        return counts

    measure_scale_pair(run=run, **_registered(_WORKER_ID))
