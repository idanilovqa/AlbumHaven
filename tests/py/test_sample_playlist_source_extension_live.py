"""Actual persisted source -> shared inventory -> unchanged pure Sample evaluator.

All data belongs to the existing isolated normal-table fixture. Spies forward to
real owners; no provider, authorization, normalization or ranking is substituted.
"""
from contextlib import contextmanager
from dataclasses import FrozenInstanceError, fields
from decimal import Decimal
from uuid import uuid4

from psycopg.types.json import Jsonb
import pytest

from library_mix_postgres_support import mix_db, mix_urls
from music_app.services import lastfm_track_popularity as provider
from music_app.services import sample_playlist as evaluator
from music_app.services import sample_playlist_sources as samples
from music_app.services.owned_playlists import PlaylistError, evidence_digest
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from test_sample_playlist_sources_live import manual_source, snapshot
from test_sample_playlist_source_facts import OBSERVATION_KEYS

METHODS = ("most_listened", "random")


@pytest.fixture(autouse=True)
def no_provider_io(monkeypatch):
    def forbidden(*args, **kwargs):
        pytest.fail("Source capture must use persisted facts without provider I/O")
    monkeypatch.setattr(provider, "fetch_track_popularity", forbidden)
    monkeypatch.setattr(provider, "get_lastfm_track_info", forbidden)


def options(method, **changes):
    return evaluator.SampleOptions(**({"selection_basis": "per_album", "songs_per_group": 1,
        "unknown_facets": "include", "selection_method": method} | changes))


def evaluate(captured, method, *, order=None, **changes):
    return evaluator.evaluate_sample_playlist(captured.candidates, options(method, **changes),
        random_order=order if method == "random" else None)


def unmap(con, track):
    con.execute("update library.track_popularity_mapping_slots set current_revision=null where track_id=%s", (track,))


def assert_recording(con, db, track, *, state="asserted", source="owner-verified:recording", mbid=None):
    con.execute("""update library.local_tracks set mbid=%s,mbid_assertion_state=%s,evidence_source=%s
        where id=%s""", (mbid or db.recordings[track], state, source, track))


def set_tags(con, track, key, value):
    # Existing physical scan-cache fact owner, not a fabricated inventory row.
    con.execute("""update library.local_track_files set metadata=jsonb_set(metadata,
        %s::text[],%s::jsonb,true) where track_id=%s""", (["scan_cache", "file_entry", key], Jsonb(value), track))


@pytest.mark.parametrize("method", METHODS)
def test_actual_source_feeds_real_evaluator_with_explicit_quota_policy_and_order(mix_db, method):
    db = mix_db
    receipt = manual_source(db, (4, 1, 3, 0, 2, 5))
    before = db.state(receipt["playlist_id"])
    persisted = before[1]
    with snapshot(db, receipt, selection_method=method) as captured:
        ids = tuple(db.tracks[i] for i in (4, 1, 3, 0, 2, 5))
        assert tuple(item.track_id for item in captured.candidates) == ids
        assert tuple(item.source_position for item in captured.candidates) == tuple(item["position"] for item in persisted)
        assert all(isinstance(item, evaluator.SampleCandidate) for item in captured.candidates)
        assert all(item.styles is item.countries is None for item in captured.candidates)
        order = tuple(reversed(ids)) if method == "random" else None
        result = evaluate(captured, method, order=order)
        assert result.track_ids == ((db.tracks[0], db.tracks[3]) if method == "most_listened" else (db.tracks[5], db.tracks[2]))
        assert result.group_counts == ((f"inventory-album:{db.library}:{db.albums[1]}", 1),
                                       (f"inventory-album:{db.library}:{db.albums[0]}", 1))
        assert result.random_order == order
        assert len(result.diagnostics) == 4
        assert all(reason == "quota_exceeded" for _track, reason in result.diagnostics)
        assert evaluate(captured, method, order=order) == result
    assert db.state(receipt["playlist_id"]) == before


