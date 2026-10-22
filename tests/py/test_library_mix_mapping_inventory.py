"""Mapping freshness, real-credit grouping and scanner projection contracts."""
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from music_app.services import library_mix as mix
from music_app.services import library_mix_inventory_postgres as inventory
from music_app.services import library_popularity_jobs as jobs

NOW = datetime(2026, 10, 13, 22, tzinfo=timezone.utc)
RECORDING = "abcdef01-2345-4678-9abc-def012345678"
OTHER = "bbbbbbbb-2345-4678-9abc-def012345678"
ARTIST = "cccccccc-2345-4678-9abc-def012345678"
ALBUM_ARTIST = "dddddddd-2345-4678-9abc-def012345678"


def row(track_id=1, **changes):
    value = {"original_local_track_id": track_id, "inventory_evidence": ["file-revision", track_id],
        "title": "Song", "artist": "Artist", "original_album_id": 10,
        "availability": "local", "disc_number": 1, "track_number": track_id,
        "recording_mbid": None, "recording_state": "unasserted", "recording_source": None,
        "artist_mbid": None, "artist_state": "unasserted", "artist_source": None,
        "album_artist_mbid": None, "album_artist_state": "unasserted", "album_artist_source": None,
        "is_compilation": False,
        "file_tags": [{"recording": RECORDING, "artists": [ARTIST],
                       "album_artists": [ALBUM_ARTIST], "conflict": False}],
        "mapping_revision": "11111111-1111-4111-8111-111111111111",
        "checked_inventory_revision": None, "retry_after": None, "last_result": "ready",
        "last_attempt_at": NOW, "mapped_inventory_revision": None,
        "mapped_recording_mbid": RECORDING, "mapped_artist_mbid": ARTIST,
        "source_entity_id": "https://www.last.fm/music/Artist/_/Song", "source_revision": "api:v1",
        "observed_at": NOW, "imported_at": NOW, "count": 42, "attribution_state": "resolved"}
    value.update(changes)
    value["mapped_inventory_revision"] = inventory.inventory_revision(value)
    value["checked_inventory_revision"] = inventory.inventory_revision(value)
    return value


def snapshot(monkeypatch, rows, *, denied=()):
    calls, identity_queries, admissions = [], [], []
    class Connection:
        autocommit = False
        def execute(self, sql, params):
            identity_queries.append((sql, params))
            assert " ".join(sql.lower().split()) == "select id from library.local_tracks where library_id=%s order by id"
            return QueryResult([{"id": value["original_local_track_id"]} for value in rows])
    def readable(track_id):
        admissions.append(track_id)
        return track_id not in denied
    def read(connection, library_id, **kwargs):
        calls.append((connection, library_id, kwargs))
        wanted = kwargs["track_ids"]
        return [value for value in rows if value["original_local_track_id"] in wanted]
    monkeypatch.setattr(inventory, "read_inventory", read)
    monkeypatch.setattr(jobs, "read_job", lambda connection, library_id: None)
    connection = Connection()
    result = inventory.read_snapshot(connection, SimpleNamespace(library_id=7), is_readable=readable)
    expected = [value["original_local_track_id"] for value in rows if value["original_local_track_id"] not in denied]
    assert calls == ([(connection, 7, {"track_ids": expected, "lock": True})] if expected else [])
    assert len(identity_queries) == 1 and identity_queries[0][1] == (7,)
    assert admissions == [value["original_local_track_id"] for value in rows]
    return result


def select(value, basis="per_artist", count=1):
    return mix.build_library_mix(value.candidates, mix.LibraryMixRecipe(basis, count, False),
        is_local_readable=lambda candidate: True,
        read_snapshot=lambda candidate: value.snapshots.get(candidate.track.track_id))


def test_local_recording_evidence_requires_assertion_source_or_physical_tag():
    assert inventory.local_identity(row()) == (RECORDING, ARTIST, None)
    missing = row(file_tags=[], recording_mbid=RECORDING, recording_state="asserted")
    assert inventory.local_identity(missing) == (None, None, "missing_recording_identity")
    missing["recording_source"] = "owner-verified"
    assert inventory.local_identity(missing) == (RECORDING, None, None)


