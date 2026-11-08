"""Real-Postgres proof that track moves retire the album rows they empty."""

from __future__ import annotations

import pytest

from music_app.services.empty_local_album_retirement import (
    GUARDED_ALBUM_CHILD_TABLES,
    SCAN_OWNED_ALBUM_CHILD_TABLES,
)
from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import watcher_repair_inventory  # noqa: F401


def _edition_entries(fixture, edition):
    return [
        {**fixture.entry(f"Owner/Silent Running/0{number}.flac", album="Silent Running"),
         "track_number": number, "edition": edition}
        for number in (1, 2)
    ]


def _albums(fixture):
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        return connection.execute("""
            select album.id, album.album_key, album.metadata ->> 'edition' as edition,
                   count(track.id) as track_count
            from library.local_albums as album
            left join library.local_tracks as track on track.album_id = album.id
            group by album.id order by album.id
        """).fetchall()


def _seed_edition_album(fixture):
    fixture.seed(*_edition_entries(fixture, "Bonus EP"))
    (source,) = _albums(fixture)
    assert (source["edition"], source["track_count"]) == ("Bonus EP", 2)
    return source


def _assert_moved_to_new_row(fixture, source, *, source_kept):
    albums = _albums(fixture)
    successors = [album for album in albums if album["id"] != source["id"]]
    assert [(album["edition"], album["track_count"]) for album in successors] == [(None, 2)]
    kept = [album for album in albums if album["id"] == source["id"]]
    assert [album["track_count"] for album in kept] == ([0] if source_kept else [])


