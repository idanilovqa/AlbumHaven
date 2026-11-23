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


def test_find_problematic_album_by_track_paths_examines_only_the_albums_holding_those_tracks(config, monkeypatch):
    # The rule stores hold no ignored repairs or separate releases.
    monkeypatch.setattr(problematic_albums_module, "load_ignored_repair_keys", lambda _config: set())
    monkeypatch.setattr(problematic_albums_module, "load_separate_release_keys", lambda _config: set())

    def album(key, name, path):
        return SimpleNamespace(
            key=key, name=name, album_artist="Artist", artists=["Artist"], year=None, cover_path=None,
            tracks=[SimpleNamespace(path=path, title=name)],
        )

    examined: list[str] = []
    st = {
        "albums": [album("problem-1", "One", "a.mp3"), album("problem-2", "Two", "b.mp3")],
        "file_cache": {}, "relation_views": {},
    }

    match = find_problematic_album_by_track_paths(
        {"b.mp3"},
        config=config,
        library_state=st,
        **_problematic_payload_kwargs(
            year_problem_reason=lambda year: "Missing year",
            all_track_year_problems_ignored=lambda album, *_args: examined.append(album.key) or False,
        ),
    )

    assert match["key"] == "problem-2"
    assert match["problem_reasons"][0] == "Missing year"
    assert examined == ["problem-2"]


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


def _evaluated_problematic_items(config):
    """The whole library evaluated directly: what the index must equal."""
    from music_app.services import library_browse_postgres as browse
    from tests.e2e.support import isolatedPostgres

    payload = browse.PostgresLibraryBrowseRepository(
        config, connect=isolatedPostgres._connect,
    ).build_problematic_files_payload()
    assert payload["projection_cache_status"] == "evaluated"
    return sorted(payload["items"], key=lambda item: (item["key"], item["track_paths"]))


def _indexed_problematic_items(database_url, *, limit=2, needle=""):
    """Every item the persisted index serves, page by page (keyset cursors)."""
    from music_app.services import library_browse_postgres as browse

    repository = browse.PostgresLibraryBrowseRepository({
        "ALBUM_HAVEN_APP_DATABASE_URL": database_url,
        "ALBUM_HAVEN_PROBLEMATIC_INDEX_ENABLED": "1",
    })
    items, cursor = [], ""
    while True:
        page = (repository.build_problematic_files_search(needle, limit=limit, cursor=cursor) if needle
                else repository.build_problematic_files_page(limit=limit, cursor=cursor))
        assert page["projection_cache_status"] == "indexed"
        assert not page["cursor_restarted"]
        items += page["items"]
        cursor = page["next_cursor"]
        if not page["has_more"]:
            break
    items = sorted(items, key=lambda item: (item["key"], item["track_paths"]))
    if not needle:
        complete = repository.build_problematic_files_payload()
        assert complete["projection_cache_status"] == "indexed" and complete["complete"]
        assert sorted(complete["items"], key=lambda item: (item["key"], item["track_paths"])) == items
        assert complete["problem_reason_types"] == browse._problematic_filter_reason_types(items)
        if items:
            assert complete["initial_detail"]["key"] == complete["items"][0]["key"]
    return items


def _ready_problematic_index(database_url):
    from music_app.services import library_browse_postgres as browse
    from music_app.services import problematic_index

    repository = browse.PostgresLibraryBrowseRepository({
        "ALBUM_HAVEN_APP_DATABASE_URL": database_url,
        "ALBUM_HAVEN_PROBLEMATIC_INDEX_ENABLED": "1",
    })
    # Duplicate sources resolve before the backfill evaluates them (the warm-up is off in tests).
    with repository._search_connection_context() as connection:
        browse._load_duplicate_candidate_album_ids(connection, [], repository=repository)
    if not problematic_index.refresh(repository):
        problematic_index.wait_for_background_work()
    assert problematic_index.refresh(repository), "The backfill makes the index readable."


def _as_served(items):
    return json.loads(json.dumps(items, default=str))


