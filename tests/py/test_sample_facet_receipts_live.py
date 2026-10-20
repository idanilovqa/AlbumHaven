"""Active currentness plus unchanged historical null/null receipt behavior."""
from copy import deepcopy
from uuid import uuid4
import pytest
from psycopg.types.json import Jsonb
from library_mix_postgres_support import mix_db, mix_urls
from music_app.services.owned_playlists import PlaylistError
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from test_sample_playlist_receipts_live import (
    capture, read, recovery, retained, destinations, options, receipts, evaluator, snapshots,
)
from test_sample_playlist_receipt_boundaries import rehash
from sample_playlist_origin_support import capture_origin, origin
from sample_facet_support import (
    KEY, ABSENT, manual_source, set_genre, set_country, envelope, forbid_provider,
    generic_evidence, add_copy, sql_probe,
)


@pytest.fixture(autouse=True)
def no_provider(monkeypatch):
    forbid_provider(monkeypatch)


def forbidden(*args, **kwargs):
    pytest.fail("Replay cannot rerank, reobserve or recreate a receipt")


@pytest.mark.parametrize("version", [1, 2])
@pytest.mark.parametrize("operation", ["read", "recovery", "capture_replay", "save", "play"])
@pytest.mark.parametrize("metadata", ["present", "malformed", "oversized", "denied"])
def test_historical_null_facets_bypass_all_new_json_permission_and_budget_work(mix_db, monkeypatch, version, operation, metadata):
    db = mix_db; parent = manual_source(db, (0, 1, 3)); key = str(uuid4())
    if operation == "play":
        from test_library_mix_persistence_live import grant_media
        from test_sample_playlist_native_live import queue
        grant_media(db)
    # The generic inventory may legitimately have more than 64 copies. Establish
    # it before capture so this test changes only facets, never old evidence.
    if metadata == "oversized":
        for _ in range(64):
            add_copy(db, stale=True)
    value = origin(db, "album_set")
    source = capture(db, parent, key=key) if version == 1 else capture_origin(db, value, key=key)
    before_queue = queue(db, source) if operation == "play" else None
    frozen = retained(db, key)
    descriptor = frozen[0]["origin_descriptor"]
    assert descriptor["version"] == version
    assert descriptor["request"]["options"]["styles"] is descriptor["request"]["options"]["countries"] is None
    before_inventory = generic_evidence(db, (0, 1, 3))
    if metadata == "present":
        set_genre(db, "Rock", indexes=(0, 1, 3)); set_country(db, envelope(db, "GB"))
    elif metadata == "malformed":
        set_genre(db, {"bad": True}, indexes=(0, 1, 3)); set_country(db, None)
    elif metadata == "oversized":
        set_genre(db, "é" * 5000, indexes=(0, 1, 3)); set_country(db, {"oversized": "x" * 100000})
    else:
        set_country(db, envelope(db, "GB"))
    assert generic_evidence(db, (0, 1, 3)) == before_inventory
    checks = []
    def constraints(ctx):
        checks.append(ctx)
        return PolicyEvaluationConstraints(deployment_allowed=not (
            metadata == "denied" and ctx.resource and ctx.resource.resource_kind == "artist"))
    monkeypatch.setattr(evaluator, "evaluate_sample_playlist", forbidden)
    monkeypatch.setattr(snapshots.inventory, "normalize_cached_inventory_row", forbidden)
    with sql_probe(monkeypatch, db) as statements:
        if operation == "read":
            result = read(db, source, constraints=constraints)
        elif operation == "recovery":
            result = recovery(db, key, constraints=constraints)
        elif operation == "capture_replay":
            result = capture(db, parent, key=key, constraints=constraints) if version == 1 else capture_origin(
                db, value, key=key, constraints=constraints)
        elif operation == "save":
            result = db.service.execute(db.context(), db.create_command(source), constraints=constraints)
            assert result["ok"] is True
        else:
            result = queue(db, source, constraints=constraints)
            assert result == before_queue
    assert retained(db, key) == frozen
    if operation not in ("save", "play"):
        assert result == source
    assert not any(ctx.resource and ctx.resource.resource_kind == "artist" for ctx in checks)
    assert not any("musicbrainz_artist_country_v1" in row["sql"] or "genre" in row["sql"] for row in statements)
    assert not any("20001" in row["sql"] or 20001 in (row["params"] or ()) for row in statements)


