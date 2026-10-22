"""Independent shared-inventory extraction contract; no copied normalizer/ranker."""
from copy import deepcopy
from datetime import timedelta, timezone
from types import SimpleNamespace

import pytest

from music_app.services import library_mix_inventory_postgres as inventory
from music_app.services import sample_playlist_sources as samples
from test_library_mix_mapping_inventory import (
    ALBUM_ARTIST, ARTIST, NOW, OTHER, RECORDING, QueryResult, row,
    select as mix_select, snapshot as mix_snapshot,
)

OBSERVATION_KEYS = frozenset(("source_revision", "observed_at", "imported_at", "count", "attribution_state"))


class ForbiddenObservation:
    def __eq__(self, other):
        raise AssertionError("Ignored observation compared")
    def __hash__(self):
        raise AssertionError("Ignored observation hashed")
    def __repr__(self):
        raise AssertionError("Ignored observation represented")
    def __bool__(self):
        raise AssertionError("Ignored observation inspected")


class IdentityOnlyRow(dict):
    """Access, membership and broad-copy traps, not a replacement normalizer."""
    def __getitem__(self, key):
        assert key not in OBSERVATION_KEYS, key
        return super().__getitem__(key)
    def get(self, key, default=None):
        assert key not in OBSERVATION_KEYS, key
        return super().get(key, default)
    def __contains__(self, key):
        assert key not in OBSERVATION_KEYS, key
        return super().__contains__(key)
    def items(self):
        raise AssertionError("Identity extraction must not copy observation values")
    def values(self):
        raise AssertionError("Identity extraction must not enumerate observation values")
    def __iter__(self):
        raise AssertionError("Identity extraction must use only identity fields")


@pytest.mark.parametrize("poisoned", [False, True])
def test_identity_extraction_never_observes_popularity_fields(poisoned):
    value = row()
    for key in OBSERVATION_KEYS:
        if poisoned:
            value[key] = ForbiddenObservation()
        else:
            del value[key]
    track, reason = inventory.normalize_cached_track_identity(IdentityOnlyRow(value))
    assert reason is None
    assert track.track_id == 1
    assert track.canonical_recording_id == RECORDING
    assert track.recording_evidence == "lastfm.track.getInfo.mbid"
    assert track.canonical_artist_id == ARTIST
    assert track.mapping_revision == value["mapping_revision"]


@pytest.mark.parametrize("changes,late,reason", [
    ({"availability": "unresolved", "file_tags": None}, {}, None),
    ({"recording_state": "ambiguous", "mapping_revision": None, "last_result": "provider_unavailable"}, {}, "ambiguous_attribution"),
    ({"recording_state": "conflicting"}, {}, "ambiguous_attribution"),
    ({"file_tags": [], "mapping_revision": None, "last_result": "provider_unavailable"}, {}, "missing_recording_identity"),
    ({"mapping_revision": None}, {}, "missing_provider_mapping"),
    ({"mapping_revision": None, "last_result": "ambiguous_attribution"}, {}, "ambiguous_attribution"),
    ({"mapping_revision": None, "last_result": "provider_unavailable"}, {}, "provider_unavailable"),
    ({"mapping_revision": None, "last_result": "provider_unavailable"}, {"checked_inventory_revision": "stale"}, "missing_provider_mapping"),
    ({}, {"mapped_inventory_revision": "stale"}, "missing_provider_mapping"),
    ({"mapped_recording_mbid": OTHER}, {}, "missing_provider_mapping"),
    ({"last_result": "provider_unavailable"}, {}, "valid"),
])
def test_identity_reason_precedence_is_the_existing_mix_contract(changes, late, reason):
    value = row(**changes)
    value.update(late)
    for key in OBSERVATION_KEYS:
        value[key] = ForbiddenObservation()
    track, actual = inventory.normalize_cached_track_identity(IdentityOnlyRow(value))
    if reason == "valid":
        assert track.canonical_recording_id == RECORDING
        assert actual is None
    else:
        assert track is None
        assert actual == reason


