"""Bounded refresh and transactional revalidation contracts with owned fakes."""
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from music_app.services import library_popularity_refresh as refresh
from music_app.services import library_mix_inventory_postgres as inventory
from music_app.services.lastfm import LastfmError
from music_app.services.lastfm_track_popularity import LastfmTrackPopularity, PopularityIdentityError

NOW = datetime(2026, 10, 13, 22, tzinfo=timezone.utc)
ARTIST = "cccccccc-2345-4678-9abc-def012345678"
CONFIG = {"LASTFM_API_ENABLED": True, "LASTFM_API_KEY": "public-test-key",
          "LASTFM_API_ROOT": "https://provider.invalid/2.0/",
          "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://test.invalid/owned-test"}


def row(track_id=1, **changes):
    recording = f"{track_id:08x}-2345-4678-9abc-def012345678"
    value = {"original_local_track_id": track_id, "inventory_evidence": ["file-revision", track_id],
        "title": "Song", "artist": "Artist", "original_album_id": 10,
        "availability": "local", "recording_mbid": None, "recording_state": "unasserted",
        "recording_source": None, "artist_mbid": None, "artist_state": "unasserted",
        "artist_source": None, "album_artist_mbid": None, "album_artist_state": "unasserted",
        "album_artist_source": None, "is_compilation": False,
        "file_tags": [{"recording": recording, "artists": [ARTIST], "conflict": False}],
        "mapping_revision": None, "checked_inventory_revision": None, "retry_after": None,
        "last_result": None, "last_attempt_at": None, "mapped_inventory_revision": None,
        "mapped_recording_mbid": None, "mapped_artist_mbid": None, "source_entity_id": None}
    value.update(changes)
    return value


def popularity(value, count=42):
    return LastfmTrackPopularity(inventory.local_identity(value)[0], ARTIST,
                                "https://www.last.fm/music/Artist/_/Song", count)


class Result:
    def __init__(self, value=None):
        self.value = value
    def fetchone(self):
        return self.value
    def fetchall(self):
        return self.value


class Connection:
    autocommit = False
    def __init__(self, result=None, rows=None):
        self.calls = []
        self.rows = rows or []
        self.result = {"id": 7, "provider": "lastfm", "next_attempt_at": NOW, "lease_until": None} if result is None else result
    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        if "from library.local_tracks where library_id=%s and id>%s" in sql:
            _, lower, upper, limit = params
            ids = sorted(value["original_local_track_id"] for value in self.rows
                         if lower < value["original_local_track_id"] <= upper)
            return Result([{ "id": value } for value in ids[:limit]])
        return Result(self.result)


@pytest.fixture
def service(monkeypatch):
    state = SimpleNamespace(active=0, connections=[], fetched=[], recorded=[], pauses=[], rows=[], token="lease-token", job=None, updates=[], is_active=True, reads=[])
    @contextmanager
    def connect(url):
        assert url == CONFIG["ALBUM_HAVEN_APP_DATABASE_URL"]
        assert state.active == 0, "Connections must not nest or span provider requests"
        connection = Connection(rows=state.rows)
        state.connections.append(connection)
        state.active += 1
        try:
            yield connection
        finally:
            state.active -= 1
    def fetch(config, recording, *, artist_mbid):
        assert state.active == 0, "Provider I/O must happen outside every transaction"
        state.fetched.append((recording, artist_mbid))
        return LastfmTrackPopularity(recording, artist_mbid,
            f"https://www.last.fm/music/Artist/_/{recording}", 42)
    def record(connection, library_id, originals, result, reason, token, now, *, run_ref=None):
        assert state.active == 1
        state.recorded.append((library_id, deepcopy(originals), result, reason, token, now))
        return len(originals) if result is not None else 0
    def read(connection, library_id, **kwargs):
        assert state.active == 1
        assert library_id == 7
        state.reads.append(kwargs)
        ids = kwargs.get("track_ids")
        return deepcopy([value for value in state.rows
                         if ids is None or value["original_local_track_id"] in ids])
    monkeypatch.setattr(refresh, "read_inventory", read)
    monkeypatch.setattr(refresh, "read_job", lambda connection, library_id: state.job)
    monkeypatch.setattr(refresh, "job_active", lambda *args, **kwargs: state.is_active)
    monkeypatch.setattr(refresh, "update_job", lambda connection, job, **kwargs: state.updates.append(kwargs))
    monkeypatch.setattr(refresh, "_lease", lambda connection, now: state.token)
    monkeypatch.setattr(refresh, "_record", record)
    state.connect = connect
    state.fetch = fetch
    state.run = lambda **kwargs: refresh.refresh_library_popularity(CONFIG, library_id=7,
        connect=connect, fetch=kwargs.pop("fetch", fetch), clock=lambda: NOW,
        pause=kwargs.pop("pause", state.pauses.append), stopping=kwargs.pop("stopping", lambda: False), **kwargs)
    return state


