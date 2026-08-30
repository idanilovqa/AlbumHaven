from __future__ import annotations

import hashlib
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

from music_app.services import cover_refresh_execution
from music_app.services import state as state_module
from tests.py.runtime_testing import configure_test_app_paths


class _LoggerStub:
    def __init__(self) -> None:
        self.handlers = []
        self.parent = None
        self.propagate = False
        self.verbose_messages: list[tuple[str, tuple[object, ...]]] = []
        self.info_messages: list[tuple[str, tuple[object, ...]]] = []
        self.warning_messages: list[tuple[str, tuple[object, ...]]] = []
        self.exception_messages: list[tuple[str, tuple[object, ...]]] = []

    def verbose(self, message: str, *args: object, **kwargs: object) -> None:
        self.verbose_messages.append((message, args))

    def info(self, message: str, *args: object, **kwargs: object) -> None:
        self.info_messages.append((message, args))

    def warning(self, message: str, *args: object, **kwargs: object) -> None:
        self.warning_messages.append((message, args))

    def exception(self, message: str, *args: object, **kwargs: object) -> None:
        self.exception_messages.append((message, args))


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
        "MUSICBRAINZ_USER_AGENT": "AlbumHavenTests/1.0",
        "SUPPORTED_EXTENSIONS": {".mp3", ".flac"},
        "TESTING": True,
    }


@pytest.fixture
def logger():
    return _LoggerStub()


@pytest.fixture
def library_state():
    carrier = SimpleNamespace()
    state_module.init_state(carrier)
    return carrier.library_state


def test_state_tests_do_not_depend_on_flask_runtime_helpers():
    source = Path(__file__).read_text(encoding="utf-8")
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


def test_execute_cover_job_returns_local_cover_when_remote_lookup_raises(tmp_path: Path, monkeypatch):
    folder = tmp_path / "Artist" / "Album"
    folder.mkdir(parents=True)
    cover_path = folder / "cover.jpg"
    cover_path.write_bytes(b"cover")

    monkeypatch.setattr(
        cover_refresh_execution.cover_refresh_provider,
        "ensure_best_cover_for_folder",
        lambda **kwargs: (_ for _ in ()).throw(RuntimeError("boom")),
    )

    resolved_cover, downloaded, detail = cover_refresh_execution.execute_cover_job(
        job={
            "folder": folder,
            "artist": "Artist",
            "album": "Album",
            "edition": "",
            "year": 1999,
        },
        image_extensions={".jpg"},
        user_agent="Album Haven Test",
        cover_cache=None,
        force_search=False,
        allow_apple_web_fallback=False,
        allow_apple_web_fallback_when_has_cover=False,
        negative_cache_ttl_seconds=None,
    )

    assert resolved_cover == cover_path
    assert downloaded is False
    assert detail["artist"] == "Artist"
    assert detail["album"] == "Album"
    assert detail["folder"] == str(folder)
    assert detail["reason"] == "exception_during_cover_fetch"
    assert detail["error"] == "boom"


def test_execute_cover_job_uses_extracted_refresh_provider_seam(tmp_path: Path, monkeypatch):
    folder = tmp_path / "Artist" / "Album"
    folder.mkdir(parents=True)
    cover_path = folder / "cover.jpg"
    cover_cache = object()
    captured = []

    def fake_ensure_best_cover_for_folder(**kwargs):
        captured.append(kwargs)
        return cover_path, True, {"reason": "cover_written", "written_path": str(cover_path)}

    monkeypatch.setattr(
        cover_refresh_execution.cover_refresh_provider,
        "ensure_best_cover_for_folder",
        fake_ensure_best_cover_for_folder,
    )

    resolved_cover, downloaded, detail = cover_refresh_execution.execute_cover_job(
        job={
            "folder": folder,
            "artist": "Artist",
            "album": "Album",
            "edition": "Deluxe",
            "year": 1999,
        },
        image_extensions={".jpg"},
        user_agent="Album Haven Test",
        cover_cache=cover_cache,
        force_search=True,
        allow_apple_web_fallback=True,
        allow_apple_web_fallback_when_has_cover=False,
        negative_cache_ttl_seconds=12.5,
    )

    assert resolved_cover == cover_path
    assert downloaded is True
    assert detail["reason"] == "cover_written"
    assert captured == [{
        "folder": folder,
        "artist": "Artist",
        "album": "Album",
        "edition": "Deluxe",
        "year": 1999,
        "image_extensions": {".jpg"},
        "cache": cover_cache,
        "user_agent": "Album Haven Test",
        "force_search": True,
        "allow_apple_web_fallback": True,
        "allow_apple_web_fallback_when_has_cover": False,
        "negative_cache_ttl_seconds": 12.5,
    }]


def test_execute_cover_job_marks_automatic_writes_and_requests_user_origin_recheck(
    tmp_path: Path,
    monkeypatch,
):
    folder = tmp_path / "Artist" / "Album"
    folder.mkdir(parents=True)
    cover_path = folder / "cover.jpg"
    captured = {}

    def fake_ensure_best_cover_for_folder(**kwargs):
        captured.update(kwargs)
        return cover_path, True, {"reason": "cover_written", "written_path": str(cover_path)}

    monkeypatch.setattr(
        cover_refresh_execution.cover_refresh_provider,
        "ensure_best_cover_for_folder",
        fake_ensure_best_cover_for_folder,
    )

    cover_refresh_execution.execute_cover_job(
        job={
            "folder": folder,
            "artist": "Artist",
            "album": "Album",
            "track_paths": [str(folder / "song.mp3")],
            "cover_selection_origin": None,
        },
        image_extensions={".jpg"},
        user_agent="Album Haven Test",
        cover_cache=object(),
        force_search=False,
        allow_apple_web_fallback=False,
        allow_apple_web_fallback_when_has_cover=False,
        negative_cache_ttl_seconds=None,
    )

    assert captured["cover_selection_origin"] == "automatic"
    assert captured["reject_if_user_controlled"] is True


def test_execute_cover_job_preserves_user_origin_for_comparison_only_search(
    tmp_path: Path,
    monkeypatch,
):
    folder = tmp_path / "Artist" / "Album"
    folder.mkdir(parents=True)
    cover_path = folder / "cover.jpg"
    cover_path.write_bytes(b"user-controlled-cover")
    captured = {}

    def fake_ensure_best_cover_for_folder(**kwargs):
        captured.update(kwargs)
        return cover_path, False, {"reason": "user_controlled_improvement_available"}

    monkeypatch.setattr(
        cover_refresh_execution.cover_refresh_provider,
        "ensure_best_cover_for_folder",
        fake_ensure_best_cover_for_folder,
    )

    resolved_cover, downloaded, _detail = cover_refresh_execution.execute_cover_job(
        job={
            "folder": folder,
            "artist": "Artist",
            "album": "Album",
            "track_paths": [str(folder / "song.mp3")],
            "cover_selection_origin": "user",
        },
        image_extensions={".jpg"},
        user_agent="Album Haven Test",
        cover_cache=object(),
        force_search=False,
        allow_apple_web_fallback=False,
        allow_apple_web_fallback_when_has_cover=False,
        negative_cache_ttl_seconds=None,
    )

    assert resolved_cover == cover_path
    assert downloaded is False
    assert captured["cover_selection_origin"] == "user"
    assert captured["reject_if_user_controlled"] is True


def test_automatic_write_guard_preserves_user_origin_for_same_art_upgrade(
    tmp_path: Path,
    monkeypatch,
):
    folder = tmp_path / "Artist" / "Album"
    folder.mkdir(parents=True)
    cover_path = folder / "cover.jpg"
    original_bytes = b"user-selected-cover"
    upgraded_bytes = b"higher-quality-same-art"
    cover_path.write_bytes(original_bytes)
    expected_revision = hashlib.sha256(original_bytes).hexdigest()
    captured = {}

    def write_action():
        cover_path.write_bytes(upgraded_bytes)
        return cover_path

    write_action.selected_cover_path = cover_path
    write_action.provisional_cover_revision = hashlib.sha256(upgraded_bytes).hexdigest()
    write_action.preserve_user_ownership = True
    write_action.expected_cover_revision = expected_revision
    write_action.prepared_cover_bytes = upgraded_bytes

    def persist(_config, track_paths, selected_cover_path, **kwargs):
        captured.update(
            track_paths=track_paths,
            selected_cover_path=selected_cover_path,
            **kwargs,
        )
        return kwargs["commit_guard"](lambda: None) or {
            "album_rows_updated": 1,
            "track_file_rows_updated": 1,
        }

    monkeypatch.setattr(
        cover_refresh_execution,
        "persist_cover_selection_for_tracks_for_config",
        persist,
    )
    monkeypatch.setattr(
        cover_refresh_execution,
        "images_are_visually_similar",
        lambda existing_path, raw_bytes: existing_path == cover_path and raw_bytes == upgraded_bytes,
        raising=False,
    )

    guard = cover_refresh_execution._build_automatic_cover_write_guard(
        config={"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://same-art-upgrade"},
        folder=folder,
        track_paths={str(folder / "song.mp3")},
    )

    assert guard(write_action, cover_selection_origin="automatic") == cover_path
    assert cover_path.read_bytes() == upgraded_bytes
    assert captured["cover_selection_origin"] == "user"
    assert captured["reject_if_user_controlled"] is False
    assert captured["expected_cover_selection_origin"] == "user"
    assert captured["expected_cover_revision"] == expected_revision


def test_automatic_write_guard_rolls_back_cover_and_new_reserve_when_commit_fails(
    tmp_path: Path,
    monkeypatch,
):
    folder = tmp_path / "Artist" / "Album"
    folder.mkdir(parents=True)
    cover_path = folder / "cover.jpg"
    reserve_path = folder / "cover-existing-1.jpg"
    prior_cover_bytes = b"prior-cover-bytes"
    replacement_bytes = b"automatic-replacement-bytes"
    cover_path.write_bytes(prior_cover_bytes)
    commit_error = RuntimeError("Postgres cover commit failed")

    def write_action():
        reserve_path.write_bytes(cover_path.read_bytes())
        cover_path.write_bytes(replacement_bytes)
        return cover_path

    write_action.selected_cover_path = cover_path
    write_action.provisional_cover_revision = hashlib.sha256(
        replacement_bytes
    ).hexdigest()

    def persist(_config, _track_paths, _selected_cover_path, **kwargs):
        def fail_commit():
            raise commit_error

        return kwargs["commit_guard"](fail_commit)

    monkeypatch.setattr(
        cover_refresh_execution,
        "persist_cover_selection_for_tracks_for_config",
        persist,
    )
    guard = cover_refresh_execution._build_automatic_cover_write_guard(
        config={"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://commit-failure"},
        folder=folder,
        track_paths={str(folder / "song.mp3")},
    )

    with pytest.raises(RuntimeError) as exc_info:
        guard(write_action, cover_selection_origin="automatic")

    assert exc_info.value is commit_error
    assert cover_path.read_bytes() == prior_cover_bytes
    assert reserve_path.exists() is False