def test_live_full_scan_edition_change_retires_emptied_album(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    source = _seed_edition_album(fixture)

    fixture.seed(*_edition_entries(fixture, ""))

    _assert_moved_to_new_row(fixture, source, source_kept=False)


def test_live_watcher_retag_retires_emptied_album(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    source = _seed_edition_album(fixture)
    retagged = _edition_entries(fixture, "")

    result = fixture.adapter.persist_targeted_inventory_mutation(
        root_id="repair-main",
        active_file_entries={entry["path"]: entry for entry in retagged},
    )

    _assert_moved_to_new_row(fixture, source, source_kept=False)
    assert source["album_key"] in result["affected_album_keys"]


def test_live_partial_move_keeps_source_album(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    source = _seed_edition_album(fixture)
    first, second = _edition_entries(fixture, "Bonus EP")

    fixture.seed(first, {**second, "edition": ""})

    by_id = {album["id"]: album for album in _albums(fixture)}
    assert by_id[source["id"]]["track_count"] == 1
    assert sorted(album["track_count"] for album in by_id.values()) == [1, 1]


def test_live_missing_album_with_stale_tracks_is_not_retired(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    source = _seed_edition_album(fixture)

    fixture.seed()

    (album,) = _albums(fixture)
    assert (album["id"], album["track_count"]) == (source["id"], 2)


_USER_STATE = {
    "cover_origin": """update library.local_albums set metadata = metadata
        || '{"cover_selection_origin": "user"}' where id = %(album_id)s""",
    "explicit_cover": """update library.local_albums set metadata = metadata
        || '{"cover_selection_provenance": "explicit"}' where id = %(album_id)s""",
    "album_mbid": """update library.local_albums
        set mbid = 'f4eb8346-052d-4a5c-8393-cba3aeadb4d9' where id = %(album_id)s""",
    "mbid_review": """update library.local_albums
        set mbid_assertion_state = 'low_confidence' where id = %(album_id)s""",
    "mbid_assertion": """insert into library.local_mbid_assertions (
        library_id, album_id, target_kind, target_key, evidence_source, mbid_assertion_state)
        values (%(library_id)s, %(album_id)s, 'album', %(album_key)s, 'owner', 'asserted')""",
    "manual_version": """insert into library.manual_versions (library_id, child_key, parent_key)
        values (%(library_id)s, %(album_key)s, 'owner::parent')""",
    "ignored_version": """insert into library.ignored_versions (library_id, version_key)
        values (%(library_id)s, %(album_key)s)""",
    "separate_release": """insert into library.separate_releases (library_id, release_key)
        values (%(library_id)s, %(album_key)s)""",
    "cover_lookup_task": """insert into ops.cover_lookup_tasks (library_id, task_key, status, album_key)
        values (%(library_id)s, 'retirement-guard', 'completed', %(album_key)s)""",
}


def _apply_state(fixture, source, statement):
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        library_id = connection.execute(
            "select library_id from library.local_albums where id = %s", (source["id"],)
        ).fetchone()["library_id"]
        connection.execute(statement, {
            "album_id": source["id"], "album_key": source["album_key"], "library_id": library_id,
        })


@pytest.mark.parametrize("state", sorted(_USER_STATE))
def test_live_emptied_album_with_user_state_is_kept(watcher_repair_inventory, state):
    fixture = watcher_repair_inventory
    source = _seed_edition_album(fixture)
    _apply_state(fixture, source, _USER_STATE[state])

    fixture.seed(*_edition_entries(fixture, ""))

    _assert_moved_to_new_row(fixture, source, source_kept=True)


def _rate(fixture, album_key, rating, provenance):
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("""
            insert into app.album_ratings (account_id, library_id, album_key, rating, provenance)
            select owner.account_id, album.library_id, album.album_key, %s, %s
            from app.bootstrap_owners as owner, library.local_albums as album
            where album.album_key = %s
        """, (rating, provenance, album_key))


def _ratings(fixture):
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        return sorted(
            (row["album_key"], row["rating"], row["provenance"])
            for row in connection.execute(
                "select album_key, rating, provenance from app.album_ratings"
            ).fetchall()
        )


def _successor_key(fixture, source):
    (successor,) = [album for album in _albums(fixture) if album["id"] != source["id"]]
    return successor["album_key"]


@pytest.mark.parametrize("provenance", ["file_tag_scan", "explicit_import"])
def test_live_move_carries_rating_to_successor_before_retiring(watcher_repair_inventory, provenance):
    fixture = watcher_repair_inventory
    source = _seed_edition_album(fixture)
    _rate(fixture, source["album_key"], 8, provenance)

    fixture.seed(*_edition_entries(fixture, ""))

    _assert_moved_to_new_row(fixture, source, source_kept=False)
    assert _ratings(fixture) == [(_successor_key(fixture, source), 8, provenance)]


def _rate_disc(fixture, album_key, disc_key, rating):
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("""
            insert into app.album_disc_ratings (account_id, library_id, album_key, disc_key, rating, provenance)
            select owner.account_id, album.library_id, album.album_key, %s, %s, 'file_tag_scan'
            from app.bootstrap_owners as owner, library.local_albums as album
            where album.album_key = %s
        """, (disc_key, rating, album_key))


def _disc_ratings(fixture):
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        return sorted(
            (row["album_key"], row["disc_key"], row["rating"])
            for row in connection.execute("select album_key, disc_key, rating from app.album_disc_ratings").fetchall()
        )


def test_live_move_carries_disc_ratings_to_successor_before_retiring(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    source = _seed_edition_album(fixture)
    _rate_disc(fixture, source["album_key"], "2", 9)

    fixture.seed(*_edition_entries(fixture, ""))

    _assert_moved_to_new_row(fixture, source, source_kept=False)
    assert _disc_ratings(fixture) == [(_successor_key(fixture, source), "2", 9)]


def test_live_split_move_keeps_disc_rated_emptied_album(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    source = _seed_edition_album(fixture)
    _rate_disc(fixture, source["album_key"], "bonus disc", 6)
    first, second = _edition_entries(fixture, "")

    fixture.seed(first, {**second, "edition": "Live"})

    assert source["id"] in {album["id"] for album in _albums(fixture)}
    assert _disc_ratings(fixture) == [(source["album_key"], "bonus disc", 6)]


def test_live_conflicting_successor_rating_keeps_emptied_album(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    source = _seed_edition_album(fixture)
    first, second = _edition_entries(fixture, "")
    fixture.seed(*_edition_entries(fixture, "Bonus EP")[:1], second)
    successor_key = _successor_key(fixture, source)
    _rate(fixture, source["album_key"], 8, "file_tag_scan")
    _rate(fixture, successor_key, 3, "explicit_import")

    fixture.seed(first, second)

    by_id = {album["id"]: album for album in _albums(fixture)}
    assert by_id[source["id"]]["track_count"] == 0
    assert _ratings(fixture) == sorted([
        (source["album_key"], 8, "file_tag_scan"), (successor_key, 3, "explicit_import"),
    ])


def test_live_split_move_keeps_rated_emptied_album(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    source = _seed_edition_album(fixture)
    _rate(fixture, source["album_key"], 8, "file_tag_scan")
    first, second = _edition_entries(fixture, "")

    fixture.seed(first, {**second, "edition": "Live"})

    by_id = {album["id"]: album for album in _albums(fixture)}
    assert by_id[source["id"]]["track_count"] == 0
    assert sorted(album["track_count"] for album in by_id.values()) == [0, 1, 1]
    assert _ratings(fixture) == [(source["album_key"], 8, "file_tag_scan")]


def test_live_split_move_without_user_state_retires_emptied_album(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    source = _seed_edition_album(fixture)
    first, second = _edition_entries(fixture, "")

    fixture.seed(first, {**second, "edition": "Live"})

    assert source["id"] not in {album["id"] for album in _albums(fixture)}


def test_live_every_album_child_table_is_classified(watcher_repair_inventory):
    with isolatedPostgres._connect(watcher_repair_inventory.setup_url) as connection:
        children = {
            row["child"] for row in connection.execute("""
                select child.relnamespace::regnamespace::text || '.' || child.relname as child
                from pg_constraint
                join pg_class as child on child.oid = pg_constraint.conrelid
                where contype = 'f' and confrelid = 'library.local_albums'::regclass
            """).fetchall()
        }
    assert children == SCAN_OWNED_ALBUM_CHILD_TABLES | GUARDED_ALBUM_CHILD_TABLES
