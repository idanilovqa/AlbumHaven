"""Bounded-interaction contracts that drive real routes and workers.

Each contract runs the registered entrypoint itself (an ASGI request through
the real route, or the real background function) at the registry's small and
production cardinalities and measures it under the entry's own id. Only the
Postgres-backed seams are replaced, by in-memory stand-ins that count their
use; the filesystem, media, and library-building work is real and counted.
"""

from __future__ import annotations

from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace

import pytest

from music_app.services import library_roots as library_roots_module
from music_app.services.library_roots import normalize_library_root_settings
from tests.py.asgi_testing import create_test_asgi_app, decode_json, run_asgi_request
from tests.py.bounded_interactions import OperationCounts, measure_scale_pair
from tests.py.filesystem_operation_counting import count_filesystem_and_media


def _registered(interaction_id: str) -> dict[str, object]:
    from tests.py.bounded_interactions import _checked_in_entries

    entry = _checked_in_entries()[interaction_id]
    growth = entry["growth"]
    return {
        "interaction_id": interaction_id,
        "small": entry["cardinalities"]["small"],
        "large": entry["cardinalities"]["production"],
        "budgets": entry["budgets"],
        "growth": (growth["metric"], growth["largeMinusSmallMax"]),
    }


# Postgres seams without a stand-in fail fast here instead of reaching any server.
_UNREACHABLE_DATABASE_URL = "postgresql://album_haven_app@127.0.0.1:1/pytest_unreachable"


class _RootSettingsStore:
    """Stands in for the Postgres root-settings store."""

    settings: dict[str, object] = {}

    def __init__(self, _config):
        pass

    def load_settings(self, **_kwargs):
        return deepcopy(type(self).settings)

    def save_settings(self, raw_payload, **_kwargs):
        type(self).settings = deepcopy(raw_payload)
        return deepcopy(raw_payload)


@pytest.fixture
def library_app(tmp_path, monkeypatch):
    from music_app.routes import api_read_asgi_routes, api_wave_d_asgi_routes
    from music_app.services import album_details, rule_state_postgres

    import psycopg

    app = create_test_asgi_app(tmp_path, monkeypatch)
    # Postgres-backed seams are selected; each one used here has a stand-in,
    # and any other connection attempt fails at once without reaching a server.
    app.state.config["ALBUM_HAVEN_APP_DATABASE_URL"] = _UNREACHABLE_DATABASE_URL

    def refuse_connection(*_args, **_kwargs):
        raise psycopg.OperationalError("bounded-interaction contracts never connect to Postgres")

    monkeypatch.setattr(psycopg, "connect", refuse_connection)
    monkeypatch.setattr(psycopg.Connection, "connect", classmethod(lambda cls, *args, **kwargs: refuse_connection()))
    monkeypatch.setattr(library_roots_module, "PostgresLibraryRootSettingsStore", _RootSettingsStore)
    # The in-memory inventory below is the published library: no hydration runs.
    monkeypatch.setattr(api_read_asgi_routes, "request_library_hydration_for_state", lambda *_args, **_kwargs: True)
    for module in (api_read_asgi_routes, api_wave_d_asgi_routes):
        if hasattr(module, "request_library_hydration_for_state"):
            monkeypatch.setattr(module, "request_library_hydration_for_state", lambda *_args, **_kwargs: True)
    # The move-availability probes are reachable only on the in-memory browse
    # path; the persistence-selection seam picks it, as on a file-backed host.
    monkeypatch.setattr(
        api_read_asgi_routes, "select_runtime_persistence_adapter",
        lambda seam_id, _config: SimpleNamespace(seam_id=seam_id, effective_backend="file"),
    )
    # The Postgres track-preference store holds no preferences for this library.
    monkeypatch.setattr(album_details, "build_track_preference_overlay_lookup", lambda *_args, **_kwargs: {})
    # The Postgres rule-state store holds no rules for this library.
    monkeypatch.setattr(rule_state_postgres.RuleStatePostgresAdapter, "_load_rows", lambda _self, _sql: [])
    return app


def _use_roots(app, settings: dict[str, object]) -> None:
    _RootSettingsStore.settings = normalize_library_root_settings(
        settings, fallback_main_root=Path(app.state.config["MUSIC_DIR"]).resolve(),
    )
    app.state.config.pop(library_roots_module._CONFIGURED_ROOT_PATHS_SNAPSHOT_KEY, None)


