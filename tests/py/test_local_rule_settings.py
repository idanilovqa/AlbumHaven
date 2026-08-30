from __future__ import annotations

from music_app.services.exception_overrides import (
    load_exception_overrides,
    save_exception_overrides,
)
from music_app.services.ignored_repairs import (
    load_ignored_repair_keys,
    update_ignored_repair_key,
)
from music_app.services import exception_overrides as exception_overrides_module
from music_app.services import ignored_repairs as ignored_repairs_module
from music_app.services import separate_releases as separate_releases_module
from music_app.services.separate_releases import (
    load_separate_release_keys,
    save_separate_release_keys,
)


def _postgres_selection(seam_id, config):
    return type(
        "Selection",
        (),
        {"seam_id": seam_id, "effective_backend": "postgres"},
    )()


def test_ignored_repairs_missing_malformed_and_update_normalize_to_key_set(tmp_path, monkeypatch):
    from music_app.services import library_browse_postgres as library_browse_postgres_module

    ignored_keys: set[str] = set()
    invalidations: list[dict[str, object]] = []

    class FakeRuleStatePostgresAdapter:
        def __init__(self, config):
            pass

        def load_ignored_repair_keys(self):
            return set(ignored_keys)

        def save_ignored_repair_keys(self, keys):
            ignored_keys.clear()
            ignored_keys.update(str(key or "").strip() for key in keys if str(key or "").strip())

    monkeypatch.setattr(ignored_repairs_module, "select_runtime_persistence_adapter", _postgres_selection)
    monkeypatch.setattr(ignored_repairs_module, "RuleStatePostgresAdapter", FakeRuleStatePostgresAdapter)
    monkeypatch.setattr(
        library_browse_postgres_module,
        "invalidate_postgres_utility_projection_cache",
        lambda **kwargs: invalidations.append(dict(kwargs)),
    )
    database_url = "postgresql://album_haven_app@localhost/ignored-repairs"
    config = {"DATA_DIR": tmp_path, "ALBUM_HAVEN_APP_DATABASE_URL": database_url}

    assert load_ignored_repair_keys(config) == set()

    (tmp_path / "ignored_repairs.json").write_text("{not-json", encoding="utf-8")
    assert load_ignored_repair_keys(config) == set()

    ignored = update_ignored_repair_key(config, " row-1 ", True)
    assert ignored == {"row-1"}
    assert load_ignored_repair_keys(config) == {"row-1"}

    update_ignored_repair_key(config, "row-1", False)
    assert load_ignored_repair_keys(config) == set()
    assert invalidations == [
        {"database_url": database_url, "kinds": ("problematic-files", "rules")},
        {"database_url": database_url, "kinds": ("problematic-files", "rules")},
    ]


def test_separate_releases_missing_malformed_and_save_normalize_to_key_set(tmp_path, monkeypatch):
    from music_app.services import library_browse_postgres as library_browse_postgres_module

    separate_keys: set[str] = set()
    invalidations: list[dict[str, object]] = []

    class FakeRuleStatePostgresAdapter:
        def __init__(self, config):
            pass

        def load_separate_release_keys(self):
            return set(separate_keys)

        def save_separate_release_keys(self, keys):
            separate_keys.clear()
            separate_keys.update(str(key or "").strip() for key in keys if str(key or "").strip())

    monkeypatch.setattr(separate_releases_module, "select_runtime_persistence_adapter", _postgres_selection)
    monkeypatch.setattr(separate_releases_module, "RuleStatePostgresAdapter", FakeRuleStatePostgresAdapter)
    monkeypatch.setattr(
        library_browse_postgres_module,
        "invalidate_postgres_utility_projection_cache",
        lambda **kwargs: invalidations.append(dict(kwargs)),
    )
    database_url = "postgresql://album_haven_app@localhost/separate-releases"
    config = {"DATA_DIR": tmp_path, "ALBUM_HAVEN_APP_DATABASE_URL": database_url}

    assert load_separate_release_keys(config) == set()

    (tmp_path / "separate_releases.json").write_text("{not-json", encoding="utf-8")
    assert load_separate_release_keys(config) == set()

    save_separate_release_keys(config, {" release-b ", "release-a", ""})
    assert load_separate_release_keys(config) == {"release-a", "release-b"}
    assert separate_keys == {"release-a", "release-b"}
    assert invalidations == [
        {"database_url": database_url, "kinds": ("problematic-files",)},
    ]


def test_exception_overrides_malformed_defaults_and_save_trims_path_keys(tmp_path, monkeypatch):
    overrides_store: dict[str, str] = {}

    class FakeRuleStatePostgresAdapter:
        def __init__(self, config):
            pass

        def load_exception_overrides(self):
            return dict(overrides_store)

        def save_exception_overrides(self, overrides):
            overrides_store.clear()
            for key, value in (overrides or {}).items():
                normalized_key = str(key or "").strip()
                if normalized_key:
                    overrides_store[normalized_key] = str(value or "")

    monkeypatch.setattr(exception_overrides_module, "select_runtime_persistence_adapter", _postgres_selection)
    monkeypatch.setattr(exception_overrides_module, "RuleStatePostgresAdapter", FakeRuleStatePostgresAdapter)
    config = {"DATA_DIR": tmp_path}
    path = tmp_path / "exception_overrides.json"
    path.write_text("{not-json", encoding="utf-8")

    assert load_exception_overrides(config) == {}

    save_exception_overrides(
        config,
        {
            " C:/Music/a.mp3 ": "Non-album rarity",
            "": "Interview",
            "C:/Music/b.mp3": "",
        },
    )

    assert load_exception_overrides(config) == {
        "C:/Music/a.mp3": "Non-album rarity",
        "C:/Music/b.mp3": "",
    }
