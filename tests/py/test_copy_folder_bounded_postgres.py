"""Bounded reads of the copy-folder and multi-album-folder work, on a throwaway database (6.5, 2026-11-24).

One synthetic library is seeded at two sizes (20 and 200 unrelated albums): three albums in their own folders,
a folder of copies of their songs, a real multi-album folder (two complete albums alone) and a folder of two
partial albums. The real app answers Album Details and Problematic Files; each added read is counted and must
not grow with the library, and the query plans must reach their indexes."""
import contextlib
import json
from pathlib import Path

import psycopg
import pytest

from tests.e2e.support import isolatedPostgres
from tests.py.test_isolated_postgres_live import (
    _dedicated_database_urls_or_skip,
    _drop_application_schemas,
    _finish_live_startup,
)

SIZES = (20, 200)
ALBUMS = ("Album One", "Album Two", "Album Three")
MIXED = "Mixed album metadata in one folder"


def _entry(music_dir, relative, album, title, number, duration=180):
    path = Path(music_dir) / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"media fixture")
    return {"path": str(path), "mtime": path.stat().st_mtime, "size": path.stat().st_size, "album": album,
            "album_artist": "Owner", "artist": "Owner", "title": title, "track_number": number, "disc_number": 1,
            "duration_seconds": duration, "year": 2026, "edition": "", "album_rating": 0,
            "library_root_id": "copy-main", "library_root_category": "main_library", "exception_type": None}


def _library(music_dir, unrelated):
    entries = []
    for index, album in enumerate(ALBUMS, start=1):
        for number in (1, 2, 3):
            entries.append(_entry(music_dir, f"Owner/{album}/{number:02d}.flac", album, f"{album} song {number}",
                                  number, 170 + index * 10 + number))
        for number in (1, 2):
            entries.append(_entry(music_dir, f"Owner/Copied songs/{index}-{number:02d}.flac", album,
                                  f"{album} song {number}", number, 170 + index * 10 + number))
    for album in ("Fourth Album", "Fifth Album"):
        for number in (1, 2):
            entries.append(_entry(music_dir, f"Owner/Shared/{album[:5]}-{number:02d}.flac", album, f"{album} {number}", number))
    entries.append(_entry(music_dir, "Owner/Partial/06-05.flac", "Sixth Album", "Sixth 5", 5))
    for number in (6, 7):
        entries.append(_entry(music_dir, f"Owner/Partial/07-{number:02d}.flac", "Seventh Album", f"Seventh {number}", number))
    for index in range(unrelated):
        entries.append(_entry(music_dir, f"Other {index:05d}/Album {index:05d}/01.flac", f"Album {index:05d}", "Song", 1))
    return {entry["path"]: entry for entry in entries}


@pytest.fixture
def seeded_app(monkeypatch, tmp_path):
    import config as app_config
    from music_app.services.library_roots_postgres import PostgresLibraryRootSettingsStore
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter
    from tests.py.asgi_testing import create_test_asgi_app

    setup_url, runtime_url = _dedicated_database_urls_or_skip(monkeypatch)

    def seed(unrelated):
        _drop_application_schemas(setup_url)
        isolatedPostgres.prepare_isolated_database(setup_url, runtime_url)
        monkeypatch.setenv("ALBUM_HAVEN_APP_DATABASE_URL", runtime_url)
        monkeypatch.setattr(app_config.Config, "ALBUM_HAVEN_APP_DATABASE_URL", runtime_url)
        app = create_test_asgi_app(tmp_path / f"app-{unrelated}", monkeypatch)
        config = app.state.config
        config["ALBUM_HAVEN_APP_DATABASE_URL"] = runtime_url
        music_dir = Path(config["MUSIC_DIR"])
        PostgresLibraryRootSettingsStore(config).save_settings({
            "main_library_roots": [{"id": "copy-main", "path": str(music_dir), "layout_mode": "artist"}],
            "hoarding_library_roots": [], "new_arrivals_roots": []})
        PostgresScanCacheAdapter(config, connect=isolatedPostgres._connect).save_snapshot(
            Path("unused-copy-folder.json"), _library(music_dir, unrelated), "copy-root-identity", 1.0,
            observed_library_root_ids={"copy-main"})
        _finish_live_startup(config)
        return app, music_dir

    try:
        yield seed, setup_url
    finally:
        isolatedPostgres.reset_application_tables(setup_url)


@contextlib.contextmanager
def _counted(sql_text):
    """Every execution of one statement through the app's connections, with the rows it returned."""
    seen = []
    original = psycopg.Connection.execute

    def execute(self, query, params=None, *args, **kwargs):
        cursor = original(self, query, params, *args, **kwargs)
        if query == sql_text:
            seen.append(cursor.rowcount)
        return cursor

    psycopg.Connection.execute = execute
    try:
        yield seen
    finally:
        psycopg.Connection.execute = original


def _candidate_sql(browse):
    return browse._CANDIDATE_FOLDER_FILES_SQL.replace(
        "__SEED_PARENT__", browse._physical_parent_sql("seed.private_path"),
    ).replace("__FILE_PARENT__", browse._physical_parent_sql("files.private_path"))


def _plan(setup_url, sql, params, *, seqscan=True):
    """The query plan, with the default planner unless seqscan=False (a structural proof only)."""
    with isolatedPostgres._connect(setup_url) as connection:
        connection.execute("analyze library.local_track_files")
        connection.execute("analyze library.local_tracks")
        if not seqscan:
            connection.execute("set enable_seqscan = off")
        row = connection.execute("explain (format json) " + sql, params).fetchone()
    return json.dumps(row[0] if not hasattr(row, "keys") else list(row.values())[0])


