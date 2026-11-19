"""Owner decision 2026-11-08, corrected 2026-11-18: an untouched New Arrivals album whose files
were truly deleted leaves no trace.

Anything the user touched, anything only unreachable, and anything outside New Arrivals stays as
Missing for confirmation. A cover never counts as a touch.
"""
import json
import shutil
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import _finish_live_startup, watcher_repair_inventory  # noqa: F401
from tests.py.test_missing_album_reachability_postgres import _files, _reconcile, _scan

ARRIVALS = "repair-arrivals"
MAIN = "repair-main"


@pytest.fixture
def inventory(watcher_repair_inventory, tmp_path):
    """The watcher repair inventory plus a New Arrivals root, the only source the rule removes from."""
    from music_app.services.library_roots_postgres import PostgresLibraryRootSettingsStore

    fixture = watcher_repair_inventory
    arrivals = {"id": ARRIVALS, "path": str(tmp_path / "New Arrivals"), "category": "new_arrivals_roots"}
    Path(arrivals["path"]).mkdir(parents=True)
    main, hoard = fixture.roots
    PostgresLibraryRootSettingsStore(fixture.config).save_settings({
        "main_library_roots": [main], "hoarding_library_roots": [hoard], "new_arrivals_roots": [arrivals],
    })
    fixture.roots.append(arrivals)  # every later scan observes the New Arrivals root too
    return fixture


def _entry(fixture, relative, *, album, root_id=ARRIVALS):
    if root_id == MAIN:
        return fixture.entry(relative, album=album)
    root = next(root for root in fixture.roots if root["id"] == root_id)
    entry = fixture.entry(relative, album=album)
    Path(entry["path"]).unlink()
    path = Path(root["path"]) / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"media fixture")
    return {**entry, "path": str(path), "mtime": path.stat().st_mtime, "library_root_id": root_id,
            "library_root_category": "new_arrivals"}


def _album(fixture, name, *, root_id=ARRIVALS):
    """Seed one album with one file, then return its ids, key, path and root."""
    entry = _entry(fixture, f"Owner/{name}/01.flac", album=name, root_id=root_id)
    fixture.seed(entry)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        row = connection.execute(
            """select albums.id as album_id, albums.album_key, albums.library_id, tracks.id as track_id,
                      files.id as file_id, owners.account_id
               from library.local_track_files files
               join library.local_tracks tracks on tracks.id = files.track_id
               join library.local_albums albums on albums.id = tracks.album_id
               join library.libraries libraries on libraries.id = albums.library_id
               join app.bootstrap_owners owners on owners.account_id = libraries.owner_account_id
               where files.private_path = %s""",
            (entry["path"],),
        ).fetchone()
    return SimpleNamespace(**row, path=entry["path"], folder=Path(entry["path"]).parent, root_id=root_id)


def _album_exists(fixture, album_key):
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        return connection.execute(
            "select 1 from library.local_albums where album_key = %s", (album_key,)
        ).fetchone() is not None


def _delete_by_watcher(fixture, album):
    shutil.rmtree(album.folder)
    _reconcile(fixture, {})(SimpleNamespace(
        root_id=album.root_id, paths=(), deleted_paths=(), deleted_subtrees=(album.folder,), moves=(),
    ))


def _touched(fixture, album, touch):
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        touch(connection, album)
    _finish_live_startup(fixture.config)


def test_live_untouched_new_arrivals_album_whose_files_were_deleted_is_removed_by_the_watcher(inventory):
    album = _album(inventory, "Added By Mistake")

    _delete_by_watcher(inventory, album)

    assert not _album_exists(inventory, album.album_key)
    assert album.path not in _files(inventory)


def test_live_untouched_new_arrivals_album_whose_files_were_deleted_is_removed_by_a_full_scan(inventory):
    kept = _entry(inventory, "Owner/Stays/01.flac", album="Stays")
    album = _album(inventory, "Scanned By Mistake")
    inventory.seed(kept, _entry(inventory, "Owner/Scanned By Mistake/01.flac", album="Scanned By Mistake"))

    shutil.rmtree(album.folder)
    _scan(inventory, [kept])

    assert not _album_exists(inventory, album.album_key)
    assert _files(inventory)[kept["path"]][:2] == (False, None)


