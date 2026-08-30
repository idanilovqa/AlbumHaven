from __future__ import annotations

import importlib
from pathlib import Path
from types import SimpleNamespace

import pytest

from music_app.services.rule_state_postgres import RuleStatePostgresAdapter


class FakeCursor:
    def __init__(self, rows: list[object] | None = None) -> None:
        self._rows = rows or []

    def fetchall(self) -> list[object]:
        return list(self._rows)

    def fetchone(self) -> object | None:
        return self._rows[0] if self._rows else None


class FakeTransaction:
    def __init__(self, connection: "FakeConnection") -> None:
        self._connection = connection

    def __enter__(self) -> "FakeTransaction":
        self._connection.transaction_entries += 1
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self._connection.transaction_exits += 1


class FakeConnection:
    def __init__(self, rows_by_table: dict[str, list[object]] | None = None) -> None:
        self.rows_by_table = rows_by_table or {}
        self.operations: list[tuple[str, object]] = []
        self.transaction_entries = 0
        self.transaction_exits = 0

    def __enter__(self) -> "FakeConnection":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        pass

    def transaction(self) -> FakeTransaction:
        return FakeTransaction(self)

    def execute(self, sql: str, params: object = None) -> FakeCursor:
        self.operations.append((sql, params))
        normalized_sql = " ".join(str(sql).lower().split())
        if "bootstrap_context_ready" in normalized_sql:
            return FakeCursor([{"bootstrap_context_ready": 1}])
        for table_name, rows in self.rows_by_table.items():
            if f"from library.{table_name}" in normalized_sql:
                return FakeCursor(rows)
        return FakeCursor()


def _adapter(connection: FakeConnection) -> RuleStatePostgresAdapter:
    return RuleStatePostgresAdapter(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connect=lambda database_url: connection,
    )


def _sql_text(connection: FakeConnection) -> str:
    return "\n".join(sql.lower() for sql, _params in connection.operations)


def _json_payload(value: object) -> object:
    return getattr(value, "obj", value)


@pytest.mark.parametrize(
    (
        "module_name",
        "seam_id",
        "legacy_file_name",
        "load_function_name",
        "save_function_name",
        "adapter_load_name",
        "adapter_save_name",
        "loaded_value",
        "saved_value",
    ),
    [
        (
            "ignored_versions",
            "ignored_versions",
            "ignored_versions.json",
            "load_ignored_version_keys",
            "save_ignored_version_keys",
            "load_ignored_version_keys",
            "save_ignored_version_keys",
            {"postgres-version"},
            {"saved-version"},
        ),
        (
            "ignored_repairs",
            "ignored_repairs",
            "ignored_repairs.json",
            "load_ignored_repair_keys",
            "save_ignored_repair_keys",
            "load_ignored_repair_keys",
            "save_ignored_repair_keys",
            {"postgres-repair"},
            {"saved-repair"},
        ),
        (
            "manual_versions",
            "manual_versions",
            "manual_versions.json",
            "load_manual_version_links",
            "save_manual_version_links",
            "load_manual_version_links",
            "save_manual_version_links",
            {"postgres-child": "postgres-parent"},
            {"saved-child": "saved-parent"},
        ),
        (
            "separate_releases",
            "separate_releases",
            "separate_releases.json",
            "load_separate_release_keys",
            "save_separate_release_keys",
            "load_separate_release_keys",
            "save_separate_release_keys",
            {"postgres-separate"},
            {"saved-separate"},
        ),
        (
            "exception_overrides",
            "exception_overrides",
            "exception_overrides.json",
            "load_exception_overrides",
            "save_exception_overrides",
            "load_exception_overrides",
            "save_exception_overrides",
            {"C:/Music/postgres.flac": "Interview"},
            {"C:/Music/saved.flac": "Non-album rarity"},
        ),
    ],
)
def test_rule_state_services_have_no_file_fallback_after_selection(
    tmp_path,
    monkeypatch,
    module_name,
    seam_id,
    legacy_file_name,
    load_function_name,
    save_function_name,
    adapter_load_name,
    adapter_save_name,
    loaded_value,
    saved_value,
):
    service_module = importlib.import_module(f"music_app.services.{module_name}")
    expected_config = {"DATA_DIR": tmp_path}
    legacy_path = Path(expected_config["DATA_DIR"]) / legacy_file_name
    legacy_path.parent.mkdir(parents=True, exist_ok=True)
    legacy_path.write_text("legacy-json-state", encoding="utf-8")
    saved_calls: list[object] = []

    class FakeAdapter:
        def __init__(self, received_config):
            assert received_config is expected_config

        def __getattr__(self, name):
            if name == adapter_load_name:
                return lambda: loaded_value
            if name == adapter_save_name:
                return lambda value: saved_calls.append(value)
            raise AttributeError(name)

    def fake_select_runtime_persistence_adapter(selected_seam_id, received_config):
        assert selected_seam_id == seam_id
        assert received_config is expected_config
        return SimpleNamespace(effective_backend="file")

    monkeypatch.setattr(
        service_module,
        "select_runtime_persistence_adapter",
        fake_select_runtime_persistence_adapter,
    )
    monkeypatch.setattr(service_module, "RuleStatePostgresAdapter", FakeAdapter)

    assert getattr(service_module, load_function_name)(expected_config) == loaded_value
    getattr(service_module, save_function_name)(expected_config, saved_value)

    assert saved_calls == [saved_value]
    assert legacy_path.read_text(encoding="utf-8") == "legacy-json-state"


