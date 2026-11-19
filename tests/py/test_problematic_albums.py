from __future__ import annotations

import json
import uuid
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
from tests.py.test_isolated_postgres_live import watcher_repair_inventory  # noqa: F401 (live fixture)


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


def test_problematic_summary_search_text_excludes_problem_reason_labels():
    payload = api_problematic_albums_module._build_problematic_album_summary_payload(
        SimpleNamespace(name="Album", album_artist="Performer", year=2026, tracks=[]),
        problem_reasons=["Album artist mismatch"],
        repair_preview={},
        cover_width=0,
        cover_height=0,
    )

    assert "artist mismatch" not in payload["search_text"].lower()


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


@pytest.mark.parametrize(
    ("actual_dimensions", "expected_poor_quality"),
    [
        ((1200, 1200), False),
        ((1199, 1200), True),
        ((1200, 1199), True),
    ],
)
def test_problematic_albums_payload_uses_current_cover_dimensions_for_quality(
    config,
    actual_dimensions,
    expected_poor_quality,
):
    cover_path = "current-cover.jpg"
    album = SimpleNamespace(
        key="album-1",
        name="Album",
        album_artist="Artist",
        artists=["Artist"],
        cover_path=cover_path,
        year=None,
        edition="",
        album_rating=0,
        total_duration_seconds=0,
        tracks=[],
        is_compilation=False,
        local_cover_width=600,
        local_cover_height=600,
    )

    payload = build_problematic_albums_read_payload(
        **_problematic_read_payload_kwargs(
            config=config,
            state_getter=lambda: {
                "albums": [album],
                "file_cache": {},
                "relation_views": {},
            },
            year_problem_reason=lambda value: "Missing year" if value is None else None,
            image_dimensions=lambda path: actual_dimensions if path == cover_path else (0, 0),
            poor_art_min_edge=1200,
        )
    )

    item = payload["items"][0]
    assert item["cover_width"] == actual_dimensions[0]
    assert item["cover_height"] == actual_dimensions[1]
    assert ("Poor art quality" in item["problem_reasons"]) is expected_poor_quality


def test_problematic_albums_payload_keeps_acceptable_cached_dimensions_on_fast_path(config):
    album = SimpleNamespace(
        key="album-1",
        name="Album",
        album_artist="Artist",
        artists=["Artist"],
        cover_path="current-cover.jpg",
        year=None,
        edition="",
        album_rating=0,
        total_duration_seconds=0,
        tracks=[],
        is_compilation=False,
        local_cover_width=1200,
        local_cover_height=1200,
    )

    payload = build_problematic_albums_read_payload(
        **_problematic_read_payload_kwargs(
            config=config,
            state_getter=lambda: {
                "albums": [album],
                "file_cache": {},
                "relation_views": {},
            },
            year_problem_reason=lambda value: "Missing year" if value is None else None,
            image_dimensions=lambda _path: pytest.fail("acceptable cached artwork must stay on the fast path"),
            poor_art_min_edge=1200,
        )
    )

    item = payload["items"][0]
    assert item["cover_width"] == 1200
    assert item["cover_height"] == 1200
    assert "Poor art quality" not in item["problem_reasons"]


def _complete_problematic_list(config, *, rebuild: bool):
    from music_app.services import library_browse_postgres as browse
    from tests.e2e.support import isolatedPostgres

    if rebuild:
        browse.invalidate_postgres_utility_projection_cache(
            database_url=config["ALBUM_HAVEN_APP_DATABASE_URL"], kinds=("problematic-files",),
        )
    payload = browse.PostgresLibraryBrowseRepository(
        config, connect=isolatedPostgres._connect,
    ).build_problematic_files_payload()
    return payload["projection_cache_status"], sorted(
        payload["items"], key=lambda item: (item["key"], item["track_paths"]),
    )


