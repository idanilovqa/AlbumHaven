"""Bounded contract: a tag save keeps the duplicate projections (FTC-TAGS-015).

The save and the next search or artist view read only the edited albums and the albums
sharing their old or new duplicate identity, never the whole library's identity index.
"""

from __future__ import annotations

import pytest

from tests.py.bounded_interactions import CountingConnection, OperationCounts, measure_scale_pair

_PAGE_ALBUMS = 40


class _FakeLibrary:
    """Answers the duplicate-projection statements from an in-memory library of albums."""

    def __init__(self, album_count: int):
        self.revision = 1
        self.tags = {
            album_id: {"album_artist": f"Artist {album_id}", "album": f"Album {album_id}", "year": 2001}
            for album_id in range(1, album_count + 1)
        }
        # Albums 1 and 2 carry one identity until the save renames album 1.
        self.tags[2] = dict(self.tags[1])

    @staticmethod
    def key(album_id: int) -> str:
        return f"album-{album_id}"

    @staticmethod
    def path(album_id: int) -> str:
        return f"/music/album-{album_id}/01.flac"

    def rows(self, sql: str, params) -> list[dict[str, object]]:
        params = params or {}
        if "inventory_mutation_revision" in sql:
            return [{"library_id": 1, "inventory_revision": str(self.revision), "root_versions": [],
                     "root_count": 1, "override_versions": None, "override_count": 0,
                     "observed_at": self.revision}]
        if "files.private_path = any(%(paths)s" in sql:
            return [{"album_id": album_id, "album_key": self.key(album_id), **self.tags[album_id]}
                    for album_id in self.tags if self.path(album_id) in params["paths"]]
        if "select distinct albums.id as album_id" in sql:
            ids = params.get("album_ids") or self.tags
            return [{"album_id": album_id, "album_key": self.key(album_id), **self.tags[album_id]}
                    for album_id in ids if album_id in self.tags]
        if "bootstrap_context" in sql:
            return [{
                "album_id": album_id, "album_key": self.key(album_id), "file_private_path": self.path(album_id),
                "file_entry": {**self.tags[album_id], "path": self.path(album_id), "title": "01"},
                "artist_name": self.tags[album_id]["album_artist"], "album_title": self.tags[album_id]["album"],
                "album_release_year": 2001, "duration_seconds": 60, "file_library_root_id": "main",
            } for album_id in params["album_ids"] if album_id in self.tags]
        raise AssertionError(f"unexpected statement: {' '.join(sql.split())[:120]}")


class _Result:
    def __init__(self, rows):
        self._rows = rows

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)


class _FakeConnection:
    class info:
        server_version = 170000

    def __init__(self, library: _FakeLibrary):
        self._library = library

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        return _Result(self._library.rows(sql, params))


def test_tag_save_contract_keeps_duplicate_projections_for_the_next_view_at_production_album_count(monkeypatch):
    """A save, then the next search or artist view of one page: the duplicate work grows with
    the edited albums, not the library."""
    import music_app.services.library_browse_postgres as browse

    monkeypatch.setattr(browse.problematic_index, "queue_maintenance", lambda repository: None)

    def run(album_count: int) -> OperationCounts:
        library = _FakeLibrary(album_count)
        counts = OperationCounts()
        measuring = {"on": False}

        def connect(_url):
            connection = _FakeConnection(library)
            return CountingConnection(connection, counts) if measuring["on"] else connection

        monkeypatch.setattr(browse, "_connect", connect)
        config = {"ALBUM_HAVEN_APP_DATABASE_URL": f"duplicate-projection-contract-{album_count}"}
        browse.invalidate_postgres_utility_projection_cache()
        repository = browse.PostgresLibraryBrowseRepository(config, connect=connect)
        page = [library.key(album_id) for album_id in range(1, _PAGE_ALBUMS + 1)]

        def view():
            albums = [{"key": key} for key in page]
            repository._attach_duplicate_sources(albums)
            return [album["key"] for album in albums if album.get("has_duplicate_files")]

        assert view() == ["album-1", "album-2"]  # Warm: the cold load reads the whole index once.
        measuring["on"] = True
        previous = {**library.tags[1], "path": library.path(1)}
        library.tags[1] = {**library.tags[1], "album": "Renamed"}
        library.revision += 1
        for _step in ("persistence", "finalize"):  # A structural save refreshes in both steps.
            browse.refresh_postgres_utility_projections_after_edit(
                config, track_paths=[library.path(1)], previous_entries=[previous],
            )
        assert view() == [], "Renaming album 1 clears the badge on both former twins at once."
        browse.invalidate_postgres_utility_projection_cache()
        return counts

    measure_scale_pair(
        interaction_id="py:services/library_browse_postgres.py#refresh_postgres_utility_projections_after_edit",
        small=60,
        large=20_000,
        run=run,
        budgets={"sql_statements": 10, "returned_rows": 13},
        growth=("returned_rows", 0),
    )
