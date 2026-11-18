from __future__ import annotations

from datetime import date
from pathlib import Path
from types import SimpleNamespace

import pytest

from music_app.services.move_executor import AlbumMoveError, execute_album_move
from music_app.services.move_tasks import build_completed_move_task, build_move_follow_up, build_move_response
from music_app.services.edit_state import find_album_dicts_by_track_paths, rebuild_affected_albums_in_state
from tests.py.runtime_testing import configure_test_app_paths


@pytest.fixture
def config(tmp_path, monkeypatch):
    paths = configure_test_app_paths(tmp_path, monkeypatch)
    paths["data_dir"].mkdir(parents=True, exist_ok=True)
    paths["music_dir"].mkdir(parents=True, exist_ok=True)
    return {
        "DATA_DIR": paths["data_dir"],
        "MUSIC_DIR": paths["music_dir"],
        "CACHE_PATH": paths["cache_path"],
        "COVER_CACHE_PATH": paths["cover_cache_path"],
        "LIBRARY_ROOTS_PATH": paths["library_roots_path"],
        "IMAGE_EXTENSIONS": {".jpg", ".jpeg", ".png"},
        "TESTING": True,
    }


@pytest.fixture
def logger():
    return SimpleNamespace(name="move-test-logger", log=lambda *args, **kwargs: None)


@pytest.fixture
def library_state():
    return {}


def test_move_executor_tests_do_not_depend_on_flask_runtime_helpers():
    source = Path(__file__).read_text()
    forbidden_terms = [
        "tests.py." "flask_fixtures",
        "from " "flask",
        "has_" "app_context",
        "app." "app_context(",
        "app." "config",
        "app." "logger",
        "app." "library_state",
    ]

    assert not [term for term in forbidden_terms if term in source]


def _make_track(path: Path) -> SimpleNamespace:
    return SimpleNamespace(
        path=str(path),
        title=path.stem,
        track_number=1,
        disc_number=1,
        disc_number_raw="1",
        artist="Broadcast",
        album="Tender Buttons",
        album_artist="Broadcast",
        year=2004,
        release_date="2004",
        edition="",
        album_rating=0,
        exception_type=None,
        duration_seconds=180,
        cover_path=None,
    )


def _record_moved_album_publication(monkeypatch, calls: list[dict[str, object]]) -> None:
    from music_app.services import move_executor as move_executor_module

    def persist(config, **kwargs):
        calls.append(kwargs)
        return {
            "inventory_mutation_revision": 9,
            "affected_album_keys": ["arrival-album"],
            "new_track_paths": [],
        }

    monkeypatch.setattr(move_executor_module, "persist_moved_album_inventory_for_config", persist)


def _seed_arrivals_album_state(library_state: dict[str, object], *, track_path: Path) -> dict[str, object]:
    st = library_state
    track = _make_track(track_path)
    album = SimpleNamespace(
        key="arrival-album",
        name="Tender Buttons",
        album_artist="Broadcast",
        artists=["Broadcast"],
        is_compilation=False,
        cover_path=None,
        year=2004,
        release_date="2004",
        edition="",
        album_rating=0,
        total_duration_seconds=180,
        library_root_id="arrivals-1",
        library_root_category="new_arrivals",
        root_provenance={
            "root_ids": ["arrivals-1"],
            "categories": ["new_arrivals"],
            "category_labels": ["New Arrivals"],
            "primary_category": "new_arrivals",
            "primary_category_label": "New Arrivals",
            "badges": ["New"],
            "is_mixed": False,
        },
        tracks=[track],
    )
    st["albums"] = [album]
    st["separate_release_keys"] = set()
    st["relation_views"] = {"artists": {}, "alias_to_canonical": {}}
    st["file_cache"] = {
        str(track_path): {
            "path": str(track_path),
            "mtime": track_path.stat().st_mtime,
            "size": track_path.stat().st_size,
            "album": "Tender Buttons",
            "album_artist": "Broadcast",
            "title": track_path.stem,
            "track_number": 1,
            "disc_number": 1,
            "disc_number_raw": "1",
            "artist": "Broadcast",
            "duration_seconds": 180,
            "cover_path": None,
            "local_cover_width": None,
            "local_cover_height": None,
            "remote_cover_url": "https://example.test/cover.jpg",
            "remote_cover_thumbnail_url": None,
            "remote_cover_source": "apple_music",
            "remote_cover_source_label": "Apple Music",
            "remote_cover_album_url": None,
            "remote_cover_width": None,
            "remote_cover_height": None,
            "year": 2004,
            "release_date": "2004",
            "edition": "",
            "album_rating": 0,
            "library_root_id": "arrivals-1",
            "library_root_category": "new_arrivals",
            "exception_type": None,
        },
    }
    return st


