"""Searching the name a release credits finds its album (0275), without reading every release.

The query's and the index's contract, without a database: the Postgres behaviour is in
test_musicbrainz_credited_search_postgres.py.
"""
from __future__ import annotations

from pathlib import Path

from music_app.services.library_browse_postgres import _search_preview_sql

MIGRATION = (Path(__file__).resolve().parents[2] / "migrations" / "postgres"
             / "0275_index_credited_album_artist_names.sql")
NAME = "lower(btrim(coalesce(artist_credit -> 0 ->> 'name', '')))"
CREDITED_ELSEWHERE = ("jsonb_array_length(artist_credit) = 1"
                      " and artist_credit -> 0 ->> 'name' is distinct from artist_credit -> 0 ->> 'artist_name'")


def test_search_finds_an_album_by_its_releases_credited_name_through_the_index():
    sql = " ".join(_search_preview_sql().split())
    arm = sql[sql.index("credited_album_artist_matches as materialized ("):sql.index("credited_raw_artist_matches as")]

    assert f"{NAME} like lower(%(query_like)s) escape ''" in arm.replace("releases.artist_credit", "artist_credit")
    assert CREDITED_ELSEWHERE in arm.replace("releases.artist_credit", "artist_credit")
    assert "decision.state = 'release'" in arm
    # Through the matching releases to their albums: a union, never an OR that reads every album.
    assert " union select albums.library_id, albums.id" in arm
    assert "jsonb_array_elements" not in arm


def test_0275_indexes_exactly_the_searchs_expression_and_predicate():
    text = MIGRATION.read_text(encoding="utf-8")
    sql = " ".join(text.split()).replace("''", "'")

    assert text.splitlines()[0] == "-- depends on: 0192_create_musicbrainz_album_credits_and_artist_groups.sql"
    assert "create index if not exists musicbrainz_releases_credited_name_trgm_idx" in sql
    assert NAME.replace("''", "'") in sql and CREDITED_ELSEWHERE in sql
    assert not any(word in sql.lower() for word in ("drop ", "alter table", "update ", "delete from"))
