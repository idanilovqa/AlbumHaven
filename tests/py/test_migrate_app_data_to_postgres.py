from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path
from types import SimpleNamespace

import pytest

from music_app.services.library_roots import (
    normalize_library_root_settings,
)
from music_app.services.track_preferences import normalize_track_preference_overlay


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = REPO_ROOT / "scripts" / "migrate_app_data_to_postgres.py"
REPORT_KEYS = {
    "mode",
    "data_dir",
    "summaries",
    "failures",
    "source_count",
    "target_count",
    "skipped_count",
    "warning_count",
    "error_count",
}
DESTRUCTIVE_SQL = re.compile(
    r"\b(delete|truncate|drop)\b|\balter\s+table\b[^;]*\bdrop\b",
    re.IGNORECASE,
)


class RecordingTarget:
    def __init__(self) -> None:
        self.started_runs: list[dict[str, object]] = []
        self.completed_runs: list[dict[str, object]] = []
        self.source_summaries: list[dict[str, object]] = []
        self.operations: list[dict[str, object]] = []

    def begin_migration_run(self, *, mode: str, data_dir: Path) -> int:
        self.started_runs.append({"mode": mode, "data_dir": Path(data_dir)})
        return len(self.started_runs)

    def record_source_summary(self, migration_run_id: int, summary: dict[str, object]) -> None:
        self.source_summaries.append(
            {"migration_run_id": migration_run_id, "summary": dict(summary)}
        )

    def execute(self, sql: str, params: object | None = None) -> None:
        self.operations.append({"sql": sql, "params": params})
        return 1

    def complete_migration_run(
        self, migration_run_id: int, *, status: str, report: dict[str, object]
    ) -> None:
        self.completed_runs.append(
            {
                "migration_run_id": migration_run_id,
                "status": status,
                "report": dict(report),
            }
        )


def _load_script_module():
    if not SCRIPT_PATH.exists():
        pytest.skip(
            "scripts/migrate_app_data_to_postgres.py is not implemented yet; "
            "test_script_module_exists captures the expected TDD red state"
        )
    spec = importlib.util.spec_from_file_location("migrate_app_data_to_postgres", SCRIPT_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


def _minimal_data_dir(tmp_path: Path) -> Path:
    data_dir = tmp_path / "album-haven-data"
    data_dir.mkdir()
    _write_json(
        data_dir / "track_preferences.json",
        {
            "tracks": {
                "artist|album|song": {
                    "rating": 5,
                    "love_tier": "loved",
                }
            }
        },
    )
    _write_json(data_dir / "listen_history.json", {"items": []})
    return data_dir


def _data_dir_with_library_cache(tmp_path: Path) -> Path:
    data_dir = _minimal_data_dir(tmp_path)
    track_path = data_dir / "Music" / "Artist One" / "Album One" / "01 Song One.flac"
    _write_json(
        data_dir / "library_cache.json",
        {
            "music_root": str(data_dir),
            "last_scan": 1.0,
            "files": {
                str(track_path): {
                    "path": str(track_path),
                    "mtime": 1710000000.0,
                    "size": 123456,
                    "album": "Album One",
                    "album_artist": "Artist One",
                    "title": "Song One",
                    "track_number": 1,
                    "disc_number": 1,
                    "artist": "Artist One",
                    "duration_seconds": 215,
                    "cover_path": str(data_dir / "covers" / "album-one.jpg"),
                    "year": 2024,
                    "library_root_id": "main",
                    "library_root_category": "albums",
                }
            },
        },
    )
    return data_dir


def _data_dir_with_external_music_root_cache(tmp_path: Path) -> Path:
    data_dir = _data_dir_with_library_cache(tmp_path)
    payload = json.loads((data_dir / "library_cache.json").read_text(encoding="utf-8"))
    payload["music_root"] = str(tmp_path / "music-root")
    _write_json(data_dir / "library_cache.json", payload)
    return data_dir


def _data_dir_with_library_roots(tmp_path: Path) -> Path:
    data_dir = _minimal_data_dir(tmp_path)
    main_root = tmp_path / "Main Music"
    hoard_root = tmp_path / "Hoard"
    arrivals_root = tmp_path / "Arrivals"
    _write_json(
        data_dir / "library_roots.json",
        {
            "main_library_roots": [
                {
                    "id": "main-1",
                    "path": str(main_root),
                    "layout_mode": "artist",
                }
            ],
            "hoarding_library_roots": [
                {
                    "id": "hoard-1",
                    "path": str(hoard_root),
                }
            ],
            "new_arrivals_roots": [
                {
                    "id": "arrivals-1",
                    "path": str(arrivals_root),
                }
            ],
            "move_policy": {
                "preferred_main_write_root": str(main_root),
                "move_new_arrivals_to": str(hoard_root),
            },
        },
    )
    return data_dir


def _data_dir_with_rule_sources(tmp_path: Path) -> Path:
    data_dir = _minimal_data_dir(tmp_path)
    _write_json(
        data_dir / "ignored_versions.json",
        {"ignored_version_keys": [" album-a ", "", "album-b"]},
    )
    _write_json(
        data_dir / "ignored_repairs.json",
        {"ignored_row_keys": [" repair-a ", "", "repair-b"]},
    )
    _write_json(
        data_dir / "manual_versions.json",
        {
            "manual_version_links": {
                " child-a ": " parent-a ",
                "blank-parent": " ",
                " same ": "same",
                "": "parent-b",
            }
        },
    )
    _write_json(
        data_dir / "separate_releases.json",
        {"separate_release_keys": [" release-a ", "", "release-b"]},
    )
    _write_json(
        data_dir / "exception_overrides.json",
        {
            "items": {
                " C:/Music/Track One.flac ": "non album rarity",
                "C:/Music/Track Two.flac": " ",
                "": "Interview",
            }
        },
    )
    return data_dir


def _data_dir_with_discovery_preferences(tmp_path: Path) -> Path:
    data_dir = _minimal_data_dir(tmp_path)
    _write_json(
        data_dir / "discovery_center_preferences.json",
        {
            "source_toggles": {
                "release": "false",
                "suggestion": True,
            },
            "delivery": {
                "toast_notifications_enabled": "0",
                "quiet_hours": {
                    "enabled": "yes",
                    "start": "23:30",
                    "end": "06:15",
                },
            },
        },
    )
    _write_json(
        data_dir / "discovery_lookup_snapshots.json",
        {
            "items": [
                {
                    "lookup_ref": "lookup-not-backfilled",
                    "status": "pending_source_integration",
                }
            ]
        },
    )
    return data_dir


def test_script_module_exists():
    assert SCRIPT_PATH.exists(), (
        "missing required Phase 6 Section 4 migration entry point: "
        "scripts/migrate_app_data_to_postgres.py"
    )


def test_cli_defaults_to_dry_run_and_rejects_conflicting_modes():
    module = _load_script_module()

    parser = module.build_arg_parser()

    default_args = parser.parse_args([])
    assert default_args.dry_run is True
    assert default_args.apply is False

    explicit_dry_run = parser.parse_args(["--dry-run"])
    assert explicit_dry_run.dry_run is True
    assert explicit_dry_run.apply is False

    apply_args = parser.parse_args(["--apply"])
    assert apply_args.apply is True
    assert apply_args.dry_run is False

    assert hasattr(default_args, "data_dir")
    assert hasattr(default_args, "report")
    with pytest.raises(SystemExit):
        parser.parse_args(["--dry-run", "--apply"])


def test_missing_data_dir_reports_cleanly_without_traceback(tmp_path: Path):
    module = _load_script_module()
    report_path = tmp_path / "missing-report.json"

    report = module.run_migration(
        data_dir=tmp_path / "does-not-exist",
        mode="dry-run",
        report_path=report_path,
    )

    assert report["mode"] == "dry-run"
    assert report["error_count"] >= 1
    assert report["failures"]
    assert "traceback" not in json.dumps(report).lower()
    assert json.loads(report_path.read_text(encoding="utf-8")) == report


def test_dry_run_writes_machine_readable_report_without_target(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    report_path = tmp_path / "dry-run-report.json"

    report = module.run_migration(
        data_dir=data_dir,
        mode="dry-run",
        report_path=report_path,
        target=None,
    )

    assert REPORT_KEYS <= set(report)
    assert report["mode"] == "dry-run"
    assert Path(report["data_dir"]) == data_dir
    assert isinstance(report["summaries"], list)
    assert isinstance(report["failures"], list)
    assert report["source_count"] >= 1
    assert report["target_count"] == 0
    assert report["skipped_count"] >= 0
    assert report["warning_count"] >= 0
    assert report["error_count"] == 0
    assert json.loads(report_path.read_text(encoding="utf-8")) == report


def test_dry_run_does_not_call_apply_target(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="dry-run", target=target)

    assert report["mode"] == "dry-run"
    assert target.started_runs == []
    assert target.source_summaries == []
    assert target.operations == []
    assert target.completed_runs == []


def test_apply_uses_injected_target_and_records_lifecycle(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    report_path = tmp_path / "apply-report.json"
    target = RecordingTarget()

    report = module.run_migration(
        data_dir=data_dir,
        mode="apply",
        report_path=report_path,
        target=target,
    )

    assert report["mode"] == "apply"
    assert target.started_runs == [{"mode": "apply", "data_dir": data_dir}]
    assert target.source_summaries
    assert target.completed_runs == [
        {
            "migration_run_id": 1,
            "status": "completed",
            "report": report,
        }
    ]
    assert json.loads(report_path.read_text(encoding="utf-8")) == report


def test_bootstrap_library_seed_is_scoped_to_bootstrap_owner(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    target = RecordingTarget()

    module.run_migration(data_dir=data_dir, mode="apply", target=target)

    bootstrap_operation = target.operations[0]
    sql = " ".join(str(bootstrap_operation["sql"]).lower().split())
    params = bootstrap_operation["params"]
    assert "insert into library.libraries" in sql
    assert "insert into app.accounts (display_name, account_kind, metadata)" in sql
    assert "'nominem', 'bootstrap_owner'" in sql
    assert "'display_name', 'nominem'" in sql
    assert "insert into app.bootstrap_owners (account_id, owner_key, metadata)" in sql
    assert "'local-bootstrap-owner'" in sql
    assert "on conflict (owner_account_id, name, library_kind)" in sql
    assert "where name = 'local library'" not in sql
    assert params in (None, [])


def test_apply_writes_non_empty_listen_history_and_counts_targets(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    _write_json(
        data_dir / "listen_history.json",
        {
            "items": [
                {
                    "id": "listen-1",
                    "track_ref": "artist|album|song",
                    "recorded_at": "2026-07-01T10:11:12+00:00",
                    "scrobble_eligible": True,
                    "scrobbled": False,
                }
            ]
        },
    )
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    listen_operations = [
        operation for operation in target.operations
        if "integration.listen_history" in str(operation["sql"])
    ]
    assert listen_operations
    assert "on conflict" in str(listen_operations[0]["sql"]).lower()
    listen_summary = next(
        summary["summary"]
        for summary in target.source_summaries
        if summary["summary"]["source_family"] == "listen_history"
    )
    report_listen_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "listen_history"
    )
    assert listen_summary["source_count"] == 1
    assert listen_summary["target_count"] == 1
    assert report_listen_summary["target_count"] == 1


def test_dry_run_reports_library_cache_local_inventory_source_counts(tmp_path: Path):
    module = _load_script_module()
    data_dir = _data_dir_with_library_cache(tmp_path)

    report = module.run_migration(data_dir=data_dir, mode="dry-run")

    inventory_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "local_library_inventory"
    )
    assert inventory_summary["source_path"] == str(data_dir / "library_cache.json")
    assert inventory_summary["source_count"] == 6
    assert inventory_summary["artist_count"] == 1
    assert inventory_summary["album_count"] == 1
    assert inventory_summary["track_count"] == 1
    assert inventory_summary["track_file_count"] == 1
    assert inventory_summary["featured_artist_count"] == 2
    assert inventory_summary["target_count"] == 0


def test_dry_run_uses_library_cache_payload_identity_for_local_inventory(tmp_path: Path):
    module = _load_script_module()
    data_dir = _data_dir_with_external_music_root_cache(tmp_path)

    report = module.run_migration(data_dir=data_dir, mode="dry-run")

    inventory_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "local_library_inventory"
    )
    assert inventory_summary["source_count"] == 6


def test_apply_writes_local_inventory_to_expected_library_tables(tmp_path: Path):
    module = _load_script_module()
    data_dir = _data_dir_with_library_cache(tmp_path)
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    sql_text = "\n".join(str(operation["sql"]).lower() for operation in target.operations)
    assert "insert into library.local_artists" in sql_text
    assert "insert into library.local_albums" in sql_text
    assert "insert into library.local_album_featured_artists" in sql_text
    assert "insert into library.local_tracks" in sql_text
    assert "insert into library.local_track_files" in sql_text
    assert "on conflict" in sql_text
    inventory_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "local_library_inventory"
    )
    assert inventory_summary["source_count"] == 6
    assert inventory_summary["target_count"] == 6


def test_apply_writes_local_track_file_relative_path_from_library_cache_root(tmp_path: Path):
    module = _load_script_module()
    data_dir = _data_dir_with_library_cache(tmp_path)
    target = RecordingTarget()

    module.run_migration(data_dir=data_dir, mode="apply", target=target)

    track_file_operation = next(
        operation for operation in target.operations
        if "insert into library.local_track_files" in str(operation["sql"]).lower()
    )
    assert track_file_operation["params"][2] == str(
        Path("Music") / "Artist One" / "Album One" / "01 Song One.flac"
    )


def test_apply_batches_local_inventory_rows_when_target_supports_batches(tmp_path: Path):
    module = _load_script_module()
    data_dir = _data_dir_with_library_cache(tmp_path)

    class BatchRecordingTarget(RecordingTarget):
        def __init__(self) -> None:
            super().__init__()
            self.batches: list[list[tuple[str, object | None]]] = []

        def execute_batch(self, operations: list[tuple[str, object | None]]) -> int:
            self.batches.append(operations)
            return len(operations)

    target = BatchRecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    batch_sql_text = "\n".join(
        sql.lower() for batch in target.batches for sql, _params in batch
    )
    assert "insert into library.local_artists" in batch_sql_text
    assert "insert into library.local_albums" in batch_sql_text
    assert "insert into library.local_album_featured_artists" in batch_sql_text
    assert "insert into library.local_tracks" in batch_sql_text
    assert "insert into library.local_track_files" in batch_sql_text
    assert not any(
        "insert into library.local_" in str(operation["sql"]).lower()
        for operation in target.operations
    )
    inventory_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "local_library_inventory"
    )
    assert inventory_summary["target_count"] == 6


def test_local_inventory_rows_split_featured_track_artists_into_featured_rows(
    monkeypatch: pytest.MonkeyPatch,
):
    module = _load_script_module()
    monkeypatch.setattr(
        module,
        "build_albums_from_file_cache",
        lambda _file_cache: [
            SimpleNamespace(
                key="artist one::album one",
                name="Album One",
                album_artist="Artist One",
                artists=["Artist One"],
                year=2024,
                cover_path=None,
                edition=None,
                root_provenance={"root": "main"},
                tracks=[
                    SimpleNamespace(
                        path="C:/Music/Artist One/Album One/01 Song One.flac",
                        title="Song One",
                        artist="Artist One feat. Guest One",
                        album="Album One",
                        album_artist="Artist One",
                        disc_number=1,
                        track_number=1,
                        duration_seconds=215,
                        root_provenance={"root": "main"},
                    )
                ],
            )
        ],
    )

    rows = module._local_inventory_rows_from_file_cache(
        {
            "C:/Music/Artist One/Album One/01 Song One.flac": {
                "path": "C:/Music/Artist One/Album One/01 Song One.flac",
                "mtime": 1710000000.0,
                "size": 123456,
                "album": "Album One",
                "album_artist": "Artist One",
                "title": "Song One",
                "track_number": 1,
                "disc_number": 1,
                "artist": "Artist One feat. Guest One",
                "duration_seconds": 215,
                "cover_path": None,
                "year": 2024,
                "library_root_id": "main",
                "library_root_category": "albums",
            }
        }
    )

    assert rows["albums"][0]["metadata"]["featured_artists"] == ["Guest One"]
    assert {
        (row["artist_key"], row["featured_kind"])
        for row in rows["featured_artists"]
    } == {
        ("artist one", "owner"),
        ("artist one", "featured_track_artist"),
        ("guest one", "featured_track_artist"),
    }


def test_dry_run_reports_library_root_settings_source_counts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    module = _load_script_module()
    data_dir = _data_dir_with_library_roots(tmp_path)
    monkeypatch.delenv("MUSIC_LIBRARY_ROOTS_PATH", raising=False)

    report = module.run_migration(data_dir=data_dir, mode="dry-run")

    root_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "library_root_settings"
    )
    assert root_summary["source_path"] == str(data_dir / "library_roots.json")
    assert root_summary["source_count"] == 9
    assert root_summary["target_count"] == 0
    assert root_summary["root_count"] == 3
    assert root_summary["settings_count"] == 1
    assert root_summary["move_policy_count"] == 2
    assert root_summary["provenance_count"] == 3
    assert report["error_count"] == 0


