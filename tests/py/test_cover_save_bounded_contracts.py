"""A committed cover save works on the saved album, never on the library.

Owner, 2026-11-21: "After album cover save Cover Look Up loads tremendously
slow". The save dropped every utility projection, so what opened next rebuilt
the library's, and its runtime update copied and walked the whole library
state. This contract drives the real save, Cover Look Up and Problematic Files
routes over the real repository; only Postgres and its stores are stand-ins.
"""

from __future__ import annotations

import base64
from io import BytesIO
from types import SimpleNamespace

import pytest

from music_app.services import cache, cover_workflow
from music_app.services import gallery_projection_postgres as gallery
from music_app.services import library_browse_postgres as browse
from music_app.services import state as state_service
from music_app.services.targeted_library_reconciliation import TargetedLibraryReconciler
from tests.py.asgi_testing import decode_json, run_asgi_request
from tests.py.bounded_interactions import CountingConnection, OperationCounts, measure_scale_pair
from tests.py.test_library_route_bounded_contracts import (
    _CountingAlbums,
    _CountingFileCache,
    _registered,
    _use_roots,
    library_app,  # noqa: F401 - fixture
)

_OTHER_PROJECTIONS = ("duplicate-identities", "duplicate-absence", "non-album-candidates", "relation-alias-maps")


class _Library:
    """Answers the browse repository's SQL for albums without cover art."""

    info = SimpleNamespace(server_version=180000)

    def __init__(self, albums: list[dict[str, object]]):
        self.albums = albums

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False

    def _file_rows(self, album):
        return [{
            "album_id": album["id"], "album_key": album["key"], "album_title": album["name"],
            "album_artist": album["artist"], "artist_name": album["artist"], "album_release_year": 2020,
            "album_cover_path": album["cover"], "album_cover_revision": album["revision"],
            "album_local_cover_width": album["edge"], "album_local_cover_height": album["edge"],
            "file_private_path": path, "track_key": path, "track_title": f"Song {number}", "track_number": number,
            "file_entry_is_object": True, "file_album": album["name"], "file_album_artist": album["artist"],
            "file_artist": album["artist"], "file_title": f"Song {number}", "file_year": 2020,
            "file_track_number": number, "file_text_mojibake_candidate": False,
        } for number, path in enumerate(album["paths"], start=1)]

    def execute(self, sql, params=None):
        params = params or {}
        paths = set(params.get("track_paths") or ())
        held = [album for album in self.albums if paths.intersection(album["paths"])]
        candidates = [album for album in self.albums if not album["cover"]]
        rows: list[dict[str, object]] = []
        if "cover_change_albums" in sql:
            rows = [{
                "album_id": album["id"], "album_key": album["key"],
                "album_cover_path": album["cover"], "album_cover_revision": album["revision"],
            } for album in held]
        elif "version_rows" in sql:
            rows = [{
                "ignored_version_key": album["key"], "album_id": album["id"], "album_key": album["key"],
                "album_title": album["name"], "album_release_year": 2020, "album_cover_path": album["cover"],
                "album_metadata": {"album_artist": album["artist"], "cover_revision": album["revision"]},
            } for album in self.albums[:2]]
        elif "relation_alias_cache_identity" in sql or "projection_structure_complete" in sql:
            rows = [{"library_id": 1, "relation_alias_fingerprint": "published", "projection_structure_complete": True}]
        elif paths:
            rows = [{
                "file_private_path": path, "file_entry": {"path": path}, "album_cover_path": album["cover"],
                "album_metadata": {"cover_revision": album["revision"]},
            } for album in held for path in album["paths"]]
        elif "album_ids" in params:
            rows = [row for album in self.albums if album["id"] in params["album_ids"] for row in self._file_rows(album)]
        elif "mojibake_candidate_pattern" in params and "limit" in params:
            ordered = sorted(candidates, key=lambda album: (album["name"].lower(), album["artist"].lower()))
            rows = [{"album_id": album["id"]} for album in ordered[:params["limit"]]]
        elif "mojibake_candidate_pattern" in params:
            rows = [row for album in candidates for row in self._file_rows(album)]
        return SimpleNamespace(fetchone=lambda: rows[0] if rows else None, fetchall=lambda: list(rows))