@pytest.mark.parametrize("count,state", [(0, "resolved"), (42, "resolved"), (None, "missing"), (42, "ambiguous")])
def test_full_normalizer_reuses_exact_identity_object_and_existing_observation(monkeypatch, count, state):
    seen = []
    real = inventory.normalize_cached_track_identity
    def observe(value):
        result = real(value)
        seen.append((value, result))
        return result
    monkeypatch.setattr(inventory, "normalize_cached_track_identity", observe)
    value = row(count=count, attribution_state=state,
                observed_at=NOW.astimezone(timezone(timedelta(hours=3))))
    track, cached, reason = inventory.normalize_cached_inventory_row(value)
    assert len(seen) == 1 and seen[0][0] is value
    assert track is seen[0][1][0]
    assert reason is None
    assert cached.local_track_id == track.track_id
    assert cached.mapping_revision == track.mapping_revision
    assert cached.observation.count == count
    assert cached.observation.attribution_state == state
    assert cached.observation.observed_at == NOW
    assert cached.observation.observed_at.utcoffset() == timedelta(0)


@pytest.mark.parametrize("changes", [
    {"count": -1}, {"count": True}, {"attribution_state": "made-up"},
    {"observed_at": NOW.replace(tzinfo=None)}, {"imported_at": NOW.replace(tzinfo=None)},
])
def test_full_normalizer_keeps_malformed_observation_validation(changes):
    value = row(**changes)
    assert inventory.normalize_cached_track_identity(value)[0] is not None
    with pytest.raises(ValueError):
        inventory.normalize_cached_inventory_row(value)


def test_missing_observation_retains_mapping_without_fabricated_cache():
    value = row(source_revision=None, observed_at=None, imported_at=None, count=None, attribution_state=None)
    track, cached, reason = inventory.normalize_cached_inventory_row(value)
    assert track.canonical_recording_id == RECORDING
    assert cached is reason is None


class RecordingConnection:
    autocommit = False
    def __init__(self):
        self.calls = []
    def execute(self, sql, params):
        self.calls.append((sql, params))
        return QueryResult([])


def test_observation_free_sql_keeps_local_mapping_and_bound_identity_columns():
    con = RecordingConnection()
    assert inventory.read_inventory(con, 7, track_ids=[9, 3], include_popularity=False) == []
    assert len(con.calls) == 1
    sql, params = con.calls[0]
    text = " ".join(sql.lower().split())
    assert params == (7, [9, 3])
    assert "t.library_id=%s" in text and "t.id=any(%s::bigint[])" in text
    for name in ("library.local_tracks", "library.local_artists", "library.local_albums",
                 "library.track_popularity_mapping_slots", "library.track_popularity_mapping_versions"):
        assert name in text
    for name in ("catalog.popularity_source_slots", "catalog.popularity_source_observations"):
        assert name not in text
    for name in OBSERVATION_KEYS:
        assert "o." + name not in text
    assert "mapped_inventory_revision" in text and "mapping_revision" in text


def test_default_read_and_explicit_true_have_exact_same_full_query():
    default, explicit = RecordingConnection(), RecordingConnection()
    inventory.read_inventory(default, 7, track_ids=[3])
    inventory.read_inventory(explicit, 7, track_ids=[3], include_popularity=True)
    assert default.calls == explicit.calls
    sql, _ = default.calls[0]
    assert "catalog.popularity_source_slots" in sql
    assert "catalog.popularity_source_observations" in sql
    assert all("o." + name in sql for name in OBSERVATION_KEYS)


@pytest.mark.parametrize("value", [None, 0, 1, "true", "false", [], {}, object()])
def test_include_popularity_requires_bool_before_sql_or_lock_work(monkeypatch, value):
    def forbidden(*args, **kwargs):
        pytest.fail("Invalid include_popularity reached lock owner")
    monkeypatch.setattr(inventory.sources, "inventory_rows", forbidden)
    con = RecordingConnection()
    with pytest.raises(ValueError):
        inventory.read_inventory(con, 7, track_ids=[3], lock=True, include_popularity=value)
    assert con.calls == []


@pytest.mark.parametrize("method", [None, "", "Random", "MOST_LISTENED", "popular", 0, True, [], {}])
def test_selection_method_rejected_before_authorization(method):
    calls = []
    def forbidden(*args, **kwargs):
        calls.append((args, kwargs))
        pytest.fail("Invalid method entered authorization")
    owner = SimpleNamespace(_authorized=forbidden)
    with pytest.raises(ValueError):
        with samples.playlist_sample_snapshot(owner, object(),
                playlist_ref="11111111-1111-4111-8111-111111111111", revision="1", selection_method=method):
            pytest.fail("Invalid method yielded")
    assert calls == []


