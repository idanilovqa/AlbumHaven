"""Edits always save, the refusal rows 6.5 ruled into this change (11-23): B2, B3, B4, A11, and one
per-reason check of R1 for A1-A5 and A7-A10.

Owner, 2026-11-22: "Any edits user makes should be saved despite any background indexing or rescanning".
Each row is a way a save could still be refused, hang or be lost while the library is being indexed.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from types import SimpleNamespace

import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import (  # noqa: F401 (live fixture)
    _dedicated_database_urls_or_skip, _drop_application_schemas, _finish_live_startup, watcher_repair_inventory,
)

ARTIST = "Row Artist"
ALBUM = "Row Album"
TITLES = ("First Row Track", "Second Row Track", "Third Row Track")


def _rows(setup_url, sql, params=()):
    with isolatedPostgres._connect(setup_url) as connection:
        cursor = connection.execute(sql, params)
        return cursor.fetchall() if cursor.description is not None else []


# A1-A5 and A7-A10: R1 per reason. Each refusal is raised inside the save's publication; the edit
# commits and its albums are journaled for the owner.

PUBLICATION_REFUSALS = {
    "A1": "Library relation index is not ready. Finish library startup before editing tags.",
    "A2": "Relation compatibility preparation is required before editing tags.",
    "A3": "Relation compatibility evidence changed; explicit preparation is required.",
    "A4": "Library source evidence changed; explicit startup reconciliation is required.",
    "A5": "Library relation index requires startup reconciliation before editing tags.",
    "A7": "Library sources changed during scoped publication; retry reconciliation.",
    "A8": "Library sources changed before gallery publication; retry reconciliation.",
    "A9": "Gallery membership baseline is unavailable; initialize or reconcile it before editing.",
    "A10": "Gallery membership baseline changed during inventory publication.",
}


@pytest.fixture
def saved_album(watcher_repair_inventory, monkeypatch):
    """One three-track album, with the background owners recorded instead of run, so each check
    observes the user's save alone."""
    from music_app.services import gallery_projection_postgres

    fixture = watcher_repair_inventory
    fixture.tracks = [fixture.entry(f"Owner/{ALBUM}/{number:02}.flac", album=ALBUM) for number in (1, 2, 3)]
    fixture.seed(*fixture.tracks)
    monkeypatch.setattr(gallery_projection_postgres, "queue_journaled_relation_drain", lambda _config: None)
    monkeypatch.setattr(gallery_projection_postgres, "schedule_gallery_projection_refresh",
                        lambda _config, **_kwargs: None)
    return fixture


def _rename_album(fixture, title):
    previous = {entry["path"]: dict(entry) for entry in fixture.tracks}
    updated = {path: {**entry, "album": title} for path, entry in previous.items()}
    options = dict(changed_paths=set(previous), previous_file_entries=previous, updated_file_entries=updated,
                   changed_field_names={"album"})
    fixture.adapter.validate_structural_tag_edit(**options)
    fixture.adapter.persist_structural_tag_edit(**options)


@pytest.mark.parametrize("row", sorted(PUBLICATION_REFUSALS), ids=sorted(PUBLICATION_REFUSALS))
def test_live_a_save_commits_and_is_journaled_whatever_its_publication_refuses(saved_album, monkeypatch, row):
    from music_app.services import scoped_relation_projection

    def refuse(*_args, **_kwargs):
        raise RuntimeError(PUBLICATION_REFUSALS[row])

    monkeypatch.setattr(scoped_relation_projection, "publish_affected_relation_projection", refuse)

    _rename_album(saved_album, f"Saved Past {row}")

    titles = {item["title"] for item in _rows(saved_album.setup_url, """
        select distinct albums.title from library.local_albums albums
        join library.local_tracks tracks on tracks.album_id = albums.id""")}
    assert f"Saved Past {row}" in titles, f"{row}'s refusal lost the edit."
    journaled = _rows(saved_album.setup_url,
                      "select count(*) as n from library.local_relation_dirty_albums where album_id > 0")[0]["n"]
    assert journaled >= 1, f"{row}'s refusal left the edit's albums out of the journal."


# A11: a media-field save (title, track number and the like) is published after the files are written.
# A cover or inventory commit between its load and its publication must never lose it.

def test_live_a_media_field_save_commits_while_other_commits_keep_landing(saved_album, monkeypatch):
    from music_app.services import cache
    from music_app.services.scan_cache_persistence import _increment_cover_mutation_revision_sql

    adapter = saved_album.adapter
    path = saved_album.tracks[0]["path"]
    load = adapter.load_file_entries

    def load_then_another_commit_lands(paths):
        entries = load(paths)
        # A cover save commits right after every load, before the save's publication.
        with isolatedPostgres._connect(saved_album.setup_url) as connection:
            connection.execute(_increment_cover_mutation_revision_sql())
        return entries

    monkeypatch.setattr(adapter, "load_file_entries", load_then_another_commit_lands)
    monkeypatch.setattr(cache, "_select_runtime_scan_cache_adapter", lambda _config: adapter)
    changed = {path: {**load({path})[path], "title": "Title Saved Anyway"}}

    cache.save_cache_updates_to_disk_for_config(saved_album.config, changed)

    assert load({path})[path]["title"] == "Title Saved Anyway", "A commit landing mid-save lost the edit."