def test_live_tag_saves_patch_the_cached_problematic_list_to_a_full_rebuild(watcher_repair_inventory):
    """Owner (11-18): each save rebuilt the whole list (94 s on the real library)."""
    from music_app.services.library_browse_postgres import refresh_postgres_utility_projections_after_edit

    fixture = watcher_repair_inventory
    erased = fixture.entry("Drozd/Karusel/01.flac", artist="R.D.", album="Карусель Эпох")
    erased["album_artist"] = "R.D."
    first = fixture.entry("Twin/One/01.flac", artist="Twin", album="Same Release")
    second = fixture.entry("Twin/Two/01.flac", artist="Twin", album="Same Release")
    for entry in (first, second):
        entry["album_artist"] = "Twin"
    untouched = fixture.entry("Other/Album/01.flac", artist="Other", album="Untouched")
    fixture.seed(erased, first, second, untouched)
    status, before = _complete_problematic_list(fixture.config, rebuild=True)
    assert status == "rebuilt"
    untouched_item = next(item for item in before if item["name"] == "Untouched")

    def save(entry, **changes):
        updated = {**entry, **changes}
        fixture.adapter.persist_structural_tag_edit(
            changed_paths={entry["path"]}, previous_file_entries={entry["path"]: entry},
            updated_file_entries={entry["path"]: updated}, changed_field_names=set(changes),
        )
        refresh_postgres_utility_projections_after_edit(fixture.config, track_paths={entry["path"]})
        entry.update(updated)
        status, patched = _complete_problematic_list(fixture.config, rebuild=False)
        assert status == "hit", "A save must patch the cached list, not drop it."
        assert patched == _complete_problematic_list(fixture.config, rebuild=True)[1]
        return patched

    # Erase the year: the album shows Missing year at once, and its tracks carry no year.
    after_erase = save(erased, year=None)
    drozd = next(item for item in after_erase if item["name"] == "Карусель Эпох")
    assert "Missing year" in drozd["problem_reasons"]
    # Renaming one twin changes the other twin's duplicate state as well.
    save(second, album="Renamed Release")
    # Restore the year: the reason leaves without a rebuild.
    after_fix = save(erased, year=2006)
    assert all(
        "Missing year" not in item["problem_reasons"]
        for item in after_fix if item["name"] == "Карусель Эпох"
    )
    assert untouched_item in after_fix


def _first_problematic_page(config, *, rebuild: bool, limit: int):
    from music_app.services import library_browse_postgres as browse
    from tests.e2e.support import isolatedPostgres

    repository = browse.PostgresLibraryBrowseRepository(config, connect=isolatedPostgres._connect)
    repository._browse_connection_context = lambda: isolatedPostgres._connect(config["ALBUM_HAVEN_APP_DATABASE_URL"])
    if rebuild:
        browse.invalidate_postgres_utility_projection_cache(
            database_url=config["ALBUM_HAVEN_APP_DATABASE_URL"], kinds=("problematic-files",),
        )
    # A first page whose duplicate sources are still resolving is served but not
    # cached; the background warm-up (off in tests) builds the duplicate index first.
    with repository._search_connection_context() as connection:
        browse._load_duplicate_candidate_album_ids(connection, [], repository=repository)
    page = repository.build_problematic_files_page(limit=limit)
    cache_key = (config["ALBUM_HAVEN_APP_DATABASE_URL"], "problematic-files-page")
    if str(limit) not in (browse._UTILITY_PROJECTION_CACHE.get(cache_key) or {}):
        page = repository.build_problematic_files_page(limit=limit)
    return page


def test_live_tag_saves_patch_the_cached_first_problematic_page(watcher_repair_inventory):
    """Owner (11-18): with only the first page cached, every album save dropped it and the
    next Problematic Files open rebuilt it (24 s on the real library)."""
    from music_app.services import library_browse_postgres as browse
    from music_app.services.library_browse_postgres import refresh_postgres_utility_projections_after_edit

    fixture = watcher_repair_inventory
    entries = []
    for index, album in enumerate(("Alpha Release", "Beta Release", "Gamma Release", "Delta Release")):
        entry = fixture.entry(f"Page/{album}/01.flac", artist="Page Artist", album=album)
        entry.update(album_artist="Page Artist", year=None if index % 2 else 2001)
        entries.append(entry)
    fixture.seed(*entries)
    first = _first_problematic_page(fixture.config, rebuild=True, limit=2)
    assert first["has_more"] is True
    page_key = (fixture.config["ALBUM_HAVEN_APP_DATABASE_URL"], "problematic-files-page")
    assert "2" in (browse._UTILITY_PROJECTION_CACHE.get(page_key) or {}), "The first page must be cached before the save."

    def save(entry, **changes):
        updated = {**entry, **changes}
        fixture.adapter.persist_structural_tag_edit(
            changed_paths={entry["path"]}, previous_file_entries={entry["path"]: entry},
            updated_file_entries={entry["path"]: updated}, changed_field_names=set(changes),
        )
        refresh_postgres_utility_projections_after_edit(fixture.config, track_paths={entry["path"]})
        entry.update(updated)
        cache_key = (fixture.config["ALBUM_HAVEN_APP_DATABASE_URL"], "problematic-files-page")
        assert cache_key in browse._UTILITY_PROJECTION_CACHE, "A save must patch the cached first page, not drop it."
        patched = _first_problematic_page(fixture.config, rebuild=False, limit=2)
        fresh = _first_problematic_page(fixture.config, rebuild=True, limit=4)
        boundary = max(browse._problematic_summary_sort_key(item) for item in patched["items"])
        assert patched["items"] == [
            item for item in fresh["items"] if browse._problematic_summary_sort_key(item) <= boundary
        ]
        _first_problematic_page(fixture.config, rebuild=True, limit=2)  # cache a fresh first page again

    save(entries[0], album="Zeta Release")   # leaves the first page
    save(entries[3], album="Aardvark Release")  # enters the first page
    save(entries[1], year=1999)  # stays, with one problem fewer


