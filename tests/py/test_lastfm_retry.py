"""Background, batched Last.fm scrobble submission: per-listen policy, batches, and the worker."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import math
import queue
import threading
from types import SimpleNamespace

import pytest

from music_app.services import lastfm_retry, listen_history, listen_history_postgres
from music_app.services.lastfm import LastfmError, LastfmScrobble, LastfmSubmissionOutcome
from music_app.services.lastfm_sync_bridge import (
    attempting_updates,
    failed_batch_disposition,
    plan_pending_scrobble,
    scrobble_attempt_updates,
    scrobble_identity,
    scrobble_retry_delay_seconds,
    scrobble_verification_due,
    scrobble_verification_due_at,
    verified_scrobble_updates,
)
from music_app.services.log_history import HistoryScope
from tests.py.bounded_interactions import OperationCounts, measure_scale_pair
from tests.py.lastfm_scrobble_ledger import (
    ACCOUNT_ID,
    LIBRARY_ID,
    FakeLastfm,
    FakeRecentTracks,
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
    monkeypatch.setattr(lastfm_retry, "_RUNNING", {})

    def install(counts: OperationCounts | None = None, *, answer=None) -> tuple[ScrobbleLedger, FakeLastfm]:
        """The ledger and Last.fm's scrobble call; ``ledger.recent_tracks`` answers lookups."""
        ledger = ScrobbleLedger(counts)
        ledger.sessions[ACCOUNT_ID] = "fixture-session"
        provider = FakeLastfm(ledger, answer)
        ledger.recent_tracks = FakeRecentTracks(ledger)
        monkeypatch.setattr(listen_history_postgres, "_connect", ledger.connect)
        monkeypatch.setattr(lastfm_retry, "scrobble_tracks", provider)
        monkeypatch.setattr(lastfm_retry, "get_lastfm_scrobbles_between", ledger.recent_tracks)
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


@pytest.mark.parametrize(("error", "expected"), [
    (LastfmError("Service Offline", code=11, retryable=True), (True, "not_sent")),
    (LastfmError("Invalid session key", code=9, reauthentication_required=True), (True, "not_sent")),
    (LastfmError("Network error contacting Last.fm", retryable=True, error_kind="network_error"),
     (False, "uncertain")),
    (LastfmError("Malformed", retryable=True, error_kind="malformed_response"), (False, "uncertain")),
    # Last.fm refused the request itself, so it recorded nothing: final, never looked up or resent.
    (LastfmError("Invalid parameters", code=6), (False, "sent")),
    # "Operation failed" may have happened after Last.fm recorded the scrobbles.
    (LastfmError("Operation failed", code=8), (False, "uncertain")),
    # Network down or Last.fm unreachable: the request never fully left the server.
    (LastfmError("Connection refused", retryable=True, error_kind="network_error", request_sent=False),
     (True, "not_sent")),
    # Last.fm answered that it did not process the request.
    (LastfmError("Request timeout", retryable=True, http_status=408), (True, "not_sent")),
    (LastfmError("Too early", retryable=True, http_status=425), (True, "not_sent")),
    (LastfmError("Rate limited", retryable=True, http_status=429), (True, "not_sent")),
    (LastfmError("Unavailable", retryable=True, http_status=503), (True, "not_sent")),
    (LastfmError("Internal error", retryable=True, http_status=500), (False, "uncertain")),
    # A gateway may have passed the request on before it failed.
    (LastfmError("Bad gateway", retryable=True, http_status=502), (False, "uncertain")),
    (LastfmError("Gateway timeout", retryable=True, http_status=504), (False, "uncertain")),
    # A 500, 502 or 504 stays uncertain even when its body carries a retryable Last.fm error code.
    (LastfmError("Operation failed (Last.fm error 16)", code=16, retryable=True, http_status=500),
     (False, "uncertain")),
    (LastfmError("Service Offline (Last.fm error 11)", code=11, retryable=True, http_status=504),
     (False, "uncertain")),
    (LastfmError("Service Offline (Last.fm error 11)", code=11, retryable=True, http_status=502),
     (False, "uncertain")),
])
def test_failed_batch_is_resent_only_when_last_fm_cannot_have_recorded_it(error, expected):
    assert failed_batch_disposition(error) == expected


