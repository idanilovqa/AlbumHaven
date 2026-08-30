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


def _canonical_relation_state(artist: str, *, built_at: float) -> dict[str, object]:
    return {
        "relation_views": {
            "artists": [artist],
            "artists_sidebar": [{"artist": artist, "count": 1}],
            "family_to_artists": {},
            "folder_related": {},
            "sidebar_families": [],
            "alias_to_canonical": {artist: artist},
            "canonical_to_aliases": {artist: [artist]},
        },
        "relations_last_built": built_at,
    }


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
    monkeypatch.setattr(move_executor_module, "library_root_cache_identity", lambda _config: "root-identity")
    monkeypatch.setattr(move_executor_module, "save_cache_to_disk_for_config", lambda *args, **kwargs: None)


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

    committed_relation_state = _canonical_relation_state("Broadcast", built_at=456.75)

    def fake_save_cache_to_disk_for_config(
        config,
        cache_path,
        file_cache,
        root_identity,
        last_scan,
        *,
        rebuild_relation_projection=False,
    ):
        assert rebuild_relation_projection is True
        seen["cache_save"] = {
            "config": config,
            "cache_path": cache_path,
            "file_cache_keys": set(file_cache),
            "root_identity": root_identity,
            "last_scan": last_scan,
            "rebuild_relation_projection": rebuild_relation_projection,
        }
        return committed_relation_state

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
    monkeypatch.setattr(move_executor_module, "library_root_cache_identity", lambda config: "root-1")
    monkeypatch.setattr(move_executor_module, "save_cache_to_disk_for_config", fake_save_cache_to_disk_for_config)
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
    assert seen["cache_save"] == {
        "config": explicit_config,
        "cache_path": explicit_config["CACHE_PATH"],
        "file_cache_keys": {str(destination_track)},
        "root_identity": "root-1",
        "last_scan": 123.0,
        "rebuild_relation_projection": True,
    }
    assert st["relation_views"] == committed_relation_state["relation_views"]
    assert st["relations_last_built"] == 456.75
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
    committed_relation_state = _canonical_relation_state("Broadcast", built_at=567.25)
    persistence_calls: list[dict[str, object]] = []

    def save_canonical_state(*args, **kwargs):
        assert kwargs == {"rebuild_relation_projection": True}
        persistence_calls.append({"args": args, "kwargs": kwargs})
        return committed_relation_state

    from music_app.services import move_executor as move_executor_module

    monkeypatch.setattr(
        move_executor_module,
        "save_cache_to_disk_for_config",
        save_canonical_state,
    )

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
    assert st["relation_views"] == committed_relation_state["relation_views"]
    assert st["relations_last_built"] == 567.25
    assert len(persistence_calls) == 1
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
    committed_relation_state = _canonical_relation_state("Broadcast", built_at=678.5)
    persistence_calls: list[dict[str, object]] = []

    def save_canonical_state(*args, **kwargs):
        assert kwargs == {"rebuild_relation_projection": True}
        persistence_calls.append({"args": args, "kwargs": kwargs})
        return committed_relation_state

    from music_app.services import move_executor as move_executor_module

    monkeypatch.setattr(
        move_executor_module,
        "save_cache_to_disk_for_config",
        save_canonical_state,
    )

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
    assert st["relation_views"] == committed_relation_state["relation_views"]
    assert st["relations_last_built"] == 678.5
    assert len(persistence_calls) == 1


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
