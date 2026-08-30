from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Lock

from music_app.services.exception_overrides import (
    apply_exception_override,
    load_exception_overrides,
    save_exception_overrides,
    set_track_exception_override,
    set_track_exception_overrides,
)


def _selected_postgres_rule_state_config() -> dict[str, object]:
    return {
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        "PERSISTENCE_BACKENDS": {"exception_overrides": "postgres"},
    }


def _enable_fake_rule_state_driver(monkeypatch) -> None:
    class FakePsycopg:
        def connect(self):
            raise AssertionError("service tests should not open a real database connection")

    monkeypatch.setattr("music_app.services.rule_state_postgres.psycopg", FakePsycopg())


def test_save_and_load_exception_overrides_round_trip(monkeypatch):
    from music_app.services import exception_overrides as exception_overrides_module

    config = _selected_postgres_rule_state_config()
    _enable_fake_rule_state_driver(monkeypatch)
    stored_overrides: dict[str, str] = {}

    class FakeExceptionOverridesAdapter:
        def __init__(self, adapter_config):
            assert adapter_config is config

        def load_exception_overrides(self):
            return dict(stored_overrides)

        def save_exception_overrides(self, overrides):
            stored_overrides.clear()
            stored_overrides.update(dict(overrides))

    monkeypatch.setattr(exception_overrides_module, "RuleStatePostgresAdapter", FakeExceptionOverridesAdapter)

    save_exception_overrides(
        config,
        {
            "C:/Music/a.mp3": "Non-album rarity",
            "C:/Music/b.mp3": "",
        },
    )

    assert load_exception_overrides(config) == {
        "C:/Music/a.mp3": "Non-album rarity",
        "C:/Music/b.mp3": "",
    }


def test_set_track_exception_override_persists_blank_mask(monkeypatch):
    from music_app.services import exception_overrides as exception_overrides_module

    config = _selected_postgres_rule_state_config()
    _enable_fake_rule_state_driver(monkeypatch)
    stored_overrides: dict[str, str] = {}

    class FakeExceptionOverridesAdapter:
        def __init__(self, adapter_config):
            assert adapter_config is config

        def load_exception_overrides(self):
            return dict(stored_overrides)

        def upsert_exception_overrides(self, overrides):
            stored_overrides.update(dict(overrides))

    monkeypatch.setattr(exception_overrides_module, "RuleStatePostgresAdapter", FakeExceptionOverridesAdapter)

    set_track_exception_override(config, "C:/Music/a.mp3", "Non-album rarity")
    cleared = set_track_exception_override(config, "C:/Music/a.mp3", "")

    assert cleared == ""
    assert load_exception_overrides(config) == {"C:/Music/a.mp3": ""}


def test_set_track_exception_overrides_upserts_one_batch(monkeypatch):
    from music_app.services import exception_overrides as exception_overrides_module

    config = _selected_postgres_rule_state_config()
    _enable_fake_rule_state_driver(monkeypatch)
    upsert_calls = []

    class FakeExceptionOverridesAdapter:
        def __init__(self, adapter_config):
            assert adapter_config is config

        def upsert_exception_overrides(self, overrides):
            upsert_calls.append(dict(overrides))

    monkeypatch.setattr(
        exception_overrides_module,
        "RuleStatePostgresAdapter",
        FakeExceptionOverridesAdapter,
    )

    normalized = set_track_exception_overrides(
        config,
        {
            "C:/Music/a.mp3": "non album rarity",
            "C:/Music/b.mp3": "",
        },
    )

    assert normalized == {
        "C:/Music/a.mp3": "Non-album rarity",
        "C:/Music/b.mp3": "",
    }
    assert upsert_calls == [{
        "C:/Music/a.mp3": "Non-album rarity",
        "C:/Music/b.mp3": "",
    }]