@pytest.mark.parametrize("measured", [True, False])
@pytest.mark.parametrize("error_kind", ["network_error", "malformed_response"])
def test_a_timeout_or_unreadable_answer_after_the_post_is_never_resent(scrobble_ledger, measured, error_kind):
    ledger, provider = scrobble_ledger(answer=lambda _payloads: LastfmError(
        "Network error contacting Last.fm", retryable=True, error_kind=error_kind))
    ledger.add_pending(2, measured=measured)

    lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG, bypass_backoff=True)
    lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG, bypass_backoff=True)

    assert len(provider.calls) == 1
    for entry in ledger.entries():
        assert (entry["scrobble_submission_state"], entry["scrobble_retryable"]) == ("uncertain", False)
        assert not listen_history.is_pending_scrobble_entry(entry)


@pytest.mark.parametrize("measured", [True, False])
def test_listens_held_by_an_outage_are_sent_once_when_last_fm_is_reachable_again(scrobble_ledger, measured):
    outage = {"active": True}

    def answer(_payloads):
        if outage["active"]:
            return LastfmError("Network is unreachable", retryable=True, error_kind="network_error",
                               request_sent=False)
        return [LastfmSubmissionOutcome(sent=True, accepted=1, outcome="accepted") for _payload in _payloads]

    ledger, provider = scrobble_ledger(answer=answer)
    ledger.add_pending(2, measured=measured)

    lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG, bypass_backoff=True)
    assert all(listen_history.is_pending_scrobble_entry(entry) for entry in ledger.entries())

    outage["active"] = False
    lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG, bypass_backoff=True)
    lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG, bypass_backoff=True)

    assert len(provider.calls) == 2
    assert [entry["scrobble_submission_state"] for entry in ledger.entries()] == ["accepted", "accepted"]


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


def test_a_revoked_account_does_not_hold_up_other_accounts_listens(scrobble_ledger):
    other_account = ACCOUNT_ID + 1
    ledger, provider = scrobble_ledger()
    ledger.sessions[other_account] = "other-session"
    ledger.add_pending(60)
    ledger.add_pending(2, account_id=other_account, start=100)
    provider.answer = lambda payloads: (
        LastfmError("Invalid session key (Last.fm error 9)", code=9, reauthentication_required=True)
        if provider.calls[-1].session_key == "fixture-session"
        else FakeLastfm(ledger).answer(payloads)
    )

    result = lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG, bypass_backoff=True)

    # The revoked account's first batch fails; its second waits for the reconnection.
    assert [(call.session_key, len(call.tracks)) for call in provider.calls] == [
        ("fixture-session", 50), ("other-session", 2)]
    revoked = [entry for entry in ledger.entries() if int(entry["title"].split()[1]) < 100]
    assert sum(bool(entry.get("scrobble_reauthentication_required")) for entry in revoked) == 50
    assert all(entry["scrobbled"] for entry in ledger.entries() if int(entry["title"].split()[1]) >= 100)
    assert result.summary["succeeded"] == 2
    # Nothing else is due until the account reconnects.
    assert result.retry_in_seconds is None


def test_permanent_rejection_marks_the_batch_without_resending(scrobble_ledger):
    ledger, provider = scrobble_ledger(answer=lambda _payloads: LastfmError("Invalid parameters (Last.fm error 6)", code=6))
    ledger.add_pending(2)

    lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG, bypass_backoff=True)
    lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG, bypass_backoff=True)

    assert len(provider.calls) == 1
    for entry in ledger.entries():
        assert (entry["scrobble_submission_state"], entry["scrobble_retryable"]) == ("sent", False)
        assert not listen_history.is_unverified_scrobble_entry(entry)
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


# Verifying unknown outcomes ------------------------------------------------

def _ago(minutes: float) -> str:
    return (datetime.now(timezone.utc) - timedelta(minutes=minutes)).isoformat()