@pytest.mark.parametrize("field,replacement", [("LASTFM_API_ENABLED", False),
    ("LASTFM_API_ENABLED", "true"), ("LASTFM_API_KEY", ""), ("LASTFM_API_ROOT", ""),
    ("ALBUM_HAVEN_APP_DATABASE_URL", "")])
def test_unconfigured_refresh_does_not_connect_or_fetch(field, replacement):
    def forbidden(*args, **kwargs):
        raise AssertionError("Unconfigured job performed I/O")
    assert refresh.refresh_library_popularity(CONFIG | {field: replacement},
        connect=forbidden, fetch=forbidden) == {"status": "not_configured", "requests": 0, "mapped_tracks": 0}


def test_batch_budget_is_25_unique_recordings_with_one_second_spacing(service):
    service.rows = [row(index) for index in range(30, 0, -1)]
    result = service.run()
    assert result == {"status": "complete_batch", "requests": 25, "mapped_tracks": 25, "next_batch_in": None}
    assert [record[1][0]["original_local_track_id"] for record in service.recorded] == list(range(1, 26))
    assert len(service.fetched) == 25
    assert service.pauses == [1.0] * 24
    assert service.active == 0


def test_duplicate_local_copies_share_one_lookup_and_all_receive_evidence(service):
    first = row()
    second = row(2, file_tags=deepcopy(first["file_tags"]))
    service.rows = [first, second]
    assert service.run() == {"status": "complete_batch", "requests": 1, "mapped_tracks": 2, "next_batch_in": None}
    assert [value["original_local_track_id"] for value in service.recorded[0][1]] == [1, 2]
    assert service.pauses == []


def test_cache_ttl_is_inventory_bound_and_unavailable_or_unknown_rows_are_not_requested(service):
    cached = row(1, retry_after=NOW + timedelta(hours=1))
    cached["checked_inventory_revision"] = inventory.inventory_revision(cached)
    changed = row(2, retry_after=NOW + timedelta(hours=1), checked_inventory_revision="0" * 64)
    expired = row(3, retry_after=NOW)
    expired["checked_inventory_revision"] = inventory.inventory_revision(expired)
    service.rows = [cached, changed, expired, row(4, availability="unresolved"), row(5, file_tags=[])]
    assert service.run()["requests"] == 2
    assert [record[1][0]["original_local_track_id"] for record in service.recorded] == [2, 3]


def test_never_attempted_and_oldest_due_identities_are_first(service):
    service.rows = [row(1, last_attempt_at=NOW), row(2, last_attempt_at=NOW - timedelta(days=2)), row(3)]
    service.run()
    assert [record[1][0]["original_local_track_id"] for record in service.recorded] == [3, 2, 1]


def test_foreign_process_lease_defers_before_inventory_or_provider(service):
    service.token = None
    service.rows = [row()]
    assert service.run() == {"status": "deferred", "requests": 0, "mapped_tracks": 0, "next_batch_in": None}
    assert service.fetched == []
    assert service.recorded == []
    assert len(service.connections) == 1


@pytest.mark.parametrize("code,expected_backoff", [(29, timedelta(minutes=15)),
    (11, timedelta(minutes=15)), (10, timedelta(days=1)), (4, timedelta(days=1)), (26, timedelta(days=1))])
def test_provider_failure_stops_requests_and_releases_lease_with_backoff(service, code, expected_backoff):
    service.rows = [row(1), row(2)]
    calls = []
    def fetch(*args, **kwargs):
        assert service.active == 0
        calls.append(args)
        raise LastfmError("provider unavailable", code=code)
    result = service.run(fetch=fetch)
    assert result == {"status": "provider_unavailable", "requests": 1, "mapped_tracks": 0, "next_batch_in": None}
    assert len(calls) == 1
    assert service.recorded[0][2:4] == (None, "provider_unavailable")
    sql, params = service.connections[-1].calls[-1]
    assert "lease_token=%s" in sql
    assert params == (NOW + expected_backoff, "lease-token")


@pytest.mark.parametrize("error,reason", [(PopularityIdentityError("mismatch"), "ambiguous_attribution"),
    (LastfmError("not found", code=6), "missing_provider_mapping"),
    (LastfmError("invalid resource", code=7), "missing_provider_mapping")])
