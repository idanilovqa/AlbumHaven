from __future__ import annotations

import json
import time
from pathlib import Path
from threading import Barrier, Event, Thread
from types import SimpleNamespace

import pytest

import music_app.routes.api_problematic_albums as api_problematic_albums_module
from music_app.routes.api_problematic_albums import (
    build_problematic_album_detail_payload as build_problematic_album_detail_read_payload,
    build_problematic_albums_payload as build_problematic_albums_read_payload,
)
from music_app.services import problematic_albums as problematic_albums_module
from music_app.services.problematic_albums import (
    build_problematic_album_detail_payload,
    build_problematic_albums_payload,
    find_problematic_album_by_track_paths,
    has_cached_problematic_albums_payload,
    invalidate_problematic_albums_payload_cache,
    queue_problematic_albums_prewarm,
)
from tests.py.runtime_testing import configure_test_app_paths


@pytest.fixture
def config(tmp_path, monkeypatch):
    paths = configure_test_app_paths(tmp_path, monkeypatch)
    return {
        "DATA_DIR": paths["data_dir"],
        "MUSIC_DIR": paths["music_dir"],
        "CACHE_PATH": paths["cache_path"],
        "COVER_CACHE_PATH": paths["cover_cache_path"],
        "LIBRARY_ROOTS_PATH": paths["library_roots_path"],
        "TESTING": True,
    }


def test_problematic_albums_tests_do_not_import_flask_fixtures():
    source = Path(__file__).read_text(encoding="utf-8")

    assert "tests.py." + "flask_fixtures" not in source


def _problematic_payload_kwargs(**overrides):
    kwargs = {
        "text_problem_reason": lambda *args, **kwargs: None,
        "artist_alias_problem_reason": lambda *args, **kwargs: None,
        "year_problem_reason": lambda *args, **kwargs: None,
        "all_track_text_problems_ignored": lambda *args, **kwargs: False,
        "all_track_year_problems_ignored": lambda *args, **kwargs: False,
        "collect_track_level_problem_reasons": lambda *args, **kwargs: [],
        "build_encoding_repair_preview": lambda *args, **kwargs: {
            "has_repairs": False,
            "raw_name": "",
            "raw_album_artist": "",
            "preview_rows": [],
        },
        "collect_track_problem_rows": lambda *args, **kwargs: [],
        "separate_release_candidate": lambda *args, **kwargs: None,
        "image_dimensions": lambda *_args, **_kwargs: (0, 0),
    }
    kwargs.update(overrides)
    return kwargs


def _problematic_read_payload_kwargs(**overrides):
    kwargs = _problematic_payload_kwargs(
        state_getter=lambda: {
            "albums": [],
            "file_cache": {},
            "relation_views": {},
        },
        config={},
        load_ignored_repair_keys=lambda _config: set(),
        load_separate_release_keys=lambda _config: set(),
        album_to_dict=lambda current_album: {
            "key": getattr(current_album, "key", ""),
            "name": getattr(current_album, "name", ""),
            "album_artist": getattr(current_album, "album_artist", ""),
            "tracks": [],
        },
        get_album_duplicate_sources=lambda *_args, **_kwargs: [],
        poor_art_min_edge=600,
    )
    kwargs.update(overrides)
    return kwargs