def _add_unverified(ledger: ScrobbleLedger, count: int, *, minutes_ago: float = 10, start: int = 0,
                    account_id: int = ACCOUNT_ID, **changes) -> None:
    """Listens whose last submission ended with an unknown outcome ``minutes_ago``."""
    ledger.add_pending(count, start=start, account_id=account_id, **{
        "scrobble_submission_state": "uncertain", "scrobble_retryable": False, "scrobble_retry_count": 1,
        "last_scrobble_attempt_at": _ago(minutes_ago), **changes,
    })


def test_scrobble_identity_ignores_case_width_and_spacing_in_any_script():
    assert scrobble_identity(1_700_000_000, "ДДТ", "Осень") == scrobble_identity("1700000000", "ддт", "  ОСЕНЬ ")
    assert scrobble_identity(1, "Ёлка", "Прощай,  ШКОЛА") == scrobble_identity(1, "ёлка", "прощай, школа")
    assert scrobble_identity(1, "Ｍｕｓｅ", "Straße") == scrobble_identity(1, "muse", "STRASSE")
    # Different seconds, artists or tracks are different scrobbles.
    assert scrobble_identity(1, "ДДТ", "Осень") != scrobble_identity(2, "ДДТ", "Осень")
    assert scrobble_identity(1, "ДДТ", "Осень") != scrobble_identity(1, "ДДТ", "Осень (live)")
    assert scrobble_identity(1, "Е", "Song") != scrobble_identity(1, "Ё", "Song")


def test_an_unknown_outcome_is_looked_up_five_minutes_after_its_submission_and_backs_off_after_a_failed_lookup():
    entry = listen_entry(1, scrobble_submission_state="uncertain", scrobble_retryable=False,
                         last_scrobble_attempt_at=_NOW.isoformat())
    assert scrobble_verification_due_at(entry, now=_NOW) == _NOW + timedelta(minutes=5)
    assert not scrobble_verification_due(entry, now=_NOW + timedelta(minutes=4), bypass_backoff=True)
    assert scrobble_verification_due(entry, now=_NOW + timedelta(minutes=5))
    # A crash after the claim leaves the listen claimed; the claim time is when its submission started.
    claimed = {**listen_entry(1), **attempting_updates(_NOW)}
    assert scrobble_verification_due_at(claimed, now=_NOW) == _NOW + timedelta(minutes=5)
    # Failed lookups back off like failed submissions, to the 15-minute cap; Submit skips the backoff.
    failed = {**entry, "scrobble_verification_failures": 7,
              "last_scrobble_verification_at": (_NOW + timedelta(minutes=10)).isoformat()}
    assert scrobble_verification_due_at(failed, now=_NOW) == _NOW + timedelta(minutes=25)
    assert scrobble_verification_due(failed, now=_NOW + timedelta(minutes=11), bypass_backoff=True)
    # Reauthentication holds the lookup until the account reconnects.
    revoked = {**entry, "scrobble_reauthentication_required": True}
    assert not scrobble_verification_due(revoked, now=_NOW + timedelta(hours=1), bypass_backoff=True)
    assert scrobble_verification_due(revoked, now=_NOW + timedelta(hours=1), reauthenticated=True)
    # A listen whose outcome is known is never looked up.
    for state in ("accepted", "sent", "not_sent", ""):
        assert not scrobble_verification_due({**entry, "scrobble_submission_state": state}, now=_NOW + timedelta(hours=1))


def test_a_listen_found_on_last_fm_is_accepted_and_never_sent_again(scrobble_ledger, monkeypatch):
    ledger, provider = scrobble_ledger()
    _add_unverified(ledger, 2, measured=False)
    ledger.recent_tracks.lists(*ledger.entries())
    events = []
    monkeypatch.setattr(lastfm_retry, "log_app_event", lambda _config, _logger, _action, **fields: events.append(fields))

    first = lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG)
    second = lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG, bypass_backoff=True)

    assert provider.calls == []
    assert len(ledger.recent_tracks.calls) == 1
    for entry in ledger.entries():
        assert (entry["scrobbled"], entry["scrobble_submission_state"], entry["sync_problem"]) == (True, "accepted", None)
        assert entry["scrobbled_at"] == entry["last_scrobble_attempt_at"]
        assert entry["scrobble_retry_count"] == 1
        assert not listen_history.is_unverified_scrobble_entry(entry)
    assert first.retry_in_seconds is None and second.summary["pending_before"] == 0
    assert [{key: fields[key] for key in ("attempted", "verified_present", "verified_absent")} for fields in events] == [
        {"attempted": 0, "verified_present": 2, "verified_absent": 0}]


