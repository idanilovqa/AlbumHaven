"""The fold decision route reads the edited albums, never the library (owner, 2026-11-22)."""
from __future__ import annotations

from contextlib import nullcontext

from tests.py.asgi_testing import create_test_asgi_app, decode_json, run_asgi_request
from tests.py.bounded_interactions import OperationCounts, measure_scale_pair

PATHS = ("/music/Artist/Copy/01.flac", "/music/Artist/Copy/02.flac")


class _Rows:
    def __init__(self, rows, counts):
        self._rows, self._counts = rows, counts

    def fetchone(self):
        rows = self.fetchall()
        return rows[0] if rows else None

    def fetchall(self):
        self._counts.returned_rows += len(self._rows)
        return list(self._rows)


class _Library:
    """One edited album in a library of ``albums``: a read that names no edited album returns them all."""

    def __init__(self, albums, counts):
        self.albums, self.counts = albums, counts

    def execute(self, query, params=None):
        self.counts.sql_statements += 1
        text = " ".join(str(query).split()).lower()
        if text.startswith("set local statement_timeout"):
            rows = []
        elif "jsonb_to_recordset" in text and params and params.get("album_ids") == [1]:
            rows = [{
                "album_key": "artist::twin réléase", "track_paths": list(PATHS),
                "folds_into": ["/music/Artist/Twin/01.flac"], "folds_into_key": "artist::twin release",
                "was_folded": False, "was_folded_into_key": None, "was_folded_into": None,
            }]
        elif "copies.track_id" in text and params and set(params["paths"]) == set(PATHS):
            rows = [{
                "private_path": path, "library_id": 1, "track_id": number, "album_id": 1,
                "title": f"Song {number}", "disc_number": 1, "track_number": number, "duration_seconds": 180,
                "album_key": "artist::other release", "artist_id": 1, "release_year": 2026, "copies": 1,
            } for number, path in enumerate(PATHS, 1)]
        elif "owner.name as album_owner" in text and params:
            rows = [{
                "private_path": path, "track_id": number, "album_id": 1, "track_metadata": {},
                "album_key": "artist::other release", "album_owner": "Artist",
            } for number, path in enumerate(PATHS, 1)]
        elif "count(*) as files" in text and params and params.get("album_id") == 1:
            rows = [{"files": 2}]
        elif "candidates.album_key" in text and params and params.get("source_album_id") == 1:
            rows = []
        elif "separate_releases.release_key" in text:
            rows = []
        elif "inventory_mutation_revision" in text:
            rows = [{"inventory_mutation_revision": 7}]
        else:
            rows = [{"id": index} for index in range(self.albums)]
        return _Rows(rows, self.counts)

    def rollback(self):
        pass


def test_fold_decision_route_contract_reads_only_the_edited_albums_at_production_album_count(tmp_path, monkeypatch):
    from music_app.routes import api_wave_a_asgi_routes as routes
    from music_app.services import stray_fold_decision

    app = create_test_asgi_app(tmp_path / "fold-decision", monkeypatch)
    monkeypatch.setattr(routes, "_is_selected_postgres_library_browse_request", lambda _request: True)

    def run(albums: int) -> OperationCounts:
        counts = OperationCounts()
        library = _Library(albums, counts)

        class Repository:
            def __init__(self, _config):
                pass

            def build_track_file_entries_by_paths(self, paths):
                counts.candidate_rows += len(paths)
                return {
                    path: {
                        "path": path, "album": "Other Release", "album_artist": "Artist", "artist": "Artist",
                        "year": 2026, "title": f"Song {number}", "track_number": number, "disc_number": 1,
                    }
                    for number, path in enumerate(sorted(paths), 1)
                }

        monkeypatch.setattr(stray_fold_decision, "leased_connection", lambda _url: nullcontext(library))
        monkeypatch.setattr(stray_fold_decision, "PostgresLibraryBrowseRepository", Repository)
        status, _headers, body = run_asgi_request(
            app, "POST", "/utilities/tag-editor/fold-decision",
            json_body={"updates": {path: {"album": "Twin Réléase"} for path in PATHS}},
        )
        decision = decode_json(body)
        assert status == 200, decision
        assert decision["albums"][0]["folds_into_key"] == "artist::twin release"
        assert decision["albums"][0]["card"] is None
        return counts

    measure_scale_pair(
        interaction_id="py:routes/api_wave_a_asgi_routes.py#tag_editor_fold_decision",
        small=20,
        large=160_000,
        run=run,
        budgets={"sql_statements": 10, "returned_rows": 12, "candidate_rows": 2},
        growth=("returned_rows", 0),
    )
