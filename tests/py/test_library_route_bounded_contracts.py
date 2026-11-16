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
from tests.py.bounded_interactions import CountingConnection, OperationCounts, measure_scale_pair
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


class _CountingAlbums(list):
    """A published album list that counts every album a reader walks."""

    counts = OperationCounts()

    def __iter__(self):
        for album in super().__iter__():
            self.counts.candidate_rows += 1
            yield album


def _published_versions_library(app, album_count: int) -> tuple[_CountingAlbums, str, str]:
    """`album_count` albums published through the library publisher; returns
    the published list and the keys of two releases by one artist."""
    from music_app.services.library import build_albums_from_file_cache
    from music_app.services.library_album_index import publish_library_albums

    file_cache = {}
    releases = [("Broadcast", "Tender Buttons"), ("Broadcast", "Tender Buttons (Demos)")]
    releases += [(f"Artist {index:05d}", "Album") for index in range(album_count - 2)]
    for artist, album in releases:
        path = f"/music/{artist}/{album}/01.mp3"
        file_cache[path] = {"path": path, "title": "One", "album": album, "album_artist": artist, "artist": artist}
    albums = _CountingAlbums(build_albums_from_file_cache(file_cache))
    # The publisher indexes the list on its own thread, before any request.
    publish_library_albums(app.state.library_state, albums)
    albums.counts = OperationCounts()
    keys = {album.name: album.key for album in list.__iter__(albums) if album.album_artist == "Broadcast"}
    return albums, keys["Tender Buttons (Demos)"], keys["Tender Buttons"]


def test_mark_version_route_contract_reads_two_albums_by_key_at_production_album_count(library_app, monkeypatch):
    from music_app.services import manual_versions, rule_state_postgres

    saved: list[dict[str, str]] = []
    # The Postgres rule-state store saves the link set it is given.
    monkeypatch.setattr(
        rule_state_postgres.RuleStatePostgresAdapter, "save_manual_version_links",
        lambda _self, links: saved.append(dict(links)),
    )

    def run(album_count: int) -> OperationCounts:
        albums, album_key, parent_key = _published_versions_library(library_app, album_count)
        manual_versions._MANUAL_VERSION_LINKS_CACHE.clear()
        status, _headers, body = run_asgi_request(
            library_app, "POST", "/versions/mark", json_body={"album_key": album_key, "parent_album_key": parent_key},
        )
        assert status == 200, body
        assert decode_json(body)["manual_version_links"] == {album_key: parent_key}
        assert saved[-1] == {album_key: parent_key}
        return albums.counts

    measure_scale_pair(run=run, **_registered("py:routes/api_wave_a_asgi_routes.py#mark_album_version"))


def test_cover_gallery_mark_seen_route_contract_probes_only_the_selected_album_at_production_library_size(
    library_app, tmp_path, monkeypatch,
):
    from music_app.routes import api_wave_d_asgi_routes

    snapshot = {"candidates": [], "automatic_improvement_revision": 2, "seen_automatic_improvement_revision": 2}
    marked: list[int] = []

    class SnapshotRepository:
        """The Postgres candidate-snapshot store for the selected album."""

        def __init__(self, _config):
            pass

        def resolve_album_id_for_track_paths(self, *, track_paths):
            return 7

        def mark_seen(self, *, album_id):
            marked.append(album_id)
            return dict(snapshot)

    monkeypatch.setattr(api_wave_d_asgi_routes, "AlbumCoverCandidateSnapshotRepository", SnapshotRepository)

    def run(album_count: int) -> OperationCounts:
        main_root = (tmp_path / f"main-{album_count}").resolve()
        for index in range(album_count):
            sibling = main_root / f"Artist {index:04d}" / "Album" / "01.mp3"
            sibling.parent.mkdir(parents=True)
            sibling.write_bytes(b"track")
        track = main_root / "Selected" / "Album" / "CD1" / "01.mp3"
        track.parent.mkdir(parents=True)
        track.write_bytes(b"track")
        (main_root / "Selected" / "Album" / "CD2").mkdir()
        _use_roots(library_app, {"main_library_roots": [{"id": "main", "path": str(main_root), "layout_mode": "artist"}]})

        def request():
            status, _headers, body = run_asgi_request(
                library_app, "POST", "/utilities/cover-lookup/gallery/mark-seen",
                json_body={"album": {"id": 7, "name": "Album", "tracks": [{"path": str(track)}]}},
            )
            assert status == 200, body
            assert decode_json(body)["candidate_snapshot"]["candidates"] == []
            assert marked[-1] == 7

        return _measure(monkeypatch, request)

    measure_scale_pair(run=run, **_registered("py:routes/api_wave_d_asgi_routes.py#utilities_cover_lookup_gallery_mark_seen"))