@pytest.mark.parametrize("method", METHODS)
def test_capture_is_one_authorized_transaction_frozen_path_free_and_digest_bound(mix_db, monkeypatch, method):
    db = mix_db
    receipt = manual_source(db)
    before = db.state(receipt["playlist_id"])
    counts = {table: db.total(table) for table in ("playlists", "playlist_items", "playlist_operations", "playlist_library_mixes")}
    admissions, reads, normalized, plain_seen = [], [], {}, []
    authorize, read, normalize = db.service._authorized, samples.inventory.read_inventory, samples.inventory.normalize_cached_inventory_row
    plain = samples.sources._plain
    def plain_hash(row):
        if reads:  # Exclude the earlier lock owner's own inventory normalization.
            plain_seen.append((row["original_local_track_id"], row["duration_seconds"]))
        return plain(row)
    @contextmanager
    def authorized(*args, **kwargs):
        with authorize(*args, **kwargs) as value:
            admissions.append(value[0])
            yield value
    def reading(connection, library, **kwargs):
        rows = read(connection, library, **kwargs)
        reads.append((connection, library, kwargs, rows))
        return rows
    def normalizing(row):
        result = normalize(row)
        normalized[row["original_local_track_id"]] = result
        return result
    monkeypatch.setattr(db.service, "_authorized", authorized)
    monkeypatch.setattr(samples.sources, "_plain", plain_hash)
    monkeypatch.setattr(samples.inventory, "read_inventory", reading)
    monkeypatch.setattr(samples.inventory, "normalize_cached_inventory_row", normalizing)
    with snapshot(db, receipt, selection_method=method) as captured:
        assert len(admissions) == len(reads) == 1
        connection, library, kwargs, rows = reads[0]
        assert connection is admissions[0] and library == db.library
        assert kwargs == {"track_ids": sorted(db.tracks[i] for i in (4, 1, 3)), "lock": True,
                          "include_popularity": method == "most_listened"}
        assert {track for track, _duration in plain_seen} == {row["original_local_track_id"] for row in rows}
        assert all(isinstance(duration, Decimal) and duration == Decimal("180.000") for _track, duration in plain_seen)
        expected = {row["original_local_track_id"]: samples.sources.entry_evidence(plain(row)) for row in rows}
        assert captured.inventory_digests == tuple((item.track_id, expected[item.track_id]) for item in captured.candidates)
        members = tuple((str(item["ref"]), item["position"], item["local_track_id"], item["original_local_track_id"]) for item in before[1])
        assert captured.membership_digest == evidence_digest(members)
        assert [field.name for field in fields(captured)] == ["playlist_ref", "revision", "library_id", "account_id",
            "session_id", "membership_digest", "candidates", "diagnostics", "inventory_digests"]
        assert not hasattr(captured, "__dict__")
        assert not hasattr(samples, "SamplePopularityCandidate")
        assert isinstance(captured.candidates, tuple) and isinstance(captured.inventory_digests, tuple)
        assert str(db.root_path) not in repr(captured)
        assert not any(hasattr(item, "inventory_evidence") or hasattr(item, "private_path") for item in captured.candidates)
        assert all(len(digest) == 64 for _track, digest in captured.inventory_digests)
        with pytest.raises(FrozenInstanceError):
            captured.inventory_digests = ()
        for item in captured.candidates:
            assert isinstance(item.duration_seconds, Decimal) and item.duration_seconds == Decimal("180.000")
            with pytest.raises(FrozenInstanceError):
                item.canonical_recording_id = None
            if method == "most_listened":
                track, cached, reason = normalized[item.track_id]
                assert reason is None and item.popularity_track is track and item.popularity is cached
                assert item.popularity.observation.count == db.counts[item.track_id]
            else:
                assert item.popularity_track is item.popularity is None
        assert len(normalized) == (3 if method == "most_listened" else 0)
    assert db.state(receipt["playlist_id"]) == before
    assert {table: db.total(table) for table in counts} == counts


def test_random_has_no_observation_sql_result_before_plain_hash_or_identity_normalization(mix_db, monkeypatch):
    db = mix_db
    receipt = manual_source(db)
    seen, identities, plain_rows = [], [], []
    read, identity, plain = samples.inventory.read_inventory, samples.inventory.normalize_cached_track_identity, samples.sources._plain
    def reading(*args, **kwargs):
        assert kwargs["include_popularity"] is False and kwargs["lock"] is True
        rows = read(*args, **kwargs)
        assert rows and all(OBSERVATION_KEYS.isdisjoint(row) for row in rows)
        seen.extend(rows)
        return rows
    def identifying(row):
        assert OBSERVATION_KEYS.isdisjoint(row)
        identities.append(row["original_local_track_id"])
        return identity(row)
    def plain_hash(row):
        assert OBSERVATION_KEYS.isdisjoint(row)
        plain_rows.append(row["original_local_track_id"])
        return plain(row)
    def forbidden(*args, **kwargs):
        pytest.fail("Random reached full observation normalization")
    monkeypatch.setattr(samples.inventory, "read_inventory", reading)
    monkeypatch.setattr(samples.inventory, "normalize_cached_track_identity", identifying)
    monkeypatch.setattr(samples.inventory, "normalize_cached_inventory_row", forbidden)
    monkeypatch.setattr(samples.sources, "_plain", plain_hash)
    with snapshot(db, receipt, selection_method="random") as captured:
        ids = {item.track_id for item in captured.candidates}
        assert ids == {row["original_local_track_id"] for row in seen} == set(identities)
        assert ids <= set(plain_rows)
        assert captured.diagnostics == ()
        assert all(item.recording_evidence == "lastfm.track.getInfo.mbid" for item in captured.candidates)
        assert all(item.popularity_track is item.popularity is None for item in captured.candidates)