def test_live_problematic_index_equals_a_full_rebuild_through_tag_saves(watcher_repair_inventory):
    """Owner (11-19): the first Problematic Files page took 22-55 s because every restart,
    deploy and first open ran the whole-library candidate pass. The persisted index must
    serve exactly what a full rebuild lists, before and after each kind of save."""
    from music_app.services import problematic_index
    from music_app.services.library_browse_postgres import refresh_postgres_utility_projections_after_edit

    fixture = watcher_repair_inventory
    database_url = fixture.config["ALBUM_HAVEN_APP_DATABASE_URL"]
    erased = fixture.entry("Drozd/Karusel/01.flac", artist="R.D.", album="Карусель Эпох")
    erased["album_artist"] = "R.D."
    first = fixture.entry("Twin/One/01.flac", artist="Twin", album="Same Release")
    second = fixture.entry("Twin/Two/01.flac", artist="Twin", album="Same Release")
    for entry in (first, second):
        entry["album_artist"] = "Twin"
    untouched = fixture.entry("Other/Album/01.flac", artist="Other", album="Untouched")
    fixture.seed(erased, first, second, untouched)
    _ready_problematic_index(database_url)
    assert _indexed_problematic_items(database_url) == _as_served(
        _evaluated_problematic_items(fixture.config))

    def save(entry, **changes):
        updated = {**entry, **changes}
        fixture.adapter.persist_structural_tag_edit(
            changed_paths={entry["path"]}, previous_file_entries={entry["path"]: entry},
            updated_file_entries={entry["path"]: updated}, changed_field_names=set(changes),
        )
        refresh_postgres_utility_projections_after_edit(fixture.config, track_paths={entry["path"]})
        entry.update(updated)
        problematic_index.wait_for_background_work()
        indexed = _indexed_problematic_items(database_url)
        assert indexed == _as_served(_evaluated_problematic_items(fixture.config))
        return indexed

    after_erase = save(erased, year=None)
    assert "Missing year" in next(item for item in after_erase if item["name"] == "Карусель Эпох")["problem_reasons"]
    # Renaming one twin changes the other twin's duplicate state through the index as well.
    save(second, album="Renamed Release")
    save(second, album="Same Release")
    after_fix = save(erased, year=2006)
    assert all("Missing year" not in item["problem_reasons"]
               for item in after_fix if item["name"] == "Карусель Эпох")