def test_a_listen_missing_from_last_fm_is_resent_once_through_the_batch(scrobble_ledger, monkeypatch):
    ledger, provider = scrobble_ledger()
    _add_unverified(ledger, 3)
    ledger.recent_tracks.lists(ledger.entry(2))
    events = []
    monkeypatch.setattr(lastfm_retry, "log_app_event", lambda _config, _logger, action, **fields: events.append(
        (action, fields)))

    result = lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG)
    lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG, bypass_backoff=True)

    # Song 1 was on Last.fm; the others were not, and go out together in one batch call.
    assert [call.tracks for call in provider.calls] == [["Song 0", "Song 2"]]
    assert provider.calls[0].claimed_states == {"attempting"}
    assert [entry["scrobble_submission_state"] for entry in ledger.entries()] == ["accepted"] * 3
    assert [entry["scrobble_retry_count"] for entry in ledger.entries()] == [2, 1, 2]
    assert result.summary == {"pending_before": 0, "attempted": 2, "succeeded": 2, "failed": 0, "pending_after": 0}
    [(action, fields)] = events
    assert action == "Last.fm scrobble retry pass completed"
    assert {key: fields[key] for key in ("attempted", "succeeded", "failed", "verified_present", "verified_absent")} == {
        "attempted": 2, "succeeded": 2, "failed": 0, "verified_present": 1, "verified_absent": 2}
    assert not {"artist", "album", "title", "track", "session_key"} & set(fields)


def test_a_resend_last_fm_ignores_is_final(scrobble_ledger):
    ledger, provider = scrobble_ledger(answer=lambda payloads: [
        LastfmSubmissionOutcome(sent=True, ignored=1, outcome="ignored", ignored_code=3, message="Timestamp too old")
        for _payload in payloads])
    _add_unverified(ledger, 1)

    lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG)
    for _later in range(3):
        lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG, bypass_backoff=True)

    [entry] = ledger.entries()
    assert (len(ledger.recent_tracks.calls), len(provider.calls)) == (1, 1)
    assert (entry["scrobbled"], entry["scrobble_submission_state"], entry["scrobble_retryable"]) == (False, "sent", False)
    assert entry["sync_problem"]["status"] == "permanent_failure"
    assert not listen_history.is_pending_scrobble_entry(entry)
    assert not listen_history.is_unverified_scrobble_entry(entry)


def test_a_resend_with_an_unknown_outcome_is_looked_up_again_before_any_further_send(scrobble_ledger):
    ledger, provider = scrobble_ledger(answer=lambda _payloads: LastfmError("Bad gateway", retryable=True, http_status=502))
    _add_unverified(ledger, 1)

    lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG)
    lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG, bypass_backoff=True)

    [entry] = ledger.entries()
    assert (len(ledger.recent_tracks.calls), len(provider.calls)) == (1, 1)
    assert (entry["scrobble_submission_state"], entry["scrobble_retry_count"]) == ("uncertain", 2)
    assert scrobble_verification_due_at(entry, now=_NOW) == datetime.fromisoformat(
        entry["last_scrobble_attempt_at"]) + timedelta(minutes=5)