def test_apply_writes_library_root_settings_to_all_root_table_families(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    module = _load_script_module()
    data_dir = _data_dir_with_library_roots(tmp_path)
    target = RecordingTarget()
    monkeypatch.delenv("MUSIC_LIBRARY_ROOTS_PATH", raising=False)

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    sql_text = "\n".join(str(operation["sql"]).lower() for operation in target.operations)
    assert "insert into library.library_roots" in sql_text
    assert "insert into library.library_root_settings" in sql_text
    assert "insert into library.move_policy_settings" in sql_text
    assert "insert into library.library_root_provenance" in sql_text
    assert "on conflict" in sql_text
    root_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "library_root_settings"
    )
    assert root_summary["source_count"] == 9
    assert root_summary["target_count"] == 9

    root_operation = next(
        operation for operation in target.operations
        if "insert into library.library_roots" in str(operation["sql"]).lower()
    )
    assert root_operation["params"][2]["root_id"] == "main-1"
    assert root_operation["params"][2]["source"] == "phase_6_json_file_backfill"

    settings_operation = next(
        operation for operation in target.operations
        if "insert into library.library_root_settings" in str(operation["sql"]).lower()
    )
    assert settings_operation["params"][2]["main_library_roots"][0]["id"] == "main-1"

    policy_operations = [
        operation for operation in target.operations
        if "insert into library.move_policy_settings" in str(operation["sql"]).lower()
    ]
    policy_payloads = {
        operation["params"][0]: operation["params"][1]
        for operation in policy_operations
    }
    assert policy_payloads["preferred_main_write_root"]["root_id"] == "main-1"
    assert policy_payloads["move_new_arrivals_to"]["root_id"] == "hoard-1"

    provenance_operation = next(
        operation for operation in target.operations
        if "insert into library.library_root_provenance" in str(operation["sql"]).lower()
    )
    assert provenance_operation["params"][1] == "library_root_settings_backfill"
    assert provenance_operation["params"][2] == str(data_dir / "library_roots.json")
    assert provenance_operation["params"][3]["root_id"] == "main-1"


def test_library_root_settings_missing_file_backfills_fallback_music_root(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    monkeypatch.delenv("MUSIC_LIBRARY_ROOTS_PATH", raising=False)

    report = module.run_migration(data_dir=data_dir, mode="dry-run")

    root_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "library_root_settings"
    )
    assert root_summary["source_count"] == 3
    assert root_summary["root_count"] == 1
    assert root_summary["settings_count"] == 1
    assert root_summary["move_policy_count"] == 0
    assert root_summary["provenance_count"] == 1
    assert root_summary["fallback_used"] is True