def test_live_indexed_duplicate_cards_equal_the_live_overlay_and_follow_each_save(watcher_repair_inventory, monkeypatch):
    """FTC-TAGS-015: gallery and search cards read each album's stored duplicate result. It
    equals the overlay computed live, key for key: main and hoard copies, an exception track,
    an album spanning two years, a pair whose duplicate problem is excluded from Problematic
    Files and one folder holding the same song twice. A save that forms or breaks a pair, or changes a
    twin's track, shows on the other card in the very next read."""
    import psycopg

    from music_app.services import library_browse_postgres as browse
    from music_app.services import problematic_index
    from music_app.services.library_browse_postgres import refresh_postgres_utility_projections_after_edit
    from music_app.services.rule_state_postgres import RuleStatePostgresAdapter
    from tests.e2e.support import isolatedPostgres

    from tests.py.runtime_testing import publish_relations_with_each_save

    publish_relations_with_each_save(monkeypatch)
    fixture = watcher_repair_inventory
    database_url = fixture.config["ALBUM_HAVEN_APP_DATABASE_URL"]

    def tagged(relative, album, *, root=0, artist="Twin", year=2001, exception=None, title=None):
        entry = fixture.entry(relative, root=root, artist=artist, album=album, exception=exception)
        entry.update(album_artist=artist, year=year, title=title or entry["title"])
        return entry

    # Album keys keep accents and duplicate identities fold them: these are two cards.
    main_copy = tagged("Twin/Main Copy/01.flac", "Same Release")
    hoard_copy = tagged("Twin/Hoard Copy/01.flac", "Same Réléase", root=1)
    other = tagged("Twin/Other/01.flac", "Other Release")
    interview = tagged("Twin/Interview/01.flac", "Interview Copy", exception="Interview")
    interview_twin = tagged("Twin/Interview Twin/01.flac", "Interview Cópy")
    early = tagged("Split/Two Years/01.flac", "Two Years", artist="Split", year=2001)
    late = tagged("Split/Two Years/02.flac", "Two Years", artist="Split", year=2002)
    excluded = tagged("Quiet/Excluded/01.flac", "Quiet Release", artist="Quiet")
    excluded_twin = tagged("Quiet/Excluded Twin/01.flac", "Quiet Réléase", artist="Quiet")
    repeated = tagged("Repeat/Album/01.flac", "Repeat Release", artist="Repeat", title="Same Song")
    repeated_copy = tagged("Repeat/Album/01 copy.flac", "Repeat Release", artist="Repeat", title="Same Song")
    fixture.seed(main_copy, hoard_copy, other, interview, interview_twin, early, late, excluded, excluded_twin,
                 repeated, repeated_copy)

    def album_key(entry):
        with psycopg.connect(fixture.runtime_url) as connection:
            return connection.execute(
                """select albums.album_key from library.local_track_files files
                   join library.local_tracks tracks on tracks.id = files.track_id
                   join library.local_albums albums on albums.id = tracks.album_id
                   where files.private_path = %s and files.scan_cache_stale is false""",
                (entry["path"],),
            ).fetchone()[0]

    excluded_key = album_key(excluded)
    RuleStatePostgresAdapter(fixture.config, connect=isolatedPostgres._connect).upsert_ignored_repair_keys(
        [f"{excluded_key}::problem-album::duplicate-files"],
        album_keys_by_repair_key={f"{excluded_key}::problem-album::duplicate-files": excluded_key},
    )
    _ready_problematic_index(database_url)
    indexed = browse.PostgresLibraryBrowseRepository({
        "ALBUM_HAVEN_APP_DATABASE_URL": database_url, "ALBUM_HAVEN_PROBLEMATIC_INDEX_ENABLED": "1",
    })
    # The duplicate results backfill after the items, in the same background pass.
    problematic_index.wait_for_background_work()
    assert problematic_index.duplicate_results_readable(indexed), "The backfill stores every duplicate result."
    live = browse.PostgresLibraryBrowseRepository(fixture.config, connect=isolatedPostgres._connect)

    def cards():
        with psycopg.connect(fixture.runtime_url) as connection:
            album_ids = [row[0] for row in connection.execute("select id from library.local_albums").fetchall()]
        with isolatedPostgres._connect(fixture.runtime_url) as connection:
            rows = live._load_problematic_file_rows(connection=connection, album_ids=album_ids)
        albums = browse._problematic_album_projection_payloads(rows)
        for album in albums:
            # The Problematic Files row builder's lazy source loader; gallery cards never carry it.
            album.pop("_duplicate_source_materializer", None)
        return sorted(albums, key=lambda album: str(album["key"]))

    def overlays():
        live_cards, indexed_cards = cards(), cards()
        browse.invalidate_postgres_utility_projection_cache()
        live._attach_duplicate_sources(live_cards)
        indexed._attach_duplicate_sources(indexed_cards, indexed=True)
        live_served, indexed_served = _as_served(live_cards), _as_served(indexed_cards)
        differences = {
            live_card["key"]: {
                field: (live_card.get(field), indexed_card.get(field))
                for field in {*live_card, *indexed_card} if live_card.get(field) != indexed_card.get(field)
            }
            for live_card, indexed_card in zip(live_served, indexed_served) if live_card != indexed_card
        }
        assert len(indexed_served) == len(live_served) and not differences, differences
        return {str(card["key"]): card for card in indexed_served}

    def marked(cards_by_key, *entries):
        return [bool(cards_by_key[album_key(entry)].get("has_duplicate_files")) for entry in entries]

    def save(entry, **changes):
        updated = {**entry, **changes}
        fixture.adapter.persist_structural_tag_edit(
            changed_paths={entry["path"]}, previous_file_entries={entry["path"]: entry},
            updated_file_entries={entry["path"]: updated}, changed_field_names=set(changes),
        )
        refresh_postgres_utility_projections_after_edit(
            fixture.config, track_paths={entry["path"]}, previous_entries=[dict(entry)],
        )
        entry.update(updated)

    first = overlays()
    assert marked(first, main_copy, hoard_copy, excluded, excluded_twin) == [True] * 4
    # An exception track belongs to no album, so it never makes its namesake a duplicate.
    assert marked(first, other, interview_twin, repeated) == [False] * 3
    assert not any(card.get("has_duplicate_files") for key, card in first.items() if key.startswith("split::"))
    listed = {item["key"]: item["problem_reasons"] for item in _indexed_problematic_items(database_url)}
    assert "Duplicate files" not in listed.get(excluded_key, []), "The exclusion hides it from Problematic Files only."

    sources_before = first[album_key(main_copy)]["duplicate_sources"]
    save(hoard_copy, title="Renamed Hoard Song")
    # Renaming the twin's only track also ends the pair (duplicates share track titles); either
    # way the other card's stored result changed with this save, equal to the live overlay.
    assert overlays()[album_key(main_copy)]["duplicate_sources"] != sources_before, (
        "A twin's track change reaches the other card at once."
    )
    save(hoard_copy, title=main_copy["title"])

    save(other, album="Sámé Release")
    assert marked(overlays(), other, main_copy, hoard_copy) == [True] * 3, (
        "Forming a pair badges the edited album at once."
    )

    save(main_copy, album="Renamed Release")
    save(other, album="Other Release")
    assert marked(overlays(), main_copy, hoard_copy, other) == [False] * 3, (
        "Breaking the pair clears the badge on the twin left behind at once."
    )

