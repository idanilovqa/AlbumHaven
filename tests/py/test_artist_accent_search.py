import os
from pathlib import Path
from uuid import uuid4

import pytest

from music_app.services.library_browse_postgres import (
    _artist_name_matches_search_query,
    _missing_album_search_artist_keys,
    _search_preview_sql,
)
from music_app.services.view_search import artist_match_rank, fold_search_accents, normalize_search_text
from tests.e2e.support import isolatedPostgres


@pytest.mark.parametrize("query,artist", [
    ("Onsegen", "Onségen Ensemble"),
    ("Onségen", "Onsegen Ensemble"),
    ("Onse\u0301gen", "Onsegen Ensemble"),
    ("Zoe", "Zoë"),
    ("Andre Rene", "André René"),
])
def test_artist_search_folds_accents_without_fuzzy_distance(query, artist):
    assert _artist_name_matches_search_query(query, artist, [])
    assert artist_match_rank(query, artist, set())[0] <= 1
    assert not _artist_name_matches_search_query(query, "Unrelated Orchestra", [])


def test_artist_alias_eligibility_folds_accents_but_preserves_identity_keys():
    assert _missing_album_search_artist_keys("Onsegen", {}, {"Onségen": ["Onségen Ensemble"]}) == [
        "onségen", "onségen ensemble",
    ]
    assert normalize_search_text("Й Ё") == "й ё"
    assert fold_search_accents("Й Ё") == "й ё"
    assert fold_search_accents("Й Ё") != fold_search_accents("И Е")
    assert normalize_search_text("Onse\u0301gen") == normalize_search_text("Onségen")
    assert artist_match_rank("Onségen", "Onségen", set()) < artist_match_rank("Onségen", "Onsegen", set())
    assert artist_match_rank("Onsegen", "Onsegen", set()) < artist_match_rank("Onsegen", "Onségen", set())


def test_sql_artist_eligibility_uses_indexed_folded_names():
    sql = _search_preview_sql()
    for expression in (
        "library.local_artists.name",
        "library.local_albums.metadata ->> 'album_artist'",
        "library.local_albums.metadata ->> 'artists'",
        "search_raw_artist.name",
    ):
        assert f"library.fold_search_accents({expression})" in sql
    assert "like library.fold_search_accents(%(query_like)s)" in sql


def test_artist_accent_migration_is_additive_and_indexed():
    sql = (Path(__file__).resolve().parents[2] / "migrations/postgres/0106_index_accent_insensitive_artist_search.sql").read_text(encoding="utf-8")
    assert "immutable" in sql
    assert 'collate "und-x-icu"' in sql
    assert "then 'casefold' else 'lower'" in sql
    assert "set search_path = pg_catalog" in sql
    for name in ("local_artists_name_accent_trgm_idx", "local_albums_album_artist_accent_trgm_idx", "local_albums_artists_accent_trgm_idx"):
        assert name in sql
    assert "update library." not in sql.lower()


def test_live_artist_accent_search_uses_index_and_matches_python_folding():
    if not os.environ.get(isolatedPostgres.SETUP_DATABASE_ENV):
        pytest.skip("Dedicated isolated Postgres URLs are not configured.")
    setup_url, runtime_url = isolatedPostgres.resolve_isolated_database_urls()
    isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
    prefix = f"accent-search-{uuid4()}"
    with isolatedPostgres._connect(setup_url) as connection:
        isolatedPostgres._assert_connected_role(connection, isolatedPostgres.SETUP_ROLE)
        with connection.transaction(force_rollback=True):
            values = ("Onségen", "Onse\u0301gen", "André René", "Й Ё", "И Е", "ЖИЗНЬ", "İpek", "  André  René  ")
            if connection.info.server_version >= 180000:
                values += ("Straße", "Σ σ ς", "ﬃ")
            for value in values:
                row = connection.execute("select library.fold_search_accents(%s) as folded", (value,)).fetchone()
                assert row["folded"] == fold_search_accents(value)
            library_id = connection.execute(
                "select libraries.id from app.bootstrap_owners owners join library.libraries libraries "
                "on libraries.owner_account_id=owners.account_id and libraries.name='Local Library' "
                "and libraries.library_kind='local' where owners.owner_key='local-bootstrap-owner'",
            ).fetchone()["id"]
            connection.execute(
                "insert into library.local_artists (library_id,artist_key,name) "
                "select %s,%s || number::text,'Unrelated Orchestra ' || number::text "
                "from generate_series(1,4000) number", (library_id, prefix),
            )
            for suffix, name in (("accented", "Onségen Ensemble"), ("plain", "Onsegen Ensemble")):
                connection.execute(
                    "insert into library.local_artists (library_id,artist_key,name) values (%s,%s,%s)",
                    (library_id, prefix + suffix, name),
                )
            connection.execute("analyze library.local_artists")
            sql = (
                "select name from library.local_artists where "
                "library.fold_search_accents(name) like library.fold_search_accents(%s)"
            )
            for query in ("%Onsegen%", "%Onségen%", "%Onse\u0301gen%"):
                names = {row["name"] for row in connection.execute(sql, (query,)).fetchall()}
                assert {"Onségen Ensemble", "Onsegen Ensemble"} <= names
                assert not any(name.startswith("Unrelated Orchestra") for name in names)
                plan = connection.execute("explain (analyze, format json) " + sql, (query,)).fetchone()["QUERY PLAN"][0]["Plan"]
                nodes = [plan]
                for node in nodes:
                    nodes.extend(node.get("Plans", []))
                assert any(node.get("Index Name") == "local_artists_name_accent_trgm_idx" for node in nodes), plan