@pytest.mark.parametrize("failure", [
    LastfmError("Network is unreachable", retryable=True, error_kind="network_error", request_sent=False),
    LastfmError("Network error contacting Last.fm", retryable=True, error_kind="network_error"),
    LastfmError("Rate limited", retryable=True, http_status=429, retry_after_seconds=60),
    LastfmError("Unavailable", retryable=True, http_status=503),
    LastfmError("Malformed", retryable=True, error_kind="malformed_response"),
], ids=["unreachable", "timeout", "429", "503", "malformed"])
def test_a_failed_lookup_leaves_the_outcome_unknown_and_is_retried_after_its_backoff(scrobble_ledger, failure):
    ledger, provider = scrobble_ledger()
    _add_unverified(ledger, 2)
    ledger.recent_tracks.lists(ledger.entry(1))
    ledger.recent_tracks.answer = lambda _call: failure
    ledger.add_pending(1, start=10)

    during = lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG)

    # Last.fm cannot be read, so the pass stops before sending the waiting listen too.
    assert provider.calls == [] and len(ledger.recent_tracks.calls) == 1
    assert during.retry_in_seconds == max(30, failure.retry_after_seconds or 0)
    for entry in ledger.entries()[:2]:
        assert (entry["scrobble_submission_state"], entry["scrobble_verification_failures"]) == ("uncertain", 1)
        assert listen_history.is_unverified_scrobble_entry(entry)
        assert not entry.get("scrobble_reauthentication_required")
        assert not scrobble_verification_due(entry, now=datetime.now(timezone.utc))

    ledger.recent_tracks.answer = None
    lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG, bypass_backoff=True)

    assert [entry["scrobble_submission_state"] for entry in ledger.entries()] == ["accepted"] * 3
    assert [call.tracks for call in provider.calls] == [["Song 1", "Song 10"]]
    assert ledger.entry(1)["scrobble_verification_failures"] == 0


def test_submit_reports_a_failed_lookup_as_incomplete(scrobble_ledger, monkeypatch):
    ledger, provider = scrobble_ledger()
    _add_unverified(ledger, 2)
    ledger.recent_tracks.answer = lambda _call: LastfmError(
        "Network is unreachable", retryable=True, error_kind="network_error", request_sent=False)
    events = []
    monkeypatch.setattr(lastfm_retry, "log_app_event", lambda _config, _logger, action, **fields: events.append(
        (action, fields)))
    monkeypatch.setattr(lastfm_retry, "_WORKER_WAKE_EVENT", threading.Event())

    lastfm_retry.request_lastfm_submission(_submit_scope())
    lastfm_retry._run_requested_pass(_CONFIG, None, *lastfm_retry._take_request())

    assert provider.calls == []
    assert lastfm_retry.lastfm_submission_status(ACCOUNT_ID) == {"state": "failed", "error": lastfm_retry.SUBMISSION_INCOMPLETE}
    pass_line = [fields for action, fields in events if action == "Last.fm scrobble retry pass completed"]
    assert [{key: fields[key] for key in ("attempted", "failed", "verified_present", "verified_absent")}
            for fields in pass_line] == [{"attempted": 0, "failed": 2, "verified_present": 0, "verified_absent": 0}]
    failure = [fields for action, fields in events if action == "Last.fm pending scrobble submission failed"]
    assert [(fields["failed"], fields["attempted"]) for fields in failure] == [(2, 0)]


def test_a_lookup_that_needs_reauthentication_holds_only_that_account(scrobble_ledger):
    other_account = ACCOUNT_ID + 1
    ledger, provider = scrobble_ledger()
    ledger.sessions[other_account] = "other-session"
    _add_unverified(ledger, 2)
    _add_unverified(ledger, 1, start=100, account_id=other_account)
    ledger.add_pending(1, start=200)
    ledger.recent_tracks.lists(ledger.entry(3))
    ledger.recent_tracks.answer = lambda call: (
        LastfmError("Invalid session key (Last.fm error 9)", code=9, reauthentication_required=True)
        if call.session_key == "fixture-session" else None)

    result = lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG)

    assert [call.session_key for call in ledger.recent_tracks.calls] == ["fixture-session", "other-session"]
    assert provider.calls == [], "the revoked account's waiting listen waits for its reconnection"
    held = ledger.entries()[:2]
    assert all(entry["scrobble_reauthentication_required"] for entry in held)
    assert all(listen_history.is_unverified_scrobble_entry(entry) for entry in held)
    assert ledger.entry(3)["scrobbled"] is True
    assert result.retry_in_seconds is None

    ledger.recent_tracks.answer = None
    lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG, reauthenticated=True)

    assert all(entry["scrobbled"] for entry in ledger.entries())
    assert [call.tracks for call in provider.calls] == [["Song 0", "Song 1", "Song 200"]]