def _install_move_root_settings(monkeypatch, *, main_root: Path, hoard_root: Path, arrivals_root: Path) -> None:
    from music_app.services import move_executor as move_executor_module
    from music_app.services import move_planner as move_planner_module

    settings = {
        "main_library_roots": [{"id": "main-1", "path": str(main_root), "layout_mode": "artist"}],
        "hoarding_library_roots": [{"id": "hoard-1", "path": str(hoard_root)}],
        "new_arrivals_roots": [{"id": "arrivals-1", "path": str(arrivals_root)}],
        "move_policy": {
            "preferred_main_write_root": "main-1",
            "move_new_arrivals_to": "hoard-1",
        },
    }
    roots = [
        {"id": "main-1", "path": str(main_root), "layout_mode": "artist", "category": "main_library_roots"},
        {"id": "hoard-1", "path": str(hoard_root), "category": "hoarding_library_roots"},
        {"id": "arrivals-1", "path": str(arrivals_root), "category": "new_arrivals_roots"},
    ]
    monkeypatch.setattr(
        move_executor_module,
        "build_move_availability_payload",
        lambda album, config: move_planner_module.build_move_availability_payload(
            album,
            config,
            load_settings=lambda _config: settings,
        ),
    )
    monkeypatch.setattr(move_executor_module, "get_library_roots", lambda _config: roots)
    monkeypatch.setattr(move_executor_module, "load_exception_overrides", lambda _config: {})
    monkeypatch.setattr(move_executor_module, "load_separate_release_keys", lambda _config: set())
    _record_moved_album_publication(monkeypatch, [])


