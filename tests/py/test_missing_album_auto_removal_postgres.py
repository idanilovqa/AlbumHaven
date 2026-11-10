"""Owner decision 2026-11-08: untouched albums whose files were truly deleted leave no trace.

Anything the user touched, or anything only unreachable, stays as Missing for confirmation.
"""
import json
import shutil
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import watcher_repair_inventory  # noqa: F401 (fixture)
from tests.py.test_missing_album_reachability_postgres import _files, _reconcile, _scan


def _album(fixture, name):
    """Seed one album with one file, then return its ids, key and path."""
    entry = fixture.entry(f"Owner/{name}/01.flac", album=name)
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
    return SimpleNamespace(**row, path=entry["path"], folder=Path(entry["path"]).parent)


def _album_exists(fixture, album_key):
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        return connection.execute(
            "select 1 from library.local_albums where album_key = %s", (album_key,)
        ).fetchone() is not None


def _delete_by_watcher(fixture, album):
    shutil.rmtree(album.folder)
    _reconcile(fixture, {})(SimpleNamespace(
        root_id="repair-main", paths=(), deleted_paths=(), deleted_subtrees=(album.folder,), moves=(),
    ))


def test_live_untouched_album_whose_files_were_deleted_is_removed_by_the_watcher(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    album = _album(fixture, "Added By Mistake")

    _delete_by_watcher(fixture, album)

    assert not _album_exists(fixture, album.album_key)
    assert album.path not in _files(fixture)


def test_live_untouched_album_whose_files_were_deleted_is_removed_by_a_full_scan(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    kept = fixture.entry("Owner/Stays/01.flac", album="Stays")
    album = _album(fixture, "Scanned By Mistake")
    fixture.seed(kept, {**fixture.entry("Owner/Scanned By Mistake/01.flac", album="Scanned By Mistake")})

    shutil.rmtree(album.folder)
    _scan(fixture, [kept])

    assert not _album_exists(fixture, album.album_key)
    assert _files(fixture)[kept["path"]][:2] == (False, None)


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


def _cover_choice(c, a):
    c.execute("""update library.local_albums set metadata = metadata || '{"cover_selection_origin": "user"}'::jsonb
                 where id = %s""", (a.album_id,))


def _cover_of_unknown_origin(c, a):
    c.execute("""update library.local_albums
                 set cover_path = 'legacy-cover.jpg', metadata = metadata - 'cover_selection_origin'
                 where id = %s""", (a.album_id,))


def _kept_as_missing(c, a):
    c.execute("""update library.local_albums set metadata = metadata || '{"missing_kept_at": "now"}'::jsonb
                 where id = %s""", (a.album_id,))


@pytest.mark.parametrize("touch", [
    _user_rating, _track_preference, _loop, _play, _loved, _override, _written_correction, _tag_edit,
    _separate_release, _ignored_version, _manual_version, _ignored_repair, _cover_choice,
    _cover_of_unknown_origin, _kept_as_missing,
], ids=lambda touch: touch.__name__.strip("_"))
def test_live_an_album_the_user_touched_stays_missing(watcher_repair_inventory, touch):
    fixture = watcher_repair_inventory
    album = _album(fixture, "Touched Album")
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        touch(connection, album)
    from tests.py.test_isolated_postgres_live import _finish_live_startup
    _finish_live_startup(fixture.config)

    _delete_by_watcher(fixture, album)

    assert _album_exists(fixture, album.album_key)
    assert _files(fixture)[album.path][:2] == (True, "deleted")


def test_live_an_unreachable_untouched_album_stays_missing(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    album = _album(fixture, "On A Dropped Drive")
    root = Path(fixture.roots[0]["path"])

    offline = root.with_name(root.name + "-offline")
    root.rename(offline)
    try:
        _reconcile(fixture, {})(SimpleNamespace(
            root_id="repair-main", paths=(), deleted_paths=(), deleted_subtrees=(album.folder,), moves=(),
        ))
    finally:
        offline.rename(root)

    assert _album_exists(fixture, album.album_key)
    assert _files(fixture)[album.path][:2] == (True, "unreachable")


def _loose_track(fixture, name):
    """Seed one file with no Album tag (a Loose Track), then return its ids and path."""
    entry = fixture.entry(f"Owner/Loose/{name}.flac", album="")
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
    return SimpleNamespace(**row, path=entry["path"], folder=Path(entry["path"]).parent)


def _track_exists(fixture, track_id):
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        return connection.execute("select 1 from library.local_tracks where id = %s", (track_id,)).fetchone() is not None


def _delete_loose_by_watcher(fixture, track):
    Path(track.path).unlink()
    _reconcile(fixture, {})(SimpleNamespace(
        root_id="repair-main", paths=(), deleted_paths=(Path(track.path),), deleted_subtrees=(), moves=(),
    ))


def test_live_untouched_loose_track_whose_file_was_deleted_is_removed(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    track = _loose_track(fixture, "Added By Mistake")

    _delete_loose_by_watcher(fixture, track)

    assert not _track_exists(fixture, track.track_id)
    assert track.path not in _files(fixture)


def test_live_a_loose_track_the_user_rated_stays_missing(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    track = _loose_track(fixture, "Rated")
    with isolatedPostgres._connect(fixture.setup_url) as connection:
        _track_preference(connection, track)

    _delete_loose_by_watcher(fixture, track)

    assert _track_exists(fixture, track.track_id)
    assert _files(fixture)[track.path][:2] == (True, "deleted")


def test_live_an_unreachable_loose_track_stays_missing(watcher_repair_inventory):
    fixture = watcher_repair_inventory
    track = _loose_track(fixture, "On A Dropped Drive")
    root = Path(fixture.roots[0]["path"])

    offline = root.with_name(root.name + "-offline")
    root.rename(offline)
    try:
        _reconcile(fixture, {})(SimpleNamespace(
            root_id="repair-main", paths=(), deleted_paths=(Path(track.path),), deleted_subtrees=(), moves=(),
        ))
    finally:
        offline.rename(root)

    assert _track_exists(fixture, track.track_id)
    assert _files(fixture)[track.path][:2] == (True, "unreachable")


def test_live_keep_as_missing_is_recorded_and_keeps_the_album(watcher_repair_inventory):
    from music_app.services.missing_album_removal_postgres import PostgresMissingAlbumRemovalService

    fixture = watcher_repair_inventory
    album = _album(fixture, "Kept By The User")
    PostgresMissingAlbumRemovalService(fixture.config, connect=isolatedPostgres._connect).keep_missing(album.album_key)

    _delete_by_watcher(fixture, album)

    assert _album_exists(fixture, album.album_key)
