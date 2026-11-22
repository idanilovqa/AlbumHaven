"""Case 59 (freeze guard): a missing album's Re-scan looks things up in the request and walks only in the background."""
from __future__ import annotations

import os as _os
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from music_app.services import missing_album_rescan as rescan_module
from music_app.services.missing_album_rescan import MissingAlbumRescan, MissingAlbumSearches
from tests.py.bounded_interactions import OperationCounts
from tests.py.filesystem_operation_counting import count_filesystem_and_media

_ALBUM = "artist::album"


class _Database:
    """The album's file rows, the rows a watcher or scan already recorded, and every statement sent."""

    def __init__(self, files, *, known=()):
        self.files, self.known, self.statements = files, set(known), []

    def __call__(self, _url):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *_failure):
        return False

    def execute(self, query, params=None):
        self.statements.append(" ".join(str(query).split()))
        if "where albums.album_key" in query and "select files.private_path" in query:
            rows = [{"private_path": path, "root_id": root_id} for path, root_id in self.files]
        elif "private_path = any" in query:
            rows = [{"private_path": path} for path in params["paths"] if path in self.known]
        else:
            rows = []
        return SimpleNamespace(fetchall=lambda: rows, fetchone=lambda: rows[0] if rows else None)


def _library(tmp_path, other_albums=0):
    roots = {"main": tmp_path / "main", "hoard": tmp_path / "hoard"}
    for root in roots.values():
        root.mkdir()
    for index in range(other_albums):
        folder = roots["main"] / f"Artist {index:04d}" / "Record"
        folder.mkdir(parents=True)
        (folder / "01.flac").write_bytes(b"audio")
    album = roots["main"] / "Artist" / "Album"
    files = [(str(album / "01.flac"), "main"), (str(album / "02.flac"), "main")]
    return roots, album, files


class _OsWithWalk:
    """The module's ``os`` with its own ``walk``: only the search's own calls, not os.walk's recursion."""

    def __init__(self, walk):
        self.walk = walk

    def __getattr__(self, name):
        return getattr(_os, name)


def _rescan(roots, database, *, searches=None, reconciled=None, search_seconds=15.0):
    return MissingAlbumRescan(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://rescan.invalid/contract"},
        reconcile=lambda request: (reconciled.append(request) if reconciled is not None else None)
        or SimpleNamespace(health="healthy", revision=3),
        roots=[{"id": root_id, "path": str(path)} for root_id, path in roots.items()],
        connect=database, search_seconds=search_seconds, searches=searches,
    )


@pytest.mark.parametrize("other_albums", [10, 200])
def test_a_rescan_finds_an_album_moved_to_another_root_by_lookups_alone(tmp_path, monkeypatch, other_albums):
    roots, album, files = _library(tmp_path, other_albums)
    moved = roots["hoard"] / "Artist" / "Album"
    moved.mkdir(parents=True)
    for name in ("01.flac", "02.flac"):
        (moved / name).write_bytes(b"audio")
    database, reconciled, counts = _Database(files), [], OperationCounts()

    with count_filesystem_and_media(monkeypatch, counts):
        result = _rescan(roots, database, reconciled=reconciled, searches=MissingAlbumSearches()).rescan(_ALBUM)

    assert result == {"status": "moved", "library_revision": 3}
    assert reconciled[0].moves[0].destination == moved
    assert counts.filesystem_enumerations == 0, "the request lists no folder"
    assert counts.stat_calls <= 2 * len(files) * len(roots), "one check per file at its old place and per other root"


def test_a_rescan_finds_an_album_a_watcher_already_recorded_under_another_root(tmp_path, monkeypatch):
    roots, album, files = _library(tmp_path)
    recorded = [str(roots["hoard"] / "Artist" / "Album" / name) for name in ("01.flac", "02.flac")]
    database, counts = _Database(files, known=recorded), OperationCounts()

    with count_filesystem_and_media(monkeypatch, counts):
        result = _rescan(roots, database, searches=MissingAlbumSearches()).rescan(_ALBUM)

    assert result["status"] == "moved"
    assert sum("private_path = any" in statement for statement in database.statements) == 1, "one lookup for every root"
    assert counts.filesystem_enumerations == 0


def test_a_rescan_that_finds_nothing_answers_at_once_and_starts_one_search(tmp_path, monkeypatch):
    roots, album, files = _library(tmp_path, 50)
    started = []
    searches = MissingAlbumSearches(start=lambda key, run: started.append(key))
    counts = OperationCounts()

    with count_filesystem_and_media(monkeypatch, counts):
        first = _rescan(roots, _Database(files), searches=searches).rescan(_ALBUM)
        second = _rescan(roots, _Database(files), searches=searches).rescan(_ALBUM)

    assert first == second == {"status": "searching"}
    assert started == [_ALBUM], "a second Re-scan joins the search already running"
    assert counts.filesystem_enumerations == 0, "the request walks nothing"
    assert searches.result(_ALBUM) == {"status": "searching"}


