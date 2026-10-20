"""Source-scoped Sample foundation on the normal migrated Postgres tables.

The existing fixture owns unique accounts/library/media per test. These tests
exercise a backend foundation, not a new Sample endpoint or full Sample flow.
"""
from dataclasses import FrozenInstanceError
from datetime import timedelta

import pytest

from library_mix_postgres_support import mix_db, mix_urls
from music_app.services import sample_playlist_sources as samples
from music_app.services.owned_playlists import CREATE, PlaylistError
from music_app.services.playlist_complete_sources import CompletePlaylistSources
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.popularity_snapshots import select_local_popular_tracks


def manual_source(db, indexes=(4, 1, 3)):
    selected = CompletePlaylistSources(playlists=db.service).from_inventory(db.context(),
        [f"inventory-track:{db.library}:{db.tracks[index]}" for index in indexes])["data"]
    receipt, _, _ = db.save(selected, title="Sample source")
    assert db.state(receipt["playlist_id"])[2] is None
    return receipt


def snapshot(db, receipt, **kwargs):
    return samples.playlist_sample_snapshot(db.service, kwargs.pop("context", db.context()),
        playlist_ref=receipt["playlist_id"], revision=receipt["revision"], **kwargs)


def test_exact_source_order_and_frozen_cached_facts_without_persistence(mix_db):
    db = mix_db
    receipt = manual_source(db)
    before = db.state(receipt["playlist_id"])
    counts = {table: db.total(table) for table in
              ("playlists", "playlist_items", "playlist_operations", "playlist_library_mixes")}
    with snapshot(db, receipt) as captured:
        assert [item.track_id for item in captured.candidates] == [db.tracks[i] for i in (4, 1, 3)]
        assert [item.popularity.observation.count for item in captured.candidates] == [80, 200, 90]
        assert (captured.library_id, captured.account_id, captured.session_id) == (
            db.library, db.owner.account_id, db.owner.session_id)
        assert len(captured.membership_digest) == 64
        assert all(len(digest) == 64 for _track_id, digest in captured.inventory_digests)
        with pytest.raises(FrozenInstanceError):
            captured.revision = "99"
        with pytest.raises(FrozenInstanceError):
            captured.candidates[0].source_position = 999
    assert db.state(receipt["playlist_id"]) == before
    assert {table: db.total(table) for table in counts} == counts


def test_existing_selector_applies_eligibility_then_rank_then_explicit_group_quota(mix_db):
    db = mix_db
    receipt = manual_source(db, (0, 1, 2, 3, 4, 5))
    with snapshot(db, receipt) as captured:
        by_id = {item.track_id: item for item in captured.candidates}
        selected = select_local_popular_tracks(
            (item.popularity_track for item in captured.candidates),
            is_local_readable=lambda item: item.track_id in by_id,
            matches_filter=lambda item: item.track_id != db.tracks[0],
            read_snapshot=lambda item: by_id[item.track_id].popularity,
            max_per_group=1,
            group_identity=lambda item: by_id[item.track_id].album_ref,
            tie_breaker=lambda item: (by_id[item.track_id].source_position,),
            limit=len(by_id))
        assert [item.track_id for item in selected.tracks] == [db.tracks[1], db.tracks[3]]
        assert selected.total == 2
    # The explicit test quota/group function is not a Sample default or policy.


@pytest.mark.parametrize("kind", ["track", "album"])
def test_resource_denial_happens_before_popularity_normalization(mix_db, monkeypatch, kind):
    db = mix_db
    receipt = manual_source(db)
    observed = []
    normalize = samples.inventory.normalize_cached_inventory_row

    def recording(row):
        observed.append(row["original_local_track_id"])
        return normalize(row)

    def constraints(context):
        denied = context.resource and context.resource.resource_kind == kind
        return PolicyEvaluationConstraints(deployment_allowed=not denied)

    monkeypatch.setattr(samples.inventory, "normalize_cached_inventory_row", recording)
    with snapshot(db, receipt, constraints=constraints) as captured:
        assert captured.candidates == captured.diagnostics == ()
    assert observed == []