# B2, B3 and B4 go through the Edit Tags route, as the user's Save does.

def _write_mp3(base_audio, path, *, title, number):
    from mutagen.id3 import ID3, TALB, TDRC, TIT2, TPE1, TPE2, TRCK

    path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(base_audio, path)
    tags = ID3(path)
    for frame, text in ((TALB, ALBUM), (TDRC, "2026"), (TIT2, title), (TPE1, ARTIST), (TPE2, ARTIST),
                        (TRCK, str(number))):
        tags.add(frame(encoding=3, text=[text]))
    tags.save(path)
    stat = path.stat()
    return {"path": str(path), "mtime": stat.st_mtime, "size": stat.st_size, "album": ALBUM,
            "album_artist": ARTIST, "artist": ARTIST, "title": title, "track_number": number, "disc_number": 1,
            "duration_seconds": 1, "year": 2026, "edition": "", "album_rating": 0,
            "library_root_id": "rows-root", "library_root_category": "main_library", "exception_type": None}


@pytest.fixture
def edit_route(monkeypatch, tmp_path):
    """The real app on an isolated database with one three-track mp3 album, after startup."""
    import imageio_ffmpeg

    import config as app_config
    from music_app.services.library_roots_postgres import PostgresLibraryRootSettingsStore
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter
    from tests.py.asgi_testing import create_test_asgi_app

    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)
    _drop_application_schemas(setup_url)
    isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
    try:
        monkeypatch.setenv("ALBUM_HAVEN_APP_DATABASE_URL", runtime_url)
        monkeypatch.setattr(app_config.Config, "ALBUM_HAVEN_APP_DATABASE_URL", runtime_url)
        app = create_test_asgi_app(tmp_path / "rows-asgi", monkeypatch)
        config = app.state.config
        config["ALBUM_HAVEN_APP_DATABASE_URL"] = runtime_url
        music_dir = Path(config["MUSIC_DIR"])
        base_audio = tmp_path / "rows-base.mp3"
        generated = subprocess.run(
            [imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi",
             "-i", "sine=frequency=440:duration=0.05:sample_rate=44100", "-codec:a", "libmp3lame", "-q:a", "9",
             str(base_audio)],
            capture_output=True, text=True, check=False, creationflags=0x08000000 if os.name == "nt" else 0)
        assert generated.returncode == 0, generated.stderr
        entries = {}
        for number, title in enumerate(TITLES, 1):
            path = music_dir / ARTIST / ALBUM / f"{number:02d} {title}.mp3"
            entries[str(path)] = _write_mp3(base_audio, path, title=title, number=number)
        PostgresLibraryRootSettingsStore(config).save_settings({
            "main_library_roots": [{"id": "rows-root", "path": str(music_dir), "layout_mode": "artist"}],
            "hoarding_library_roots": [], "new_arrivals_roots": []})
        PostgresScanCacheAdapter(config, connect=isolatedPostgres._connect).save_snapshot(
            Path("unused-rows.json"), entries, "rows-root-identity", 1.0, observed_library_root_ids={"rows-root"})
        _finish_live_startup(config)
        album = _rows(setup_url, "select id, album_key from library.local_albums where title = %s", (ALBUM,))[0]
        yield SimpleNamespace(app=app, config=config, setup_url=setup_url, runtime_url=runtime_url,
                              music_dir=music_dir, base_audio=base_audio, entries=entries, album=album)
    finally:
        isolatedPostgres.reset_application_tables(setup_url)


def _post_edit(route, updates, *, tracks=None):
    from tests.py.asgi_testing import decode_json, run_asgi_request

    tracks = tracks if tracks is not None else [
        {"path": path, "title": entry["title"]} for path, entry in route.entries.items()]
    began = time.perf_counter()
    status, _headers, body = run_asgi_request(route.app, "POST", "/utilities/edit-tags", json_body={
        "confirmed": True,
        "album": {"album_id": route.album["id"], "key": route.album["album_key"], "name": ALBUM,
                  "album_artist": ARTIST, "year": 2026, "tracks": tracks},
        "updates": updates,
    })
    elapsed = time.perf_counter() - began
    try:
        payload = decode_json(body)
    except ValueError:
        payload = {"raw": body.decode("utf-8", "replace")}
    return status, payload, elapsed


def _file_title(path):
    from mutagen.id3 import ID3

    return str(ID3(path).get("TIT2"))


def _persisted_title(route, path):
    rows = _rows(route.setup_url, "select metadata->>'title' as title from library.local_track_files "
                                  "where private_path = %s", (path,))
    return rows[0]["title"] if rows else None


def _shows_a_local_path(route, payload):
    text = str(payload)
    return any(fragment in text for fragment in (str(route.music_dir), str(route.music_dir).replace("\\", "/"),
                                                  str(Path(route.music_dir).parent)))