def test_a_lookup_last_fm_refuses_holds_only_that_accounts_lookups(scrobble_ledger):
    other_account = ACCOUNT_ID + 1
    ledger, provider = scrobble_ledger()
    ledger.sessions[other_account] = "other-session"
    # Account A was renamed on Last.fm, so its lookups are refused for good.
    _add_unverified(ledger, 2)
    ledger.add_pending(1, start=100, account_id=other_account)
    ledger.recent_tracks.answer = lambda call: (
        LastfmError("User not found (Last.fm error 6)", code=6) if call.session_key == "fixture-session" else None)

    results = [lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG, bypass_backoff=True) for _pass in range(3)]

    # Account B's listen goes out in the first pass, once; A's lookups are retried every pass.
    assert [(call.session_key, call.tracks) for call in provider.calls] == [("other-session", ["Song 100"])]
    assert ledger.entry(3)["scrobbled"] is True
    assert [call.session_key for call in ledger.recent_tracks.calls] == ["fixture-session"] * 3
    for entry in ledger.entries()[:2]:
        assert listen_history.is_unverified_scrobble_entry(entry)
        assert (entry["scrobble_verification_failures"], entry.get("scrobble_reauthentication_required")) == (3, False)
    # Without Submit, A's next lookup waits for its backoff.
    assert 0 < results[-1].retry_in_seconds <= scrobble_retry_delay_seconds(3)


def test_a_lookup_reads_only_the_window_around_its_batch_never_the_whole_history(scrobble_ledger):
    ledger, _provider = scrobble_ledger()
    # 60 listens: 50 within one minute, then 10 two hours later, so two batches of one window
    # each. Last.fm also holds 30,000 other scrobbles before, between, and after them.
    _add_unverified(ledger, 50)
    _add_unverified(ledger, 10, start=7200)
    ledger.recent_tracks.lists(*ledger.entries())
    ledger.recent_tracks.scrobbles.extend(
        LastfmScrobble(timestamp, "Other", "Track")
        for timestamp in (*range(1_690_000_000, 1_690_010_000), *range(1_700_000_100, 1_700_007_000),
                          *range(1_700_010_000, 1_700_023_100)))

    lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG)

    assert [(call.after, call.before, call.page) for call in ledger.recent_tracks.calls] == [
        (1_700_000_000 - 1, 1_700_000_049 + 1, 1),
        (1_700_007_200 - 1, 1_700_007_209 + 1, 1),
    ]
    assert {call.user for call in ledger.recent_tracks.calls} == {f"listener-{ACCOUNT_ID}"}
    assert ledger.counts.candidate_rows == 60
    assert all(entry["scrobbled"] for entry in ledger.entries())


def test_a_window_with_more_scrobbles_than_its_page_limit_resolves_only_what_it_read(scrobble_ledger, monkeypatch):
    monkeypatch.setattr(lastfm_retry, "_VERIFICATION_MAX_PAGES", 2)
    ledger, provider = scrobble_ledger()
    # Two listens 40 minutes apart, with 500 other scrobbles between them: three pages.
    _add_unverified(ledger, 1)
    _add_unverified(ledger, 1, start=2400)
    ledger.recent_tracks.lists(ledger.entry(2))
    ledger.recent_tracks.scrobbles.extend(LastfmScrobble(1_700_000_001 + offset, "Other", "Track") for offset in range(500))

    lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG)

    assert [call.page for call in ledger.recent_tracks.calls] == [1, 2]
    # The newest listen was on the pages read; the oldest may be on the page left unread, so its
    # outcome stays unknown.
    first, second = ledger.entries()
    assert (second["scrobbled"], first["scrobble_submission_state"], first["scrobble_verification_failures"]) == (
        True, "uncertain", 1)
    assert provider.calls == []


def test_a_listen_without_a_timestamp_is_never_looked_up_and_fails_as_invalid(scrobble_ledger):
    ledger, provider = scrobble_ledger()
    _add_unverified(ledger, 1, started_at_unix=0)

    lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG)

    [entry] = ledger.entries()
    assert ledger.recent_tracks.calls == [] and provider.calls == []
    assert (entry["scrobble_submission_state"], entry["scrobble_retryable"]) == ("not_sent", False)
    assert entry["scrobble_error"] == "Missing listen timestamp for queued scrobble."