def test_live_stored_duplicate_result_follows_a_stray_link_only_the_stray_album_changed(watcher_repair_inventory):
    """FTC-TAGS-033 (renaming a pair apart left the marker): while an album is another's stray
    copy its tracks carry the owner's identity. Setting or clearing that link changes only the
    stray album's row, so only it is marked; the owner's stored result must follow both times."""
    import psycopg
    from psycopg.types.json import Jsonb

    from music_app.services import library_browse_postgres as browse
    from music_app.services import problematic_index

    fixture = watcher_repair_inventory
    owner = fixture.entry("Apart/Owner/01.flac", artist="Apart", album="Own Release")
    stray = fixture.entry("Apart/Stray/01.flac", artist="Apart", album="Stray Release")
    for entry in (owner, stray):
        entry.update(album_artist="Apart", year=2001)
    fixture.seed(owner, stray)
    database_url = fixture.config["ALBUM_HAVEN_APP_DATABASE_URL"]
    _ready_problematic_index(database_url)
    problematic_index.wait_for_background_work()
    indexed = browse.PostgresLibraryBrowseRepository({
        "ALBUM_HAVEN_APP_DATABASE_URL": database_url, "ALBUM_HAVEN_PROBLEMATIC_INDEX_ENABLED": "1",
    })
    with psycopg.connect(fixture.runtime_url) as connection:
        albums = {
            title: (album_id, key)
            for album_id, key, title in connection.execute(
                "select id, album_key, title from library.local_albums",
            ).fetchall()
        }
    owner_id, owner_key = albums["Own Release"]
    stray_id, _stray_key = albums["Stray Release"]

    def owner_marked():
        card = {"key": owner_key, "year": 2001, "tracks": []}
        indexed._attach_duplicate_sources([card], indexed=True)
        return bool(card.get("has_duplicate_files"))

    def set_stray_link(link):
        with psycopg.connect(fixture.runtime_url) as connection:
            connection.execute(
                """update library.local_albums
                   set metadata = case when %(link)s::jsonb is null then metadata - 'stray_duplicate_of'
                     else metadata || jsonb_build_object('stray_duplicate_of', %(link)s::jsonb) end
                   where id = %(album_id)s""",
                {"link": Jsonb(link) if link else None, "album_id": stray_id},
            )

    assert owner_marked() is False
    set_stray_link({"album_id": owner_id, "album_key": owner_key})
    assert owner_marked() is True, "Linking a stray copy marks its owner in the very next read."
    set_stray_link(None)
    assert owner_marked() is False, "Clearing the stray link clears its owner's marker in the very next read."


def test_live_duplicate_results_backfill_runs_once_across_restarts(watcher_repair_inventory, monkeypatch):
    """The backfill is one-time: a restart on a ready database never runs it again."""
    from music_app.services import library_browse_postgres as browse
    from music_app.services import problematic_index

    fixture = watcher_repair_inventory
    fixture.seed(fixture.entry("Restart/Album/01.flac", artist="Restart", album="Restart Album"))
    database_url = fixture.config["ALBUM_HAVEN_APP_DATABASE_URL"]
    _ready_problematic_index(database_url)
    problematic_index.wait_for_background_work()
    repository = browse.PostgresLibraryBrowseRepository({
        "ALBUM_HAVEN_APP_DATABASE_URL": database_url, "ALBUM_HAVEN_PROBLEMATIC_INDEX_ENABLED": "1",
    })
    assert problematic_index.duplicate_results_readable(repository)

    reruns = []
    for backfill in ("_backfill", "_backfill_duplicate_results"):
        monkeypatch.setattr(problematic_index, backfill, lambda *_args, name=backfill: reruns.append(name))
    # A restarted process has seen nothing.
    for seen in ("_READY", "_DUPLICATES_READY", "_WARMED"):
        monkeypatch.setattr(problematic_index, seen, set())
    problematic_index._maintain(repository)
    assert problematic_index.duplicate_results_readable(repository)
    assert reruns == []


def test_live_index_evaluators_leave_the_real_pool_transactional_and_unlocked(watcher_repair_inventory):
    """After a request's evaluation and after a maintenance pass the next pool lease is
    transactional and no advisory lock of the index is left on any backend."""
    from psycopg.pq import TransactionStatus

    from music_app.services import library_browse_postgres as browse
    from music_app.services import problematic_index
    from music_app.services.postgres_connections import leased_connection

    fixture = watcher_repair_inventory
    fixture.seed(fixture.entry("Pool/Album/01.flac", artist="Pool", album="Pool Album"))
    database_url = fixture.config["ALBUM_HAVEN_APP_DATABASE_URL"]
    _ready_problematic_index(database_url)
    problematic_index.wait_for_background_work()
    repository = browse.PostgresLibraryBrowseRepository({
        "ALBUM_HAVEN_APP_DATABASE_URL": database_url, "ALBUM_HAVEN_PROBLEMATIC_INDEX_ENABLED": "1",
    })
    for evaluate in (problematic_index.refresh, problematic_index._maintain):
        with leased_connection(database_url) as connection:
            connection.execute(
                "select library.mark_problematic_album_dirty(library_id, id) from library.local_albums",
            ).fetchall()
        evaluate(repository)
        with leased_connection(database_url) as connection:
            assert connection.autocommit is False
            left = connection.execute(
                """select (select count(*) from library.problematic_index_dirty_albums) as marks,
                          (select count(*) from pg_locks
                           where locktype = 'advisory' and classid::bigint = %s
                             and database = (select oid from pg_database where datname = current_database())) as locks""",
                (problematic_index._LOCK_NAMESPACE,),
            ).fetchone()
            assert connection.info.transaction_status == TransactionStatus.INTRANS
            assert dict(left) == {"marks": 0, "locks": 0}