def test_execute_album_move_runs_without_flask_app_context_using_explicit_dependencies(tmp_path, monkeypatch):
    from music_app.services import move_executor as move_executor_module

    arrivals_root = (tmp_path / "arrivals").resolve()
    hoard_root = (tmp_path / "hoard").resolve()
    source_folder = arrivals_root / "Broadcast" / "Tender Buttons"
    destination_folder = hoard_root / "2026 Arrivals" / "2004 - Broadcast - Tender Buttons"
    track_path = source_folder / "01 - I Found the F.mp3"
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")

    explicit_config = {
        "CACHE_PATH": tmp_path / "library_cache.json",
        "IMAGE_EXTENSIONS": {".jpg", ".jpeg"},
    }
    explicit_logger = SimpleNamespace(name="move-test-logger")
    st = {
        "albums": [
            SimpleNamespace(
                key="arrival-album",
                tracks=[_make_track(track_path)],
            )
        ],
        "file_cache": {
            str(track_path): {
                "path": str(track_path),
                "mtime": track_path.stat().st_mtime,
                "size": track_path.stat().st_size,
                "album": "Tender Buttons",
                "album_artist": "Broadcast",
                "title": track_path.stem,
                "track_number": 1,
                "disc_number": 1,
                "disc_number_raw": "1",
                "artist": "Broadcast",
                "duration_seconds": 180,
                "cover_path": None,
            },
        },
        "last_scan": 123.0,
        "separate_release_keys": {"existing-separate-release"},
    }
    seen: dict[str, object] = {}

    def fake_availability(album, config):
        assert album is st["albums"][0]
        assert config is explicit_config
        return {
            "source_folder": str(source_folder),
            "actions": {
                "move_to_hoard": {
                    "available": True,
                    "destination_path": str(destination_folder),
                    "target_category": "hoard",
                }
            },
        }

    def fake_get_library_roots(config):
        seen.setdefault("root_configs", []).append(config)
        assert config is explicit_config
        return [
            {"id": "arrivals-1", "path": str(arrivals_root), "category": "new_arrivals"},
            {"id": "hoard-1", "path": str(hoard_root), "category": "hoard"},
        ]

    def fake_read_metadata(path):
        return {
            "path": str(path),
            "mtime": path.stat().st_mtime,
            "size": path.stat().st_size,
            "album": "Tender Buttons",
            "album_artist": "Broadcast",
            "title": path.stem,
            "track_number": 1,
            "disc_number": 1,
            "disc_number_raw": "1",
            "artist": "Broadcast",
            "duration_seconds": 180,
            "cover_path": None,
        }

    def fake_log_app_event(config, logger, message, **kwargs):
        seen["log"] = {
            "config": config,
            "logger": logger,
            "message": message,
        }

    monkeypatch.setattr(move_executor_module, "build_move_availability_payload", fake_availability)
    monkeypatch.setattr(move_executor_module, "get_library_roots", fake_get_library_roots)
    monkeypatch.setattr(move_executor_module, "load_exception_overrides", lambda config: {})
    monkeypatch.setattr(move_executor_module, "apply_exception_override", lambda entry, overrides: None)
    monkeypatch.setattr(move_executor_module, "find_cover_for_track_folder", lambda folder, image_extensions: None)
    monkeypatch.setattr(move_executor_module, "read_metadata_for_file", fake_read_metadata)
    publications: list[dict[str, object]] = []
    _record_moved_album_publication(monkeypatch, publications)
    monkeypatch.setattr(move_executor_module, "log_app_event", fake_log_app_event)

    payload = execute_album_move(
        action="move_to_hoard",
        album_key="arrival-album",
        config=explicit_config,
        logger=explicit_logger,
        get_state=lambda: st,
        rebuild_affected_albums_in_state=lambda *args, **kwargs: None,
        find_albums_by_track_paths=lambda track_paths: [{"key": "moved-album", "paths": sorted(track_paths)}],
        find_problematic_album_by_track_paths=lambda track_paths: None,
    )

    destination_track = destination_folder / track_path.name
    assert payload["ok"] is True
    assert destination_track.exists()
    assert str(destination_track) in st["file_cache"]
    assert publications == [{
        "root_id": "hoard-1",
        "active_file_entries": {str(destination_track): st["file_cache"][str(destination_track)]},
        "moves": ({
            "source_path": str(source_folder),
            "destination_path": str(destination_folder),
            "source_root_id": "arrivals-1",
            "destination_root_id": "hoard-1",
            "is_directory": True,
        },),
    }]
    assert st["inventory_mutation_revision"] == 9
    assert st["targeted_inventory_album_keys"] == ("arrival-album",)
    assert payload["move_task"]["moved_track_paths"] == [str(destination_track)]
    assert seen["log"] == {
        "config": explicit_config,
        "logger": explicit_logger,
        "message": "Album moved",
    }
    assert seen["root_configs"] == [explicit_config, explicit_config, explicit_config]