def test_unmapped_recording_does_not_poison_later_recording(service, error, reason):
    service.rows = [row(1), row(2)]
    attempted = []
    def fetch(config, recording, *, artist_mbid):
        attempted.append(recording)
        if len(attempted) == 1:
            raise error
        return LastfmTrackPopularity(recording, artist_mbid, "https://www.last.fm/music/A/_/B", 1)
    assert service.run(fetch=fetch) == {"status": "complete_batch", "requests": 2, "mapped_tracks": 1, "next_batch_in": None}
    assert service.recorded[0][3] == reason
    assert service.recorded[1][3] is None


def test_unexpected_fetch_error_propagates_but_lease_is_released(service):
    service.rows = [row()]
    def fetch(*args, **kwargs):
        raise RuntimeError("unexpected test failure")
    with pytest.raises(RuntimeError, match="unexpected test failure"):
        service.run(fetch=fetch)
    assert service.recorded == []
    assert service.connections[-1].calls[-1][1] == (NOW + timedelta(minutes=15), "lease-token")


@pytest.fixture
def recorder(monkeypatch):
    state = SimpleNamespace(connection=Connection(), originals=[row()], current=[], observations=[], checks=[], reads=[])
    def lease(connection, token, now):
        state.checks.append((connection, token, now))
    def read(connection, library_id, **kwargs):
        state.reads.append((library_id, kwargs))
        return state.current
    def put(connection, value):
        state.observations.append(value)
        return "accepted", value
    monkeypatch.setattr(refresh, "_check_lease", lease)
    monkeypatch.setattr(refresh, "read_inventory", read)
    monkeypatch.setattr(refresh, "put_observation", put)
    state.current = deepcopy(state.originals)
    state.run = lambda result, reason=None: refresh._record(state.connection, 7,
        state.originals, result, reason, "owned-token", NOW)
    return state


def test_ingestion_revalidates_inventory_under_locks_before_appending_observation(recorder):
    result = popularity(recorder.originals[0])
    assert recorder.run(result) == 1
    assert recorder.checks == [(recorder.connection, "owned-token", NOW)]
    assert recorder.reads == [(7, {"track_ids": [1], "lock": True})]
    observation, = recorder.observations
    assert (observation.provider, observation.metric, observation.count) == ("lastfm", "overall_scrobbles", 42)
    assert observation.observed_at == observation.imported_at == NOW
    assert observation.attribution_state == "resolved"
    writes = recorder.connection.calls
    assert "track_popularity_mapping_versions" in writes[0][0]
    assert writes[0][1][0] == 1
    assert writes[0][1][2:6] == (inventory.inventory_revision(recorder.current[0]),
        result.recording_mbid, ARTIST, result.source_entity_id)
    assert writes[-1][1][4:] == (NOW + timedelta(days=1), "ready")


@pytest.mark.parametrize("change", ["file_changed", "unavailable", "deleted"])
def test_stale_or_removed_track_cannot_receive_provider_result(recorder, change):
    if change == "file_changed":
        recorder.current[0]["inventory_evidence"] = ["new-file"]
    elif change == "unavailable":
        recorder.current[0]["availability"] = "unresolved"
    else:
        recorder.current = []
    assert recorder.run(popularity(recorder.originals[0])) == 0
    assert recorder.observations == []
    assert recorder.connection.calls == []


def test_unchanged_mapping_revision_is_reused_on_count_refresh(recorder):
    result = popularity(recorder.originals[0])
    current = recorder.current[0]
    current.update(mapping_revision="existing-revision", mapped_inventory_revision=inventory.inventory_revision(current),
        mapped_recording_mbid=result.recording_mbid, mapped_artist_mbid=ARTIST,
        source_entity_id=result.source_entity_id)
    recorder.originals = deepcopy(recorder.current)
    assert recorder.run(result) == 1
    assert len(recorder.connection.calls) == 1
    assert recorder.connection.calls[0][1][1] == "existing-revision"


def test_missing_global_metric_is_recorded_as_unknown_with_day_ttl(recorder):
    assert recorder.run(popularity(recorder.originals[0], count=None)) == 1
    assert recorder.observations[0].count is None
    assert recorder.observations[0].attribution_state == "missing"
    assert recorder.connection.calls[-1][1][4:] == (NOW + timedelta(days=1), "missing_global_metric")