@pytest.mark.parametrize("changes", [
    {"recording_state": "conflicting"}, {"recording_state": "ambiguous"},
    {"file_tags": [{"recording": RECORDING, "conflict": True}]},
    {"file_tags": [{"recording": RECORDING}, {"recording": OTHER}]},
    {"file_tags": [{"recording": "malformed"}]},
    {"recording_mbid": OTHER, "recording_state": "asserted", "recording_source": "verified"},
])
def test_conflicting_local_recordings_never_reach_provider_or_snapshot(changes):
    assert inventory.local_identity(row(**changes)) == (None, None, "ambiguous_attribution")


def test_multi_artist_credit_never_guesses_first_primary_artist():
    value = row(file_tags=[{"recording": RECORDING, "artists": [ARTIST, ALBUM_ARTIST]}])
    assert inventory.local_identity(value) == (RECORDING, None, None)


def test_inventory_revision_changes_for_each_attribution_and_file_boundary():
    value = row()
    baseline = inventory.inventory_revision(value)
    changes = {"inventory_evidence": ["replacement-file"], "title": "Changed", "artist": "Changed",
        "original_album_id": 11, "recording_mbid": OTHER, "recording_state": "asserted",
        "recording_source": "different", "artist_mbid": OTHER, "artist_state": "asserted",
        "artist_source": "different", "album_artist_mbid": OTHER, "album_artist_state": "asserted",
        "album_artist_source": "different", "is_compilation": True, "file_tags": []}
    for key, replacement in changes.items():
        assert inventory.inventory_revision(value | {key: replacement}) != baseline, key
    assert inventory.inventory_revision(value | {"count": 999, "source_revision": "new"}) == baseline


def test_snapshot_uses_primary_album_credit_but_compilation_track_credit(monkeypatch):
    ordinary = row()
    compilation = row(2, original_album_id=20, is_compilation=True)
    result = snapshot(monkeypatch, [ordinary, compilation])
    assert result.library_id == 7
    assert result.diagnostics == ()
    assert [candidate.primary_artist_ref for candidate in result.candidates] == [
        "musicbrainz-artist:" + ALBUM_ARTIST, "musicbrainz-artist:" + ARTIST]
    assert [candidate.album_ref for candidate in result.candidates] == [
        "inventory-album:7:10", "inventory-album:7:20"]
    assert result.candidates[0].track.recording_evidence == "lastfm.track.getInfo.mbid"
    assert result.snapshots[1].observation.count == 42


def test_albumless_track_can_enter_artist_mix_without_fabricated_album(monkeypatch):
    result = snapshot(monkeypatch, [row(original_album_id=None)])
    candidate, = result.candidates
    assert candidate.album_ref is None
    assert candidate.primary_artist_ref == "musicbrainz-artist:" + ARTIST
    assert len(select(result).tracks) == 1
    assert select(result, "per_album").diagnostics == ((1, "missing_group_identity"),)


def test_conflicting_album_artist_evidence_remains_unknown_for_whole_album(monkeypatch):
    first = row()
    second = row(2, file_tags=[{"recording": OTHER, "artists": [ARTIST],
                              "album_artists": [OTHER], "conflict": False}],
                 mapped_recording_mbid=OTHER, source_entity_id="https://www.last.fm/music/Artist/_/Other")
    result = snapshot(monkeypatch, [first, second])
    assert [candidate.primary_artist_ref for candidate in result.candidates] == [None, None]
    assert select(result).diagnostics == ((1, "missing_group_identity"), (2, "missing_group_identity"))
    assert len(select(result, "per_album").tracks) == 1


def test_unavailable_rows_are_excluded_before_identity_or_observation_validation(monkeypatch):
    result = snapshot(monkeypatch, [row(availability="unresolved", file_tags=None,
                                       observed_at=None, count=-1)])
    assert result.candidates == ()
    assert result.snapshots == {}
    assert result.diagnostics == ()


