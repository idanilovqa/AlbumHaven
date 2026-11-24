"""The stray-fold decision for a save that hasn't been written yet.

Cards change at the Save click, so the fold is decided from the proposed tag values. It is decided
by the publication's own SQL rule: each case asks for the decision, then runs the real save and
requires the same links.
"""
from __future__ import annotations

from collections import defaultdict

import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import watcher_repair_inventory  # noqa: F401 (live fixture)

TITLES = (("First Song", 205), ("Second Song", 310), ("Third Song", 265))
ACCENTED = "Quiet Séason"
PLAIN = "Quiet Season"


def _album(fixture, folder, album, *, artist="Twin Artist", year=1971, titles=TITLES):
    tracks = []
    for number, (title, duration) in enumerate(titles, start=1):
        entry = fixture.entry(f"{artist}/{folder}/{number:02}.flac", album=album, artist=artist)
        entry.update(album_artist=artist, title=title, track_number=number, duration_seconds=duration, year=year)
        tracks.append(entry)
    return tracks


def _pair(fixture):
    return _album(fixture, "One", PLAIN), _album(fixture, "Two", ACCENTED)


def _retitle_into_a_twin(fixture):
    first, second = _album(fixture, "One", PLAIN), _album(fixture, "Two", "Loud Winter")
    return first + second, second, {"album": ACCENTED}


def _retitle_out_of_a_pair(fixture):
    first, second = _pair(fixture)
    return first + second, second, {"album": "Loud Winter"}


def _rename_the_owner(fixture):
    first, second = _pair(fixture)
    return first + second, first, {"album": "Loud Winter"}


def _change_the_artist_of_a_copy(fixture):
    first, second = _pair(fixture)
    return first + second, second, {"album_artist": "Someone Else"}


def _change_the_year_of_a_copy(fixture):
    first, second = _pair(fixture)
    return first + second, second, {"year": 1999}


def _move_one_track_out_of_a_copy(fixture):
    first, second = _pair(fixture)
    return first + second, second[2:], {"album": "Loud Winter"}


def _retitle_a_single_track_into_a_stray(fixture):
    whole = _album(fixture, "One", PLAIN)
    single = _album(fixture, "Single", "Loose", artist="Guest", titles=TITLES[:1])
    return whole + single, single, {"album": ACCENTED}


def _retitle_a_track_of_a_copy(fixture):
    first, second = _pair(fixture)
    return first + second, second[:1], {"title": "Another Song"}


def _retitle_a_single_track_into_a_stray_of_a_compilation(fixture):
    # A compilation's album has no artist row; its album artist still names it.
    whole = _album(fixture, "One", PLAIN, artist="Various Artists")
    single = _album(fixture, "Single", "Loose", artist="Guest", titles=TITLES[:1])
    return whole + single, single, {"album": ACCENTED}


def _merge_by_exact_tags(fixture):
    first = _album(fixture, "One", PLAIN)
    second = _album(fixture, "Two", "Loud Winter", titles=(("Fourth Song", 190),))
    return first + second, second, {"album": PLAIN}


def _edit_nothing_the_rule_reads(fixture):
    first, second = _pair(fixture)
    return first + second, second, {"artist": "Credited Player"}


EDITS = [
    _retitle_into_a_twin, _retitle_out_of_a_pair, _rename_the_owner, _change_the_artist_of_a_copy,
    _change_the_year_of_a_copy, _move_one_track_out_of_a_copy, _retitle_a_single_track_into_a_stray,
    _retitle_a_track_of_a_copy, _merge_by_exact_tags, _edit_nothing_the_rule_reads,
    _retitle_a_single_track_into_a_stray_of_a_compilation,
]


def _links(fixture):
    """Every album as its tracks' paths, with the album it folds into."""
    with isolatedPostgres._connect(fixture.runtime_url) as connection:
        rows = connection.execute(
            """
            select files.private_path, albums.id,
              (albums.metadata #>> '{stray_duplicate_of,album_id}')::bigint as owner_id
            from library.local_track_files files
            join library.local_tracks tracks on tracks.id = files.track_id
            join library.local_albums albums on albums.id = tracks.album_id
            where files.scan_cache_stale is false
            """
        ).fetchall()
    paths, owners = defaultdict(set), {}
    for row in rows:
        paths[row["id"]].add(row["private_path"])
        owners[row["id"]] = row["owner_id"]
    return {
        frozenset(members): frozenset(paths[owners[album]]) if owners[album] else None
        for album, members in paths.items()
    }