@pytest.mark.parametrize("root_id", [MAIN, "repair-hoard"])
def test_live_an_untouched_album_outside_new_arrivals_stays_missing(inventory, root_id):
    if root_id == MAIN:
        album = _album(inventory, "Main Library Album", root_id=MAIN)
    else:
        entry = inventory.entry("Hoarder/Hoarded/01.flac", root=1, album="Hoarded Album")
        inventory.seed(entry)
        files = _files(inventory)
        album = SimpleNamespace(album_key=files[entry["path"]][2], path=entry["path"],
                                folder=Path(entry["path"]).parent, root_id=root_id)

    _delete_by_watcher(inventory, album)

    assert _album_exists(inventory, album.album_key)
    assert _files(inventory)[album.path][:2] == (True, "deleted")


def _user_rating(c, a):
    c.execute("""insert into app.album_ratings (account_id, library_id, album_key, rating, provenance)
                 values (%s, %s, %s, 8, 'user')""", (a.account_id, a.library_id, a.album_key))


def _track_preference(c, a):
    c.execute("""insert into app.track_preferences (account_id, library_id, track_id, track_key, rating)
                 values (%s, %s, %s, %s, 4)""", (a.account_id, a.library_id, a.track_id, a.path))


def _loop(c, a):
    c.execute("""insert into app.saved_loops (loop_key, track_id, start_seconds, end_seconds)
                 values (%s, %s, 1, 2)""", (uuid4().hex, a.track_id))


def _play(c, a):
    c.execute("""insert into integration.listen_history (track_id, track_key, played_at)
                 values (%s, %s, now())""", (a.track_id, a.path))


def _loved(c, a):
    c.execute("""insert into integration.lastfm_loved_tracks (account_id, track_id, track_key)
                 values (%s, %s, %s)""", (a.account_id, a.track_id, a.path))


def _override(c, a):
    c.execute("""insert into library.exception_overrides (library_id, track_id, track_key, override_payload)
                 values (%s, %s, %s, '{"exception_type": "Interview"}'::jsonb)""",
              (a.library_id, a.track_id, a.path))


def _written_correction(c, a):
    c.execute("""insert into library.local_track_file_text_correction_writes (track_file_id, text_corrections)
                 values (%s, '{"title": "Fixed"}'::jsonb)""", (a.file_id,))


def _tag_edit(c, a):
    c.execute("""insert into library.tag_edit_intents (id, library_root_identity, changes)
                 values (%s, 'watcher-repair', %s::jsonb)""",
              (str(uuid4()), json.dumps([{"path": a.path, "fields": {"title": "Edited"}}])))


def _separate_release(c, a):
    c.execute("insert into library.separate_releases (library_id, release_key) values (%s, %s)",
              (a.library_id, a.album_key))


def _ignored_version(c, a):
    c.execute("insert into library.ignored_versions (library_id, version_key) values (%s, %s)",
              (a.library_id, a.album_key))


def _manual_version(c, a):
    c.execute("insert into library.manual_versions (library_id, child_key, parent_key) values (%s, %s, 'other::album')",
              (a.library_id, a.album_key))


def _ignored_repair(c, a):
    c.execute("insert into library.ignored_repairs (library_id, repair_key) values (%s, %s)",
              (a.library_id, f"{a.album_key}::problem-album::undecoded-characters"))


def _kept_as_missing(c, a):
    c.execute("""update library.local_albums set metadata = metadata || '{"missing_kept_at": "now"}'::jsonb
                 where id = %s""", (a.album_id,))


@pytest.mark.parametrize("touch", [
    _user_rating, _track_preference, _loop, _play, _loved, _override, _written_correction, _tag_edit,
    _separate_release, _ignored_version, _manual_version, _ignored_repair, _kept_as_missing,
], ids=lambda touch: touch.__name__.strip("_"))
def test_live_a_new_arrivals_album_the_user_touched_stays_missing(inventory, touch):
    album = _album(inventory, "Touched Album")
    _touched(inventory, album, touch)

    _delete_by_watcher(inventory, album)

    assert _album_exists(inventory, album.album_key)
    assert _files(inventory)[album.path][:2] == (True, "deleted")