def test_no_admitted_tracks_never_falls_back_to_library_inventory(mix_db, monkeypatch):
    db = mix_db
    receipt = manual_source(db)

    def unexpected(*args, **kwargs):
        pytest.fail("Empty source admission must not read whole-library inventory")

    monkeypatch.setattr(samples.inventory, "read_inventory", unexpected)
    constraints = lambda context: PolicyEvaluationConstraints(deployment_allowed=not (
        context.resource and context.resource.resource_kind == "track"))
    with snapshot(db, receipt, constraints=constraints) as captured:
        assert captured.candidates == ()


@pytest.mark.parametrize("change", ["revision", "private", "create", "session"])
def test_source_and_current_authority_are_required(mix_db, change):
    db = mix_db
    receipt = manual_source(db)
    context = db.context()
    if change == "revision":
        receipt = {**receipt, "revision": "999"}
    elif change == "private":
        with db.connect() as con:
            other = db.member(con)
        context = db.context(other)
    elif change == "create":
        with db.connect() as con:
            con.execute("delete from app.capabilities where account_id=%s and capability_key=%s",
                        (db.owner.account_id, CREATE))
    else:
        db.clock_time += timedelta(days=2)
    with pytest.raises(PlaylistError):
        with snapshot(db, receipt, context=context):
            pytest.fail("Unauthorized source yielded")


def test_final_session_fence_uses_fresh_clock(mix_db):
    db = mix_db
    receipt = manual_source(db)
    with pytest.raises(PlaylistError, match="forbidden"):
        with snapshot(db, receipt):
            db.clock_time += timedelta(days=2)


def test_session_expiring_during_inventory_wait_never_yields(mix_db, monkeypatch):
    db = mix_db
    receipt = manual_source(db)
    read = samples.inventory.read_inventory

    def delayed(*args, **kwargs):
        result = read(*args, **kwargs)
        db.clock_time += timedelta(days=2)
        return result

    monkeypatch.setattr(samples.inventory, "read_inventory", delayed)
    with pytest.raises(PlaylistError, match="forbidden"):
        with snapshot(db, receipt):
            pytest.fail("Expired session yielded source facts")


def test_empty_playlist_is_not_whole_library_sample(mix_db):
    db = mix_db
    receipt = manual_source(db)
    _playlist, items, _recipe = db.state(receipt["playlist_id"])
    receipt = db.mutate(receipt, "remove", item_refs=[str(item["ref"]) for item in items])
    with pytest.raises(PlaylistError, match="playlist_empty"):
        with snapshot(db, receipt):
            pytest.fail("Empty source yielded whole-library tracks")


def test_resource_revocation_during_evaluation_fails_final_fence(mix_db):
    db = mix_db
    receipt = manual_source(db)
    deny = False

    def constraints(context):
        return PolicyEvaluationConstraints(deployment_allowed=not (
            deny and context.resource and context.resource.resource_kind == "track"))

    with pytest.raises(PlaylistError, match="source_unavailable"):
        with snapshot(db, receipt, constraints=constraints):
            deny = True


def test_complete_source_bound_is_not_silent_truncation(mix_db, monkeypatch):
    db = mix_db
    receipt = manual_source(db)
    monkeypatch.setattr(samples, "MAX_PLAYLIST_ITEMS_PER_COMMAND", 2)
    with pytest.raises(PlaylistError, match="source_too_large"):
        with snapshot(db, receipt):
            pytest.fail("Oversized source yielded a prefix")


def test_missing_cached_mapping_stays_diagnostic_not_synthetic_popularity(mix_db):
    db = mix_db
    receipt = manual_source(db)
    with db.connect() as con:
        con.execute("update library.track_popularity_mapping_slots set current_revision=null where track_id=%s",
                    (db.tracks[4],))
    with snapshot(db, receipt) as captured:
        assert [item.track_id for item in captured.candidates] == [db.tracks[i] for i in (4, 1, 3)]
        unknown = captured.candidates[0]
        assert unknown.canonical_recording_id is unknown.recording_evidence is None
        assert unknown.popularity_track is unknown.popularity is None
        assert captured.diagnostics == ((db.tracks[4], "missing_provider_mapping"),)