def test_a_restarted_server_answers_the_first_page_from_the_stored_first_page(monkeypatch):
    """sandbox2 (11-18): the complete list is no longer built, so nothing was stored and
    every restart paid the 22-55 s whole-library candidate query for the first page."""
    import psycopg

    from music_app.services import library_browse_postgres as browse
    from tests.py.test_problematic_files_search_postgres import (
        _MOJIBAKE_TITLE,
        _bump_inventory_revision,
        _drain_background_work,
        _seed_problematic_albums,
    )

    database_url = _seed_problematic_albums(8)
    _drain_background_work()
    page_key = (database_url, browse._PROBLEMATIC_FILES_PAGE_KIND)

    def resolve_duplicates():
        # A page whose duplicate sources are still resolving is served but neither cached
        # nor stored; the background warm-up (off in tests) resolves them first.
        repository = browse.PostgresLibraryBrowseRepository({"ALBUM_HAVEN_APP_DATABASE_URL": database_url})
        with repository._search_connection_context() as connection:
            browse._load_duplicate_candidate_album_ids(connection, [], repository=repository)

    def restart_and_open_first_page(*, candidate_query_allowed):
        for registry in (browse._UTILITY_PROJECTION_CACHE, browse._UTILITY_PROJECTION_STALE):
            registry.pop(page_key, None)
            registry.pop((database_url, "problematic-files"), None)
        browse._PROBLEMATIC_SNAPSHOT_CHECKED.discard((database_url, "problematic-files"))
        repository = browse.PostgresLibraryBrowseRepository({"ALBUM_HAVEN_APP_DATABASE_URL": database_url})
        if not candidate_query_allowed:
            monkeypatch.setattr(repository, "_load_problematic_candidate_ids",
                                lambda **_options: pytest.fail("the whole-library candidate query must not run"))
        return repository.build_problematic_files_page(limit=5)

    with psycopg.connect(database_url) as connection:
        connection.execute("delete from library.problematic_files_snapshots")
        connection.commit()
    resolve_duplicates()
    fresh = restart_and_open_first_page(candidate_query_allowed=True)
    _drain_background_work()
    reader = browse.PostgresLibraryBrowseRepository({"ALBUM_HAVEN_APP_DATABASE_URL": database_url})
    assert fresh["projection_cache_status"] == "bounded"
    assert reader._load_problematic_files_snapshot(allow_outdated=True, for_first_page=True),         "A freshly built first page is stored for the next restart."
    assert reader._load_problematic_files_snapshot() is None, "A first page is never served as the complete list."
    assert reader._load_problematic_files_snapshot(allow_outdated=True) is None, "Search never reads a first page."

    unchanged = restart_and_open_first_page(candidate_query_allowed=False)
    assert unchanged["projection_cache_status"] == "revalidated"
    assert [item["key"] for item in unchanged["items"]] == [item["key"] for item in fresh["items"]]
    assert unchanged["has_more"]

    # While the server was down, a new album sorting first became problematic.
    with psycopg.connect(database_url) as connection:
        album = connection.execute("""select library_id, artist_id from library.local_albums
            where album_key = %s""", (fresh["items"][0]["key"],)).fetchone()
        root_id = connection.execute("select id from library.library_roots where library_id = %s limit 1",
                                     (album[0],)).fetchone()[0]
        token = uuid.uuid4().hex[:12]
        album_id = connection.execute("""insert into library.local_albums(library_id,artist_id,album_key,title)
            values(%s,%s,%s,%s) returning id""", (*album, f"{token}::new", f"{_MOJIBAKE_TITLE} -01")).fetchone()[0]
        track_id = connection.execute("""insert into library.local_tracks(library_id,album_id,artist_id,track_key,title)
            values(%s,%s,%s,%s,'New') returning id""", (album[0], album_id, album[1], token)).fetchone()[0]
        connection.execute("""insert into library.local_track_files(track_id,library_root_id,private_path,relative_path)
            values(%s,%s,%s,%s)""", (track_id, root_id, f"C:/pf-search/{token}/new/01.flac", "new/01.flac"))
        _bump_inventory_revision(connection)
        connection.commit()
    resolve_duplicates()

    outdated = restart_and_open_first_page(candidate_query_allowed=True)
    assert outdated["projection_cache_status"] == "revalidated"
    assert f"{token}::new" not in [item["key"] for item in outdated["items"]]
    _drain_background_work()
    refreshed = browse.PostgresLibraryBrowseRepository({"ALBUM_HAVEN_APP_DATABASE_URL": database_url}) \
        .build_problematic_files_page(limit=5)
    assert refreshed["items"][0]["key"] == f"{token}::new", "The background refresh adds what the snapshot missed."
    assert restart_and_open_first_page(candidate_query_allowed=False)["items"][0]["key"] == f"{token}::new"
    _drain_background_work()