def test_execute_album_move_moves_arrivals_album_and_refreshes_state(config, logger, library_state, monkeypatch):
    arrivals_root = (config["DATA_DIR"] / "arrivals").resolve()
    hoard_root = (config["DATA_DIR"] / "hoard").resolve()
    main_root = (config["DATA_DIR"] / "library").resolve()
    track_path = arrivals_root / "Broadcast" / "Tender Buttons" / "01 - I Found the F.mp3"
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")

    _install_move_root_settings(
        monkeypatch,
        main_root=main_root,
        hoard_root=hoard_root,
        arrivals_root=arrivals_root,
    )
    st = _seed_arrivals_album_state(library_state, track_path=track_path)
    problematic_requests: list[set[str]] = []
    follow_up_requests: list[set[str]] = []
    persistence_calls: list[dict[str, object]] = []
    _record_moved_album_publication(monkeypatch, persistence_calls)
    previous_relation_views = st["relation_views"]

    def build_follow_up(track_paths, **kwargs):
        follow_up_requests.append(set(track_paths))
        return build_move_follow_up(track_paths, **kwargs)

    payload = execute_album_move(
        action="move_to_hoard",
        requested_track_paths={str(track_path)},
        config=config,
        logger=logger,
        get_state=lambda: st,
        rebuild_affected_albums_in_state=lambda st, previous_file_cache, updated_file_cache, changed_paths, separate_release_keys: rebuild_affected_albums_in_state(
            st,
            previous_file_cache,
            updated_file_cache,
            changed_paths,
            separate_release_keys,
        ),
        find_albums_by_track_paths=lambda track_paths: find_album_dicts_by_track_paths(
            list(st.get("albums", [])),
            track_paths,
        ),
        find_problematic_album_by_track_paths=lambda track_paths: problematic_requests.append(set(track_paths)) or None,
        build_follow_up=build_follow_up,
    )

    destination_track = (
        hoard_root
        / f"{date.today().year} Arrivals"
        / "2004 - Broadcast - Tender Buttons"
        / "01 - I Found the F.mp3"
    )
    assert payload["ok"] is True
    assert payload["destination_folder"] == str(destination_track.parent)
    assert payload["requires_view_refresh"] is True
    assert payload["updated_album"]["library_root_category"] == "hoard"
    assert len(payload["updated_albums"]) == 1
    assert payload["updated_albums"][0]["tracks"][0]["path"] == str(destination_track)
    assert payload["move_task"]["kind"] == "move-album"
    assert payload["move_task"]["status"] == "completed"
    assert payload["move_task"]["moved_track_paths"] == [str(destination_track)]
    assert payload["move_task"]["requires_view_refresh"] is True
    assert not track_path.exists()
    assert destination_track.exists()
    assert str(track_path) not in st["file_cache"]
    assert str(destination_track) in st["file_cache"]
    assert st["file_cache"][str(destination_track)]["remote_cover_source_label"] == "Apple Music"
    assert st["relation_views"] is previous_relation_views
    assert len(persistence_calls) == 1
    assert set(persistence_calls[0]["active_file_entries"]) == {str(destination_track)}
    assert follow_up_requests == [{str(destination_track)}]
    assert problematic_requests == [{str(destination_track)}]


def test_execute_album_move_accepts_album_key_without_track_paths(config, logger, library_state, monkeypatch):
    arrivals_root = (config["DATA_DIR"] / "arrivals").resolve()
    hoard_root = (config["DATA_DIR"] / "hoard").resolve()
    main_root = (config["DATA_DIR"] / "library").resolve()
    track_path = arrivals_root / "Broadcast" / "Tender Buttons" / "01 - I Found the F.mp3"
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")

    _install_move_root_settings(
        monkeypatch,
        main_root=main_root,
        hoard_root=hoard_root,
        arrivals_root=arrivals_root,
    )
    st = _seed_arrivals_album_state(library_state, track_path=track_path)
    persistence_calls: list[dict[str, object]] = []
    _record_moved_album_publication(monkeypatch, persistence_calls)
    previous_relation_views = st["relation_views"]

    payload = execute_album_move(
        action="move_to_hoard",
        album_key="arrival-album",
        config=config,
        logger=logger,
        get_state=lambda: st,
        rebuild_affected_albums_in_state=lambda st, previous_file_cache, updated_file_cache, changed_paths, separate_release_keys: rebuild_affected_albums_in_state(
            st,
            previous_file_cache,
            updated_file_cache,
            changed_paths,
            separate_release_keys,
        ),
        find_albums_by_track_paths=lambda track_paths: find_album_dicts_by_track_paths(
            list(st.get("albums", [])),
            track_paths,
        ),
        find_problematic_album_by_track_paths=lambda track_paths: None,
    )

    destination_track = (
        hoard_root
        / f"{date.today().year} Arrivals"
        / "2004 - Broadcast - Tender Buttons"
        / "01 - I Found the F.mp3"
    )
    assert payload["ok"] is True
    assert destination_track.exists()
    assert payload["move_task"]["moved_track_paths"] == [str(destination_track)]
    assert st["relation_views"] is previous_relation_views
    assert len(persistence_calls) == 1
    assert set(persistence_calls[0]["active_file_entries"]) == {str(destination_track)}


