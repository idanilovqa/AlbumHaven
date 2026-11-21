from __future__ import annotations

from contextlib import contextmanager

from music_app.services.cover_references import CoverReferenceStore


def test_a_store_names_new_covers_once_its_runtime_leaves_browse_only():
    # Owner 2026-11-21 (Lisbon): a sandbox runtime starts browse-only and leaves it after startup. The store read the
    # flag once, so new local covers never got a reference: blank thumbnails whose delete did nothing.
    stored: dict[str, str] = {}
    inserts = []

    class Cursor:
        def __init__(self, rows):
            self._rows = rows

        def fetchall(self):
            return self._rows

    class Connection:
        def execute(self, sql, params):
            if sql.lstrip().startswith("insert"):
                inserts.append(params)
                for path in params[1]:
                    stored.setdefault(path, f"ref{len(stored):017d}xx")
                return Cursor([])
            return Cursor([
                {"private_path": path, "reference": stored[path], "kind": "candidate"}
                for path in params[1] if path in stored
            ])

    @contextmanager
    def connect(_url, workload=None):
        yield Connection()

    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused", "SHARED_LIBRARY_BROWSE_ONLY": True}
    store = CoverReferenceStore(config, connect=connect)

    assert store.references_for(1, {"/music/Lisbon/cover-existing-1.jpg": "candidate"}) == {}
    assert inserts == [], "browse-only never writes"

    config["SHARED_LIBRARY_BROWSE_ONLY"] = False
    named = store.references_for(1, {"/music/Lisbon/cover-existing-1.jpg": "candidate"})
    assert set(named) == {"/music/Lisbon/cover-existing-1.jpg"}
    assert len(inserts) == 1