def test_library_root_settings_missing_file_uses_configured_music_dir(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    configured_music_dir = tmp_path / "Configured Music"
    target = RecordingTarget()
    monkeypatch.setenv("MUSIC_DIR", str(configured_music_dir))
    monkeypatch.delenv("MUSIC_LIBRARY_ROOTS_PATH", raising=False)

    module.run_migration(data_dir=data_dir, mode="apply", target=target)

    root_operation = next(
        operation for operation in target.operations
        if "insert into library.library_roots" in str(operation["sql"]).lower()
    )
    assert root_operation["params"][0] == str(configured_music_dir.resolve(strict=False))


def test_library_root_settings_live_write_is_backfilled_with_same_payload(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    main_root = tmp_path / "Live Main"
    hoard_root = tmp_path / "Live Hoard"
    arrivals_root = tmp_path / "Live Arrivals"
    fallback_music_root = tmp_path / "Fallback Music"
    raw_settings = {
        "main_library_roots": [
            {
                "id": "live-main",
                "path": f" {main_root} ",
                "layout_mode": "genre/artist",
            }
        ],
        "hoarding_library_roots": [
            {
                "id": "live-hoard",
                "path": str(hoard_root),
            }
        ],
        "new_arrivals_roots": [
            {
                "id": "live-arrivals",
                "path": str(arrivals_root),
            }
        ],
        "move_policy": {
            "preferred_main_write_root": str(main_root),
            "move_new_arrivals_to": "live-hoard",
        },
    }
    _write_json(data_dir / "library_roots.json", raw_settings)
    expected = normalize_library_root_settings(
        raw_settings,
        fallback_main_root=fallback_music_root,
    )
    monkeypatch.setenv("MUSIC_DIR", str(fallback_music_root))
    monkeypatch.delenv("MUSIC_LIBRARY_ROOTS_PATH", raising=False)
    target = RecordingTarget()

    module.run_migration(data_dir=data_dir, mode="apply", target=target)

    settings_operation = next(
        operation for operation in target.operations
        if "insert into library.library_root_settings" in str(operation["sql"]).lower()
    )
    assert settings_operation["params"][0] == "genre/artist"
    assert settings_operation["params"][2] == {
        **expected,
        "source": "phase_6_json_file_backfill",
    }

    root_operations = [
        operation for operation in target.operations
        if "insert into library.library_roots" in str(operation["sql"]).lower()
    ]
    root_rows = {
        operation["params"][2]["root_id"]: operation["params"]
        for operation in root_operations
    }
    assert {
        root_id: [params[0], params[1], params[2]["category_key"]]
        for root_id, params in root_rows.items()
    } == {
        "live-main": [
            expected["main_library_roots"][0]["path"],
            "main_library",
            "main_library_roots",
        ],
        "live-hoard": [
            expected["hoarding_library_roots"][0]["path"],
            "hoard",
            "hoarding_library_roots",
        ],
        "live-arrivals": [
            expected["new_arrivals_roots"][0]["path"],
            "new_arrivals",
            "new_arrivals_roots",
        ],
    }

    policy_payloads = {
        operation["params"][0]: operation["params"][1]
        for operation in target.operations
        if "insert into library.move_policy_settings" in str(operation["sql"]).lower()
    }
    assert policy_payloads == {
        "preferred_main_write_root": {
            "root_id": expected["move_policy"]["preferred_main_write_root"],
            "source": "phase_6_json_file_backfill",
        },
        "move_new_arrivals_to": {
            "root_id": expected["move_policy"]["move_new_arrivals_to"],
            "source": "phase_6_json_file_backfill",
        },
    }

    provenance_rows = {
        operation["params"][3]["root_id"]: operation["params"]
        for operation in target.operations
        if "insert into library.library_root_provenance" in str(operation["sql"]).lower()
    }
    assert set(provenance_rows) == {"live-main", "live-hoard", "live-arrivals"}
    assert provenance_rows["live-main"][1] == "library_root_settings_backfill"
    assert provenance_rows["live-main"][2] == str(data_dir / "library_roots.json")
    assert provenance_rows["live-main"][3]["source_family"] == "library_root_settings"


def test_dry_run_reports_rule_source_counts(tmp_path: Path):
    module = _load_script_module()
    data_dir = _data_dir_with_rule_sources(tmp_path)

    report = module.run_migration(data_dir=data_dir, mode="dry-run")

    summaries = {
        summary["source_family"]: summary
        for summary in report["summaries"]
    }
    assert summaries["ignored_versions"]["source_count"] == 2
    assert summaries["ignored_repairs"]["source_count"] == 2
    assert summaries["manual_versions"]["source_count"] == 1
    assert summaries["separate_releases"]["source_count"] == 2
    assert summaries["exception_overrides"]["source_count"] == 2
    assert summaries["ignored_versions"]["target_count"] == 0
    assert summaries["exception_overrides"]["target_count"] == 0
    assert report["error_count"] == 0


def test_apply_writes_all_rule_table_families(tmp_path: Path):
    module = _load_script_module()
    data_dir = _data_dir_with_rule_sources(tmp_path)
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    sql_text = "\n".join(str(operation["sql"]).lower() for operation in target.operations)
    assert "insert into library.ignored_versions" in sql_text
    assert "insert into library.ignored_repairs" in sql_text
    assert "insert into library.manual_versions" in sql_text
    assert "insert into library.separate_releases" in sql_text
    assert "insert into library.exception_overrides" in sql_text
    assert report["error_count"] == 0

    summaries = {
        summary["summary"]["source_family"]: summary["summary"]
        for summary in target.source_summaries
    }
    assert summaries["ignored_versions"]["target_count"] == 2
    assert summaries["ignored_repairs"]["target_count"] == 2
    assert summaries["manual_versions"]["target_count"] == 1
    assert summaries["separate_releases"]["target_count"] == 2
    assert summaries["exception_overrides"]["target_count"] == 2


def test_rule_settings_live_writes_are_backfilled_with_same_normalized_values(
    tmp_path: Path,
):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    _write_json(
        data_dir / "ignored_versions.json",
        {"ignored_version_keys": [" version-b ", "version-a", ""]},
    )
    _write_json(
        data_dir / "ignored_repairs.json",
        {"ignored_row_keys": [" repair-a ", "", "repair-b"]},
    )
    _write_json(
        data_dir / "manual_versions.json",
        {
            "manual_version_links": {
                " child-a ": " parent-a ",
                "same": "same",
                "blank-parent": "",
                "": "parent-b",
            }
        },
    )
    _write_json(
        data_dir / "separate_releases.json",
        {"separate_release_keys": [" release-b ", "release-a", ""]},
    )
    _write_json(
        data_dir / "exception_overrides.json",
        {
            "items": {
                " C:/Music/Track One.flac ": "non album rarity",
                "C:/Music/Track Two.flac": "",
                "": "Interview",
            }
        },
    )
    expected_ignored_versions = ["version-a", "version-b"]
    expected_ignored_repairs = ["repair-a", "repair-b"]
    expected_manual_versions = {"child-a": "parent-a"}
    expected_separate_releases = ["release-a", "release-b"]
    expected_exception_overrides = {
        "C:/Music/Track One.flac": "Non-album rarity",
        "C:/Music/Track Two.flac": "",
    }
    target = RecordingTarget()

    module.run_migration(data_dir=data_dir, mode="apply", target=target)

    ignored_versions = sorted(
        operation["params"][0]
        for operation in target.operations
        if "insert into library.ignored_versions" in str(operation["sql"]).lower()
    )
    ignored_repairs = sorted(
        operation["params"][0]
        for operation in target.operations
        if "insert into library.ignored_repairs" in str(operation["sql"]).lower()
    )
    manual_versions = dict(sorted(
        (operation["params"][0], operation["params"][1])
        for operation in target.operations
        if "insert into library.manual_versions" in str(operation["sql"]).lower()
    ))
    separate_releases = sorted(
        operation["params"][0]
        for operation in target.operations
        if "insert into library.separate_releases" in str(operation["sql"]).lower()
    )
    exception_overrides = dict(sorted(
        (
            operation["params"][0],
            operation["params"][1]["exception_type"],
        )
        for operation in target.operations
        if "insert into library.exception_overrides" in str(operation["sql"]).lower()
    ))

    assert ignored_versions == expected_ignored_versions
    assert ignored_repairs == expected_ignored_repairs
    assert manual_versions == expected_manual_versions
    assert separate_releases == expected_separate_releases
    assert exception_overrides == expected_exception_overrides


def test_apply_links_exception_override_to_same_run_local_track(tmp_path: Path):
    module = _load_script_module()
    data_dir = _data_dir_with_library_cache(tmp_path)
    track_path = data_dir / "Music" / "Artist One" / "Album One" / "01 Song One.flac"
    _write_json(
        data_dir / "exception_overrides.json",
        {"items": {str(track_path): "non album rarity"}},
    )

    class LinkingTarget(RecordingTarget):
        def __init__(self) -> None:
            super().__init__()
            self.next_track_id = 1
            self.local_tracks: dict[str, int] = {}
            self.exception_overrides: dict[str, dict[str, object]] = {}

        def execute(self, sql: str, params: object | None = None) -> int:
            self.operations.append({"sql": sql, "params": params})
            sql_text = sql.lower()
            if "insert into library.local_tracks" in sql_text:
                assert isinstance(params, list)
                track_key = str(params[2])
                self.local_tracks[track_key] = self.next_track_id
                self.next_track_id += 1
            if "insert into library.exception_overrides" in sql_text:
                assert isinstance(params, list)
                track_key = str(params[0])
                self.exception_overrides[track_key] = {
                    "track_id": self.local_tracks.get(track_key),
                    "override_payload": params[1],
                }
            return 1

    target = LinkingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    assert report["error_count"] == 0
    assert target.exception_overrides[str(track_path)]["track_id"] == 1


def test_malformed_rule_sources_default_to_empty_without_errors(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    for filename in (
        "ignored_versions.json",
        "ignored_repairs.json",
        "manual_versions.json",
        "separate_releases.json",
        "exception_overrides.json",
    ):
        (data_dir / filename).write_text("{not-json", encoding="utf-8")

    report = module.run_migration(data_dir=data_dir, mode="dry-run")

    summaries = {
        summary["source_family"]: summary
        for summary in report["summaries"]
    }
    for source_family in (
        "ignored_versions",
        "ignored_repairs",
        "manual_versions",
        "separate_releases",
        "exception_overrides",
    ):
        assert summaries[source_family]["source_count"] == 0
        assert summaries[source_family]["error_count"] == 0
    assert report["error_count"] == 0


def test_wrong_shape_rule_sources_default_to_empty_without_errors(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    _write_json(data_dir / "ignored_versions.json", [])
    _write_json(data_dir / "ignored_repairs.json", [])
    _write_json(data_dir / "manual_versions.json", [])
    _write_json(data_dir / "separate_releases.json", [])
    _write_json(data_dir / "exception_overrides.json", [])

    report = module.run_migration(data_dir=data_dir, mode="dry-run")

    summaries = {
        summary["source_family"]: summary
        for summary in report["summaries"]
    }
    for source_family in (
        "ignored_versions",
        "ignored_repairs",
        "manual_versions",
        "separate_releases",
        "exception_overrides",
    ):
        assert summaries[source_family]["source_count"] == 0
        assert summaries[source_family]["error_count"] == 0
    assert report["error_count"] == 0


def test_rule_loader_unexpected_failure_is_reported_as_source_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)

    def broken_loader(path: Path, key: str) -> list[object]:
        if path.name == "ignored_versions.json":
            raise RuntimeError("loader exploded")
        return []

    monkeypatch.setattr(module, "_load_json_list_or_key_default", broken_loader)

    report = module.run_migration(data_dir=data_dir, mode="dry-run")

    ignored_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "ignored_versions"
    )
    assert ignored_summary["source_count"] == 0
    assert ignored_summary["error_count"] == 1
    assert report["error_count"] == 1
    assert any(
        failure.get("source_family") == "ignored_versions"
        and "loader exploded" in failure.get("message", "")
        for failure in report["failures"]
    )


def test_rule_source_normalization_and_metadata_payloads(tmp_path: Path):
    module = _load_script_module()
    data_dir = _data_dir_with_rule_sources(tmp_path)
    target = RecordingTarget()

    module.run_migration(data_dir=data_dir, mode="apply", target=target)

    ignored_version_operation = next(
        operation for operation in target.operations
        if "insert into library.ignored_versions" in str(operation["sql"]).lower()
    )
    manual_operation = next(
        operation for operation in target.operations
        if "insert into library.manual_versions" in str(operation["sql"]).lower()
    )
    exception_operations = [
        operation for operation in target.operations
        if "insert into library.exception_overrides" in str(operation["sql"]).lower()
    ]

    assert ignored_version_operation["params"][0] == "album-a"
    assert ignored_version_operation["params"][1]["source_file"] == "ignored_versions.json"
    assert manual_operation["params"][0] == "child-a"
    assert manual_operation["params"][1] == "parent-a"

    exception_payloads = {
        operation["params"][0]: operation["params"][1]
        for operation in exception_operations
    }
    assert exception_payloads["C:/Music/Track One.flac"]["exception_type"] == "Non-album rarity"
    assert exception_payloads["C:/Music/Track Two.flac"]["exception_type"] == ""
    assert exception_payloads["C:/Music/Track Two.flac"]["source_file"] == "exception_overrides.json"


def test_rule_apply_sql_is_idempotent_non_destructive_and_counts_rows_touched(tmp_path: Path):
    module = _load_script_module()
    data_dir = _data_dir_with_rule_sources(tmp_path)

    class TouchedRulesTarget(RecordingTarget):
        def execute(self, sql: str, params: object | None = None) -> int:
            self.operations.append({"sql": sql, "params": params})
            return 1

    target = TouchedRulesTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    rule_sql = "\n".join(
        str(operation["sql"])
        for operation in target.operations
        if any(
            table_name in str(operation["sql"])
            for table_name in (
                "library.ignored_versions",
                "library.ignored_repairs",
                "library.manual_versions",
                "library.separate_releases",
                "library.exception_overrides",
            )
        )
    )
    assert "on conflict" in rule_sql.lower()
    assert not DESTRUCTIVE_SQL.search(rule_sql)
    summaries = {
        summary["source_family"]: summary
        for summary in report["summaries"]
    }
    assert summaries["ignored_versions"]["target_count"] == 2
    assert summaries["exception_overrides"]["target_count"] == 2


def test_library_root_settings_reads_custom_source_path_outside_data_dir(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    custom_settings_path = tmp_path / "settings" / "custom-library-roots.json"
    custom_root = tmp_path / "Custom Root"
    _write_json(
        custom_settings_path,
        {
            "main_library_roots": [
                {
                    "id": "custom-main",
                    "path": str(custom_root),
                    "layout_mode": "artist",
                }
            ],
        },
    )
    monkeypatch.setenv("MUSIC_LIBRARY_ROOTS_PATH", str(custom_settings_path))

    report = module.run_migration(data_dir=data_dir, mode="dry-run")

    root_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "library_root_settings"
    )
    assert root_summary["source_path"] == str(custom_settings_path.resolve())
    assert root_summary["source_count"] == 3
    assert root_summary["fallback_used"] is False


def test_malformed_library_root_settings_are_reported_as_source_errors(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    (data_dir / "library_roots.json").write_text("{not-json", encoding="utf-8")
    monkeypatch.delenv("MUSIC_LIBRARY_ROOTS_PATH", raising=False)

    report = module.run_migration(data_dir=data_dir, mode="dry-run")

    assert report["error_count"] >= 1
    assert any(
        failure.get("source_family") == "library_root_settings"
        and failure.get("severity") == "error"
        for failure in report["failures"]
    )
    root_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "library_root_settings"
    )
    assert root_summary["error_count"] == 1


def test_library_root_move_policy_path_references_are_normalized_to_root_ids(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    module = _load_script_module()
    data_dir = _data_dir_with_library_roots(tmp_path)
    target = RecordingTarget()
    monkeypatch.delenv("MUSIC_LIBRARY_ROOTS_PATH", raising=False)

    module.run_migration(data_dir=data_dir, mode="apply", target=target)

    policy_operations = [
        operation for operation in target.operations
        if "insert into library.move_policy_settings" in str(operation["sql"]).lower()
    ]
    policy_payloads = {
        operation["params"][0]: operation["params"][1]
        for operation in policy_operations
    }
    assert policy_payloads == {
        "preferred_main_write_root": {
            "root_id": "main-1",
            "source": "phase_6_json_file_backfill",
        },
        "move_new_arrivals_to": {
            "root_id": "hoard-1",
            "source": "phase_6_json_file_backfill",
        },
    }


def test_apply_scopes_track_preferences_to_bootstrap_library(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    target = RecordingTarget()

    module.run_migration(data_dir=data_dir, mode="apply", target=target)

    track_operation = next(
        operation for operation in target.operations
        if "insert into app.track_preferences" in str(operation["sql"]).lower()
    )
    sql = str(track_operation["sql"]).lower()
    assert "bootstrap_context" in sql
    assert "library.libraries" in sql
    assert "library_id" in sql
    assert "owner_account_id" in sql


def test_apply_scopes_listen_history_to_bootstrap_owner_and_library(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    _write_json(
        data_dir / "listen_history.json",
        {
            "items": [
                {
                    "id": "listen-scoped",
                    "track_ref": "artist|album|song",
                    "recorded_at": "2026-07-01T10:11:12+00:00",
                }
            ]
        },
    )
    target = RecordingTarget()

    module.run_migration(data_dir=data_dir, mode="apply", target=target)

    listen_operation = next(
        operation for operation in target.operations
        if "integration.listen_history" in str(operation["sql"])
    )
    sql = str(listen_operation["sql"]).lower()
    assert "bootstrap_context" in sql
    assert "library.libraries" in sql
    assert "library_id" in sql
    assert "account_id" in sql
    assert "owner_account_id" in sql
    assert "source_family" in sql
    assert "source_entry_id" in sql
    assert "on conflict (source_family, source_entry_id)" in sql


def test_apply_writes_saved_loop_metadata_without_media_file_operations(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    loop_path = data_dir / "loops" / "parent-loop.mp3"
    child_path = data_dir / "loops" / "child-loop.mp3"
    source_path = tmp_path / "Music" / "Artist" / "Album" / "Song.flac"
    _write_json(
        data_dir / "loops" / "loops.json",
        {
            "loops": [
                {
                    "id": "parent-loop",
                    "name": "Parent Loop",
                    "path": str(loop_path),
                    "source_path": str(source_path),
                    "start_seconds": 12.5,
                    "end_seconds": 18.25,
                    "duration_seconds": 5.75,
                    "artist": "Artist",
                    "title": "Song",
                    "album": "Album",
                    "cover_path": str(data_dir / "covers" / "cover.jpg"),
                    "created_at": "2026-07-01T10:11:12+00:00",
                },
                {
                    "id": "child-loop",
                    "name": "Child Loop",
                    "path": str(child_path),
                    "source_path": str(source_path),
                    "start_seconds": "20.000",
                    "end_seconds": "21.500",
                    "parent_loop_id": "parent-loop",
                    "source_file": "Song.flac",
                    "source_key": "artist|album|song",
                    "source_index": 7,
                    "source_payload": {"extra": "kept"},
                },
            ]
        },
    )
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    saved_loop_operations = [
        operation for operation in target.operations
        if "insert into app.saved_loops" in str(operation["sql"]).lower()
    ]
    parent_link_operations = [
        operation for operation in target.operations
        if "update app.saved_loops as child_loop" in str(operation["sql"]).lower()
    ]
    assert len(saved_loop_operations) == 2
    assert len(parent_link_operations) == 1
    sql = str(saved_loop_operations[0]["sql"]).lower()
    assert "bootstrap_context" in sql
    assert "parent_loop_match" in sql
    assert "app.saved_loops.loop_key = input_row.parent_loop_key" in sql
    assert "bootstrap_context.account_id = app.saved_loops.account_id" in sql
    assert "on conflict (account_id, library_id, loop_key)" in sql
    assert "where account_id is not null" in sql
    assert "loop_previews" not in sql
    assert "delete" not in sql
    assert "copy" not in sql

    parent_params = saved_loop_operations[0]["params"]
    child_params = saved_loop_operations[1]["params"]
    parent_link_params = parent_link_operations[0]["params"]
    parent_link_sql = str(parent_link_operations[0]["sql"])
    assert parent_params[:7] == [
        "parent-loop",
        str(source_path),
        str(loop_path),
        12.5,
        18.25,
        "2026-07-01T10:11:12+00:00",
        "",
    ]
    assert child_params[:7] == [
        "child-loop",
        str(source_path),
        str(child_path),
        20.0,
        21.5,
        "1970-01-01T00:00:00+00:00",
        "parent-loop",
    ]
    assert parent_link_params == ["child-loop", "parent-loop"]
    assert "parent_loop_resolution" in parent_link_sql
    assert "bootstrap_context.account_id = parent_loop.account_id" in parent_link_sql
    assert "child_loop.account_id = bootstrap_context.account_id" in parent_link_sql
    parent_metadata = parent_params[7]
    child_metadata = child_params[7]
    assert parent_metadata["name"] == "Parent Loop"
    assert parent_metadata["duration_seconds"] == 5.75
    assert parent_metadata["artist"] == "Artist"
    assert parent_metadata["title"] == "Song"
    assert parent_metadata["album"] == "Album"
    assert parent_metadata["cover_path"] == str(data_dir / "covers" / "cover.jpg")
    assert parent_metadata["loop_media_storage"] == "filesystem-backed"
    assert parent_metadata["pitch_preview_storage"] == "filesystem-backed"
    assert parent_metadata["source_payload"]["path"] == str(loop_path)
    assert child_metadata["source_file"] == "Song.flac"
    assert child_metadata["source_key"] == "artist|album|song"
    assert child_metadata["source_index"] == 7
    assert child_metadata["source_payload"]["source_payload"] == {"extra": "kept"}

    saved_loop_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "saved_loops"
    )
    assert saved_loop_summary["source_path"] == str(data_dir / "loops" / "loops.json")
    assert saved_loop_summary["source_count"] == 2
    assert saved_loop_summary["target_count"] == 2
    assert saved_loop_summary["skipped_count"] == 0


def test_saved_loops_resolve_parent_links_after_all_loop_upserts(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    _write_json(
        data_dir / "loops" / "loops.json",
        {
            "loops": [
                {
                    "id": "child-loop",
                    "start_seconds": 20,
                    "end_seconds": 25,
                    "parent_loop_id": "parent-loop",
                },
                {
                    "id": "parent-loop",
                    "start_seconds": 10,
                    "end_seconds": 15,
                },
            ]
        },
    )
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    saved_loop_operations = [
        operation for operation in target.operations
        if "insert into app.saved_loops" in str(operation["sql"]).lower()
    ]
    parent_link_operations = [
        operation for operation in target.operations
        if "update app.saved_loops as child_loop" in str(operation["sql"]).lower()
    ]
    saved_loop_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "saved_loops"
    )
    assert [operation["params"][0] for operation in saved_loop_operations] == [
        "child-loop",
        "parent-loop",
    ]
    assert [operation["params"] for operation in parent_link_operations] == [
        ["child-loop", "parent-loop"]
    ]
    assert "track_id" in saved_loop_operations[0]["sql"].lower()
    assert "source_track_match" in saved_loop_operations[0]["sql"].lower()
    assert "metadata_track_match" in saved_loop_operations[0]["sql"].lower()
    assert (
        "track_id = coalesce(excluded.track_id, app.saved_loops.track_id)"
        in saved_loop_operations[0]["sql"].lower()
    )
    assert (
        "track_id = coalesce(child_loop.track_id, (select track_id from parent_loop_match))"
        in parent_link_operations[-1]["sql"].lower()
    )
    assert saved_loop_summary["target_count"] == 2


def test_saved_loops_live_saved_index_is_backfilled_with_parent_link(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    parent_loop_path = data_dir / "loops" / "parent.mp3"
    child_loop_path = data_dir / "loops" / "child.mp3"
    source_path = data_dir / "Music" / "Artist" / "Album" / "source.flac"
    _write_json(
        data_dir / "loops" / "loops.json",
        {
            "loops": [
                {
                    "id": "parent-loop",
                    "path": str(parent_loop_path),
                "source_path": str(source_path),
                "start_seconds": 1.25,
                "end_seconds": 9.75,
                "created_at": "2026-07-01T11:00:00+00:00",
                "name": "Parent loop",
            },
            {
                "id": "child-loop",
                "path": str(child_loop_path),
                "source_path": str(parent_loop_path),
                "start_seconds": 2.0,
                "end_seconds": 5.5,
                "created_at": "2026-07-01T11:05:00+00:00",
                    "parent_loop_id": "parent-loop",
                    "name": "Child loop",
                },
            ]
        },
    )
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    saved_loop_operations = [
        operation for operation in target.operations
        if "insert into app.saved_loops" in str(operation["sql"]).lower()
    ]
    parent_link_operations = [
        operation for operation in target.operations
        if "update app.saved_loops as child_loop" in str(operation["sql"]).lower()
    ]
    assert [operation["params"][0] for operation in saved_loop_operations] == [
        "parent-loop",
        "child-loop",
    ]
    assert saved_loop_operations[0]["params"][1:5] == [
        str(source_path),
        str(parent_loop_path),
        1.25,
        9.75,
    ]
    assert saved_loop_operations[1]["params"][1:7] == [
        str(parent_loop_path),
        str(child_loop_path),
        2.0,
        5.5,
        "2026-07-01T11:05:00+00:00",
        "parent-loop",
    ]
    assert saved_loop_operations[1]["params"][7]["loop_media_storage"] == "filesystem-backed"
    assert saved_loop_operations[1]["params"][7]["pitch_preview_storage"] == "filesystem-backed"
    assert parent_link_operations[-1]["params"] == ["child-loop", "parent-loop"]
    assert "track_id" in saved_loop_operations[0]["sql"].lower()
    assert "source_track_match" in saved_loop_operations[0]["sql"].lower()
    assert "metadata_track_match" in saved_loop_operations[0]["sql"].lower()
    assert (
        "track_id = coalesce(child_loop.track_id, (select track_id from parent_loop_match))"
        in parent_link_operations[-1]["sql"].lower()
    )
    saved_loop_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "saved_loops"
    )
    assert saved_loop_summary["source_count"] == 2
    assert saved_loop_summary["target_count"] == 2


@pytest.mark.parametrize(
    "payload",
    [
        None,
        {"loops": "not-a-list"},
        {"wrong": []},
    ],
)
def test_saved_loops_missing_malformed_or_wrong_shaped_sources_default_to_empty(
    tmp_path: Path,
    payload: object,
):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    if payload is None:
        pass
    elif isinstance(payload, list):
        _write_json(data_dir / "loops" / "loops.json", payload)
    else:
        _write_json(data_dir / "loops" / "loops.json", payload)

    report = module.run_migration(data_dir=data_dir, mode="dry-run")

    saved_loop_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "saved_loops"
    )
    assert saved_loop_summary["source_count"] == 0
    assert saved_loop_summary["target_count"] == 0
    assert saved_loop_summary["skipped_count"] == 0
    assert saved_loop_summary["warning_count"] == 0
    assert saved_loop_summary["error_count"] == 0
    assert not any(
        failure.get("source_family") == "saved_loops"
        for failure in report["failures"]
    )


def test_saved_loops_skip_idless_non_dict_and_invalid_time_rows_with_honest_counts(
    tmp_path: Path,
):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    _write_json(
        data_dir / "loops" / "loops.json",
        {
            "loops": [
                "not-a-dict",
                {"name": "Missing id", "start_seconds": 0, "end_seconds": 1},
                {"id": "bad-start", "start_seconds": "x", "end_seconds": 2},
                {"id": "bad-order", "start_seconds": 3, "end_seconds": 3},
                {"id": "valid-loop", "start_seconds": 3, "end_seconds": 4},
            ]
        },
    )
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    saved_loop_operations = [
        operation for operation in target.operations
        if "insert into app.saved_loops" in str(operation["sql"]).lower()
    ]
    saved_loop_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "saved_loops"
    )
    assert [operation["params"][0] for operation in saved_loop_operations] == ["valid-loop"]
    assert saved_loop_summary["source_count"] == 5
    assert saved_loop_summary["target_count"] == 1
    assert saved_loop_summary["skipped_count"] == 4
    assert saved_loop_summary["warning_count"] == 2
    assert report["error_count"] == 0


def test_saved_loops_do_not_migrate_pitch_preview_sources_or_write_media_paths(
    tmp_path: Path,
):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    _write_json(
        data_dir / "loops" / "loops.json",
        {
            "loops": [
                {
                    "id": "loop-one",
                    "path": str(data_dir / "loops" / "loop-one.mp3"),
                    "source_path": str(tmp_path / "source.flac"),
                    "start_seconds": 1,
                    "end_seconds": 2,
                }
            ]
        },
    )
    _write_json(
        data_dir / "loop_previews" / "loop_previews.json",
        {"previews": [{"id": "loop-one_plus1", "path": "preview.mp3"}]},
    )
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    source_families = {summary["source_family"] for summary in report["summaries"]}
    assert "saved_loops" in source_families
    assert "loop_previews" not in source_families
    sql_text = "\n".join(str(operation["sql"]).lower() for operation in target.operations)
    assert "loop_previews" not in sql_text
    assert "insert into app.saved_loops" in sql_text
    saved_loop_operation = next(
        operation for operation in target.operations
        if "insert into app.saved_loops" in str(operation["sql"]).lower()
    )
    assert saved_loop_operation["params"][1] == str(tmp_path / "source.flac")
    assert saved_loop_operation["params"][2] == str(data_dir / "loops" / "loop-one.mp3")
    assert saved_loop_operation["params"][7]["loop_media_storage"] == "filesystem-backed"


@pytest.mark.parametrize(
    ("evidence", "expected_state"),
    [
        (
            [
                {
                    "mbid": "11111111-1111-1111-1111-111111111111",
                    "confidence": 0.98,
                    "source": "lastfm.public.artists",
                }
            ],
            "asserted",
        ),
        ([], "missing"),
        (
            [
                {
                    "mbid": "11111111-1111-1111-1111-111111111111",
                    "confidence": 0.97,
                    "source": "lastfm.public.artists",
                },
                {
                    "mbid": "11111111-1111-1111-1111-111111111111",
                    "confidence": 0.96,
                    "source": "lastfm.public.tracks.artist_mbid",
                },
            ],
            "asserted",
        ),
        (
            [
                {
                    "mbid": "11111111-1111-1111-1111-111111111111",
                    "confidence": 0.97,
                    "source": "lastfm.public.artists",
                },
                {
                    "mbid": "22222222-2222-2222-2222-222222222222",
                    "confidence": 0.96,
                    "source": "lastfm.public.tracks.artist_mbid",
                },
            ],
            "conflicting",
        ),
        (
            [
                {
                    "mbid": "11111111-1111-1111-1111-111111111111",
                    "confidence": 0.42,
                    "source": "lastfm.public.artists",
                }
            ],
            "low_confidence",
        ),
    ],
)
def test_classify_artist_mbid_evidence_states(evidence: list[dict[str, object]], expected_state: str):
    module = _load_script_module()

    classification = module.classify_artist_mbid_evidence("Artist One", evidence)

    assert classification["mbid_assertion_state"] == expected_state
    assert "explanation" in classification
    assert classification["source_payload"]["evidence"] == evidence


def test_classify_artist_mbid_evidence_normalizes_order_for_idempotent_payloads():
    module = _load_script_module()
    artist_evidence = {
        "mbid": "11111111-1111-1111-1111-111111111111",
        "confidence": 0.98,
        "source": "lastfm.public.artists",
        "payload": {"artist_name": "Artist One", "provider_row": "(0,1)"},
    }
    album_evidence = {
        "mbid": "11111111111111111111111111111111",
        "confidence": 0.94,
        "source": "lastfm.public.albums",
        "payload": {
            "artist_name": "Artist One",
            "album_title": "Album One",
            "provider_row": "(0,2)",
        },
    }

    first = module.classify_artist_mbid_evidence(
        "Artist One",
        [album_evidence, artist_evidence, dict(album_evidence)],
    )
    second = module.classify_artist_mbid_evidence(
        "Artist One",
        [dict(artist_evidence), dict(album_evidence)],
    )

    assert first == second
    assert first["source_payload"]["evidence"] == [
        artist_evidence,
        {
            **album_evidence,
            "mbid": "11111111-1111-1111-1111-111111111111",
        },
    ]


def test_classify_artist_mbid_evidence_does_not_write_invalid_mbid():
    module = _load_script_module()
    evidence = [{"mbid": "not-a-uuid", "confidence": 0.98, "source": "lastfm.public.artists"}]

    classification = module.classify_artist_mbid_evidence("Artist One", evidence)

    assert classification["mbid"] is None
    assert classification["mbid_assertion_state"] == "missing"
    assert classification["source_payload"]["evidence"] == evidence


def test_classify_artist_mbid_evidence_ignores_invalid_competing_mbid():
    module = _load_script_module()
    evidence = [
        {
            "mbid": "11111111-1111-1111-1111-111111111111",
            "confidence": 0.97,
            "source": "lastfm.public.artists",
        },
        {"mbid": "not-a-uuid", "confidence": 0.99, "source": "lastfm.public.albums"},
    ]

    classification = module.classify_artist_mbid_evidence("Artist One", evidence)

    assert classification["mbid"] == "11111111-1111-1111-1111-111111111111"
    assert classification["mbid_assertion_state"] == "asserted"
    assert classification["source_payload"]["evidence"] == evidence


def test_classify_album_mbid_evidence_requires_exact_local_artist_and_title():
    module = _load_script_module()
    evidence = [
        {
            "mbid": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            "confidence": 0.96,
            "source": "lastfm.public.albums",
            "payload": {"artist_name": "Artist One", "album_title": "Album One"},
        },
        {
            "mbid": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            "confidence": 0.99,
            "source": "lastfm.public.albums",
            "payload": {"artist_name": "Artist One", "album_title": "Different Album"},
        },
    ]

    exact = module.classify_album_mbid_evidence("Artist One", "Album One", evidence)
    mismatch = module.classify_album_mbid_evidence("Artist One", "Missing Album", evidence)

    assert exact["mbid"] == "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    assert exact["mbid_assertion_state"] == "asserted"
    assert exact["evidence_source"] == "lastfm.public.albums"
    assert mismatch["mbid"] is None
    assert mismatch["mbid_assertion_state"] == "missing"


def test_classify_track_mbid_evidence_requires_exact_local_artist_and_title():
    module = _load_script_module()
    evidence = [
        {
            "mbid": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            "confidence": 0.96,
            "source": "lastfm.public.tracks.mbid",
            "payload": {"artist_name": "Artist One", "track_title": "Song One"},
        },
        {
            "mbid": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
            "confidence": 0.99,
            "source": "lastfm.public.tracks.mbid",
            "payload": {"artist_name": "Different Artist", "track_title": "Song One"},
        },
    ]

    exact = module.classify_track_mbid_evidence("Artist One", "Song One", evidence)
    mismatch = module.classify_track_mbid_evidence("Artist Two", "Song One", evidence)

    assert exact["mbid"] == "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    assert exact["mbid_assertion_state"] == "asserted"
    assert exact["evidence_source"] == "lastfm.public.tracks.mbid"
    assert mismatch["mbid"] is None
    assert mismatch["mbid_assertion_state"] == "missing"


@pytest.mark.parametrize(
    ("classifier_name", "args", "evidence", "expected_state"),
    [
        (
            "classify_album_mbid_evidence",
            ("Artist One", "Album One"),
            [
                {
                    "mbid": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    "confidence": 0.4,
                    "source": "lastfm.public.albums",
                    "payload": {"artist_name": "Artist One", "album_title": "Album One"},
                }
            ],
            "low_confidence",
        ),
        (
            "classify_track_mbid_evidence",
            ("Artist One", "Song One"),
            [
                {
                    "mbid": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    "confidence": 0.97,
                    "source": "lastfm.public.tracks.mbid",
                    "payload": {"artist_name": "Artist One", "track_title": "Song One"},
                },
                {
                    "mbid": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                    "confidence": 0.96,
                    "source": "lastfm.public.tracks.mbid",
                    "payload": {"artist_name": "Artist One", "track_title": "Song One"},
                },
            ],
            "conflicting",
        ),
        (
            "classify_album_mbid_evidence",
            ("Artist One", "Album One"),
            [
                {
                    "mbid": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    "confidence": 0.97,
                    "source": "lastfm.public.albums",
                    "payload": {
                        "artist_name": "Artist One",
                        "album_title": "Album One",
                        "provider_row": "(0,1)",
                    },
                },
                {
                    "mbid": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    "confidence": 0.96,
                    "source": "lastfm.public.albums",
                    "payload": {
                        "artist_name": "Artist One",
                        "album_title": "Album One",
                        "provider_row": "(0,2)",
                    },
                },
            ],
            "ambiguous",
        ),
        (
            "classify_track_mbid_evidence",
            ("Artist One", "Song One"),
            [
                {
                    "mbid": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                    "confidence": 0.97,
                    "source": "lastfm.public.tracks.mbid",
                    "payload": {
                        "artist_name": "Artist One",
                        "track_title": "Song One",
                        "provider_row": "(0,1)",
                    },
                },
                {
                    "mbid": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                    "confidence": 0.96,
                    "source": "lastfm.public.tracks.mbid",
                    "payload": {
                        "artist_name": "Artist One",
                        "track_title": "Song One",
                        "provider_row": "(0,2)",
                    },
                },
            ],
            "ambiguous",
        ),
    ],
)
def test_album_and_track_non_asserted_evidence_does_not_choose_mbid(
    classifier_name: str,
    args: tuple[str, str],
    evidence: list[dict[str, object]],
    expected_state: str,
):
    module = _load_script_module()
    classifier = getattr(module, classifier_name)

    classification = classifier(*args, evidence)

    assert classification["mbid"] is None
    assert classification["mbid_assertion_state"] == expected_state
    assert classification["evidence_source"] is not None
    assert classification["confidence"] is not None


def test_local_artist_mbid_assertion_insert_is_idempotent_without_constraint():
    module = _load_script_module()

    sql = module._insert_local_artist_mbid_assertion_sql().lower()

    assert "not exists" in sql
    assert "mbid is not distinct from" in sql
    assert "evidence_source" in sql
    assert "mbid_assertion_state" in sql
    assert "source_payload" in sql
    assert "returning 1" in sql


def test_apply_writes_artist_mbid_assertion_rows_with_source_attribution(tmp_path: Path):
    module = _load_script_module()
    data_dir = _data_dir_with_library_cache(tmp_path)
    target = RecordingTarget()
    evidence = {
        "artist one": [
            {
                "mbid": "11111111-1111-1111-1111-111111111111",
                "confidence": 0.98,
                "source": "lastfm.public.artists",
                "payload": {"artist": "Artist One", "provider_row": 7},
            }
        ]
    }

    module.run_migration(
        data_dir=data_dir,
        mode="apply",
        target=target,
        artist_mbid_evidence=evidence,
    )

    assertion_operation = next(
        operation for operation in target.operations
        if "library.local_artist_mbid_assertions" in str(operation["sql"])
    )
    assert assertion_operation["params"][0] == "artist one"
    assert assertion_operation["params"][1] == "lastfm.public.artists"
    assert assertion_operation["params"][2] == "11111111-1111-1111-1111-111111111111"
    assert assertion_operation["params"][3] == "asserted"
    assert assertion_operation["params"][4] == 0.98
    assert assertion_operation["params"][5]
    assert assertion_operation["params"][6]["evidence"][0]["payload"]["provider_row"] == 7


def test_local_inventory_rows_apply_album_and_track_inline_mbid_assertions(tmp_path: Path):
    module = _load_script_module()
    data_dir = _data_dir_with_library_cache(tmp_path)
    _file_cache, _last_scan, _relation_views, _relations_last_built, error = (
        module.load_cache_snapshot_from_disk(data_dir / "library_cache.json", data_dir)
    )
    assert error is None

    rows = module._local_inventory_rows_from_file_cache(
        _file_cache,
        album_mbid_evidence={
            ("artist one", "album one"): [
                {
                    "mbid": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    "confidence": 0.96,
                    "source": "lastfm.public.albums",
                    "payload": {"artist_name": "Artist One", "album_title": "Album One"},
                }
            ]
        },
        track_mbid_evidence={
            ("artist one", "song one"): [
                {
                    "mbid": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                    "confidence": 0.97,
                    "source": "lastfm.public.tracks.mbid",
                    "payload": {"artist_name": "Artist One", "track_title": "Song One"},
                }
            ]
        },
    )

    assert rows["albums"][0]["mbid"] == "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
    assert rows["albums"][0]["mbid_assertion_state"] == "asserted"
    assert rows["albums"][0]["evidence_source"] == "lastfm.public.albums"
    assert rows["albums"][0]["evidence_confidence"] == 0.96
    assert rows["tracks"][0]["mbid"] == "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
    assert rows["tracks"][0]["mbid_assertion_state"] == "asserted"
    assert rows["tracks"][0]["evidence_source"] == "lastfm.public.tracks.mbid"
    assert rows["tracks"][0]["evidence_confidence"] == 0.97


def test_local_inventory_rows_preserve_non_asserted_album_and_track_review_evidence(tmp_path: Path):
    module = _load_script_module()
    data_dir = _data_dir_with_library_cache(tmp_path)
    _file_cache, _last_scan, _relation_views, _relations_last_built, error = (
        module.load_cache_snapshot_from_disk(data_dir / "library_cache.json", data_dir)
    )
    assert error is None

    rows = module._local_inventory_rows_from_file_cache(
        _file_cache,
        album_mbid_evidence={
            ("artist one", "album one"): [
                {
                    "mbid": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    "confidence": 0.96,
                    "source": "lastfm.public.albums",
                    "payload": {"artist_name": "Artist One", "album_title": "Album One"},
                },
                {
                    "mbid": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                    "confidence": 0.95,
                    "source": "lastfm.public.albums",
                    "payload": {"artist_name": "Artist One", "album_title": "Album One"},
                },
            ]
        },
        track_mbid_evidence={
            ("artist one", "song one"): [
                {
                    "mbid": "cccccccc-cccc-cccc-cccc-cccccccccccc",
                    "confidence": 0.4,
                    "source": "lastfm.public.tracks.mbid",
                    "payload": {"artist_name": "Artist One", "track_title": "Song One"},
                }
            ]
        },
    )

    review_rows = rows["local_mbid_assertions"]
    assert [row["target_kind"] for row in review_rows] == ["album", "track"]
    assert {row["mbid_assertion_state"] for row in review_rows} == {
        "conflicting",
        "low_confidence",
    }
    assert all(row["mbid"] is None for row in review_rows)
    assert review_rows[0]["album_key"] == rows["albums"][0]["album_key"]
    assert review_rows[1]["track_key"] == rows["tracks"][0]["track_key"]
    assert review_rows[0]["source_payload"]["evidence"]
    assert review_rows[1]["source_payload"]["evidence"]


def test_local_inventory_rows_preserve_missing_only_when_evidence_context_exists(tmp_path: Path):
    module = _load_script_module()
    data_dir = _data_dir_with_library_cache(tmp_path)
    _file_cache, _last_scan, _relation_views, _relations_last_built, error = (
        module.load_cache_snapshot_from_disk(data_dir / "library_cache.json", data_dir)
    )
    assert error is None

    without_evidence_context = module._local_inventory_rows_from_file_cache(_file_cache)
    with_mismatched_album_context = module._local_inventory_rows_from_file_cache(
        _file_cache,
        album_mbid_evidence={
            ("artist one", "different album"): [
                {
                    "mbid": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    "confidence": 0.96,
                    "source": "lastfm.public.albums",
                    "payload": {
                        "artist_name": "Artist One",
                        "album_title": "Different Album",
                    },
                }
            ]
        },
    )
    with_empty_album_context = module._local_inventory_rows_from_file_cache(
        _file_cache,
        album_mbid_evidence={("artist one", "album one"): []},
    )

    assert without_evidence_context["local_mbid_assertions"] == []
    assert with_empty_album_context["local_mbid_assertions"] == []
    review_rows = with_mismatched_album_context["local_mbid_assertions"]
    assert len(review_rows) == 1
    assert review_rows[0]["target_kind"] == "album"
    assert review_rows[0]["mbid_assertion_state"] == "missing"
    assert review_rows[0]["mbid"] is None


def test_local_inventory_summary_reports_review_assertion_counts(tmp_path: Path):
    module = _load_script_module()
    data_dir = _data_dir_with_library_cache(tmp_path)

    report = module.run_migration(
        data_dir=data_dir,
        mode="dry-run",
        artist_mbid_evidence={},
        album_mbid_evidence={
            ("artist one", "album one"): [
                {
                    "mbid": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    "confidence": 0.4,
                    "source": "lastfm.public.albums",
                    "payload": {"artist_name": "Artist One", "album_title": "Album One"},
                }
            ]
        },
        track_mbid_evidence={
            ("artist one", "song one"): [
                {
                    "mbid": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                    "confidence": 0.4,
                    "source": "lastfm.public.tracks.mbid",
                    "payload": {"artist_name": "Artist One", "track_title": "Song One"},
                }
            ]
        },
    )

    inventory_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "local_library_inventory"
    )
    assert inventory_summary["album_mbid_review_assertion_count"] == 1
    assert inventory_summary["track_mbid_review_assertion_count"] == 1
    assert inventory_summary["local_mbid_review_assertion_count"] == 2


def test_apply_writes_album_and_track_local_mbid_assertion_review_rows(tmp_path: Path):
    module = _load_script_module()
    data_dir = _data_dir_with_library_cache(tmp_path)
    target = RecordingTarget()

    report = module.run_migration(
        data_dir=data_dir,
        mode="apply",
        target=target,
        artist_mbid_evidence={},
        album_mbid_evidence={
            ("artist one", "album one"): [
                {
                    "mbid": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    "confidence": 0.4,
                    "source": "lastfm.public.albums",
                    "payload": {"artist_name": "Artist One", "album_title": "Album One"},
                }
            ]
        },
        track_mbid_evidence={
            ("artist one", "song one"): [
                {
                    "mbid": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                    "confidence": 0.97,
                    "source": "lastfm.public.tracks.mbid",
                    "payload": {"artist_name": "Artist One", "track_title": "Song One"},
                },
                {
                    "mbid": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                    "confidence": 0.96,
                    "source": "lastfm.public.tracks.mbid",
                    "payload": {
                        "artist_name": "Artist One",
                        "track_title": "Song One",
                        "provider_row": "(0,2)",
                    },
                },
            ]
        },
    )

    assertion_operations = [
        operation for operation in target.operations
        if "library.local_mbid_assertions" in str(operation["sql"])
    ]
    assert len(assertion_operations) == 2
    assert "insert into library.local_mbid_assertions" in str(assertion_operations[0]["sql"]).lower()
    assert assertion_operations[0]["params"][0] == "album"
    assert assertion_operations[0]["params"][1] == assertion_operations[0]["params"][3]
    assert assertion_operations[0]["params"][2] == "artist one"
    assert assertion_operations[0]["params"][4] is None
    assert assertion_operations[0]["params"][5:9] == [
        "lastfm.public.albums",
        None,
        "low_confidence",
        0.4,
    ]
    assert assertion_operations[0]["params"][-1] == 1
    assert assertion_operations[1]["params"][0] == "track"
    assert assertion_operations[1]["params"][2] == "artist one"
    assert assertion_operations[1]["params"][3] == assertion_operations[0]["params"][3]
    assert assertion_operations[1]["params"][4]
    assert assertion_operations[1]["params"][7] == "ambiguous"
    inventory_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "local_library_inventory"
    )
    assert inventory_summary["local_mbid_review_assertion_count"] == 2


def test_local_mbid_assertion_insert_is_idempotent_for_review_rows():
    module = _load_script_module()

    sql = module._insert_local_mbid_assertion_sql().lower()

    assert "not exists" in sql
    assert "library.local_mbid_assertions" in sql
    assert "target_kind" in sql
    assert "evidence_source" in sql
    assert "mbid is not distinct from" in sql
    assert "mbid_assertion_state" in sql
    assert "source_payload" in sql
    assert "migration_run_id" in sql
    assert "returning 1" in sql


def test_apply_writes_album_and_track_mbid_columns_with_source_attribution(tmp_path: Path):
    module = _load_script_module()
    data_dir = _data_dir_with_library_cache(tmp_path)
    target = RecordingTarget()

    module.run_migration(
        data_dir=data_dir,
        mode="apply",
        target=target,
        artist_mbid_evidence={},
        album_mbid_evidence={
            ("artist one", "album one"): [
                {
                    "mbid": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    "confidence": 0.96,
                    "source": "lastfm.public.albums",
                    "payload": {"artist_name": "Artist One", "album_title": "Album One"},
                }
            ]
        },
        track_mbid_evidence={
            ("artist one", "song one"): [
                {
                    "mbid": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                    "confidence": 0.97,
                    "source": "lastfm.public.tracks.mbid",
                    "payload": {"artist_name": "Artist One", "track_title": "Song One"},
                }
            ]
        },
    )

    album_operation = next(
        operation for operation in target.operations
        if "insert into library.local_albums" in str(operation["sql"]).lower()
    )
    track_operation = next(
        operation for operation in target.operations
        if "insert into library.local_tracks" in str(operation["sql"]).lower()
    )
    assert album_operation["params"][5:9] == [
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "asserted",
        "lastfm.public.albums",
        0.96,
    ]
    assert track_operation["params"][7:11] == [
        "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        "asserted",
        "lastfm.public.tracks.mbid",
        0.97,
    ]


def test_apply_writes_projection_mbid_migration_provenance_and_null_scan_ref(tmp_path: Path):
    module = _load_script_module()
    data_dir = _data_dir_with_library_cache(tmp_path)
    target = RecordingTarget()

    module.run_migration(
        data_dir=data_dir,
        mode="apply",
        target=target,
        artist_mbid_evidence={
            "artist one": [
                {
                    "mbid": "11111111-1111-1111-1111-111111111111",
                    "confidence": 0.98,
                    "source": "lastfm.public.artists",
                    "payload": {"artist_name": "Artist One"},
                }
            ]
        },
        album_mbid_evidence={
            ("artist one", "album one"): [
                {
                    "mbid": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    "confidence": 0.96,
                    "source": "lastfm.public.albums",
                    "payload": {"artist_name": "Artist One", "album_title": "Album One"},
                }
            ]
        },
        track_mbid_evidence={
            ("artist one", "song one"): [
                {
                    "mbid": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                    "confidence": 0.97,
                    "source": "lastfm.public.tracks.mbid",
                    "payload": {"artist_name": "Artist One", "track_title": "Song One"},
                }
            ]
        },
    )

    artist_operation = next(
        operation for operation in target.operations
        if "insert into library.local_artists" in str(operation["sql"]).lower()
    )
    album_operation = next(
        operation for operation in target.operations
        if "insert into library.local_albums" in str(operation["sql"]).lower()
    )
    track_operation = next(
        operation for operation in target.operations
        if "insert into library.local_tracks" in str(operation["sql"]).lower()
    )
    assert artist_operation["params"][7:10] == [1, None, {"source": module.MIGRATION_NAME}]
    assert album_operation["params"][9:12] == [1, None, album_operation["params"][11]]
    assert track_operation["params"][11:14] == [1, None, track_operation["params"][13]]

    sql_text = "\n".join(
        str(operation["sql"]).lower()
        for operation in (artist_operation, album_operation, track_operation)
    )
    assert "mbid_assertion_migration_run_id" in sql_text
    assert "mbid_assertion_scan_run_ref" in sql_text


def test_apply_accepts_provider_neutral_injected_mbid_evidence(tmp_path: Path):
    module = _load_script_module()
    data_dir = _data_dir_with_library_cache(tmp_path)
    target = RecordingTarget()

    module.run_migration(
        data_dir=data_dir,
        mode="apply",
        target=target,
        artist_mbid_evidence={},
        album_mbid_evidence={
            ("artist one", "album one"): [
                {
                    "mbid": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    "confidence": 0.96,
                    "source": "musicbrainz.release",
                    "payload": {"artist_name": "Artist One", "album_title": "Album One"},
                }
            ]
        },
        track_mbid_evidence={
            ("artist one", "song one"): [
                {
                    "mbid": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                    "confidence": 0.97,
                    "source": "listenbrainz.recording",
                    "payload": {"artist_name": "Artist One", "track_title": "Song One"},
                }
            ]
        },
    )

    album_operation = next(
        operation for operation in target.operations
        if "insert into library.local_albums" in str(operation["sql"]).lower()
    )
    track_operation = next(
        operation for operation in target.operations
        if "insert into library.local_tracks" in str(operation["sql"]).lower()
    )
    assert album_operation["params"][5:9] == [
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "asserted",
        "musicbrainz.release",
        0.96,
    ]
    assert track_operation["params"][7:11] == [
        "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        "asserted",
        "listenbrainz.recording",
        0.97,
    ]


class FakeLastfmReadonlySource:
    def __init__(
        self,
        rows_by_marker: dict[str, list[dict[str, object]]],
        *,
        columns_by_table: dict[str, set[str]] | None = None,
        fail_markers: set[str] | None = None,
    ) -> None:
        self.rows_by_marker = rows_by_marker
        self.columns_by_table = columns_by_table or {
            "artists": {"name", "mbid"},
            "albums": {"artist", "title", "mbid"},
            "tracks": {"artist", "title", "artist_mbid", "mbid"},
        }
        self.fail_markers = fail_markers or set()
        self.queries: list[str] = []

    def query_json(self, sql: str, params: object | None = None) -> list[dict[str, object]]:
        self.queries.append(sql)
        normalized_sql = " ".join(sql.lower().split())
        if "information_schema.columns" in normalized_sql:
            rows = []
            for table_name, columns in self.columns_by_table.items():
                rows.extend(
                    {"table_name": table_name, "column_name": column_name}
                    for column_name in sorted(columns)
                )
            return rows
        if "from public.artists" in normalized_sql:
            if "artists" in self.fail_markers:
                raise AssertionError("artists evidence source should have been skipped")
            return self.rows_by_marker.get("artists", [])
        if "from public.albums" in normalized_sql:
            if "albums" in self.fail_markers:
                raise AssertionError("albums evidence source should have been skipped")
            return self.rows_by_marker.get("albums", [])
        if "from public.tracks" in normalized_sql and "artist_mbid" in normalized_sql:
            if "track_artists" in self.fail_markers:
                raise AssertionError("track artist evidence source should have been skipped")
            return self.rows_by_marker.get("track_artists", [])
        if "from public.tracks" in normalized_sql and "tracks.mbid" in normalized_sql:
            if "tracks" in self.fail_markers:
                raise AssertionError("track evidence source should have been skipped")
            return self.rows_by_marker.get("tracks", [])
        return []


def test_lastfm_mbid_evidence_sql_reads_confirmed_columns_without_mutations():
    module = _load_script_module()
    source = FakeLastfmReadonlySource(
        {
            "artists": [{"artist_name": "Artist One", "mbid": "11111111-1111-1111-1111-111111111111"}],
            "albums": [{"artist_name": "Artist One", "album_title": "Album One", "mbid": "11111111-1111-1111-1111-111111111111"}],
            "track_artists": [{"artist_name": "Artist One", "track_title": "Song One", "mbid": "11111111-1111-1111-1111-111111111111"}],
            "tracks": [{"artist_name": "Artist One", "track_title": "Song One", "mbid": "22222222-2222-2222-2222-222222222222"}],
        }
    )

    evidence, summary = module.collect_lastfm_mbid_evidence_for_artists(
        ["Artist One"],
        source=source,
    )

    sql_text = "\n".join(source.queries).lower()
    assert "public.artists" in sql_text
    assert "artists.mbid" in sql_text
    assert "public.albums" in sql_text
    assert "albums.mbid" in sql_text
    assert "public.tracks" in sql_text
    assert "tracks.artist_mbid" in sql_text
    assert "tracks.mbid" in sql_text
    assert not DESTRUCTIVE_SQL.search(sql_text)
    assert set(evidence) == {"artist one"}
    assert summary["source_family"] == "lastfm_mbid_evidence"
    assert summary["artist_mbid_count"] == 1
    assert summary["album_mbid_count"] == 1
    assert summary["track_artist_mbid_count"] == 1
    assert summary["track_mbid_count"] == 1


def test_track_mbid_evidence_is_not_used_as_artist_mbid_evidence():
    module = _load_script_module()
    source = FakeLastfmReadonlySource(
        {
            "tracks": [
                {
                    "artist_name": "Artist One",
                    "track_title": "Song One",
                    "mbid": "22222222-2222-2222-2222-222222222222",
                }
            ],
        },
        columns_by_table={
            "artists": {"name", "mbid"},
            "albums": set(),
            "tracks": {"artist", "title", "mbid"},
        },
    )

    evidence, summary = module.collect_lastfm_mbid_evidence_for_artists(
        ["Artist One"],
        source=source,
    )

    assert "artist one" not in evidence
    assert summary["track_mbid_count"] == 1


def test_lastfm_mbid_evidence_skips_sources_with_missing_text_columns():
    module = _load_script_module()
    source = FakeLastfmReadonlySource(
        {
            "artists": [{"artist_name": "Artist One", "mbid": "11111111-1111-1111-1111-111111111111"}],
            "albums": [{"artist_name": "Artist One", "album_title": "Album One", "mbid": "22222222-2222-2222-2222-222222222222"}],
            "tracks": [{"artist_name": "Artist One", "track_title": "Song One", "mbid": "33333333-3333-3333-3333-333333333333"}],
        },
        columns_by_table={
            "artists": {"name", "mbid"},
            "albums": {"mbid"},
            "tracks": {"artist", "title", "artist_mbid", "mbid"},
        },
        fail_markers={"albums"},
    )

    evidence, summary = module.collect_lastfm_mbid_evidence_for_artists(
        ["Artist One"],
        source=source,
    )

    sql_text = "\n".join(source.queries).lower()
    assert "information_schema.columns" in sql_text
    assert "from public.albums" not in sql_text
    assert summary["source_count"] == 2
    assert summary["album_mbid_count"] == 0
    assert summary["warning_count"] == 1
    assert "lastfm.public.albums" in summary["message"]
    assert "artist" in summary["message"]
    assert "title" in summary["message"]
    assert {item["source"] for item in evidence["artist one"]} == {
        "lastfm.public.artists",
    }


def test_run_migration_uses_injected_lastfm_source_for_artist_assertions(tmp_path: Path):
    module = _load_script_module()
    data_dir = _data_dir_with_library_cache(tmp_path)
    target = RecordingTarget()
    source = FakeLastfmReadonlySource(
        {
            "artists": [
                {
                    "artist_name": "Artist One",
                    "mbid": "11111111-1111-1111-1111-111111111111",
                    "provider_row": 7,
                }
            ],
            "albums": [
                {
                    "artist_name": "Artist One",
                    "album_title": "Album One",
                    "mbid": "11111111-1111-1111-1111-111111111111",
                    "provider_row": 8,
                }
            ],
        }
    )

    report = module.run_migration(
        data_dir=data_dir,
        mode="apply",
        target=target,
        lastfm_readonly_source=source,
    )

    lastfm_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "lastfm_mbid_evidence"
    )
    assert lastfm_summary["source_count"] == 2
    assertion_operation = next(
        operation for operation in target.operations
        if "library.local_artist_mbid_assertions" in str(operation["sql"])
    )
    assert assertion_operation["params"][1] == "lastfm.public.artists"
    assert assertion_operation["params"][2] == "11111111-1111-1111-1111-111111111111"
    assert assertion_operation["params"][3] == "asserted"
    assert assertion_operation["params"][6]["evidence"][0]["source"] == "lastfm.public.artists"