def test_live_deploy_step_fills_before_serving_and_reruns_without_redoing_it(watcher_repair_inventory, monkeypatch):
    """Owner (11-21): "Fill it first". On a database nothing has prepared, the step leaves
    both states ready with no album waiting; a rerun backfills nothing unless told to."""
    from music_app.services import library_browse_postgres as browse
    from music_app.services import problematic_index

    fixture = watcher_repair_inventory
    fixture.seed(fixture.entry("Deploy/Album/01.flac", artist="Deploy", album="Deploy Album"))
    repository = browse.PostgresLibraryBrowseRepository({
        "ALBUM_HAVEN_APP_DATABASE_URL": fixture.config["ALBUM_HAVEN_APP_DATABASE_URL"],
    })
    assert problematic_index.serving_readiness(repository)["duplicate_results"] != "ready"

    progress = []
    problematic_index.prepare_for_serving(repository, report=lambda *step: progress.append(step))
    assert ("Duplicate results", 1, 1) in progress
    assert problematic_index.serving_readiness(repository) == {
        "problematic_index": "ready", "duplicate_results": "ready", "changed_albums_waiting": 0,
    }

    backfilled = []
    real = problematic_index._backfill_duplicate_results
    monkeypatch.setattr(problematic_index, "_backfill_duplicate_results",
                        lambda *args: backfilled.append(1) or real(*args))
    problematic_index.prepare_for_serving(repository)
    assert backfilled == []
    problematic_index.prepare_for_serving(repository, rebuild_duplicates=True)
    assert backfilled == [1]


@pytest.mark.parametrize("change", ["former stray copy", "former identity twin"])
def test_live_builder_bump_keeps_duplicate_results_readable_and_evaluates_their_marks(
    watcher_repair_inventory, monkeypatch, change,
):
    """The results have their own version: a Problematic Files builder bump never makes them
    unreadable or rebuilds them. An album changed before it still gets evaluated, and so does
    its former twin, which the changed album's identities no longer reach: only the stored
    linked_album_ids do."""
    import psycopg
    from psycopg.types.json import Jsonb

    from music_app.services import library_browse_postgres as browse
    from music_app.services import problematic_index

    fixture = watcher_repair_inventory
    identity_twin = change == "former identity twin"
    owner = fixture.entry("Bump/Owner/01.flac", artist="Bump", album="Same Release" if identity_twin else "Own Release")
    other = fixture.entry("Bump/Other/01.flac", artist="Bump", album="Same Réléase" if identity_twin else "Stray Release")
    for entry in (owner, other):
        entry.update(album_artist="Bump", year=2001)
    fixture.seed(owner, other)

    def sql(statement, params=None):
        with psycopg.connect(fixture.runtime_url) as connection:
            cursor = connection.execute(statement, params)
            return cursor.fetchall() if cursor.description else []

    album_of = {
        path: (album_id, key)
        for path, album_id, key in sql(
            """select files.private_path, albums.id, albums.album_key
               from library.local_track_files files
               join library.local_tracks tracks on tracks.id = files.track_id
               join library.local_albums albums on albums.id = tracks.album_id""",
        )
    }
    (owner_id, owner_key), (other_id, _other_key) = album_of[owner["path"]], album_of[other["path"]]

    def set_stray_link(link):
        sql(
            """update library.local_albums
               set metadata = case when %(link)s::jsonb is null then metadata - 'stray_duplicate_of'
                 else metadata || jsonb_build_object('stray_duplicate_of', %(link)s::jsonb) end
               where id = %(album_id)s""",
            {"link": Jsonb(link) if link else None, "album_id": other_id},
        )

    if identity_twin:
        sql("update library.local_albums set metadata = metadata - 'stray_duplicate_of'")
    database_url = fixture.config["ALBUM_HAVEN_APP_DATABASE_URL"]
    _ready_problematic_index(database_url)
    problematic_index.wait_for_background_work()
    repository = browse.PostgresLibraryBrowseRepository({
        "ALBUM_HAVEN_APP_DATABASE_URL": database_url, "ALBUM_HAVEN_PROBLEMATIC_INDEX_ENABLED": "1",
    })

    def owner_marked():
        card = {"key": owner_key, "year": 2001, "tracks": []}
        repository._attach_duplicate_sources([card], indexed=True)
        return bool(card.get("has_duplicate_files"))

    if not identity_twin:
        set_stray_link({"album_id": owner_id, "album_key": owner_key})
    assert owner_marked() is True
    assert sql("select linked_album_ids from library.album_duplicate_results where album_id = %s", (owner_id,)) == [
        ([other_id],),
    ]

    # A change nobody has evaluated yet, then the builder bump.
    if identity_twin:
        sql(
            """update library.local_track_files
               set metadata = jsonb_set(metadata, '{scan_cache,file_entry,album}', %s)
               where private_path = %s""",
            (Jsonb("Other Release"), other["path"]),
        )
    else:
        set_stray_link(None)
    assert sql("select album_id from library.problematic_index_dirty_albums where album_id <> 0") == [(other_id,)]
    library_id = sql("select library_id from library.local_albums where id = %s", (owner_id,))[0][0]
    assert owner_id not in {
        row[0] for row in sql(problematic_index._SCOPE_SQL, {
            "library_id": library_id, "album_ids": [other_id], "old_identities": [],
        })
    }, "Only linked_album_ids can reach the former twin."
    monkeypatch.setattr(problematic_index, "BUILDER_VERSION", "next")
    monkeypatch.setattr(problematic_index, "queue_maintenance", lambda _repository: None)
    monkeypatch.setattr(problematic_index, "_backfill_duplicate_results",
                        lambda *_args: pytest.fail("a builder bump must not rebuild the results"))
    assert problematic_index.duplicate_results_readable(repository), "A builder bump hid the stored results."
    assert owner_marked() is True, "The last complete rows serve until the pass evaluates the change."

    problematic_index._maintain(repository)

    assert sql("select builder_version, status from library.problematic_index_state") == [("next", "ready")]
    assert sql("select status from library.album_duplicate_results_state") == [("ready",)]
    assert sql("select album_id from library.problematic_index_dirty_albums where album_id <> 0") == []
    assert owner_marked() is False, "The former twin was evaluated."