@pytest.mark.parametrize("method", METHODS)
def test_current_mapping_without_current_observation_retains_canonical_identity(mix_db, method):
    db = mix_db
    receipt = manual_source(db, (0,))
    with db.connect() as con:
        con.execute("""update catalog.popularity_source_slots set current_revision=null
            where provider='lastfm' and metric='overall_scrobbles' and source_entity_id=%s""", (db.source_ids[db.tracks[0]],))
    with snapshot(db, receipt, selection_method=method) as captured:
        item, = captured.candidates
        assert item.canonical_recording_id == db.recordings[db.tracks[0]]
        assert item.recording_evidence == "lastfm.track.getInfo.mbid"
        assert item.popularity is None
        assert captured.diagnostics == ()
        if method == "random":
            assert item.popularity_track is None
            assert evaluate(captured, method, order=(item.track_id,)).track_ids == (item.track_id,)
        else:
            assert item.popularity_track is not None
            assert evaluate(captured, method).track_ids == ()


@pytest.mark.parametrize("method", METHODS)
@pytest.mark.parametrize("mapping", ["missing", "stale", "current"])
def test_asserted_recording_fallback_and_current_mapping_precedence(mix_db, method, mapping):
    db = mix_db
    track = db.tracks[0]
    receipt = manual_source(db, (0,))
    evidence = "  owner-verified:recording  "
    with db.connect() as con:
        assert_recording(con, db, track, source=evidence)
        if mapping == "missing":
            unmap(con, track)
        elif mapping == "current":
            db.rebind_mappings(con, [track])
        # Otherwise the actual old mapping fingerprint is now stale.
    with snapshot(db, receipt, selection_method=method) as captured:
        item, = captured.candidates
        assert item.canonical_recording_id == db.recordings[track]
        assert item.recording_evidence == ("lastfm.track.getInfo.mbid" if mapping == "current" else evidence)
        assert captured.diagnostics == (((track, "missing_provider_mapping"),) if method == "most_listened" and mapping != "current" else ())
        if method == "random":
            assert item.popularity_track is item.popularity is None
            assert evaluate(captured, method, order=(track,)).track_ids == (track,)
        elif mapping != "current":
            assert item.popularity_track is item.popularity is None
            assert evaluate(captured, method).diagnostics == ((track, "missing_provider_mapping"),)


@pytest.mark.parametrize("case", ["tags_only", "unreviewed", "ambiguous", "conflicting", "blank", "missing_source", "disagreement", "stale_tag_mapping"])
def test_random_never_promotes_unasserted_or_conflicting_recording_evidence(mix_db, case):
    db = mix_db
    track = db.tracks[0]
    receipt = manual_source(db, (0,))
    with db.connect() as con:
        if case not in ("tags_only", "stale_tag_mapping"):
            assert_recording(con, db, track,
                state=case if case in ("unreviewed", "ambiguous", "conflicting") else "asserted",
                source=" " if case == "blank" else None if case == "missing_source" else "owner-verified",
                mbid=str(uuid4()) if case == "disagreement" else None)
        if case == "stale_tag_mapping":
            con.execute("update library.local_tracks set title=title || ' changed' where id=%s", (track,))
        else:
            unmap(con, track)
    with snapshot(db, receipt, selection_method="random") as captured:
        item, = captured.candidates
        assert item.canonical_recording_id is item.recording_evidence is None
        assert item.popularity_track is item.popularity is None
        assert captured.diagnostics == ((track, "missing_canonical_recording"),)
        assert evaluate(captured, "random", order=()).diagnostics == ((track, "missing_canonical_recording"),)
        # Source readiness must not be appended to filtered evaluator diagnostics.
        filtered = evaluate(captured, "random", order=(), countries=frozenset({"CA"}), unknown_facets="exclude")
        assert filtered.diagnostics == ((track, "unknown_country"),)


