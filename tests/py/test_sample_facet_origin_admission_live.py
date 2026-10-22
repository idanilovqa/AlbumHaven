"""Actual new producers delegate to accepted typed-origin and authority owners.

Only exact artist network acquisition is doubled. Normal Top setup is fixture
construction; discovery cannot create a receipt or acquire provider metadata.
"""
from copy import deepcopy
import pytest
from library_mix_postgres_support import mix_db, mix_urls
from music_app.services.owned_playlists import BROWSE, PlaylistError
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from sample_playlist_origin_support import KINDS, origin, sample_top
from test_sample_playlist_native_live import receipt_count
from test_sample_playlist_receipts_live import destinations
from sample_facet_support import (
    KEY, REFRESH, acquisition, country, enrich, envelope, grant_refresh,
    manual_source, primary_row, set_country, set_genre, strict_result, target, sql_probe,
)


def assert_country_typed_lock_prefix(log, db, kind, top):
    write = next(row for row in log if row["sql"].startswith("update library.local_artists"))
    same = [row for row in log if row["connection"] is write["connection"]]
    advisory = next(i for i, row in enumerate(same) if "pg_advisory_xact_lock" in row["sql"])
    # Existing typed origin locks occur after Country's advisory, not before a
    # provider request. The legacy tail is separately asserted in concurrency.
    prefix = same[advisory + 1:]
    first_track = next(i for i, row in enumerate(prefix)
        if "from library.local_tracks" in row["sql"] and "for update" in row["sql"]
        and "from library.local_albums" not in row["sql"])
    albums = [row for row in prefix[:first_track]
        if "from library.local_albums" in row["sql"] and "for update" in row["sql"]]
    assert albums and all("order by id" in row["sql"] for row in albums)
    assert [record["id"] for row in albums for record in row["rows"]] == sorted(db.albums)
    selected = prefix[first_track]
    assert "for update nowait" in selected["sql"]
    expected = [db.tracks[i] for i in (3, 1, 0)] if kind == "album_details" else db.tracks
    assert [row["id"] for row in selected["rows"]] == sorted(expected)
    legacy = next(row for row in prefix[first_track + 1:]
        if "from library.local_tracks" in row["sql"] and "for update" in row["sql"]
        and "from library.local_albums" not in row["sql"])
    assert "nowait" not in legacy["sql"]
    bindings = [row for row in prefix[:first_track] if "lock_top_native_catalog_binding" in row["sql"]]
    if kind == "album_top":
        assert len(bindings) == 2 and all(str(row["params"][0]) == top["top_ref"] for row in bindings)
        assert max(prefix.index(row) for row in bindings) < min(prefix.index(row) for row in albums)
        assert any("from app.album_lists" in row["sql"] and "for share" in row["sql"]
            for row in prefix[:prefix.index(bindings[0])])
    else:
        assert bindings == []
        assert not any("app.playlists" in row["sql"] for row in prefix)


@pytest.mark.parametrize("kind", KINDS)
def test_real_typed_source_discovery_and_explicit_country_acquisition(sample_top, monkeypatch, kind):
    db = sample_top.db; grant_refresh(db)
    selected = {"origin": origin(db, kind, sample_top.top)}
    set_genre(db, "Rock", indexes=range(6))
    before = destinations(db), receipt_count(db)
    calls = acquisition(monkeypatch)
    found = db.service.read_sample_facets(db.context(), selected, "most_listened",
        ["styles", "countries"], None)
    assert found["status"] == "ready" and calls == []
    facets = found["data"]["facets"]
    assert facets["styles"]["choices"] == [{"identity": "genre-tag:Rock", "label": "Rock"}]
    assert facets["styles"]["coverage"]["candidate_count"] == (3 if kind == "album_details" else 6)
    assert facets["countries"]["enrichment_targets"]
    assert target(db) in facets["countries"]["enrichment_targets"]
    assert facets["countries"]["choices"] == []
    with sql_probe(monkeypatch, db) as statements:
        result = db.service.enrich_sample_country_metadata(db.context(), selected,
            "most_listened", [target(db)], None, lambda: False)
    assert result == {"status": "ready", "data": {"selection_method": "most_listened",
        "results": [{**target(db), "status": "stored_known"}]}}
    actual = country(db); expected = envelope(db, "GB")
    expected.update({key: actual[key] for key in ("envelope_revision", "captured_at")})
    assert actual == expected and len(calls) == 1
    assert_country_typed_lock_prefix(statements, db, kind, sample_top.top)
    assert (destinations(db), receipt_count(db)) == before