def _arrival_library(app, scale_root: Path, artist_count: int):
    """`artist_count` artist folders in the Main Library and one New Arrivals
    album whose artist folder already exists there; returns the album."""
    from music_app.services.library import build_albums_from_file_cache

    main_root = scale_root / "main"
    arrivals_root = scale_root / "arrivals"
    for index in range(artist_count):
        (main_root / f"Artist {index:05d}").mkdir(parents=True)
    (main_root / "Broadcast").mkdir()
    track = arrivals_root / "Broadcast" / "Tender Buttons" / "01 - I Found the F.mp3"
    track.parent.mkdir(parents=True)
    track.write_bytes(b"track")
    _use_roots(app, {
        "main_library_roots": [{"id": "main", "path": str(main_root), "layout_mode": "artist"}],
        "hoarding_library_roots": [],
        "new_arrivals_roots": [{"id": "arrivals-1", "path": str(arrivals_root)}],
        "move_policy": {"preferred_main_write_root": "main"},
    })
    file_cache = {str(track): {
        "path": str(track), "title": "I Found the F", "album": "Tender Buttons", "album_artist": "Broadcast",
        "artist": "Broadcast", "year": 2004, "track_number": 1,
    }}
    (album,) = build_albums_from_file_cache(file_cache)
    album.library_root_id = "arrivals-1"
    album.library_root_category = "new_arrivals"
    album.root_provenance = {
        "root_ids": ["arrivals-1"], "categories": ["new_arrivals"], "category_labels": ["New Arrivals"],
        "primary_category": "new_arrivals", "primary_category_label": "New Arrivals", "badges": ["New"], "is_mixed": False,
    }
    state = app.state.library_state
    state["albums"] = [album]
    state["file_cache"] = file_cache
    return album, main_root


def _measure(monkeypatch, request) -> OperationCounts:
    """Counts one warm request; the uncounted first one settles process-wide setup."""
    request()
    counts = OperationCounts()
    with count_filesystem_and_media(monkeypatch, counts):
        request()
    return counts


def test_album_details_route_contract_probes_one_artist_folder_at_production_artist_count(library_app, tmp_path, monkeypatch):
    def run(artist_count: int) -> OperationCounts:
        album, main_root = _arrival_library(library_app, tmp_path / f"scale-{artist_count}", artist_count)

        def request():
            status, _headers, body = run_asgi_request(library_app, "GET", "/album-details", query={"album_key": album.key})
            assert status == 200, body
            move = decode_json(body)["album"]["move_availability"]["actions"]["move_to_library"]
            assert move["destination_path"] == str(main_root / "Broadcast" / "2004 - Tender Buttons")

        return _measure(monkeypatch, request)

    measure_scale_pair(run=run, **_registered("py:routes/api_read_asgi_routes.py#album_details"))


def test_fetch_cover_route_contract_probes_one_artist_folder_at_production_artist_count(library_app, tmp_path, monkeypatch):
    from music_app.services import problematic_albums
    from music_app.services import state as state_service

    # The Postgres rule-state store holds no ignored repairs for this library.
    monkeypatch.setattr(problematic_albums, "load_ignored_repair_keys", lambda _config: set())
    refreshed: list[set[str]] = []

    def refresh_cover_artwork(_state, _config, _logger, track_paths, **_kwargs):
        # The cover provider search is network work outside this contract.
        refreshed.append(set(track_paths))
        return {"processed": 1, "downloaded": 0, "skipped": 1, "failed": 0, "job_results": []}

    monkeypatch.setattr(state_service, "refresh_cover_artwork_for_track_paths_for_state", refresh_cover_artwork)

    def run(artist_count: int) -> OperationCounts:
        album, _main_root = _arrival_library(library_app, tmp_path / f"scale-{artist_count}", artist_count)
        tracks = [{"path": str(track.path)} for track in album.tracks]

        def request():
            status, _headers, body = run_asgi_request(
                library_app, "POST", "/utilities/fetch-cover", json_body={"album": {"name": album.name, "tracks": tracks}},
            )
            assert status == 200, body
            assert decode_json(body)["processed_count"] == 1

        counts = _measure(monkeypatch, request)
        assert refreshed[-1] == {track["path"] for track in tracks}
        return counts

    measure_scale_pair(run=run, **_registered("py:routes/api_wave_d_asgi_routes.py#utilities_fetch_cover"))


def _contaminated_file_cache(root: Path, album_count: int) -> tuple[dict[str, dict[str, object]], Path, Path]:
    """`album_count` albums of 160 tracks plus one album whose inherited cover
    comes from a stray copy of one of its tracks; returns the cache, the real
    album's own cover, and its folder."""
    from PIL import Image

    album_root = root / "Artist" / "Real Album"
    random_root = root / "Random songs"
    (album_root / "CD1").mkdir(parents=True)
    random_root.mkdir()
    good = album_root / "cover.png"
    unrelated = random_root / "cover.png"
    Image.new("RGB", (1600, 1600), "red").save(good)
    Image.new("RGB", (200, 200), "blue").save(unrelated)
    file_cache = {
        str(path): {
            "path": str(path), "title": title, "album": "Real Album", "album_artist": "Artist",
            "cover_path": str(unrelated), "cover_selection_origin": "automatic",
        }
        for path, title in (
            (album_root / "CD1" / "1.mp3", "One"),
            (album_root / "CD1" / "2.mp3", "Two"),
            (random_root / "copied-song.mp3", "One"),
        )
    }
    for album_index in range(album_count):
        folder = root / "library" / f"Artist {album_index:04d}" / "Album"
        for track_index in range(160):
            track_path = str(folder / f"{track_index:03d}.mp3")
            file_cache[track_path] = {
                "path": track_path, "album": f"Album {album_index}", "album_artist": f"Artist {album_index}",
                "title": f"Track {track_index}", "track_number": track_index + 1, "cover_path": str(folder / "cover.jpg"),
            }
    return file_cache, good, album_root