@pytest.mark.parametrize("method", METHODS)
def test_mapping_and_ambiguity_diagnostics_are_sorted_while_local_candidates_keep_source_order(mix_db, method):
    db = mix_db
    receipt = manual_source(db, (4, 0))
    with db.connect() as con:
        unmap(con, db.tracks[4])
        con.execute("update library.local_tracks set mbid_assertion_state='ambiguous' where id=%s", (db.tracks[0],))
    with snapshot(db, receipt, selection_method=method) as captured:
        assert tuple(item.track_id for item in captured.candidates) == (db.tracks[4], db.tracks[0])
        assert tuple(track for track, _ in captured.inventory_digests) == (db.tracks[4], db.tracks[0])
        assert captured.diagnostics == ((db.tracks[0], "ambiguous_attribution" if method == "most_listened" else "missing_canonical_recording"),
                                       (db.tracks[4], "missing_provider_mapping" if method == "most_listened" else "missing_canonical_recording"))


@pytest.mark.parametrize("album_kind", ["ordinary", "compilation", "albumless"])
@pytest.mark.parametrize("method", METHODS)
def test_group_facts_use_real_primary_credits_without_featured_groups(mix_db, album_kind, method):
    db = mix_db
    track = db.tracks[0]
    receipt = manual_source(db, (0,))
    with db.connect() as con:
        if album_kind == "compilation":
            con.execute("update library.local_albums set metadata=metadata || '{\"is_compilation\":true}'::jsonb where id=%s", (db.albums[0],))
        elif album_kind == "albumless":
            con.execute("update library.local_tracks set album_id=null where id=%s", (track,))
        set_tags(con, track, "musicbrainz_album_artist_ids", [db.artist_mbids[1]])
        db.rebind_mappings(con, [track])
        con.execute("""insert into library.local_album_featured_artists(library_id,album_id,artist_id,featured_kind)
            select %s,%s,artist_id,'featured_track_artist' from library.local_albums where id=%s""",
            (db.library, db.albums[0], db.albums[1]))
    with snapshot(db, receipt, selection_method=method) as captured:
        item, = captured.candidates
        expected_artist = db.artist_mbids[1 if album_kind == "ordinary" else 0]
        assert item.primary_artist_ref == "musicbrainz-artist:" + expected_artist
        assert item.album_ref == (None if album_kind == "albumless" else f"inventory-album:{db.library}:{db.albums[0]}")
        selected = evaluate(captured, method, order=(track,), selection_basis="per_artist")
        assert selected.track_ids == (track,)
        assert selected.group_counts == (("musicbrainz-artist:" + expected_artist, 1),)


@pytest.mark.parametrize("kind", ["compilation", "albumless"])
@pytest.mark.parametrize("artist_case", ["asserted", "unreviewed", "blank", "missing_source", "disagreement"])
def test_random_artist_assertion_without_mapping_is_strict_and_never_uses_old_mapped_artist(mix_db, kind, artist_case):
    db = mix_db
    track = db.tracks[0]
    receipt = manual_source(db, (0,))
    with db.connect() as con:
        assert_recording(con, db, track)
        con.execute("""update library.local_artists set mbid=%s,mbid_assertion_state=%s,evidence_source=%s
            where id=(select artist_id from library.local_tracks where id=%s)""",
            (db.artist_mbids[1 if artist_case == "disagreement" else 0],
             "unreviewed" if artist_case == "unreviewed" else "asserted",
             " " if artist_case == "blank" else None if artist_case == "missing_source" else "owner-verified:artist", track))
        if kind == "albumless":
            con.execute("update library.local_tracks set album_id=null where id=%s", (track,))
        else:
            con.execute("update library.local_albums set metadata=metadata || '{\"is_compilation\":true}'::jsonb where id=%s", (db.albums[0],))
        # Keep the now-stale mapping to prove its old artist never supplies authority.
    with snapshot(db, receipt, selection_method="random") as captured:
        item, = captured.candidates
        assert item.canonical_recording_id == db.recordings[track]
        assert item.primary_artist_ref == ("musicbrainz-artist:" + db.artist_mbids[0] if artist_case == "asserted" else None)
        assert captured.diagnostics == ()
        selected = evaluate(captured, "random", order=(track,) if artist_case == "asserted" else (), selection_basis="per_artist")
        assert selected.track_ids == ((track,) if artist_case == "asserted" else ())
    with snapshot(db, receipt, selection_method="most_listened") as captured:
        assert captured.candidates[0].primary_artist_ref is None
        assert captured.candidates[0].popularity_track is None


