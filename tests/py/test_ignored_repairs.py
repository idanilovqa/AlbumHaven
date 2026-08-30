from __future__ import annotations

import pytest

from music_app.services import ignored_repairs


def _patch_dependencies(monkeypatch, *, adapter_type):
    selected: list[tuple[str, dict]] = []
    invalidated: list[dict[str, object]] = []

    monkeypatch.setattr(
        ignored_repairs,
        "select_runtime_persistence_adapter",
        lambda seam, config: selected.append((seam, config)),
    )
    monkeypatch.setattr(ignored_repairs, "RuleStatePostgresAdapter", adapter_type)

    from music_app.services import library_browse_postgres

    monkeypatch.setattr(
        library_browse_postgres,
        "invalidate_postgres_utility_projection_cache",
        lambda **kwargs: invalidated.append(kwargs),
    )
    return selected, invalidated


def test_create_ignored_repair_keys_uses_one_targeted_mutation_then_invalidates(monkeypatch):
    calls: list[tuple[set[str], dict[str, str], set[str]]] = []

    class FakeAdapter:
        def __init__(self, config):
            assert config is expected_config

        def upsert_ignored_repair_keys(
            self,
            row_keys,
            *,
            album_keys_by_repair_key=None,
            remove_repair_keys=(),
        ):
            calls.append(
                (
                    set(row_keys),
                    dict(album_keys_by_repair_key or {}),
                    set(remove_repair_keys),
                )
            )

    expected_config = {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://runtime/app"}
    selected, invalidated = _patch_dependencies(monkeypatch, adapter_type=FakeAdapter)

    ignored_repairs.create_ignored_repair_keys(
        expected_config,
        {"album-rule", "file-rule"},
        album_keys_by_repair_key={"album-rule": "neal morse::?"},
        remove_row_keys={"legacy-rule"},
    )

    assert selected == [("ignored_repairs", expected_config)]
    assert calls == [
        (
            {"album-rule", "file-rule"},
            {"album-rule": "neal morse::?"},
            {"legacy-rule"},
        )
    ]
    assert invalidated == [
        {
            "database_url": "postgresql://runtime/app",
            "kinds": ("problematic-files", "rules"),
        }
    ]


def test_delete_ignored_repair_keys_uses_targeted_delete_then_invalidates(monkeypatch):
    calls: list[set[str]] = []

    class FakeAdapter:
        def __init__(self, config):
            assert config is expected_config

        def delete_ignored_repair_keys(self, row_keys):
            calls.append(set(row_keys))

    expected_config = {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://runtime/app"}
    selected, invalidated = _patch_dependencies(monkeypatch, adapter_type=FakeAdapter)

    ignored_repairs.delete_ignored_repair_keys(expected_config, {"row-b", "row-a"})

    assert selected == [("ignored_repairs", expected_config)]
    assert calls == [{"row-a", "row-b"}]
    assert invalidated == [
        {
            "database_url": "postgresql://runtime/app",
            "kinds": ("problematic-files", "rules"),
        }
    ]


@pytest.mark.parametrize("operation", ["create", "delete"])
def test_targeted_ignored_repair_failure_does_not_invalidate(monkeypatch, operation):
    class FakeAdapter:
        def __init__(self, _config):
            pass

        def upsert_ignored_repair_keys(self, *_args, **_kwargs):
            raise RuntimeError("write failed")

        def delete_ignored_repair_keys(self, *_args, **_kwargs):
            raise RuntimeError("write failed")

    config = {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://runtime/app"}
    _selected, invalidated = _patch_dependencies(monkeypatch, adapter_type=FakeAdapter)

    with pytest.raises(RuntimeError, match="write failed"):
        if operation == "create":
            ignored_repairs.create_ignored_repair_keys(config, {"row-key"})
        else:
            ignored_repairs.delete_ignored_repair_keys(config, {"row-key"})

    assert invalidated == []