@pytest.mark.parametrize(
    ("method_name", "table_name", "rows", "expected"),
    [
        (
            "load_ignored_version_keys",
            "ignored_versions",
            [{"version_key": " album-b "}, {"version_key": ""}, ("album-a",)],
            {"album-a", "album-b"},
        ),
        (
            "load_ignored_repair_keys",
            "ignored_repairs",
            [{"repair_key": " repair-b "}, {"repair_key": None}, ("repair-a",)],
            {"repair-a", "repair-b"},
        ),
        (
            "load_separate_release_keys",
            "separate_releases",
            [{"release_key": " release-b "}, {"release_key": ""}, ("release-a",)],
            {"release-a", "release-b"},
        ),
    ],
)
def test_postgres_rule_key_loads_read_normalized_sets(method_name, table_name, rows, expected):
    connection = FakeConnection({table_name: rows})

    result = getattr(_adapter(connection), method_name)()

    assert result == expected
    sql_text = _sql_text(connection)
    assert f"from library.{table_name}" in sql_text
    assert "app.bootstrap_owners" in sql_text
    assert "local-bootstrap-owner" in sql_text
    assert "local library" in sql_text


def test_postgres_manual_versions_loads_normalized_links():
    connection = FakeConnection(
        {
            "manual_versions": [
                {"child_key": " child-b ", "parent_key": " parent-b "},
                {"child_key": "same", "parent_key": "same"},
                ("child-a", "parent-a"),
                ("", "parent-c"),
            ]
        }
    )

    result = _adapter(connection).load_manual_version_links()

    assert result == {"child-a": "parent-a", "child-b": "parent-b"}
    assert "from library.manual_versions" in _sql_text(connection)


def test_postgres_rule_state_loads_complete_legacy_album_exclusion_groups():
    connection = FakeConnection(
        {
            "ignored_repairs": [
                {
                    "album_key": "neal morse::?",
                    "album_title": "?",
                    "legacy_repair_keys": ["X:/SyntheticMusic/01.mp3::album", "X:/SyntheticMusic/02.mp3::album"],
                }
            ]
        }
    )

    groups = _adapter(connection).load_complete_legacy_album_exclusion_groups()

    assert groups == [
        {
            "album_key": "neal morse::?",
            "album_title": "?",
            "legacy_repair_keys": ["X:/SyntheticMusic/01.mp3::album", "X:/SyntheticMusic/02.mp3::album"],
        }
    ]
    sql = _sql_text(connection)
    assert "library.ignored_repairs" in sql
    assert "count(distinct legacy_rows.private_path) = active_album_file_counts.active_file_count" in " ".join(sql.split())


def test_ignored_repairs_migrates_complete_legacy_album_rules_to_one_album_rule(monkeypatch):
    from music_app.services import ignored_repairs as ignored_repairs_module

    saved_calls = []

    class FakeAdapter:
        def __init__(self, _config):
            pass

        def load_complete_legacy_album_exclusion_groups(self):
            return [
                {
                    "album_key": "neal morse::?",
                    "album_title": "?",
                    "legacy_repair_keys": [
                        "X:/SyntheticMusic/01.mp3::album",
                        "X:/SyntheticMusic/02.mp3::album",
                    ],
                }
            ]

        def load_ignored_repair_keys(self):
            return {
                "X:/SyntheticMusic/01.mp3::album",
                "X:/SyntheticMusic/02.mp3::album",
                "unrelated::problem-file::missing-year",
            }

        def save_ignored_repair_keys(self, values, *, album_keys_by_repair_key=None):
            saved_calls.append((set(values), dict(album_keys_by_repair_key or {})))

    monkeypatch.setattr(ignored_repairs_module, "RuleStatePostgresAdapter", FakeAdapter)
    result = ignored_repairs_module.migrate_legacy_album_exclusions(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://runtime/app"}
    )

    album_rule = "neal morse::?::problem-album::undecoded-characters"
    assert saved_calls == [
        (
            {"unrelated::problem-file::missing-year", album_rule},
            {album_rule: "neal morse::?"},
        )
    ]
    assert result == {
        "migrated_album_count": 1,
        "removed_legacy_rule_count": 2,
        "created_album_rule_count": 1,
    }


