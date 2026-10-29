"""Scoped live regressions for retained dates and subtree publication locks."""

from pathlib import Path
from threading import Event, Thread
from types import SimpleNamespace

import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import watcher_repair_inventory


@pytest.mark.parametrize("mutation", ["delete_first", "refresh_other"])
@pytest.mark.parametrize("explicit_date", [False, True])
def test_targeted_release_year_matches_complete_surviving_members(watcher_repair_inventory, mutation, explicit_date):
    from music_app.services.library import build_albums_from_file_cache

    fixture = watcher_repair_inventory
    first = {**fixture.entry("Owner/A/song.flac"), "year": 2000}
    other_root = 1 if mutation == "delete_first" else 0
    other = {**fixture.entry("Owner/Z/song.flac", root=other_root), "year": 2001}
    fixture.seed(first, other)
    if explicit_date:
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            connection.execute("""update library.local_albums album set release_year=2004,
                metadata=album.metadata || '{"release_date":"2004-07-16"}'::jsonb
                from library.local_tracks track
                join library.local_track_files file on file.track_id=track.id
                where album.id=track.album_id and file.private_path=%s""", (other["path"],))
    if mutation == "delete_first":
        Path(first["path"]).unlink()
        complete = {other["path"]: other}
        fixture.adapter.persist_targeted_inventory_mutation(
            root_id=fixture.roots[0]["id"], active_file_entries={}, deleted_paths=(first["path"],),
        )
    else:
        replacement = {**other, "year": 2003}
        complete = {first["path"]: first, other["path"]: replacement}
        fixture.adapter.persist_targeted_inventory_mutation(
            root_id=fixture.roots[other_root]["id"], active_file_entries={other["path"]: replacement},
        )
    expected_year = 2004 if explicit_date else build_albums_from_file_cache(complete, set())[0].year
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        album = connection.execute(
            """
            select album.release_year, album.metadata
            from library.local_track_files file
            join library.local_tracks track on track.id = file.track_id
            join library.local_albums album on album.id = track.album_id
            where file.private_path = %s and file.scan_cache_stale is false
            """,
            (other["path"],),
        ).fetchone()
    assert album["release_year"] == expected_year
    if explicit_date:
        assert album["metadata"]["release_date"] == "2004-07-16"


def test_targeted_second_year_adopts_base_album_without_reversing_the_year_key(
    watcher_repair_inventory,
):
    fixture = watcher_repair_inventory
    original = {**fixture.entry("Owner/Original/song.flac"), "year": 2001}
    reissue = {**fixture.entry("Owner/Reissue/song.flac"), "year": 2002}
    fixture.seed(original)
    selected_cover = str(Path(original["path"]).with_name("selected-cover.jpg"))

    with isolatedPostgres._connect(fixture.setup_url) as connection:
        original_album = connection.execute(
            """
            update library.local_albums
            set cover_path = %s,
                metadata = metadata ||
                    '{"cover_selection_origin":"user","fixture_state":"preserved"}'::jsonb
            where album_key = 'owner::repair album'
            returning id
            """,
            (selected_cover,),
        ).fetchone()

    fixture.adapter.persist_targeted_inventory_mutation(
        root_id=fixture.roots[0]["id"],
        active_file_entries={reissue["path"]: reissue},
    )

    with isolatedPostgres._connect(fixture.setup_url) as connection:
        split_albums = connection.execute(
            """
            select id, album_key, cover_path, metadata
            from library.local_albums
            where title = 'Repair Album'
            order by album_key
            """
        ).fetchall()

    assert [row["album_key"] for row in split_albums] == [
        "owner::repair album::year::2001",
        "owner::repair album::year::2002",
    ]
    adopted_original = split_albums[0]
    assert adopted_original["id"] == original_album["id"]
    assert adopted_original["cover_path"] == selected_cover
    assert adopted_original["metadata"]["fixture_state"] == "preserved"

    Path(reissue["path"]).unlink()
    fixture.adapter.persist_targeted_inventory_mutation(
        root_id=fixture.roots[0]["id"],
        active_file_entries={},
        deleted_paths=(reissue["path"],),
    )
    fixture.adapter.persist_targeted_inventory_mutation(
        root_id=fixture.roots[0]["id"],
        active_file_entries={original["path"]: original},
    )

    with isolatedPostgres._connect(fixture.setup_url) as connection:
        active_album_keys = connection.execute(
            """
            select distinct album.album_key
            from library.local_albums as album
            join library.local_tracks as track on track.album_id = album.id
            join library.local_track_files as file on file.track_id = track.id
            where album.title = 'Repair Album'
              and file.scan_cache_stale is false
            order by album.album_key
            """
        ).fetchall()

    assert [row["album_key"] for row in active_album_keys] == [
        "owner::repair album::year::2001"
    ]