def test_non_asserted_artist_mbid_stays_out_of_projection_row(tmp_path: Path):
    module = _load_script_module()
    data_dir = _data_dir_with_library_cache(tmp_path)
    target = RecordingTarget()

    module.run_migration(
        data_dir=data_dir,
        mode="apply",
        target=target,
        artist_mbid_evidence={
            "artist one": [
                {
                    "mbid": "11111111-1111-1111-1111-111111111111",
                    "confidence": 0.4,
                    "source": "lastfm.public.artists",
                    "payload": {"artist_name": "Artist One"},
                }
            ]
        },
    )

    artist_operation = next(
        operation for operation in target.operations
        if "insert into library.local_artists" in str(operation["sql"]).lower()
    )
    assertion_operation = next(
        operation for operation in target.operations
        if "library.local_artist_mbid_assertions" in str(operation["sql"])
    )
    assert artist_operation["params"][3] is None
    assert artist_operation["params"][4] == "low_confidence"
    assert assertion_operation["params"][2] == "11111111-1111-1111-1111-111111111111"
    assert assertion_operation["params"][3] == "low_confidence"


def test_migration_asserts_artist_mbid_when_true_artist_evidence_corroborates(tmp_path: Path):
    module = _load_script_module()
    data_dir = _data_dir_with_library_cache(tmp_path)
    target = RecordingTarget()

    module.run_migration(
        data_dir=data_dir,
        mode="apply",
        target=target,
        artist_mbid_evidence={
            "artist one": [
                {
                    "mbid": "11111111-1111-1111-1111-111111111111",
                    "confidence": 0.98,
                    "source": "lastfm.public.artists",
                    "payload": {"artist_name": "Artist One"},
                },
                {
                    "mbid": "11111111-1111-1111-1111-111111111111",
                    "confidence": 0.93,
                    "source": "lastfm.public.tracks.artist_mbid",
                    "payload": {"artist_name": "Artist One", "track_title": "Song One"},
                },
            ]
        },
    )

    artist_operation = next(
        operation for operation in target.operations
        if "insert into library.local_artists" in str(operation["sql"]).lower()
    )
    assertion_operation = next(
        operation for operation in target.operations
        if "library.local_artist_mbid_assertions" in str(operation["sql"])
    )
    assert artist_operation["params"][3] == "11111111-1111-1111-1111-111111111111"
    assert artist_operation["params"][4] == "asserted"
    assert assertion_operation["params"][2] == "11111111-1111-1111-1111-111111111111"
    assert assertion_operation["params"][3] == "asserted"