@pytest.mark.parametrize("reason,preserve,backoff", [
    ("provider_unavailable", True, timedelta(minutes=15)),
    ("ambiguous_attribution", False, timedelta(days=1)),
    ("missing_provider_mapping", False, timedelta(days=1)),
])
def test_outage_preserves_verified_mapping_but_new_identity_failure_invalidates_it(recorder, reason, preserve, backoff):
    recorder.current[0]["mapping_revision"] = "existing-revision"
    recorder.originals = deepcopy(recorder.current)
    assert recorder.run(None, reason) == 0
    assert recorder.observations == []
    call, = recorder.connection.calls
    assert call[1][1] == ("existing-revision" if preserve else None)
    assert call[1][4:] == (NOW + backoff, reason)


def test_rejected_observation_cannot_replace_mapping_slot(recorder, monkeypatch):
    monkeypatch.setattr(refresh, "put_observation", lambda connection, observation: ("stale", observation))
    assert recorder.run(popularity(recorder.originals[0])) == 0
    assert recorder.connection.calls == []


def test_expired_or_replaced_lease_blocks_ingestion_before_data_reads(monkeypatch):
    connection = Connection()
    connection.result = None
    def forbidden(*args, **kwargs):
        raise AssertionError("Expired lease reached data boundary")
    monkeypatch.setattr(refresh, "read_inventory", forbidden)
    monkeypatch.setattr(refresh, "put_observation", forbidden)
    original = row()
    with pytest.raises(RuntimeError, match="lease expired"):
        refresh._record(connection, 7, [original], popularity(original), None, "old-token", NOW)
    sql, params = connection.calls[0]
    assert "lease_token=%s" in sql and "lease_until > %s" in sql and "for share" in sql
    assert params == ("old-token", NOW)


def demand_job(**changes):
    return {"library_id": 7, "run_ref": "11111111-1111-4111-8111-111111111111",
        "status": "queued", "upper_track_id": 60, "last_track_id": 0,
        "started_at": NOW - timedelta(minutes=1), "next_batch_at": NOW,
        "examined_tracks": 0, "provider_requests": 0} | changes


def test_demand_batch_advances_high_water_cursor_without_admitting_new_tracks():
    rows = [row(index) for index in range(1, 71)]
    job = demand_job(upper_track_id=60)
    all_ids = []
    for expected_cursor in (25, 50, 60):
        groups, cursor, examined = refresh.plan_batch(rows, NOW, job)
        batch_ids = [value["original_local_track_id"] for group in groups.values() for value in group]
        assert len(groups) <= 25
        assert cursor == expected_cursor
        assert examined == len(batch_ids)
        all_ids.extend(batch_ids)
        job = job | {"last_track_id": cursor}
    assert all_ids == list(range(1, 61))
    groups, cursor, examined = refresh.plan_batch(rows, NOW, job)
    assert groups == {}
    assert cursor == 60
    assert examined == 0


def test_demand_cursor_crosses_unknown_deleted_and_cached_rows_without_requests():
    cached = row(2, retry_after=NOW + timedelta(days=1))
    cached["checked_inventory_revision"] = inventory.inventory_revision(cached)
    rows = [row(1, file_tags=[]), cached, row(4, availability="unresolved")]
    groups, cursor, examined = refresh.plan_batch(rows, NOW, demand_job(upper_track_id=5))
    assert groups == {}
    assert cursor == 5
    assert examined == 3


def test_demand_refresh_exposes_continuation_until_finite_range_is_exhausted(service):
    service.rows = [row(index) for index in range(1, 61)]
    service.job = demand_job()
    result = service.run()
    assert result == {"status": "queued", "requests": 25, "mapped_tracks": 25, "next_batch_in": 60.0}
    assert service.updates[-1] == {"status": "queued", "now": NOW,
        "delay": timedelta(minutes=1), "cursor": 25, "examined": 25, "requests": 25}
    service.job = demand_job(last_track_id=50)
    result = service.run()
    assert result == {"status": "complete", "requests": 10, "mapped_tracks": 10, "next_batch_in": None}
    assert service.updates[-1]["cursor"] == 60
    assert service.updates[-1]["examined"] == 10


def test_demand_respects_next_batch_cooldown_before_lease_and_provider(service):
    service.job = demand_job(next_batch_at=NOW + timedelta(seconds=30))
    service.rows = [row()]
    assert service.run() == {"status": "deferred", "requests": 0, "mapped_tracks": 0, "next_batch_in": 30.0}
    assert service.fetched == []
    assert service.recorded == []
    assert service.updates == []


def test_cancelled_demand_is_observed_before_any_provider_request(service):
    service.job = demand_job()
    service.is_active = False
    service.rows = [row()]
    assert service.run() == {"status": "cancelled", "requests": 0, "mapped_tracks": 0}
    assert service.fetched == []
    assert service.recorded == []