def test_a_listen_claimed_moments_ago_is_not_looked_up_while_its_submission_may_be_running(scrobble_ledger):
    ledger, provider = scrobble_ledger()
    ledger.add(listen_entry(1, **attempting_updates(datetime.now(timezone.utc) - timedelta(seconds=30))))
    ledger.add(listen_entry(2, **attempting_updates(datetime.now(timezone.utc) - timedelta(minutes=6))))
    ledger.recent_tracks.lists(ledger.entry(2))

    result = lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG, bypass_backoff=True)

    assert len(ledger.recent_tracks.calls) == 1
    assert ledger.entry(1)["scrobble_submission_state"] == "attempting"
    assert ledger.entry(2)["scrobble_submission_state"] == "accepted"
    assert provider.calls == []
    assert 4 * 60 < result.retry_in_seconds <= 4.5 * 60


@pytest.mark.parametrize("concurrent", ["accepted by a live submission", "returned to the queue by another lookup"])
def test_a_lookup_never_overwrites_a_listen_another_submitter_handled_after_it_was_loaded(
    scrobble_ledger, monkeypatch, concurrent,
):
    ledger, provider = scrobble_ledger()
    _add_unverified(ledger, 2)
    lock = listen_history_postgres.lock_pending_entries
    handled = (
        scrobble_attempt_updates(ledger.entry(1), attempted_at=_NOW, submission_state="accepted")
        if concurrent.startswith("accepted")
        else verified_scrobble_updates(ledger.entry(1), listed=False, verified_at=_NOW)
    )

    def handled_meanwhile(connection, batch):
        ledger.entry(1).update(handled)
        return lock(connection, batch)

    monkeypatch.setattr(lastfm_retry, "lock_pending_entries", handled_meanwhile)
    lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG)

    assert {key: ledger.entry(1)[key] for key in handled} == handled
    # The other listen was not on Last.fm either; it alone is resent, once.
    assert [call.tracks for call in provider.calls] == [["Song 1"]]


def test_a_lookup_and_a_batch_send_take_the_same_provider_guards_as_a_live_submission(scrobble_ledger, monkeypatch):
    ledger, _provider = scrobble_ledger()
    _add_unverified(ledger, 2)
    ledger.add_pending(1, start=10)
    guarded = []
    lock = listen_history_postgres.lock_pending_entries

    def observed(connection, batch):
        guarded.append(sorted(item.entry["title"] for item in batch))
        return lock(connection, batch)

    monkeypatch.setattr(lastfm_retry, "lock_pending_entries", observed)
    lastfm_retry.retry_pending_lastfm_scrobbles(_CONFIG)

    # The lookup's results are stored under the guard, and so is the claim of the resend.
    assert guarded == [["Song 0", "Song 1"], ["Song 0", "Song 1", "Song 10"]]
    assert ledger.unknown == []


# Requests and the worker ---------------------------------------------------

def _submit_scope() -> HistoryScope:
    return HistoryScope(library_id=LIBRARY_ID, account_id=ACCOUNT_ID, origin_kind="request")


def test_submit_while_the_accounts_pass_runs_starts_nothing(monkeypatch):
    monkeypatch.setattr(lastfm_retry, "_REQUESTS", {})
    monkeypatch.setattr(lastfm_retry, "_SUBMISSIONS", {})
    monkeypatch.setattr(lastfm_retry, "_RUNNING", {})
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