@pytest.mark.parametrize("second_credit", [ALBUM_ARTIST, OTHER, None])
def test_ordinary_group_consensus_includes_missing_and_disagreeing_local_credits(second_credit):
    first = row()
    second = row(2, file_tags=[{"recording": RECORDING, "artists": [ARTIST],
                               "album_artists": [] if second_credit is None else [second_credit]}])
    unavailable = row(3, availability="unresolved", file_tags=None)
    values = [first, second, unavailable]
    before = deepcopy(values)
    expected = "musicbrainz-artist:" + ALBUM_ARTIST if second_credit == ALBUM_ARTIST else None
    assert inventory.primary_artist_refs(values, track_artist_ids={1: ARTIST, 2: ARTIST, 3: OTHER}) == {1: expected, 2: expected}
    assert values == before


@pytest.mark.parametrize("album_id,compilation", [(10, True), (None, False), (None, True)])
@pytest.mark.parametrize("supplied", [ARTIST, None])
def test_compilation_and_albumless_group_use_only_supplied_track_artist(album_id, compilation, supplied):
    value = row(original_album_id=album_id, is_compilation=compilation, mapped_artist_mbid=OTHER)
    actual = inventory.primary_artist_refs([value], track_artist_ids={} if supplied is None else {1: supplied})
    assert actual == {1: None if supplied is None else "musicbrainz-artist:" + supplied}


@pytest.mark.parametrize("not_true", [False, 1, "true", None])
def test_compilation_marker_requires_actual_true(not_true):
    assert inventory.primary_artist_refs([row(is_compilation=not_true)], track_artist_ids={1: ARTIST}) == {
        1: "musicbrainz-artist:" + ALBUM_ARTIST}


def test_real_mix_reader_calls_shared_group_owner_and_preserves_track_cache_objects(monkeypatch):
    values = [row(), row(2, original_album_id=20, is_compilation=True,
        mapped_recording_mbid=OTHER, source_entity_id="fixture:second", count=10,
        file_tags=[{"recording": OTHER, "artists": [ARTIST], "album_artists": [ALBUM_ARTIST]}])]
    seen_groups, normalized = [], {}
    real_groups, real_normalize = inventory.primary_artist_refs, inventory.normalize_cached_inventory_row
    def grouping(rows, *, track_artist_ids):
        rows = tuple(rows)
        seen_groups.append((rows, dict(track_artist_ids)))
        return real_groups(rows, track_artist_ids=track_artist_ids)
    def normalizing(value):
        result = real_normalize(value)
        normalized[value["original_local_track_id"]] = result
        return result
    monkeypatch.setattr(inventory, "primary_artist_refs", grouping)
    monkeypatch.setattr(inventory, "normalize_cached_inventory_row", normalizing)
    captured = mix_snapshot(monkeypatch, values)
    assert len(seen_groups) == 1
    assert len(seen_groups[0][0]) == 2
    assert all(actual is original for actual, original in zip(seen_groups[0][0], values))
    assert seen_groups[0][1] == {1: ARTIST, 2: ARTIST}
    assert captured.diagnostics == ()
    for candidate in captured.candidates:
        track, cached, _ = normalized[candidate.track.track_id]
        assert candidate.track is track
        assert captured.snapshots[track.track_id] is cached
    chosen = mix_select(captured)
    assert [candidate.track.track_id for candidate in chosen.tracks] == [1, 2]
    assert chosen.diagnostics == ()
    assert [candidate.primary_artist_ref for candidate in chosen.tracks] == [
        "musicbrainz-artist:" + ALBUM_ARTIST, "musicbrainz-artist:" + ARTIST]


def test_mix_missing_mapping_row_still_participates_in_existing_album_consensus(monkeypatch):
    unavailable_mapping = row(2, mapping_revision=None,
        file_tags=[{"recording": OTHER, "artists": [ARTIST], "album_artists": [OTHER]}])
    captured = mix_snapshot(monkeypatch, [row(), unavailable_mapping])
    assert [candidate.track.track_id for candidate in captured.candidates] == [1]
    assert captured.candidates[0].primary_artist_ref is None
    assert captured.diagnostics == ((2, "missing_provider_mapping"),)
    assert mix_select(captured).diagnostics == ((1, "missing_group_identity"),)