@pytest.mark.parametrize("method", METHODS)
@pytest.mark.parametrize("length,low,high,chosen", [
    ("up_to_3", "239.999", "240.000", 0), ("up_to_5", "359.999", "360.000", 0),
    ("up_to_8", "539.999", "540.000", 0), ("up_to_10", "659.999", "660.000", 0),
    ("over_10", "659.999", "660.000", 1),
])
def test_decimal_duration_boundaries_reach_real_evaluator_without_hash_rounding(mix_db, method, length, low, high, chosen):
    db = mix_db
    receipt = manual_source(db, (0, 1))
    with db.connect() as con:
        for track, duration in zip(db.tracks[:2], (low, high)):
            con.execute("update library.local_tracks set duration_seconds=%s where id=%s", (Decimal(duration), track))
    with snapshot(db, receipt, selection_method=method) as captured:
        assert tuple(item.duration_seconds for item in captured.candidates) == (Decimal(low), Decimal(high))
        assert all(isinstance(item.duration_seconds, Decimal) for item in captured.candidates)
        assert all(len(digest) == 64 for _track, digest in captured.inventory_digests)
        chosen_id = db.tracks[chosen]
        result = evaluate(captured, method, order=(chosen_id,), length=length)
        assert result.track_ids == (chosen_id,)
        assert result.diagnostics == ((db.tracks[1 - chosen], "length_filtered"),)
        first_digests = captured.inventory_digests
    with snapshot(db, receipt, selection_method=method) as again:
        assert again.inventory_digests == first_digests


@pytest.mark.parametrize("method", METHODS)
@pytest.mark.parametrize("duration", [None, Decimal("-1"), Decimal("NaN")])
def test_real_persisted_unknown_duration_is_normalized_without_synthetic_length(mix_db, method, duration):
    db = mix_db
    receipt = manual_source(db, (0,))
    with db.connect() as con:
        con.execute("update library.local_tracks set duration_seconds=%s where id=%s", (duration, db.tracks[0]))
    with snapshot(db, receipt, selection_method=method) as captured:
        assert captured.candidates[0].duration_seconds is None
        assert len(captured.inventory_digests[0][1]) == 64
        excluded = evaluate(captured, method, order=(), length="up_to_3", unknown_facets="exclude")
        assert excluded.track_ids == () and excluded.diagnostics == ((db.tracks[0], "unknown_length"),)
        assert evaluate(captured, method, order=(db.tracks[0],), length="up_to_3").track_ids == (db.tracks[0],)


@pytest.mark.parametrize("method", METHODS)
@pytest.mark.parametrize("credit", ["different", "missing"])
def test_source_group_consensus_uses_all_admitted_local_rows_even_missing_mappings(mix_db, method, credit):
    db = mix_db
    receipt = manual_source(db, (0, 1))
    with db.connect() as con:
        set_tags(con, db.tracks[1], "musicbrainz_album_artist_ids", [db.artist_mbids[1]] if credit == "different" else [])
        unmap(con, db.tracks[1])
    with snapshot(db, receipt, selection_method=method) as captured:
        assert tuple(item.track_id for item in captured.candidates) == tuple(db.tracks[:2])
        assert all(item.primary_artist_ref is None for item in captured.candidates)
        assert captured.candidates[0].canonical_recording_id == db.recordings[db.tracks[0]]
        selected = evaluate(captured, method, order=(), selection_basis="per_artist")
        assert selected.track_ids == ()
        assert (db.tracks[0], "missing_group_identity") in selected.diagnostics