def test_shutdown_preserves_resumable_cursor_and_stops_provider_work(service):
    service.job = demand_job(last_track_id=10)
    service.rows = [row(index) for index in range(11, 41)]
    result = service.run(stopping=lambda: True)
    assert result == {"status": "queued", "requests": 0, "mapped_tracks": 0, "next_batch_in": None}
    assert service.updates[-1]["cursor"] == 10
    assert service.updates[-1]["examined"] == 0
    assert service.fetched == []


def test_demand_provider_failure_is_visible_blocked_with_unadvanced_cursor(service):
    service.job = demand_job(last_track_id=10)
    service.rows = [row(11)]
    def fetch(*args, **kwargs):
        raise LastfmError("service unavailable", code=11)
    result = service.run(fetch=fetch)
    assert result == {"status": "blocked", "requests": 1, "mapped_tracks": 0, "next_batch_in": None}
    assert service.updates[-1]["cursor"] == 10
    assert service.updates[-1]["examined"] == 0
    assert service.updates[-1]["delay"] == timedelta(minutes=15)


def test_inflight_cancellation_or_new_run_prevents_observation_and_mapping_write(recorder, monkeypatch):
    calls = []
    def inactive(connection, library_id, run_ref, **kwargs):
        calls.append((library_id, run_ref, kwargs))
        return False
    monkeypatch.setattr(refresh, "job_active", inactive)
    assert refresh._record(recorder.connection, 7, recorder.originals,
        popularity(recorder.originals[0]), None, "owned-token", NOW, run_ref="superseded-run") == 0
    assert calls == [(7, "superseded-run", {"lock": True})]
    assert recorder.reads == []
    assert recorder.observations == []
    assert recorder.connection.calls == []


def test_shutdown_during_inter_request_pause_prevents_next_provider_call(service):
    service.job = demand_job()
    service.rows = [row(1), row(2)]
    stopped = []
    def pause(seconds):
        assert seconds == 1.0
        stopped.append(True)
    result = service.run(pause=pause, stopping=lambda: bool(stopped))
    assert len(service.fetched) == 1
    assert result["requests"] == 1
    assert result["status"] == "queued"
    assert result["next_batch_in"] is None


def test_cancel_during_inter_request_pause_prevents_next_provider_call(service):
    service.job = demand_job()
    service.rows = [row(1), row(2)]
    def pause(seconds):
        assert seconds == 1.0
        service.is_active = False
    result = service.run(pause=pause)
    assert len(service.fetched) == 1
    assert result == {"status": "cancelled", "requests": 1, "mapped_tracks": 1}


def test_demand_only_continuation_never_starts_unrequested_background_batch(service):
    service.rows = [row()]
    assert service.run(demand_only=True) == {"status": "inactive", "requests": 0, "mapped_tracks": 0}
    assert service.fetched == []
    assert service.recorded == []


def test_partial_inventory_page_does_not_skip_the_remaining_demand_range():
    groups, cursor, examined = refresh.plan_batch([row(1, file_tags=[]), row(2, file_tags=[])],
        NOW, demand_job(), complete_range=False)
    assert groups == {}
    assert (cursor, examined) == (2, 2)


def test_demand_inventory_page_is_bounded_and_continues_past_unmapped_rows(service):
    service.job = demand_job(upper_track_id=5002)
    service.rows = [row(index, file_tags=[]) for index in range(1, 5001)] + [row(5001), row(5002)]
    result = service.run()
    assert result == {"status": "queued", "requests": 0, "mapped_tracks": 0, "next_batch_in": 60.0}
    assert service.reads == [{"track_ids": list(range(1, 5001))}]
    assert service.updates[-1]["cursor"] == 5000
    assert service.updates[-1]["examined"] == 5000
    id_queries = [call for connection in service.connections for call in connection.calls
                  if "from library.local_tracks where library_id=%s and id>%s" in call[0]]
    assert id_queries[0][1] == (7, 0, 5002, 5001)
    service.job = demand_job(upper_track_id=5002, last_track_id=5000)
    assert service.run() == {"status": "complete", "requests": 2, "mapped_tracks": 2, "next_batch_in": None}
    assert service.updates[-1]["cursor"] == 5002


def test_demand_with_busy_global_lease_remains_queued_without_provider_read(service):
    service.job = demand_job()
    service.token = None
    assert service.run() == {"status": "deferred", "requests": 0, "mapped_tracks": 0, "next_batch_in": 60.0}
    assert service.updates[-1]["status"] == "queued"
    assert service.updates[-1]["cursor"] == 0
    assert service.fetched == []