def test_live_problematic_index_reads_pages_and_search_without_the_whole_library_pass(monkeypatch):
    """An album that becomes problematic, one that is fixed and one that is removed reach the
    first page and search through the marked albums alone."""
    import psycopg

    from music_app.services import library_browse_postgres as browse
    from tests.py.test_problematic_files_search_postgres import _MOJIBAKE_TITLE, _seed_problematic_albums

    database_url = _seed_problematic_albums(8)
    _ready_problematic_index(database_url)
    before = _indexed_problematic_items(database_url, limit=3)
    assert len(before) == 8
    monkeypatch.setattr(browse.PostgresLibraryBrowseRepository, "_problematic_candidate_album_ids",
                        lambda *_args, **_kwargs: pytest.fail("the whole-library candidate pass must not run"))

    with psycopg.connect(database_url) as connection:
        first_key, second_key = (item["key"] for item in sorted(before, key=browse._problematic_summary_sort_key)[:2])
        album = connection.execute("select library_id, artist_id from library.local_albums where album_key = %s",
                                   (first_key,)).fetchone()
        root_id = connection.execute("select id from library.library_roots where library_id = %s limit 1",
                                     (album[0],)).fetchone()[0]
        new_id = connection.execute("""insert into library.local_albums(library_id,artist_id,album_key,title)
            values(%s,%s,'index-new::album',%s) returning id""", (*album, f"{_MOJIBAKE_TITLE} -01")).fetchone()[0]
        track_id = connection.execute("""insert into library.local_tracks(library_id,album_id,artist_id,track_key,title)
            values(%s,%s,%s,'index-new-track','Fresh Needle') returning id""", (album[0], new_id, album[1])).fetchone()[0]
        connection.execute("""insert into library.local_track_files(track_id,library_root_id,private_path,relative_path)
            values(%s,%s,'C:/pf-search/index-new/01.flac','index-new/01.flac')""", (track_id, root_id))
        connection.execute("update library.local_albums set title = 'Plain Title' where album_key = %s", (first_key,))
        connection.execute("delete from library.local_albums where album_key = %s", (second_key,))
        connection.commit()

    page = browse.PostgresLibraryBrowseRepository({
        "ALBUM_HAVEN_APP_DATABASE_URL": database_url, "ALBUM_HAVEN_PROBLEMATIC_INDEX_ENABLED": "1",
    }).build_problematic_files_page(limit=3)
    assert page["projection_cache_status"] == "indexed"
    with psycopg.connect(database_url) as connection:
        assert not connection.execute("select 1 from library.problematic_index_dirty_albums").fetchall(), \
            "The read evaluated every marked album inline."
    # "Plain Title" (Latin) sorts before the Cyrillic mojibake titles, then the new album.
    assert [item["key"] for item in page["items"][:2]] == [first_key, "index-new::album"]
    assert page["items"][0]["name"] == "Plain Title"
    after = {item["key"]: item for item in _indexed_problematic_items(database_url, limit=3)}
    assert "index-new::album" in after and second_key not in after
    # The renamed album was evaluated again: gone, or listed under its new title.
    assert first_key not in after or after[first_key]["name"] == "Plain Title"
    assert [item["key"] for item in _indexed_problematic_items(
        database_url, needle=f"{_MOJIBAKE_TITLE} -01".lower())] == ["index-new::album"]


def _indexed_by_name(database_url):
    return {item["name"]: item for item in _indexed_problematic_items(database_url, limit=50)}