def test_execute_album_move_reports_a_readable_error_when_publication_fails(config, logger, library_state, monkeypatch):
    from music_app.services import move_executor as move_executor_module

    arrivals_root = (config["DATA_DIR"] / "arrivals").resolve()
    track_path = arrivals_root / "Broadcast" / "Tender Buttons" / "01 - I Found the F.mp3"
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    _install_move_root_settings(
        monkeypatch,
        main_root=(config["DATA_DIR"] / "library").resolve(),
        hoard_root=(config["DATA_DIR"] / "hoard").resolve(),
        arrivals_root=arrivals_root,
    )
    st = _seed_arrivals_album_state(library_state, track_path=track_path)

    def fail(_config, **_kwargs):
        raise RuntimeError("Some library changes may have been missed.")

    monkeypatch.setattr(move_executor_module, "persist_moved_album_inventory_for_config", fail)

    with pytest.raises(AlbumMoveError) as excinfo:
        execute_album_move(
            action="move_to_hoard",
            album_key="arrival-album",
            config=config,
            logger=logger,
            get_state=lambda: st,
            rebuild_affected_albums_in_state=lambda *args, **kwargs: None,
            find_albums_by_track_paths=lambda track_paths: [],
            find_problematic_album_by_track_paths=lambda track_paths: None,
        )

    assert excinfo.value.status_code == 500
    assert str(excinfo.value) == (
        "Album folder moved but library publication failed: Some library changes may have been missed."
    )
    assert "inventory_mutation_revision" not in st


def test_execute_album_move_collision_leaves_state_and_files_unchanged(config, logger, library_state, monkeypatch):
    arrivals_root = (config["DATA_DIR"] / "arrivals").resolve()
    hoard_root = (config["DATA_DIR"] / "hoard").resolve()
    main_root = (config["DATA_DIR"] / "library").resolve()
    track_path = arrivals_root / "Broadcast" / "Tender Buttons" / "01 - I Found the F.mp3"
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")

    destination_folder = hoard_root / f"{date.today().year} Arrivals" / "2004 - Broadcast - Tender Buttons"
    destination_folder.mkdir(parents=True, exist_ok=True)
    (destination_folder / "existing.mp3").write_bytes(b"track")

    _install_move_root_settings(
        monkeypatch,
        main_root=main_root,
        hoard_root=hoard_root,
        arrivals_root=arrivals_root,
    )
    st = _seed_arrivals_album_state(library_state, track_path=track_path)
    previous_file_cache = dict(st["file_cache"])
    previous_album_paths = {
        str(getattr(track, "path", "") or "")
        for album in st["albums"]
        for track in getattr(album, "tracks", []) or []
    }

    with pytest.raises(AlbumMoveError) as excinfo:
        execute_album_move(
            action="move_to_hoard",
            requested_track_paths={str(track_path)},
            config=config,
            logger=logger,
            get_state=lambda: st,
            rebuild_affected_albums_in_state=lambda *args, **kwargs: None,
            find_albums_by_track_paths=lambda track_paths: [],
            find_problematic_album_by_track_paths=lambda track_paths: None,
        )

    assert excinfo.value.status_code == 409
    assert str(excinfo.value) == "Destination folder already exists"
    assert track_path.exists()
    assert st["file_cache"] == previous_file_cache
    assert {
        str(getattr(track, "path", "") or "")
        for album in st["albums"]
        for track in getattr(album, "tracks", []) or []
    } == previous_album_paths