def test_concurrent_exception_override_updates_preserve_both_paths(monkeypatch):
    from music_app.services import exception_overrides as exception_overrides_module

    config = _selected_postgres_rule_state_config()
    _enable_fake_rule_state_driver(monkeypatch)
    load_barrier = Barrier(2)
    store_lock = Lock()
    stored_overrides: dict[str, str] = {}

    class ConcurrentExceptionOverridesAdapter:
        def __init__(self, adapter_config):
            assert adapter_config is config

        def load_exception_overrides(self):
            snapshot = dict(stored_overrides)
            load_barrier.wait(timeout=1.0)
            return snapshot

        def save_exception_overrides(self, overrides):
            with store_lock:
                stored_overrides.clear()
                stored_overrides.update(overrides)

        def upsert_exception_overrides(self, overrides):
            with store_lock:
                stored_overrides.update(overrides)

    monkeypatch.setattr(
        exception_overrides_module,
        "RuleStatePostgresAdapter",
        ConcurrentExceptionOverridesAdapter,
    )

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [
            executor.submit(
                set_track_exception_override,
                config,
                path,
                exception_type,
            )
            for path, exception_type in (
                ("C:/Music/a.mp3", "Interview"),
                ("C:/Music/b.mp3", "Non-album rarity"),
            )
        ]
        assert [future.result(timeout=1.0) for future in futures] == [
            "Interview",
            "Non-album rarity",
        ]

    assert stored_overrides == {
        "C:/Music/a.mp3": "Interview",
        "C:/Music/b.mp3": "Non-album rarity",
    }


def test_exception_override_mutation_invalidates_and_refetches_scoped_problematic_projection(monkeypatch):
    from music_app.services import exception_overrides as exception_overrides_module
    from music_app.services import library_browse_postgres as library_browse_postgres_module

    database_url = "postgresql://album_haven_app@localhost/exception-invalidation"
    config = {
        "ALBUM_HAVEN_APP_DATABASE_URL": database_url,
        "PERSISTENCE_BACKENDS": {"exception_overrides": "postgres"},
    }
    cache_key = (database_url, "problematic-files")
    current_projection_key = "before-override"
    build_count = 0

    class FakeExceptionOverridesAdapter:
        def __init__(self, adapter_config):
            assert adapter_config is config

        def save_exception_overrides(self, overrides):
            nonlocal current_projection_key
            assert overrides == {"C:/Music/a.mp3": "Interview"}
            current_projection_key = "after-override"

    monkeypatch.setattr(
        exception_overrides_module,
        "RuleStatePostgresAdapter",
        FakeExceptionOverridesAdapter,
    )
    repository = library_browse_postgres_module.PostgresLibraryBrowseRepository(
        config,
        connect=lambda _database_url: None,
    )

    def build_payload():
        nonlocal build_count
        build_count += 1
        return {
            "items": [{"key": current_projection_key}],
            "count": 1,
        }

    monkeypatch.setattr(
        repository,
        "_build_problematic_files_payload_uncached",
        build_payload,
    )
    with library_browse_postgres_module._UTILITY_PROJECTION_CACHE_LOCK:
        library_browse_postgres_module._UTILITY_PROJECTION_CACHE.pop(cache_key, None)
        library_browse_postgres_module._UTILITY_PROJECTION_GENERATIONS.pop(cache_key, None)

    assert repository.build_problematic_files_payload()["items"][0]["key"] == "before-override"
    assert repository.build_problematic_files_payload()["items"][0]["key"] == "before-override"
    assert build_count == 1

    save_exception_overrides(config, {"C:/Music/a.mp3": "Interview"})

    assert repository.build_problematic_files_payload()["items"][0]["key"] == "after-override"
    assert build_count == 2
    with library_browse_postgres_module._UTILITY_PROJECTION_CACHE_LOCK:
        assert library_browse_postgres_module._UTILITY_PROJECTION_GENERATIONS[cache_key] == 1


def test_apply_exception_override_replaces_entry_value():
    entry = {"path": "C:/Music/a.mp3", "exception_type": None}

    result = apply_exception_override(entry, {"C:/Music/a.mp3": "Interview"})

    assert result["exception_type"] == "Interview"


def test_apply_exception_override_masks_embedded_value_with_blank_override():
    entry = {"path": "C:/Music/a.mp3", "exception_type": "Interview"}

    result = apply_exception_override(entry, {"C:/Music/a.mp3": ""})

    assert result["exception_type"] is None