def test_automatic_write_guard_removes_new_cover_when_commit_fails_without_prior_cover(
    tmp_path: Path,
    monkeypatch,
):
    folder = tmp_path / "Artist" / "Album"
    folder.mkdir(parents=True)
    cover_path = folder / "cover.jpg"
    replacement_bytes = b"automatic-replacement-bytes"
    commit_error = RuntimeError("Postgres cover commit failed")

    def write_action():
        cover_path.write_bytes(replacement_bytes)
        return cover_path

    write_action.selected_cover_path = cover_path
    write_action.provisional_cover_revision = hashlib.sha256(
        replacement_bytes
    ).hexdigest()

    def persist(_config, _track_paths, _selected_cover_path, **kwargs):
        def fail_commit():
            raise commit_error

        return kwargs["commit_guard"](fail_commit)

    monkeypatch.setattr(
        cover_refresh_execution,
        "persist_cover_selection_for_tracks_for_config",
        persist,
    )
    guard = cover_refresh_execution._build_automatic_cover_write_guard(
        config={"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://commit-failure"},
        folder=folder,
        track_paths={str(folder / "song.mp3")},
    )

    with pytest.raises(RuntimeError) as exc_info:
        guard(write_action, cover_selection_origin="automatic")

    assert exc_info.value is commit_error
    assert cover_path.exists() is False


def test_same_art_automatic_guard_blocks_after_concurrent_manual_cover_change(
    tmp_path: Path,
    monkeypatch,
):
    folder = tmp_path / "Artist" / "Album"
    folder.mkdir(parents=True)
    cover_path = folder / "cover.jpg"
    searched_cover_bytes = b"cover-when-search-started"
    concurrent_manual_bytes = b"new-manual-selection"
    automatic_upgrade_bytes = b"automatic-same-art-upgrade"
    cover_path.write_bytes(concurrent_manual_bytes)

    def write_action():
        raise AssertionError("A stale automatic writer must not replace a manual selection")

    write_action.selected_cover_path = cover_path
    write_action.provisional_cover_revision = hashlib.sha256(
        automatic_upgrade_bytes
    ).hexdigest()
    write_action.preserve_user_ownership = True
    write_action.expected_cover_revision = hashlib.sha256(
        searched_cover_bytes
    ).hexdigest()
    write_action.prepared_cover_bytes = automatic_upgrade_bytes

    monkeypatch.setattr(
        cover_refresh_execution,
        "images_are_visually_similar",
        lambda *_args: True,
        raising=False,
    )
    monkeypatch.setattr(
        cover_refresh_execution,
        "persist_cover_selection_for_tracks_for_config",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("A stale automatic writer must be rejected before persistence")
        ),
    )

    guard = cover_refresh_execution._build_automatic_cover_write_guard(
        config={"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://concurrent-manual"},
        folder=folder,
        track_paths={str(folder / "song.mp3")},
    )

    assert guard(write_action, cover_selection_origin="automatic") is False
    assert cover_path.read_bytes() == concurrent_manual_bytes


def test_dead_no_arg_state_wrappers_are_absent():
    for wrapper_name in (
        "scan_percent",
        "relations_percent",
        "refresh_cached_cover_paths_in_state",
        "cover_file_cache_snapshot",
        "hydrate_library_from_disk",
        "start_background_library_hydration",
        "refresh_cover_artwork",
        "refresh_cover_artwork_for_track_paths",
        "refresh_unsuccessful_cover_artwork",
        "refresh_library",
        "start_background_refresh",
        "cancel_background_refresh",
    ):
        assert not hasattr(state_module, wrapper_name)


def test_state_module_does_not_expose_flask_state_bridge():
    exposed_bridge_names = sorted(
        name for name in ("state", "current_app") if hasattr(state_module, name)
    )

    assert exposed_bridge_names == []


def test_refresh_cover_artwork_for_track_paths_for_state_uses_explicit_dependencies_without_flask_context(config, logger, monkeypatch):
    library_state = {"file_cache": {}, "cover_generation": 0}
    captured = []

    monkeypatch.setattr(
        state_module,
        "refresh_cover_artwork_for_track_paths_request",
        lambda **kwargs: captured.append(kwargs) or {"changed": False},
    )

    result = state_module.refresh_cover_artwork_for_track_paths_for_state(
        library_state,
        config,
        logger,
        {"track-1"},
        force_search=True,
    )

    assert result == {"changed": False}
    assert captured[0]["get_state"]() is library_state
    assert captured[0]["config"] is config
    assert captured[0]["logger"] is logger
    assert captured[0]["track_paths"] == {"track-1"}
    assert captured[0]["force_search"] is True


def test_hydrate_library_state_worker_uses_explicit_dependencies_without_flask_context(config, logger, monkeypatch):
    library_state = {"hydrate_in_progress": True, "last_error": None}
    captured = []

    def fake_hydrate_library_state_for_config(state_arg, config_arg, **kwargs):
        captured.append((state_arg, config_arg, kwargs))
        return True

    monkeypatch.setattr(
        state_module,
        "hydrate_library_state_for_config",
        fake_hydrate_library_state_for_config,
    )

    state_module._hydrate_library_state_worker(
        library_state,
        config,
        logger,
        ensure_relations=True,
        validate_cache=False,
    )

    assert captured == [(
        library_state,
        config,
        {
            "ensure_relations": True,
            "validate_cache": False,
            "logger_for_prewarm": logger,
        },
    )]
    assert library_state["hydrate_in_progress"] is False
    assert library_state["last_error"] is None
    assert logger.exception_messages == []


def test_hydrate_library_state_worker_prewarms_root_browse_payload_when_background_startup_skips_utility_prewarm(config, logger, monkeypatch):
    library_state = {"hydrate_in_progress": True, "last_error": None, "albums": ["album-1"]}
    captured = []

    def fake_hydrate_library_state_for_config(state_arg, config_arg, **kwargs):
        captured.append(("hydrate", state_arg, config_arg, kwargs))
        return True

    def fake_prewarm_root_browse_payload_for_state(state_arg, config_arg, logger_arg):
        captured.append(("prewarm", state_arg, config_arg, logger_arg))

    monkeypatch.setattr(
        state_module,
        "hydrate_library_state_for_config",
        fake_hydrate_library_state_for_config,
    )
    monkeypatch.setattr(
        state_module,
        "_prewarm_root_browse_payload_for_state",
        fake_prewarm_root_browse_payload_for_state,
    )

    state_module._hydrate_library_state_worker(
        library_state,
        config,
        logger,
        ensure_relations=False,
        validate_cache=False,
        enable_prewarm=False,
    )

    assert captured == [
        (
            "hydrate",
            library_state,
            config,
            {
                "ensure_relations": False,
                "validate_cache": False,
                "logger_for_prewarm": None,
            },
        ),
        ("prewarm", library_state, config, logger),
    ]
    assert library_state["hydrate_in_progress"] is False


def test_hydrate_library_state_worker_records_and_logs_exceptions_without_flask_context(config, logger, monkeypatch):
    library_state = {"hydrate_in_progress": True, "last_error": None}

    def fake_hydrate_library_state_for_config(*args, **kwargs):
        raise RuntimeError("disk hydrate failed")

    monkeypatch.setattr(
        state_module,
        "hydrate_library_state_for_config",
        fake_hydrate_library_state_for_config,
    )

    state_module._hydrate_library_state_worker(
        library_state,
        config,
        logger,
        ensure_relations=False,
        validate_cache=True,
    )

    assert library_state["hydrate_in_progress"] is False
    assert library_state["last_error"] == "disk hydrate failed"
    assert logger.exception_messages == [("Background library hydration failed", ())]


def test_hydrate_library_state_for_config_returns_false_when_runtime_persistence_adapter_is_unavailable(monkeypatch):
    library_state = {"albums": [], "last_error": None}

    monkeypatch.setattr(
        state_module,
        "hydrate_library_state_from_disk",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            ValueError("Postgres runtime persistence adapter is unavailable for exception_overrides.")
        ),
    )

    hydrated = state_module.hydrate_library_state_for_config(
        library_state,
        {"MUSIC_DIR": "."},
    )

    assert hydrated is False
    assert library_state["last_error"] == "Postgres runtime persistence adapter is unavailable for exception_overrides."


def test_startup_hydration_selects_strict_scan_cache_adapter_and_passes_it_explicitly(
    config,
    logger,
    monkeypatch,
):
    adapter = object()
    library_state = {"albums": [], "file_cache": {}, "last_error": None}
    app = SimpleNamespace(config=config, library_state=library_state, logger=logger)
    calls = []

    monkeypatch.setattr(
        "music_app.services.tag_edit_recovery.reconcile_unfinished_tag_edit_intents_on_startup",
        lambda runtime: calls.append(("recover", runtime)),
    )

    monkeypatch.setattr(state_module, "select_scan_cache_adapter", lambda selected_config: adapter)
    monkeypatch.setattr(
        state_module,
        "_call_hydrate_library_state_from_disk",
        lambda state, selected_config, **kwargs: calls.append((state, selected_config, kwargs)) or True,
    )
    monkeypatch.setattr(
        state_module,
        "migrate_legacy_album_exclusions",
        lambda selected_config: calls.append(("migrate", selected_config)) or {
            "migrated_album_count": 0,
            "removed_legacy_rule_count": 0,
            "created_album_rule_count": 0,
        },
        raising=False,
    )

    assert state_module.hydrate_runtime_library_state_on_startup(app) is True
    assert calls == [
        ("recover", app),
        (
            library_state,
            config,
            {
                "ensure_relations": False,
                "validate_cache": False,
                "scan_cache_adapter": adapter,
                "strict_scan_cache_load": True,
                "logger": logger,
            },
        ),
        ("migrate", config),
    ]


