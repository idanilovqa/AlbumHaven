"""Incremental 5000/5001 expansion regressions, authored/unrun.

The 5000 sentinel stops at real candidate preparation, before facts/evaluation and
both independent 2 MiB descriptor limits. It is NOT a receipt-persistence claim.
"""
from uuid import uuid4

import pytest
from library_mix_postgres_support import mix_db, mix_urls
from sample_playlist_origin_support import sample_top, capture_origin, origin
from test_sample_playlist_receipts_live import snapshots, complete, destinations, retained, options, no_provider
from music_app.services.owned_playlists import PlaylistError
from sample_playlist_origin_integration_support import (
    SQLTrace, add_album, grow_album, album_set, receipts_for, no_survivors,
    is_album_probe, probe_album, probe_limit, is_track_update,
)


class BudgetStageReached(Exception):
    """Intentional test stop; never a fake successful snapshot or receipt."""


def stop_at_facts(monkeypatch, expected):
    seen = []
    def stop(rows, positions, readable, library_id, **kwargs):
        assert set(positions) == set(expected)
        assert {row["original_local_track_id"] for row in rows} == set(expected)
        seen.append(dict(positions))
        raise BudgetStageReached()
    monkeypatch.setattr(snapshots, "_candidate_facts", stop)
    return seen


def reject_header(monkeypatch):
    calls = []
    def forbidden(*args, **kwargs):
        calls.append(True)
        pytest.fail("Expansion overflow/budget-stage sentinel reached a receipt header")
    monkeypatch.setattr(complete, "_header", forbidden)
    return calls


@pytest.mark.parametrize("kind", ["album_set", "album_top"])
@pytest.mark.parametrize("quota", [1, 9001])
def test_multi_album_exact5000_reaches_budget_stage_not_receipt(sample_top, monkeypatch, kind, quota):
    db = sample_top.db
    first, second = db.albums[1], db.albums[0]
    first_ids = grow_album(db, first, 2500)
    second_ids = grow_album(db, second, 2500)
    expected = first_ids + second_ids
    value = origin(db, kind, sample_top.top)
    key = str(uuid4())
    before = destinations(db), receipts_for(db, db.owner)
    seen = stop_at_facts(monkeypatch, expected)
    headers = reject_header(monkeypatch)
    with SQLTrace().install(db.service) as trace:
        with pytest.raises(BudgetStageReached):
            capture_origin(db, value, key=key, opts=options(songs_per_group=quota))
    assert len(seen) == 1 and headers == []
    assert seen[0] == {identity: index for index, identity in enumerate(expected)}
    probes = [call for call in trace.calls if is_album_probe(call)]
    assert [probe_album(call) for call in probes] == [first, second]
    assert [probe_limit(call) for call in probes] == [5001, 2501]
    assert all("for update" not in call.sql and "for share" not in call.sql for call in probes)
    track_locks = [call for call in trace.calls if is_track_update(call)]
    assert track_locks and "nowait" in track_locks[0].sql
    assert [row["id"] for row in track_locks[0].rows] == sorted(expected)
    no_survivors(db, key, before)


@pytest.mark.parametrize("counts", [(2500, 2501), (5000, 1), (4999, 2)])
def test_multi_album5001_stops_at_remaining_plus_one_and_never_reads_later_album(mix_db, monkeypatch, counts):
    db = mix_db
    first, second = db.albums[1], db.albums[0]
    # The existing three rows are kept when the desired overflow portion is 1/2.
    # A remaining+1 probe establishes the same 5001st witness without scanning all 3.
    grow_album(db, first, counts[0])
    grow_album(db, second, max(3, counts[1]))
    later = add_album(db)
    grow_album(db, later, 7)
    key = str(uuid4())
    before = destinations(db), receipts_for(db, db.owner)
    headers = reject_header(monkeypatch)
    facts = stop_at_facts(monkeypatch, ())
    with SQLTrace().install(db.service) as trace:
        with pytest.raises(PlaylistError, match="source_too_large") as error:
            capture_origin(db, album_set(db, [first, second, later]), key=key)
    assert error.value.status_code == 413 and facts == [] and headers == []
    probes = [call for call in trace.calls if is_album_probe(call)]
    assert [probe_album(call) for call in probes] == [first, second]
    assert [probe_limit(call) for call in probes] == [5001, 5001 - counts[0]]
    assert sum(len(call.rows) for call in probes) == 5001
    assert all("for update" not in call.sql and "for share" not in call.sql for call in probes)
    # Neither eager ID discovery nor a later album query may hide outside LIMIT probes.
    track_reads = [call for call in trace.calls if "from library.local_tracks" in call.sql]
    assert track_reads == probes
    assert not any(is_track_update(call) for call in trace.calls)
    assert len(trace.connections) == 1
    no_survivors(db, key, before)


def test_saved_top5001_stops_before_second_album_can_expand_fully(sample_top, monkeypatch):
    db = sample_top.db
    grow_album(db, db.albums[1], 2500)
    grow_album(db, db.albums[0], 2501)
    key = str(uuid4())
    before = destinations(db), receipts_for(db, db.owner)
    headers = reject_header(monkeypatch)
    facts = stop_at_facts(monkeypatch, ())
    with SQLTrace().install(db.service) as trace:
        with pytest.raises(PlaylistError, match="source_too_large") as error:
            capture_origin(db, origin(db, "album_top", sample_top.top), key=key)
    assert error.value.status_code == 413 and headers == [] and facts == []
    probes = [call for call in trace.calls if is_album_probe(call)]
    assert [probe_album(call) for call in probes] == list(reversed(db.albums))
    assert [probe_limit(call) for call in probes] == [5001, 2501]
    assert sum(len(call.rows) for call in probes) == 5001
    assert not any(is_track_update(call) for call in trace.calls)
    no_survivors(db, key, before)


@pytest.mark.parametrize("kind", ["album_set", "album_top"])
def test_final_membership_probes_reuse_admitted_plan_with_count_plus_one(sample_top, kind):
    db = sample_top.db
    with SQLTrace().install(db.service) as trace:
        result = capture_origin(db, origin(db, kind, sample_top.top))
    probes = [call for call in trace.calls if is_album_probe(call)]
    assert [probe_album(call) for call in probes[:2]] == list(reversed(db.albums))
    assert [probe_limit(call) for call in probes[:2]] == [5001, 4998]
    assert all(probe_limit(call) <= 4 for call in probes[2:])
    assert all(probe_album(call) in db.albums for call in probes)
    descriptor = retained(db, result["source"]["ref"])[0]["origin_descriptor"]
    assert [member["track_refs"] for member in descriptor["origin_proof"]["members"]] == [
        [f"inventory-track:{db.library}:{track}" for track in db.tracks[3:]],
        [f"inventory-track:{db.library}:{track}" for track in db.tracks[:3]],
    ]
    assert [fact["source_position"] for fact in descriptor["facts"]] == [0, 1, 2, 3, 4, 5]