def test_submit_for_another_library_while_a_pass_runs_is_queued_to_run_next(monkeypatch):
    monkeypatch.setattr(lastfm_retry, "_REQUESTS", {})
    monkeypatch.setattr(lastfm_retry, "_SUBMISSIONS", {})
    monkeypatch.setattr(lastfm_retry, "_RUNNING", {})
    monkeypatch.setattr(lastfm_retry, "_WORKER_WAKE_EVENT", threading.Event())
    other_library = HistoryScope(library_id=LIBRARY_ID + 1, account_id=ACCOUNT_ID, origin_kind="request")

    lastfm_retry.request_lastfm_submission(_submit_scope())
    lastfm_retry._take_request()
    assert lastfm_retry.request_lastfm_submission(other_library) == "running"
    assert lastfm_retry._REQUESTS[ACCOUNT_ID].library_ids == frozenset({LIBRARY_ID + 1})
    assert lastfm_retry._REQUESTS[ACCOUNT_ID].history_scope == other_library
    # When the running pass ends, the account stays queued and the next pass is library B's.
    monkeypatch.setattr(lastfm_retry, "retry_pending_lastfm_scrobbles",
                        lambda *_args, **_kwargs: lastfm_retry.LastfmRetryPass(summary={
                            "pending_before": 0, "attempted": 0, "succeeded": 0, "failed": 0,
                            "pending_after": 0}))
    lastfm_retry._run_requested_pass(_CONFIG, None, ACCOUNT_ID, lastfm_retry._RUNNING[ACCOUNT_ID])
    assert lastfm_retry.lastfm_submission_status(ACCOUNT_ID)["state"] == "queued"
    assert lastfm_retry._take_request() == (ACCOUNT_ID, lastfm_retry._RetryRequest(
        library_ids=frozenset({LIBRARY_ID + 1}), bypass_backoff=True, history_scope=other_library))


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

    def run(listens: int) -> OperationCounts:
        """``listens`` sends whose outcome Last.fm left unknown (a 502), half of them recorded."""
        counts = OperationCounts()
        ledger, provider = scrobble_ledger(counts)
        _add_unverified(ledger, listens)
        ledger.recent_tracks.lists(*ledger.entries()[::2])
        # The account's history on Last.fm is ten times larger, all outside the listens' windows.
        ledger.recent_tracks.scrobbles.extend(
            LastfmScrobble(1_600_000_000 + offset, "Other", "Track") for offset in range(10 * listens))
        outage = {"calls": 1}

        def last_fm_down_once(_call):
            if outage["calls"]:
                outage["calls"] -= 1
                return LastfmError("Network is unreachable", retryable=True, error_kind="network_error",
                                   request_sent=False)
            return None

        ledger.recent_tracks.answer = last_fm_down_once
        with _WorkerProbe(monkeypatch) as worker:
            # Start-up finds listens to look up; the first lookup meets the outage and the pass stops.
            assert worker.next("check") is True
            during_outage = worker.next("pass")
            assert during_outage.summary["attempted"] == 0
            assert during_outage.retry_in_seconds == pytest.approx(0.02)
            # After the backoff the worker looks every listen up on its own and resends the missing half.
            assert worker.next("check") is True
            recovered = worker.next("pass")
            converged = OperationCounts(**vars(counts))
            # A listen left unsent wakes the worker; with nothing waiting that costs one query.
            lastfm_retry.wake_lastfm_retry_worker()
            assert worker.next("check") is False
            with pytest.raises(queue.Empty):
                worker.events.get(timeout=0.3)
        lookups, resends, missing = math.ceil(listens / 50), math.ceil(listens / 2 / 50), listens // 2
        assert recovered.summary == {"pending_before": 0, "attempted": missing, "succeeded": missing,
                                     "failed": 0, "pending_after": 0}
        assert recovered.retry_in_seconds is None
        assert all(entry["scrobbled"] for entry in ledger.entries())
        assert sum(len(call.tracks) for call in provider.calls) == missing, "each missing listen is resent once"
        # One window per batch of 50 listens, read on one page: never the account's whole history.
        assert len(ledger.recent_tracks.calls) == 1 + lookups
        assert counts.candidate_rows == listens - missing
        assert converged.provider_calls == 1 + lookups + resends
        assert converged.transactions == 1 + lookups + 2 * resends, (
            "one result transaction per lookup batch, one claim and one result transaction per send batch")
        # Two checks, two passes of 3 reads each, 3 statements per lookup batch and 4 per send batch.
        assert converged.sql_statements == 2 + 3 + 3 + 3 + 3 * lookups + 4 * resends
        assert counts.provider_calls == converged.provider_calls, "Last.fm calls stop once the queue is empty"
        assert counts.transactions == converged.transactions
        assert counts.sql_statements - converged.sql_statements == 1
        assert ledger.unknown == []
        return counts

    measure_scale_pair(run=run, **_registered(_WORKER_ID))