@pytest.mark.parametrize("edit", EDITS, ids=lambda edit: edit.__name__.strip("_"))
def test_live_the_decision_is_the_link_the_save_publishes(watcher_repair_inventory, edit):
    from music_app.services.stray_fold_decision import decide_stray_folds

    fixture = watcher_repair_inventory
    seeded, edited, changes = edit(fixture)
    fixture.seed(*seeded)
    before = _links(fixture)
    previous = {entry["path"]: dict(entry) for entry in edited}
    updated = {path: {**entry, **changes} for path, entry in previous.items()}

    with isolatedPostgres._connect(fixture.runtime_url) as connection:
        # A decision never writes, locks a row or moves a link.
        connection.execute("set transaction read only")
        decision = decide_stray_folds(
            connection, previous_entries=previous, updated_entries=updated, changed_fields=set(changes),
        )
    decided = {
        frozenset(album["track_paths"]): frozenset(album["folds_into"]) if album["folds_into"] else None
        for album in decision["albums"]
    }
    assert _links(fixture) == before

    fixture.adapter.persist_structural_tag_edit(
        changed_paths=set(updated), previous_file_entries=previous, updated_file_entries=updated,
        changed_field_names=set(changes), rebuild_relation_projection=True,
    )
    published = _links(fixture)

    assert decided == {album: published.get(album, "no such album") for album in decided}
    changed = {album for album, owner in published.items() if album not in before or before[album] != owner}
    assert changed <= set(decided), "The save changed an album's fold that the decision left out."


def test_live_the_decision_names_the_inventory_it_was_made_from(watcher_repair_inventory):
    from music_app.services.stray_fold_decision import decide_stray_folds

    fixture = watcher_repair_inventory
    seeded, edited, changes = _retitle_into_a_twin(fixture)
    fixture.seed(*seeded)
    previous = {entry["path"]: dict(entry) for entry in edited}
    updated = {path: {**entry, **changes} for path, entry in previous.items()}

    def decide():
        with isolatedPostgres._connect(fixture.runtime_url) as connection:
            return decide_stray_folds(
                connection, previous_entries=previous, updated_entries=updated, changed_fields=set(changes),
            )["inventory_mutation_revision"]

    made_from = decide()
    assert made_from == decide()
    fixture.adapter.persist_structural_tag_edit(
        changed_paths=set(updated), previous_file_entries=previous, updated_file_entries=updated,
        changed_field_names=set(changes), rebuild_relation_projection=True,
    )
    with isolatedPostgres._connect(fixture.runtime_url) as connection:
        current = connection.execute(
            """select coalesce(nullif(libraries.metadata ->> 'inventory_mutation_revision', '')::bigint, 0) as revision
               from library.libraries libraries
               join app.bootstrap_owners owners on owners.account_id = libraries.owner_account_id
               where owners.owner_key = 'local-bootstrap-owner' and libraries.name = 'Local Library'"""
        ).fetchone()["revision"]
    assert made_from < current, "A decision from before the save must read as stale after it."


def _stored_pair(fixture):
    """Two stored albums sharing a folded title. A seed stores one album for title variants, so retitle one."""
    first, second = _album(fixture, "One", PLAIN), _album(fixture, "Two", "Loud Winter")
    fixture.seed(*first, *second)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("update library.local_albums set title = %s where title = 'Loud Winter'", (ACCENTED,))
        connection.commit()
    return first, [{**entry, "album": ACCENTED} for entry in second]


def _refresh_every_album(fixture):
    from music_app.services.scoped_relation_projection import _refresh_stray_duplicate_ownership

    with isolatedPostgres._connect(fixture.runtime_url) as connection:
        rows = connection.execute("select id, library_id from library.local_albums").fetchall()
        _refresh_stray_duplicate_ownership(connection, rows[0]["library_id"], {row["id"] for row in rows})
        connection.commit()
        return connection.execute(
            """select id, (metadata #>> '{stray_duplicate_of,album_id}')::bigint as owner_id
               from library.local_albums order by id"""
        ).fetchall()


def test_live_an_equal_size_tie_keeps_the_lower_album_id(watcher_repair_inventory):
    _stored_pair(watcher_repair_inventory)

    lower, higher = _refresh_every_album(watcher_repair_inventory)

    assert lower["owner_id"] is None
    assert higher["owner_id"] == lower["id"]


