"""App-owned pure cached popularity contract; no external DTO or persistence proof."""
from dataclasses import FrozenInstanceError, replace
from datetime import datetime, timedelta, timezone

import pytest

from music_app.services import popularity_snapshots as popularity


NOW = datetime(2026, 10, 12, 7, tzinfo=timezone.utc)


def observation(**changes):
    values = dict(provider="lastfm", metric="overall_scrobbles", source_entity_id="lfm:track:one",
                  source_revision="opaque:z", observed_at=NOW, imported_at=NOW + timedelta(hours=1),
                  count=30, attribution_state="resolved")
    return popularity.PopularityObservation(**(values | changes))


def track(track_id=1, **changes):
    values = dict(track_id=track_id, mapping_revision="mapping:one", provider="lastfm", source_entity_id=f"lfm:track:{track_id}",
                  canonical_recording_id=f"recording:{track_id}",
                  recording_evidence="verified:recording", canonical_artist_id="artist:one", artist_evidence="verified:artist")
    return popularity.LocalTrackEvidence(**(values | changes))


def cached(item, **changes):
    return popularity.CachedPopularity(local_track_id=item.track_id, mapping_revision=item.mapping_revision,
                                      observation=observation(source_entity_id=f"lfm:track:{item.track_id}", **changes))


def select(items, snapshots, **options):
    return popularity.select_local_popular_tracks(items, is_local_readable=lambda item: True,
        matches_filter=lambda item: True, read_snapshot=lambda item: snapshots.get(item.track_id), **options)


def ids(result):
    return tuple(item.track_id for item in result.tracks)


@pytest.mark.parametrize("count", [0, 1, 2**53 - 1])
def test_exact_global_safe_integer_is_valid_including_zero(count):
    value = observation(count=count)
    assert popularity.validate_observation(value) == value


@pytest.mark.parametrize("changes", [
    {"provider": "listenbrainz"}, {"metric": "personal_play_count"}, {"metric": "listeners"},
    {"metric": "weekly_scrobbles"}, {"metric": "scrobbles"}, {"source_entity_id": ""},
    {"source_revision": " "}, {"source_entity_id": None}, {"source_revision": 3},
    {"count": True}, {"count": 1.0}, {"count": "30"}, {"count": -1}, {"count": 2**53},
    {"count": float("nan")}, {"count": float("inf")}, {"count": None},
    {"observed_at": NOW.replace(tzinfo=None)}, {"imported_at": NOW.replace(tzinfo=None)},
    {"observed_at": "2026-10-12T07:00:00Z"}, {"observed_at": NOW.astimezone(timezone(timedelta(hours=1)))},
    {"imported_at": NOW - timedelta(seconds=1)}, {"attribution_state": "guessed"},
    {"attribution_state": "missing", "count": 0},
])
def test_invalid_normalized_observation_is_rejected(changes):
    with pytest.raises(ValueError):
        popularity.validate_observation(observation(**changes))


def test_raw_dict_is_not_an_external_provider_dto():
    with pytest.raises(ValueError):
        popularity.validate_observation({"playcount": 40, "userplaycount": 99})


@pytest.mark.parametrize("state,count", [("missing", None), ("ambiguous", None), ("ambiguous", 40)])
def test_missing_and_ambiguous_are_explicit_not_zero(state, count):
    value = observation(attribution_state=state, count=count)
    assert popularity.validate_observation(value) == value


def test_frozen_typed_records_cannot_be_mutated():
    value = observation()
    with pytest.raises(FrozenInstanceError):
        value.count = 100


def test_new_observation_is_accepted_and_lower_fresh_count_replaces_old():
    old = observation()
    assert popularity.reconcile_observation(None, old) == ("accepted", old)
    fresh = observation(source_revision="opaque:a", observed_at=NOW + timedelta(minutes=1), count=2)
    assert popularity.reconcile_observation(old, fresh) == ("accepted", fresh)


def test_late_import_cannot_make_stale_provider_observation_current():
    old = observation()
    stale = observation(source_revision="opaque:zz", observed_at=NOW - timedelta(minutes=1),
                        imported_at=NOW + timedelta(days=7), count=900)
    assert popularity.reconcile_observation(old, stale) == ("stale", old)


def test_same_source_revision_and_content_is_idempotent_despite_later_import():
    old = observation()
    replay = replace(old, imported_at=NOW + timedelta(days=2))
    assert popularity.reconcile_observation(old, replay) == ("idempotent", old)


@pytest.mark.parametrize("changes", [
    {"source_revision": "opaque:new"}, {"count": 99},
    {"observed_at": NOW + timedelta(minutes=1)}, {"attribution_state": "ambiguous"},
])
def test_equal_timestamp_different_revision_or_reused_revision_changed_payload_conflicts(changes):
    old = observation()
    assert popularity.reconcile_observation(old, observation(**changes)) == ("conflict", old)