# Owner 2026-11-18: a cover never counts as a touch, wherever it came from.
def _folder_art(c, a):
    c.execute("""update library.local_albums
                 set cover_path = 'folder.jpg', metadata = metadata - 'cover_selection_origin' - 'cover_selection_provenance'
                 where id = %s""", (a.album_id,))


def _automatic_cover(c, a):
    c.execute("""update library.local_albums
                 set cover_path = 'front.jpg', metadata = metadata || '{"cover_selection_origin": "automatic"}'::jsonb
                 where id = %s""", (a.album_id,))


def _cover_picked_in_app(c, a):
    c.execute("""update library.local_albums
                 set cover_path = 'chosen.jpg', metadata = metadata
                   || '{"cover_selection_origin": "user", "cover_selection_provenance": "explicit"}'::jsonb
                 where id = %s""", (a.album_id,))


def _user_cover_displaced_by_repair(c, a):
    c.execute("""update library.local_albums
                 set cover_path = 'repaired.jpg', metadata = metadata
                   || '{"cover_selection_origin": "automatic",
                        "cover_selection_repair_previous": {"cover_path": "chosen.jpg", "cover_selection_origin": "user"}}'::jsonb
                 where id = %s""", (a.album_id,))


@pytest.mark.parametrize("cover", [_folder_art, _automatic_cover, _cover_picked_in_app, _user_cover_displaced_by_repair],
                         ids=lambda cover: cover.__name__.strip("_"))
def test_live_a_new_arrivals_album_with_any_cover_is_removed(inventory, cover):
    album = _album(inventory, "Cover Album")
    _touched(inventory, album, cover)

    _delete_by_watcher(inventory, album)

    assert not _album_exists(inventory, album.album_key)
    assert album.path not in _files(inventory)


def test_live_an_unreachable_untouched_new_arrivals_album_stays_missing(inventory):
    album = _album(inventory, "On A Dropped Drive")
    root = Path(next(root for root in inventory.roots if root["id"] == ARRIVALS)["path"])

    offline = root.with_name(root.name + "-offline")
    root.rename(offline)
    try:
        _reconcile(inventory, {})(SimpleNamespace(
            root_id=ARRIVALS, paths=(), deleted_paths=(), deleted_subtrees=(album.folder,), moves=(),
        ))
    finally:
        offline.rename(root)

    assert _album_exists(inventory, album.album_key)
    assert _files(inventory)[album.path][:2] == (True, "unreachable")


def _loose_track(fixture, name, *, root_id=ARRIVALS):
    """Seed one file with no Album tag (a Loose Track), then return its ids and path."""
    entry = _entry(fixture, f"Owner/Loose/{name}.flac", album="", root_id=root_id)
    fixture.seed(entry)
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        row = connection.execute(
            """select tracks.id as track_id, tracks.album_id, tracks.library_id, files.id as file_id,
                      owners.account_id
               from library.local_track_files files
               join library.local_tracks tracks on tracks.id = files.track_id
               join library.libraries libraries on libraries.id = tracks.library_id
               join app.bootstrap_owners owners on owners.account_id = libraries.owner_account_id
               where files.private_path = %s""",
            (entry["path"],),
        ).fetchone()
    assert row["album_id"] is None, "fixture must be a loose track"
    return SimpleNamespace(**row, path=entry["path"], folder=Path(entry["path"]).parent, root_id=root_id)


def _track_exists(fixture, track_id):
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        return connection.execute("select 1 from library.local_tracks where id = %s", (track_id,)).fetchone() is not None


def _delete_loose_by_watcher(fixture, track):
    Path(track.path).unlink()
    _reconcile(fixture, {})(SimpleNamespace(
        root_id=track.root_id, paths=(), deleted_paths=(Path(track.path),), deleted_subtrees=(), moves=(),
    ))