def test_startup_hydration_propagates_strict_adapter_selection_failure(config, logger, monkeypatch):
    library_state = {"albums": [], "file_cache": {}, "last_error": None}
    app = SimpleNamespace(config=config, library_state=library_state, logger=logger)
    monkeypatch.setattr(
        "music_app.services.tag_edit_recovery.reconcile_unfinished_tag_edit_intents_on_startup",
        lambda _runtime: None,
    )
    monkeypatch.setattr(
        state_module,
        "select_scan_cache_adapter",
        lambda _config: (_ for _ in ()).throw(RuntimeError("strict Postgres adapter unavailable")),
    )
    monkeypatch.setattr(
        state_module,
        "_call_hydrate_library_state_from_disk",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("startup must not fall back after strict adapter selection fails")
        ),
    )

    with pytest.raises(RuntimeError, match="strict Postgres adapter unavailable"):
        state_module.hydrate_runtime_library_state_on_startup(app)

    assert library_state["last_error"] is None
    assert logger.warning_messages == []


def test_startup_hydration_propagates_snapshot_load_failures(config, logger, monkeypatch):
    app = SimpleNamespace(
        config=config,
        library_state={"albums": [], "file_cache": {}, "last_error": None},
        logger=logger,
    )
    monkeypatch.setattr(
        "music_app.services.tag_edit_recovery.reconcile_unfinished_tag_edit_intents_on_startup",
        lambda _runtime: None,
    )
    monkeypatch.setattr(state_module, "select_scan_cache_adapter", lambda _config: object())
    monkeypatch.setattr(
        state_module,
        "_call_hydrate_library_state_from_disk",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("snapshot load failed")),
    )

    with pytest.raises(RuntimeError, match="snapshot load failed"):
        state_module.hydrate_runtime_library_state_on_startup(app)


def test_mbid_assertion_follow_up_worker_uses_explicit_logger_without_flask_context(logger, monkeypatch):
    captured = []

    def fake_run_post_scan_artist_mbid_assertion_follow_up(**kwargs):
        captured.append(kwargs)
        return {"artist_count": 1}

    monkeypatch.setattr(
        state_module,
        "run_post_scan_artist_mbid_assertion_follow_up",
        fake_run_post_scan_artist_mbid_assertion_follow_up,
    )

    state_module._run_mbid_assertion_follow_up(
        logger,
        {"artist_names": ["Stereolab"], "scan_run_ref": "scan-1"},
    )

    assert captured == [{"artist_names": ["Stereolab"], "scan_run_ref": "scan-1"}]
    assert logger.exception_messages == []


def test_mbid_assertion_follow_up_worker_logs_exceptions_without_flask_context(logger, monkeypatch):
    def fake_run_post_scan_artist_mbid_assertion_follow_up(**kwargs):
        raise RuntimeError("mbid follow-up failed")

    monkeypatch.setattr(
        state_module,
        "run_post_scan_artist_mbid_assertion_follow_up",
        fake_run_post_scan_artist_mbid_assertion_follow_up,
    )

    state_module._run_mbid_assertion_follow_up(
        logger,
        {"artist_names": ["Stereolab"], "scan_run_ref": "scan-1"},
    )

    assert logger.exception_messages == [("Post-scan MBID assertion follow-up failed", ())]


def test_refresh_unsuccessful_cover_artwork_for_state_uses_explicit_dependencies_without_flask_context(config, logger, monkeypatch):
    library_state = {"file_cache": {}, "cover_generation": 0}
    captured = []

    monkeypatch.setattr(
        state_module,
        "refresh_unsuccessful_cover_artwork_request",
        lambda **kwargs: captured.append(kwargs) or {"changed": False},
    )

    result = state_module.refresh_unsuccessful_cover_artwork_for_state(
        library_state,
        config,
        logger,
        force_search=True,
    )

    assert result == {"changed": False}
    assert captured[0]["get_state"]() is library_state
    assert captured[0]["config"] is config
    assert captured[0]["logger"] is logger
    assert captured[0]["force_search"] is True
    assert captured[0]["bulk_negative_cache_ttl_seconds"] == state_module._BULK_NEGATIVE_CACHE_TTL_SECONDS


def test_refresh_unsuccessful_cover_artwork_for_state_uses_configured_bulk_cover_limits(
    config,
    logger,
    monkeypatch,
):
    library_state = {"file_cache": {}, "cover_generation": 0}
    captured = []
    config["BULK_COVER_NEGATIVE_CACHE_TTL_SECONDS"] = 0
    config["BULK_COVER_JOB_WORKERS"] = 4

    monkeypatch.setattr(
        state_module,
        "refresh_unsuccessful_cover_artwork_request",
        lambda **kwargs: captured.append(kwargs) or {"changed": False},
    )

    state_module.refresh_unsuccessful_cover_artwork_for_state(
        library_state,
        config,
        logger,
    )

    assert captured[0]["bulk_negative_cache_ttl_seconds"] == 0
    assert captured[0]["job_workers"] == 4


def test_state_utility_prewarm_routes_to_authoritative_postgres_projections_when_effective(
    config,
    logger,
    library_state,
    monkeypatch,
):
    from music_app.services import problematic_albums, utility_rules

    queued_kinds = []
    legacy_calls = []
    repository_configs = []

    class RepositoryStub:
        def __init__(self, repository_config):
            repository_configs.append(repository_config)

        def queue_utility_projection_prewarm(self, kind):
            queued_kinds.append(kind)

    monkeypatch.setattr(
        state_module,
        "library_browse_postgres_is_effective",
        lambda repository_config: repository_config is config,
        raising=False,
    )
    monkeypatch.setattr(
        state_module,
        "PostgresLibraryBrowseRepository",
        RepositoryStub,
        raising=False,
    )
    monkeypatch.setattr(
        problematic_albums,
        "queue_problematic_albums_prewarm",
        lambda **_kwargs: legacy_calls.append("problematic-files"),
    )
    monkeypatch.setattr(
        utility_rules,
        "queue_utility_rules_prewarm",
        lambda **_kwargs: legacy_calls.append("rules"),
    )

    state_module._queue_problematic_albums_prewarm_for_state(library_state, config, logger)
    state_module._queue_utility_rules_prewarm_for_state(library_state, config, logger)

    assert repository_configs == [config, config]
    assert queued_kinds == ["problematic-files", "rules"]
    assert legacy_calls == []


def test_refresh_library_for_state_threads_explicit_manual_cover_refresh_dependencies(config, logger, library_state, monkeypatch):
    captured = []
    scan_calls = []
    refresh_kwargs = []

    def fake_refresh_library_state(library_state, **kwargs):
        refresh_kwargs.append(kwargs)
        kwargs["scan_music_incremental"](use_existing_cache=False, expected_scan_generation=7)
        kwargs["start_manual_cover_refresh"](force_search=True)

    monkeypatch.setattr(state_module, "refresh_library_state", fake_refresh_library_state)
    monkeypatch.setattr(
        state_module,
        "scan_music_incremental",
        lambda **kwargs: scan_calls.append(kwargs) or ({}, 0.0),
    )
    monkeypatch.setattr(
        state_module,
        "start_manual_cover_refresh_request",
        lambda **kwargs: captured.append(kwargs) or {"started": True},
    )

    state_module.refresh_library_for_state(library_state, config, logger, force=False)

    assert len(captured) == 1
    assert len(scan_calls) == 1
    assert scan_calls[0]["config"] is config
    assert scan_calls[0]["logger"] is logger
    assert scan_calls[0]["library_state"] is library_state
    assert scan_calls[0]["use_existing_cache"] is False
    assert scan_calls[0]["expected_scan_generation"] == 7
    assert len(refresh_kwargs) == 1
    assert refresh_kwargs[0]["config"] is config
    assert refresh_kwargs[0]["logger"] is logger
    assert captured[0]["config"] is config
    assert captured[0]["logger"] is logger
    assert "app" not in captured[0]
    assert captured[0]["force_search"] is True


