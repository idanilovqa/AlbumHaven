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