def _watcher_pass(fixture, *, active=(), deleted=()):
    """What a watcher pass writes and runs after its commit."""
    from music_app.services.state import invalidate_targeted_library_projections

    fixture.adapter.persist_targeted_inventory_mutation(
        root_id="repair-main",
        active_file_entries={entry["path"]: entry for entry in active},
        deleted_paths=tuple(deleted),
    )
    invalidate_targeted_library_projections(
        {}, fixture.config, revision=0, affected_album_keys=(),
        track_paths=tuple(entry["path"] for entry in active) + tuple(deleted))


def _no_whole_library_pass(monkeypatch):
    from music_app.services import library_browse_postgres as browse

    monkeypatch.setattr(browse.PostgresLibraryBrowseRepository, "_problematic_candidate_album_ids",
                        lambda *_args, **_kwargs: pytest.fail("the whole-library candidate pass must not run"))


def test_live_problematic_index_follows_watcher_additions_removals_and_fixes(watcher_repair_inventory, monkeypatch):
    """Owner (11-19): files added to or removed from the library, and problems fixed on disk,
    reach Problematic Files on the fly through the watcher, never through a full build."""
    fixture = watcher_repair_inventory
    database_url = fixture.config["ALBUM_HAVEN_APP_DATABASE_URL"]
    clean = fixture.entry("Owner/Clean/01.flac", album="Clean Album")
    fixture.seed(clean)
    _ready_problematic_index(database_url)
    # Fixture albums have no cover art, so every album is listed; the year is what changes.
    assert "Missing year" not in _indexed_by_name(database_url)["Clean Album"]["problem_reasons"]
    _no_whole_library_pass(monkeypatch)

    # 1. The watcher finds a new album with a problem (no year).
    added = {**fixture.entry("Owner/Added/01.flac", album="Added Album"), "year": None}
    _watcher_pass(fixture, active=[added])
    listed = _indexed_by_name(database_url)
    assert "Missing year" in listed["Added Album"]["problem_reasons"]

    # 3. The problem is fixed on disk (the year is written) and the watcher sees the file again.
    _watcher_pass(fixture, active=[{**added, "year": 2026}])
    assert "Missing year" not in _indexed_by_name(database_url)["Added Album"]["problem_reasons"]

    # 2. A problematic album's files are removed: it leaves the list or is listed as not found.
    removed = {**fixture.entry("Owner/Removed/01.flac", album="Removed Album"), "year": None}
    _watcher_pass(fixture, active=[removed])
    assert "Removed Album" in _indexed_by_name(database_url)
    _watcher_pass(fixture, deleted=[removed["path"]])
    after_removal = _indexed_by_name(database_url).get("Removed Album")
    assert after_removal is None or after_removal["problem_reasons"] == ["Album not found"]
    assert _as_served(_indexed_problematic_items(database_url)) == _as_served(
        _evaluated_problematic_items(fixture.config))


def test_live_problematic_index_takes_a_large_watcher_batch_in_the_background(watcher_repair_inventory, monkeypatch):
    """A folder of many albums is evaluated in the background: neither the watcher pass,
    a save nor a Problematic Files read waits for it."""
    from music_app.services import problematic_index
    from tests.e2e.support import isolatedPostgres

    fixture = watcher_repair_inventory
    database_url = fixture.config["ALBUM_HAVEN_APP_DATABASE_URL"]
    fixture.seed(fixture.entry("Owner/Clean/01.flac", album="Clean Album"))
    _ready_problematic_index(database_url)
    _no_whole_library_pass(monkeypatch)
    batch = [{**fixture.entry(f"Owner/Batch {index:03d}/01.flac", album=f"Batch {index:03d}"), "year": None}
             for index in range(problematic_index.INLINE_ALBUM_LIMIT + 10)]

    # The maintainer is busy (its lock is held): writers never wait for it.
    with isolatedPostgres._connect(database_url) as holder:
        holder.autocommit = True
        library_id = holder.execute("select id from library.libraries where library_kind = 'local' limit 1").fetchone()["id"]
        holder.execute("select pg_advisory_lock(%s, %s::integer)", (problematic_index._LOCK_NAMESPACE, library_id))
        started = time.perf_counter()
        _watcher_pass(fixture, active=batch)
        saved = {**batch[0], "album": "Batch Renamed"}
        fixture.adapter.persist_structural_tag_edit(
            changed_paths={saved["path"]}, previous_file_entries={saved["path"]: batch[0]},
            updated_file_entries={saved["path"]: saved}, changed_field_names={"album"},
        )
        _indexed_problematic_items(database_url, limit=50)
        elapsed = time.perf_counter() - started
        holder.execute("select pg_advisory_unlock(%s, %s::integer)", (problematic_index._LOCK_NAMESPACE, library_id))
    assert elapsed < 30, f"The watcher pass, a save and a read waited for the index ({elapsed:.1f} s)."

    problematic_index.queue_maintenance(problematic_index._browse().PostgresLibraryBrowseRepository({
        "ALBUM_HAVEN_APP_DATABASE_URL": database_url, "ALBUM_HAVEN_PROBLEMATIC_INDEX_ENABLED": "1"}))
    problematic_index.wait_for_background_work()
    listed = _indexed_by_name(database_url)
    assert {f"Batch {index:03d}" for index in range(1, len(batch))} <= set(listed)
    assert "Batch Renamed" in listed and "Batch 000" not in listed
    assert _as_served(_indexed_problematic_items(database_url)) == _as_served(
        _evaluated_problematic_items(fixture.config))