def test_execute_album_move_rejects_source_folder_outside_configured_new_arrivals_roots(
    config,
    logger,
    library_state,
    monkeypatch,
):
    unsafe_source_root = (config["DATA_DIR"] / "unsafe-source").resolve()
    hoard_root = (config["DATA_DIR"] / "hoard").resolve()
    main_root = (config["DATA_DIR"] / "library").resolve()
    arrivals_root = (config["DATA_DIR"] / "arrivals").resolve()
    track_path = unsafe_source_root / "Broadcast" / "Tender Buttons" / "01 - I Found the F.mp3"
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")

    _install_move_root_settings(
        monkeypatch,
        main_root=main_root,
        hoard_root=hoard_root,
        arrivals_root=arrivals_root,
    )
    st = _seed_arrivals_album_state(library_state, track_path=track_path)
    previous_file_cache = dict(st["file_cache"])

    with pytest.raises(AlbumMoveError) as excinfo:
        execute_album_move(
            action="move_to_hoard",
            requested_track_paths={str(track_path)},
            config=config,
            logger=logger,
            get_state=lambda: st,
            rebuild_affected_albums_in_state=lambda *args, **kwargs: None,
            find_albums_by_track_paths=lambda track_paths: [],
            find_problematic_album_by_track_paths=lambda track_paths: None,
        )

    assert excinfo.value.status_code == 409
    assert str(excinfo.value) == "Album source folder is outside the configured New Arrivals roots"
    assert track_path.exists()
    assert st["file_cache"] == previous_file_cache


def test_build_move_follow_up_collects_refreshed_album_and_problematic_payload():
    follow_up = build_move_follow_up(
        {"track-1.mp3"},
        find_albums_by_track_paths=lambda track_paths: [{"key": "album-1", "paths": sorted(track_paths)}],
        find_problematic_album_by_track_paths=lambda track_paths: {"key": "problem-1", "paths": sorted(track_paths)},
    )

    assert follow_up == {
        "updated_album": {"key": "album-1", "paths": ["track-1.mp3"]},
        "updated_albums": [{"key": "album-1", "paths": ["track-1.mp3"]}],
        "updated_problematic_album": {"key": "problem-1", "paths": ["track-1.mp3"]},
        "requires_view_refresh": True,
    }


def test_build_move_response_keeps_legacy_fields_and_attaches_move_task_metadata():
    follow_up = {
        "updated_album": {"key": "album-1"},
        "updated_albums": [{"key": "album-1"}],
        "updated_problematic_album": None,
        "requires_view_refresh": True,
    }

    payload = build_move_response(
        action="move_to_hoard",
        source_folder="C:\\source",
        destination_folder="C:\\dest",
        moved_track_paths={"track-1.mp3"},
        follow_up=follow_up,
    )

    assert payload["ok"] is True
    assert payload["updated_album"] == {"key": "album-1"}
    assert payload["updated_albums"] == [{"key": "album-1"}]
    assert payload["requires_view_refresh"] is True
    assert payload["move_task"]["kind"] == "move-album"
    assert payload["move_task"]["status"] == "completed"
    assert payload["move_task"]["action"] == "move_to_hoard"
    assert payload["move_task"]["source_folder"] == "C:\\source"
    assert payload["move_task"]["destination_folder"] == "C:\\dest"
    assert payload["move_task"]["moved_track_paths"] == ["track-1.mp3"]
    assert payload["move_task"]["updated_album_count"] == 1
    assert payload["move_task"]["created_at"]


def test_build_completed_move_task_tracks_refresh_metadata():
    task = build_completed_move_task(
        action="move_to_library",
        source_folder="C:\\source",
        destination_folder="C:\\dest",
        moved_track_paths={"track-1.mp3", "track-2.mp3"},
        follow_up={
            "updated_albums": [{"key": "album-1"}],
            "requires_view_refresh": True,
        },
    )

    assert task["kind"] == "move-album"
    assert task["status"] == "completed"
    assert task["action"] == "move_to_library"
    assert task["moved_track_count"] == 2
    assert task["updated_album_count"] == 1
    assert task["requires_view_refresh"] is True