# B4: a requested file the inventory doesn't hold at the first lookup.

def test_live_a_save_whose_file_lands_during_an_in_flight_publication_is_saved(edit_route, monkeypatch):
    """A scan's publication is in flight: the first lookup misses the file it is about to publish. The
    save re-resolves after that publication instead of refusing."""
    from music_app.services.library_browse_postgres import PostgresLibraryBrowseRepository

    target = next(iter(edit_route.entries))
    resolve = PostgresLibraryBrowseRepository.build_track_file_entries_by_paths
    lookups = []

    def first_lookup_misses_the_file(self, paths, *args, **kwargs):
        found = resolve(self, paths, *args, **kwargs)
        lookups.append(len(found))
        return {path: entry for path, entry in found.items() if path != target} if len(lookups) == 1 else found

    monkeypatch.setattr(PostgresLibraryBrowseRepository, "build_track_file_entries_by_paths",
                        first_lookup_misses_the_file)

    status, payload, _elapsed = _post_edit(edit_route, {target: {"title": "Saved After Publication"}})

    assert status == 200, f"The save was refused while a publication was in flight: {status} {payload}"
    assert _file_title(target) == "Saved After Publication"
    assert _persisted_title(edit_route, target) == "Saved After Publication"


def test_live_a_save_naming_a_file_that_is_gone_says_which_track_without_its_path(edit_route):
    """A file really gone (deleted between the user's load and Save) is named by its track title, never
    by its local path (AGENTS.md: never expose local music paths)."""
    gone = str(edit_route.music_dir / ARTIST / ALBUM / "04 Gone Row Track.mp3")
    tracks = [{"path": path, "title": entry["title"]} for path, entry in edit_route.entries.items()]
    tracks.append({"path": gone, "title": "Gone Row Track"})

    status, payload, _elapsed = _post_edit(edit_route, {gone: {"title": "Never Written"}}, tracks=tracks)

    assert status >= 400, f"A gone file was reported saved: {status} {payload}"
    assert not _shows_a_local_path(edit_route, payload), f"The refusal shows a local path: {payload}"
    assert "Gone Row Track" in str(payload), f"The refusal doesn't name the gone track: {payload}"


# B3: every request-pool connection is held (publications, browse reads); the save still checks out.

SAVE_BOUND_SECONDS = 10.0


def test_live_a_save_commits_while_every_request_pool_connection_is_held(edit_route):
    from music_app.services.postgres_connections import pooled_connection

    target = next(iter(edit_route.entries))
    holding, release = [], threading.Event()
    ready = threading.Semaphore(0)

    def hold():
        with pooled_connection(edit_route.runtime_url, workload="default") as connection:
            connection.execute("select 1")
            holding.append(1)
            ready.release()
            release.wait(120)

    from music_app.services import postgres_connections

    threads = [threading.Thread(target=hold, daemon=True)
               for _ in range(postgres_connections._DEFAULT_WORKLOAD_MAX_SIZE)]
    for thread in threads:
        thread.start()
    for _ in threads:
        assert ready.acquire(timeout=30), "Could not hold every request-pool connection."
    try:
        status, payload, elapsed = _post_edit(edit_route, {target: {"title": "Saved With The Pool Full"}})
    finally:
        release.set()
        for thread in threads:
            thread.join(30)

    assert status == 200, f"The save failed while the request pool was full: {status} {payload}"
    assert elapsed < SAVE_BOUND_SECONDS, f"The save waited {elapsed:.1f} s for a pool connection."
    assert _persisted_title(edit_route, target) == "Saved With The Pool Full"


# B2: a publication holds the inventory lock (a Full Rescan's or startup build's write). The save never
# hangs: it commits, or fails readably within its ceiling.

LOCK_CEILING_SECONDS = 2.0


def test_live_a_save_never_hangs_behind_a_held_inventory_lock(edit_route):
    from music_app.services.relation_projection_postgres import inventory_publication_advisory_lock_sql

    edit_route.config["EDIT_TAGS_LOCK_WAIT_SECONDS"] = LOCK_CEILING_SECONDS
    target = next(iter(edit_route.entries))
    locked, release = threading.Event(), threading.Event()

    def hold_the_lock():
        with isolatedPostgres._connect(edit_route.runtime_url) as connection:
            connection.execute(inventory_publication_advisory_lock_sql())
            locked.set()
            release.wait(60)

    holder = threading.Thread(target=hold_the_lock, daemon=True)
    holder.start()
    assert locked.wait(30), "Could not take the inventory lock."
    try:
        status, payload, elapsed = _post_edit(edit_route, {target: {"album": "Renamed Behind The Lock"}})
    finally:
        release.set()
        holder.join(30)

    assert elapsed < LOCK_CEILING_SECONDS + 5, f"The save hung {elapsed:.1f} s behind the inventory lock."
    if status != 200:
        assert payload.get("error"), f"The save failed without a readable message: {status} {payload}"
        assert not _shows_a_local_path(edit_route, payload), f"The failure shows a local path: {payload}"