@pytest.mark.parametrize("facet,ignored", [("styles", "countries"), ("countries", "styles")])
def test_one_active_facet_never_reads_or_enforces_other_facet(facet, ignored, mix_db):
    db = mix_db; parent = manual_source(db, (0,))
    set_genre(db, "Rock"); set_country(db, envelope(db, "GB"))
    token = "genre-tag:Rock" if facet == "styles" else "musicbrainz-country:GB"
    source = capture(db, parent, opts=options(**{facet: frozenset({token})}))
    if ignored == "countries":
        set_country(db, {"oversized": "x" * 100000})
    else:
        set_genre(db, "é" * 20000)
    assert read(db, source) == source


@pytest.mark.parametrize("facet", ["styles", "countries"])
def test_unknown_becoming_unresolved_is_source_changed_even_though_both_facts_are_none(mix_db, facet):
    db = mix_db; parent = manual_source(db, (0,))
    if facet == "countries":
        set_country(db, envelope(db, None))
    token = "genre-tag:Rock" if facet == "styles" else "musicbrainz-country:GB"
    source = capture(db, parent, opts=options(**{facet: frozenset({token})}))
    assert source["entries"] == []
    assert [db.tracks[0], {"styles": "style", "countries": "country"}[facet] + "_metadata_unknown"] in source["source_diagnostics"]
    before = generic_evidence(db)
    if facet == "styles":
        set_genre(db, {"invalid": True})
    else:
        set_country(db, None)
    assert generic_evidence(db) == before
    with pytest.raises(PlaylistError, match="source_changed"):
        read(db, source)


def test_changed_unselected_candidate_active_style_is_currentness_dependency_not_reranking(mix_db, monkeypatch):
    db = mix_db; parent = manual_source(db, (0, 1)); set_genre(db, "Rock", indexes=(0, 1))
    source = capture(db, parent, opts=options(styles=frozenset({"genre-tag:Rock"})))
    assert len(source["entries"]) == 1
    old = retained(db, source["source"]["ref"]); set_genre(db, "Jazz", indexes=(1,))
    monkeypatch.setattr(evaluator, "evaluate_sample_playlist", forbidden)
    with pytest.raises(PlaylistError, match="source_changed"):
        read(db, source)
    assert retained(db, source["source"]["ref"]) == old


def test_same_normalized_valid_country_refresh_remains_current_without_expiry_renewal(mix_db):
    db = mix_db; parent = manual_source(db, (0,)); set_country(db, envelope(db, "GB"))
    source = capture(db, parent, opts=options(countries=frozenset({"musicbrainz-country:GB"})))
    old = retained(db, source["source"]["ref"])
    set_country(db, envelope(db, " GB "))
    assert read(db, source) == source
    assert retained(db, source["source"]["ref"]) == old


@pytest.mark.parametrize("facet,new_value", [("styles", "Jazz"), ("countries", "DE")])
def test_active_changed_fact_rejects_read_recovery_save_without_descriptor_rewrite(mix_db, facet, new_value):
    db = mix_db; parent = manual_source(db, (0,)); set_genre(db, "Rock"); set_country(db, envelope(db, "GB"))
    token = "genre-tag:Rock" if facet == "styles" else "musicbrainz-country:GB"
    source = capture(db, parent, opts=options(**{facet: frozenset({token})}))
    old = retained(db, source["source"]["ref"]); before = destinations(db)
    if facet == "styles": set_genre(db, new_value)
    else: set_country(db, envelope(db, new_value))
    for action in (lambda: read(db, source), lambda: recovery(db, source["source"]["ref"]),
        lambda: db.service.execute(db.context(), db.create_command(source))):
        with pytest.raises(PlaylistError, match="source_changed"):
            action()
    assert retained(db, source["source"]["ref"]) == old and destinations(db) == before


def test_changed_facet_with_recomputed_descriptor_hashes_cannot_forge_source_authority(mix_db):
    db = mix_db; parent = manual_source(db, (0,)); set_genre(db, "Rock")
    source = capture(db, parent, opts=options(styles=frozenset({"genre-tag:Rock"})))
    key = source["source"]["ref"]; descriptor = deepcopy(retained(db, key)[0]["origin_descriptor"])
    descriptor["request"]["options"]["styles"] = ["genre-tag:Jazz"]
    descriptor["facts"][0]["styles"] = ["genre-tag:Jazz"]
    rehash(descriptor)
    with db.connect() as con:
        con.execute("update app.playlist_creation_sources set origin_descriptor=%s where ref=%s",
            (Jsonb(descriptor), key))
    with pytest.raises(PlaylistError, match="source_changed"):
        read(db, source)


def test_request_key_cannot_change_canonical_facet_selection(mix_db):
    db = mix_db; parent = manual_source(db, (0,)); set_genre(db, "Rock"); key = str(uuid4())
    capture(db, parent, key=key, opts=options(styles=frozenset({"genre-tag:Rock"})))
    with pytest.raises(PlaylistError, match="request_key_conflict"):
        capture(db, parent, key=key, opts=options(styles=frozenset({"genre-tag:Jazz"})))