@pytest.mark.parametrize("method", METHODS)
@pytest.mark.parametrize("kind", ["track", "album"])
def test_initial_denial_precedes_every_new_metadata_normalizer_and_group_fact(mix_db, monkeypatch, method, kind):
    db = mix_db
    receipt = manual_source(db)
    groups = []
    def forbidden(*args, **kwargs):
        pytest.fail("Denied resource metadata reached an inventory/identity/hash owner")
    def no_groups(rows, *, track_artist_ids):
        rows = tuple(rows)
        groups.append(rows)
        assert rows == () and track_artist_ids == {}
        return {}
    for name in ("read_inventory", "local_identity", "normalize_cached_track_identity", "normalize_cached_inventory_row"):
        monkeypatch.setattr(samples.inventory, name, forbidden)
    monkeypatch.setattr(samples.inventory, "primary_artist_refs", no_groups)
    monkeypatch.setattr(samples.sources, "_plain", forbidden)
    constraint = lambda context: PolicyEvaluationConstraints(deployment_allowed=not (
        context.resource and context.resource.resource_kind == kind))
    with snapshot(db, receipt, selection_method=method, constraints=constraint) as captured:
        assert captured.candidates == captured.diagnostics == captured.inventory_digests == ()
    assert all(value == () for value in groups)


@pytest.mark.parametrize("method", METHODS)
def test_post_inventory_wait_denial_is_filtered_before_identity_and_album_consensus(mix_db, monkeypatch, method):
    db = mix_db
    receipt = manual_source(db, (0, 1))
    allowed, denied = db.tracks[:2]
    with db.connect() as con:
        set_tags(con, denied, "musicbrainz_album_artist_ids", [db.artist_mbids[1]])
        db.rebind_mappings(con, [denied])
    waited = False
    normalizations, grouped, reads = [], [], []
    read, group = samples.inventory.read_inventory, samples.inventory.primary_artist_refs
    def reading(*args, **kwargs):
        nonlocal waited
        rows = read(*args, **kwargs)
        reads.append(kwargs)
        waited = True
        return rows
    def grouping(rows, *, track_artist_ids):
        rows = tuple(rows)
        grouped.append(tuple(row["original_local_track_id"] for row in rows))
        assert denied not in track_artist_ids
        return group(rows, track_artist_ids=track_artist_ids)
    def wrap(real):
        def normalize(row):
            normalizations.append(row["original_local_track_id"])
            assert row["original_local_track_id"] != denied
            return real(row)
        return normalize
    for name in ("local_identity", "normalize_cached_track_identity", "normalize_cached_inventory_row"):
        monkeypatch.setattr(samples.inventory, name, wrap(getattr(samples.inventory, name)))
    monkeypatch.setattr(samples.inventory, "read_inventory", reading)
    monkeypatch.setattr(samples.inventory, "primary_artist_refs", grouping)
    def constraint(context):
        resource = context.resource
        blocked = waited and resource and resource.resource_kind == "track" and resource.resource_ref == str(denied)
        return PolicyEvaluationConstraints(deployment_allowed=not blocked)
    with snapshot(db, receipt, selection_method=method, constraints=constraint) as captured:
        assert [item.track_id for item in captured.candidates] == [allowed]
        assert captured.candidates[0].primary_artist_ref == "musicbrainz-artist:" + db.artist_mbids[0]
        assert captured.diagnostics == ()
    assert len(reads) == 1 and reads[0]["track_ids"] == [allowed, denied]
    assert normalizations and set(normalizations) == {allowed}
    assert grouped == [(allowed,)]


@pytest.mark.parametrize("method", METHODS)
def test_unavailable_persisted_track_is_not_a_candidate_or_group_poison(mix_db, method):
    db = mix_db
    receipt = manual_source(db, (0, 1))
    with db.connect() as con:
        con.execute("update library.local_track_files set metadata=jsonb_set(metadata,'{scan_cache,stale}','true'::jsonb) where track_id=%s", (db.tracks[1],))
    with snapshot(db, receipt, selection_method=method) as captured:
        assert [item.track_id for item in captured.candidates] == [db.tracks[0]]
        assert captured.candidates[0].primary_artist_ref == "musicbrainz-artist:" + db.artist_mbids[0]
        assert [track for track, _ in captured.inventory_digests] == [db.tracks[0]]
        assert captured.diagnostics == ()