def test_migration_keeps_conflicting_high_confidence_artist_mbids_reviewable(tmp_path: Path):
    module = _load_script_module()
    data_dir = _data_dir_with_library_cache(tmp_path)
    target = RecordingTarget()

    module.run_migration(
        data_dir=data_dir,
        mode="apply",
        target=target,
        artist_mbid_evidence={
            "artist one": [
                {
                    "mbid": "11111111-1111-1111-1111-111111111111",
                    "confidence": 0.98,
                    "source": "lastfm.public.artists",
                    "payload": {"artist_name": "Artist One"},
                },
                {
                    "mbid": "22222222-2222-2222-2222-222222222222",
                    "confidence": 0.93,
                    "source": "lastfm.public.tracks.artist_mbid",
                    "payload": {"artist_name": "Artist One", "track_title": "Song One"},
                },
            ]
        },
    )

    artist_operation = next(
        operation for operation in target.operations
        if "insert into library.local_artists" in str(operation["sql"]).lower()
    )
    assertion_operation = next(
        operation for operation in target.operations
        if "library.local_artist_mbid_assertions" in str(operation["sql"])
    )
    assert artist_operation["params"][3] is None
    assert artist_operation["params"][4] == "conflicting"
    assert assertion_operation["params"][2] == "11111111-1111-1111-1111-111111111111"
    assert assertion_operation["params"][3] == "conflicting"


def test_migration_persists_album_and_track_context_without_artist_evidence_key(tmp_path: Path):
    module = _load_script_module()
    data_dir = _data_dir_with_library_cache(tmp_path)
    target = RecordingTarget()

    module.run_migration(
        data_dir=data_dir,
        mode="apply",
        target=target,
        artist_mbid_evidence={},
        album_mbid_evidence={
            ("artist one", "album one"): [
                {
                    "mbid": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    "confidence": 0.99,
                    "source": "musicbrainz.release",
                    "payload": {"artist_name": "Artist One", "album_title": "Album One"},
                }
            ],
        },
        track_mbid_evidence={
            ("artist one", "song one"): [
                {
                    "mbid": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                    "confidence": 0.99,
                    "source": "listenbrainz.recording",
                    "payload": {"artist_name": "Artist One", "track_title": "Song One"},
                },
            ],
        },
    )

    artist_operation = next(
        operation for operation in target.operations
        if "insert into library.local_artists" in str(operation["sql"]).lower()
    )
    assertion_operation = next(
        operation for operation in target.operations
        if "library.local_artist_mbid_assertions" in str(operation["sql"])
    )
    assert artist_operation["params"][3] is None
    assert artist_operation["params"][4] == "missing"
    assert assertion_operation["params"][2] is None
    assert assertion_operation["params"][3] == "missing"
    assert [item["source"] for item in assertion_operation["params"][6]["local_match_evidence"]] == [
        "musicbrainz.release",
        "listenbrainz.recording",
    ]


def test_artist_mbid_assertion_rows_carry_migration_provenance(tmp_path: Path):
    module = _load_script_module()
    data_dir = _data_dir_with_library_cache(tmp_path)
    target = RecordingTarget()

    module.run_migration(
        data_dir=data_dir,
        mode="apply",
        target=target,
        artist_mbid_evidence={
            "artist one": [
                {
                    "mbid": "11111111-1111-1111-1111-111111111111",
                    "confidence": 0.98,
                    "source": "lastfm.public.artists",
                    "payload": {"artist_name": "Artist One"},
                }
            ]
        },
    )

    assertion_operation = next(
        operation for operation in target.operations
        if "library.local_artist_mbid_assertions" in str(operation["sql"])
    )
    assert assertion_operation["params"][-1] == 1
    assert "migration_run_id" in str(assertion_operation["sql"]).lower()


def test_run_migration_applies_lastfm_album_and_track_mbid_evidence_inline(tmp_path: Path):
    module = _load_script_module()
    data_dir = _data_dir_with_library_cache(tmp_path)
    target = RecordingTarget()
    source = FakeLastfmReadonlySource(
        {
            "albums": [
                {
                    "artist_name": "Artist One",
                    "album_title": "Album One",
                    "mbid": "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
                    "provider_row": "(0,8)",
                }
            ],
            "tracks": [
                {
                    "artist_name": "Artist One",
                    "track_title": "Song One",
                    "mbid": "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
                    "provider_row": "(0,9)",
                }
            ],
        }
    )

    report = module.run_migration(
        data_dir=data_dir,
        mode="apply",
        target=target,
        lastfm_readonly_source=source,
    )

    lastfm_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "lastfm_mbid_evidence"
    )
    assert lastfm_summary["album_mbid_count"] == 1
    assert lastfm_summary["track_mbid_count"] == 1

    album_operation = next(
        operation for operation in target.operations
        if "insert into library.local_albums" in str(operation["sql"]).lower()
    )
    track_operation = next(
        operation for operation in target.operations
        if "insert into library.local_tracks" in str(operation["sql"]).lower()
    )
    assert album_operation["params"][5:9] == [
        "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        "asserted",
        "lastfm.public.albums",
        0.94,
    ]
    assert track_operation["params"][7:11] == [
        "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        "asserted",
        "lastfm.public.tracks.mbid",
        0.94,
    ]


def test_missing_lastfm_readonly_url_is_reported_as_skipped_source(tmp_path: Path):
    module = _load_script_module()
    data_dir = _data_dir_with_library_cache(tmp_path)

    report = module.run_migration(
        data_dir=data_dir,
        mode="dry-run",
        lastfm_readonly_url=None,
    )

    lastfm_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "lastfm_mbid_evidence"
    )
    assert lastfm_summary["source_count"] == 0
    assert lastfm_summary["skipped_count"] == 1
    assert lastfm_summary["warning_count"] == 1
    assert report["error_count"] == 0