def test_the_search_walks_each_readable_root_once_and_restores_the_album(tmp_path, monkeypatch):
    roots, album, files = _library(tmp_path, 30)
    renamed = roots["hoard"] / "Sorted" / "Album"
    renamed.mkdir(parents=True)
    for name in ("01.flac", "02.flac"):
        (renamed / name).write_bytes(b"audio")
    walks = []

    def counted_walk(top, *args, **kwargs):
        walks.append(Path(top))
        return _os.walk(top, *args, **kwargs)

    monkeypatch.setattr(rescan_module, "os", _OsWithWalk(counted_walk))
    searches, reconciled = MissingAlbumSearches(), []

    assert _rescan(roots, _Database(files), searches=searches, reconciled=reconciled).rescan(_ALBUM) == {"status": "searching"}
    searches.wait(_ALBUM, timeout=10)

    assert searches.result(_ALBUM) == {"status": "moved", "library_revision": 3}
    assert reconciled[0].moves[0].destination == renamed
    assert sorted(walks) == sorted(roots.values()), "one walk per readable root, no walk of a candidate folder"


def test_the_search_honours_its_time_cap_and_says_why_the_album_is_missing(tmp_path, monkeypatch):
    roots, album, files = _library(tmp_path, 30)
    clock = iter(range(0, 10_000, 100))
    monkeypatch.setattr(rescan_module, "monotonic", lambda: float(next(clock)))
    searches = MissingAlbumSearches()

    _rescan(roots, _Database(files), searches=searches, search_seconds=15.0).rescan(_ALBUM)
    searches.wait(_ALBUM, timeout=10)

    assert searches.result(_ALBUM) == {"status": "missing", "reason": "deleted"}


_ROUTE = "py:routes/api_wave_a_asgi_routes.py#rescan_missing_album"
_SEARCH = "py:services/missing_album_rescan.py#MissingAlbumSearches._run"


def _contract(interaction_id, run):
    from tests.py.bounded_interactions import _checked_in_entries, measure_scale_pair

    entry = _checked_in_entries()[interaction_id]
    measure_scale_pair(
        interaction_id=interaction_id,
        small=entry["cardinalities"]["small"],
        large=entry["cardinalities"]["production"],
        run=run,
        budgets=entry["budgets"],
        growth=(entry["growth"]["metric"], entry["growth"]["largeMinusSmallMax"]),
    )


def test_rescan_route_contract_looks_up_a_fixed_number_of_places_at_any_library_size(tmp_path, monkeypatch):
    def run(other_albums):
        roots, _album, files = _library(tmp_path / str(other_albums), other_albums)
        database, counts = _Database(files), OperationCounts()
        searches = MissingAlbumSearches(start=lambda _key, _run: None)
        with count_filesystem_and_media(monkeypatch, counts):
            assert _rescan(roots, database, searches=searches).rescan(_ALBUM) == {"status": "searching"}
        counts.sql_statements = len(database.statements)
        return counts

    _contract(_ROUTE, run)


def test_missing_album_search_contract_walks_each_readable_root_once_at_any_library_size(tmp_path, monkeypatch):
    def run(other_albums):
        roots, album, files = _library(tmp_path / str(other_albums), other_albums)
        rescan, counts = _rescan(roots, _Database(files)), OperationCounts()
        paths = [Path(path) for path, _root in files]
        with count_filesystem_and_media(monkeypatch, counts):
            assert rescan._search(_ALBUM, "main", album, paths) == {"status": "missing", "reason": "deleted"}
        return counts

    _contract(_SEARCH, run)


def test_a_search_stops_at_shutdown_and_publishes_nothing(tmp_path, monkeypatch):
    roots, album, files = _library(tmp_path, 30)
    entered, release = threading.Event(), threading.Event()

    def slow_walk(top, *args, **kwargs):
        entered.set()
        release.wait(5)
        return _os.walk(top, *args, **kwargs)

    monkeypatch.setattr(rescan_module, "os", _OsWithWalk(slow_walk))
    searches, reconciled = MissingAlbumSearches(), []
    _rescan(roots, _Database(files), searches=searches, reconciled=reconciled).rescan(_ALBUM)
    assert entered.wait(5)

    stopping = threading.Thread(target=searches.stop)
    stopping.start()
    release.set()
    stopping.join(10)

    assert not stopping.is_alive()
    assert reconciled == [] and searches.result(_ALBUM) is None, "a stopped search reports and publishes nothing"