def test_random_representatives_and_capture_share_current_active_eligibility(mix_db):
    db = mix_db; parent = manual_source(db, (0, 1)); set_genre(db, "Rock", indexes=(0, 1))
    opts = options("random", styles=frozenset({"genre-tag:Rock"}))
    result = receipts.representatives(db.service, db.context(), playlist_ref=parent["playlist_id"],
        revision=parent["revision"], options=opts)["data"]
    order = tuple(int(ref.rsplit(":", 1)[1]) for ref in result["representative_refs"])
    set_genre(db, "Jazz", indexes=(1,))
    with pytest.raises(PlaylistError, match="source_changed"):
        capture(db, parent, opts=opts, order=order)


def test_active_per_album_country_rejects_forged_unselected_primary_with_equal_country(mix_db, monkeypatch):
    db = mix_db; parent = manual_source(db, (0, 1))
    set_country(db, envelope(db, "GB"))
    opts = options(selection_basis="per_album", countries=frozenset({"musicbrainz-country:GB"}))
    source = capture(db, parent, opts=opts)
    assert len(source["entries"]) == 1
    key = source["source"]["ref"]; old = deepcopy(retained(db, key)[0]["origin_descriptor"])
    selected = set(old["result"]["track_ids"])
    unselected = next(fact for fact in old["facts"] if fact["track_id"] not in selected)
    descriptor = deepcopy(old)
    changed = next(fact for fact in descriptor["facts"] if fact["track_id"] == unselected["track_id"])
    assert changed["primary_artist_ref"] == "musicbrainz-artist:" + db.artist_mbids[0]
    assert changed["countries"] == ["musicbrainz-country:GB"]
    changed["primary_artist_ref"] = "musicbrainz-artist:" + db.artist_mbids[1]
    rehash(descriptor)
    assert descriptor["request"] == old["request"] and descriptor["result"] == old["result"]
    assert {k: v for k, v in changed.items() if k != "primary_artist_ref"} == {
        k: v for k, v in unselected.items() if k != "primary_artist_ref"}
    before_inventory = generic_evidence(db, (0, 1))
    with db.connect() as con:
        con.execute("update app.playlist_creation_sources set origin_descriptor=%s where ref=%s",
            (Jsonb(descriptor), key))
    frozen = retained(db, key); before_destinations = destinations(db)
    monkeypatch.setattr(evaluator, "evaluate_sample_playlist", forbidden)
    for action in (lambda: read(db, source), lambda: recovery(db, key),
        lambda: db.service.execute(db.context(), db.create_command(source))):
        with pytest.raises(PlaylistError, match="source_changed"):
            action()
    assert generic_evidence(db, (0, 1)) == before_inventory
    assert retained(db, key) == frozen and destinations(db) == before_destinations


@pytest.mark.parametrize("facet", ["styles", "countries"])
def test_active_post_capture_projection_overflow_rejects_replay_without_rewriting_receipt(mix_db, monkeypatch, facet):
    db = mix_db; parent = manual_source(db, (0, 1))
    set_genre(db, "Rock", indexes=(0, 1)); set_country(db, envelope(db, "GB"))
    token = "genre-tag:Rock" if facet == "styles" else "musicbrainz-country:GB"
    opts = options(**{facet: frozenset({token})})
    source = capture(db, parent, opts=opts); key = source["source"]["ref"]
    frozen = retained(db, key); before_destinations = destinations(db)
    before_inventory = generic_evidence(db, (0, 1))
    if facet == "styles":
        set_genre(db, "é" * 513, indexes=(1,))
    else:
        set_country(db, {"oversized": "x" * 8193})
    assert generic_evidence(db, (0, 1)) == before_inventory
    monkeypatch.setattr(evaluator, "evaluate_sample_playlist", forbidden)
    original = snapshots.inventory.read_inventory
    def observation_free(*args, **kwargs):
        assert kwargs["include_popularity"] is False
        return original(*args, **kwargs)
    monkeypatch.setattr(snapshots.inventory, "read_inventory", observation_free)
    for action in (lambda: read(db, source), lambda: recovery(db, key),
        lambda: capture(db, parent, key=key, opts=opts),
        lambda: db.service.execute(db.context(), db.create_command(source))):
        with sql_probe(monkeypatch, db) as statements:
            with pytest.raises(PlaylistError, match="source_too_large") as error:
                action()
        assert error.value.status_code == 413
        assert not any("catalog.popularity_source_observations" in row["sql"] for row in statements)
        assert retained(db, key) == frozen and destinations(db) == before_destinations