def test_skip_lastfm_mbid_evidence_suppresses_missing_url_warning(tmp_path: Path):
    module = _load_script_module()
    data_dir = _data_dir_with_library_cache(tmp_path)

    report = module.run_migration(
        data_dir=data_dir,
        mode="dry-run",
        skip_lastfm_mbid_evidence=True,
    )

    lastfm_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "lastfm_mbid_evidence"
    )
    assert lastfm_summary["skipped_count"] == 1
    assert lastfm_summary["warning_count"] == 0


def test_cli_supports_env_and_flag_lastfm_readonly_url(monkeypatch: pytest.MonkeyPatch):
    module = _load_script_module()
    monkeypatch.setenv("ALBUM_HAVEN_LASTFM_READONLY_URL", "postgresql://readonly-env/lastfm")

    parser = module.build_arg_parser()

    env_args = parser.parse_args([])
    explicit_args = parser.parse_args(["--lastfm-readonly-url", "postgresql://readonly-flag/lastfm"])
    skipped_args = parser.parse_args(["--skip-lastfm-mbid-evidence"])

    assert env_args.lastfm_readonly_url == "postgresql://readonly-env/lastfm"
    assert explicit_args.lastfm_readonly_url == "postgresql://readonly-flag/lastfm"
    assert skipped_args.skip_lastfm_mbid_evidence is True


def test_lastfm_readonly_subprocess_source_uses_lastfm_url_not_app_database_url(
    monkeypatch: pytest.MonkeyPatch,
):
    module = _load_script_module()
    calls: list[list[str]] = []

    monkeypatch.setenv("ALBUM_HAVEN_DATABASE_URL", "postgresql://migrator/album_haven_core")

    def fake_run(command: list[str], **kwargs: object):
        calls.append(command)

        class Completed:
            stdout = '[{"ok": true}]\n'

        return Completed()

    monkeypatch.setattr(module.subprocess, "run", fake_run)
    source = module.LastfmReadonlySubprocessSource(
        database_url="postgresql://readonly/lastfm",
        psql_path="psql",
    )

    assert source.query_json("select true as ok;") == [{"ok": True}]

    assert calls
    assert "postgresql://readonly/lastfm" in calls[0]
    assert "postgresql://migrator/album_haven_core" not in calls[0]


def test_lastfm_readonly_subprocess_source_sends_sql_via_stdin(
    monkeypatch: pytest.MonkeyPatch,
):
    module = _load_script_module()
    calls: list[tuple[list[str], dict[str, object]]] = []

    def fake_run(command: list[str], **kwargs: object):
        calls.append((command, kwargs))

        class Completed:
            stdout = '[{"ok": true}]\n'

        return Completed()

    monkeypatch.setattr(module.subprocess, "run", fake_run)
    source = module.LastfmReadonlySubprocessSource(
        database_url="postgresql://readonly/lastfm",
        psql_path="psql",
    )
    long_sql = f"select true as ok where 'artist' in ({', '.join(repr(str(index)) for index in range(2000))})"

    assert source.query_json(long_sql) == [{"ok": True}]

    command, kwargs = calls[0]
    assert "-c" not in command
    assert long_sql in str(kwargs["input"])
    assert kwargs["encoding"] == "utf-8"


def test_lastfm_readonly_subprocess_source_streams_unicode_sql_as_utf8(
    monkeypatch: pytest.MonkeyPatch,
):
    module = _load_script_module()
    calls: list[dict[str, object]] = []

    def fake_run(_command: list[str], **kwargs: object):
        calls.append(kwargs)

        class Completed:
            stdout = '[{"artist_name": "Büyük Ev Ablukada"}]\n'

        return Completed()

    monkeypatch.setattr(module.subprocess, "run", fake_run)
    source = module.LastfmReadonlySubprocessSource(
        database_url="postgresql://readonly/lastfm",
        psql_path="psql",
    )

    assert source.query_json("select 'Büyük Ev Ablukada' as artist_name") == [
        {"artist_name": "Büyük Ev Ablukada"}
    ]
    assert calls[0]["encoding"] == "utf-8"


@pytest.mark.parametrize(
    "sql",
    [
        "insert into public.artists(name) values ('Artist One')",
        "update public.artists set name = 'Artist Two'",
        "delete from public.artists where name = 'Artist One'",
        "create table public.tmp_artist_mbid as select true as ok",
        "select * into public.tmp_artist_mbid from public.artists",
        "select (select count(*) from public.artists) as artist_count into public.tmp_artist_mbid",
    ],
)
def test_lastfm_readonly_subprocess_source_rejects_mutating_sql(
    monkeypatch: pytest.MonkeyPatch,
    sql: str,
):
    module = _load_script_module()

    def fail_run(*_args: object, **_kwargs: object):
        raise AssertionError("mutating Last.fm SQL must be rejected before psql runs")

    monkeypatch.setattr(module.subprocess, "run", fail_run)
    source = module.LastfmReadonlySubprocessSource(
        database_url="postgresql://readonly/lastfm",
        psql_path="psql",
    )

    with pytest.raises(ValueError, match="only accepts SELECT statements"):
        source.query_json(sql)


def test_lastfm_readonly_subprocess_source_allows_into_inside_literal_and_comment(
    monkeypatch: pytest.MonkeyPatch,
):
    module = _load_script_module()
    calls: list[list[str]] = []

    def fake_run(command: list[str], **kwargs: object):
        calls.append(command)

        class Completed:
            stdout = '[{"artist_name": "Into It. Over It."}]\n'

        return Completed()

    monkeypatch.setattr(module.subprocess, "run", fake_run)
    source = module.LastfmReadonlySubprocessSource(
        database_url="postgresql://readonly/lastfm",
        psql_path="psql",
    )

    assert source.query_json(
        """
            select 'Into It. Over It.' as artist_name
            -- into appears here as comment text only
        """
    ) == [{"artist_name": "Into It. Over It."}]

    assert calls


def test_lastfm_readonly_subprocess_source_allows_nested_select_without_into(
    monkeypatch: pytest.MonkeyPatch,
):
    module = _load_script_module()
    calls: list[list[str]] = []

    def fake_run(command: list[str], **kwargs: object):
        calls.append(command)

        class Completed:
            stdout = '[{"artist_count": 3}]\n'

        return Completed()

    monkeypatch.setattr(module.subprocess, "run", fake_run)
    source = module.LastfmReadonlySubprocessSource(
        database_url="postgresql://readonly/lastfm",
        psql_path="psql",
    )

    assert source.query_json(
        "select (select count(*) from public.artists) as artist_count"
    ) == [{"artist_count": 3}]

    assert calls


def test_lastfm_settings_session_and_timezone_are_backfilled(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    _write_json(
        data_dir / "lastfm_settings.json",
        {
            "username": "listener",
            "session_key": "session-secret",
            "connected_at": "2026-07-01T08:00:00+00:00",
            "user_timezone": "America/Denver",
            "extra": {"kept": True},
        },
    )
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    settings_operation = next(
        operation for operation in target.operations
        if "integration.lastfm_settings" in str(operation["sql"])
    )
    session_operation = next(
        operation for operation in target.operations
        if "integration.lastfm_sessions" in str(operation["sql"])
    )
    summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "lastfm_settings"
    )
    assert settings_operation["params"][0:2] == ["listener", "America/Denver"]
    assert "session_key" not in settings_operation["params"][2]["settings_payload"]
    assert session_operation["params"][0:2] == ["listener", "session-secret"]
    assert session_operation["params"][2]["source_payload"]["user_timezone"] == "America/Denver"
    assert "session_key" not in session_operation["params"][2]["source_payload"]
    assert summary["source_count"] == 1
    assert summary["settings_count"] == 1
    assert summary["session_count"] == 1
    assert summary["target_count"] == 2


def test_malformed_lastfm_settings_defaults_to_empty_without_source_error(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    (data_dir / "lastfm_settings.json").write_text("{not-json", encoding="utf-8")
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    settings_operations = [
        operation for operation in target.operations
        if "integration.lastfm_settings" in str(operation["sql"])
    ]
    session_operations = [
        operation for operation in target.operations
        if "integration.lastfm_sessions" in str(operation["sql"])
    ]
    summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "lastfm_settings"
    )
    assert not any(failure.get("source_family") == "lastfm_settings" for failure in report["failures"])
    assert settings_operations == []
    assert session_operations == []
    assert summary["source_count"] == 0
    assert summary["settings_count"] == 0
    assert summary["session_count"] == 0
    assert summary["target_count"] == 0


@pytest.mark.parametrize(
    ("case_name", "settings_payload"),
    [
        ("missing", None),
        ("empty", {}),
        ("non_dict", ["bad"]),
    ],
)
def test_empty_lastfm_settings_sources_do_not_write_target_rows(
    tmp_path: Path,
    case_name: str,
    settings_payload: object,
):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    if case_name != "missing":
        _write_json(data_dir / "lastfm_settings.json", settings_payload)
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    lastfm_operations = [
        operation for operation in target.operations
        if "integration.lastfm_settings" in str(operation["sql"])
        or "integration.lastfm_sessions" in str(operation["sql"])
    ]
    summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "lastfm_settings"
    )
    assert lastfm_operations == []
    assert summary["source_count"] == 0
    assert summary["settings_count"] == 0
    assert summary["session_count"] == 0
    assert summary["target_count"] == 0


def test_lastfm_sync_state_pending_problem_and_retry_summary_are_backfilled(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    _write_json(
        data_dir / "lastfm_sync_state.json",
        {
            "pending_scrobbles": {
                "listen-1": {
                    "retry_count": 2,
                    "last_error": "temporary failure",
                    "track_ref": "artist|album|song",
                    "played_at": "2026-07-01T09:00:00+00:00",
                }
            },
            "sync_problems": {
                "listen-1": {
                    "provider": "lastfm",
                    "kind": "scrobble",
                    "status": "pending_retry",
                    "message": "temporary failure",
                }
            },
            "last_retry_summary": {
                "pending_before": 1,
                "attempted": 1,
                "succeeded": 0,
                "failed": 1,
                "pending_after": 1,
                "recorded_at": "2026-07-01T09:05:00+00:00",
            },
        },
    )
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    pending_operation = next(
        operation for operation in target.operations
        if "integration.pending_scrobbles" in str(operation["sql"])
    )
    retry_operations = [
        operation for operation in target.operations
        if "integration.scrobble_retry_state" in str(operation["sql"])
    ]
    summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "lastfm_sync_state"
    )
    assert pending_operation["params"][0:5] == [
        "artist|album|song",
        "2026-07-01T09:00:00+00:00",
        2,
        None,
        "pending",
    ]
    assert pending_operation["params"][5]["source_key"] == "listen-1"
    assert len(retry_operations) == 2
    assert retry_operations[0]["params"][0:3] == ["lastfm", "pending_retry", 0]
    assert retry_operations[0]["params"][5] == "temporary failure"
    assert retry_operations[0]["params"][6]["source_section"] == "sync_problems"
    assert retry_operations[1]["params"][0:4] == [
        "lastfm",
        "summary",
        1,
        "2026-07-01T09:05:00+00:00",
    ]
    assert retry_operations[1]["params"][6]["source_section"] == "last_retry_summary"
    assert summary["source_count"] == 3
    assert summary["pending_scrobble_count"] == 1
    assert summary["sync_problem_count"] == 1
    assert summary["retry_summary_count"] == 1
    assert summary["target_count"] == 3


def test_wrong_shaped_lastfm_sync_state_sections_default_to_empty(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    _write_json(
        data_dir / "lastfm_sync_state.json",
        {
            "pending_scrobbles": ["bad"],
            "sync_problems": "bad",
            "last_retry_summary": ["bad"],
        },
    )
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    sync_operations = [
        operation for operation in target.operations
        if "integration.pending_scrobbles" in str(operation["sql"])
        or "integration.scrobble_retry_state" in str(operation["sql"])
    ]
    summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "lastfm_sync_state"
    )
    assert sync_operations == []
    assert summary["source_count"] == 0
    assert summary["target_count"] == 0
    assert summary["pending_scrobble_count"] == 0
    assert summary["sync_problem_count"] == 0
    assert summary["retry_summary_count"] == 0


def test_malformed_lastfm_sync_state_items_are_skipped_without_target_writes(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    _write_json(
        data_dir / "lastfm_sync_state.json",
        {
            "pending_scrobbles": {
                "": {"track_ref": "artist|album|blank", "played_at": "2026-07-01T09:00:00+00:00"},
                "pending-non-dict": "bad",
            },
            "sync_problems": {
                "   ": {"message": "blank key"},
                "problem-non-dict": ["bad"],
            },
            "last_retry_summary": {
                "attempted": 1,
                "recorded_at": "2026-07-01T09:05:00+00:00",
            },
        },
    )
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    pending_operations = [
        operation for operation in target.operations
        if "integration.pending_scrobbles" in str(operation["sql"])
    ]
    retry_operations = [
        operation for operation in target.operations
        if "integration.scrobble_retry_state" in str(operation["sql"])
    ]
    summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "lastfm_sync_state"
    )
    assert pending_operations == []
    assert len(retry_operations) == 1
    assert retry_operations[0]["params"][1] == "summary"
    assert retry_operations[0]["params"][6]["source_section"] == "last_retry_summary"
    assert summary["source_count"] == 5
    assert summary["target_count"] == 1
    assert summary["skipped_count"] == 4
    assert summary["warning_count"] == 4
    assert summary["pending_scrobble_count"] == 0
    assert summary["sync_problem_count"] == 0
    assert summary["retry_summary_count"] == 1


def test_lastfm_live_settings_sync_and_listen_writes_are_backfilled_with_same_payload(
    tmp_path: Path,
):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    config = {"DATA_DIR": str(data_dir)}
    _write_json(
        data_dir / "lastfm_settings.json",
        {
            "username": "live-listener",
            "session_key": "live-session",
            "connected_at": "2026-07-01T08:00:00+00:00",
            "user_timezone": "America/Denver",
        },
    )
    _write_json(
        data_dir / "lastfm_sync_state.json",
        {
            "pending_scrobbles": {
                "listen-live": {
                    "retry_count": 3,
                    "last_error": "rate limited",
                    "track_ref": "Artist|Album|Song",
                    "played_at": "2026-07-01T09:00:00+00:00",
                }
            },
            "sync_problems": {
                "listen-live": {
                    "provider": "lastfm",
                    "kind": "scrobble",
                    "status": "pending_retry",
                    "message": "rate limited",
                }
            },
            "last_retry_summary": {
                "pending_before": 1,
                "attempted": 1,
                "succeeded": 0,
                "failed": 1,
                "pending_after": 1,
                "recorded_at": "2026-07-01T09:05:00+00:00",
            },
        },
    )
    live_listen = {
        "id": "listen-live",
        "track_ref": "Artist|Album|Song",
        "recorded_at": "2026-07-01T09:00:00+00:00",
        "ended_at": "2026-07-01T09:00:00+00:00",
        "request_origin": "local_playback",
        "scrobbled": False,
        "total_listened_seconds": 180,
    }
    _write_json(
        data_dir / "listen_history.json",
        {"items": [live_listen]},
    )
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    settings_operation = next(
        operation for operation in target.operations
        if "integration.lastfm_settings" in str(operation["sql"])
    )
    session_operation = next(
        operation for operation in target.operations
        if "integration.lastfm_sessions" in str(operation["sql"])
    )
    pending_operation = next(
        operation for operation in target.operations
        if "integration.pending_scrobbles" in str(operation["sql"])
    )
    retry_operations = [
        operation for operation in target.operations
        if "integration.scrobble_retry_state" in str(operation["sql"])
    ]
    listen_operation = next(
        operation for operation in target.operations
        if "integration.listen_history" in str(operation["sql"])
    )
    assert settings_operation["params"][0:2] == ["live-listener", "America/Denver"]
    assert "session_key" not in settings_operation["params"][2]["settings_payload"]
    assert session_operation["params"][0:2] == ["live-listener", "live-session"]
    assert (
        session_operation["params"][2]["source_payload"]["connected_at"]
        == "2026-07-01T08:00:00+00:00"
    )
    assert "session_key" not in session_operation["params"][2]["source_payload"]
    assert pending_operation["params"][0:5] == [
        "Artist|Album|Song",
        "2026-07-01T09:00:00+00:00",
        3,
        None,
        "pending",
    ]
    assert pending_operation["params"][5]["source_key"] == "listen-live"
    assert retry_operations[0]["params"][0:3] == ["lastfm", "pending_retry", 0]
    assert retry_operations[0]["params"][5] == "rate limited"
    assert retry_operations[1]["params"][0:4] == [
        "lastfm",
        "summary",
        1,
        "2026-07-01T09:05:00+00:00",
    ]
    assert listen_operation["params"][0:6] == [
        "Artist|Album|Song",
        live_listen["recorded_at"],
        "phase_6_json_file_backfill",
        "listen-live",
        None,
        "local_playback",
    ]
    for key, value in live_listen.items():
        assert listen_operation["params"][6]["source_payload"][key] == value
    assert listen_operation["params"][6]["source_payload"]["_source_index"] == 0
    assert any(
        summary["source_family"] == "lastfm_settings" and summary["target_count"] == 2
        for summary in report["summaries"]
    )
    assert any(
        summary["source_family"] == "lastfm_sync_state" and summary["target_count"] == 3
        for summary in report["summaries"]
    )