def test_move_cache_refresh_contract_reads_only_moved_tracks_at_production_library_size(config, tmp_path, monkeypatch):
    from music_app.services import metadata
    from music_app.services import move_executor as move_executor_module
    from tests.py.bounded_interactions import OperationCounts, measure_scale_pair
    from tests.py.filesystem_operation_counting import count_filesystem_and_media

    main_root = (tmp_path / "main").resolve()
    destination = main_root / "Broadcast" / "2004 - Tender Buttons"
    destination.mkdir(parents=True)
    (destination / "booklet-front.jpg").write_bytes(b"not decoded")
    moved = {}
    for index in range(10):
        new_path = destination / f"{index:02d}.mp3"
        new_path.write_bytes(b"track")
        moved[str(tmp_path / "arrivals" / f"{index:02d}.mp3")] = str(new_path)
    monkeypatch.setattr(move_executor_module, "get_library_roots", lambda _config: [
        {"id": "main-1", "path": str(main_root), "category": "main_library_roots"},
    ])
    monkeypatch.setattr(move_executor_module, "load_exception_overrides", lambda _config: {})

    def run(album_count: int) -> OperationCounts:
        previous_file_cache = {
            f"{tmp_path}/library/Artist {index}/track.mp3": {"title": "unrelated"}
            for index in range(album_count * 160)
        }
        previous_file_cache.update({old_path: {"title": "moved"} for old_path in moved})
        counts = OperationCounts()
        with count_filesystem_and_media(monkeypatch, counts, media_modules=(metadata,)):
            updated, new_paths = move_executor_module._refresh_cache_after_move(
                config=config,
                previous_file_cache=previous_file_cache,
                track_path_map=moved,
            )
        assert new_paths == set(moved.values())
        assert not set(moved) & set(updated)
        return counts

    small, production = measure_scale_pair(
        interaction_id="py:services/move_executor.py#_refresh_cache_after_move",
        small=20,
        large=1_000,
        run=run,
        budgets={"filesystem_enumerations": 1, "stat_calls": 96, "open_calls": 11, "media_parses": 10},
        growth=("stat_calls", 0),
    )
    assert small.media_parses == production.media_parses == len(moved)


class _Rows:
    description = ("rows",)
    rowcount = -1

    def __init__(self, rows):
        self._rows = list(rows)

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return list(self._rows)

    def __iter__(self):
        return iter(self._rows)


class _MovedAlbumDatabase:
    """Postgres double: one moved album inside a library of `track_count` tracks.

    Only library-wide reads (relation source rows, an unfiltered file load)
    return `track_count` rows, so any global work shows up as growth.
    """

    def __init__(self, *, track_count: int, old_path: str, album_key: str):
        self.track_count = track_count
        self.old_path = old_path
        self.album_key = album_key
        self.executed: list[str] = []
        self.commits = 0

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def commit(self):
        self.commits += 1

    def pipeline(self):
        from contextlib import nullcontext

        return nullcontext()

    def execute(self, sql, params=None):
        text = " ".join(str(sql).split()).lower()
        self.executed.append(text)
        if "relation_locations as materialized" in text or (
            "{scan_cache,file_entry}" in text and set(params or {}) == {"source"}
        ):
            return _Rows({"private_path": f"/library/{index}.mp3"} for index in range(self.track_count))
        if "watch_health_load" in text:
            return _Rows([{"library_watch_health": {}}])
        if "bootstrap_context_ready" in text:
            return _Rows([{"bootstrap_context_ready": 1}])
        if "as album_owner_key" in text:
            return _Rows([{
                "private_path": self.old_path,
                "album_key": self.album_key,
                "album_owner_key": "broadcast",
                "album_title": "Tender Buttons",
                "album_artist": "Broadcast",
            }])
        if "as affected_album_key" in text:
            return _Rows([{"affected_album_key": self.album_key}])
        if "update library.libraries" in text and "inventory_mutation_revision" in text:
            return _Rows([{"inventory_mutation_revision": 11}])
        return _Rows([])