def test_different_source_identity_cannot_replace_existing_slot():
    old = observation()
    incoming = observation(source_entity_id="lfm:other", source_revision="new", observed_at=NOW + timedelta(minutes=1))
    assert popularity.reconcile_observation(old, incoming) == ("conflict", old)


def test_invalid_incoming_is_never_silently_accepted_or_retained():
    with pytest.raises(ValueError):
        popularity.reconcile_observation(observation(), observation(count=True))


def test_admission_precedes_filter_snapshot_reads_and_diagnostics():
    denied, admitted = track(1), track(2)
    calls = []
    def allowed(item):
        calls.append(("admit", item.track_id))
        return item.track_id == 2
    def predicate(item):
        assert item.track_id == 2
        calls.append(("filter", item.track_id))
        return True
    def read(item):
        assert item.track_id == 2
        calls.append(("read", item.track_id))
        return cached(item, count=0)
    result = popularity.select_local_popular_tracks([denied, admitted], is_local_readable=allowed,
        matches_filter=predicate, read_snapshot=read)
    assert ids(result) == (2,)
    assert calls == [("admit", 1), ("admit", 2), ("filter", 2), ("read", 2)]
    assert result.diagnostics == ()


def test_filter_precedes_snapshot_reads_and_canonical_deduplication():
    rejected = track(1)
    accepted = track(2, canonical_recording_id=rejected.canonical_recording_id)
    def read(item):
        assert item.track_id == 2
        return cached(item)
    result = popularity.select_local_popular_tracks([rejected, accepted], is_local_readable=lambda item: True,
        matches_filter=lambda item: item.track_id == 2, read_snapshot=read)
    assert ids(result) == (2,)
    assert result.diagnostics == ()


def test_global_ranking_then_canonical_artist_cap_then_pagination():
    items = [track(1), track(2), track(3, canonical_artist_id="artist:two"), track(4, canonical_artist_id="artist:three")]
    snapshots = {item.track_id: cached(item, count=count) for item, count in zip(items, [90, 100, 80, 0])}
    result = select(items, snapshots, max_per_artist=1, offset=1, limit=2)
    assert ids(result) == (3, 4)
    assert result.total == 3


def test_canonical_recording_duplicates_do_not_consume_cap():
    items = [track(1), track(2, canonical_recording_id="recording:1"), track(3)]
    snapshots = {item.track_id: cached(item, count=20 if item.track_id < 3 else 10) for item in items}
    assert ids(select(items, snapshots, max_per_artist=2)) == (1, 3)


def test_missing_recording_uses_stable_provider_identity_then_local_identity():
    a, b = [track(i, canonical_recording_id=None, recording_evidence=None) for i in [1, 2]]
    b = replace(b, source_entity_id=a.source_entity_id)
    shared = {item.track_id: cached(item) for item in [a, b]}
    shared[2] = replace(shared[2], observation=shared[1].observation)
    assert ids(select([b, a], shared, max_per_artist=2)) == (1,)
    b = replace(b, source_entity_id="lfm:track:2")
    distinct = {item.track_id: cached(item) for item in [a, b]}
    assert ids(select([a, b], distinct, max_per_artist=2)) == (1, 2)


def test_missing_artist_is_eligible_without_cap_and_ineligible_only_with_cap():
    item = track(canonical_artist_id=None, artist_evidence=None)
    snapshots = {1: cached(item, count=0)}
    assert ids(select([item], snapshots)) == (1,)
    assert ids(select([item], snapshots, max_per_artist=1)) == ()
    assert select([item], snapshots, max_per_artist=1).diagnostics == ((1, "missing_canonical_artist"),)


@pytest.mark.parametrize("state,count", [("missing", None), ("ambiguous", None), ("ambiguous", 900)])
def test_unknown_or_ambiguous_global_metric_cannot_rank(state, count):
    item = track()
    result = select([item], {1: cached(item, attribution_state=state, count=count)})
    assert ids(result) == ()
    assert result.diagnostics == ((1, "missing_global_metric" if state == "missing" else "ambiguous_attribution"),)


def test_missing_cached_snapshot_is_unknown_not_zero():
    result = select([track()], {})
    assert ids(result) == ()
    assert result.diagnostics == ((1, "missing_global_metric"),)


@pytest.mark.parametrize("field,value", [("mapping_revision", "old-mapping"), ("local_track_id", 999)])
def test_cached_mapping_must_match_current_local_identity_and_revision(field, value):
    item = track()
    result = select([item], {1: replace(cached(item), **{field: value})})
    assert ids(result) == ()
    assert result.diagnostics == ((1, "mapping_mismatch"),)


@pytest.mark.parametrize("changes", [{"recording_evidence": None}, {"artist_evidence": ""},
    {"canonical_recording_id": None}, {"canonical_artist_id": None}, {"mapping_revision": ""},
    {"track_id": True}, {"track_id": 0}])