def test_refresh_library_for_state_runs_without_flask_context(config, logger, library_state, monkeypatch):
    scan_calls = []
    relation_calls = []
    manual_cover_calls = []
    background_cover_calls = []
    background_cover_refresh_calls = []
    problematic_calls = []
    utility_calls = []
    mbid_calls = []
    mbid_submissions = []
    refresh_kwargs = []

    class _MbidExecutorStub:
        def submit(self, *args):
            mbid_submissions.append(args)

    def fake_refresh_library_state(library_state, **kwargs):
        refresh_kwargs.append((library_state, kwargs))
        kwargs["scan_music_incremental"](use_existing_cache=False, expected_scan_generation=9)
        kwargs["refresh_relation_views"]()
        kwargs["start_manual_cover_refresh"](force_search=True)
        kwargs["start_background_cover_refresh"]()
        kwargs["queue_problematic_albums_prewarm"]()
        kwargs["queue_utility_rules_prewarm"]()
        kwargs["queue_mbid_assertion_follow_up"](library_state, previous_albums={"old": {}})

    monkeypatch.setattr(state_module, "refresh_library_state", fake_refresh_library_state)
    monkeypatch.setattr(
        state_module,
        "scan_music_incremental",
        lambda **kwargs: scan_calls.append(kwargs) or ({}, 0.0),
    )
    monkeypatch.setattr(
        state_module,
        "refresh_relation_views_for_state",
        lambda library_state, config: relation_calls.append((library_state, config)),
    )
    monkeypatch.setattr(
        state_module,
        "start_manual_cover_refresh_request",
        lambda **kwargs: manual_cover_calls.append(kwargs) or {"started": True},
    )
    monkeypatch.setattr(
        state_module,
        "start_background_cover_refresh_request",
        lambda **kwargs: background_cover_calls.append(kwargs) or {"started": True},
    )
    monkeypatch.setattr(
        state_module,
        "refresh_cover_artwork_request",
        lambda **kwargs: background_cover_refresh_calls.append(kwargs)
        or {"changed": False},
    )
    monkeypatch.setattr(
        state_module,
        "queue_post_scan_artist_mbid_assertion_follow_up",
        lambda *args, **kwargs: mbid_calls.append((args, kwargs))
        or kwargs["submit_follow_up"](artist_names=["Stereolab"], scan_run_ref="scan-9"),
    )
    monkeypatch.setattr(state_module, "_MBID_ASSERTION_EXECUTOR", _MbidExecutorStub())
    monkeypatch.setattr(
        state_module,
        "_queue_problematic_albums_prewarm_for_state",
        lambda library_state, config, logger: problematic_calls.append((library_state, config, logger)),
        raising=False,
    )
    monkeypatch.setattr(
        state_module,
        "_queue_utility_rules_prewarm_for_state",
        lambda library_state, config, logger: utility_calls.append((library_state, config, logger)),
        raising=False,
    )

    state_module.refresh_library_for_state(library_state, config, logger, force=True)
    config["BULK_COVER_NEGATIVE_CACHE_TTL_SECONDS"] = 0
    config["BULK_COVER_JOB_WORKERS"] = 4
    background_cover_calls[0]["refresh_cover_artwork"]()

    assert refresh_kwargs[0][0] is library_state
    assert refresh_kwargs[0][1]["config"] is config
    assert refresh_kwargs[0][1]["logger"] is logger
    assert refresh_kwargs[0][1]["force"] is True
    assert scan_calls[0]["config"] is config
    assert scan_calls[0]["logger"] is logger
    assert scan_calls[0]["library_state"] is library_state
    assert relation_calls == [(library_state, config)]
    assert manual_cover_calls[0]["config"] is config
    assert manual_cover_calls[0]["logger"] is logger
    assert "app" not in manual_cover_calls[0]
    assert "app" not in background_cover_calls[0]
    assert background_cover_refresh_calls[0]["bulk_negative_cache_ttl_seconds"] == 0
    assert background_cover_refresh_calls[0]["job_workers"] == 4
    assert problematic_calls == [(library_state, config, logger)]
    assert utility_calls == [(library_state, config, logger)]
    assert mbid_calls[0][1]["config"] is config
    assert mbid_submissions == [(
        state_module._run_mbid_assertion_follow_up,
        logger,
        {"artist_names": ["Stereolab"], "scan_run_ref": "scan-9"},
    )]
    assert all(not hasattr(arg, "app_context") for arg in mbid_submissions[0])


def test_hydration_file_errors_use_bounded_structured_history(
    config,
    logger,
    library_state,
    monkeypatch,
):
    logged_events = []

    monkeypatch.setattr(
        state_module,
        "log_app_event",
        lambda _config, _logger, action, **fields: logged_events.append({
            "action": action,
            **fields,
        }),
    )

    hydrate_calls = 0

    def fake_hydrate(_library_state, _config, **kwargs):
        nonlocal hydrate_calls
        hydrate_calls += 1
        record_file_error = kwargs["record_file_error"]
        for index in range(30):
            record_file_error(
                "Library hydration directory read failed",
                path=f"call-{hydrate_calls}-blocked-{index:02d}",
                error="directory access denied",
                error_type="PermissionError",
            )
        return True

    monkeypatch.setattr(state_module, "hydrate_library_state_from_disk", fake_hydrate)
    library_state["scan_generation"] = 9

    first_hydrated = state_module._call_hydrate_library_state_from_disk(
        library_state,
        config,
        ensure_relations=False,
        validate_cache=True,
        logger=logger,
    )
    second_hydrated = state_module._call_hydrate_library_state_from_disk(
        library_state,
        config,
        ensure_relations=False,
        validate_cache=True,
        logger=logger,
    )

    assert first_hydrated is True
    assert second_hydrated is True
    assert hydrate_calls == 2
    assert len(logged_events) == 51
    assert [event["action"] for event in logged_events[:50]] == [
        "Library hydration directory read failed"
    ] * 50
    assert logged_events[-1] == {
        "action": "Additional library hydration file errors omitted",
        "level": "error",
        "history": True,
        "id": "library-hydration-file-errors-omitted:9",
        "scan_generation": 9,
        "detail_limit": 50,
    }

def test_scan_music_incremental_bounds_structured_file_error_history(
    config,
    logger,
    library_state,
    tmp_path,
    monkeypatch,
):
    library_root = tmp_path / "Library"
    library_root.mkdir()
    logged_events = []

    monkeypatch.setattr(state_module, "iter_library_root_paths", lambda _config: [library_root])
    monkeypatch.setattr(state_module, "load_exception_overrides", lambda _config: {})
    monkeypatch.setattr(state_module, "get_library_roots", lambda _config: [])
    monkeypatch.setattr(
        state_module,
        "log_app_event",
        lambda _config, _logger, action, **fields: logged_events.append({
            "action": action,
            **fields,
        }),
    )

    def fake_scan_library_file_cache(_library_state, **kwargs):
        record_file_error = kwargs["record_file_error"]
        for index in range(52):
            record_file_error(
                "Library candidate file stat failed",
                path=str(library_root / f"blocked-{index:02d}.mp3"),
                error="file attributes unavailable",
                error_type="OSError",
            )
        return {}, 1.0

    monkeypatch.setattr(
        state_module,
        "scan_library_file_cache",
        fake_scan_library_file_cache,
    )

    result = state_module.scan_music_incremental(
        config=config,
        logger=logger,
        library_state=library_state,
        expected_scan_generation=14,
    )

    assert result == ({}, 1.0)
    assert len(logged_events) == 51
    assert all(event["history"] is True for event in logged_events)
    assert all(event["level"] == "error" for event in logged_events)
    assert all(event["scan_generation"] == 14 for event in logged_events)
    assert [event["action"] for event in logged_events[:50]] == [
        "Library candidate file stat failed"
    ] * 50
    assert logged_events[0]["path"].endswith("blocked-00.mp3")
    assert logged_events[0]["error"] == "file attributes unavailable"
    assert logged_events[0]["error_type"] == "OSError"
    assert logged_events[-1] == {
        "action": "Additional library file errors omitted",
        "level": "error",
        "history": True,
        "id": "library-file-errors-omitted:14",
        "scan_generation": 14,
        "detail_limit": 50,
    }

def test_start_background_refresh_for_state_submits_explicit_worker_dependencies(config, logger, library_state, monkeypatch):
    submitted = []

    class _ExecutorStub:
        def submit(self, *args):
            submitted.append(args)

    monkeypatch.setattr(state_module, "_SCAN_EXECUTOR", _ExecutorStub())
    library_state["last_error"] = "Previous scan failed"

    accepted = state_module.start_background_refresh_for_state(
        library_state,
        config,
        logger,
        force=True,
        scan_mode="manual",
    )

    assert library_state["scan_in_progress"] is True
    assert library_state["scan_mode"] == "manual"
    assert library_state["scan_phase"] == "discovering"
    assert library_state["last_error"] is None
    assert accepted is True
    assert submitted
    worker, submitted_library_state, submitted_config, submitted_logger, force = submitted[0]
    assert worker.__name__ == "_refresh_library_worker"
    assert submitted_library_state is library_state
    assert submitted_config is config
    assert submitted_logger is logger
    assert force is True
    assert all(not hasattr(arg, "app_context") for arg in submitted[0])

    library_state["scan_processed"] = 41
    rejected = state_module.start_background_refresh_for_state(
        library_state,
        config,
        logger,
        force=True,
        scan_mode="manual_full_rescan",
        accepted_state_updates={"scan_processed": 0},
    )

    assert rejected is False
    assert len(submitted) == 1
    assert library_state["scan_mode"] == "manual"
    assert library_state["scan_processed"] == 41


def test_refresh_library_worker_uses_explicit_dependencies_without_flask_context(config, logger, library_state, monkeypatch):
    calls = []

    def fake_refresh_library_for_state(library_state, config, logger, *, force=False):
        calls.append(
            {
                "library_state": library_state,
                "config": config,
                "logger": logger,
                "force": force,
            }
        )

    monkeypatch.setattr(state_module, "refresh_library_for_state", fake_refresh_library_for_state)

    state_module._refresh_library_worker(library_state, config, logger, True)

    assert calls == [
        {
            "library_state": library_state,
            "config": config,
            "logger": logger,
            "force": True,
        }
    ]


def test_postgres_relation_refresh_uses_canonical_rebuild_and_adopts_committed_state(
    config,
    monkeypatch,
):
    config["ALBUM_HAVEN_APP_DATABASE_URL"] = (
        "postgresql://album_haven_app@localhost/album_haven_test"
    )
    library_state = {
        "file_cache": {"track-1": {"path": "track-1", "album": "Album"}},
        "last_scan": 789.5,
        "relations_last_built": 321.25,
        "separate_release_keys": {"artist::album"},
        "relation_projection_startup_rebuilt": True,
        "relation_projection_rebuild_reason": "missing_projection",
        "relation_projection_duration_ms": 12.5,
    }
    canonical_views = {
        "artists": ["Canonical Artist"],
        "artists_sidebar": [{"artist": "Canonical Artist", "count": 1}],
        "family_to_artists": {},
        "folder_related": {"Canonical Artist": set()},
        "sidebar_families": [],
        "alias_to_canonical": {"Canonical Artist": "Canonical Artist"},
        "canonical_to_aliases": {"Canonical Artist": ["Canonical Artist"]},
    }
    saved = []

    monkeypatch.setattr(
        state_module,
        "refresh_relation_views_in_state",
        lambda *_args, **_kwargs: pytest.fail(
            "Postgres relation refresh invoked the legacy filesystem builder"
        ),
    )
    monkeypatch.setattr(state_module, "library_root_cache_identity", lambda config_arg: f"root-{id(config_arg)}")

    def save_snapshot(config_arg, cache_path, file_cache, root_identity, last_scan, **kwargs):
        saved.append((config_arg, cache_path, file_cache, root_identity, last_scan, kwargs))
        return {
            "relation_views": canonical_views,
            "relations_last_built": 456.75,
        }

    monkeypatch.setattr(
        state_module,
        "save_cache_to_disk_for_config",
        save_snapshot,
    )

    state_module.refresh_relation_views_for_state(library_state, config)

    assert saved == [(
        config,
        config["CACHE_PATH"],
        {"track-1": {"path": "track-1", "album": "Album"}},
        f"root-{id(config)}",
        789.5,
        {
            "separate_release_keys": {"artist::album"},
            "rebuild_relation_projection": True,
        },
    )]
    assert library_state["relation_views"] == canonical_views
    assert library_state["relations_last_built"] == 456.75
    assert library_state["relation_projection_ready"] is True
    assert "artist_family_projection_relations_last_built" not in library_state
    assert library_state["relation_projection_startup_rebuilt"] is True
    assert library_state["relation_projection_rebuild_reason"] == "missing_projection"
    assert library_state["relation_projection_duration_ms"] == 12.5