@pytest.fixture
def postgres_app(library_app, monkeypatch):  # noqa: F811 - the imported fixture
    from music_app.routes import api_read_asgi_routes, api_wave_d_asgi_routes
    from music_app.services import album_cover_candidate_snapshots_postgres as snapshots

    monkeypatch.setattr(api_read_asgi_routes, "_is_postgres_utility_projection_request", lambda _request: True)
    monkeypatch.setattr(api_read_asgi_routes, "load_problematic_artist_items", lambda _request: [])
    monkeypatch.setattr(api_read_asgi_routes, "_project_library_watch_health_for_request", lambda _request: {"problems": []})
    monkeypatch.setattr(
        api_wave_d_asgi_routes, "mark_cover_lookup_notifications_action_taken_for_track_paths",
        lambda *_args, **_kwargs: [],
    )
    repository = snapshots.AlbumCoverCandidateSnapshotRepository
    monkeypatch.setattr(repository, "resolve_album_id_for_track_paths", lambda _self, **_kwargs: 1)
    monkeypatch.setattr(repository, "get_for_album_context", lambda _self, **_kwargs: None)
    return library_app


def test_cover_save_contract_next_cover_lookup_and_problematic_files_open_grow_with_the_saved_album(
    postgres_app, tmp_path, monkeypatch,
):
    from PIL import Image

    from music_app.services.library import build_albums_from_file_cache
    from music_app.services.library_album_index import publish_library_albums

    app = postgres_app
    config, state = app.state.config, app.state.library_state
    image = BytesIO()
    Image.new("RGB", (1200, 1200), "red").save(image, format="JPEG")
    pasted = f"data:image/jpeg;base64,{base64.b64encode(image.getvalue()).decode()}"

    def run(album_count: int) -> OperationCounts:
        main_root = (tmp_path / f"main-{album_count}").resolve()
        album_root = main_root / "Selected" / "Album"
        album_root.mkdir(parents=True)
        track_paths = [str(album_root / f"{number:02d}.mp3") for number in (1, 2)]
        for path in track_paths:
            (album_root / path).write_bytes(b"track")
        _use_roots(app, {"main_library_roots": [{"id": "main", "path": str(main_root), "layout_mode": "artist"}]})
        albums = [
            {"id": 1, "key": "selected::album", "name": "Album", "artist": "Selected", "paths": track_paths},
            *({"id": index + 2, "key": f"artist {index:05d}::record", "name": "Record",
               "artist": f"Artist {index:05d}", "paths": [str(main_root / f"Artist {index:05d}" / "Record" / "01.mp3")]}
              for index in range(album_count)),
        ]
        for album in albums:
            album.update(cover=None, revision=None, edge=None)
        entries = {
            path: {
                "path": path, "title": f"Song {number}", "album": album["name"], "album_artist": album["artist"],
                "artist": album["artist"], "year": 2020, "track_number": number,
            }
            for album in albums for number, path in enumerate(album["paths"], start=1)
        }
        published, file_cache = _CountingAlbums(build_albums_from_file_cache(entries)), _CountingFileCache(entries)
        state.update({"file_cache": file_cache, "relation_views": {}})
        publish_library_albums(state, published)

        counts = published.counts = file_cache.counts = OperationCounts()
        library = _Library(albums)

        def connect(*_args, **_kwargs):
            return CountingConnection(library, counts)

        monkeypatch.setattr(browse, "_connect", connect)
        monkeypatch.setattr(browse, "_pooled_connection", connect)

        class Adapter:
            def persist_cover_selection(self, *, track_paths, selected_cover_path, cover_revision, **_options):
                (saved,) = [album for album in albums if set(track_paths) == set(album["paths"])]
                saved.update(cover=str(selected_cover_path), revision=cover_revision, edge=1200)
                return {"album_rows_updated": 1, "track_file_rows_updated": len(track_paths)}

        monkeypatch.setattr(cache, "_select_runtime_scan_cache_adapter", lambda _config: Adapter())
        for name in ("_UTILITY_PROJECTION_CACHE", "_UTILITY_PROJECTION_GENERATIONS", "_UTILITY_COVER_CHANGES"):
            monkeypatch.setattr(browse, name, {}, raising=False)

        for kind in ("_build_problematic_files_payload_uncached", "_build_problematic_files_first_page"):
            build = getattr(browse.PostgresLibraryBrowseRepository, kind)
            build = getattr(build, "__wrapped__", build)

            def counted(self, *args, _build=build, **kwargs):
                counts.count("builder_calls")
                return _build(self, *args, **kwargs)

            counted.__wrapped__ = build
            monkeypatch.setattr(browse.PostgresLibraryBrowseRepository, kind, counted)
        for owner in (gallery, state_service):
            monkeypatch.setattr(owner, "schedule_gallery_projection_refresh", lambda *_a, **_k: counts.count("worker_wakes"))
        monkeypatch.setattr(
            browse.PostgresLibraryBrowseRepository, "queue_settings_projection_prewarm",
            lambda _self: counts.count("worker_wakes"),
        )

        def call(method: str, route: str, **request):
            status, _headers, body = run_asgi_request(app, method, route, **request)
            assert status == 200, body
            return decode_json(body)

        repository = browse.PostgresLibraryBrowseRepository(config)

        def open_problematic_files():
            page = call("GET", "/utilities/problematic-files", query={"limit": "50"})
            return page, call("GET", "/utilities/problematic-files")

        # What was open before the save: the complete list and Rules, warm.
        _page, complete = open_problematic_files()
        assert complete["count"] == album_count + 1
        assert complete["initial_detail"]["key"] == "selected::album"
        assert repository.build_utility_rules_payload()["rules"][0]["albums"]
        database_url = config["ALBUM_HAVEN_APP_DATABASE_URL"]
        for kind in _OTHER_PROJECTIONS:
            browse._UTILITY_PROJECTION_CACHE.setdefault((database_url, kind), {"fingerprint": "published"})

        counts.__init__()
        album_payload = {"key": "selected::album", "name": "Album", "album_artist": "Selected",
                         "tracks": [{"path": path} for path in track_paths]}
        saved = call(
            "POST", "/utilities/cover-lookup/pasted-image-save",
            json_body={"album": album_payload, "data_url": pasted},
        )
        assert saved["cover_revision"] == cover_workflow.cover_revision_for_path(album_root / "cover.jpg")
        assert len(saved["updated_albums"]) == 1
        # The watcher sees the written cover.jpg: there is no inventory to commit.
        TargetedLibraryReconciler(
            config,
            repository=Adapter(),
            root_definitions=[{"id": "main", "path": str(main_root)}],
            after_commit=lambda _result: counts.count("worker_wakes"),
        ).reconcile(SimpleNamespace(root_id="main", paths=(album_root / "cover.jpg",)))
        assert call("POST", "/utilities/cover-lookup/gallery", json_body={"album": album_payload})["ok"]
        page, complete = open_problematic_files()
        rules = repository.build_utility_rules_payload()
        counts.invalidations = sum(
            (database_url, kind) not in browse._UTILITY_PROJECTION_CACHE
            for kind in (*_OTHER_PROJECTIONS, "problematic-files", "rules")
        )
        measured = OperationCounts(**vars(counts))

        # What is shown is what rebuilding the library would show.
        assert complete["count"] == album_count and page["count"] == min(50, album_count)
        assert "selected::album" not in {item["key"] for item in [*page["items"], *complete["items"]]}
        assert page["initial_detail"]["key"] == page["items"][0]["key"] == "artist 00000::record"
        version = next(album for album in rules["rules"][0]["albums"] if album["key"] == "selected::album")
        assert version["cover_revision"] == saved["cover_revision"]
        scoped = repository.build_problematic_files_payload()
        browse.invalidate_postgres_utility_projection_cache(database_url=database_url)
        rebuilt = repository.build_problematic_files_payload()
        for payload in (scoped, rebuilt):
            payload.pop("projection_cache_status")
        assert scoped == rebuilt
        assert rules == repository.build_utility_rules_payload()
        assert {state["file_cache"][path]["cover_revision"] for path in track_paths} == {saved["cover_revision"]}
        return measured

    measure_scale_pair(
        run=run, **_registered("py:routes/api_wave_d_asgi_routes.py#utilities_cover_lookup_pasted_image_save"),
    )