def test_invalid_admitted_local_evidence_fails_closed(changes):
    item = track(**changes)
    with pytest.raises(ValueError):
        select([item], {item.track_id: cached(item)})


def test_equal_counts_are_deterministic_and_inputs_unchanged():
    items = [track(3), track(2), track(1)]
    snapshots = {item.track_id: cached(item) for item in items}
    before = list(items), dict(snapshots)
    assert ids(select(items, snapshots)) == (1, 2, 3)
    assert (items, snapshots) == before


@pytest.mark.parametrize("options", [{"max_per_artist": 0}, {"max_per_artist": True}, {"max_per_artist": 1.5},
    {"offset": -1}, {"offset": True}, {"limit": 0}, {"limit": True}, {"limit": 1.5}])
def test_invalid_selection_options_are_rejected(options):
    with pytest.raises(ValueError):
        select([], {}, **options)


@pytest.mark.parametrize("field,value", [("source_entity_id", "lfm:other"), ("provider", "other-provider")])
def test_cached_source_identity_must_match_current_local_mapping(field, value):
    item = track(**{field: value})
    result = select([item], {1: cached(item)})
    assert ids(result) == ()
    assert result.diagnostics == ((1, "mapping_mismatch"),)


def test_unreadable_bad_evidence_is_not_validated_or_reported():
    item = track(mapping_revision="", recording_evidence=None)
    def forbidden(item):
        raise AssertionError("Unreadable candidate reached private metadata callback")
    result = popularity.select_local_popular_tracks([item], is_local_readable=lambda item: False,
        matches_filter=forbidden, read_snapshot=forbidden)
    assert ids(result) == () and result.total == 0 and result.diagnostics == ()


def test_zero_snapshot_ranks_below_positive_and_above_missing():
    items = [track(1), track(2), track(3)]
    result = select(items, {1: cached(items[0], count=0), 2: cached(items[1], count=1)})
    assert ids(result) == (2, 1)
    assert result.total == 2


def test_same_name_artists_are_never_grouped_without_canonical_identity():
    items = [track(1, canonical_artist_id="mbid:artist-A"), track(2, canonical_artist_id="mbid:artist-B")]
    assert ids(select(items, {item.track_id: cached(item) for item in items}, max_per_artist=1)) == (1, 2)


def test_mixed_canonical_coverage_dedupes_shared_provider_recording():
    a = track(1)
    b = track(2, source_entity_id=a.source_entity_id, canonical_recording_id=None, recording_evidence=None)
    snapshots = {1: cached(a), 2: replace(cached(b), observation=cached(a).observation)}
    assert ids(select([b, a], snapshots, max_per_artist=2)) == (1,)


def test_multiple_genre_and_artist_predicates_run_before_cap():
    items = [track(1), track(2), track(3, canonical_artist_id="artist:two")]
    # The caller owns genre and artist semantics; this pure seam composes that predicate.
    eligible_ids = {2, 3}
    snapshots = {item.track_id: cached(item, count=100 - item.track_id) for item in items}
    result = popularity.select_local_popular_tracks(items, is_local_readable=lambda item: True,
        matches_filter=lambda item: item.track_id in eligible_ids,
        read_snapshot=lambda item: snapshots[item.track_id], max_per_artist=1)
    assert ids(result) == (2, 3)


def test_count_is_not_added_across_local_copies():
    items = [track(1), track(2, canonical_recording_id="recording:1"), track(3, canonical_artist_id="artist:two")]
    snapshots = {item.track_id: cached(item, count=20 if item.track_id < 3 else 30) for item in items}
    assert ids(select(items, snapshots)) == (3, 1)


@pytest.mark.parametrize("field,value", [("canonical_recording_id", "recording:other"),
                                        ("canonical_artist_id", "artist:other")])
def test_conflicting_canonical_evidence_on_same_provider_recording_is_ambiguous(field, value):
    a = track(1)
    b = replace(track(2, source_entity_id=a.source_entity_id,
                      canonical_recording_id=a.canonical_recording_id), **{field: value})
    snapshots = {1: cached(a), 2: replace(cached(b), observation=cached(a).observation)}
    result = select([a, b], snapshots, max_per_artist=1)
    assert ids(result) == () and result.total == 0
    assert result.diagnostics == ((1, "ambiguous_attribution"), (2, "ambiguous_attribution"))


def test_consistent_complete_canonical_evidence_is_preferred_to_missing_duplicate_evidence():
    a = track(1, canonical_recording_id=None, recording_evidence=None,
              canonical_artist_id=None, artist_evidence=None)
    b = track(2, source_entity_id=a.source_entity_id)
    snapshots = {1: cached(a), 2: replace(cached(b), observation=cached(a).observation)}
    result = select([a, b], snapshots, max_per_artist=1)
    assert ids(result) == (2,)
    assert result.diagnostics == ()
    assert a.canonical_recording_id is None and a.canonical_artist_id is None