def test_live_untouched_new_arrivals_loose_track_whose_file_was_deleted_is_removed(inventory):
    track = _loose_track(inventory, "Added By Mistake")

    _delete_loose_by_watcher(inventory, track)

    assert not _track_exists(inventory, track.track_id)
    assert track.path not in _files(inventory)


def test_live_an_untouched_loose_track_outside_new_arrivals_stays_missing(inventory):
    track = _loose_track(inventory, "Main Library Loose", root_id=MAIN)

    _delete_loose_by_watcher(inventory, track)

    assert _track_exists(inventory, track.track_id)
    assert _files(inventory)[track.path][:2] == (True, "deleted")


def test_live_a_loose_track_the_user_rated_stays_missing(inventory):
    track = _loose_track(inventory, "Rated")
    with isolatedPostgres._connect(inventory.setup_url) as connection:
        _track_preference(connection, track)

    _delete_loose_by_watcher(inventory, track)

    assert _track_exists(inventory, track.track_id)
    assert _files(inventory)[track.path][:2] == (True, "deleted")


def test_live_an_unreachable_loose_track_stays_missing(inventory):
    track = _loose_track(inventory, "On A Dropped Drive")
    root = Path(next(root for root in inventory.roots if root["id"] == ARRIVALS)["path"])

    offline = root.with_name(root.name + "-offline")
    root.rename(offline)
    try:
        _reconcile(inventory, {})(SimpleNamespace(
            root_id=ARRIVALS, paths=(), deleted_paths=(Path(track.path),), deleted_subtrees=(), moves=(),
        ))
    finally:
        offline.rename(root)

    assert _track_exists(inventory, track.track_id)
    assert _files(inventory)[track.path][:2] == (True, "unreachable")


def test_live_keep_as_missing_is_recorded_and_keeps_the_album(inventory):
    from music_app.services.missing_album_removal_postgres import PostgresMissingAlbumRemovalService

    album = _album(inventory, "Kept By The User")
    PostgresMissingAlbumRemovalService(inventory.config, connect=isolatedPostgres._connect).keep_missing(album.album_key)

    _delete_by_watcher(inventory, album)

    assert _album_exists(inventory, album.album_key)


def test_live_confirmed_removal_keeps_the_gallery_baseline_for_the_next_watcher_event(inventory):
    """FTC-LIBROOTS-016/018: after the owner removes a missing album, the next deletion still reconciles."""
    from music_app.services.gallery_projection_postgres import ensure_gallery_projection_ready
    from music_app.services.missing_album_removal_postgres import PostgresMissingAlbumRemovalService

    kept = _entry(inventory, "Owner/Main Library Album/01.flac", album="Main Library Album", root_id=MAIN)
    mistake = _entry(inventory, "Owner/Added By Mistake/01.flac", album="Added By Mistake")
    inventory.seed(kept, mistake)
    files = _files(inventory)
    kept_key, mistake_key = files[kept["path"]][2], files[mistake["path"]][2]

    _delete_by_watcher(inventory, SimpleNamespace(folder=Path(kept["path"]).parent, root_id=MAIN))
    assert _files(inventory)[kept["path"]][:2] == (True, "deleted")
    PostgresMissingAlbumRemovalService(
        inventory.config, connect=isolatedPostgres._connect, root_health_check=lambda _root_id: True,
    ).confirm_removal(kept_key)

    # The removal publishes its own journal: nothing pending, every gallery scope current.
    with isolatedPostgres._connect(inventory.setup_url) as connection:
        assert connection.execute(
            "select count(*) as pending from library.local_relation_dirty_albums").fetchone()["pending"] == 0
        generation = connection.execute("select generation from library.gallery_projection_state").fetchone()["generation"]
        assert {row["source_generation"] for row in connection.execute(
            "select source_generation from library.gallery_membership_headers").fetchall()} == {generation}
    # As the route does after a removal.
    ensure_gallery_projection_ready(inventory.config, connect=isolatedPostgres._connect)

    _delete_by_watcher(inventory, SimpleNamespace(folder=Path(mistake["path"]).parent, root_id=ARRIVALS))

    assert not _album_exists(inventory, kept_key)
    assert not _album_exists(inventory, mistake_key)