def _real_album_cover(albums, album_root: Path) -> Path:
    (repaired,) = [album for album in albums if album.name == "Real Album" and Path(album.cover_path or "").is_relative_to(album_root)]
    return Path(repaired.cover_path)


def test_partial_scan_publication_contract_repairs_only_contaminated_albums_at_production_track_count(tmp_path, monkeypatch):
    from music_app.services import covers
    from music_app.services.library_indexing import _publish_partial_scan_albums

    def run(album_count: int) -> OperationCounts:
        file_cache, good, album_root = _contaminated_file_cache(tmp_path / f"scale-{album_count}", album_count)
        library_state: dict[str, object] = {}
        counts = OperationCounts()
        with count_filesystem_and_media(monkeypatch, counts, media_modules=(covers,)):
            _publish_partial_scan_albums(library_state, file_cache)
        assert _real_album_cover(library_state["albums"], album_root) == good
        assert len(library_state["albums"]) >= album_count + 1
        return counts

    measure_scale_pair(run=run, **_registered("py:services/library_indexing.py#_publish_partial_scan_albums"))


def test_relation_snapshot_contract_republishes_repaired_covers_without_probing_the_library_at_production_track_count(
    library_app, tmp_path, monkeypatch,
):
    from music_app.services import covers
    from music_app.services import state as state_service

    def run(album_count: int) -> OperationCounts:
        file_cache, good, album_root = _contaminated_file_cache(tmp_path / f"scale-{album_count}", album_count)
        state = library_app.state.library_state
        state.update({"file_cache": file_cache, "albums": [], "scan_generation": 1, "last_scan": 1.0})
        repaired_path = str(album_root / "CD1" / "1.mp3")
        committed: list[int] = []

        def save_snapshot(_config, _cache_path, cache, *_args, **_kwargs):
            # The Postgres cache commit reports the album whose stray cover it repaired.
            committed.append(len(cache))
            return {"repaired_cover_entries": {repaired_path: {"cover_path": str(good), "cover_selection_origin": "automatic"}},
                    "relation_views": {"artists": []}}

        monkeypatch.setattr(state_service, "save_cache_to_disk_for_config", save_snapshot)
        counts = OperationCounts()
        with count_filesystem_and_media(monkeypatch, counts, media_modules=(covers,)):
            state_service.refresh_relation_views_for_state(state, library_app.state.config)
        assert committed == [len(file_cache)]
        assert _real_album_cover(state["albums"], album_root) == good
        return counts

    measure_scale_pair(run=run, **_registered("py:services/state.py#refresh_relation_views_for_state"))


def _published_library(app, root: Path, album_count: int) -> None:
    """A published, freshly scanned library of `album_count` albums."""
    import time

    from music_app.services.library import build_albums_from_file_cache

    file_cache = {}
    for index in range(album_count):
        for number in (1, 2):
            path = str(root / f"Artist {index:04d}" / "Album" / f"{number:02d}.mp3")
            file_cache[path] = {
                "path": path, "title": f"Track {number}", "album": f"Album {index}", "album_artist": f"Artist {index}",
                "artist": f"Artist {index}", "track_number": number,
            }
    state = app.state.library_state
    state.update({
        "file_cache": file_cache,
        "albums": build_albums_from_file_cache(file_cache),
        "last_scan": time.time(),
        "relation_views": {"artists": [{"name": "Artist 0000"}]},
        "relation_projection_ready": True,
        "scan_in_progress": False,
    })


@pytest.mark.parametrize("interaction_id", [
    "py:services/state.py#refresh_library_for_state",
    "py:services/state.py#_refresh_library_worker",
    "py:services/scan_state.py#refresh_library_state",
])
def test_refresh_worker_contract_converges_without_rescanning_a_fresh_library_at_production_size(
    library_app, tmp_path, monkeypatch, interaction_id,
):
    from music_app.services import state as state_service

    def run(album_count: int) -> OperationCounts:
        _published_library(library_app, tmp_path / f"library-{album_count}", album_count)
        state, config, logger = library_app.state.library_state, library_app.state.config, library_app.state.logger
        if interaction_id.endswith("#_refresh_library_worker"):
            refresh = lambda: state_service._refresh_library_worker(state, config, logger, False)  # noqa: E731
        else:
            refresh = lambda: state_service.refresh_library_for_state(state, config, logger, force=False)  # noqa: E731
        counts = _measure(monkeypatch, refresh)
        assert state["scan_outcome"] == "completed"
        assert len(state["file_cache"]) == album_count * 2
        return counts

    measure_scale_pair(run=run, **_registered(interaction_id))
