from __future__ import annotations

import time
from pathlib import Path
from threading import Barrier, Event, Thread
from types import SimpleNamespace

import pytest

from music_app.services import utility_rules as utility_rules_module
from music_app.services.utility_rules import (
    build_utility_rules_payload,
    has_cached_utility_rules_payload,
    invalidate_utility_rules_payload_cache,
    queue_utility_rules_prewarm,
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


def test_utility_rules_tests_do_not_import_flask_fixtures():
    source = Path(__file__).read_text(encoding="utf-8")

    assert "tests.py." + "flask_fixtures" not in source


def test_utility_rules_cache_revision_invalidation_is_monotonic_under_concurrency():
    class SlowRevisionState(dict):
        def get(self, key, default=None):
            value = super().get(key, default)
            if key == utility_rules_module._UTILITY_RULES_CACHE_REVISION_KEY:
                time.sleep(0.01)
            return value

    worker_count = 8
    start = Barrier(worker_count)
    st = SlowRevisionState()

    def invalidate() -> None:
        start.wait()
        invalidate_utility_rules_payload_cache(st)

    workers = [Thread(target=invalidate) for _ in range(worker_count)]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join(timeout=2)

    assert all(not worker.is_alive() for worker in workers)
    assert st[utility_rules_module._UTILITY_RULES_CACHE_REVISION_KEY] == worker_count


def test_utility_rules_build_does_not_publish_cache_invalidated_during_active_build(
    config,
    monkeypatch,
):
    build_started = Event()
    allow_build_to_finish = Event()
    st = {"albums": [], "file_cache": {}, "relation_views": {}}

    def blocked_build(**_kwargs):
        build_started.set()
        assert allow_build_to_finish.wait(timeout=2)
        return {"rules": [{"rule": "stale"}]}

    monkeypatch.setattr(
        utility_rules_module,
        "build_utility_rules_read_payload",
        blocked_build,
    )
    result: list[dict[str, object]] = []
    worker = Thread(
        target=lambda: result.append(
            build_utility_rules_payload(
                library_state=st,
                config=config,
                load_ignored_version_keys=lambda _config: set(),
                load_ignored_repair_keys=lambda _config: set(),
                album_to_dict=lambda album: album,
            )
        )
    )

    worker.start()
    assert build_started.wait(timeout=2)
    invalidate_utility_rules_payload_cache(st)
    allow_build_to_finish.set()
    worker.join(timeout=2)

    assert not worker.is_alive()
    assert result == [{"rules": [{"rule": "stale"}]}]
    assert has_cached_utility_rules_payload(st, config=config) is False
    assert utility_rules_module._UTILITY_RULES_CACHE_KEY not in st


def test_build_utility_rules_payload_uses_explicit_dependencies_without_flask_context(config, monkeypatch):
    built_kwargs = []
    st = {
        "albums": [SimpleNamespace(key="album-1", name="Album", album_artist="Artist", artists=["Artist"], tracks=[])],
        "file_cache": {"track-1": {"path": "track-1"}},
        "relation_views": {},
    }

    def fake_build_utility_rules_read_payload(**kwargs):
        built_kwargs.append(kwargs)
        return {"ok": True, "rules": [], "ignored_version_keys": []}

    monkeypatch.setattr(
        utility_rules_module,
        "build_utility_rules_read_payload",
        fake_build_utility_rules_read_payload,
    )

    payload = build_utility_rules_payload(
        library_state=st,
        config=config,
        load_ignored_version_keys=lambda _config: set(),
        load_ignored_repair_keys=lambda _config: set(),
        album_to_dict=lambda album: {"key": album.key, "name": album.name},
    )

    assert payload == {"ok": True, "rules": [], "ignored_version_keys": []}
    assert built_kwargs[0]["config"] is config
    assert built_kwargs[0]["albums"] == st["albums"]
    assert has_cached_utility_rules_payload(st, config=config) is True


def test_has_cached_utility_rules_payload_without_config_returns_false_without_flask_context():
    st = {
        utility_rules_module._UTILITY_RULES_CACHE_KEY: {"ok": True, "rules": []},
        utility_rules_module._UTILITY_RULES_CACHE_SIGNATURE_KEY: ("cached",),
    }

    assert has_cached_utility_rules_payload(st) is False
    assert has_cached_utility_rules_payload() is False


def test_build_utility_rules_payload_without_config_raises_before_flask_state_lookup():
    with pytest.raises(ValueError, match="config is required"):
        build_utility_rules_payload(
            load_ignored_version_keys=lambda _config: set(),
            load_ignored_repair_keys=lambda _config: set(),
            album_to_dict=lambda album: {"key": album.key},
        )


def test_utility_rules_helpers_require_explicit_library_state(config):
    with pytest.raises(ValueError, match="library_state is required"):
        invalidate_utility_rules_payload_cache()

    with pytest.raises(ValueError, match="library_state is required"):
        has_cached_utility_rules_payload(config=config)

    with pytest.raises(ValueError, match="library_state is required"):
        build_utility_rules_payload(
            config=config,
            load_ignored_version_keys=lambda _config: set(),
            load_ignored_repair_keys=lambda _config: set(),
            album_to_dict=lambda album: {"key": album.key},
        )


def test_build_utility_rules_payload_reuses_cached_payload_until_invalidated(config, monkeypatch):
    call_count = 0

    def fake_build_utility_rules_read_payload(**_kwargs):
        nonlocal call_count
        call_count += 1
        return {"ok": True, "rules": [{"key": f"rules-{call_count}"}], "ignored_version_keys": []}

    monkeypatch.setattr(
        utility_rules_module,
        "build_utility_rules_read_payload",
        fake_build_utility_rules_read_payload,
    )

    st = {
        "albums": [SimpleNamespace(key="album-1", name="Album", album_artist="Artist", artists=["Artist"], tracks=[])],
        "file_cache": {"track-1": {"path": "track-1"}},
        "relation_views": {},
    }
    invalidate_utility_rules_payload_cache(st)

    payload = build_utility_rules_payload(
        library_state=st,
        config=config,
        load_ignored_version_keys=lambda _config: set(),
        load_ignored_repair_keys=lambda _config: set(),
        album_to_dict=lambda album: {"key": album.key, "name": album.name},
    )
    cached_payload = build_utility_rules_payload(
        library_state=st,
        config=config,
        load_ignored_version_keys=lambda _config: set(),
        load_ignored_repair_keys=lambda _config: set(),
        album_to_dict=lambda album: {"key": album.key, "name": album.name},
    )

    assert payload == {"ok": True, "rules": [{"key": "rules-1"}], "ignored_version_keys": []}
    assert cached_payload is payload
    assert call_count == 1

    invalidate_utility_rules_payload_cache(st)
    refreshed_payload = build_utility_rules_payload(
        library_state=st,
        config=config,
        load_ignored_version_keys=lambda _config: set(),
        load_ignored_repair_keys=lambda _config: set(),
        album_to_dict=lambda album: {"key": album.key, "name": album.name},
    )

    assert refreshed_payload == {"ok": True, "rules": [{"key": "rules-2"}], "ignored_version_keys": []}
    assert call_count == 2


def test_utility_rules_cache_uses_explicit_revision_not_legacy_json_files(config, monkeypatch):
    call_count = 0

    def fake_build_utility_rules_read_payload(**_kwargs):
        nonlocal call_count
        call_count += 1
        return {"ok": True, "rules": [], "ignored_version_keys": []}

    monkeypatch.setattr(
        utility_rules_module,
        "build_utility_rules_read_payload",
        fake_build_utility_rules_read_payload,
    )

    st = {
        "albums": [],
        "file_cache": {},
        "relation_views": {},
    }
    invalidate_utility_rules_payload_cache(st)

    first_payload = build_utility_rules_payload(
        library_state=st,
        config=config,
        load_ignored_version_keys=lambda _config: set(),
        load_ignored_repair_keys=lambda _config: set(),
        album_to_dict=lambda album: {"key": album.key, "name": album.name},
    )

    revision_after_first_invalidation = st[utility_rules_module._UTILITY_RULES_CACHE_REVISION_KEY]
    cached_payload = build_utility_rules_payload(
        library_state=st,
        config=config,
        load_ignored_version_keys=lambda _config: {"album-1"},
        load_ignored_repair_keys=lambda _config: set(),
        album_to_dict=lambda album: {"key": album.key, "name": album.name},
    )

    assert first_payload == {"ok": True, "rules": [], "ignored_version_keys": []}
    assert cached_payload is first_payload
    assert call_count == 1

    invalidate_utility_rules_payload_cache(st)
    assert st[utility_rules_module._UTILITY_RULES_CACHE_REVISION_KEY] == revision_after_first_invalidation + 1
    refreshed_payload = build_utility_rules_payload(
        library_state=st,
        config=config,
        load_ignored_version_keys=lambda _config: {"album-1"},
        load_ignored_repair_keys=lambda _config: set(),
        album_to_dict=lambda album: {"key": album.key, "name": album.name},
    )

    assert refreshed_payload == {"ok": True, "rules": [], "ignored_version_keys": []}
    assert call_count == 2

    source = Path(utility_rules_module.__file__).read_text(encoding="utf-8")
    assert "_data_file_signature" not in source
    assert ".stat(" not in source
    assert "ignored_versions.json" not in source
    assert "ignored_repairs.json" not in source


def test_queue_utility_rules_prewarm_builds_payload_in_background_once_without_app_context(config, monkeypatch):
    submitted = []
    built_payloads = []
    warnings = []

    monkeypatch.setattr(
        utility_rules_module._UTILITY_RULES_PREWARM_EXECUTOR,
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
    load_ignored_version_keys = lambda _config: set()
    load_ignored_repair_keys = lambda _config: set()
    album_to_dict = lambda album: {"key": album.key, "name": album.name}
    invalidate_utility_rules_payload_cache(st)

    def fake_build_utility_rules_payload_for_prewarm(**kwargs):
        built_payloads.append(kwargs)
        st[utility_rules_module._UTILITY_RULES_CACHE_KEY] = {"ok": True, "rules": []}
        st[utility_rules_module._UTILITY_RULES_CACHE_SIGNATURE_KEY] = utility_rules_module._utility_rules_cache_signature(st)
        return {"ok": True, "rules": []}

    monkeypatch.setattr(
        utility_rules_module,
        "_build_utility_rules_payload_for_prewarm",
        fake_build_utility_rules_payload_for_prewarm,
    )

    first_started = queue_utility_rules_prewarm(
        library_state=st,
        config=config,
        logger=logger,
        load_ignored_version_keys=load_ignored_version_keys,
        load_ignored_repair_keys=load_ignored_repair_keys,
        album_to_dict=album_to_dict,
    )
    second_started = queue_utility_rules_prewarm(
        library_state=st,
        config=config,
        logger=logger,
        load_ignored_version_keys=load_ignored_version_keys,
        load_ignored_repair_keys=load_ignored_repair_keys,
        album_to_dict=album_to_dict,
    )

    assert first_started is True
    assert second_started is False
    assert len(submitted) == 1
    assert built_payloads == [
        {
            "library_state": st,
            "config": config,
            "logger": logger,
            "load_ignored_version_keys": load_ignored_version_keys,
            "load_ignored_repair_keys": load_ignored_repair_keys,
            "album_to_dict": album_to_dict,
        }
    ]
    assert warnings == []
    assert has_cached_utility_rules_payload(st, config=config) is True


def test_utility_rules_prewarm_rejects_work_queued_before_revision_invalidation(config, monkeypatch):
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
    load_ignored_version_keys = lambda _config: set()
    load_ignored_repair_keys = lambda _config: set()
    album_to_dict = lambda album: {"key": album.key, "name": album.name}
    invalidate_utility_rules_payload_cache(st)
    monkeypatch.setattr(
        utility_rules_module._UTILITY_RULES_PREWARM_EXECUTOR,
        "submit",
        lambda fn, *args, **kwargs: submitted.append((fn, args, kwargs)),
    )
    monkeypatch.setattr(
        utility_rules_module,
        "_build_utility_rules_payload_for_prewarm",
        lambda **kwargs: built_payloads.append(kwargs),
    )

    assert queue_utility_rules_prewarm(
        library_state=st,
        config=config,
        logger=logger,
        load_ignored_version_keys=load_ignored_version_keys,
        load_ignored_repair_keys=load_ignored_repair_keys,
        album_to_dict=album_to_dict,
    ) is True
    invalidate_utility_rules_payload_cache(st)
    fn, args, kwargs = submitted.pop()
    fn(*args, **kwargs)

    assert built_payloads == []
    assert has_cached_utility_rules_payload(st, config=config) is False