@pytest.mark.parametrize("kind", KINDS)
def test_typed_origin_currentness_is_rechecked_after_network_without_playlist_fallback(sample_top, monkeypatch, kind):
    db = sample_top.db; grant_refresh(db)
    selected = {"origin": origin(db, kind, sample_top.top)}
    old = envelope(db, "FR"); set_country(db, old)
    def network(mbid, *_):
        with db.connect() as con:
            if kind == "album_top":
                con.execute("update app.album_lists set revision=revision+1 where ref=%s",
                    (sample_top.top["top_ref"],))
            else:
                # A non-target candidate changes while target zero's truthful
                # artist and envelope remain unchanged.
                con.execute("delete from library.local_tracks where library_id=%s and id=%s",
                    (db.library, db.tracks[1]))
        return strict_result(mbid, "GB")
    calls = acquisition(monkeypatch, network)
    try:
        result = db.service.enrich_sample_country_metadata(db.context(), selected,
            "most_listened", [target(db)], None, lambda: False)
    except PlaylistError as error:
        expected_error = {"album_top": "revision_conflict", "album_set": "source_changed",
            "album_details": "source_unavailable"}[kind]
        assert error.code == expected_error
    else:
        assert kind != "album_top", "A stale Top must preserve its existing revision error"
        assert result["data"]["results"] == [{**target(db), "status": "source_changed"}]
    assert len(calls) == 1 and country(db) == old


@pytest.mark.parametrize("invalid,constraint_field", [
    ("outside_source", "deployment_allowed"), ("wrong_primary", "deployment_allowed"),
    ("artist_browse", "deployment_allowed"), ("artist_refresh", "deployment_allowed"),
    ("artist_browse", "client_surface_allowed"), ("artist_refresh", "client_surface_allowed"),
    ("artist_browse", "request_origin_allowed"), ("artist_refresh", "request_origin_allowed"),
])
def test_real_initial_mixed_target_admission_rejects_every_target_before_acquisition(
        mix_db, monkeypatch, invalid, constraint_field):
    db = mix_db; grant_refresh(db)
    parent = manual_source(db, (0,) if invalid == "outside_source" else (0, 3))
    old = [envelope(db, "FR"), envelope(db, "DE", index=3)]
    set_country(db, old[0]); set_country(db, old[1], index=3)
    targets = [target(db), target(db, 3)]
    if invalid == "wrong_primary":
        targets[1]["primary_artist_ref"] = target(db)["primary_artist_ref"]
    checked = []; denied_action = BROWSE if invalid == "artist_browse" else REFRESH
    denied_id = str(primary_row(db, 3)["id"])
    def constraints(ctx):
        checked.append(ctx)
        denied = (invalid.startswith("artist_") and ctx.action == denied_action
            and ctx.resource and ctx.resource.resource_kind == "artist"
            and ctx.resource.resource_ref == denied_id)
        return PolicyEvaluationConstraints(**{constraint_field: not denied})
    calls = acquisition(monkeypatch)
    with pytest.raises(PlaylistError, match="source_unavailable") as error:
        enrich(db, parent, deepcopy(targets), constraints=constraints)
    assert error.value.status_code == 404
    assert calls == [] and [country(db), country(db, 3)] == old
    if invalid.startswith("artist_"):
        assert any(ctx.action == denied_action and ctx.resource
            and ctx.resource.resource_kind == "artist"
            and ctx.resource.resource_ref == denied_id for ctx in checked)