class _CountingFileCache(dict):
    """A published scan cache that counts every entry a reader walks or copies."""

    counts = OperationCounts()

    def __iter__(self):
        for path in super().__iter__():
            self.counts.membership_rows += 1
            yield path

    def keys(self):
        return list(iter(self))

    def items(self):
        return [(path, self[path]) for path in self]

    def values(self):
        return [self[path] for path in self]


def _repairable_library(app, root: Path, track_count: int) -> tuple[list[str], OperationCounts]:
    """One 12-track album with a mis-decoded title among `track_count` tracks;
    every album and cache entry a request walks is counted."""
    from music_app.services.library import build_albums_from_file_cache
    from music_app.services.library_album_index import publish_library_albums

    album_root = root / "Broadcast" / "Tender Buttons"
    album_root.mkdir(parents=True)
    album_cache = {}
    for number in range(1, 13):
        path = album_root / f"{number:02d}.mp3"
        path.write_bytes(b"track")
        album_cache[str(path)] = {
            "path": str(path), "title": "Ã‰tÃ©" if number == 1 else f"Song {number}", "album": "Tender Buttons",
            "album_artist": "Broadcast", "artist": "Broadcast", "track_number": number, "year": 2005,
        }
    unrelated_cache = {}
    unrelated_albums = []
    for album_index in range((track_count - 12) // 4):
        tracks = []
        for number in range(1, 5):
            path = f"/library/Artist {album_index:05d}/Album/{number:02d}.mp3"
            unrelated_cache[path] = {"path": path, "title": f"Track {number}", "album": "Album", "album_artist": f"Artist {album_index:05d}"}
            tracks.append(SimpleNamespace(path=path))
        unrelated_albums.append(SimpleNamespace(
            key=f"artist {album_index:05d}::album", name="Album", album_artist=f"Artist {album_index:05d}", year=None, tracks=tracks,
        ))
    counts = OperationCounts()
    albums = _CountingAlbums(sorted(
        [*build_albums_from_file_cache(album_cache), *unrelated_albums], key=lambda album: album.album_artist.lower(),
    ))
    file_cache = _CountingFileCache({**unrelated_cache, **album_cache})
    state = app.state.library_state
    state.update({"file_cache": file_cache, "relation_views": {}, "separate_release_keys": set()})
    publish_library_albums(state, albums)
    albums.counts = file_cache.counts = counts
    return sorted(album_cache), counts


@pytest.mark.parametrize("repair", ["separate-release", "selected-rows"])
def test_repair_album_route_contract_reads_only_the_repaired_album_at_production_track_count(
    library_app, tmp_path, monkeypatch, repair,
):
    from music_app.routes import api_wave_a_asgi_routes
    from music_app.services import ignored_repairs, rule_state_postgres
    from music_app.services.library_album_index import library_album_index

    select_backend = api_wave_a_asgi_routes.select_runtime_persistence_adapter
    # The in-memory library browse path, as on a file-backed host.
    monkeypatch.setattr(
        api_wave_a_asgi_routes, "select_runtime_persistence_adapter",
        lambda seam_id, config: (
            SimpleNamespace(seam_id=seam_id, effective_backend="file")
            if seam_id == "library_browse" else select_backend(seam_id, config)
        ),
    )
    saved_separate_keys: list[set[str]] = []
    # The Postgres rule-state store keeps the separate releases it is given
    # and holds no ignored repairs.
    monkeypatch.setattr(
        rule_state_postgres.RuleStatePostgresAdapter, "save_separate_release_keys",
        lambda _self, keys: saved_separate_keys.append(set(keys)),
    )
    monkeypatch.setattr(ignored_repairs, "load_ignored_repair_keys", lambda _config: set())
    written: list[tuple[str, dict[str, str]]] = []
    # The tag writer is media I/O outside this contract; it reports the fields it wrote.
    monkeypatch.setattr(
        api_wave_a_asgi_routes, "_apply_repairs_worker",
        lambda path, repairs: written.append((path, dict(repairs))) or (path, True, sorted(repairs)),
    )
    finalized: list[dict[str, object]] = []
    # The save task finalizes on its own registered worker.
    monkeypatch.setattr(api_wave_a_asgi_routes, "queue_finalize_save_task", lambda **kwargs: finalized.append(kwargs))

    def run(track_count: int) -> OperationCounts:
        album_paths, counts = _repairable_library(library_app, tmp_path / f"library-{track_count}", track_count)
        payload = {"confirmed": True, "album": {"name": "Tender Buttons", "tracks": [{"path": path} for path in album_paths]}}
        if repair == "separate-release":
            payload.update(selected_rows=[], separate_release_keys=["broadcast::tender buttons"])
        else:
            payload["selected_rows"] = [f"{album_paths[0]}::title"]
        with count_filesystem_and_media(monkeypatch, counts):
            status, _headers, body = run_asgi_request(library_app, "POST", "/utilities/repair-album", json_body=payload)
        assert status == 200, body
        result = decode_json(body)
        if repair == "separate-release":
            assert saved_separate_keys[-1] == {"broadcast::tender buttons"}
            assert {track["path"] for album in result["updated_albums"] for track in album["tracks"]} == set(album_paths)
            # The release now splits by year, in the response and in the published albums.
            assert result["updated_problematic_album"]["key"] == "broadcast::tender buttons::year::2005"
            assert library_album_index(library_app.state.library_state).album("broadcast::tender buttons::year::2005")
            assert library_album_index(library_app.state.library_state).album("broadcast::tender buttons") is None
        else:
            assert written[-1] == (album_paths[0], {"title": "Été"})
            assert result["changed_count"] == 1
            assert result["updated_album"]["tracks"][0]["title"] == "Été"
            assert set(finalized[-1]["updated_file_cache"]) == set(finalized[-1]["previous_file_cache"]) == {album_paths[0]}
        return counts

    measure_scale_pair(run=run, **_registered("py:routes/api_wave_a_asgi_routes.py#utilities_repair_album"))


class _Rows:
    description = ("rows",)
    rowcount = -1

    def __init__(self, rows=()):
        self._rows = list(rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)

    def __iter__(self):
        return iter(self._rows)


class _PublishedGalleryDatabase:
    """Postgres double for a library of `track_count` tracks (12 per album)
    whose root gallery projection is published. Each read returns what its
    statement selects; a statement it does not know fails the contract."""

    page_cover: Path | None = None

    def __init__(self, track_count: int):
        self.album_count = max(1, track_count // 12)
        self.unknown: list[str] = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def rollback(self):
        pass

    def close(self):
        pass

    def _occurrence(self, ordinal: int) -> dict[str, object]:
        return {
            "artist_id": ordinal, "artist_name": f"Artist {ordinal:06d}", "artist_sort_name": f"Artist {ordinal:06d}",
            "album_id": ordinal + 1, "album_key": f"artist {ordinal:06d}::album", "album_title": "Album",
            "album_release_year": 2000,
        }

    def _album_row(self, album_id: int) -> dict[str, object]:
        ordinal = album_id - 1
        return {
            **self._occurrence(ordinal),
            "album_cover_path": str(self.page_cover) if self.page_cover else None,
            "album_metadata": {"album_artist": f"Artist {ordinal:06d}", "artists": [f"Artist {ordinal:06d}"]},
            "track_id": album_id * 100, "track_key": f"album-{album_id}-track", "track_title": "Track",
            "disc_number": 1, "track_number": 1, "duration_seconds": 90,
            "file_private_path": f"/library/Artist {ordinal:06d}/Album/01.flac", "file_library_root_id": 1,
            "file_library_root_category": "main_library", "track_count": 12, "total_duration_seconds": 1080,
        }

    def execute(self, sql, params=None):
        text = " ".join(str(sql).split()).lower()
        params = params or {}
        if text.startswith("set transaction"):
            return _Rows()
        if "bootstrap_context_ready" in text:
            return _Rows([{"bootstrap_context_ready": 1}])
        if "to_regclass('library.gallery_projection_state')" in text:
            return _Rows([{"installed": True}])
        if "information_schema.columns" in text:
            return _Rows([{"compatible": True}])
        if "join library.gallery_projection_state state" in text:
            return _Rows([{"library_id": 1, "generation": 7}])
        if "from library.gallery_projection_snapshots" in text:
            sidebar = [
                {"artist": f"Artist {index:06d}", "artist_display": f"Artist {index:06d}", "count": 1}
                for index in range(self.album_count)
            ]
            return _Rows([{"revision": "r1", "sidebar": sidebar, "album_count": self.album_count, "occurrence_count": self.album_count}])
        if "select payload from library.gallery_projection_occurrences" in text:
            return _Rows(
                {"payload": self._occurrence(ordinal)}
                for ordinal in range(params["offset"], min(params["end"], self.album_count))
            )
        if "gallery_album_ids" in params:
            return _Rows(self._album_row(album_id) for album_id in sorted(params["gallery_album_ids"]))
        if "alias_to_canonical" in text:
            return _Rows([{"alias_to_canonical": {}, "canonical_to_aliases": {}}])
        if "ignored_version_state as" in text and "manual_version_state as" in text:
            return _Rows([{"ignored_version_keys": [], "manual_version_links": {}}])
        if "from app.album_ratings" in text or "from app.album_disc_ratings" in text:
            return _Rows()
        self.unknown.append(text[-300:])
        return _Rows()


@pytest.fixture
def published_gallery(library_app, tmp_path, monkeypatch):
    """The Postgres library browse path, reading a published root gallery from
    the `_PublishedGalleryDatabase` stand-in at the browse connection seam."""
    import contextlib

    from music_app.routes import api_read_asgi_routes, web_asgi
    from music_app.services import covers, gallery_projection_postgres
    from music_app.services import library_browse_postgres as browse

    monkeypatch.setattr(
        api_read_asgi_routes, "select_runtime_persistence_adapter",
        lambda seam_id, _config: SimpleNamespace(seam_id=seam_id, effective_backend="postgres"),
    )
    monkeypatch.setattr(web_asgi, "library_browse_postgres_is_effective", lambda _config: True)
    # Background projection and display-variant work are their own registered entries.
    monkeypatch.setattr(gallery_projection_postgres, "schedule_gallery_projection_refresh", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(covers, "queue_cover_display_variant_generation", lambda *_args, **_kwargs: None)
    cover = tmp_path / "page-cover.jpg"
    cover.write_bytes(b"cover")
    current: dict[str, object] = {}

    @contextlib.contextmanager
    def browse_connection(_database_url, **_options):
        yield CountingConnection(current["database"], current["counts"])

    monkeypatch.setattr(browse, "_pooled_connection", browse_connection)

    def install(track_count: int) -> tuple[_PublishedGalleryDatabase, OperationCounts]:
        database = _PublishedGalleryDatabase(track_count)
        database.page_cover = cover
        current.update(database=database, counts=OperationCounts())
        return database, current["counts"]

    return install


@pytest.mark.parametrize("route", [
    ("py:routes/api_read_asgi_routes.py#view_data", "/view-data", {"surface": "albums", "gallery_page_size": "50"}),
    ("py:routes/web_asgi.py#bootstrap_data", "/bootstrap-data", {"surface": "albums"}),
], ids=["view-data", "bootstrap-data"])
def test_root_gallery_route_contract_reads_one_published_page_at_production_track_count(
    library_app, published_gallery, monkeypatch, route,
):
    from music_app.services import covers

    interaction_id, path, query = route

    def run(track_count: int) -> OperationCounts:
        database, counts = published_gallery(track_count)

        def request():
            status, _headers, body = run_asgi_request(library_app, "GET", path, query=query)
            assert status == 200, body
            payload = decode_json(body)
            view = payload.get("initial_view", payload)
            albums = [album for group in view["artist_groups"] for album in group["albums"]]
            assert [album["key"] for album in albums] == [f"artist {index:06d}::album" for index in range(len(albums))]
            assert 0 < len(albums) <= 50
            assert view["album_count"] == database.album_count
            assert database.unknown == []

        request()
        counts.__init__()
        with count_filesystem_and_media(monkeypatch, counts, media_modules=(covers,)):
            request()
        return counts

    measure_scale_pair(run=run, **_registered(interaction_id))


def _cover_lookup_library(app, root: Path, album_count: int) -> tuple[Path, list[str], OperationCounts]:
    """`album_count` sibling albums in the Main Library (folders and cache
    entries) plus one selected two-track album; returns its folder, its track
    paths, and the counts every cache walk is recorded in."""
    from PIL import Image

    main_root = root.resolve()
    library_cache = {}
    for index in range(album_count):
        sibling = main_root / f"Artist {index:04d}" / "Album" / "01.mp3"
        sibling.parent.mkdir(parents=True)
        sibling.write_bytes(b"track")
        library_cache[str(sibling)] = {"path": str(sibling), "title": "Track", "album": "Album", "album_artist": f"Artist {index:04d}"}
    album_root = main_root / "Selected" / "Album"
    album_root.mkdir(parents=True)
    track_paths = []
    for number in (1, 2):
        track = album_root / f"{number:02d}.mp3"
        track.write_bytes(b"track")
        track_paths.append(str(track))
        library_cache[str(track)] = {
            "path": str(track), "title": f"Song {number}", "album": "Album", "album_artist": "Selected", "track_number": number,
        }
    Image.new("RGB", (1200, 1200), "red").save(album_root / "front.jpg")
    _use_roots(app, {"main_library_roots": [{"id": "main", "path": str(main_root), "layout_mode": "artist"}]})
    from music_app.services.library import build_albums_from_file_cache
    from music_app.services.library_album_index import publish_library_albums

    albums = _CountingAlbums([
        *build_albums_from_file_cache({path: library_cache[path] for path in track_paths}),
        *(SimpleNamespace(key=f"artist {index:04d}::album", tracks=[SimpleNamespace(path=path)])
          for index, path in enumerate(path for path in library_cache if path not in track_paths)),
    ])
    file_cache = _CountingFileCache(library_cache)
    state = app.state.library_state
    state.update({"file_cache": file_cache, "relation_views": {}})
    publish_library_albums(state, albums)
    counts = albums.counts = file_cache.counts = OperationCounts()
    return album_root, track_paths, counts


def test_cover_lookup_add_remote_route_contract_reads_only_the_selected_album_at_production_library_size(
    library_app, tmp_path, monkeypatch,
):
    from music_app.routes import api_wave_d_asgi_routes
    from music_app.services import covers

    from music_app.services import cover_lookup_tasks

    notified: list[str] = []
    # The Postgres notification store keeps the tasks it is given in one write.
    monkeypatch.setattr(
        cover_lookup_tasks, "upsert_cover_lookup_notifications",
        lambda _config, tasks: notified.extend(str(task.get("id")) for task, _revision in tasks),
    )
    match = {"id": "pasted-1", "image_url": "https://covers.example/front.jpg", "source": "manual", "width": 1200, "height": 1200}
    # Fetching the pasted pages is provider network work outside this contract.
    monkeypatch.setattr(api_wave_d_asgi_routes, "add_manual_cover_candidates_from_urls", lambda urls, **_kwargs: [dict(match)])

    def run(album_count: int) -> OperationCounts:
        album_root, track_paths, counts = _cover_lookup_library(library_app, tmp_path / f"main-{album_count}", album_count)

        def request():
            status, _headers, body = run_asgi_request(
                library_app, "POST", "/utilities/cover-lookup/add-remote",
                json_body={"album": {"name": "Album", "album_artist": "Selected", "tracks": [{"path": path} for path in track_paths]},
                           "urls": ["https://covers.example/album"]},
            )
            assert status == 200, body
            payload = decode_json(body)
            assert [item["id"] for item in payload["task"]["possible_matches"]] == ["pasted-1"]
            assert payload["gallery"]["album_root"] == str(album_root)
            assert [Path(item["path"]).name for item in payload["gallery"]["local_covers"]] == ["front.jpg"]

        request()
        counts.__init__()
        with count_filesystem_and_media(monkeypatch, counts, media_modules=(covers,)):
            request()
        return counts

    measure_scale_pair(run=run, **_registered("py:routes/api_wave_d_asgi_routes.py#utilities_cover_lookup_add_remote"))


def test_cover_lookup_local_select_route_contract_reads_only_the_selected_album_at_production_library_size(
    library_app, tmp_path, monkeypatch,
):
    from music_app.routes import api_wave_d_asgi_routes
    from music_app.services import covers, library_browse_postgres

    selected: dict[str, object] = {}

    class SelectedAlbumRepository:
        """The Postgres browse reads of the selected album."""

        def __init__(self, _config, **_kwargs):
            pass

        def build_album_payloads_by_track_paths(self, _track_paths):
            return [{"tracks": [{"path": path} for path in selected["track_paths"]]}]

        def build_track_file_entries_by_paths(self, track_paths):
            cache = library_app.state.library_state["file_cache"]
            return {path: dict(cache[path]) for path in track_paths}

    monkeypatch.setattr(library_browse_postgres, "PostgresLibraryBrowseRepository", SelectedAlbumRepository)
    monkeypatch.setattr(api_wave_d_asgi_routes, "PostgresLibraryBrowseRepository", SelectedAlbumRepository)
    persisted: list[tuple[set[str], str]] = []

    def persist_cover_selection(track_paths, cover_path, *, commit_guard, **_options):
        # The Postgres cover-selection commit for the selected tracks.
        persisted.append((set(track_paths), str(cover_path)))
        return commit_guard(lambda: {"album_rows_updated": 1, "track_file_rows_updated": len(track_paths)})

    monkeypatch.setattr(api_wave_d_asgi_routes, "persist_cover_selection_for_tracks", persist_cover_selection)

    def run(album_count: int) -> OperationCounts:
        album_root, track_paths, counts = _cover_lookup_library(library_app, tmp_path / f"main-{album_count}", album_count)
        selected["track_paths"] = track_paths

        def request():
            status, _headers, body = run_asgi_request(
                library_app, "POST", "/utilities/cover-lookup/local-select",
                json_body={"album": {"name": "Album", "album_artist": "Selected", "tracks": [{"path": path} for path in track_paths]},
                           "source_path": str(album_root / "front.jpg")},
            )
            assert status == 200, body
            assert decode_json(body)["selected_cover_path"] == str(album_root / "cover.jpg")
            assert persisted[-1] == (set(track_paths), str(album_root / "cover.jpg"))

        request()
        counts.__init__()
        with count_filesystem_and_media(monkeypatch, counts, media_modules=(covers,)):
            request()
        return counts

    measure_scale_pair(run=run, **_registered("py:routes/api_wave_d_asgi_routes.py#utilities_cover_lookup_local_select"))


def test_cover_lookup_save_remote_route_contract_reads_only_the_selected_album_at_production_library_size(
    library_app, tmp_path, monkeypatch,
):
    from music_app.routes import api_wave_d_asgi_routes
    from music_app.services import cover_lookup_tasks, covers

    # The Postgres notification store keeps the tasks it is given in one write.
    monkeypatch.setattr(cover_lookup_tasks, "upsert_cover_lookup_notifications", lambda *_args, **_kwargs: None)

    class SnapshotRepository:
        """The Postgres candidate-snapshot store resolves the selected album."""

        def __init__(self, _config):
            pass

        def resolve_album_id_for_track_paths(self, *, track_paths):
            return 7

    monkeypatch.setattr(api_wave_d_asgi_routes, "AlbumCoverCandidateSnapshotRepository", SnapshotRepository)
    queued: list[tuple[str, set[str]]] = []
    # Downloading and saving the image runs on its own registered worker.
    monkeypatch.setattr(
        api_wave_d_asgi_routes, "queue_cover_lookup_save_remote_task",
        lambda task_id, _album_root, track_paths, candidate_id, *_args, **_kwargs: queued.append((candidate_id, set(track_paths))),
    )
    match = {"id": "remote-1", "url": "https://covers.example/front.jpg", "source": "musicbrainz", "art_kind": "cover", "width": 1200, "height": 1200}

    def run(album_count: int) -> OperationCounts:
        album_root, track_paths, counts = _cover_lookup_library(library_app, tmp_path / f"main-{album_count}", album_count)
        album = {"id": 7, "name": "Album", "album_artist": "Selected", "tracks": [{"path": path} for path in track_paths]}
        task_id, _cancel = cover_lookup_tasks.create_cover_lookup_task(album, set(track_paths), config=library_app.state.config)
        cover_lookup_tasks.update_cover_lookup_task(
            task_id, config=library_app.state.config, possible_matches=[dict(match)], status="completed",
        )

        def request():
            status, _headers, body = run_asgi_request(
                library_app, "POST", "/utilities/cover-lookup/save-remote",
                json_body={"album": album, "task_id": task_id, "candidate_id": "remote-1"},
            )
            assert status == 200, body
            assert decode_json(body)["optimistic_cover_path"] == str(album_root / "cover.jpg")
            assert queued[-1] == ("remote-1", set(track_paths))

        request()
        counts.__init__()
        with count_filesystem_and_media(monkeypatch, counts, media_modules=(covers,)):
            request()
        return counts

    measure_scale_pair(run=run, **_registered("py:routes/api_wave_d_asgi_routes.py#utilities_cover_lookup_save_remote"))


def _problematic_rows(track_count: int) -> list[dict[str, object]]:
    """Inventory rows for `track_count` tracks, 12 per album; the first album
    has a mis-decoded title."""
    rows = []
    for track_index in range(track_count):
        album_index = track_index // 12
        artist = "Broadcast" if album_index == 0 else f"Artist {album_index:05d}"
        title = "Ã‰tÃ©" if track_index == 0 else f"Song {track_index}"
        path = f"/library/{artist}/Tender Buttons/{track_index % 12 + 1:02d}.mp3"
        rows.append({
            "album_id": album_index + 1, "album_key": f"{artist.casefold()}::tender buttons",
            "album_title": "Tender Buttons", "album_release_year": 2005, "album_cover_path": None,
            "album_metadata": {"album_artist": artist, "artists": [artist]}, "artist_name": artist,
            "track_id": track_index + 1, "track_key": f"track-{track_index}", "track_title": title,
            "track_number": track_index % 12 + 1, "disc_number": 1, "duration_seconds": 90,
            "file_private_path": path,
            "file_entry": {"path": path, "album": "Tender Buttons", "album_artist": artist, "artist": artist,
                           "title": title, "year": 2005, "track_number": track_index % 12 + 1, "disc_number": 1},
            "ignored_repair_keys": [], "separate_release_keys": [], "duplicate_file_count": 1,
        })
    return rows


@pytest.mark.parametrize("backend", ["in-memory", "postgres"])
@pytest.mark.parametrize("route", [
    ("py:routes/api_read_asgi_routes.py#utilities_problematic_file_detail", "/utilities/problematic-files/broadcast::tender buttons", {}),
    ("py:routes/api_read_asgi_routes.py#utilities_problematic_file_detail_query", "/utilities/problematic-files/detail",
     {"album_key": "broadcast::tender buttons"}),
], ids=["path", "query"])
def test_problematic_file_detail_route_contract_reads_only_the_selected_album_at_production_track_count(
    library_app, tmp_path, monkeypatch, route, backend,
):
    from music_app.routes import api_read_asgi_routes
    from music_app.services import library_browse_postgres, problematic_albums

    interaction_id, path, query = route
    # The Postgres rule-state store holds no ignored repairs for this library.
    monkeypatch.setattr(problematic_albums, "load_ignored_repair_keys", lambda _config: set())
    current: dict[str, object] = {}
    if backend == "postgres":
        monkeypatch.setattr(
            api_read_asgi_routes, "select_runtime_persistence_adapter",
            lambda seam_id, _config: SimpleNamespace(seam_id=seam_id, effective_backend="postgres"),
        )
        repository = library_browse_postgres.PostgresLibraryBrowseRepository

        def load_problematic_file_rows(_self, album_key=None, **_options):
            # The keyed Postgres read: `where album_key = %(album_key)s`.
            selected = [row for row in current["rows"] if row["album_key"] == album_key]
            current["counts"].candidate_rows += len(selected)
            return [dict(row) for row in selected]

        def load_relation_alias_maps(_self, **_options):
            # One Postgres read of the relation alias maps per request.
            current["counts"].sql_statements += 1
            return {"alias_to_canonical": {}}

        monkeypatch.setattr(repository, "_load_problematic_file_rows", load_problematic_file_rows)
        monkeypatch.setattr(repository, "_load_relation_alias_maps", load_relation_alias_maps)

    def run(track_count: int) -> OperationCounts:
        if backend == "postgres":
            counts = OperationCounts()
            current.update(rows=_problematic_rows(track_count), counts=counts)
        else:
            _album_paths, counts = _repairable_library(library_app, tmp_path / f"library-{track_count}", track_count)
        status, _headers, body = run_asgi_request(library_app, "GET", path, query=query)
        assert status == 200, body
        payload = decode_json(body)
        assert payload["key"] == "broadcast::tender buttons"
        assert len(payload["tracks"]) == 12
        assert "Encoding problem" in payload["problem_reasons"]
        return counts

    measure_scale_pair(run=run, **_registered(interaction_id))

