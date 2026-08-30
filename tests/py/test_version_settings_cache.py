from __future__ import annotations

from threading import Event, Thread

from music_app.services import ignored_versions as ignored_versions_module
from music_app.services import manual_versions as manual_versions_module
from music_app.services.ignored_versions import load_ignored_version_keys, save_ignored_version_keys
from music_app.services.manual_versions import load_manual_version_links, save_manual_version_links


def _select_postgres_rule_state(seam_id: str) -> dict[str, object]:
    return {
        "ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app",
        "PERSISTENCE_BACKENDS": {seam_id: "postgres"},
    }


def _enable_fake_rule_state_driver(monkeypatch) -> None:
    class FakePsycopg:
        def connect(self):
            raise AssertionError("service tests should not open a real database connection")

    monkeypatch.setattr("music_app.services.rule_state_postgres.psycopg", FakePsycopg())


def _join_thread(thread: Thread) -> None:
    thread.join(timeout=1)
    assert not thread.is_alive()


def test_manual_version_links_use_selected_postgres_store(monkeypatch):
    selected_config = _select_postgres_rule_state("manual_versions")
    _enable_fake_rule_state_driver(monkeypatch)
    saved_links: list[dict[str, str]] = []
    loaded_links = [{"postgres-child": "postgres-parent"}]

    class FakeManualVersionsAdapter:
        def __init__(self, config):
            assert config is selected_config

        def load_manual_version_links(self):
            return loaded_links.pop(0)

        def save_manual_version_links(self, manual_version_links):
            saved_links.append(dict(manual_version_links))

    monkeypatch.setattr(manual_versions_module, "RuleStatePostgresAdapter", FakeManualVersionsAdapter)

    loaded = load_manual_version_links(selected_config)
    loaded["mutated-child"] = "mutated-parent"

    assert load_manual_version_links(selected_config) == {"postgres-child": "postgres-parent"}
    save_manual_version_links(selected_config, {"saved-child": "saved-parent"})

    assert saved_links == [{"saved-child": "saved-parent"}]
    assert load_manual_version_links(selected_config) == {"saved-child": "saved-parent"}
    assert loaded_links == []


def test_manual_version_links_do_not_publish_stale_slow_load_after_save(monkeypatch):
    selected_config = _select_postgres_rule_state("manual_versions")
    _enable_fake_rule_state_driver(monkeypatch)
    load_started = Event()
    release_load = Event()
    loaded_results: list[dict[str, str]] = []
    saved_links: list[dict[str, str]] = []

    class FakeManualVersionsAdapter:
        def __init__(self, config):
            assert config is selected_config

        def load_manual_version_links(self):
            load_started.set()
            assert release_load.wait(timeout=1)
            return {"old-child": "old-parent"}

        def save_manual_version_links(self, manual_version_links):
            saved_links.append(dict(manual_version_links))

    monkeypatch.setattr(manual_versions_module, "RuleStatePostgresAdapter", FakeManualVersionsAdapter)

    load_thread = Thread(target=lambda: loaded_results.append(load_manual_version_links(selected_config)))
    save_thread = Thread(target=lambda: save_manual_version_links(selected_config, {"saved-child": "saved-parent"}))

    load_thread.start()
    assert load_started.wait(timeout=1)
    save_thread.start()
    release_load.set()

    _join_thread(load_thread)
    _join_thread(save_thread)

    assert loaded_results == [{"old-child": "old-parent"}]
    assert saved_links == [{"saved-child": "saved-parent"}]
    assert load_manual_version_links(selected_config) == {"saved-child": "saved-parent"}


def test_ignored_version_keys_use_selected_postgres_store(monkeypatch):
    selected_config = _select_postgres_rule_state("ignored_versions")
    _enable_fake_rule_state_driver(monkeypatch)
    saved_keys: list[set[str]] = []
    loaded_keys = [{"postgres-version"}]

    class FakeIgnoredVersionsAdapter:
        def __init__(self, config):
            assert config is selected_config

        def load_ignored_version_keys(self):
            return loaded_keys.pop(0)

        def save_ignored_version_keys(self, ignored_version_keys):
            saved_keys.append(set(ignored_version_keys))

    monkeypatch.setattr(ignored_versions_module, "RuleStatePostgresAdapter", FakeIgnoredVersionsAdapter)

    loaded = load_ignored_version_keys(selected_config)
    loaded.add("mutated-version")

    assert load_ignored_version_keys(selected_config) == {"postgres-version"}
    save_ignored_version_keys(selected_config, {"saved-version"})

    assert saved_keys == [{"saved-version"}]
    assert load_ignored_version_keys(selected_config) == {"saved-version"}
    assert loaded_keys == []


def test_ignored_version_keys_do_not_publish_stale_slow_load_after_save(monkeypatch):
    selected_config = _select_postgres_rule_state("ignored_versions")
    _enable_fake_rule_state_driver(monkeypatch)
    load_started = Event()
    release_load = Event()
    loaded_results: list[set[str]] = []
    saved_keys: list[set[str]] = []

    class FakeIgnoredVersionsAdapter:
        def __init__(self, config):
            assert config is selected_config

        def load_ignored_version_keys(self):
            load_started.set()
            assert release_load.wait(timeout=1)
            return {"old-version"}

        def save_ignored_version_keys(self, ignored_version_keys):
            saved_keys.append(set(ignored_version_keys))

    monkeypatch.setattr(ignored_versions_module, "RuleStatePostgresAdapter", FakeIgnoredVersionsAdapter)

    load_thread = Thread(target=lambda: loaded_results.append(load_ignored_version_keys(selected_config)))
    save_thread = Thread(target=lambda: save_ignored_version_keys(selected_config, {"saved-version"}))

    load_thread.start()
    assert load_started.wait(timeout=1)
    save_thread.start()
    release_load.set()

    _join_thread(load_thread)
    _join_thread(save_thread)

    assert loaded_results == [{"old-version"}]
    assert saved_keys == [{"saved-version"}]
    assert load_ignored_version_keys(selected_config) == {"saved-version"}