def test_postgres_relation_refresh_publishes_terminal_status_from_committed_artists(
    config,
    monkeypatch,
):
    config["ALBUM_HAVEN_APP_DATABASE_URL"] = (
        "postgresql://album_haven_app@localhost/album_haven_test"
    )
    library_state = {
        "file_cache": {},
        "last_scan": 10.0,
        "separate_release_keys": set(),
        "relations_in_progress": True,
        "relations_processed": 0,
        "relations_total": 0,
        "relations_phase": "Preparing Artist Family build",
        "relations_source": "local",
    }
    canonical_artists = [f"Canonical Artist {index}" for index in range(100)]
    canonical_views = {
        "artists": canonical_artists,
        "artists_sidebar": [
            {"artist": artist, "count": 1}
            for artist in canonical_artists
        ],
    }

    monkeypatch.setattr(
        state_module,
        "refresh_relation_views_in_state",
        lambda *_args, **_kwargs: pytest.fail(
            "Postgres relation refresh invoked the legacy filesystem builder"
        ),
    )
    monkeypatch.setattr(
        state_module,
        "library_root_cache_identity",
        lambda _config: "root",
    )
    monkeypatch.setattr(
        state_module,
        "save_cache_to_disk_for_config",
        lambda *_args, **_kwargs: {
            "relation_views": canonical_views,
            "relations_last_built": 456.75,
        },
    )

    state_module.refresh_relation_views_for_state(library_state, config)

    assert library_state["relations_total"] == len(canonical_artists)
    assert library_state["relations_processed"] == len(canonical_artists)
    assert library_state["relations_phase"] == "Artist Family ready"
    assert library_state["relations_source"] == "local"
    assert library_state["relations_in_progress"] is False


def test_postgres_relation_refresh_fails_loudly_without_committed_canonical_state(
    config,
    monkeypatch,
):
    config["ALBUM_HAVEN_APP_DATABASE_URL"] = (
        "postgresql://album_haven_app@localhost/album_haven_test"
    )
    library_state = {
        "file_cache": {},
        "last_scan": 10.0,
        "separate_release_keys": set(),
        "relation_projection_ready": False,
    }
    monkeypatch.setattr(
        state_module,
        "refresh_relation_views_in_state",
        lambda *_args, **_kwargs: pytest.fail(
            "Postgres relation refresh invoked the legacy filesystem builder"
        ),
    )
    monkeypatch.setattr(state_module, "library_root_cache_identity", lambda _config: "root")
    monkeypatch.setattr(
        state_module,
        "save_cache_to_disk_for_config",
        lambda *_args, **_kwargs: None,
    )

    with pytest.raises(RuntimeError, match="canonical relation projection"):
        state_module.refresh_relation_views_for_state(library_state, config)

    assert library_state["relation_projection_ready"] is False


def test_file_backed_relation_refresh_keeps_legacy_in_memory_builder_contract(
    config,
    monkeypatch,
):
    config.pop("ALBUM_HAVEN_APP_DATABASE_URL", None)
    library_state = {
        "file_cache": {"track": {"path": "track"}},
        "last_scan": 10.0,
        "relations_last_built": 2.0,
        "separate_release_keys": set(),
    }
    legacy_views = {
        "artists": ["File Artist"],
        "artists_sidebar": [{"artist": "File Artist", "count": 1}],
        "family_to_artists": {},
        "folder_related": {},
        "sidebar_families": [],
        "alias_to_canonical": {"File Artist": "File Artist"},
        "canonical_to_aliases": {"File Artist": ["File Artist"]},
    }
    calls = []
    monkeypatch.setattr(
        state_module,
        "refresh_relation_views_in_state",
        lambda state, selected_config: calls.append((state, selected_config))
        or legacy_views,
    )
    monkeypatch.setattr(state_module, "library_root_cache_identity", lambda _config: "file-root")
    saved = []
    monkeypatch.setattr(
        state_module,
        "save_cache_to_disk_for_config",
        lambda *_args, **kwargs: saved.append(kwargs),
    )

    state_module.refresh_relation_views_for_state(library_state, config)

    assert calls == [(library_state, config)]
    assert saved == [{
        "relation_views": legacy_views,
        "relations_last_built": 2.0,
        "separate_release_keys": set(),
    }]
    assert library_state["relation_views"] == legacy_views


def test_refresh_relation_views_for_state_keeps_existing_projection_freshness_marker(config, monkeypatch):
    config["ALBUM_HAVEN_APP_DATABASE_URL"] = (
        "postgresql://album_haven_app@localhost/album_haven_test"
    )
    library_state = {
        "file_cache": {"track-1": {"path": "track-1", "album": "Album"}},
        "last_scan": 789.5,
        "relations_last_built": 321.25,
        "artist_family_projection_relations_last_built": 12.0,
    }
    relation_views = {"artists": ["Artist"], "artists_sidebar": [{"artist": "Artist", "count": 1}]}

    monkeypatch.setattr(
        state_module,
        "refresh_relation_views_in_state",
        lambda *_args, **_kwargs: pytest.fail(
            "Postgres relation refresh invoked the legacy filesystem builder"
        ),
    )
    monkeypatch.setattr(state_module, "library_root_cache_identity", lambda _config_arg: "root")
    monkeypatch.setattr(
        state_module,
        "save_cache_to_disk_for_config",
        lambda *_args, **_kwargs: {
            "relation_views": relation_views,
            "relations_last_built": 321.25,
        },
    )
    state_module.refresh_relation_views_for_state(library_state, config)

    assert library_state["artist_family_projection_relations_last_built"] == 12.0


def test_scan_cancelled_during_postgres_publication_rolls_back_before_rating_seed(
    config,
    monkeypatch,
):
    from music_app.services import cache as cache_module
    from music_app.services import scan_cache_persistence
    from music_app.services.library_indexing import ScanCancelled

    class CursorStub:
        def __init__(self, rows=None):
            self._rows = list(rows or [])

        def fetchall(self):
            return list(self._rows)

        def fetchone(self):
            return self._rows[0] if self._rows else None

    class TransactionConnectionStub:
        def __init__(self):
            self.cancelled_during_publication = False
            self.rolled_back = False
            self.executed = []
            self.commit_calls = 0

        def __enter__(self):
            return self

        def __exit__(self, exc_type, _exc, _traceback):
            self.rolled_back = exc_type is not None
            return False

        def execute(self, sql, params=None):
            self.executed.append((sql, params))
            if "bootstrap_context_ready" in sql:
                return CursorStub([{"bootstrap_context_ready": 1}])
            if "metadata -> 'scan_cache'" in sql:
                return CursorStub()
            if (
                "jsonb_build_object('scan_cache'" in sql
                and not self.cancelled_during_publication
            ):
                self.cancelled_during_publication = True
                assert state_module.cancel_background_refresh_for_state(library_state)
            return CursorStub()

        def commit(self):
            self.commit_calls += 1

    library_state = {
        "file_cache": {},
        "last_scan": 789.5,
        "relations_last_built": 321.25,
        "scan_generation": 1,
        "scan_in_progress": True,
        "scan_mode": "background",
    }
    connection = TransactionConnectionStub()
    seed_calls = []
    config["ALBUM_HAVEN_APP_DATABASE_URL"] = (
        "postgresql://album_haven_app@localhost/album_haven"
    )
    adapter = scan_cache_persistence.PostgresScanCacheAdapter(
        config,
        connect=lambda _database_url: connection,
        build_albums=lambda _file_cache, _selected_artists: [],
    )

    monkeypatch.setattr(state_module, "_CACHE_LOCK", threading.Lock())
    monkeypatch.setattr(
        state_module,
        "refresh_relation_views_in_state",
        lambda _state, _config: {"artists": []},
    )
    monkeypatch.setattr(
        state_module,
        "library_root_cache_identity",
        lambda _config: "root-identity",
    )
    monkeypatch.setattr(
        cache_module,
        "_select_runtime_scan_cache_adapter",
        lambda _config: adapter,
    )
    monkeypatch.setattr(scan_cache_persistence, "Jsonb", None)
    monkeypatch.setattr(
        scan_cache_persistence.PostgresAlbumRatingsService,
        "seed_missing_album_ratings_in_transaction",
        lambda _self, *args, **kwargs: seed_calls.append((args, kwargs)),
    )

    with pytest.raises(ScanCancelled):
        state_module.refresh_relation_views_for_state(
            library_state,
            config,
            seed_missing_album_ratings=True,
            expected_scan_generation=1,
        )

    assert connection.cancelled_during_publication is True
    assert connection.rolled_back is True
    assert connection.commit_calls == 0
    assert seed_calls == []
    assert library_state["scan_generation"] == 2


def test_committed_scan_generation_rejects_cancel_waiting_on_publication_lock(
    monkeypatch,
):
    lock = threading.Lock()
    library_state = {
        "scan_generation": 7,
        "scan_in_progress": True,
        "scan_mode": "background",
    }
    seed_entered = threading.Event()
    release_seed = threading.Event()
    cancel_attempted = threading.Event()
    results = {}

    monkeypatch.setattr(state_module, "_CACHE_LOCK", lock)

    def seed_action():
        seed_entered.set()
        assert release_seed.wait(timeout=2)
        return "committed"

    def run_publication_guard():
        results["publication"] = state_module._run_album_rating_seed_for_current_generation(
            library_state,
            7,
            seed_action,
        )

    def cancel_scan():
        cancel_attempted.set()
        results["cancelled"] = state_module.cancel_background_refresh_for_state(
            library_state
        )

    publication_thread = threading.Thread(target=run_publication_guard)
    cancellation_thread = threading.Thread(target=cancel_scan)
    publication_thread.start()
    assert seed_entered.wait(timeout=2)
    cancellation_thread.start()
    assert cancel_attempted.wait(timeout=2)
    cancellation_thread.join(timeout=0.05)
    assert cancellation_thread.is_alive()

    release_seed.set()
    publication_thread.join(timeout=2)
    cancellation_thread.join(timeout=2)

    assert not publication_thread.is_alive()
    assert not cancellation_thread.is_alive()
    assert results == {"publication": "committed", "cancelled": False}
    assert library_state["scan_generation"] == 7
    assert library_state["scan_committed_generation"] == 7
    assert library_state["scan_in_progress"] is True