def test_postgres_exception_overrides_loads_json_exception_type_with_text_fallback():
    connection = FakeConnection(
        {
            "exception_overrides": [
                {"track_key": " C:/Music/a.flac ", "override_payload": {"exception_type": " non-album rarity "}},
                {"track_key": "C:/Music/b.flac", "override_payload": "Interview"},
                {"track_key": "C:/Music/c.flac", "exception_type": "Single"},
                {"track_key": "C:/Music/d.flac", "override_payload": {}, "exception_type": "Compilation"},
                {"track_key": "", "override_payload": {"exception_type": "Interview"}},
            ]
        }
    )

    result = _adapter(connection).load_exception_overrides()

    assert result == {
        "C:/Music/a.flac": "Non-album rarity",
        "C:/Music/b.flac": "Interview",
        "C:/Music/c.flac": "Single",
        "C:/Music/d.flac": "Compilation",
    }
    assert "from library.exception_overrides" in _sql_text(connection)


@pytest.mark.parametrize(
    ("method_name", "table_name", "input_values", "insert_column", "expected_params"),
    [
        (
            "save_ignored_version_keys",
            "ignored_versions",
            {" album-b ", "", "album-a"},
            "version_key",
            [("album-a",), ("album-b",)],
        ),
        (
            "save_ignored_repair_keys",
            "ignored_repairs",
            {" repair-b ", "", "repair-a"},
            "repair_key",
            [("repair-a",), ("repair-b",)],
        ),
    ],
)
def test_postgres_rule_key_saves_replace_library_rows_in_transaction(
    method_name,
    table_name,
    input_values,
    insert_column,
    expected_params,
):
    connection = FakeConnection()

    getattr(_adapter(connection), method_name)(input_values)

    sql_text = _sql_text(connection)
    assert f"delete from library.{table_name}" in sql_text
    assert f"insert into library.{table_name}" in sql_text
    assert insert_column in sql_text
    assert connection.transaction_entries == 1
    assert connection.transaction_exits == 1
    insert_params = [
        params
        for sql, params in connection.operations
        if f"insert into library.{table_name}" in sql.lower()
    ]
    assert insert_params == expected_params


def test_postgres_ignored_repair_upsert_only_mutates_submitted_keys():
    connection = FakeConnection()

    _adapter(connection).upsert_ignored_repair_keys(
        {" album-rule ", "file-rule", ""},
        album_keys_by_repair_key={" album-rule ": " neal morse::? ", "unused": "other"},
        remove_repair_keys={" legacy-b ", "album-rule", "legacy-a", ""},
    )

    relevant_operations = [
        (" ".join(sql.lower().split()), params)
        for sql, params in connection.operations
        if "library.ignored_repairs" in sql.lower()
    ]
    assert len(relevant_operations) == 3
    assert "delete from library.ignored_repairs" in relevant_operations[0][0]
    assert "repair_key = any(%s::text[])" in relevant_operations[0][0]
    assert "and not" not in relevant_operations[0][0]
    assert relevant_operations[0][1] == (["legacy-a", "legacy-b"],)
    assert "insert into library.ignored_repairs" in relevant_operations[1][0]
    assert "on conflict (library_id, repair_key) do update" in relevant_operations[1][0]
    assert relevant_operations[1][1] == ("album-rule", "neal morse::?")
    assert "insert into library.ignored_repairs" in relevant_operations[2][0]
    assert relevant_operations[2][1] == ("file-rule",)
    assert all(
        "not ( library.ignored_repairs.repair_key = any" not in sql
        for sql, _params in relevant_operations
    )
    assert connection.transaction_entries == 1
    assert connection.transaction_exits == 1


def test_postgres_ignored_repair_delete_only_deletes_submitted_keys():
    connection = FakeConnection()

    _adapter(connection).delete_ignored_repair_keys({" rule-b ", "", "rule-a"})

    relevant_operations = [
        (" ".join(sql.lower().split()), params)
        for sql, params in connection.operations
        if "library.ignored_repairs" in sql.lower()
    ]
    assert len(relevant_operations) == 1
    assert relevant_operations[0][1] == (["rule-a", "rule-b"],)
    assert "delete from library.ignored_repairs" in relevant_operations[0][0]
    assert "repair_key = any(%s::text[])" in relevant_operations[0][0]
    assert "and not" not in relevant_operations[0][0]
    assert connection.transaction_entries == 1
    assert connection.transaction_exits == 1