def test_denied_row_metadata_is_not_read_or_used_as_coverage(monkeypatch):
    class ForbiddenMetadata(dict):
        def __getitem__(self, key):
            assert key == "original_local_track_id", f"Denied metadata was observed: {key}"
            return super().__getitem__(key)
        def get(self, key, default=None):
            raise AssertionError(f"Denied metadata was observed: {key}")
    result = snapshot(monkeypatch, [row(), ForbiddenMetadata(original_local_track_id=2)], denied={2})
    assert [candidate.track.track_id for candidate in result.candidates] == [1]
    assert result.diagnostics == ()
    assert list(result.snapshots) == [1]


def test_denied_malformed_observation_is_not_validated(monkeypatch):
    denied = row(2, observed_at=None, imported_at=None, count=-1, attribution_state="not-a-state")
    result = snapshot(monkeypatch, [row(), denied], denied={2})
    assert list(result.snapshots) == [1]
    assert result.snapshots[1].observation.count == 42
    assert result.diagnostics == ()


def test_denied_album_credit_cannot_poison_allowed_grouping(monkeypatch):
    denied = row(2, file_tags=[{"recording": OTHER, "artists": [ARTIST],
                             "album_artists": [OTHER], "conflict": False}],
                 mapped_recording_mbid=OTHER, source_entity_id="https://www.last.fm/music/Artist/_/Other")
    result = snapshot(monkeypatch, [row(), denied], denied={2})
    candidate, = result.candidates
    assert candidate.primary_artist_ref == "musicbrainz-artist:" + ALBUM_ARTIST
    assert [value.track.track_id for value in select(result).tracks] == [1]
    assert result.diagnostics == ()


def test_all_denied_snapshot_does_not_read_inventory_or_evidence(monkeypatch):
    result = snapshot(monkeypatch, [row(), row(2)], denied={1, 2})
    assert result.candidates == () and result.snapshots == {} and result.diagnostics == ()
    assert result.refresh_status == "idle"


@pytest.mark.parametrize("library_id,autocommit,predicate", [
    (True, False, lambda _: True), (0, False, lambda _: True),
    (7, True, lambda _: True), (7, False, None), (7, False, True),
])
def test_snapshot_requires_explicit_admission_and_valid_transaction(library_id, autocommit, predicate):
    class Connection:
        def execute(self, *args):
            raise AssertionError("Invalid authority reached the identity enumeration")
    connection = Connection()
    connection.autocommit = autocommit
    with pytest.raises(ValueError):
        inventory.read_snapshot(connection, SimpleNamespace(library_id=library_id), is_readable=predicate)


def test_snapshot_never_defaults_to_all_tracks_without_admission_callback():
    with pytest.raises(TypeError):
        inventory.read_snapshot(SimpleNamespace(autocommit=False), SimpleNamespace(library_id=7))


@pytest.mark.parametrize("decision", [1, "yes", [True], None, False])
def test_snapshot_requires_explicit_true_rather_than_truthy_admission(monkeypatch, decision):
    class Connection:
        autocommit = False
        def execute(self, sql, params):
            return QueryResult([{"id": 1}])
    def forbidden(*args, **kwargs):
        raise AssertionError("Non-True admission loaded inventory evidence")
    monkeypatch.setattr(inventory, "read_inventory", forbidden)
    monkeypatch.setattr(jobs, "read_job", lambda connection, library_id: None)
    result = inventory.read_snapshot(Connection(), SimpleNamespace(library_id=7),
                                     is_readable=lambda track_id: decision)
    assert result.candidates == () and result.snapshots == {} and result.diagnostics == ()


def test_mapping_must_match_current_inventory_and_recording(monkeypatch):
    changed_file = row()
    changed_file["inventory_evidence"] = ["changed-after-mapping"]
    wrong_recording = row(2, mapped_recording_mbid=OTHER)
    missing_mapping = row(3, mapping_revision=None)
    result = snapshot(monkeypatch, [changed_file, wrong_recording, missing_mapping])
    assert result.candidates == ()
    assert result.snapshots == {}
    assert result.diagnostics == tuple((i, "missing_provider_mapping") for i in (1, 2, 3))


@pytest.mark.parametrize("reason", ["ambiguous_attribution", "provider_unavailable"])
def test_latest_identity_check_reason_is_used_only_for_matching_inventory(monkeypatch, reason):
    current = row(mapping_revision=None, last_result=reason)
    stale = row(2, mapping_revision=None, last_result=reason)
    stale["checked_inventory_revision"] = "0" * 64
    result = snapshot(monkeypatch, [current, stale])
    assert result.diagnostics == ((1, reason), (2, "missing_provider_mapping"))