@pytest.mark.parametrize("method", METHODS)
def test_repeated_real_copy_occurrence_retains_first_persisted_position_once(mix_db, method):
    db = mix_db
    receipt = manual_source(db, (1, 0))
    with db.connect() as con:
        # Migration 0106 permits this independent authored occurrence without
        # weakening ordinary direct-entry uniqueness.
        con.execute("""insert into app.playlist_items
            (ref,playlist_ref,library_id,position,original_local_track_id,local_track_id,
             source_kind,source_protocol,source_lineage)
            values(%s,%s,%s,99,%s,%s,'playlist','playlist_copy_v1',%s)""",
            (uuid4(), receipt["playlist_id"], db.library, db.tracks[1], db.tracks[1],
             Jsonb({"playlist_ref": str(uuid4()), "playlist_item_ref": str(uuid4()), "playlist_revision": "1"})))
    persisted = db.state(receipt["playlist_id"])[1]
    assert len(persisted) == 3
    with snapshot(db, receipt, selection_method=method) as captured:
        assert [item.track_id for item in captured.candidates] == [db.tracks[1], db.tracks[0]]
        assert captured.candidates[0].source_position == persisted[0]["position"]
        assert captured.candidates[0].source_position != 99
        assert [track for track, _ in captured.inventory_digests] == [db.tracks[1], db.tracks[0]]
        members = tuple((str(item["ref"]), item["position"], item["local_track_id"], item["original_local_track_id"]) for item in persisted)
        assert captured.membership_digest == evidence_digest(members)


@pytest.mark.parametrize("method", METHODS)
def test_deleted_member_current_id_never_rebinds_saved_original_or_same_display_track(mix_db, method):
    db = mix_db
    receipt = manual_source(db, (0, 1))
    with db.connect() as con:
        con.execute("update library.local_tracks set title=(select title from library.local_tracks where id=%s) where id=%s",
                    (db.tracks[0], db.tracks[2]))
        con.execute("delete from library.local_tracks where id=%s", (db.tracks[0],))
    first = db.state(receipt["playlist_id"])[1][0]
    assert first["local_track_id"] is None and first["original_local_track_id"] == db.tracks[0]
    with snapshot(db, receipt, selection_method=method) as captured:
        assert [item.track_id for item in captured.candidates] == [db.tracks[1]]
        assert db.tracks[2] not in [track for track, _ in captured.inventory_digests]


@pytest.mark.parametrize("method", METHODS)
@pytest.mark.parametrize("when", ["inventory_wait", "evaluation"])
def test_exact_member_comparison_rejects_changes_after_lock_wait_and_after_yield(mix_db, monkeypatch, method, when):
    db = mix_db
    receipt = manual_source(db, (0, 1))
    before = db.state(receipt["playlist_id"])
    connections = []
    read = samples.inventory.read_inventory
    def alter(connection):
        connection.execute("update app.playlist_items set position=77 where ref=%s", (before[1][0]["ref"],))
    def reading(connection, *args, **kwargs):
        result = read(connection, *args, **kwargs)
        connections.append(connection)
        if when == "inventory_wait":
            alter(connection)
        return result
    monkeypatch.setattr(samples.inventory, "read_inventory", reading)
    with pytest.raises(PlaylistError, match="source_changed"):
        with snapshot(db, receipt, selection_method=method):
            assert when == "evaluation", "Changed membership yielded after inventory wait"
            alter(connections[0])
    assert len(connections) == 1
    assert db.state(receipt["playlist_id"]) == before


@pytest.mark.parametrize("kind", ["track", "album"])
def test_random_retains_final_resource_authority_fence(mix_db, kind):
    db = mix_db
    receipt = manual_source(db)
    denied = False
    def constraint(context):
        return PolicyEvaluationConstraints(deployment_allowed=not (
            denied and context.resource and context.resource.resource_kind == kind))
    with pytest.raises(PlaylistError, match="source_unavailable"):
        with snapshot(db, receipt, selection_method="random", constraints=constraint) as captured:
            assert captured.candidates
            denied = True


@pytest.mark.parametrize("when", ["initial", "inventory_wait", "evaluation"])
def test_random_keeps_current_session_clock_fences(mix_db, monkeypatch, when):
    from datetime import timedelta
    db = mix_db
    receipt = manual_source(db)
    read = samples.inventory.read_inventory
    def reading(*args, **kwargs):
        result = read(*args, **kwargs)
        if when == "inventory_wait":
            db.clock_time += timedelta(days=2)
        return result
    monkeypatch.setattr(samples.inventory, "read_inventory", reading)
    if when == "initial":
        db.clock_time += timedelta(days=2)
    with pytest.raises(PlaylistError):
        with snapshot(db, receipt, selection_method="random"):
            assert when == "evaluation", "Expired session yielded"
            db.clock_time += timedelta(days=2)