def test_postgres_ignored_repair_targeted_mutations_skip_empty_inputs():
    connection = FakeConnection()
    adapter = _adapter(connection)

    adapter.upsert_ignored_repair_keys(set())
    adapter.delete_ignored_repair_keys(set())

    assert connection.operations == []
    assert connection.transaction_entries == 0


def test_postgres_separate_release_save_upserts_before_deleting_absent_keys():
    connection = FakeConnection()

    _adapter(connection).save_separate_release_keys(
        {" release-b ", "", "release-a"}
    )

    relevant_operations = [
        (sql.lower(), params)
        for sql, params in connection.operations
        if "library.separate_releases" in sql.lower()
    ]
    assert len(relevant_operations) == 3
    assert "insert into library.separate_releases" in relevant_operations[0][0]
    assert relevant_operations[0][1] == ("release-a",)
    assert "on conflict (library_id, release_key) do nothing" in relevant_operations[0][0]
    assert "insert into library.separate_releases" in relevant_operations[1][0]
    assert relevant_operations[1][1] == ("release-b",)
    assert "delete from library.separate_releases" in relevant_operations[2][0]
    normalized_delete_sql = " ".join(relevant_operations[2][0].split())
    assert (
        "not ( library.separate_releases.release_key = any(%s::text[]) )"
        in normalized_delete_sql
    )
    assert relevant_operations[2][1] == (["release-a", "release-b"],)
    assert connection.transaction_entries == 1
    assert connection.transaction_exits == 1


def test_postgres_manual_versions_save_replaces_normalized_links():
    connection = FakeConnection()

    _adapter(connection).save_manual_version_links(
        {
            " child-b ": " parent-b ",
            "same": "same",
            "": "parent-c",
            "child-a": "parent-a",
        }
    )

    sql_text = _sql_text(connection)
    assert "delete from library.manual_versions" in sql_text
    assert "insert into library.manual_versions" in sql_text
    assert connection.transaction_entries == 1
    insert_params = [
        params
        for sql, params in connection.operations
        if "insert into library.manual_versions" in sql.lower()
    ]
    assert insert_params == [("child-a", "parent-a"), ("child-b", "parent-b")]


def test_postgres_exception_overrides_save_replaces_normalized_payloads():
    connection = FakeConnection()

    _adapter(connection).save_exception_overrides(
        {
            " C:/Music/b.flac ": "",
            "C:/Music/a.flac": " non-album rarity ",
            "": "Interview",
        }
    )

    sql_text = _sql_text(connection)
    assert "insert into library.exception_overrides" in sql_text
    assert "library.local_tracks" in sql_text
    assert "track_id = coalesce(excluded.track_id, library.exception_overrides.track_id)" in sql_text
    assert "delete from library.exception_overrides" in sql_text
    assert "track_key <> all" in sql_text
    assert connection.transaction_entries == 1
    insert_params = [
        (params[0], _json_payload(params[1]))
        for sql, params in connection.operations
        if "insert into library.exception_overrides" in sql.lower()
    ]
    assert insert_params == [
        ("C:/Music/a.flac", {"exception_type": "Non-album rarity"}),
        ("C:/Music/b.flac", {"exception_type": ""}),
    ]
    trim_params = [
        params
        for sql, params in connection.operations
        if "delete from library.exception_overrides" in sql.lower()
    ]
    assert trim_params == [(2, ["C:/Music/a.flac", "C:/Music/b.flac"])]


def test_postgres_exception_overrides_empty_save_deletes_all_rows():
    connection = FakeConnection()

    _adapter(connection).save_exception_overrides({})

    sql_text = _sql_text(connection)
    assert "delete from library.exception_overrides" in sql_text
    assert "insert into library.exception_overrides" not in sql_text


def test_postgres_exception_override_upserts_do_not_delete_unmentioned_paths():
    connection = FakeConnection()

    _adapter(connection).upsert_exception_overrides(
        {
            " C:/Music/b.flac ": "",
            "C:/Music/a.flac": " non-album rarity ",
            "": "Interview",
        }
    )

    exception_operations = [
        (sql, params)
        for sql, params in connection.operations
        if "library.exception_overrides" in sql.lower()
    ]
    assert all(
        "delete from library.exception_overrides" not in sql.lower()
        for sql, _params in exception_operations
    )
    assert [
        (params[0], _json_payload(params[1]))
        for sql, params in exception_operations
        if "insert into library.exception_overrides" in sql.lower()
    ] == [
        ("C:/Music/a.flac", {"exception_type": "Non-album rarity"}),
        ("C:/Music/b.flac", {"exception_type": ""}),
    ]
    assert connection.transaction_entries == 1
    assert connection.transaction_exits == 1