def test_unknown_global_count_is_not_replaced_by_zero(monkeypatch):
    missing = row(count=None, attribution_state="missing")
    no_observation = row(2, source_revision=None)
    result = snapshot(monkeypatch, [missing, no_observation])
    assert result.snapshots[1].observation.count is None
    assert 2 not in result.snapshots
    assert select(result).tracks == ()
    assert select(result).diagnostics == ((1, "missing_global_metric"), (2, "missing_global_metric"))


def test_observation_timezones_are_normalized_and_naive_times_rejected(monkeypatch):
    offset = timezone(timedelta(hours=2))
    result = snapshot(monkeypatch, [row(observed_at=NOW.astimezone(offset), imported_at=NOW.astimezone(offset))])
    assert result.snapshots[1].observation.observed_at == NOW
    assert result.snapshots[1].observation.observed_at.tzinfo is timezone.utc
    with pytest.raises(ValueError, match="timezone-aware"):
        snapshot(monkeypatch, [row(observed_at=NOW.replace(tzinfo=None))])


class QueryResult:
    def __init__(self, rows):
        self.rows = rows
    def fetchall(self):
        return self.rows


def test_inventory_reads_exact_library_and_locks_all_requested_ids(monkeypatch):
    calls, locks = [], []
    class Connection:
        autocommit = False
        def execute(self, sql, params):
            calls.append((sql, params))
            return QueryResult([{"id": 3}, {"id": 8}] if len(calls) == 1 else [])
    connection = Connection()
    monkeypatch.setattr(inventory.sources, "inventory_rows",
        lambda connection, library_id, ids, **kwargs: locks.append((library_id, ids, kwargs)))
    assert inventory.read_inventory(connection, 7, lock=True) == []
    assert locks == [(7, [3, 8], {"lock": True})]
    assert calls[0][1] == (7,)
    assert calls[-1][1] == (7, [3, 8])
    assert "t.id=any(%s::bigint[])" in calls[-1][0]
    assert "for share" in calls[1][0]


@pytest.mark.parametrize("library_id,autocommit", [(True, False), (0, False), (-1, False), (1, True)])
def test_inventory_requires_valid_library_and_caller_transaction(library_id, autocommit):
    class Connection:
        def execute(self, *args):
            raise AssertionError("Invalid boundary reached database")
    connection = Connection()
    connection.autocommit = autocommit
    with pytest.raises(ValueError):
        inventory.read_inventory(connection, library_id)


def test_scanner_records_identity_and_cache_roundtrip_without_media_writes(monkeypatch, tmp_path):
    from music_app.services import cache, metadata
    path = tmp_path / "read-only-fixture.flac"
    payload = b"test media remains unchanged"
    path.write_bytes(payload)
    tags = {"musicbrainz_trackid": [RECORDING], "musicbrainz_artistid": [ARTIST],
            "musicbrainz_albumartistid": [ALBUM_ARTIST], "title": ["Song"], "album": ["Album"]}
    before = deepcopy(tags)
    monkeypatch.setattr(metadata, "read_tags", lambda observed: tags if observed == path else {})
    entry = metadata.read_metadata_for_file(path)
    restored = cache.deserialize_file_entry(cache.serialize_file_entry(entry))
    for key in ("musicbrainz_recording_id", "musicbrainz_artist_ids",
                "musicbrainz_album_artist_ids", "musicbrainz_identity_conflict"):
        assert restored[key] == entry[key]
    assert entry["metadata_schema_version"] == 3
    assert metadata.file_metadata_schema_is_current(entry) is True
    assert metadata.file_metadata_schema_is_current(entry | {"metadata_schema_version": 2}) is False
    for missing in ("musicbrainz_recording_id", "musicbrainz_artist_ids",
                    "musicbrainz_album_artist_ids", "musicbrainz_identity_conflict"):
        partial = {key: value for key, value in entry.items() if key != missing}
        assert metadata.file_metadata_schema_is_current(partial) is False
    assert path.read_bytes() == payload
    assert tags == before