def test_live_shaped_listen_history_uses_ended_at_then_started_at(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    _write_json(
        data_dir / "listen_history.json",
        {
            "items": [
                {
                    "id": "listen-ended",
                    "track_ref": "artist|album|song",
                    "ended_at": "2026-07-01T10:04:00+00:00",
                    "started_at": "2026-07-01T10:00:00+00:00",
                },
                {
                    "id": "listen-started",
                    "track_ref": "artist|album|other",
                    "started_at": "2026-07-01T11:00:00+00:00",
                },
            ]
        },
    )
    target = RecordingTarget()

    module.run_migration(data_dir=data_dir, mode="apply", target=target)

    listen_operations = [
        operation for operation in target.operations
        if "integration.listen_history" in str(operation["sql"])
    ]
    assert [operation["params"][1] for operation in listen_operations] == [
        "2026-07-01T10:04:00+00:00",
        "2026-07-01T11:00:00+00:00",
    ]


def test_lastfm_backfill_sql_uses_idempotent_conflict_identities(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    _write_json(
        data_dir / "lastfm_settings.json",
        {"username": "listener", "session_key": "session-secret"},
    )
    _write_json(
        data_dir / "lastfm_sync_state.json",
        {
            "pending_scrobbles": {"listen-1": {"track_ref": "artist|album|song"}},
            "sync_problems": {"listen-1": {"message": "temporary failure"}},
            "last_retry_summary": {"attempted": 1},
        },
    )
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    sql_text = "\n".join(str(operation["sql"]) for operation in target.operations)
    settings_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "lastfm_settings"
    )
    sync_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "lastfm_sync_state"
    )
    assert "on conflict (account_id) do update" in sql_text
    assert "on conflict (account_id, provider_username)" in sql_text
    assert "on conflict ((payload->>'source_family'), (payload->>'source_key'))" in sql_text
    assert (
        "on conflict ((metadata->>'source_family'), (metadata->>'source_section'), "
        "(metadata->>'source_key'))"
    ) in sql_text
    assert settings_summary["target_count"] == 2
    assert sync_summary["target_count"] == 3


def test_cover_lookup_terminal_notifications_are_backfilled(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    _write_json(
        data_dir / "cover_lookup_notifications.json",
        {
            "tasks": [
                {
                    "id": "cover-task-1",
                    "status": "completed",
                    "artist": "Artist One",
                    "album": "Album One",
                    "year": 2024,
                    "created_at": "2026-07-01T08:00:00+00:00",
                    "finished_at": "2026-07-01T08:01:00+00:00",
                    "notification_completed_at": "2026-07-01T08:02:00+00:00",
                    "notification_action_taken": True,
                    "notification_expires_at": "",
                    "track_paths": ["C:/Music/Artist One/Album One/01 Song.flac"],
                    "manual_urls": ["https://example.test/cover.jpg"],
                    "possible_matches": [{"id": "candidate-1", "provider": "manual"}],
                    "selected_candidate_id": "candidate-1",
                    "selected_cover_path": "C:/Music/Artist One/Album One/cover.jpg",
                    "caa_empty_notice": False,
                    "job_contract": {"job_type": "candidate_lookup"},
                },
                {
                    "id": "cover-task-2",
                    "status": "failed",
                    "artist": "Artist Two",
                    "album": "Album Two",
                    "updated_at": "2026-07-01T09:00:00+00:00",
                    "message": "Remote lookup failed.",
                    "error": "provider timeout",
                },
            ]
        },
    )
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    operations = [
        operation for operation in target.operations
        if "ops.cover_lookup_tasks" in str(operation["sql"])
    ]
    summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "cover_lookup_notifications"
    )
    first_params = operations[0]["params"]
    second_params = operations[1]["params"]
    assert len(operations) == 2
    assert first_params[0:6] == [
        "cover-task-1",
        "completed",
        "2026-07-01T08:00:00+00:00",
        "2026-07-01T08:02:00+00:00",
        "artist one|album one|2024",
        "C:/Music/Artist One/Album One/cover.jpg",
    ]
    assert first_params[6] == {
        "possible_matches": [{"id": "candidate-1", "provider": "manual"}],
        "manual_urls": ["https://example.test/cover.jpg"],
        "selected_candidate_id": "candidate-1",
        "caa_empty_notice": False,
        "job_contract": {"job_type": "candidate_lookup"},
    }
    assert first_params[7] is None
    assert first_params[8]["source_family"] == "cover_lookup_notifications"
    assert first_params[8]["source_key"] == "cover-task-1"
    assert first_params[8]["notification_action_taken"] is True
    assert first_params[8]["notification_completed_at"] == "2026-07-01T08:02:00+00:00"
    assert first_params[8]["track_paths"] == ["C:/Music/Artist One/Album One/01 Song.flac"]
    assert first_params[8]["source_payload"]["selected_cover_path"] == (
        "C:/Music/Artist One/Album One/cover.jpg"
    )
    assert second_params[0:4] == [
        "cover-task-2",
        "failed",
        "2026-07-01T09:00:00+00:00",
        "2026-07-01T09:00:00+00:00",
    ]
    assert second_params[7] == "provider timeout"
    assert summary["source_count"] == 2
    assert summary["target_count"] == 2
    assert summary["terminal_task_count"] == 2


def test_cover_lookup_terminal_notification_uses_updated_album_private_cover_path(
    tmp_path: Path,
):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    _write_json(
        data_dir / "cover_lookup_notifications.json",
        {
            "tasks": [
                {
                    "id": "cover-save-task",
                    "status": "completed",
                    "artist": "Saved Artist",
                    "album": "Saved Album",
                    "created_at": "2026-07-01T10:00:00+00:00",
                    "finished_at": "2026-07-01T10:01:00+00:00",
                    "updated_albums": [
                        {
                            "name": "Saved Album",
                            "album_artist": "Saved Artist",
                            "cover_path": "https://example.test/not-private.jpg",
                        },
                        {
                            "name": "Saved Album",
                            "album_artist": "Saved Artist",
                            "cover_path": "C:/Music/Saved Artist/Saved Album/cover.jpg",
                        },
                    ],
                },
            ]
        },
    )
    target = RecordingTarget()

    module.run_migration(data_dir=data_dir, mode="apply", target=target)

    operations = [
        operation for operation in target.operations
        if "ops.cover_lookup_tasks" in str(operation["sql"])
    ]
    assert len(operations) == 1
    assert operations[0]["params"][5] == "C:/Music/Saved Artist/Saved Album/cover.jpg"


@pytest.mark.parametrize(
    "payload",
    [
        "{not-json",
        ["wrong-shape"],
        {"tasks": "wrong-shape"},
        {"tasks": ["bad", {"id": "", "status": "completed"}, {"id": "live", "status": "running"}]},
    ],
)
def test_cover_lookup_notifications_skip_malformed_idless_and_non_terminal_rows(
    tmp_path: Path,
    payload: object,
):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    path = data_dir / "cover_lookup_notifications.json"
    if isinstance(payload, str):
        path.write_text(payload, encoding="utf-8")
    else:
        _write_json(path, payload)
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    operations = [
        operation for operation in target.operations
        if "ops.cover_lookup_tasks" in str(operation["sql"])
    ]
    summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "cover_lookup_notifications"
    )
    assert operations == []
    assert not any(
        failure.get("source_family") == "cover_lookup_notifications"
        for failure in report["failures"]
    )
    assert summary["target_count"] == 0
    assert summary["terminal_task_count"] == 0


def test_cover_lookup_legacy_terminal_notification_source_is_backfilled(tmp_path: Path):
    module = _load_script_module()
    data_dir = tmp_path / "album-haven-data"
    data_dir.mkdir()
    track_path = data_dir / "Music" / "Artist" / "Album" / "song.flac"
    selected_cover_path = data_dir / "covers" / "selected.jpg"
    selected_cover_path.parent.mkdir(parents=True, exist_ok=True)
    selected_cover_path.write_bytes(b"cover")
    task_id = "legacy-cover-task"
    _write_json(
        data_dir / "cover_lookup_notifications.json",
        {
            "tasks": [
                {
                    "id": task_id,
                    "status": "completed",
                    "album_payload": {
                        "key": "artist|album",
                        "album_artist": "Artist",
                        "name": "Album",
                        "cover_path": str(selected_cover_path),
                    },
                    "track_paths": [str(track_path)],
                    "finished_at": "2026-07-01T10:00:00+00:00",
                    "notification_completed_at": "2026-07-01T10:00:00+00:00",
                    "notification_action_taken": True,
                    "selected_candidate_id": "local-cover",
                    "selected_cover_path": str(selected_cover_path),
                    "message": "Saved selected cover",
                },
            ]
        },
    )
    summaries = module._collect_cover_lookup_notifications(data_dir, failures=[])
    cover_summary = summaries[0]
    cover_row = cover_summary["rows"][0]

    assert cover_summary["source_count"] == 1
    assert cover_summary["target_count"] == 0
    assert cover_summary["terminal_task_count"] == 1
    assert cover_row["task_key"] == task_id
    assert cover_row["status"] == "completed"
    assert cover_row["album_key"] == "artist|album"
    assert cover_row["selected_cover_private_path"] == str(selected_cover_path)
    assert cover_row["metadata"]["source_family"] == "cover_lookup_notifications"
    assert cover_row["metadata"]["notification_action_taken"] is True
    assert cover_row["metadata"]["source_payload"]["selected_candidate_id"] == "local-cover"


def test_cover_provider_search_cache_remains_file_backed_and_out_of_migration(
    tmp_path: Path,
):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    _write_json(
        data_dir / "cover_search_cache.json",
        {
            "queries": {
                "artist|album": [{"provider": "discogs", "image_url": "https://example.test/a.jpg"}]
            }
        },
    )
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    assert not any(
        summary["source_family"] == "cover_search_cache"
        for summary in report["summaries"]
    )
    assert not any(
        "cover_search_cache" in str(operation["sql"]).lower()
        for operation in target.operations
    )


def test_listen_history_source_count_includes_skipped_non_dict_items(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    _write_json(
        data_dir / "listen_history.json",
        {
            "items": [
                {
                    "id": "listen-1",
                    "track_ref": "artist|album|song",
                    "recorded_at": "2026-07-01T10:11:12+00:00",
                },
                "not-a-dict",
            ]
        },
    )
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    listen_summary = next(
        summary["summary"]
        for summary in target.source_summaries
        if summary["summary"]["source_family"] == "listen_history"
    )
    report_listen_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "listen_history"
    )
    assert listen_summary["source_count"] == 2
    assert listen_summary["skipped_count"] == 1
    assert report_listen_summary["source_count"] == 2
    assert report_listen_summary["skipped_count"] == 1


def test_apply_target_count_uses_returned_write_counts(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    _write_json(
        data_dir / "listen_history.json",
        {
            "items": [
                {
                    "id": "listen-existing",
                    "track_ref": "artist|album|song",
                    "recorded_at": "2026-07-01T10:11:12+00:00",
                }
            ]
        },
    )

    class ExistingListenTarget(RecordingTarget):
        def execute(self, sql: str, params: object | None = None) -> int:
            self.operations.append({"sql": sql, "params": params})
            if "integration.listen_history" in sql:
                return 0
            return 1

    target = ExistingListenTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    listen_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "listen_history"
    )
    assert listen_summary["source_count"] == 1
    assert listen_summary["target_count"] == 0


def test_apply_normalizes_listen_history_track_key_from_path(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    _write_json(
        data_dir / "listen_history.json",
        {
            "items": [
                {
                    "id": "listen-path-only",
                    "path": "C:/Music/Artist/Album/01 Song.flac",
                    "recorded_at": "2026-07-01T10:11:12+00:00",
                }
            ]
        },
    )
    target = RecordingTarget()

    module.run_migration(data_dir=data_dir, mode="apply", target=target)

    listen_operation = next(
        operation for operation in target.operations
        if "integration.listen_history" in str(operation["sql"])
    )
    assert listen_operation["params"][0] == "C:/Music/Artist/Album/01 Song.flac"


def test_apply_derives_stable_source_key_for_listen_history_without_id(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    _write_json(
        data_dir / "listen_history.json",
        {
            "items": [
                {
                    "track_ref": "artist|album|song",
                    "recorded_at": "2026-07-01T10:11:12+00:00",
                    "total_listened_seconds": 42,
                }
            ]
        },
    )
    first_target = RecordingTarget()
    second_target = RecordingTarget()

    module.run_migration(data_dir=data_dir, mode="apply", target=first_target)
    module.run_migration(data_dir=data_dir, mode="apply", target=second_target)

    first_listen_operation = next(
        operation for operation in first_target.operations
        if "integration.listen_history" in str(operation["sql"])
    )
    second_listen_operation = next(
        operation for operation in second_target.operations
        if "integration.listen_history" in str(operation["sql"])
    )
    first_metadata = first_listen_operation["params"][6]
    second_metadata = second_listen_operation["params"][6]
    assert first_metadata["source_entry_id"]
    assert first_metadata["source_entry_id"] == second_metadata["source_entry_id"]


def test_apply_skips_listen_history_rows_without_timestamp(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    _write_json(
        data_dir / "listen_history.json",
        {
            "items": [
                {
                    "id": "listen-no-timestamp",
                    "track_ref": "artist|album|song",
                }
            ]
        },
    )
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    listen_operations = [
        operation for operation in target.operations
        if "integration.listen_history" in str(operation["sql"])
    ]
    listen_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "listen_history"
    )
    assert listen_operations == []
    assert listen_summary["source_count"] == 1
    assert listen_summary["target_count"] == 0
    assert listen_summary["skipped_count"] == 1
    assert listen_summary["warning_count"] == 1


def test_apply_skips_listen_history_rows_with_invalid_timestamp(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    _write_json(
        data_dir / "listen_history.json",
        {
            "items": [
                {
                    "id": "listen-bad-timestamp",
                    "track_ref": "artist|album|song",
                    "recorded_at": "not-a-timestamp",
                }
            ]
        },
    )
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    listen_operations = [
        operation for operation in target.operations
        if "integration.listen_history" in str(operation["sql"])
    ]
    listen_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "listen_history"
    )
    assert listen_operations == []
    assert listen_summary["source_count"] == 1
    assert listen_summary["target_count"] == 0
    assert listen_summary["skipped_count"] == 1
    assert listen_summary["warning_count"] == 1


def test_malformed_listen_history_is_reported_as_source_error(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    (data_dir / "listen_history.json").write_text("{not-json", encoding="utf-8")

    report = module.run_migration(data_dir=data_dir, mode="dry-run")

    assert report["error_count"] >= 1
    assert any(
        failure.get("source_family") == "listen_history"
        and failure.get("severity") == "error"
        for failure in report["failures"]
    )
    listen_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "listen_history"
    )
    assert listen_summary["error_count"] == 1
    assert report["error_count"] == 1


def test_listen_history_object_without_items_is_reported_as_source_error(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    _write_json(data_dir / "listen_history.json", {"history": []})

    report = module.run_migration(data_dir=data_dir, mode="dry-run")

    assert report["error_count"] >= 1
    assert any(
        failure.get("source_family") == "listen_history"
        and failure.get("severity") == "error"
        for failure in report["failures"]
    )
    assert report["error_count"] == 1


def test_render_sql_does_not_replace_percent_s_inside_rendered_values():
    module = _load_script_module()

    rendered = module._render_sql(
        "insert into sample (a, b, c) values (%s, %s, %s);",
        ["literal %s marker", "second", "third"],
    )

    assert rendered == "insert into sample (a, b, c) values ('literal %s marker', 'second', 'third');"


def test_render_sql_rejects_placeholder_param_mismatch():
    module = _load_script_module()

    with pytest.raises(ValueError):
        module._render_sql("select %s, %s;", ["only-one"])


def test_duplicate_idless_listen_history_rows_preserve_multiplicity(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    listen_row = {
        "track_ref": "artist|album|song",
        "recorded_at": "2026-07-01T10:11:12+00:00",
        "total_listened_seconds": 42,
    }
    _write_json(
        data_dir / "listen_history.json",
        {
            "items": [
                listen_row,
                listen_row,
            ]
        },
    )
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    listen_operations = [
        operation for operation in target.operations
        if "integration.listen_history" in str(operation["sql"])
    ]
    source_entry_ids = [
        operation["params"][6]["source_entry_id"]
        for operation in listen_operations
    ]
    listen_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "listen_history"
    )
    assert len(listen_operations) == 2
    assert len(set(source_entry_ids)) == 2
    assert listen_summary["source_count"] == 2
    assert listen_summary["target_count"] == 2


def test_track_preferences_live_write_is_backfilled_with_same_normalized_overlay(
    tmp_path: Path,
):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    preference_payload = {"rating": "5", "love_tier": "obsessed"}
    live_result = normalize_track_preference_overlay(preference_payload)
    _write_json(
        data_dir / "track_preferences.json",
        {
            "actors": {
                "local": {
                    "track_preferences": {
                        "Artist|Album|Song": preference_payload,
                    }
                }
            }
        },
    )
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    track_operation = next(
        operation for operation in target.operations
        if "insert into app.track_preferences" in str(operation["sql"]).lower()
        and operation["params"][0] == "Artist|Album|Song"
    )
    lastfm_loved_operations = [
        operation for operation in target.operations
        if "integration.lastfm_loved_tracks" in str(operation["sql"]).lower()
    ]
    assert track_operation["params"][1:3] == [
        live_result["rating"],
        live_result["love_tier"],
    ]
    assert track_operation["params"][3] == {
        "source": "phase_6_json_file_backfill",
        "actor_id": "local",
    }
    assert lastfm_loved_operations == []
    track_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "track_preferences"
    )
    assert track_summary["target_count"] == 1


def test_track_preferences_backfill_reads_file_when_runtime_postgres_is_selected(
    tmp_path: Path,
    monkeypatch,
):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    _write_json(
        data_dir / "track_preferences.json",
        {
            "actors": {
                "local": {
                    "track_preferences": {
                        "Artist|Album|Song": {"rating": "5", "love_tier": "obsessed"},
                    }
                }
            }
        },
    )
    monkeypatch.setenv("ALBUM_HAVEN_PERSISTENCE_TRACK_PREFERENCES", "postgres")
    monkeypatch.setattr("music_app.services.track_preferences_postgres.psycopg", object())
    monkeypatch.setattr(
        "music_app.services.track_preferences.PostgresTrackPreferencesStore",
        lambda config: pytest.fail("track preference backfill should read source JSON"),
    )
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    track_operation = next(
        operation for operation in target.operations
        if "insert into app.track_preferences" in str(operation["sql"]).lower()
    )
    assert track_operation["params"][0] == "Artist|Album|Song"
    track_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "track_preferences"
    )
    assert track_summary["target_count"] == 1


def test_dry_run_reports_discovery_center_preferences_without_lookup_snapshots(
    tmp_path: Path,
):
    module = _load_script_module()
    data_dir = _data_dir_with_discovery_preferences(tmp_path)

    report = module.run_migration(data_dir=data_dir, mode="dry-run")

    discovery_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "discovery_center_preferences"
    )
    source_families = {summary["source_family"] for summary in report["summaries"]}
    assert discovery_summary["source_path"] == str(data_dir / "discovery_center_preferences.json")
    assert discovery_summary["source_count"] == 1
    assert discovery_summary["target_count"] == 0
    assert "discovery_lookup_snapshots" not in source_families
    assert "lookup-not-backfilled" not in json.dumps(report)


