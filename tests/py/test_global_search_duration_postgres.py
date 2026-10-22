"""R4-1: preserve real PostgreSQL numeric durations in private Search DTOs.

Use the unchanged guarded disposable-Postgres route/authority fixture. The
runtime role reads actual numeric(12,3) values through the normal psycopg
driver before each HTTP assertion. No result rows, service, or configuration
are substituted. No proposed Search source module is imported directly.

Known values follow the native browse presentation owner: truncate toward zero
and clamp at zero. An actually absent SQL duration remains JSON null under the
nullable Search DTO contract. Fixed expected values prevent a shared broken
conversion from becoming its own test oracle.
"""
from decimal import Decimal

import pytest

from music_app.services.library_browse_postgres import _coerce_duration_seconds
from tests.py.test_global_private_search_postgres import (
    album_ref, assert_sql_bound, assert_tracks, connect, db, isolated_urls,
    track_refs,
)


DURATION_CASES = [
    pytest.param("181", 181, id="whole-numeric"),
    pytest.param("181.125", 181, id="fraction-below-half"),
    pytest.param("181.500", 181, id="fraction-at-half"),
    pytest.param("181.999", 181, id="fraction-above-half"),
    pytest.param("0", 0, id="known-zero"),
    pytest.param("0.999", 0, id="positive-subsecond"),
    pytest.param("-1.125", 0, id="negative-clamped"),
    pytest.param(None, None, id="absent-null"),
]


def _seed_duration_page(db, stored, page_kind, mode):
    # This Artist and every referenced parent belong to this fixture's unique
    # library. The earlier year puts the new album before the fixture's other
    # albums in global Track order, without assuming a database text collation.
    artist = db.albums[db.main_album]["artist"]
    album = db.album(artist, "Duration Album " + db.token, year=1900)
    before = None
    if page_kind == "continuation":
        before = db.track(album, "Duration Leading Witness", number=1)
    target = db.track(album, "Duration Target", number=2,
                      tier="off" if mode == "nonmatching-detail" else "loved")
    after = db.track(album, "Duration Trailing Witness", number=3)
    value = None if stored is None else Decimal(stored)
    with connect(db.setup) as connection:
        updated = connection.execute("""update library.local_tracks
            set duration_seconds=%s
            where library_id=%s and album_id=%s and id=%s returning id""",
            (value, db.library, album, target)).fetchall()
    assert updated == [{"id": target}], "Duration setup must affect exactly its owned Track"

    # This is a separate real application-role read, not a fabricated service
    # result. It proves both the schema and the Python type at the driver edge.
    with connect(db.runtime) as connection:
        schema = connection.execute("""select format_type(atttypid, atttypmod) as sql_type
            from pg_attribute where attrelid='library.local_tracks'::regclass
            and attname='duration_seconds' and not attisdropped""").fetchone()
        observed = connection.execute("""select id, duration_seconds,
            pg_typeof(duration_seconds)::text as sql_type
            from library.local_tracks where library_id=%s and album_id=%s and id=%s""",
            (db.library, album, target)).fetchone()
    assert schema == {"sql_type": "numeric(12,3)"}, "Requires the actual current duration schema"
    assert observed is not None and observed["id"] == target
    assert observed["sql_type"] == "numeric"
    if stored is None:
        assert observed["duration_seconds"] is None
    else:
        assert type(observed["duration_seconds"]) is Decimal
        assert observed["duration_seconds"] == Decimal(stored)
        assert observed["duration_seconds"].as_tuple().exponent == -3
    return album, before, target, after, observed["duration_seconds"]


def _read_target_page(db, album, before, target, mode):
    params = {"search_page_size": "1"}
    if mode == "global-tracks":
        params.update(search_presentation="tracks", all_artists="1", omit_sidebar="1")
    else:
        params["search_detail_album_ref"] = album_ref(db, album)
    first = db.read(":loved", **params)
    assert_sql_bound(db)
    assert first["page"]["has_more"] is True
    assert isinstance(first["page"]["next_cursor"], str) and first["page"]["next_cursor"]
    assert [row["inventory_track_ref"] for row in first["tracks"]] == track_refs(
        db, [before if before is not None else target])
    if before is None:
        return first

    # Do not assert the leading witness's duration first: this must reach the
    # actual continuation target even on the frozen duration-dropping service.
    second = db.read(":loved", search_cursor=first["page"]["next_cursor"], **params)
    assert_sql_bound(db)
    assert [row["inventory_track_ref"] for row in second["tracks"]] == track_refs(db, [target])
    assert second["page"]["has_more"] is True
    assert isinstance(second["page"]["next_cursor"], str) and second["page"]["next_cursor"]
    return second


@pytest.mark.parametrize("stored,expected", DURATION_CASES)
@pytest.mark.parametrize("page_kind", ["initial", "continuation"])
@pytest.mark.parametrize("mode", ["global-tracks", "matching-detail", "nonmatching-detail"])
def test_native_numeric_duration_survives_initial_and_continued_search_dtos(
        db, stored, expected, page_kind, mode):
    album, before, target, after, observed = _seed_duration_page(db, stored, page_kind, mode)
    assert after != target and (before is None or before != target)
    if stored is not None:
        assert _coerce_duration_seconds(observed) == expected, (
            "Fixed duration oracle must still agree with the retained native display owner")

    payload = _read_target_page(db, album, before, target, mode)
    row = payload["tracks"][0]
    assert payload["page"]["returned_count"] == 1
    assert row["title"] == "Duration Target"
    assert row["parent_album"]["album_ref"] == album_ref(db, album)
    assert row["disc_number"] == 1 and row["track_number"] == 2
    assert row["allowed_actions"] == {"can_read": True, "can_select": True}
    if mode == "global-tracks":
        assert_tracks(db, payload, [target])
        assert payload["selection_state"] == "all_artists"
        assert payload["selected_artist"] is None
        assert payload["sidebar"] is None
    else:
        assert payload["presentation"] == "album_detail"
        assert payload["album_ref"] == album_ref(db, album)
        assert row["matches_search"] is (mode == "matching-detail")
        assert row["match_state"] == "known"
        assert set(row) == {"inventory_track_ref", "canonical_track_ref", "title", "artist", "album",
                            "duration_seconds", "disc_number", "track_number", "parent_album",
                            "allowed_actions", "matches_search", "match_state"}

    assert row["duration_seconds"] == expected, (
        "Search must preserve the native displayed duration from real PostgreSQL numeric; "
        f"stored={stored!r}, expected={expected!r}, actual={row['duration_seconds']!r}, "
        f"mode={mode}, page={page_kind}")
    if expected is None:
        assert row["duration_seconds"] is None, "Absent duration must remain JSON null"
    else:
        assert type(row["duration_seconds"]) is int, "Known duration must be an integer, including zero"