def test_move_album_contract_publishes_only_the_moved_album_at_production_track_count(config, logger, tmp_path, monkeypatch):
    from music_app.services import cache as cache_module
    from music_app.services import move_executor as move_executor_module
    from music_app.services import relation_projection_builder, scan_cache_persistence
    from music_app.services import state as state_module
    from music_app.services.scan_cache_persistence import PostgresScanCacheAdapter
    from tests.py.bounded_interactions import CountingConnection, OperationCounts, measure_scale_pair

    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    monkeypatch.setattr(state_module, "library_browse_postgres_is_effective", lambda _config: False)
    monkeypatch.setattr(state_module, "invalidate_postgres_utility_projection_cache", lambda **_kwargs: None)
    current: dict[str, OperationCounts] = {}

    def count_global_relation_work(module, name):
        original = getattr(module, name)

        def counted(*args, **kwargs):
            current["counts"].builder_calls += 1
            return original(*args, **kwargs)

        monkeypatch.setattr(module, name, counted)

    for module, name in (
        (scan_cache_persistence, "load_relation_source_rows_sql"),
        (scan_cache_persistence, "relation_source_fingerprint"),
        (scan_cache_persistence, "build_relation_views_from_postgres_rows"),
        (relation_projection_builder, "build_postgres_relation_views"),
    ):
        count_global_relation_work(module, name)
    # The background owner that rebuilds the stale relation projection.
    monkeypatch.setattr(
        state_module,
        "schedule_gallery_projection_refresh",
        lambda _config, **_kwargs: current["counts"].count("invalidations"),
    )

    def run(track_count: int) -> OperationCounts:
        run_root = tmp_path / f"library-{track_count}"
        arrivals_root = (run_root / "arrivals").resolve()
        hoard_root = (run_root / "hoard").resolve()
        track_path = arrivals_root / "Broadcast" / "Tender Buttons" / "01 - I Found the F.mp3"
        track_path.parent.mkdir(parents=True)
        track_path.write_bytes(b"track")
        _install_move_root_settings(
            monkeypatch,
            main_root=(run_root / "library").resolve(),
            hoard_root=hoard_root,
            arrivals_root=arrivals_root,
        )
        monkeypatch.setattr(
            move_executor_module,
            "persist_moved_album_inventory_for_config",
            cache_module.persist_moved_album_inventory_for_config,
        )
        st = _seed_arrivals_album_state({}, track_path=track_path)
        for index in range(track_count - 1):
            st["file_cache"][f"{run_root}/library/Artist {index}/track.mp3"] = {"title": "unrelated"}
        st["albums"].extend(SimpleNamespace(key=f"unrelated-{index}", tracks=[]) for index in range(track_count // 10))
        relation_views = st["relation_views"]
        counts = current["counts"] = OperationCounts()
        database = _MovedAlbumDatabase(track_count=track_count, old_path=str(track_path), album_key="arrival-album")
        move_config = {**config, "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://isolated.invalid/move"}
        monkeypatch.setattr(
            cache_module,
            "_select_runtime_scan_cache_adapter",
            lambda _config: PostgresScanCacheAdapter(
                move_config,
                connect=lambda _url: CountingConnection(database, counts),
            ),
        )

        payload = execute_album_move(
            action="move_to_hoard",
            album_key="arrival-album",
            config=move_config,
            logger=logger,
            get_state=lambda: st,
            rebuild_affected_albums_in_state=rebuild_affected_albums_in_state,
            find_albums_by_track_paths=lambda track_paths: find_album_dicts_by_track_paths(list(st["albums"]), track_paths),
            find_problematic_album_by_track_paths=lambda track_paths: None,
        )

        destination_track = (
            hoard_root / f"{date.today().year} Arrivals" / "2004 - Broadcast - Tender Buttons" / track_path.name
        )
        assert payload["ok"] is True
        assert destination_track.exists() and not track_path.exists()
        assert payload["updated_album"]["library_root_category"] == "hoard"
        assert str(destination_track) in st["file_cache"] and str(track_path) not in st["file_cache"]
        assert st["inventory_mutation_revision"] == 11
        assert st["relation_views"] is relation_views
        assert database.commits == 1
        assert any(
            "update library.libraries" in sql and "relation_projection,status" in sql
            for sql in database.executed
        ), "the move must leave the relation projection stale for the background rebuild"
        return counts

    small, production = measure_scale_pair(
        interaction_id="py:routes/api_wave_a_asgi_routes.py#utilities_move_album",
        small=20,
        large=160_000,
        run=run,
        budgets={"builder_calls": 0, "returned_rows": 6, "sql_statements": 29, "invalidations": 1},
        growth=("returned_rows", 0),
    )
    assert small.invalidations == production.invalidations == 1
    assert small.sql_statements == production.sql_statements