@pytest.mark.parametrize("operation", ["rename", "split", "merge"])
def test_album_only_edit_preserves_full_display_date_with_different_raw_year(watcher_repair_inventory, operation):
    fixture = watcher_repair_inventory
    selected = {**fixture.entry("Owner/A/one.flac"), "year": 2000}
    sibling = {**fixture.entry("Owner/Z/two.flac", root=1), "year": 2000}
    destination = {**fixture.entry("Owner/Destination/three.flac", album="Renamed"), "year": 2000} if operation == "merge" else None
    fixture.seed(selected, sibling, *([destination] if destination else []))
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        connection.execute("""update library.local_albums set release_year=2004,
            metadata=metadata || '{"release_date":"2004-07-16"}'::jsonb
            where album_key='owner::repair album'""")
        if destination:
            connection.execute("""update library.local_albums set release_year=2010,
                metadata=metadata || '{"release_date":"2010-09-17"}'::jsonb where title='Renamed'""")
    previous = {entry["path"]: entry for entry in (selected, sibling)}
    changed = {selected["path"]} if operation == "split" else set(previous)
    updated = {path: {**entry, **({"album": "Renamed"} if path in changed else {})} for path, entry in previous.items()}
    result = fixture.adapter.persist_structural_tag_edit(
        changed_paths=changed, previous_file_entries=previous,
        updated_file_entries=updated, changed_field_names={"album"},
    )
    assert result["track_file_rows_updated"] == len(changed)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        albums = connection.execute("""select title, release_year, metadata from library.local_albums album
            where exists (select 1 from library.local_tracks track join library.local_track_files file on file.track_id=track.id
                          where track.album_id=album.id and file.scan_cache_stale is false)
            order by title""").fetchall()
        raw_years = connection.execute("select metadata #>> '{scan_cache,file_entry,year}' as year from library.local_track_files").fetchall()
    assert {album["title"] for album in albums} == ({"Repair Album", "Renamed"} if operation == "split" else {"Renamed"})
    assert all(album["release_year"] == (2010 if operation == "merge" else 2004) for album in albums)
    assert [album["metadata"]["release_date"] for album in albums] == (["2010-09-17"] if operation == "merge" else ["2004-07-16"] * len(albums))
    assert {row["year"] for row in raw_years} == {"2000"}


@pytest.mark.parametrize("move", [False, True])
@pytest.mark.parametrize("stale", [False, True])
def test_subtree_reconciliation_reserves_persisted_descendants_before_publication(watcher_repair_inventory, move, stale):
    from music_app.services.save_tasks import StructuralTagEditReservationManager, structural_tag_edit_resource_keys
    from music_app.services.targeted_library_reconciliation import TargetedLibraryReconciler

    fixture = watcher_repair_inventory
    first = fixture.entry("Owner/Source/song.flac")
    nested = fixture.entry("Owner/Source/Disc 2/song.flac")
    collision = fixture.entry("Owner/Source-other/song.flac", album="Outside")
    other_root = fixture.entry("Owner/Source/song.flac", root=1, album="Other Root")
    fixture.seed(first, nested, collision, other_root)
    if stale:
        fixture.adapter.persist_targeted_inventory_mutation(
            root_id=fixture.roots[0]["id"], active_file_entries={}, deleted_paths=(first["path"], nested["path"]),
        )
    source = Path(first["path"]).parent
    destination = source.with_name("Moved")
    destination.mkdir()
    Path(first["path"]).unlink()
    Path(nested["path"]).unlink()
    manager = StructuralTagEditReservationManager()
    blocked_keys = structural_tag_edit_resource_keys(None, {first["path"], nested["path"]})
    editor = manager.acquire(blocked_keys)
    attempted = Event()
    finished = Event()
    requested_keys = []
    failures = []
    results = []

    def acquire(keys):
        requested_keys.append(keys)
        attempted.set()
        return manager.acquire(keys)

    reconciler = TargetedLibraryReconciler(
        {"SUPPORTED_EXTENSIONS": {".flac"}}, repository=fixture.adapter,
        root_definitions=fixture.roots, reservation_acquirer=acquire,
        metadata_reader=lambda _path: pytest.fail("deleted source must never be read"),
    )
    request = SimpleNamespace(
        root_id=fixture.roots[0]["id"], paths=(), deleted_paths=(),
        deleted_subtrees=() if move else (source,),
        moves=(SimpleNamespace(source=source, destination=destination, is_directory=True,
                               source_root_id=fixture.roots[0]["id"], destination_root_id=fixture.roots[0]["id"]),) if move else (),
    )

    def reconcile():
        try:
            results.append(reconciler.reconcile(request))
        except BaseException as exc:
            failures.append(exc)
        finally:
            finished.set()

    worker = Thread(target=reconcile, name="scoped-subtree-publication")
    worker.start()
    try:
        assert attempted.wait(1), "deletion-only subtree must acquire descendant reservations"
        assert blocked_keys <= requested_keys[0]
        assert not structural_tag_edit_resource_keys(None, {collision["path"], other_root["path"]}) & requested_keys[0]
        assert not finished.wait(0.05), "publication must wait for an existing descendant tag writer"
    finally:
        editor.release()
        worker.join(3)
        assert not worker.is_alive()
    assert failures == []
    assert results[0].health == "healthy"
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        active_paths = {row["private_path"] for row in connection.execute("select private_path from library.local_track_files where scan_cache_stale is false").fetchall()}
    assert active_paths == {collision["path"], other_root["path"]}