def test_problematic_albums_cache_revision_invalidation_is_monotonic_under_concurrency():
    class SlowRevisionState(dict):
        def get(self, key, default=None):
            value = super().get(key, default)
            if key == problematic_albums_module._PROBLEMATIC_ALBUMS_CACHE_REVISION_KEY:
                time.sleep(0.01)
            return value

    worker_count = 8
    start = Barrier(worker_count)
    st = SlowRevisionState()

    def invalidate() -> None:
        start.wait()
        invalidate_problematic_albums_payload_cache(st)

    workers = [Thread(target=invalidate) for _ in range(worker_count)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join(timeout=2)

    assert all(not worker.is_alive() for worker in workers)
    assert st[problematic_albums_module._PROBLEMATIC_ALBUMS_CACHE_REVISION_KEY] == worker_count


def test_problematic_albums_build_does_not_publish_cache_invalidated_during_active_build(
    config,
    monkeypatch,
):
    build_started = Event()
    allow_build_to_finish = Event()
    st = {"albums": [], "file_cache": {}, "relation_views": {}}

    def blocked_build(**_kwargs):
        build_started.set()
        assert allow_build_to_finish.wait(timeout=2)
        return {"items": [{"album_key": "stale"}]}

    monkeypatch.setattr(
        problematic_albums_module,
        "build_problematic_albums_read_payload",
        blocked_build,
    )
    result: list[dict[str, object]] = []
    worker = Thread(
        target=lambda: result.append(
            build_problematic_albums_payload(
                library_state=st,
                config=config,
                **_problematic_payload_kwargs(),
            )
        )
    )

    worker.start()
    assert build_started.wait(timeout=2)
    invalidate_problematic_albums_payload_cache(st)
    allow_build_to_finish.set()
    worker.join(timeout=2)

    assert not worker.is_alive()
    assert result == [{"items": [{"album_key": "stale"}]}]
    assert has_cached_problematic_albums_payload(st, config=config) is False
    assert problematic_albums_module._PROBLEMATIC_ALBUMS_CACHE_KEY not in st


def test_find_problematic_album_by_track_paths_returns_matching_item():
    payload = {
        "items": [
            {"key": "problem-1", "tracks": [{"path": "a.mp3"}]},
            {"key": "problem-2", "tracks": [{"path": "b.mp3"}]},
        ]
    }

    match = find_problematic_album_by_track_paths(
        {"b.mp3"},
        build_problematic_albums_payload=lambda: payload,
    )

    assert match == {"key": "problem-2", "tracks": [{"path": "b.mp3"}]}


def test_build_problematic_album_detail_payload_ignores_e2e_fixture_file(config, monkeypatch, tmp_path):
    fixture_path = tmp_path / "problematic-fixture.json"
    fixture_path.write_text(json.dumps({
        "summary": {
            "items": [
                {
                    "key": "fixture-album",
                    "name": "Fixture Album",
                    "album_artist": "Fixture Artist",
                    "problem_reasons": ["Missing year"],
                    "track_paths": ["D:/Music/Fixture Artist/Fixture Album/01.flac"],
                    "tracks": [{"path": "D:/Music/Fixture Artist/Fixture Album/01.flac", "title": "Track One"}],
                    "detail_loaded": False,
                },
            ],
            "count": 1,
        },
        "details": {},
    }), encoding="utf-8")
    monkeypatch.setenv("ALBUM_HAVEN_E2E_PROBLEMATIC_FIXTURE_PATH", str(fixture_path))
    calls = []

    def fake_detail_read_payload(**kwargs):
        calls.append(kwargs)
        return {
            "key": "product-album",
            "name": "Product Album",
            "detail_loaded": True,
            "problematic_track_paths": ["D:/Music/Product Artist/Product Album/01.flac"],
            "repair_preview_rows": [],
            "track_problem_rows": [{"path": "D:/Music/Product Artist/Product Album/01.flac"}],
        }

    monkeypatch.setattr(
        problematic_albums_module,
        "build_problematic_album_detail_read_payload",
        fake_detail_read_payload,
    )

    payload = build_problematic_album_detail_payload(
        "product-album",
        **_problematic_payload_kwargs(
            config=config,
            library_state={"albums": [], "file_cache": {}, "relation_views": {}},
        ),
    )

    assert payload is not None
    assert payload["key"] == "product-album"
    assert payload["name"] == "Product Album"
    assert payload["detail_loaded"] is True
    assert payload["problematic_track_paths"] == ["D:/Music/Product Artist/Product Album/01.flac"]
    assert payload["repair_preview_rows"] == []
    assert payload["track_problem_rows"] == [{"path": "D:/Music/Product Artist/Product Album/01.flac"}]
    assert calls[0]["album_key"] == "product-album"
    assert calls[0]["config"] is config


def test_build_problematic_albums_payload_uses_explicit_dependencies_without_flask_context(config, monkeypatch):
    built_kwargs = []
    log_calls = []
    st = {
        "albums": [
            SimpleNamespace(
                key="album-1",
                name="Album",
                album_artist="Artist",
                artists=["Artist"],
                cover_path=None,
                year=2001,
                edition="",
                album_rating=0,
                total_duration_seconds=0,
                tracks=[],
                is_compilation=False,
            )
        ],
        "file_cache": {},
        "relation_views": {},
    }
    logger = SimpleNamespace(info=lambda *args: log_calls.append(args))

    def fake_build_problematic_albums_read_payload(**kwargs):
        built_kwargs.append(kwargs)
        return {"items": [{"key": "problem-1", "tracks": []}], "count": 1}

    monkeypatch.setattr(
        problematic_albums_module,
        "build_problematic_albums_read_payload",
        fake_build_problematic_albums_read_payload,
    )

    payload = build_problematic_albums_payload(
        **_problematic_payload_kwargs(
            config=config,
            library_state=st,
            logger=logger,
        )
    )

    assert payload == {"items": [{"key": "problem-1", "tracks": []}], "count": 1}
    assert built_kwargs[0]["config"] is config
    assert built_kwargs[0]["state_getter"]() is st
    assert has_cached_problematic_albums_payload(st, config=config) is True


def test_build_problematic_albums_payload_ignores_empty_e2e_fixture_summary(config, monkeypatch, tmp_path):
    fixture_path = tmp_path / "problematic-fixture-empty.json"
    fixture_path.write_text(json.dumps({
        "summary": {
            "items": [],
            "count": 0,
        },
    }), encoding="utf-8")
    monkeypatch.setenv("ALBUM_HAVEN_E2E_PROBLEMATIC_FIXTURE_PATH", str(fixture_path))
    calls = []

    def fake_summary_read_payload(**kwargs):
        calls.append(kwargs)
        return {"items": [], "count": 0}

    monkeypatch.setattr(
        problematic_albums_module,
        "build_problematic_albums_read_payload",
        fake_summary_read_payload,
    )

    library_state = {"albums": [], "file_cache": {}, "relation_views": {}}
    assert build_problematic_albums_payload(
        **_problematic_payload_kwargs(
            config=config,
            library_state=library_state,
        ),
    ) == {"items": [], "count": 0}
    assert calls[0]["config"] is config
    assert calls[0]["state_getter"]() is library_state


def test_has_cached_problematic_albums_payload_without_config_returns_false_before_state_lookup():
    st = {
        problematic_albums_module._PROBLEMATIC_ALBUMS_CACHE_KEY: {"items": [], "count": 0},
        problematic_albums_module._PROBLEMATIC_ALBUMS_CACHE_SIGNATURE_KEY: ("cached",),
    }

    assert has_cached_problematic_albums_payload(st) is False
    assert has_cached_problematic_albums_payload() is False


def test_build_problematic_albums_payload_without_config_raises_before_state_lookup():
    with pytest.raises(ValueError, match="config is required"):
        build_problematic_albums_payload(**_problematic_payload_kwargs())


def test_problematic_albums_helpers_require_explicit_library_state(config):
    with pytest.raises(ValueError, match="library_state is required"):
        invalidate_problematic_albums_payload_cache()

    with pytest.raises(ValueError, match="library_state is required"):
        has_cached_problematic_albums_payload(config=config)

    with pytest.raises(ValueError, match="library_state is required"):
        build_problematic_albums_payload(**_problematic_payload_kwargs(config=config))

    with pytest.raises(ValueError, match="library_state is required"):
        build_problematic_album_detail_payload(
            "album-1",
            **_problematic_payload_kwargs(config=config),
        )


def test_direct_problematic_albums_summary_payload_requires_config_before_state_lookup():
    def fail_state():
        raise AssertionError("missing config must fail before resolving direct read state")

    with pytest.raises(ValueError, match="config is required"):
        build_problematic_albums_read_payload(
            **_problematic_read_payload_kwargs(config=None, state_getter=fail_state),
        )


def test_direct_problematic_album_detail_payload_requires_config_before_state_lookup():
    def fail_state():
        raise AssertionError("missing config must fail before resolving direct detail state")

    with pytest.raises(ValueError, match="config is required"):
        build_problematic_album_detail_read_payload(
            album_key="album-1",
            **_problematic_read_payload_kwargs(config=None, state_getter=fail_state),
        )


def test_direct_problematic_album_helpers_do_not_expose_flask_globals():
    assert "current_app" not in vars(api_problematic_albums_module)
    assert "Flask" not in vars(api_problematic_albums_module)


def test_build_problematic_albums_payload_reuses_cached_payload_until_invalidated(config, monkeypatch):
    call_count = 0

    def fake_build_problematic_albums_read_payload(**_kwargs):
        nonlocal call_count
        call_count += 1
        return {"items": [{"key": f"problem-{call_count}", "tracks": []}], "count": call_count}

    monkeypatch.setattr(
        problematic_albums_module,
        "build_problematic_albums_read_payload",
        fake_build_problematic_albums_read_payload,
    )

    st = {
        "albums": [
            SimpleNamespace(
                key="album-1",
                name="Album",
                album_artist="Artist",
                artists=["Artist"],
                cover_path=None,
                year=2001,
                edition="",
                album_rating=0,
                total_duration_seconds=0,
                tracks=[],
                is_compilation=False,
            )
        ],
        "file_cache": {},
        "relation_views": {},
    }
    invalidate_problematic_albums_payload_cache(st)

    payload = build_problematic_albums_payload(
        **_problematic_payload_kwargs(config=config, library_state=st),
    )
    cached_payload = build_problematic_albums_payload(
        **_problematic_payload_kwargs(config=config, library_state=st),
    )

    assert payload == {"items": [{"key": "problem-1", "tracks": []}], "count": 1}
    assert cached_payload is payload
    assert call_count == 1

    invalidate_problematic_albums_payload_cache(st)
    refreshed_payload = build_problematic_albums_payload(
        **_problematic_payload_kwargs(config=config, library_state=st),
    )

    assert refreshed_payload == {"items": [{"key": "problem-2", "tracks": []}], "count": 2}
    assert call_count == 2


def test_problematic_albums_cache_uses_explicit_revision_not_legacy_json_files(config, monkeypatch):
    call_count = 0

    def fake_build_problematic_albums_read_payload(**_kwargs):
        nonlocal call_count
        call_count += 1
        return {"items": [], "count": call_count}

    monkeypatch.setattr(
        problematic_albums_module,
        "build_problematic_albums_read_payload",
        fake_build_problematic_albums_read_payload,
    )

    st = {
        "albums": [],
        "file_cache": {},
        "relation_views": {},
    }
    invalidate_problematic_albums_payload_cache(st)

    first_payload = build_problematic_albums_payload(
        **_problematic_payload_kwargs(config=config, library_state=st),
    )

    revision_after_first_invalidation = st[problematic_albums_module._PROBLEMATIC_ALBUMS_CACHE_REVISION_KEY]
    legacy_path = Path(config["DATA_DIR"]) / "ignored_repairs.json"
    legacy_path.parent.mkdir(parents=True, exist_ok=True)
    legacy_path.write_text(json.dumps({"ignored_row_keys": ["track.mp3::title"]}), encoding="utf-8")

    cached_payload = build_problematic_albums_payload(
        **_problematic_payload_kwargs(config=config, library_state=st),
    )

    assert first_payload == {"items": [], "count": 1}
    assert cached_payload is first_payload
    assert call_count == 1

    invalidate_problematic_albums_payload_cache(st)
    assert st[problematic_albums_module._PROBLEMATIC_ALBUMS_CACHE_REVISION_KEY] == revision_after_first_invalidation + 1
    refreshed_payload = build_problematic_albums_payload(
        **_problematic_payload_kwargs(config=config, library_state=st),
    )

    assert refreshed_payload == {"items": [], "count": 2}
    assert call_count == 2

    source = Path(problematic_albums_module.__file__).read_text(encoding="utf-8")
    assert "_data_file_signature" not in source
    assert ".stat(" not in source
    assert "ignored_repairs.json" not in source
    assert "separate_releases.json" not in source


def test_build_problematic_albums_payload_logs_summary_timing(config, monkeypatch):
    log_calls = []

    monkeypatch.setattr(
        problematic_albums_module,
        "build_problematic_albums_read_payload",
        lambda **_kwargs: {"items": [{"key": "problem-1"}], "count": 1},
    )
    logger = SimpleNamespace(info=lambda *args: log_calls.append(args))

    st = {
        "albums": [],
        "file_cache": {},
        "relation_views": {},
    }
    invalidate_problematic_albums_payload_cache(st)

    payload = build_problematic_albums_payload(
        **_problematic_payload_kwargs(config=config, library_state=st, logger=logger),
    )

    assert payload == {"items": [{"key": "problem-1"}], "count": 1}
    assert log_calls
    assert log_calls[0][0] == "Problematic albums timing: %s"
    assert log_calls[0][1]["kind"] == "summary_payload"
    assert log_calls[0][1]["cache_status"] == "miss"
    assert log_calls[0][1]["item_count"] == 1
    assert log_calls[0][1]["elapsed_ms"] >= 0


def test_queue_problematic_albums_prewarm_builds_payload_in_background_once_without_app_context(config, monkeypatch):
    submitted = []
    built_payloads = []
    warnings = []

    monkeypatch.setattr(
        problematic_albums_module._PROBLEMATIC_ALBUMS_PREWARM_EXECUTOR,
        "submit",
        lambda fn, *args, **kwargs: submitted.append((fn, args, kwargs)) or fn(*args, **kwargs),
    )

    st = {
        "albums": [SimpleNamespace(key="album-1", tracks=[])],
        "file_cache": {"track-1": {"path": "track-1"}},
        "relation_views": {},
        "scan_in_progress": False,
        "covers_in_progress": False,
    }
    logger = SimpleNamespace(warning=lambda *args: warnings.append(args))
    invalidate_problematic_albums_payload_cache(st)

    def fake_build_problematic_albums_payload_for_prewarm(**kwargs):
        built_payloads.append(kwargs)
        st[problematic_albums_module._PROBLEMATIC_ALBUMS_CACHE_KEY] = {"items": [], "count": 0}
        st[problematic_albums_module._PROBLEMATIC_ALBUMS_CACHE_SIGNATURE_KEY] = (
            problematic_albums_module._problematic_albums_cache_signature(st)
        )
        return {"items": [], "count": 0}

    monkeypatch.setattr(
        problematic_albums_module,
        "_build_problematic_albums_payload_for_prewarm",
        fake_build_problematic_albums_payload_for_prewarm,
    )

    first_started = queue_problematic_albums_prewarm(
        library_state=st,
        config=config,
        logger=logger,
    )
    second_started = queue_problematic_albums_prewarm(
        library_state=st,
        config=config,
        logger=logger,
    )

    assert first_started is True
    assert second_started is False
    assert len(submitted) == 1
    assert built_payloads == [{"library_state": st, "config": config, "logger": logger}]
    assert warnings == []
    assert has_cached_problematic_albums_payload(st, config=config) is True


def test_problematic_albums_prewarm_rejects_work_queued_before_revision_invalidation(config, monkeypatch):
    submitted = []
    built_payloads = []
    logger = SimpleNamespace(warning=lambda *_args: None)
    st = {
        "albums": [SimpleNamespace(key="album-1", tracks=[])],
        "file_cache": {"track-1": {"path": "track-1"}},
        "relation_views": {},
        "scan_in_progress": False,
        "covers_in_progress": False,
    }
    invalidate_problematic_albums_payload_cache(st)
    monkeypatch.setattr(
        problematic_albums_module._PROBLEMATIC_ALBUMS_PREWARM_EXECUTOR,
        "submit",
        lambda fn, *args, **kwargs: submitted.append((fn, args, kwargs)),
    )
    monkeypatch.setattr(
        problematic_albums_module,
        "_build_problematic_albums_payload_for_prewarm",
        lambda **kwargs: built_payloads.append(kwargs),
    )

    assert queue_problematic_albums_prewarm(library_state=st, config=config, logger=logger) is True
    invalidate_problematic_albums_payload_cache(st)
    fn, args, kwargs = submitted.pop()
    fn(*args, **kwargs)

    assert built_payloads == []
    assert has_cached_problematic_albums_payload(st, config=config) is False


def test_queue_problematic_albums_prewarm_skips_when_library_not_ready(config):
    st = {
        "albums": [],
        "file_cache": {},
        "scan_in_progress": False,
        "covers_in_progress": False,
    }

    assert queue_problematic_albums_prewarm(
        library_state=st,
        config=config,
        logger=SimpleNamespace(warning=lambda *_args: None),
    ) is False


def test_problematic_albums_payload_skips_unreadable_cover_paths_without_crashing(config):
    album = SimpleNamespace(
        key="album-1",
        name="Album",
        album_artist="Artist",
        artists=["Artist"],
        cover_path="locked-cover.jpg",
        year=None,
        edition="",
        album_rating=0,
        total_duration_seconds=0,
        tracks=[],
        is_compilation=False,
        local_cover_width=0,
        local_cover_height=0,
    )

    payload = build_problematic_albums_read_payload(
        **_problematic_read_payload_kwargs(
            config=config,
            state_getter=lambda: {
                "albums": [album],
                "file_cache": {},
                "relation_views": {},
            },
            text_problem_reason=lambda label, value: "Missing year" if label == "Year" and value is None else None,
            year_problem_reason=lambda value: "Missing year" if value is None else None,
            image_dimensions=lambda *_args, **_kwargs: (_ for _ in ()).throw(PermissionError("locked")),
        )
    )

    assert payload["count"] == 1
    assert payload["items"][0]["key"] == "album-1"
    assert payload["items"][0]["problem_reasons"] == ["Missing year"]
    assert payload["items"][0]["cover_width"] == 0
    assert payload["items"][0]["cover_height"] == 0