def test_authoritative_cover_commit_invalidates_prepared_scan_publication(monkeypatch):
    lock = threading.Lock()
    scan_generation = 7
    track_path = "C:/Generated/Kaipa/Kaipa/01 Musiken ar ljuset.mp3"
    stale_cover_path = "C:/Generated/Kaipa/Kaipa/Art/Back.jpg"
    selected_cover_path = "C:/Generated/Kaipa/Kaipa/cover.jpg"
    stale_publication_state = {
        "file_cache": {
            track_path: {
                "path": track_path,
                "cover_path": stale_cover_path,
                "cover_revision": "stale-cover-revision",
            }
        },
        "albums": [
            SimpleNamespace(
                cover_path=stale_cover_path,
                cover_revision="stale-cover-revision",
            )
        ],
    }
    library_state = {
        "scan_generation": scan_generation,
        "scan_committed_generation": scan_generation,
        "scan_in_progress": True,
        "scan_mode": "background",
        "scan_phase": "publishing",
        **stale_publication_state,
    }
    monkeypatch.setattr(state_module, "_CACHE_LOCK", lock)

    def commit_authoritative_cover():
        library_state["file_cache"] = {
            track_path: {
                "path": track_path,
                "cover_path": selected_cover_path,
                "cover_revision": "selected-cover-revision",
            }
        }
        library_state["albums"] = [
            SimpleNamespace(
                cover_path=selected_cover_path,
                cover_revision="selected-cover-revision",
            )
        ]
        return {"ok": True, "selected_cover_path": selected_cover_path}

    commit_guard = getattr(
        state_module,
        "run_authoritative_cover_commit_for_state",
        None,
    )
    result = (
        commit_guard(library_state, commit_authoritative_cover)
        if callable(commit_guard)
        else commit_authoritative_cover()
    )

    # This is the final same-process publication check performed after the scan's
    # database transaction has committed but before its prepared state goes live.
    if int(library_state.get("scan_generation") or 0) == scan_generation:
        library_state.update(stale_publication_state)

    assert result == {"ok": True, "selected_cover_path": selected_cover_path}
    assert library_state["scan_outcome"] == "cancelled"
    assert {
        "scan_generation": library_state["scan_generation"],
        "scan_in_progress": library_state["scan_in_progress"],
        "file_cover_path": library_state["file_cache"][track_path]["cover_path"],
        "file_cover_revision": library_state["file_cache"][track_path]["cover_revision"],
        "album_cover_path": library_state["albums"][0].cover_path,
        "album_cover_revision": library_state["albums"][0].cover_revision,
    } == {
        "scan_generation": scan_generation + 1,
        "scan_in_progress": False,
        "file_cover_path": selected_cover_path,
        "file_cover_revision": "selected-cover-revision",
        "album_cover_path": selected_cover_path,
        "album_cover_revision": "selected-cover-revision",
    }


def test_relation_repair_waiting_for_database_allows_cancel_and_rejects_stale_commit(
    config,
    monkeypatch,
):
    lock = threading.Lock()
    library_state = {
        "file_cache": {},
        "last_scan": 789.5,
        "relations_last_built": 321.25,
        "scan_generation": 7,
        "scan_in_progress": True,
        "scan_mode": "background",
    }
    save_entered = threading.Event()
    release_save = threading.Event()
    cancel_attempted = threading.Event()
    results = {}

    monkeypatch.setattr(state_module, "_CACHE_LOCK", lock)
    monkeypatch.setattr(
        state_module,
        "refresh_relation_views_in_state",
        lambda _state, _config: {"artists": []},
    )
    monkeypatch.setattr(
        state_module,
        "library_root_cache_identity",
        lambda _config: "root-identity",
    )

    def save_snapshot(*_args, **kwargs):
        save_entered.set()
        assert release_save.wait(timeout=2)
        kwargs["publication_commit_guard"](
            lambda: results.update(database_committed=True)
        )
        return {
            "relation_views": {
                "artists": [],
                "artists_sidebar": [],
                "family_to_artists": {},
                "folder_related": {},
                "sidebar_families": [],
                "alias_to_canonical": {},
                "canonical_to_aliases": {},
            },
            "relations_last_built": 321.25,
        }

    monkeypatch.setattr(state_module, "save_cache_to_disk_for_config", save_snapshot)

    def repair_relations():
        try:
            state_module.refresh_relation_views_for_state(
                library_state,
                config,
                expected_scan_generation=7,
            )
            results["repaired"] = True
        except BaseException as exc:  # pragma: no cover - asserted below for thread handoff.
            results["repair_error"] = exc

    def cancel_scan():
        cancel_attempted.set()
        results["cancelled"] = state_module.cancel_background_refresh_for_state(
            library_state
        )

    repair_thread = threading.Thread(target=repair_relations)
    cancellation_thread = threading.Thread(target=cancel_scan)
    repair_thread.start()
    assert save_entered.wait(timeout=2)
    cancellation_thread.start()
    assert cancel_attempted.wait(timeout=2)
    cancellation_thread.join(timeout=0.25)
    cancellation_was_blocked = cancellation_thread.is_alive()

    release_save.set()
    repair_thread.join(timeout=2)
    cancellation_thread.join(timeout=2)

    assert not repair_thread.is_alive()
    assert not cancellation_thread.is_alive()
    assert cancellation_was_blocked is False
    assert results["cancelled"] is True
    assert isinstance(results["repair_error"], state_module.ScanCancelled)
    assert "database_committed" not in results
    assert "repaired" not in results
    assert library_state["scan_generation"] == 8


def test_guarded_relation_repair_waits_for_database_before_acquiring_cache_lock(
    config,
    monkeypatch,
):
    cache_lock = threading.Lock()
    library_state = {
        "file_cache": {},
        "last_scan": 789.5,
        "relations_last_built": 321.25,
        "scan_generation": 7,
        "scan_in_progress": True,
        "scan_mode": "background",
    }
    database_wait_entered = threading.Event()
    database_lock_acquired = threading.Event()
    publication_committed = threading.Event()
    events: list[str] = []
    errors: list[BaseException] = []

    monkeypatch.setattr(state_module, "_CACHE_LOCK", cache_lock)
    monkeypatch.setattr(
        state_module,
        "refresh_relation_views_in_state",
        lambda _state, _config: {"artists": ["Kaipa"]},
    )
    monkeypatch.setattr(
        state_module,
        "library_root_cache_identity",
        lambda _config: "generated-root",
    )

    def save_snapshot(*_args, **kwargs):
        events.append("database-wait-entered")
        database_wait_entered.set()
        cache_was_free_while_waiting_for_database = cache_lock.acquire(timeout=0.25)
        if not cache_was_free_while_waiting_for_database:
            raise AssertionError(
                "Guarded relation repair held _CACHE_LOCK while waiting for the database."
            )
        cache_lock.release()
        events.append("database-lock-acquired")
        database_lock_acquired.set()

        def commit_database_transaction():
            assert database_lock_acquired.is_set()
            cache_reacquired_inside_commit = cache_lock.acquire(timeout=0.05)
            if cache_reacquired_inside_commit:
                cache_lock.release()
                raise AssertionError(
                    "Publication commit ran without holding _CACHE_LOCK."
                )
            events.append("publication-commit")
            publication_committed.set()

        kwargs["publication_commit_guard"](commit_database_transaction)
        events.append("database-lock-released")
        return {
            "relation_views": {
                "artists": [],
                "artists_sidebar": [],
                "family_to_artists": {},
                "folder_related": {},
                "sidebar_families": [],
                "alias_to_canonical": {},
                "canonical_to_aliases": {},
            },
            "relations_last_built": 321.25,
        }

    monkeypatch.setattr(state_module, "save_cache_to_disk_for_config", save_snapshot)

    def repair_relations():
        try:
            state_module.refresh_relation_views_for_state(
                library_state,
                config,
                expected_scan_generation=7,
            )
        except BaseException as exc:  # pragma: no cover - asserted below for thread handoff.
            errors.append(exc)

    repair_thread = threading.Thread(target=repair_relations)
    repair_thread.start()
    assert database_wait_entered.wait(timeout=1)
    assert database_lock_acquired.wait(timeout=1)
    assert publication_committed.wait(timeout=1)
    repair_thread.join(timeout=1)

    assert not repair_thread.is_alive()
    assert errors == []
    assert events == [
        "database-wait-entered",
        "database-lock-acquired",
        "publication-commit",
        "database-lock-released",
    ]


def test_refresh_cached_cover_paths_for_state_uses_explicit_dependencies_without_flask_context(config, monkeypatch):
    library_state = {"file_cache": {"track-1": {"path": "track-1"}}}
    captured = []

    def fake_refresh_cached_cover_paths_in_library_state(state_arg, config_arg, **kwargs):
        captured.append((state_arg, config_arg, kwargs))
        return True

    monkeypatch.setattr(
        state_module,
        "refresh_cached_cover_paths_in_library_state",
        fake_refresh_cached_cover_paths_in_library_state,
    )
    monkeypatch.setattr(state_module.time, "time", lambda: 456.75)

    assert state_module.refresh_cached_cover_paths_for_state(
        library_state,
        config,
        min_interval_seconds=12.0,
    ) is True

    assert captured == [(
        library_state,
        config,
        {
            "min_interval_seconds": 12.0,
            "now": 456.75,
        },
    )]


def test_cover_file_cache_snapshot_for_state_uses_provided_state_without_flask_context():
    file_cache = {"track-1": {"path": "track-1"}}
    library_state = {"file_cache": file_cache}

    snapshot = state_module.cover_file_cache_snapshot_for_state(library_state)

    assert snapshot == file_cache
    assert snapshot is not file_cache
    assert snapshot["track-1"] is not file_cache["track-1"]