def test_live_copy_folder_reads_stay_flat_at_two_library_sizes(seeded_app):
    from music_app.services import library_browse_postgres as browse
    from music_app.services.album_local_membership import local_album_membership_ctes_sql
    from tests.py.asgi_testing import decode_json, run_asgi_request

    seed, setup_url = seeded_app
    measured = {}
    for unrelated in SIZES:
        app, music_dir = seed(unrelated)
        with isolatedPostgres._connect(setup_url) as connection:
            keys = {row["title"]: row["album_key"] for row in connection.execute(
                "select title, album_key from library.local_albums").fetchall()}

        # B: Album Details reads the opened album's copies in one statement.
        with _counted(browse._OUTSIDE_COPIES_SQL) as copy_reads:
            status, _headers, body = run_asgi_request(app, "GET", "/album-details", query={"album_key": keys["Album One"]})
        assert status == 200, body
        tracks = decode_json(body)["album"]["tracks"]
        marked = sorted(track["title"] for track in tracks if track.get("problem_track_path"))
        assert marked == ["Album One song 1", "Album One song 2"]

        # A: Album Details' own membership classification reads the album and its folders only.
        twin_sql = (
            "with bootstrap_context as (select library.libraries.id as library_id from app.bootstrap_owners "
            "join library.libraries on library.libraries.owner_account_id = app.bootstrap_owners.account_id "
            "and library.libraries.name = 'Local Library' and library.libraries.library_kind = 'local' "
            "where app.bootstrap_owners.owner_key = 'local-bootstrap-owner' limit 1), "
            + local_album_membership_ctes_sql(scope_album_key=True) + " select count(*) as n from local_album_membership"
        )
        with isolatedPostgres._connect(setup_url) as connection:
            twin_rows = connection.execute(twin_sql, {"album_key": keys["Album One"]}).fetchone()["n"]

        # Problematic Files: only the real multi-album folder keeps the mixed-folder type.
        with _counted(_candidate_sql(browse)) as narrowing:
            status, _headers, body = run_asgi_request(app, "GET", "/utilities/problematic-files")
        assert status == 200, body
        reasons = {item["name"]: set(item.get("problem_reasons") or []) for item in decode_json(body)["items"]}
        assert MIXED in reasons.get("Fourth Album", set()) and MIXED in reasons.get("Fifth Album", set())
        assert MIXED not in reasons.get("Sixth Album", set()) | reasons.get("Seventh Album", set())

        measured[unrelated] = {"copy_reads": list(copy_reads), "twin_rows": twin_rows, "narrowing": list(narrowing)}

    # Flat: the same statements and rows at 20 and at 200 unrelated albums.
    small, large = (measured[size] for size in SIZES)
    assert small == large, measured
    assert len(small["copy_reads"]) == 1 and small["copy_reads"][0] == 2, "one read, returning the album's 2 copies"
    # The summary reaches the narrowing at most once per read (or not at all when it serves stored items).
    assert len(small["narrowing"]) <= 1, small


_INDEXES = {
    # B: the copy lookup goes through the duplicate identity index (0093).
    "copies": ("local_track_files_active_duplicate_identity_idx",),
    # D3: candidate folders by private path and physical parent (0088), other albums' files by album id.
    "candidate folders": ("local_track_files_private_path_idx", "local_track_files_active_physical_parent_idx"),
}
# At 200 albums the default planner reads local_tracks (a few hundred rows) sequentially, which is cheaper there;
# that the "files elsewhere" check can use the album-id index is shown with sequential scans off.
_STRUCTURAL_INDEXES = {"candidate folders": ("local_tracks_album_id_idx",)}


def _plans(seed, setup_url, *, seqscan):
    from music_app.services import library_browse_postgres as browse

    _app, music_dir = seed(SIZES[-1])
    album_paths = [str(Path(music_dir) / f"Owner/Album One/{number:02d}.flac") for number in (1, 2, 3)]
    shared_paths = [str(Path(music_dir) / f"Owner/Shared/{album[:5]}-{number:02d}.flac")
                    for album in ("Fourth Album", "Fifth Album") for number in (1, 2)]
    return {
        "copies": _plan(setup_url, browse._OUTSIDE_COPIES_SQL,
                        {"paths": album_paths, "reason": "Duplicate track outside album folder"}, seqscan=seqscan),
        "candidate folders": _plan(setup_url, _candidate_sql(browse), {"paths": shared_paths}, seqscan=seqscan),
    }


def test_live_added_reads_reach_their_indexes_with_the_default_planner(seeded_app):
    """6.5 (2026-11-24): at 200 unrelated albums the default planner (sequential scans allowed) already picks
    every index the added reads rely on."""
    plans = _plans(*seeded_app, seqscan=True)
    missing = [(read, index) for read, indexes in _INDEXES.items() for index in indexes if index not in plans[read]]
    assert not missing, (missing, plans)


def test_live_album_id_index_structural_proof(seeded_app):
    """Structural proof (sequential scans off): the candidate folders' "files elsewhere" check can reach other
    albums' files through local_tracks_album_id_idx, so it stays keyed by album at any library size."""
    plans = _plans(*seeded_app, seqscan=False)
    missing = [(read, index) for read, indexes in _STRUCTURAL_INDEXES.items()
               for index in indexes if index not in plans[read]]
    assert not missing, (missing, plans)