@pytest.mark.parametrize("change", ["revision", "private", "create", "empty", "bound"])
def test_random_does_not_bypass_parent_command_or_complete_membership_admission(mix_db, monkeypatch, change):
    from music_app.services.owned_playlists import CREATE
    db = mix_db
    receipt = manual_source(db)
    context = db.context(); constraints = None
    if change == "revision":
        receipt = receipt | {"revision": "999"}
    elif change == "private":
        with db.connect() as con:
            other = db.member(con)
        context = db.context(other)
    elif change == "create":
        constraints = lambda ctx: PolicyEvaluationConstraints(deployment_allowed=ctx.action != CREATE)
    elif change == "empty":
        receipt = db.mutate(receipt, "remove", item_refs=[str(item["ref"]) for item in db.state(receipt["playlist_id"])[1]])
    else:
        monkeypatch.setattr(samples, "MAX_PLAYLIST_ITEMS_PER_COMMAND", 2)
    def forbidden(*args, **kwargs):
        pytest.fail("Invalid source reached inventory read")
    monkeypatch.setattr(samples.inventory, "read_inventory", forbidden)
    with pytest.raises(PlaylistError):
        with snapshot(db, receipt, context=context, selection_method="random", constraints=constraints):
            pytest.fail("Invalid source yielded")


@pytest.mark.parametrize("count,state,reason", [(0, "resolved", None), (None, "missing", "missing_global_metric"),
                                               (42, "ambiguous", "ambiguous_attribution")])
def test_most_listened_source_keeps_cached_zero_unknown_and_ambiguous_counts(mix_db, count, state, reason):
    db = mix_db
    track = db.tracks[0]
    receipt = manual_source(db, (0,))
    with db.connect() as con:
        db.observe(con, track, count, state=state)
    with snapshot(db, receipt) as captured:
        item, = captured.candidates
        assert item.popularity.observation.count == count
        assert item.popularity.observation.attribution_state == state
        assert item.popularity.observation.provider == "lastfm"
        assert item.popularity.observation.metric == "overall_scrobbles"
        assert captured.diagnostics == ()
        result = evaluate(captured, "most_listened")
        assert result.track_ids == ((track,) if reason is None else ())
        assert result.diagnostics == (() if reason is None else ((track, reason),))


@pytest.mark.parametrize("method", METHODS)
def test_parent_revision_is_rechecked_after_evaluation_before_success(mix_db, monkeypatch, method):
    db = mix_db
    receipt = manual_source(db)
    before = db.state(receipt["playlist_id"])
    connections = []
    read = samples.inventory.read_inventory
    def reading(connection, *args, **kwargs):
        connections.append(connection)
        return read(connection, *args, **kwargs)
    monkeypatch.setattr(samples.inventory, "read_inventory", reading)
    with pytest.raises(PlaylistError, match="revision_conflict"):
        with snapshot(db, receipt, selection_method=method) as captured:
            assert captured.candidates
            connections[0].execute("update app.playlists set revision=revision+1 where ref=%s", (receipt["playlist_id"],))
    assert db.state(receipt["playlist_id"]) == before


@pytest.mark.parametrize("method", METHODS)
def test_all_post_wait_admissions_lost_never_normalizes_or_refills_from_library(mix_db, monkeypatch, method):
    db = mix_db
    receipt = manual_source(db)
    waited, reads = False, []
    read = samples.inventory.read_inventory
    def reading(*args, **kwargs):
        nonlocal waited
        rows = read(*args, **kwargs)
        reads.append(kwargs)
        waited = True
        return rows
    def forbidden(*args, **kwargs):
        pytest.fail("Post-wait denied metadata was normalized")
    def grouping(rows, *, track_artist_ids):
        assert tuple(rows) == () and track_artist_ids == {}
        return {}
    monkeypatch.setattr(samples.inventory, "read_inventory", reading)
    for name in ("local_identity", "normalize_cached_track_identity", "normalize_cached_inventory_row"):
        monkeypatch.setattr(samples.inventory, name, forbidden)
    monkeypatch.setattr(samples.inventory, "primary_artist_refs", grouping)
    def constraint(context):
        return PolicyEvaluationConstraints(deployment_allowed=not (
            waited and context.resource and context.resource.resource_kind == "track"))
    with snapshot(db, receipt, selection_method=method, constraints=constraint) as captured:
        assert captured.candidates == captured.inventory_digests == captured.diagnostics == ()
    assert len(reads) == 1 and reads[0]["track_ids"] == sorted(db.tracks[i] for i in (4, 1, 3))