def test_live_problematic_index_follows_a_legacy_album_rule_revert(watcher_repair_inventory):
    """Gate run 44590187281 (FTC-UTIL-PROBLEMS-001): reverting a legacy album-level Rules
    exclusion (`<album key>::problem-album::<reason>`, no album_key metadata) left the album
    hidden, because the journal marked albums only through that metadata (fixed by 0266)."""
    from music_app.services import library_browse_postgres as browse
    from tests.e2e.support import isolatedPostgres

    fixture = watcher_repair_inventory
    database_url = fixture.config["ALBUM_HAVEN_APP_DATABASE_URL"]
    fixture.seed({**fixture.entry("Owner/Legacy/01.flac", album="Legacy Album"), "year": None})
    _ready_problematic_index(database_url)
    listed = _indexed_by_name(database_url)["Legacy Album"]
    assert "Missing year" in listed["problem_reasons"]
    rule_key = browse._problem_identity_row_key(listed["key"], "Missing year", scope="album")

    def set_rule(present):
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            library_id = connection.execute(
                "select id from library.libraries where library_kind = 'local' limit 1").fetchone()["id"]
            if present:
                connection.execute("insert into library.ignored_repairs (library_id, repair_key) values (%s, %s)",
                                   (library_id, rule_key))
            else:
                connection.execute("delete from library.ignored_repairs where repair_key = %s", (rule_key,))

    set_rule(True)
    hidden = _indexed_by_name(database_url).get("Legacy Album")
    assert hidden is None or "Missing year" not in hidden["problem_reasons"]
    set_rule(False)
    assert "Missing year" in _indexed_by_name(database_url)["Legacy Album"]["problem_reasons"]
    assert _as_served(_indexed_problematic_items(database_url)) == _as_served(_evaluated_problematic_items(fixture.config))


def test_live_problematic_index_follows_a_loose_group_exclusion_and_its_revert(watcher_repair_inventory):
    """An excluded loose group leaves the list and its detail; reverting the exclusion brings both back."""
    from music_app.services import library_browse_postgres as browse, problematic_index
    from tests.e2e.support import isolatedPostgres

    fixture = watcher_repair_inventory
    database_url = fixture.config["ALBUM_HAVEN_APP_DATABASE_URL"]
    # A loose file has no artist tag ("Missing artist"). One in each of two folders makes two groups, so the
    # other group proves the rule is scoped.
    def stray(folder):
        entry = fixture.entry(f"Owner/{folder}/01.flac", artist="")
        entry["album_artist"] = ""
        return entry

    fixture.seed(*(fixture.entry(f"Owner/Album/{track}.flac") for track in ("01", "02", "03")),
                 stray("Strays A"), stray("Strays B"))
    _ready_problematic_index(database_url)
    repository = browse.PostgresLibraryBrowseRepository(
        {**fixture.config, problematic_index.ENABLED_KEY: "1"})

    def loose():
        return {item["key"]: item for item in _indexed_problematic_items(database_url, limit=50)
                if browse._is_problematic_loose_tracks_key(item["key"])}

    before = loose()
    assert len(before) == 2, "The fixture needs two loose groups."
    key, other = sorted(before)
    assert problematic_index.loose_group_detail(repository, key)
    rule_keys = {
        browse._problem_identity_row_key(identity, reason, scope=scope)
        for reason in before[key]["problem_reasons"]
        for scope, identities in (("album", [key]), ("file", before[key]["track_paths"]))
        for identity in identities
    }

    def set_rules(present):
        with isolatedPostgres._connect(fixture.setup_url) as connection:
            library_id = connection.execute(
                "select id from library.libraries where library_kind = 'local' limit 1").fetchone()["id"]
            for rule_key in sorted(rule_keys):
                if present:
                    connection.execute("insert into library.ignored_repairs (library_id, repair_key) values (%s, %s)",
                                       (library_id, rule_key))
                else:
                    connection.execute("delete from library.ignored_repairs where repair_key = %s", (rule_key,))

    set_rules(True)
    assert set(loose()) == {other}, "The excluded loose group is still listed."
    assert problematic_index.loose_group_detail(repository, key) is None, "The excluded group still has a detail."
    set_rules(False)
    assert loose() == before
    assert problematic_index.loose_group_detail(repository, key)