def test_apply_writes_normalized_discovery_center_preferences_payload(
    tmp_path: Path,
):
    module = _load_script_module()
    data_dir = _data_dir_with_discovery_preferences(tmp_path)
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    operation = next(
        operation for operation in target.operations
        if "insert into app.user_discovery_preferences" in str(operation["sql"]).lower()
    )
    preferences_payload = operation["params"][1]
    metadata = operation["params"][2]
    assert operation["params"][0] == "local_first_single_viewer"
    assert preferences_payload == {
        "source_toggles": {
            "release": False,
            "suggestion": True,
            "research": True,
        },
        "delivery": {
            "toast_notifications_enabled": False,
            "quiet_hours": {
                "enabled": True,
                "start": "23:30",
                "end": "06:15",
            },
        },
    }
    assert metadata == {
        "source": "phase_6_json_file_backfill",
        "source_family": "discovery_center_preferences",
    }
    discovery_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "discovery_center_preferences"
    )
    assert discovery_summary["target_count"] == 1
    assert not any(
        "discovery_lookup_snapshots" in str(operation["sql"]).lower()
        for operation in target.operations
    )


def test_malformed_discovery_center_preferences_backfills_current_defaults(
    tmp_path: Path,
):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    (data_dir / "discovery_center_preferences.json").write_text(
        "{not-json",
        encoding="utf-8",
    )
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    operation = next(
        operation for operation in target.operations
        if "insert into app.user_discovery_preferences" in str(operation["sql"]).lower()
    )
    assert operation["params"][1]["source_toggles"] == {
        "release": True,
        "suggestion": True,
        "research": True,
    }
    assert operation["params"][1]["delivery"]["toast_notifications_enabled"] is True
    discovery_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "discovery_center_preferences"
    )
    assert discovery_summary["source_count"] == 1
    assert discovery_summary["target_count"] == 1
    assert discovery_summary["error_count"] == 0
    assert report["error_count"] == 0


def test_discovery_center_preferences_backfill_reads_file_when_runtime_postgres_is_selected(
    tmp_path: Path,
    monkeypatch,
):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    _write_json(
        data_dir / "discovery_center_preferences.json",
        {"source_toggles": {"release": False}},
    )
    monkeypatch.setenv("ALBUM_HAVEN_PERSISTENCE_DISCOVERY_CENTER_PREFERENCES", "postgres")
    monkeypatch.setattr(
        "music_app.services.discovery_center_preferences_postgres.psycopg",
        object(),
    )
    monkeypatch.setattr(
        "music_app.services.discovery_center_read_seams.DiscoveryCenterPreferencesPostgresAdapter",
        lambda config: pytest.fail("discovery preference backfill should read source JSON"),
    )
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    operation = next(
        operation for operation in target.operations
        if "insert into app.user_discovery_preferences" in str(operation["sql"]).lower()
    )
    assert operation["params"][1]["source_toggles"]["release"] is False
    discovery_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "discovery_center_preferences"
    )
    assert discovery_summary["target_count"] == 1


def test_track_preferences_apply_preserves_local_app_owned_love_tiers_only(
    tmp_path: Path,
):
    module = _load_script_module()
    data_dir = tmp_path / "album-haven-data"
    data_dir.mkdir()
    _write_json(
        data_dir / "track_preferences.json",
        {
            "actors": {
                "local": {
                    "track_preferences": {
                        "artist|album|song": {"rating": 5, "love_tier": "loved"},
                        "artist|album|obsessed": {
                            "rating": 4,
                            "love_tier": "obsessed",
                        },
                    }
                },
                "other": {
                    "track_preferences": {
                        "artist|album|song": {"rating": 1, "love_tier": "obsessed"}
                    }
                },
            }
        },
    )
    _write_json(data_dir / "listen_history.json", {"items": []})
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    track_operations = [
        operation for operation in target.operations
        if "app.track_preferences" in str(operation["sql"])
        and "insert into app.track_preferences" in str(operation["sql"]).lower()
    ]
    lastfm_loved_operations = [
        operation for operation in target.operations
        if "integration.lastfm_loved_tracks" in str(operation["sql"]).lower()
    ]
    track_preferences_by_key = {
        operation["params"][0]: {
            "rating": operation["params"][1],
            "love_tier": operation["params"][2],
        }
        for operation in track_operations
    }
    assert track_preferences_by_key == {
        "artist|album|song": {"rating": 5, "love_tier": "loved"},
        "artist|album|obsessed": {"rating": 4, "love_tier": "obsessed"},
    }
    assert lastfm_loved_operations == []
    track_summary = next(
        summary["summary"]
        for summary in target.source_summaries
        if summary["summary"]["source_family"] == "track_preferences"
    )
    report_track_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "track_preferences"
    )
    assert track_summary["source_count"] == 3
    assert track_summary["target_count"] == 2
    assert track_summary["skipped_count"] == 1
    assert track_summary["warning_count"] == 1
    assert report_track_summary["source_count"] == 3
    assert report_track_summary["skipped_count"] == 1
    assert report["warning_count"] >= 1


def test_track_preferences_non_local_only_store_preserves_skip_counts(tmp_path: Path):
    module = _load_script_module()
    data_dir = tmp_path / "album-haven-data"
    data_dir.mkdir()
    _write_json(
        data_dir / "track_preferences.json",
        {
            "actors": {
                "other": {
                    "track_preferences": {
                        "artist|album|song": {"rating": 1, "love_tier": "obsessed"}
                    }
                }
            }
        },
    )
    _write_json(data_dir / "listen_history.json", {"items": []})
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    track_operations = [
        operation for operation in target.operations
        if "insert into app.track_preferences" in str(operation["sql"]).lower()
    ]
    track_summary = next(
        summary["summary"]
        for summary in target.source_summaries
        if summary["summary"]["source_family"] == "track_preferences"
    )
    report_track_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "track_preferences"
    )
    assert track_operations == []
    assert track_summary["source_count"] == 1
    assert track_summary["target_count"] == 0
    assert track_summary["skipped_count"] == 1
    assert track_summary["warning_count"] == 1
    assert report_track_summary["source_count"] == 1
    assert report_track_summary["skipped_count"] == 1


def test_legacy_track_preferences_clamp_invalid_ratings_before_apply(tmp_path: Path):
    module = _load_script_module()
    data_dir = tmp_path / "album-haven-data"
    data_dir.mkdir()
    _write_json(
        data_dir / "track_preferences.json",
        {
            "tracks": {
                "artist|album|song": {"rating": 999, "love_tier": "off"},
                "artist|album|loved": {"rating": 999, "love_tier": "loved"},
            }
        },
    )
    _write_json(data_dir / "listen_history.json", {"items": []})
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    track_operations = [
        operation for operation in target.operations
        if "insert into app.track_preferences" in str(operation["sql"]).lower()
    ]
    track_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "track_preferences"
    )
    assert len(track_operations) == 1
    assert track_operations[0]["params"][1] is None
    assert track_operations[0]["params"][2] == "loved"
    assert track_summary["source_count"] == 2
    assert track_summary["target_count"] == 1
    assert track_summary["skipped_count"] == 1
    assert track_summary["warning_count"] == 2


def test_malformed_track_preferences_are_reported_as_source_errors(tmp_path: Path):
    module = _load_script_module()
    data_dir = tmp_path / "album-haven-data"
    data_dir.mkdir()
    (data_dir / "track_preferences.json").write_text("{not-json", encoding="utf-8")

    report = module.run_migration(data_dir=data_dir, mode="dry-run")

    assert report["error_count"] >= 1
    assert any(
        failure.get("source_family") == "track_preferences"
        and failure.get("severity") == "error"
        for failure in report["failures"]
    )


def test_apply_records_failed_lifecycle_for_source_errors(tmp_path: Path):
    module = _load_script_module()
    data_dir = tmp_path / "album-haven-data"
    data_dir.mkdir()
    (data_dir / "track_preferences.json").write_text("{not-json", encoding="utf-8")
    target = RecordingTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    assert report["error_count"] >= 1
    assert target.started_runs == [{"mode": "apply", "data_dir": data_dir}]
    assert target.source_summaries
    assert target.completed_runs == [
        {
            "migration_run_id": 1,
            "status": "failed",
            "report": report,
        }
    ]
    assert not target.operations


def test_apply_records_partial_target_counts_when_target_write_fails(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    _write_json(
        data_dir / "listen_history.json",
        {
            "items": [
                {
                    "id": "listen-1",
                    "track_ref": "artist|album|song",
                    "recorded_at": "2026-07-01T10:11:12+00:00",
                },
                {
                    "id": "listen-2",
                    "track_ref": "artist|album|song",
                    "recorded_at": "2026-07-01T10:12:12+00:00",
                },
            ]
        },
    )

    class FailingListenTarget(RecordingTarget):
        def __init__(self) -> None:
            super().__init__()
            self.listen_writes = 0

        def execute(self, sql: str, params: object | None = None) -> int:
            self.operations.append({"sql": sql, "params": params})
            if "integration.listen_history" not in sql:
                return 1
            self.listen_writes += 1
            if self.listen_writes == 2:
                raise RuntimeError("target write failed")
            return 1

    target = FailingListenTarget()

    report = module.run_migration(data_dir=data_dir, mode="apply", target=target)

    listen_summary = next(
        summary["summary"]
        for summary in target.source_summaries
        if summary["summary"]["source_family"] == "listen_history"
    )
    report_listen_summary = next(
        summary for summary in report["summaries"]
        if summary["source_family"] == "listen_history"
    )
    assert target.completed_runs[-1]["status"] == "failed"
    assert any(failure.get("source_family") == "target" for failure in report["failures"])
    assert listen_summary["target_count"] == 1
    assert report_listen_summary["target_count"] == 1


def test_apply_source_errors_construct_default_target_for_failed_lifecycle(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    module = _load_script_module()
    data_dir = tmp_path / "album-haven-data"
    data_dir.mkdir()
    (data_dir / "track_preferences.json").write_text("{not-json", encoding="utf-8")
    target = RecordingTarget()

    class FakePsqlTarget:
        def __new__(cls):
            return target

    monkeypatch.setattr(module, "PsqlSubprocessTarget", FakePsqlTarget)

    report = module.run_migration(data_dir=data_dir, mode="apply")

    assert report["error_count"] >= 1
    assert target.started_runs == [{"mode": "apply", "data_dir": data_dir}]
    assert target.source_summaries
    assert target.completed_runs[-1]["status"] == "failed"


def test_apply_reports_target_construction_failure_cleanly(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
):
    module = _load_script_module()
    data_dir = tmp_path / "album-haven-data"
    data_dir.mkdir()
    (data_dir / "track_preferences.json").write_text("{not-json", encoding="utf-8")

    class BrokenPsqlTarget:
        def __init__(self):
            raise RuntimeError("missing database url")

    monkeypatch.setattr(module, "PsqlSubprocessTarget", BrokenPsqlTarget)

    report = module.run_migration(data_dir=data_dir, mode="apply")

    assert report["error_count"] >= 1
    assert any(
        failure.get("source_family") == "target"
        and "missing database url" in failure.get("message", "")
        for failure in report["failures"]
    )
    assert "traceback" not in json.dumps(report).lower()


def test_psql_subprocess_target_sends_sql_via_utf8_stdin(monkeypatch: pytest.MonkeyPatch):
    module = _load_script_module()
    calls: list[tuple[list[str], dict[str, object]]] = []

    def fake_run(command: list[str], **kwargs: object):
        calls.append((command, kwargs))

        class Completed:
            stdout = "1\n"

        return Completed()

    monkeypatch.setattr(module.subprocess, "run", fake_run)
    target = module.PsqlSubprocessTarget(
        database_url="postgresql://migrator/album_haven_core",
        psql_path="psql",
    )
    long_sql = f"select 'Büyük Ev Ablukada' as artist_name where 'artist' in ({', '.join(repr(str(index)) for index in range(2000))})"

    completed = target._run_sql(long_sql, capture=True)

    command, kwargs = calls[0]
    assert completed.stdout == "1\n"
    assert "-c" not in command
    assert long_sql in str(kwargs["input"])
    assert kwargs["encoding"] == "utf-8"


def test_psql_subprocess_target_counts_returned_rows_without_command_tags(
    monkeypatch: pytest.MonkeyPatch,
):
    module = _load_script_module()

    def fake_run(command: list[str], **kwargs: object):
        class Completed:
            stdout = "1\nINSERT 0 1\n"

        return Completed()

    monkeypatch.setattr(module.subprocess, "run", fake_run)
    target = module.PsqlSubprocessTarget(
        database_url="postgresql://migrator/album_haven_core",
        psql_path="psql",
    )

    assert target.execute("insert into app.example values (%s) returning 1;", ["row"]) == 1


def test_psql_subprocess_target_batches_sql_via_single_utf8_stdin_call(monkeypatch: pytest.MonkeyPatch):
    module = _load_script_module()
    calls: list[tuple[list[str], dict[str, object]]] = []

    def fake_run(command: list[str], **kwargs: object):
        calls.append((command, kwargs))

        class Completed:
            stdout = "1\nINSERT 0 1\n1\nINSERT 0 1\n"

        return Completed()

    monkeypatch.setattr(module.subprocess, "run", fake_run)
    target = module.PsqlSubprocessTarget(
        database_url="postgresql://migrator/album_haven_core",
        psql_path="psql",
    )

    applied_count = target.execute_batch(
        [
            ("select %s;", ["Büyük Ev Ablukada"]),
            ("select %s;", ["She Past Away"]),
        ]
    )

    command, kwargs = calls[0]
    assert applied_count == 2
    assert len(calls) == 1
    assert "-c" not in command
    assert "Büyük Ev Ablukada" in str(kwargs["input"])
    assert "She Past Away" in str(kwargs["input"])
    assert kwargs["encoding"] == "utf-8"


def test_psql_subprocess_target_wraps_batch_in_transaction(monkeypatch: pytest.MonkeyPatch):
    module = _load_script_module()
    calls: list[tuple[list[str], dict[str, object]]] = []

    def fake_run(command: list[str], **kwargs: object):
        calls.append((command, kwargs))

        class Completed:
            stdout = "1\nINSERT 0 1\n"

        return Completed()

    monkeypatch.setattr(module.subprocess, "run", fake_run)
    target = module.PsqlSubprocessTarget(
        database_url="postgresql://migrator/album_haven_core",
        psql_path="psql",
    )

    target.execute_batch([("insert into app.example values (%s) returning 1;", ["row"])])

    batch_sql = str(calls[0][1]["input"]).strip()
    assert batch_sql.startswith("begin;")
    assert batch_sql.endswith("commit;")


def test_apply_writes_report_when_completion_update_fails(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    report_path = tmp_path / "completion-failure-report.json"

    class CompletionFailureTarget(RecordingTarget):
        def complete_migration_run(
            self, migration_run_id: int, *, status: str, report: dict[str, object]
        ) -> None:
            raise RuntimeError("completion failed")

    report = module.run_migration(
        data_dir=data_dir,
        mode="apply",
        report_path=report_path,
        target=CompletionFailureTarget(),
    )

    assert report["error_count"] == 1
    assert any(
        failure.get("source_family") == "target"
        and "completion failed" in failure.get("message", "")
        for failure in report["failures"]
    )
    assert json.loads(report_path.read_text(encoding="utf-8")) == report


def test_apply_operations_are_idempotent_and_non_destructive(tmp_path: Path):
    module = _load_script_module()
    data_dir = _minimal_data_dir(tmp_path)
    target = RecordingTarget()

    module.run_migration(data_dir=data_dir, mode="apply", target=target)

    sql_text = "\n".join(str(operation["sql"]) for operation in target.operations)
    assert "insert" in sql_text.lower()
    assert "on conflict" in sql_text.lower()
    assert not DESTRUCTIVE_SQL.search(sql_text)