def test_progress_percent_helpers_use_provided_state_without_flask_context():
    library_state = {
        "scan_processed": 3,
        "scan_total": 6,
        "relations_processed": 2,
        "relations_total": 5,
    }

    assert state_module.scan_percent_for_state(library_state) == 50
    assert state_module.relations_percent_for_state(library_state) == 40
    assert state_module.scan_percent_for_state({"scan_processed": 1, "scan_total": 0}) == 0
    assert state_module.relations_percent_for_state({"relations_processed": 1, "relations_total": 0}) == 0


def test_run_cover_jobs_updates_cache_and_state(config, logger, library_state, monkeypatch):
    track_path = (config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    cover_path = track_path.parent / "cover.jpg"
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    cover_path.write_bytes(b"cover")

    library_state["file_cache"] = {
        str(track_path): {
            "path": str(track_path),
            "mtime": 1.0,
            "size": 1,
            "album": "Album",
            "album_artist": "Artist",
            "title": "Song",
            "track_number": 1,
            "disc_number": 1,
            "artist": "Artist",
            "duration_seconds": 0,
            "cover_path": None,
        }
    }
    library_state["covers_in_progress"] = True
    library_state["last_scan"] = 123.0
    saved = []

    monkeypatch.setattr(
        cover_refresh_execution,
        "execute_cover_job",
        lambda **kwargs: (
            cover_path,
            True,
            {"artist": "Artist", "album": "Album", "written_path": str(cover_path), "elapsed_ms": 5},
        ),
    )
    monkeypatch.setattr(
        cover_refresh_execution,
        "build_albums_from_file_cache",
        lambda file_cache, separate_release_keys: [{"key": "album-1", "cover_path": file_cache[str(track_path)]["cover_path"]}],
    )
    monkeypatch.setattr(
        cover_refresh_execution,
        "save_cache_to_disk_for_config",
        lambda config, cache_path, file_cache, root_identity, last_scan: saved.append(
            (config, cache_path, dict(file_cache), root_identity, last_scan)
        ),
    )
    monkeypatch.setattr(
        cover_refresh_execution,
        "library_root_cache_identity",
        lambda _config: "root-identity",
    )

    result = cover_refresh_execution.run_cover_jobs(
        get_state=lambda: library_state,
        config=config,
        logger=logger,
        cache_lock=threading.Lock(),
        jobs=[
            {
                "folder": track_path.parent,
                "artist": "Artist",
                "album": "Album",
                "track_paths": [str(track_path)],
            }
        ],
        file_cache=dict(library_state["file_cache"]),
        separate_release_keys=set(),
        image_extensions={".jpg"},
        user_agent="Album Haven Test",
        cover_cache=type("CacheStub", (), {"save": lambda self: None})(),
    )

    assert result["changed"] is True
    assert result["downloaded"] == 1
    assert result["downloaded_paths"] == [str(cover_path)]
    assert library_state["file_cache"][str(track_path)]["cover_path"] == str(cover_path)
    assert library_state["albums"] == [{"key": "album-1", "cover_path": str(cover_path)}]
    assert library_state["covers_in_progress"] is False
    assert saved and saved[0][0] is config


def test_run_cover_jobs_preserves_user_controlled_linked_cover_fields_when_write_is_blocked(
    config,
    logger,
    library_state,
    monkeypatch,
):
    track_path = (config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    cover_path = track_path.parent / "cover.jpg"
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    cover_path.write_bytes(b"user-controlled-cover")
    original_entry = {
        "path": str(track_path),
        "album": "Album",
        "album_artist": "Artist",
        "cover_path": str(cover_path),
        "cover_selection_origin": "user",
        "remote_cover_url": "https://images.example/user-cover.jpg",
        "remote_cover_thumbnail_url": "https://images.example/user-thumb.jpg",
        "remote_cover_source": "spotify",
        "remote_cover_source_label": "Spotify",
        "remote_cover_album_url": "https://open.example/album",
        "remote_cover_width": 1200,
        "remote_cover_height": 1200,
    }
    file_cache = {str(track_path): dict(original_entry)}
    library_state.update(
        {
            "file_cache": file_cache,
            "covers_in_progress": True,
            "last_scan": 123.0,
        }
    )

    monkeypatch.setattr(
        cover_refresh_execution,
        "execute_cover_job",
        lambda **_kwargs: (
            cover_path,
            False,
            {
                "artist": "Artist",
                "album": "Album",
                "reason": "automatic_write_blocked_by_user_selection",
            },
        ),
    )
    monkeypatch.setattr(
        cover_refresh_execution,
        "save_cache_to_disk_for_config",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(
            AssertionError("A blocked automatic write must not persist cache changes")
        ),
    )

    result = cover_refresh_execution.run_cover_jobs(
        get_state=lambda: library_state,
        config=config,
        logger=logger,
        cache_lock=threading.Lock(),
        jobs=[
            {
                "folder": track_path.parent,
                "artist": "Artist",
                "album": "Album",
                "track_paths": [str(track_path)],
                "cover_selection_origin": "user",
            }
        ],
        file_cache=file_cache,
        separate_release_keys=set(),
        image_extensions={".jpg"},
        user_agent="Album Haven Test",
        cover_cache=type("CacheStub", (), {"save": lambda self: None})(),
    )

    assert result["changed"] is False
    assert file_cache[str(track_path)] == original_entry


def test_run_cover_jobs_owns_automatic_candidate_publishers_per_album(
    config,
    logger,
    library_state,
    monkeypatch,
):
    events: list[tuple[object, ...]] = []

    class Repository:
        def __init__(self, repository_config):
            assert repository_config["ALBUM_HAVEN_APP_DATABASE_URL"] == "postgresql://covers"
            events.append(("repository",))

    class Publisher:
        def __init__(
            self,
            repository,
            *,
            album_id,
            search_generation,
            search_kind,
        ):
            assert isinstance(repository, Repository)
            assert search_generation
            assert search_kind == "automatic"
            self.album_id = album_id
            events.append(("publisher", album_id, search_generation, search_kind))

        def begin_candidate_generation(self):
            events.append(("begin", self.album_id))

        def publish_candidates(self, candidates, *, automatic_improvement=False):
            events.append(
                (
                    "publish",
                    self.album_id,
                    [candidate["url"] for candidate in candidates],
                    automatic_improvement,
                )
            )
            return True

        def complete(self):
            events.append(("complete", self.album_id))
            return True

        def fail(self):
            events.append(("fail", self.album_id))
            return True

    configured = {
        **config,
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://covers",
    }
    jobs = []
    file_cache = {}
    for album_id, album, should_fail in (
        (101, "Completed Album", False),
        (102, "Failed Album", True),
    ):
        track_path = (configured["MUSIC_DIR"] / "Artist" / album / "song.mp3").resolve()
        track_path.parent.mkdir(parents=True)
        track_path.write_bytes(b"track")
        cover_path = track_path.parent / "cover.jpg"
        if not should_fail:
            cover_path.write_bytes(b"cover")
        file_cache[str(track_path)] = {
            "path": str(track_path),
            "album": album,
            "album_artist": "Artist",
            "cover_path": str(cover_path) if not should_fail else None,
            "cover_selection_origin": "automatic" if not should_fail else None,
        }
        jobs.append(
            {
                "album_id": album_id,
                "folder": track_path.parent,
                "artist": "Artist",
                "album": album,
                "track_paths": [str(track_path)],
                "cover_selection_origin": "automatic" if not should_fail else None,
                "should_fail": should_fail,
            }
        )

    def execute(**kwargs):
        job = kwargs["job"]
        callback = kwargs["candidate_callback"]
        callback(
            {
                "source": "cover_art_archive",
                "url": f"https://images.example/{job['album_id']}.jpg",
                "width": 1200,
                "height": 1200,
                "score": 0.95,
            }
        )
        if job["should_fail"]:
            return None, False, {"reason": "candidate_download_failed"}
        return Path(file_cache[job["track_paths"][0]]["cover_path"]), False, {
            "reason": "remote_not_better_than_local"
        }

    monkeypatch.setattr(
        cover_refresh_execution,
        "AlbumCoverCandidateSnapshotRepository",
        Repository,
        raising=False,
    )
    monkeypatch.setattr(
        cover_refresh_execution,
        "AlbumCoverCandidatePublisher",
        Publisher,
        raising=False,
    )
    monkeypatch.setattr(cover_refresh_execution, "execute_cover_job", execute)
    library_state.update(
        {
            "file_cache": file_cache,
            "covers_in_progress": True,
            "last_scan": 123.0,
        }
    )

    result = cover_refresh_execution.run_cover_jobs(
        get_state=lambda: library_state,
        config=configured,
        logger=logger,
        cache_lock=threading.Lock(),
        jobs=jobs,
        file_cache=file_cache,
        separate_release_keys=set(),
        image_extensions={".jpg"},
        user_agent="Album Haven Test",
        cover_cache=type("CacheStub", (), {"save": lambda self: None})(),
    )

    assert result["processed"] == 2
    assert [(event[0], event[1]) for event in events if event[0] == "publish"] == [
        ("publish", 101),
        ("publish", 102),
    ]
    assert ("complete", 101) in events
    assert ("fail", 102) in events


def test_automatic_candidate_payload_preserves_provider_storage_policy_metadata():
    from music_app.services.cover_provider_candidates import CoverCandidate

    candidate = CoverCandidate(
        source="spotify",
        url="https://i.scdn.co/image/automatic-cover",
        width=1200,
        height=1200,
        score=0.95,
        debug_payload={
            "source_label": "Spotify",
            "thumbnail_url": "https://i.scdn.co/image/automatic-cover-thumb",
            "album_url": "https://open.spotify.com/album/automatic-album",
        },
    )

    payload = cover_refresh_execution._automatic_candidate_payload(candidate)

    assert payload["source"] == "spotify"
    assert payload["source_label"] == "Spotify"
    assert payload["thumbnail_url"] == "https://i.scdn.co/image/automatic-cover-thumb"
    assert payload["album_url"] == "https://open.spotify.com/album/automatic-album"
    assert payload["display_only"] is True


def test_run_cover_jobs_resolves_album_id_from_tracks_before_publishing_candidates(
    config,
    logger,
    library_state,
    monkeypatch,
):
    track_path = (config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True)
    track_path.write_bytes(b"track")
    file_cache = {
        str(track_path): {
            "path": str(track_path),
            "album": "Album",
            "album_artist": "Artist",
            "cover_path": None,
        }
    }
    events: list[tuple[object, ...]] = []

    class Repository:
        def __init__(self, _config):
            return None

        def resolve_album_id_for_track_paths(self, track_paths):
            events.append(("resolve", tuple(track_paths)))
            return 303

    class Publisher:
        def __init__(self, _repository, *, album_id, **_kwargs):
            events.append(("publisher", album_id))

        def begin_candidate_generation(self):
            return None

        def publish_candidates(self, candidates, **_kwargs):
            events.append(("publish", candidates[0]["url"]))
            return True

        def complete(self):
            return True

    def execute(**kwargs):
        kwargs["candidate_callback"](
            {
                "source": "apple",
                "url": "https://images.example/cover.jpg",
                "width": 1200,
                "height": 1200,
                "score": 0.95,
            }
        )
        return None, False, {"reason": "remote_not_better_than_local"}

    monkeypatch.setattr(
        cover_refresh_execution,
        "AlbumCoverCandidateSnapshotRepository",
        Repository,
        raising=False,
    )
    monkeypatch.setattr(
        cover_refresh_execution,
        "AlbumCoverCandidatePublisher",
        Publisher,
        raising=False,
    )
    monkeypatch.setattr(cover_refresh_execution, "execute_cover_job", execute)
    library_state.update({"file_cache": file_cache, "covers_in_progress": True})

    result = cover_refresh_execution.run_cover_jobs(
        get_state=lambda: library_state,
        config={**config, "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://covers"},
        logger=logger,
        cache_lock=threading.Lock(),
        jobs=[
            {
                "folder": track_path.parent,
                "artist": "Artist",
                "album": "Album",
                "track_paths": [str(track_path)],
            }
        ],
        file_cache=file_cache,
        separate_release_keys=set(),
        image_extensions={".jpg"},
        user_agent="Album Haven Test",
        cover_cache=type("CacheStub", (), {"save": lambda self: None})(),
    )

    assert result["processed"] == 1
    assert ("resolve", (str(track_path),)) in events
    assert ("publisher", 303) in events
    assert ("publish", "https://images.example/cover.jpg") in events


def test_run_cover_jobs_logs_publisher_failure_and_continues_cover_processing(
    config,
    logger,
    library_state,
    monkeypatch,
):
    track_path = (config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True)
    track_path.write_bytes(b"track")
    file_cache = {
        str(track_path): {
            "path": str(track_path),
            "album": "Album",
            "album_artist": "Artist",
            "cover_path": None,
            "cover_selection_origin": None,
        }
    }
    processing_finished = []

    class Repository:
        def __init__(self, _config):
            return None

    class Publisher:
        def __init__(self, _repository, **_kwargs):
            return None

        def begin_candidate_generation(self):
            return None

        def publish_candidates(self, _candidates, **_kwargs):
            raise RuntimeError("candidate snapshot unavailable")

        def fail(self):
            return False

    def execute(**kwargs):
        kwargs["candidate_callback"](
            {
                "source": "cover_art_archive",
                "url": "https://images.example/cover.jpg",
            }
        )
        processing_finished.append(True)
        return None, False, {"reason": "candidate_download_failed"}

    monkeypatch.setattr(
        cover_refresh_execution,
        "AlbumCoverCandidateSnapshotRepository",
        Repository,
        raising=False,
    )
    monkeypatch.setattr(
        cover_refresh_execution,
        "AlbumCoverCandidatePublisher",
        Publisher,
        raising=False,
    )
    monkeypatch.setattr(cover_refresh_execution, "execute_cover_job", execute)
    library_state.update({"file_cache": file_cache, "covers_in_progress": True})

    result = cover_refresh_execution.run_cover_jobs(
        get_state=lambda: library_state,
        config={**config, "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://covers"},
        logger=logger,
        cache_lock=threading.Lock(),
        jobs=[
            {
                "album_id": 101,
                "folder": track_path.parent,
                "artist": "Artist",
                "album": "Album",
                "track_paths": [str(track_path)],
                "cover_selection_origin": None,
            }
        ],
        file_cache=file_cache,
        separate_release_keys=set(),
        image_extensions={".jpg"},
        user_agent="Album Haven Test",
        cover_cache=type("CacheStub", (), {"save": lambda self: None})(),
    )

    assert processing_finished == [True]
    assert result["processed"] == 1
    assert any(
        "candidate" in message.casefold() and "snapshot" in message.casefold()
        for message, _args in logger.warning_messages
    )


def test_run_cover_jobs_uses_explicit_dependencies_without_request_context(config, logger, monkeypatch):
    track_path = (config["MUSIC_DIR"] / "Artist" / "Album" / "outside.mp3").resolve()
    cover_path = track_path.parent / "cover.jpg"
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")
    cover_path.write_bytes(b"cover")

    library_state = {
        "file_cache": {
            str(track_path): {
                "path": str(track_path),
                "album": "Album",
                "album_artist": "Artist",
                "cover_path": str(cover_path),
                "cover_revision": "stale-cover-revision",
            }
        },
        "covers_in_progress": True,
        "last_scan": 456.0,
    }
    saved = []

    monkeypatch.setattr(
        cover_refresh_execution,
        "execute_cover_job",
        lambda **kwargs: (
            cover_path,
            True,
            {"artist": "Artist", "album": "Album", "written_path": str(cover_path), "elapsed_ms": 5},
        ),
    )
    monkeypatch.setattr(
        cover_refresh_execution,
        "build_albums_from_file_cache",
        lambda file_cache, separate_release_keys: [{"key": "album-1", "cover_path": file_cache[str(track_path)]["cover_path"]}],
    )
    monkeypatch.setattr(
        cover_refresh_execution,
        "save_cache_to_disk_for_config",
        lambda config, cache_path, file_cache, root_identity, last_scan: saved.append(
            (config, cache_path, dict(file_cache), root_identity, last_scan)
        ),
    )
    monkeypatch.setattr(
        cover_refresh_execution,
        "library_root_cache_identity",
        lambda _config: "root-identity",
    )

    result = cover_refresh_execution.run_cover_jobs(
        get_state=lambda: library_state,
        config=config,
        logger=logger,
        cache_lock=threading.Lock(),
        jobs=[
            {
                "folder": track_path.parent,
                "artist": "Artist",
                "album": "Album",
                "track_paths": [str(track_path)],
            }
        ],
        file_cache=dict(library_state["file_cache"]),
        separate_release_keys=set(),
        image_extensions={".jpg"},
        user_agent="Album Haven Test",
        cover_cache=type("CacheStub", (), {"save": lambda self: None})(),
    )

    assert result["changed"] is True
    assert result["downloaded"] == 1
    assert library_state["file_cache"][str(track_path)]["cover_path"] == str(cover_path)
    assert library_state["file_cache"][str(track_path)]["cover_revision"] == hashlib.sha256(
        cover_path.read_bytes()
    ).hexdigest()
    assert library_state["albums"] == [{"key": "album-1", "cover_path": str(cover_path)}]
    assert library_state["covers_in_progress"] is False
    assert saved and saved[0][0] is config
    assert saved[0][3] == "root-identity"
    assert saved[0][4] == 456.0
    assert logger.verbose_messages


def test_run_cover_jobs_counts_disabled_remote_provider_group_as_skipped(config, logger, tmp_path, monkeypatch):
    folder = tmp_path / "Artist" / "Album"
    folder.mkdir(parents=True)
    provider_calls = []

    def fail_provider(*args, **kwargs):
        provider_calls.append((args, kwargs))
        raise AssertionError("disabled remote provider group must not call providers")

    monkeypatch.setattr(cover_refresh_execution.cover_refresh_provider, "_search_apple", fail_provider)
    monkeypatch.setattr(cover_refresh_execution.cover_refresh_provider, "_search_deezer", fail_provider)
    monkeypatch.setattr(cover_refresh_execution.cover_refresh_provider, "_search_spotify", fail_provider)
    config["COVER_PROVIDER_GROUPS"] = "offline"
    library_state = {"covers_downloaded": 0, "covers_in_progress": True}

    result = cover_refresh_execution.run_cover_jobs(
        get_state=lambda: library_state,
        config=config,
        logger=logger,
        cache_lock=threading.Lock(),
        jobs=[{"folder": folder, "artist": "Artist", "album": "Album", "track_paths": []}],
        file_cache={},
        separate_release_keys=set(),
        image_extensions={".jpg"},
        user_agent="Album Haven Test",
        cover_cache=type("CacheStub", (), {"save": lambda self: None})(),
    )

    assert provider_calls == []
    assert result["processed"] == 1
    assert result["downloaded"] == 0
    assert result["failed"] == 0
    assert result["skipped"] == 1
    assert result["job_results"][0]["reason"] == "remote_provider_group_disabled"


def test_run_cover_jobs_aborts_when_cover_generation_changes(config, logger, library_state, monkeypatch):
    track_path = (config["MUSIC_DIR"] / "Artist" / "Album" / "song.mp3").resolve()
    track_path.parent.mkdir(parents=True, exist_ok=True)
    track_path.write_bytes(b"track")

    library_state["file_cache"] = {str(track_path): {"cover_path": None}}
    library_state["cover_generation"] = 8
    library_state["covers_in_progress"] = True

    called = []
    monkeypatch.setattr(
        cover_refresh_execution,
        "execute_cover_job",
        lambda **kwargs: called.append(True) or (None, False, {"reason": "should_not_run"}),
    )

    result = cover_refresh_execution.run_cover_jobs(
        get_state=lambda: library_state,
        config=config,
        logger=logger,
        cache_lock=threading.Lock(),
        jobs=[
            {
                "folder": track_path.parent,
                "artist": "Artist",
                "album": "Album",
                "track_paths": [str(track_path)],
            }
        ],
        file_cache=dict(library_state["file_cache"]),
        separate_release_keys=set(),
        image_extensions={".jpg"},
        user_agent="Album Haven Test",
        cover_cache=type("CacheStub", (), {"save": lambda self: None})(),
        cover_generation=7,
    )

    assert called == []
    assert result["changed"] is False
    assert result["processed"] == 0
    assert library_state["covers_in_progress"] is False