@pytest.mark.parametrize("album_artist, named", [
    ("Various Artists", True), ("Сборник", True), (None, False), ("", False), ("   ", False), ("?!-.", False),
])
def test_live_an_album_without_an_artist_row_folds_only_by_a_named_album_artist(
    watcher_repair_inventory, album_artist, named,
):
    fixture = watcher_repair_inventory
    _stored_pair(fixture)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute(
            """update library.local_albums set artist_id = null,
                 metadata = (metadata - 'stray_duplicate_of' - 'album_artist')
                   || jsonb_strip_nulls(jsonb_build_object('album_artist', %s::text))""",
            (album_artist,),
        )
        connection.commit()

    lower, higher = _refresh_every_album(fixture)

    assert lower["owner_id"] is None
    assert higher["owner_id"] == (lower["id"] if named else None)


def _decide(fixture, edited, changes):
    from music_app.services.stray_fold_decision import decide_stray_folds

    previous = {entry["path"]: dict(entry) for entry in edited}
    updated = {path: {**entry, **changes} for path, entry in previous.items()}
    with isolatedPostgres._connect(fixture.runtime_url) as connection:
        decision = decide_stray_folds(
            connection, previous_entries=previous, updated_entries=updated, changed_fields=set(changes),
        )
    return previous, updated, decision["albums"]


def test_live_040_an_unfolded_card_carries_the_proposed_album_artist(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    pair = _stored_pair(fixture)
    _owner, folded = _refresh_every_album(fixture)  # The seed decides which copy gets the lower id.
    with isolatedPostgres._connect(fixture.runtime_url) as connection:
        folded_paths = {row["private_path"] for row in connection.execute(
            """select files.private_path from library.local_track_files files
               join library.local_tracks tracks on tracks.id = files.track_id
               where tracks.album_id = %s""", (folded["id"],),
        ).fetchall()}
    copy = next(entries for entries in pair if {entry["path"] for entry in entries} == folded_paths)

    _previous, _updated, albums = _decide(fixture, copy, {"album_artist": "Someone Else"})

    card = next(album["card"] for album in albums if set(album["track_paths"]) == folded_paths)
    assert card["album_artist"] == "Someone Else"


def test_live_037_the_album_a_partial_move_leaves_keeps_a_card(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    first, second = _pair(fixture)  # A seed stores the pair as one album: one copy's move leaves the other.
    fixture.seed(*first, *second)

    previous, updated, albums = _decide(fixture, first, {"album": "Loud Winter"})

    remainder = {entry["path"] for entry in second}
    card = next((album["card"] for album in albums if set(album["track_paths"]) == remainder), None)
    assert card, "The album the move leaves has no card to show at the click."
    fixture.adapter.persist_structural_tag_edit(
        changed_paths=set(updated), previous_file_entries=previous, updated_file_entries=updated,
        changed_field_names={"album"}, rebuild_relation_projection=True,
    )
    with isolatedPostgres._connect(fixture.runtime_url) as connection:
        stored = connection.execute(
            """select albums.album_key, albums.title from library.local_albums albums
               join library.local_tracks tracks on tracks.album_id = albums.id
               join library.local_track_files files on files.track_id = tracks.id
               where files.private_path = %s""",
            (second[0]["path"],),
        ).fetchone()
    assert (card["key"], card["name"]) == (stored["album_key"], stored["title"])


@pytest.mark.parametrize("edited_copies", ["both", "one"])
@pytest.mark.parametrize("artist_row", [True, False], ids=["with_artist_row", "without_artist_row"])
@pytest.mark.parametrize("album_artist", ["", "   ", "?!-.", "Сборник"])
def test_live_the_decision_stores_the_proposed_identity_as_the_save_does(
    watcher_repair_inventory, album_artist, artist_row, edited_copies,
):
    # A save always gives the album it writes an artist row, so it folds by that. An album it
    # leaves stored folds by its own row or named album artist.
    fixture = watcher_repair_inventory
    first, second = _stored_pair(fixture)
    if not artist_row:
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            connection.execute(
                """update library.local_albums set artist_id = null,
                     metadata = metadata || jsonb_build_object('album_artist', %s::text)""",
                (album_artist,),
            )
            connection.commit()
    _refresh_every_album(fixture)
    edited = first + second if edited_copies == "both" else second

    previous, updated, albums = _decide(fixture, edited, {"album_artist": album_artist})

    fixture.adapter.persist_structural_tag_edit(
        changed_paths=set(updated), previous_file_entries=previous, updated_file_entries=updated,
        changed_field_names={"album_artist"}, rebuild_relation_projection=True,
    )
    published = _links(fixture)
    decided = {
        frozenset(album["track_paths"]): frozenset(album["folds_into"]) if album["folds_into"] else None
        for album in albums
    }
    assert decided == {album: published.get(album, "no such album") for album in decided}
