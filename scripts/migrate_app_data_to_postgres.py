from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
import shutil
import subprocess
import sys
import uuid
from typing import Any

from music_app.services import local_mbid_assertions
from music_app.services import library_roots
from music_app.services.discovery_center_read_seams import (
    _normalize_preferences as normalize_discovery_center_preferences_for_migration,
)
from music_app.services.cache import load_cache_snapshot_from_disk
from music_app.services.library import build_albums_from_file_cache
from music_app.services.metadata import normalize_exception_value
from music_app.services.track_preferences import (
    normalize_track_preference_overlay,
    normalize_track_preferences_store,
)
from music_app.services.track_stats import normalize_track_ref
from music_app.services.utils import safe_int


MIGRATION_NAME = "phase_6_json_file_backfill"
BOOTSTRAP_OWNER_KEY = "local-bootstrap-owner"
BOOTSTRAP_OWNER_DISPLAY_NAME = "nominem"
BOOTSTRAP_LIBRARY_NAME = "Local Library"


class _ModeAction(argparse.Action):
    def __call__(
        self,
        parser: argparse.ArgumentParser,
        namespace: argparse.Namespace,
        values: object,
        option_string: str | None = None,
    ) -> None:
        is_apply = option_string == "--apply"
        setattr(namespace, "apply", is_apply)
        setattr(namespace, "dry_run", not is_apply)


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Dry-run or apply the Phase 6 JSON/file-backed data migration.",
    )
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--dry-run",
        action=_ModeAction,
        nargs=0,
        default=True,
        help="Inspect sources and write a report without touching Postgres (default).",
    )
    mode.add_argument(
        "--apply",
        action=_ModeAction,
        nargs=0,
        default=False,
        help="Apply idempotent inserts to the configured Postgres target.",
    )
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=Path(os.environ.get("ALBUM_HAVEN_DATA_DIR", ".")).expanduser(),
        help="Album Haven data directory containing current JSON/file-backed sources.",
    )
    parser.add_argument(
        "--report",
        type=Path,
        default=None,
        help="Optional path for a machine-readable JSON migration report.",
    )
    parser.add_argument(
        "--lastfm-readonly-url",
        default=os.environ.get("ALBUM_HAVEN_LASTFM_READONLY_URL"),
        help="Read-only Last.fm Postgres URL for MBID evidence. Defaults to ALBUM_HAVEN_LASTFM_READONLY_URL.",
    )
    parser.add_argument(
        "--skip-lastfm-mbid-evidence",
        action="store_true",
        help="Skip Last.fm MBID evidence reads when the local Last.fm database is unavailable.",
    )
    return parser


class PsqlSubprocessTarget:
    """Small psql-backed target for owner-run apply mode without a Python DB dependency."""

    def __init__(
        self,
        *,
        database_url: str | None = None,
        psql_path: str | None = None,
    ) -> None:
        self.database_url = database_url or os.environ.get("ALBUM_HAVEN_DATABASE_URL")
        self.psql_path = psql_path or _resolve_psql_path()
        if not self.database_url:
            raise RuntimeError("ALBUM_HAVEN_DATABASE_URL is required for --apply without a target.")

    def begin_migration_run(self, *, mode: str, data_dir: Path) -> int:
        sql = """
            insert into ops.migration_runs (migration_name, dry_run, status, summary)
            values (%s, %s, 'running', %s::jsonb)
            returning id;
        """
        started = {
            "mode": mode,
            "data_dir": str(data_dir),
            "started_by": "scripts/migrate_app_data_to_postgres.py",
        }
        return int(self._query_scalar(sql, [MIGRATION_NAME, mode == "dry-run", started]))

    def record_source_summary(self, migration_run_id: int, summary: dict[str, object]) -> None:
        sql = """
            insert into ops.migration_source_summaries (
              migration_run_id,
              source_family,
              source_path,
              source_count,
              target_count,
              skipped_count,
              error_count,
              warning_count,
              summary_payload
            )
            values (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb);
        """
        self.execute(
            sql,
            [
                migration_run_id,
                summary.get("source_family"),
                summary.get("source_path"),
                summary.get("source_count", 0),
                summary.get("target_count", 0),
                summary.get("skipped_count", 0),
                summary.get("error_count", 0),
                summary.get("warning_count", 0),
                summary,
            ],
        )

    def execute(self, sql: str, params: object | None = None) -> int:
        completed = self._run_sql(_render_sql(sql, params), capture=True)
        return self._returned_row_count(completed.stdout)

    def execute_batch(self, operations: list[tuple[str, object | None]]) -> int:
        if not operations:
            return 0
        rendered = "\n".join(
            ["begin;", *(_render_sql(sql, params) for sql, params in operations), "commit;"]
        )
        completed = self._run_sql(rendered, capture=True)
        return self._returned_row_count(completed.stdout)

    def complete_migration_run(
        self,
        migration_run_id: int,
        *,
        status: str,
        report: dict[str, object],
    ) -> None:
        sql = """
            update ops.migration_runs
            set finished_at = now(), status = %s, report_path = %s, summary = %s::jsonb
            where id = %s;
        """
        self.execute(sql, [status, report.get("report_path"), report, migration_run_id])

    def _query_scalar(self, sql: str, params: object | None = None) -> str:
        rendered = _render_sql(sql, params)
        completed = self._run_sql(rendered, capture=True)
        for line in completed.stdout.splitlines():
            text = line.strip()
            if text:
                return text
        raise RuntimeError("psql did not return a scalar value.")

    def _run_sql(self, sql: str, *, capture: bool = False) -> subprocess.CompletedProcess[str]:
        command = [
            self.psql_path,
            "-w",
            "-v",
            "ON_ERROR_STOP=1",
            self.database_url,
            "-At",
        ]
        return subprocess.run(
            command,
            check=True,
            capture_output=capture,
            encoding="utf-8",
            input=sql,
            text=True,
        )

    @staticmethod
    def _returned_row_count(output: str) -> int:
        return sum(1 for line in output.splitlines() if line.strip() == "1")


class LastfmReadonlySubprocessSource:
    """Read-only psql-backed Last.fm source for MBID evidence."""

    _MUTATING_SQL = re.compile(
        r"\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|merge|copy)\b",
        re.IGNORECASE,
    )
    _INTO_SQL = re.compile(r"\binto\b", re.IGNORECASE)

    def __init__(
        self,
        *,
        database_url: str | None = None,
        psql_path: str | None = None,
    ) -> None:
        self.database_url = database_url or os.environ.get("ALBUM_HAVEN_LASTFM_READONLY_URL")
        self.psql_path = psql_path or _resolve_psql_path()
        if not self.database_url:
            raise RuntimeError(
                "ALBUM_HAVEN_LASTFM_READONLY_URL is required for Last.fm MBID evidence reads."
            )

    def query_json(self, sql: str, params: object | None = None) -> list[dict[str, object]]:
        rendered_sql = _render_sql(sql, params).strip().rstrip(";")
        guard_sql = _sql_guard_text(rendered_sql)
        if self._MUTATING_SQL.search(guard_sql) or self._INTO_SQL.search(guard_sql):
            raise ValueError("Last.fm readonly source only accepts SELECT statements.")
        if not rendered_sql.lower().startswith(("select", "with")):
            raise ValueError("Last.fm readonly source only accepts SELECT statements.")
        wrapped_sql = f"""
            select coalesce(jsonb_agg(to_jsonb(lastfm_rows)), '[]'::jsonb)
            from (
              {rendered_sql}
            ) as lastfm_rows;
        """
        command = [
            self.psql_path,
            "-w",
            "-v",
            "ON_ERROR_STOP=1",
            self.database_url,
            "-At",
        ]
        completed = subprocess.run(
            command,
            check=True,
            capture_output=True,
            encoding="utf-8",
            input=wrapped_sql,
            text=True,
        )
        payload = completed.stdout.strip() or "[]"
        decoded = json.loads(payload)
        if not isinstance(decoded, list):
            raise RuntimeError("Last.fm readonly query did not return a JSON list.")
        return [dict(item) for item in decoded if isinstance(item, dict)]


def run_migration(
    *,
    data_dir: Path,
    mode: str = "dry-run",
    report_path: Path | None = None,
    target: object | None = None,
    artist_mbid_evidence: dict[str, list[dict[str, object]]] | None = None,
    album_mbid_evidence: dict[tuple[str, str], list[dict[str, object]]] | None = None,
    track_mbid_evidence: dict[tuple[str, str], list[dict[str, object]]] | None = None,
    lastfm_readonly_url: str | None = None,
    lastfm_readonly_source: object | None = None,
    skip_lastfm_mbid_evidence: bool = False,
) -> dict[str, object]:
    normalized_mode = "apply" if mode == "apply" else "dry-run"
    resolved_data_dir = Path(data_dir).expanduser().resolve(strict=False)
    failures: list[dict[str, object]] = []
    summaries: list[dict[str, object]] = []

    if not resolved_data_dir.exists() or not resolved_data_dir.is_dir():
        failures.append(
            {
                "source_family": "data_dir",
                "source_path": str(resolved_data_dir),
                "severity": "error",
                "message": "Data directory does not exist or is not a directory.",
            }
        )
    else:
        summaries.extend(_collect_track_preferences(resolved_data_dir, failures))
        summaries.extend(_collect_listen_history(resolved_data_dir, failures))
        summaries.extend(_collect_lastfm_settings(resolved_data_dir, failures))
        summaries.extend(_collect_lastfm_sync_state(resolved_data_dir, failures))
        summaries.extend(_collect_cover_lookup_notifications(resolved_data_dir, failures))
        summaries.extend(_collect_saved_loops(resolved_data_dir, failures))
        summaries.extend(_collect_discovery_center_preferences(resolved_data_dir, failures))
        summaries.extend(_collect_library_root_settings(resolved_data_dir, failures))
        if artist_mbid_evidence is None:
            artist_names = _local_artist_names_from_cache(resolved_data_dir, failures)
            (
                artist_mbid_evidence,
                collected_album_mbid_evidence,
                collected_track_mbid_evidence,
                lastfm_summary,
            ) = _lastfm_evidence_for_migration(
                artist_names,
                source=lastfm_readonly_source,
                readonly_url=lastfm_readonly_url,
                skip=skip_lastfm_mbid_evidence,
                failures=failures,
            )
            if album_mbid_evidence is None:
                album_mbid_evidence = collected_album_mbid_evidence
            if track_mbid_evidence is None:
                track_mbid_evidence = collected_track_mbid_evidence
            summaries.append(lastfm_summary)
        elif lastfm_readonly_source is not None or lastfm_readonly_url:
            _unused_artist, _unused_album, _unused_track, lastfm_summary = _lastfm_evidence_for_migration(
                [],
                source=lastfm_readonly_source,
                readonly_url=lastfm_readonly_url,
                skip=True,
                failures=failures,
            )
            summaries.append(lastfm_summary)
        summaries.extend(
            _collect_local_library_inventory(
                resolved_data_dir,
                failures,
                artist_mbid_evidence=artist_mbid_evidence,
                album_mbid_evidence=album_mbid_evidence,
                track_mbid_evidence=track_mbid_evidence,
            )
        )
        summaries.extend(_collect_rule_settings(resolved_data_dir, failures))

    report = _build_report(
        mode=normalized_mode,
        data_dir=resolved_data_dir,
        summaries=summaries,
        failures=failures,
        report_path=report_path,
    )

    if normalized_mode == "apply":
        try:
            apply_target = target or PsqlSubprocessTarget()
        except Exception as exc:
            failures.append(
                {
                    "source_family": "target",
                    "source_path": None,
                    "severity": "error",
                    "message": str(exc),
                }
            )
            report = _build_report(
                mode=normalized_mode,
                data_dir=resolved_data_dir,
                summaries=summaries,
                failures=failures,
                report_path=report_path,
            )
            apply_target = None
        if apply_target is not None:
            migration_run_id = apply_target.begin_migration_run(
                mode=normalized_mode,
                data_dir=resolved_data_dir,
            )
            status = "failed" if failures else "completed"
            try:
                if not failures:
                    _apply_summaries(apply_target, migration_run_id, summaries)
                else:
                    _record_source_summaries(apply_target, migration_run_id, summaries)
                report = _build_report(
                    mode=normalized_mode,
                    data_dir=resolved_data_dir,
                    summaries=summaries,
                    failures=failures,
                    report_path=report_path,
                )
            except Exception as exc:
                status = "failed"
                failures.append(
                    {
                        "source_family": "target",
                        "source_path": None,
                        "severity": "error",
                        "message": str(exc),
                    }
                )
                try:
                    _record_source_summaries(apply_target, migration_run_id, summaries)
                except Exception as summary_exc:
                    failures.append(
                        {
                            "source_family": "target",
                            "source_path": None,
                            "severity": "warning",
                            "message": f"Could not record source summaries after target failure: {summary_exc}",
                        }
                    )
                report = _build_report(
                    mode=normalized_mode,
                    data_dir=resolved_data_dir,
                    summaries=summaries,
                    failures=failures,
                    report_path=report_path,
                )
            try:
                apply_target.complete_migration_run(
                    migration_run_id,
                    status=status,
                    report=report,
                )
            except Exception as exc:
                failures.append(
                    {
                        "source_family": "target",
                        "source_path": None,
                        "severity": "error",
                        "message": f"Could not complete migration run: {exc}",
                    }
                )
                report = _build_report(
                    mode=normalized_mode,
                    data_dir=resolved_data_dir,
                    summaries=summaries,
                    failures=failures,
                    report_path=report_path,
                )

    if report_path is not None:
        report["report_path"] = str(Path(report_path).expanduser().resolve(strict=False))
        _write_report(Path(report_path), report)
    _print_report(report)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = build_arg_parser()
    args = parser.parse_args(argv)
    mode = "apply" if args.apply else "dry-run"
    report = run_migration(
        data_dir=args.data_dir,
        mode=mode,
        report_path=args.report,
        lastfm_readonly_url=args.lastfm_readonly_url,
        skip_lastfm_mbid_evidence=args.skip_lastfm_mbid_evidence,
    )
    return 1 if report["error_count"] else 0


def _collect_track_preferences(
    data_dir: Path,
    failures: list[dict[str, object]],
) -> list[dict[str, object]]:
    source_path = data_dir / "track_preferences.json"
    config = {
        "DATA_DIR": str(data_dir),
        "MUSIC_DIR": str(data_dir),
    }
    try:
        store = _load_track_preferences_store_for_migration(source_path)
        rows, skipped_count, warning_count = _track_preference_rows_from_store(store)
        if not rows and skipped_count == 0 and _has_legacy_track_preferences_payload(source_path):
            rows, skipped_count, warning_count = _legacy_track_preference_rows(source_path)
    except Exception as exc:
        failures.append(_source_failure("track_preferences", source_path, exc))
        return [
            _summary(
                source_family="track_preferences",
                source_path=source_path,
                error_count=1,
            )
        ]

    return [
        _summary(
            source_family="track_preferences",
            source_path=source_path,
            source_count=len(rows) + skipped_count,
            skipped_count=skipped_count,
            warning_count=warning_count,
            rows=rows,
        )
    ]


def _collect_listen_history(
    data_dir: Path,
    failures: list[dict[str, object]],
) -> list[dict[str, object]]:
    source_path = data_dir / "listen_history.json"
    try:
        items = _load_listen_history_for_migration(source_path)
    except Exception as exc:
        failures.append(_source_failure("listen_history", source_path, exc))
        return [
            _summary(
                source_family="listen_history",
                source_path=source_path,
                error_count=1,
            )
        ]

    rows: list[dict[str, object]] = []
    skipped_count = 0
    warning_count = 0
    for source_index, item in enumerate(items):
        if not isinstance(item, dict):
            skipped_count += 1
            continue
        listen_timestamp = _listen_history_timestamp(item)
        if listen_timestamp is None:
            skipped_count += 1
            warning_count += 1
            continue
        row = dict(item)
        row["_source_index"] = source_index
        row["_listen_timestamp"] = listen_timestamp
        rows.append(row)
    return [
        _summary(
            source_family="listen_history",
            source_path=source_path,
            source_count=len(items),
            skipped_count=skipped_count,
            warning_count=warning_count,
            rows=rows,
        )
    ]


def _collect_lastfm_settings(
    data_dir: Path,
    failures: list[dict[str, object]],
) -> list[dict[str, object]]:
    source_path = data_dir / "lastfm_settings.json"
    settings = _load_lastfm_settings_for_migration(source_path)

    username = str(settings.get("username") or "").strip()
    session_key = str(settings.get("session_key") or "").strip()
    connected_at = str(settings.get("connected_at") or "").strip()
    user_timezone = str(settings.get("user_timezone") or "").strip()
    settings_payload = {key: value for key, value in settings.items() if key != "session_key"}
    has_source_state = bool(
        username
        or session_key
        or connected_at
        or user_timezone
        or settings_payload
    )
    rows = {
        "settings": [],
        "sessions": [],
    }
    if has_source_state:
        rows["settings"].append(
            {
                "provider_username": username or None,
                "timezone_name": user_timezone or None,
                "settings_payload": {
                    "source": MIGRATION_NAME,
                    "source_family": "lastfm_settings",
                    "source_file": "lastfm_settings.json",
                    "settings_payload": settings_payload,
                },
            }
        )
    if username and session_key:
        rows["sessions"].append(
            {
                "provider_username": username,
                "session_key": session_key,
                "metadata": {
                    "source": MIGRATION_NAME,
                    "source_family": "lastfm_settings",
                    "source_file": "lastfm_settings.json",
                    "source_payload": settings_payload,
                    "connected_at": connected_at,
                },
            }
        )
    summary = _summary(
        source_family="lastfm_settings",
        source_path=source_path,
        source_count=1 if settings else 0,
        rows=rows,
    )
    summary.update(
        {
            "settings_count": len(rows["settings"]),
            "session_count": len(rows["sessions"]),
        }
    )
    return [summary]


def _collect_lastfm_sync_state(
    data_dir: Path,
    failures: list[dict[str, object]],
) -> list[dict[str, object]]:
    source_path = data_dir / "lastfm_sync_state.json"
    sync_state = _load_lastfm_sync_state_for_migration(source_path)

    pending_items = sync_state.get("pending_scrobbles")
    problem_items = sync_state.get("sync_problems")
    retry_summary = sync_state.get("last_retry_summary")
    pending_scrobbles = pending_items if isinstance(pending_items, dict) else {}
    sync_problems = problem_items if isinstance(problem_items, dict) else {}
    last_retry_summary = retry_summary if isinstance(retry_summary, dict) else {}

    pending_sync_items, skipped_pending_count = _valid_lastfm_sync_items(pending_scrobbles)
    problem_sync_items, skipped_problem_count = _valid_lastfm_sync_items(sync_problems)
    skipped_count = skipped_pending_count + skipped_problem_count
    pending_rows = [
        _pending_scrobble_row(source_key, payload, source_path=source_path)
        for source_key, payload in pending_sync_items
    ]
    problem_rows = [
        _sync_problem_retry_row(source_key, payload, source_path=source_path)
        for source_key, payload in problem_sync_items
    ]
    retry_rows = []
    if last_retry_summary:
        retry_rows.append(_retry_summary_row(last_retry_summary, source_path=source_path))

    rows = {
        "pending_scrobbles": pending_rows,
        "sync_problems": problem_rows,
        "last_retry_summary": retry_rows,
    }
    source_count = len(pending_rows) + len(problem_rows) + len(retry_rows) + skipped_count
    summary = _summary(
        source_family="lastfm_sync_state",
        source_path=source_path,
        source_count=source_count,
        skipped_count=skipped_count,
        warning_count=skipped_count,
        rows=rows,
    )
    summary.update(
        {
            "pending_scrobble_count": len(pending_rows),
            "sync_problem_count": len(problem_rows),
            "retry_summary_count": len(retry_rows),
        }
    )
    return [summary]


def _collect_cover_lookup_notifications(
    data_dir: Path,
    failures: list[dict[str, object]],
) -> list[dict[str, object]]:
    source_path = data_dir / "cover_lookup_notifications.json"
    payload = _load_json_object_default(source_path, default={"tasks": []})
    items = payload.get("tasks", []) if isinstance(payload, dict) else []
    if not isinstance(items, list):
        items = []

    rows: list[dict[str, object]] = []
    skipped_count = 0
    for source_index, item in enumerate(items):
        if not isinstance(item, dict):
            skipped_count += 1
            continue
        task_id = str(item.get("id") or "").strip()
        if not task_id:
            skipped_count += 1
            continue
        status = _normalize_cover_lookup_status(item.get("status"))
        if status is None:
            skipped_count += 1
            continue
        rows.append(
            _cover_lookup_notification_row(
                item,
                task_id=task_id,
                status=status,
                source_path=source_path,
                source_index=source_index,
            )
        )

    summary = _summary(
        source_family="cover_lookup_notifications",
        source_path=source_path,
        source_count=len(rows) + skipped_count,
        skipped_count=skipped_count,
        warning_count=0,
        rows=rows,
    )
    summary.update(
        {
            "terminal_task_count": len(rows),
            "provider_cache_decision": (
                "cover_search_cache.json remains file-backed as a replaceable "
                "provider result cache; Phase 6 only backfills terminal task notification metadata."
            ),
        }
    )
    return [summary]


def _collect_saved_loops(
    data_dir: Path,
    failures: list[dict[str, object]],
) -> list[dict[str, object]]:
    source_path = data_dir / "loops" / "loops.json"
    items = _load_loop_items_for_migration(source_path)

    rows: list[dict[str, object]] = []
    skipped_count = 0
    warning_count = 0
    for source_index, item in enumerate(items):
        if not isinstance(item, dict):
            skipped_count += 1
            continue
        loop_key = str(item.get("id") or "").strip()
        if not loop_key:
            skipped_count += 1
            continue
        start_seconds = _strict_float_or_none(item.get("start_seconds"))
        end_seconds = _strict_float_or_none(item.get("end_seconds"))
        if start_seconds is None or end_seconds is None or end_seconds <= start_seconds:
            skipped_count += 1
            warning_count += 1
            continue
        rows.append(
            _saved_loop_row(
                item,
                loop_key=loop_key,
                start_seconds=start_seconds,
                end_seconds=end_seconds,
                source_path=source_path,
                source_index=source_index,
            )
        )

    summary = _summary(
        source_family="saved_loops",
        source_path=source_path,
        source_count=len(items),
        skipped_count=skipped_count,
        warning_count=warning_count,
        rows=rows,
    )
    summary.update(
        {
            "saved_loop_count": len(rows),
            "media_storage_decision": (
                "Only saved loop metadata is backfilled. Loop audio files, pitch "
                "previews, failed preview cleanup, delete path guards, and media "
                "routes remain filesystem-backed."
            ),
        }
    )
    return [summary]


def _collect_discovery_center_preferences(
    data_dir: Path,
    failures: list[dict[str, object]],
) -> list[dict[str, object]]:
    source_path = data_dir / "discovery_center_preferences.json"
    try:
        payload = _load_discovery_center_preferences_for_migration(source_path)
    except Exception as exc:
        failures.append(_source_failure("discovery_center_preferences", source_path, exc))
        return [
            _summary(
                source_family="discovery_center_preferences",
                source_path=source_path,
                error_count=1,
            )
        ]
    if not source_path.exists():
        return [
            _summary(
                source_family="discovery_center_preferences",
                source_path=source_path,
            )
        ]
    row = {
        "preference_scope": str(payload.get("preference_scope") or "local_first_single_viewer"),
        "preferences_payload": {
            "source_toggles": payload.get("source_toggles"),
            "delivery": payload.get("delivery"),
        },
        "metadata": {
            "source": MIGRATION_NAME,
            "source_family": "discovery_center_preferences",
        },
    }
    return [
        _summary(
            source_family="discovery_center_preferences",
            source_path=source_path,
            source_count=1,
            rows=[row],
        )
    ]


def _load_lastfm_settings_for_migration(source_path: Path) -> dict[str, object]:
    return _load_json_object_default(source_path, default={})


def _load_lastfm_sync_state_for_migration(source_path: Path) -> dict[str, object]:
    payload = _load_json_object_default(
        source_path,
        default={
            "pending_scrobbles": {},
            "sync_problems": {},
            "last_retry_summary": {},
        },
    )
    return payload if isinstance(payload, dict) else {}


def _load_loop_items_for_migration(source_path: Path) -> list[object]:
    try:
        payload = json.loads(source_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError, UnicodeDecodeError):
        return []
    items = payload.get("loops") if isinstance(payload, dict) else payload
    if not isinstance(items, list):
        return []
    return items


def _saved_loop_row(
    payload: dict[str, object],
    *,
    loop_key: str,
    start_seconds: float,
    end_seconds: float,
    source_path: Path,
    source_index: int,
) -> dict[str, object]:
    created_at = _normalize_listen_timestamp(payload.get("created_at"))
    sanitized_payload = _sanitize_json_payload(payload)
    metadata = {
        "source_family": "saved_loops",
        "source": MIGRATION_NAME,
        "source_file": source_path.name,
        "source_path": str(source_path),
        "source_key": str(payload.get("source_key") or loop_key),
        "source_index": payload.get("source_index", source_index),
        "source_payload": sanitized_payload,
        "name": str(payload.get("name") or ""),
        "duration_seconds": _strict_float_or_none(payload.get("duration_seconds")),
        "artist": str(payload.get("artist") or ""),
        "title": str(payload.get("title") or ""),
        "album": str(payload.get("album") or ""),
        "cover_path": str(payload.get("cover_path") or ""),
        "source_loop_media_path": str(payload.get("path") or ""),
        "source_audio_private_path": str(payload.get("source_path") or ""),
        "loop_media_storage": "filesystem-backed",
        "pitch_preview_storage": "filesystem-backed",
        "media_serving": "filesystem-backed",
        "failed_preview_cleanup": "filesystem-backed",
    }
    if payload.get("source_file") is not None:
        metadata["source_file"] = str(payload.get("source_file") or "")
    return {
        "loop_key": loop_key,
        "source_private_path": str(payload.get("source_path") or ""),
        "loop_private_path": str(payload.get("path") or ""),
        "start_seconds": start_seconds,
        "end_seconds": end_seconds,
        "created_at": created_at or "1970-01-01T00:00:00+00:00",
        "parent_loop_key": str(payload.get("parent_loop_id") or "").strip(),
        "metadata": metadata,
    }


def _load_json_object_default(source_path: Path, *, default: dict[str, object]) -> dict[str, object]:
    try:
        payload = json.loads(source_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError, UnicodeDecodeError):
        return dict(default)
    return payload if isinstance(payload, dict) else dict(default)


def _load_json_list_default(source_path: Path) -> list[object]:
    try:
        payload = json.loads(source_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError, UnicodeDecodeError):
        return []
    return payload if isinstance(payload, list) else []


def _load_json_list_or_key_default(source_path: Path, key: str) -> list[object]:
    try:
        payload = json.loads(source_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError, UnicodeDecodeError):
        return []
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        keyed_payload = payload.get(key)
        return keyed_payload if isinstance(keyed_payload, list) else []
    return []


def _load_json_object_or_key_default(source_path: Path, key: str) -> dict[str, object]:
    try:
        payload = json.loads(source_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError, UnicodeDecodeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    keyed_payload = payload.get(key)
    if isinstance(keyed_payload, dict):
        return keyed_payload
    return payload


def _load_track_preferences_store_for_migration(source_path: Path) -> dict[str, object]:
    if not source_path.exists():
        payload = {}
    else:
        payload = json.loads(source_path.read_text(encoding="utf-8"))
    return normalize_track_preferences_store(payload)


def _load_discovery_center_preferences_for_migration(source_path: Path) -> dict[str, object]:
    payload = _load_json_object_default(source_path, default={})
    preferences = normalize_discovery_center_preferences_for_migration(payload)
    return {
        "preference_scope": "local_first_single_viewer",
        "source_toggles": preferences.get("source_toggles"),
        "delivery": preferences.get("delivery"),
    }


def _load_library_root_settings_for_migration(
    source_path: Path,
    config: dict[str, object],
) -> dict[str, object]:
    if source_path.exists():
        payload = json.loads(source_path.read_text(encoding="utf-8"))
    else:
        payload = {}
    fallback_main_root = Path(str(config.get("MUSIC_DIR") or ".")).expanduser().resolve(strict=False)
    return library_roots.normalize_library_root_settings(
        payload,
        fallback_main_root=fallback_main_root,
    )


def _library_roots_settings_path_for_migration(config: dict[str, object]) -> Path:
    explicit = config.get("LIBRARY_ROOTS_PATH")
    if explicit:
        return Path(str(explicit)).expanduser().resolve()
    base_dir = config.get("DATA_DIR") or config.get("MUSIC_DIR") or "."
    return (Path(str(base_dir)).expanduser().resolve() / "library_roots.json").resolve()


def _normalize_cover_lookup_status(value: object) -> str | None:
    status = str(value or "").strip().casefold()
    if status in {"completed", "failed", "canceled"}:
        return status
    return None


def _cover_lookup_notification_row(
    payload: dict[str, object],
    *,
    task_id: str,
    status: str,
    source_path: Path,
    source_index: int,
) -> dict[str, object]:
    completed_at = (
        _normalize_listen_timestamp(payload.get("notification_completed_at"))
        or _normalize_listen_timestamp(payload.get("finished_at"))
        or _normalize_listen_timestamp(payload.get("updated_at"))
        or _normalize_listen_timestamp(payload.get("created_at"))
    )
    requested_at = (
        _normalize_listen_timestamp(payload.get("created_at"))
        or completed_at
        or "1970-01-01T00:00:00+00:00"
    )
    sanitized_payload = _sanitize_json_payload(payload)
    provider_payload = _cover_lookup_provider_payload(sanitized_payload)
    metadata = {
        "source_family": "cover_lookup_notifications",
        "source": MIGRATION_NAME,
        "source_file": source_path.name,
        "source_path": str(source_path),
        "source_key": task_id,
        "source_index": source_index,
        "notification_action_taken": bool(payload.get("notification_action_taken")),
        "notification_completed_at": completed_at,
        "notification_expires_at": str(payload.get("notification_expires_at") or ""),
        "track_paths": _string_list(payload.get("track_paths")),
        "source_payload": sanitized_payload,
    }
    return {
        "task_key": task_id,
        "status": status,
        "requested_at": requested_at,
        "completed_at": completed_at,
        "album_key": _cover_lookup_album_key(payload),
        "selected_cover_private_path": _selected_cover_private_path(payload),
        "provider_payload": provider_payload,
        "error_message": _cover_lookup_error_message(payload, status),
        "metadata": metadata,
    }


def _cover_lookup_provider_payload(payload: dict[str, object]) -> dict[str, object]:
    provider_payload: dict[str, object] = {}
    for key in (
        "possible_matches",
        "manual_urls",
        "selected_candidate_id",
        "caa_empty_notice",
        "job_contract",
    ):
        if key in payload:
            provider_payload[key] = payload.get(key)
    return provider_payload


def _cover_lookup_album_key(payload: dict[str, object]) -> str | None:
    album_payload = payload.get("album_payload")
    album_payload_dict = album_payload if isinstance(album_payload, dict) else {}
    artist = str(
        payload.get("artist")
        or payload.get("album_artist")
        or album_payload_dict.get("album_artist")
        or ""
    ).strip()
    album = str(
        payload.get("album")
        or payload.get("name")
        or album_payload_dict.get("name")
        or album_payload_dict.get("album")
        or ""
    ).strip()
    year = str(payload.get("year") or album_payload_dict.get("year") or "").strip()
    parts = [_local_inventory_key(part) for part in (artist, album, year) if str(part or "").strip()]
    return "|".join(parts) if artist or album or year else None


def _selected_cover_private_path(payload: dict[str, object]) -> str | None:
    for key in (
        "selected_cover_private_path",
        "selected_cover_path",
        "local_cover_path",
        "cover_path",
    ):
        value = _local_private_cover_path(payload.get(key))
        if value:
            return value
    updated_albums = payload.get("updated_albums")
    if isinstance(updated_albums, list):
        for album in updated_albums:
            if not isinstance(album, dict):
                continue
            for key in (
                "selected_cover_private_path",
                "selected_cover_path",
                "local_cover_path",
                "cover_path",
            ):
                value = _local_private_cover_path(album.get(key))
                if value:
                    return value
    return None


def _local_private_cover_path(value: object) -> str | None:
    candidate = str(value or "").strip()
    if candidate and not candidate.lower().startswith(("http://", "https://")):
        return candidate
    return None


def _cover_lookup_error_message(payload: dict[str, object], status: str) -> str | None:
    for key in ("error", "error_message", "message"):
        value = str(payload.get(key) or "").strip()
        if value and (status in {"failed", "canceled"} or key != "message"):
            return value
    return None


def _string_list(value: object) -> list[str]:
    if not isinstance(value, list | tuple | set):
        return []
    return [str(item).strip() for item in value if str(item or "").strip()]


def _sanitize_json_payload(value: object) -> object:
    if isinstance(value, dict):
        sanitized: dict[str, object] = {}
        for key, item in value.items():
            normalized_key = str(key or "")
            if normalized_key in {"prefetched_raw_bytes", "raw_bytes"}:
                continue
            if isinstance(item, bytes):
                continue
            sanitized[normalized_key] = _sanitize_json_payload(item)
        return sanitized
    if isinstance(value, list):
        return [_sanitize_json_payload(item) for item in value]
    if isinstance(value, tuple | set):
        return [_sanitize_json_payload(item) for item in value]
    if isinstance(value, bytes):
        return None
    return value


def _valid_lastfm_sync_items(items: dict[object, object]) -> tuple[list[tuple[object, dict[str, object]]], int]:
    valid_items = []
    skipped_count = 0
    for source_key, payload in sorted(items.items(), key=lambda item: str(item[0])):
        if not str(source_key or "").strip() or not isinstance(payload, dict):
            skipped_count += 1
            continue
        valid_items.append((source_key, payload))
    return valid_items, skipped_count


def _collect_library_root_settings(
    data_dir: Path,
    failures: list[dict[str, object]],
) -> list[dict[str, object]]:
    config = {
        "DATA_DIR": str(data_dir),
        "MUSIC_DIR": os.environ.get("MUSIC_DIR", ""),
        "LIBRARY_ROOTS_PATH": os.environ.get(
            "MUSIC_LIBRARY_ROOTS_PATH",
            str(data_dir / "library_roots.json"),
        ),
    }
    source_path = _library_roots_settings_path_for_migration(config)
    fallback_used = not source_path.exists()
    try:
        settings = _load_library_root_settings_for_migration(source_path, config)
    except Exception as exc:
        failures.append(_source_failure("library_root_settings", source_path, exc))
        summary = _summary(
            source_family="library_root_settings",
            source_path=source_path,
            error_count=1,
        )
        summary.update(
            {
                "root_count": 0,
                "settings_count": 0,
                "move_policy_count": 0,
                "provenance_count": 0,
                "fallback_used": fallback_used,
            }
        )
        return [summary]

    root_rows = _library_root_rows_from_settings(settings)
    policy_rows = _move_policy_rows_from_settings(settings)
    provenance_rows = _library_root_provenance_rows(root_rows, source_path=source_path)
    rows = {
        "roots": root_rows,
        "settings": [_library_root_settings_row(settings, root_rows)],
        "move_policy": policy_rows,
        "provenance": provenance_rows,
    }
    source_count = (
        len(root_rows)
        + len(rows["settings"])
        + len(policy_rows)
        + len(provenance_rows)
    )
    summary = _summary(
        source_family="library_root_settings",
        source_path=source_path,
        source_count=source_count,
        rows=rows,
    )
    summary.update(
        {
            "root_count": len(root_rows),
            "settings_count": len(rows["settings"]),
            "move_policy_count": len(policy_rows),
            "provenance_count": len(provenance_rows),
            "fallback_used": fallback_used,
        }
    )
    return [summary]


def _collect_rule_settings(
    data_dir: Path,
    failures: list[dict[str, object]],
) -> list[dict[str, object]]:
    collectors = (
        (
            "ignored_versions",
            data_dir / "ignored_versions.json",
            lambda path: sorted(_load_json_list_or_key_default(path, "ignored_version_keys")),
            _rule_key_rows,
        ),
        (
            "ignored_repairs",
            data_dir / "ignored_repairs.json",
            lambda path: sorted(_load_json_list_or_key_default(path, "ignored_row_keys")),
            _rule_key_rows,
        ),
        (
            "manual_versions",
            data_dir / "manual_versions.json",
            lambda path: dict(sorted(_load_json_object_or_key_default(path, "manual_version_links").items())),
            _manual_version_rows,
        ),
        (
            "separate_releases",
            data_dir / "separate_releases.json",
            lambda path: sorted(_load_json_list_or_key_default(path, "separate_release_keys")),
            _rule_key_rows,
        ),
        (
            "exception_overrides",
            data_dir / "exception_overrides.json",
            lambda path: dict(sorted(_load_json_object_or_key_default(path, "items").items())),
            _exception_override_rows,
        ),
    )
    summaries: list[dict[str, object]] = []
    for source_family, source_path, load_values, row_builder in collectors:
        try:
            values = load_values(source_path)
        except Exception as exc:
            if _is_quiet_rule_shape_exception(exc):
                values = {}
            else:
                failures.append(_source_failure(source_family, source_path, exc))
                summaries.append(
                    _summary(
                        source_family=source_family,
                        source_path=source_path,
                        error_count=1,
                    )
                )
                continue
        rows = row_builder(source_family, source_path, values)
        summaries.append(
            _summary(
                source_family=source_family,
                source_path=source_path,
                source_count=len(rows),
                rows=rows,
            )
        )
    return summaries


def _is_quiet_rule_shape_exception(exc: Exception) -> bool:
    return isinstance(exc, AttributeError) and "object has no attribute 'get'" in str(exc)


def _rule_key_rows(source_family: str, source_path: Path, values: object) -> list[dict[str, object]]:
    if not isinstance(values, list):
        return []
    rows: list[dict[str, object]] = []
    for value in values:
        rule_key = str(value or "").strip()
        if not rule_key:
            continue
        rows.append(
            {
                "rule_key": rule_key,
                "metadata": _rule_source_metadata(
                    source_family=source_family,
                    source_path=source_path,
                    source_payload={"key": rule_key},
                ),
            }
        )
    return rows


def _manual_version_rows(source_family: str, source_path: Path, values: object) -> list[dict[str, object]]:
    if not isinstance(values, dict):
        return []
    rows: list[dict[str, object]] = []
    for child_key, parent_key in values.items():
        child = str(child_key or "").strip()
        parent = str(parent_key or "").strip()
        if not child or not parent or child == parent:
            continue
        rows.append(
            {
                "child_key": child,
                "parent_key": parent,
                "metadata": _rule_source_metadata(
                    source_family=source_family,
                    source_path=source_path,
                    source_payload={
                        "child_key": child,
                        "parent_key": parent,
                    },
                ),
            }
        )
    return rows


def _exception_override_rows(source_family: str, source_path: Path, values: object) -> list[dict[str, object]]:
    if not isinstance(values, dict):
        return []
    rows: list[dict[str, object]] = []
    for track_key, exception_type in values.items():
        normalized_track_key = str(track_key or "").strip()
        if not normalized_track_key:
            continue
        normalized_exception_type = normalize_exception_value(exception_type)
        rows.append(
            {
                "track_key": normalized_track_key,
                "override_payload": _rule_source_metadata(
                    source_family=source_family,
                    source_path=source_path,
                    source_payload={
                        "track_key": normalized_track_key,
                        "exception_type": normalized_exception_type,
                    },
                    extra={
                        "track_key": normalized_track_key,
                        "exception_type": normalized_exception_type,
                    },
                ),
            }
        )
    return rows


def _rule_source_metadata(
    *,
    source_family: str,
    source_path: Path,
    source_payload: dict[str, object],
    extra: dict[str, object] | None = None,
) -> dict[str, object]:
    metadata: dict[str, object] = {
        "source": MIGRATION_NAME,
        "source_family": source_family,
        "source_file": source_path.name,
        "source_path": str(source_path),
        "source_payload": source_payload,
    }
    if extra:
        metadata.update(extra)
    return metadata


def _collect_local_library_inventory(
    data_dir: Path,
    failures: list[dict[str, object]],
    *,
    artist_mbid_evidence: dict[str, list[dict[str, object]]] | None = None,
    album_mbid_evidence: dict[tuple[str, str], list[dict[str, object]]] | None = None,
    track_mbid_evidence: dict[tuple[str, str], list[dict[str, object]]] | None = None,
) -> list[dict[str, object]]:
    source_path = data_dir / "library_cache.json"
    file_cache, _last_scan, _relation_views, _relations_last_built, error = load_cache_snapshot_from_disk(
        source_path,
        data_dir,
    )
    if not file_cache and not error and source_path.exists():
        payload_identity = _library_cache_payload_identity(source_path)
        if payload_identity is not None and payload_identity != data_dir:
            file_cache, _last_scan, _relation_views, _relations_last_built, error = load_cache_snapshot_from_disk(
                source_path,
                payload_identity,
            )
    if error:
        failures.append(
            {
                "source_family": "local_library_inventory",
                "source_path": str(source_path),
                "severity": "error",
                "message": error,
            }
        )
        return [
            _summary(
                source_family="local_library_inventory",
                source_path=source_path,
                error_count=1,
            )
        ]

    inventory = _local_inventory_rows_from_file_cache(
        file_cache,
        file_cache_root=_library_cache_payload_root_path(source_path, fallback=data_dir),
        artist_mbid_evidence=artist_mbid_evidence,
        album_mbid_evidence=album_mbid_evidence,
        track_mbid_evidence=track_mbid_evidence,
    )
    source_count = sum(
        len(inventory[key]) for key in ("artists", "albums", "featured_artists", "tracks", "track_files")
    )
    summary = _summary(
        source_family="local_library_inventory",
        source_path=source_path,
        source_count=source_count,
        rows=inventory,
    )
    summary.update(
        {
            "artist_count": len(inventory["artists"]),
            "album_count": len(inventory["albums"]),
            "featured_artist_count": len(inventory["featured_artists"]),
            "track_count": len(inventory["tracks"]),
            "track_file_count": len(inventory["track_files"]),
            "artist_mbid_assertion_count": len(inventory["artist_mbid_assertions"]),
            "album_mbid_review_assertion_count": sum(
                1 for row in inventory["local_mbid_assertions"]
                if row.get("target_kind") == "album"
            ),
            "track_mbid_review_assertion_count": sum(
                1 for row in inventory["local_mbid_assertions"]
                if row.get("target_kind") == "track"
            ),
            "local_mbid_review_assertion_count": len(inventory["local_mbid_assertions"]),
        }
    )
    return [summary]


def _local_artist_names_from_cache(
    data_dir: Path,
    failures: list[dict[str, object]],
) -> list[str]:
    source_path = data_dir / "library_cache.json"
    file_cache, _last_scan, _relation_views, _relations_last_built, error = load_cache_snapshot_from_disk(
        source_path,
        data_dir,
    )
    if not file_cache and not error and source_path.exists():
        payload_identity = _library_cache_payload_identity(source_path)
        if payload_identity is not None and payload_identity != data_dir:
            file_cache, _last_scan, _relation_views, _relations_last_built, error = load_cache_snapshot_from_disk(
                source_path,
                payload_identity,
            )
    if error:
        failures.append(
            {
                "source_family": "lastfm_mbid_evidence",
                "source_path": str(source_path),
                "severity": "error",
                "message": f"Could not collect local artists for Last.fm MBID evidence: {error}",
            }
        )
        return []

    inventory = _local_inventory_rows_from_file_cache(file_cache)
    return sorted(
        {
            str(row.get("name") or "").strip()
            for row in inventory.get("artists", [])
            if isinstance(row, dict) and str(row.get("name") or "").strip()
        },
        key=str.casefold,
    )


def _lastfm_evidence_for_migration(
    artist_names: list[str],
    *,
    source: object | None,
    readonly_url: str | None,
    skip: bool,
    failures: list[dict[str, object]],
) -> tuple[
    dict[str, list[dict[str, object]]],
    dict[tuple[str, str], list[dict[str, object]]],
    dict[tuple[str, str], list[dict[str, object]]],
    dict[str, object],
]:
    if skip:
        return {}, {}, {}, _lastfm_evidence_summary(skipped_count=1)
    if source is None:
        if not readonly_url:
            return {}, {}, {}, _lastfm_evidence_summary(
                skipped_count=1,
                warning_count=1,
                message="Last.fm MBID evidence skipped because no read-only URL was configured.",
            )
        try:
            source = LastfmReadonlySubprocessSource(database_url=readonly_url)
        except Exception as exc:
            failures.append(
                {
                    "source_family": "lastfm_mbid_evidence",
                    "source_path": "lastfm.public",
                    "severity": "error",
                    "message": str(exc),
                }
            )
            return {}, {}, {}, _lastfm_evidence_summary(error_count=1, message=str(exc))
    try:
        return collect_lastfm_mbid_evidence_for_local_targets(artist_names, source=source)
    except Exception as exc:
        failures.append(
            {
                "source_family": "lastfm_mbid_evidence",
                "source_path": "lastfm.public",
                "severity": "error",
                "message": str(exc),
            }
        )
        return {}, {}, {}, _lastfm_evidence_summary(error_count=1, message=str(exc))


def collect_lastfm_mbid_evidence_for_artists(
    artist_names: list[str],
    *,
    source: object,
) -> tuple[dict[str, list[dict[str, object]]], dict[str, object]]:
    artist_evidence, _album_evidence, _track_evidence, summary = (
        collect_lastfm_mbid_evidence_for_local_targets(artist_names, source=source)
    )
    return artist_evidence, summary


def collect_lastfm_mbid_evidence_for_local_targets(
    artist_names: list[str],
    *,
    source: object,
) -> tuple[
    dict[str, list[dict[str, object]]],
    dict[tuple[str, str], list[dict[str, object]]],
    dict[tuple[str, str], list[dict[str, object]]],
    dict[str, object],
]:
    normalized_artist_names = sorted(
        {_local_inventory_key(name) for name in artist_names if _local_inventory_key(name)}
    )
    if not normalized_artist_names:
        return {}, {}, {}, _lastfm_evidence_summary()

    filter_sql = _lastfm_artist_filter_sql(normalized_artist_names)
    available_columns = _lastfm_available_columns(source)
    source_specs = [
        (
            "artist_mbid_count",
            "lastfm.public.artists",
            "artists",
            {"name", "mbid"},
            0.98,
            f"""
                select
                  artists.name as artist_name,
                  artists.mbid as mbid,
                  ctid::text as provider_row
                from public.artists as artists
                where artists.mbid is not null
                  and btrim(artists.mbid::text) <> ''
                  and lower(btrim(artists.name::text)) in ({filter_sql})
                order by lower(btrim(artists.name::text)), artists.mbid::text, ctid::text
            """,
        ),
        (
            "album_mbid_count",
            "lastfm.public.albums",
            "albums",
            {"artist", "title", "mbid"},
            0.94,
            f"""
                select
                  albums.artist as artist_name,
                  albums.title as album_title,
                  albums.mbid as mbid,
                  ctid::text as provider_row
                from public.albums as albums
                where albums.mbid is not null
                  and btrim(albums.mbid::text) <> ''
                  and lower(btrim(albums.artist::text)) in ({filter_sql})
                order by lower(btrim(albums.artist::text)), lower(btrim(albums.title::text)), albums.mbid::text, ctid::text
            """,
        ),
        (
            "track_artist_mbid_count",
            "lastfm.public.tracks.artist_mbid",
            "tracks",
            {"artist", "title", "artist_mbid"},
            0.93,
            f"""
                select
                  tracks.artist as artist_name,
                  tracks.title as track_title,
                  tracks.artist_mbid as mbid,
                  ctid::text as provider_row
                from public.tracks as tracks
                where tracks.artist_mbid is not null
                  and btrim(tracks.artist_mbid::text) <> ''
                  and lower(btrim(tracks.artist::text)) in ({filter_sql})
                order by lower(btrim(tracks.artist::text)), lower(btrim(tracks.title::text)), tracks.artist_mbid::text, ctid::text
            """,
        ),
        (
            "track_mbid_count",
            "lastfm.public.tracks.mbid",
            "tracks",
            {"artist", "title", "mbid"},
            0.94,
            f"""
                select
                  tracks.artist as artist_name,
                  tracks.title as track_title,
                  tracks.mbid as mbid,
                  ctid::text as provider_row
                from public.tracks as tracks
                where tracks.mbid is not null
                  and btrim(tracks.mbid::text) <> ''
                  and lower(btrim(tracks.artist::text)) in ({filter_sql})
                order by lower(btrim(tracks.artist::text)), lower(btrim(tracks.title::text)), tracks.mbid::text, ctid::text
            """,
        ),
    ]
    evidence_by_artist: dict[str, list[dict[str, object]]] = {}
    evidence_by_album: dict[tuple[str, str], list[dict[str, object]]] = {}
    evidence_by_track: dict[tuple[str, str], list[dict[str, object]]] = {}
    warning_messages: list[str] = []
    counts = {
        "artist_mbid_count": 0,
        "album_mbid_count": 0,
        "track_artist_mbid_count": 0,
        "track_mbid_count": 0,
    }

    for count_key, evidence_source, table_name, required_columns, confidence, sql in source_specs:
        missing_columns = sorted(required_columns - available_columns.get(table_name, set()))
        if missing_columns:
            warning_messages.append(
                f"{evidence_source} skipped because public.{table_name} is missing columns: "
                f"{', '.join(missing_columns)}."
            )
            continue
        rows = source.query_json(sql)
        counts[count_key] = len(rows)
        for row in rows:
            artist_key = _local_inventory_key(row.get("artist_name"))
            mbid = str(row.get("mbid") or "").strip()
            if not artist_key or not mbid:
                continue
            evidence_item = {
                "mbid": mbid,
                "confidence": confidence,
                "source": evidence_source,
                "payload": {
                    key: value
                    for key, value in row.items()
                    if key not in {"mbid"}
                },
            }
            if evidence_source in {"lastfm.public.artists", "lastfm.public.tracks.artist_mbid"}:
                evidence_by_artist.setdefault(artist_key, []).append(evidence_item)
            elif evidence_source == "lastfm.public.albums":
                album_key = _local_inventory_key(row.get("album_title"))
                if album_key:
                    evidence_by_album.setdefault((artist_key, album_key), []).append(evidence_item)
            elif evidence_source == "lastfm.public.tracks.mbid":
                track_key = _local_inventory_key(row.get("track_title"))
                if track_key:
                    evidence_by_track.setdefault((artist_key, track_key), []).append(evidence_item)

    return evidence_by_artist, evidence_by_album, evidence_by_track, _lastfm_evidence_summary(
        source_count=sum(counts.values()),
        warning_count=len(warning_messages),
        message=" ".join(warning_messages) if warning_messages else None,
        warning_messages=warning_messages,
        counts=counts,
    )


def _lastfm_available_columns(source: object) -> dict[str, set[str]]:
    rows = source.query_json(
        """
            select
              columns.table_name,
              columns.column_name
            from information_schema.columns as columns
            where columns.table_schema = 'public'
              and columns.table_name in ('artists', 'albums', 'tracks')
        """
    )
    available: dict[str, set[str]] = {
        "artists": set(),
        "albums": set(),
        "tracks": set(),
    }
    for row in rows:
        table_name = str(row.get("table_name") or "").strip()
        column_name = str(row.get("column_name") or "").strip()
        if table_name in available and column_name:
            available[table_name].add(column_name)
    return available


def _lastfm_artist_filter_sql(normalized_artist_names: list[str]) -> str:
    return ", ".join(_sql_literal(name) for name in normalized_artist_names)


def _lastfm_evidence_summary(
    *,
    source_count: int = 0,
    skipped_count: int = 0,
    warning_count: int = 0,
    error_count: int = 0,
    message: str | None = None,
    warning_messages: list[str] | None = None,
    counts: dict[str, int] | None = None,
) -> dict[str, object]:
    summary = _summary(
        source_family="lastfm_mbid_evidence",
        source_path=Path("lastfm.public"),
        source_count=source_count,
        skipped_count=skipped_count,
        warning_count=warning_count,
        error_count=error_count,
    )
    summary.update(
        {
            "artist_mbid_count": 0,
            "album_mbid_count": 0,
            "track_artist_mbid_count": 0,
            "track_mbid_count": 0,
        }
    )
    if counts:
        summary.update(counts)
    if message:
        summary["message"] = message
    if warning_messages:
        summary["warning_messages"] = warning_messages
    return summary


def _local_inventory_rows_from_file_cache(
    file_cache: dict[str, dict[str, object]],
    *,
    file_cache_root: object = None,
    artist_mbid_evidence: dict[str, list[dict[str, object]]] | None = None,
    album_mbid_evidence: dict[tuple[str, str], list[dict[str, object]]] | None = None,
    track_mbid_evidence: dict[tuple[str, str], list[dict[str, object]]] | None = None,
) -> dict[str, list[dict[str, object]]]:
    albums = build_albums_from_file_cache(file_cache)
    file_entries_by_path = {str(entry.get("path") or path): entry for path, entry in file_cache.items()}
    artists: dict[str, dict[str, object]] = {}
    album_rows: list[dict[str, object]] = []
    featured_artist_rows: list[dict[str, object]] = []
    track_rows: list[dict[str, object]] = []
    track_file_rows: list[dict[str, object]] = []
    local_mbid_assertion_rows: list[dict[str, object]] = []
    seen_featured_rows: set[tuple[str, str, str, str]] = set()
    album_evidence_map = album_mbid_evidence or {}
    track_evidence_map = track_mbid_evidence or {}

    def ensure_artist(name: object) -> str | None:
        artist_name = str(name or "").strip()
        if not artist_name:
            return None
        artist_key = _local_inventory_key(artist_name)
        artists.setdefault(
            artist_key,
            {
                "artist_key": artist_key,
                "name": artist_name,
                "sort_name": artist_name.casefold(),
                "metadata": {"source": MIGRATION_NAME},
            },
        )
        return artist_key

    for album in albums:
        album_artist_key = ensure_artist(getattr(album, "album_artist", None))
        member_artist_names = _deduped_artist_names(getattr(album, "artists", []) or [])
        if not member_artist_names:
            owner_name = str(getattr(album, "album_artist", None) or "").strip()
            if owner_name:
                member_artist_names = [owner_name]
        for member in member_artist_names:
            ensure_artist(member)
        album_title = str(getattr(album, "name", "") or "").strip() or "Unknown Album"
        album_key = str(getattr(album, "key", "") or "").strip()
        owner_name = str(getattr(album, "album_artist", None) or "").strip()
        owner_key = _local_inventory_key(owner_name) if owner_name else None
        track_artist_names: list[str] = []
        album_evidence_key = (
            _local_inventory_key(getattr(album, "album_artist", None)),
            _local_inventory_key(album_title),
        )
        album_exact_evidence = album_evidence_map.get(album_evidence_key, [])
        album_review_evidence = (
            album_exact_evidence
            if album_exact_evidence
            else _related_local_mbid_evidence(album_evidence_map, album_evidence_key)
        )
        album_classification = classify_album_mbid_evidence(
            str(getattr(album, "album_artist", "") or ""),
            album_title,
            album_exact_evidence or album_review_evidence,
        )
        album_rows.append(
            {
                "album_key": album_key,
                "artist_key": album_artist_key,
                "title": album_title,
                "release_year": safe_int(getattr(album, "year", None)),
                "cover_path": str(getattr(album, "cover_path", "") or "").strip() or None,
                "mbid": album_classification.get("mbid"),
                "mbid_assertion_state": album_classification["mbid_assertion_state"],
                "evidence_source": album_classification.get("evidence_source"),
                "evidence_confidence": album_classification.get("confidence"),
                "metadata": {
                    "source": MIGRATION_NAME,
                    "album_artist": getattr(album, "album_artist", None),
                    "artists": member_artist_names,
                    "featured_artists": [],
                    "edition": getattr(album, "edition", None),
                    "root_provenance": getattr(album, "root_provenance", None),
                },
            }
        )
        _append_featured_artist_row(
            featured_artist_rows,
            seen_featured_rows,
            album_key=album_key,
            artist_key=album_artist_key,
            featured_kind="owner",
            source=MIGRATION_NAME,
        )
        for member_name in member_artist_names:
            member_key = ensure_artist(member_name)
            featured_kind = "owner" if member_key == owner_key else "featured_member"
            _append_featured_artist_row(
                featured_artist_rows,
                seen_featured_rows,
                album_key=album_key,
                artist_key=member_key,
                featured_kind=featured_kind,
                source=MIGRATION_NAME,
            )
        album_review_row = _local_mbid_review_row(
            target_kind="album",
            target_key=album_key,
            artist_key=album_artist_key,
            album_key=album_key,
            track_key=None,
            classification=album_classification,
            evidence_context=album_review_evidence,
        )
        if album_review_row is not None:
            local_mbid_assertion_rows.append(album_review_row)
        for track in getattr(album, "tracks", []) or []:
            track_artist_name = str(
                getattr(track, "artist", None) or getattr(album, "album_artist", None) or ""
            ).strip()
            track_artist_key = ensure_artist(track_artist_name)
            track_key = normalize_track_ref(str(getattr(track, "path", "") or ""))
            if not track_key:
                continue
            track_title = str(getattr(track, "title", "") or "").strip() or Path(track_key).stem
            attached_track_artist_names = _attached_track_artist_names(
                track_artist_name,
                owner_name,
            )
            track_artist_names.extend(attached_track_artist_names)
            for attached_artist_name in attached_track_artist_names:
                attached_artist_key = ensure_artist(attached_artist_name)
                _append_featured_artist_row(
                    featured_artist_rows,
                    seen_featured_rows,
                    album_key=album_key,
                    artist_key=attached_artist_key,
                    featured_kind="featured_track_artist",
                    source=MIGRATION_NAME,
                )
            track_evidence_key = (
                _local_inventory_key(track_artist_name),
                _local_inventory_key(track_title),
            )
            track_exact_evidence = track_evidence_map.get(track_evidence_key, [])
            track_review_evidence = (
                track_exact_evidence
                if track_exact_evidence
                else _related_local_mbid_evidence(track_evidence_map, track_evidence_key)
            )
            track_classification = classify_track_mbid_evidence(
                track_artist_name,
                track_title,
                track_exact_evidence or track_review_evidence,
            )
            track_rows.append(
                {
                    "track_key": track_key,
                    "album_key": str(getattr(album, "key", "") or "").strip(),
                    "artist_key": track_artist_key,
                    "title": track_title,
                    "disc_number": safe_int(getattr(track, "disc_number", None)),
                    "track_number": safe_int(getattr(track, "track_number", None)),
                    "duration_seconds": safe_int(getattr(track, "duration_seconds", None)),
                    "mbid": track_classification.get("mbid"),
                    "mbid_assertion_state": track_classification["mbid_assertion_state"],
                    "evidence_source": track_classification.get("evidence_source"),
                    "evidence_confidence": track_classification.get("confidence"),
                    "metadata": {
                        "source": MIGRATION_NAME,
                        "album": getattr(track, "album", None),
                        "album_artist": getattr(track, "album_artist", None),
                        "root_provenance": getattr(track, "root_provenance", None),
                    },
                }
            )
            track_review_row = _local_mbid_review_row(
                target_kind="track",
                target_key=track_key,
                artist_key=track_artist_key,
                album_key=str(getattr(album, "key", "") or "").strip(),
                track_key=track_key,
                classification=track_classification,
                evidence_context=track_review_evidence,
            )
            if track_review_row is not None:
                local_mbid_assertion_rows.append(track_review_row)
            file_entry = file_entries_by_path.get(track_key, {})
            track_file_rows.append(
                {
                    "track_key": track_key,
                    "private_path": track_key,
                    "relative_path": _relative_path_or_none(
                        track_key,
                        file_cache_root=_file_entry_root_path(file_entry) or file_cache_root,
                    ),
                    "file_size_bytes": safe_int(file_entry.get("size")),
                    "modified_at": _epoch_seconds_to_iso(file_entry.get("mtime")),
                    "content_signature": None,
                    "metadata": {
                        "source": MIGRATION_NAME,
                        "library_root_id": file_entry.get("library_root_id"),
                        "library_root_category": file_entry.get("library_root_category"),
                    },
                }
            )
        album_rows[-1]["metadata"]["featured_artists"] = [
            artist_name
            for artist_name in _deduped_artist_names([*member_artist_names, *track_artist_names])
            if _local_inventory_key(artist_name) != owner_key
        ]

    artist_rows = sorted(artists.values(), key=lambda row: str(row["artist_key"]))
    assertion_rows: list[dict[str, object]] = []
    evidence_map = artist_mbid_evidence or {}
    for artist_row in artist_rows:
        artist_key = str(artist_row["artist_key"])
        artist_evidence_context = evidence_map.get(artist_key)
        local_match_evidence = _local_match_evidence_for_artist(
            artist_key,
            album_evidence_map,
            track_evidence_map,
        )
        classification = classify_artist_mbid_evidence(
            str(artist_row["name"]),
            artist_evidence_context or [],
            local_match_evidence=local_match_evidence,
        )
        artist_row.update(
            {
                "mbid": classification.get("mbid"),
                "mbid_assertion_state": classification["mbid_assertion_state"],
                "evidence_source": classification.get("evidence_source"),
                "evidence_confidence": classification.get("confidence"),
            }
        )
        if artist_evidence_context is not None or local_match_evidence:
            assertion_rows.append(
                {
                    "artist_key": artist_key,
                    "evidence_source": classification.get("evidence_source") or "injected",
                    "mbid": classification.get("mbid"),
                    "assertion_mbid": classification.get("assertion_mbid") or classification.get("mbid"),
                    "mbid_assertion_state": classification["mbid_assertion_state"],
                    "confidence": classification.get("confidence"),
                    "explanation": classification.get("explanation"),
                    "source_payload": classification.get("source_payload"),
                }
            )

    return {
        "artists": artist_rows,
        "albums": album_rows,
        "featured_artists": featured_artist_rows,
        "tracks": track_rows,
        "track_files": track_file_rows,
        "artist_mbid_assertions": assertion_rows,
        "local_mbid_assertions": local_mbid_assertion_rows,
    }


def _related_local_mbid_evidence(
    evidence_map: dict[tuple[str, str], list[dict[str, object]]],
    evidence_key: tuple[str, str],
) -> list[dict[str, object]]:
    artist_key, target_title_key = evidence_key
    if evidence_key in evidence_map:
        return []
    related: list[dict[str, object]] = []
    for (candidate_artist_key, candidate_title_key), evidence_rows in evidence_map.items():
        if candidate_artist_key != artist_key or candidate_title_key == target_title_key:
            continue
        related.extend(row for row in evidence_rows if isinstance(row, dict))
    return related


def _attached_track_artist_names(track_artist_name: str | None, owner_name: str | None) -> list[str]:
    artist_name = str(track_artist_name or "").strip()
    if not artist_name:
        return []
    owner = str(owner_name or "").strip()
    if not owner:
        return [artist_name]
    if _local_inventory_key(artist_name) == _local_inventory_key(owner):
        return [owner]
    match = re.match(
        r"^(?P<owner>.+?)(?:\s+(?:feat\.?|featuring|with|vs|x)\s+|\s*&\s*|/|;|,\s*)(?P<featured>.+)$",
        artist_name,
        re.IGNORECASE,
    )
    if match is None or _local_inventory_key(match.group("owner")) != _local_inventory_key(owner):
        return [artist_name]
    return _deduped_artist_names([owner, *_split_featured_member_names(match.group("featured"))])


def _split_featured_member_names(value: object) -> list[str]:
    names: list[str] = []
    for part in re.split(r"\s+(?:and|и)\s+|(?:\s*&\s*)|/|;|,", str(value or "")):
        name = str(part or "").strip()
        if not name:
            continue
        names.append(name)
    return names


def _deduped_artist_names(values: list[object]) -> list[str]:
    names: list[str] = []
    seen: set[str] = set()
    for value in values:
        name = str(value or "").strip()
        if not name:
            continue
        name_key = _local_inventory_key(name)
        if name_key in seen:
            continue
        seen.add(name_key)
        names.append(name)
    return names


def _append_featured_artist_row(
    rows: list[dict[str, object]],
    seen_rows: set[tuple[str, str, str, str]],
    *,
    album_key: str,
    artist_key: str | None,
    featured_kind: str,
    source: str,
) -> None:
    if artist_key is None:
        return
    row_identity = (album_key, artist_key, featured_kind, source)
    if row_identity in seen_rows:
        return
    seen_rows.add(row_identity)
    rows.append(
        {
            "album_key": album_key,
            "artist_key": artist_key,
            "featured_kind": featured_kind,
            "metadata": {"source": source},
        }
    )


def _local_match_evidence_for_artist(
    artist_key: str,
    album_evidence_map: dict[tuple[str, str], list[dict[str, object]]],
    track_evidence_map: dict[tuple[str, str], list[dict[str, object]]],
) -> list[dict[str, object]]:
    evidence_rows: list[dict[str, object]] = []
    for evidence_map in (album_evidence_map, track_evidence_map):
        for (candidate_artist_key, _title_key), rows in evidence_map.items():
            if candidate_artist_key != artist_key:
                continue
            evidence_rows.extend(row for row in rows if isinstance(row, dict))
    return evidence_rows


def _local_mbid_review_row(
    *,
    target_kind: str,
    target_key: str,
    artist_key: str | None,
    album_key: str | None,
    track_key: str | None,
    classification: dict[str, object],
    evidence_context: list[dict[str, object]],
) -> dict[str, object] | None:
    state = str(classification.get("mbid_assertion_state") or "")
    if state not in {"missing", "ambiguous", "conflicting", "low_confidence"}:
        return None
    if not evidence_context:
        return None
    return {
        "target_kind": target_kind,
        "target_key": target_key,
        "artist_key": artist_key,
        "album_key": album_key,
        "track_key": track_key,
        "evidence_source": classification.get("evidence_source") or _first_evidence_source(evidence_context),
        "mbid": None,
        "mbid_assertion_state": state,
        "confidence": classification.get("confidence"),
        "explanation": classification.get("explanation"),
        "source_payload": classification.get("source_payload"),
    }


def _first_evidence_source(evidence_context: list[dict[str, object]]) -> str:
    for evidence in evidence_context:
        source = str(evidence.get("source") or evidence.get("evidence_source") or "").strip()
        if source:
            return source
    return "mbid_evidence"


def _library_cache_payload_identity(source_path: Path) -> object | None:
    try:
        payload = json.loads(source_path.read_text(encoding="utf-8"))
    except Exception:
        return None
    if not isinstance(payload, dict):
        return None
    music_root = str(payload.get("music_root") or "").strip()
    if music_root:
        return Path(music_root)
    library_root_identity = str(payload.get("library_root_identity") or "").strip()
    if library_root_identity:
        return library_root_identity
    return None


def _library_cache_payload_root_path(source_path: Path, *, fallback: object = None) -> object | None:
    try:
        payload = json.loads(source_path.read_text(encoding="utf-8"))
    except Exception:
        return fallback
    if not isinstance(payload, dict):
        return fallback
    for key in ("music_root", "root_path", "library_root_path"):
        text = str(payload.get(key) or "").strip()
        if text:
            return Path(text)
    return fallback


def _file_entry_root_path(file_entry: dict[str, object]) -> object | None:
    for key in ("music_root", "root_path", "library_root_path"):
        text = str(file_entry.get(key) or "").strip()
        if text:
            return Path(text)
    provenance = file_entry.get("root_provenance")
    if isinstance(provenance, dict):
        for key in ("path", "root_path", "music_root", "library_root_path"):
            text = str(provenance.get(key) or "").strip()
            if text:
                return Path(text)
    return None


def classify_artist_mbid_evidence(
    artist_name: str,
    evidence: list[dict[str, object]],
    *,
    high_confidence_threshold: float = 0.9,
) -> dict[str, object]:
    normalized_evidence = _normalized_artist_mbid_evidence(evidence)
    candidates = [
        {**item, "normalized_mbid": normalized_mbid}
        for item in normalized_evidence
        if (normalized_mbid := _normalize_uuid_text(item.get("mbid"))) is not None
    ]
    source_payload = {
        "artist": artist_name,
        "evidence": normalized_evidence,
    }
    if not candidates:
        return {
            "mbid": None,
            "mbid_assertion_state": "missing",
            "evidence_source": None,
            "confidence": None,
            "explanation": "No MBID evidence was provided for this local artist.",
            "source_payload": source_payload,
        }

    high_confidence = [
        item for item in candidates
        if _safe_float(item.get("confidence")) >= high_confidence_threshold
    ]
    if not high_confidence:
        top = max(candidates, key=lambda item: _safe_float(item.get("confidence")))
        return {
            "mbid": None,
            "assertion_mbid": top["normalized_mbid"],
            "mbid_assertion_state": "low_confidence",
            "evidence_source": str(top.get("source") or top.get("evidence_source") or "").strip() or None,
            "confidence": _safe_float(top.get("confidence")),
            "explanation": "MBID evidence exists, but no candidate reached the high-confidence threshold.",
            "source_payload": source_payload,
        }

    mbids = {str(item["normalized_mbid"]) for item in high_confidence}
    top = max(high_confidence, key=lambda item: _safe_float(item.get("confidence")))
    state = "asserted"
    explanation = "Exactly one high-confidence MBID candidate was found."
    if len(mbids) > 1:
        state = "conflicting"
        explanation = "Multiple high-confidence MBID candidates disagree."
    elif len(high_confidence) > 1:
        state = "ambiguous"
        explanation = "Multiple high-confidence evidence rows point to the same MBID."
    projection_mbid = top["normalized_mbid"] if state == "asserted" else None
    return {
        "mbid": projection_mbid,
        "assertion_mbid": top["normalized_mbid"],
        "mbid_assertion_state": state,
        "evidence_source": str(top.get("source") or top.get("evidence_source") or "").strip() or None,
        "confidence": _safe_float(top.get("confidence")),
        "explanation": explanation,
        "source_payload": source_payload,
    }


def classify_album_mbid_evidence(
    artist_name: str,
    album_title: str,
    evidence: list[dict[str, object]],
    *,
    high_confidence_threshold: float = 0.9,
) -> dict[str, object]:
    return _classify_local_mbid_evidence(
        target_kind="album",
        artist_name=artist_name,
        title=album_title,
        title_payload_key="album_title",
        evidence=evidence,
        high_confidence_threshold=high_confidence_threshold,
    )


def classify_track_mbid_evidence(
    artist_name: str,
    track_title: str,
    evidence: list[dict[str, object]],
    *,
    high_confidence_threshold: float = 0.9,
) -> dict[str, object]:
    return _classify_local_mbid_evidence(
        target_kind="track",
        artist_name=artist_name,
        title=track_title,
        title_payload_key="track_title",
        evidence=evidence,
        high_confidence_threshold=high_confidence_threshold,
    )


def _classify_local_mbid_evidence(
    *,
    target_kind: str,
    artist_name: str,
    title: str,
    title_payload_key: str,
    evidence: list[dict[str, object]],
    high_confidence_threshold: float,
) -> dict[str, object]:
    normalized_evidence = _normalized_artist_mbid_evidence(evidence)
    local_artist_key = _local_inventory_key(artist_name)
    local_title_key = _local_inventory_key(title)
    exact_evidence = [
        item for item in normalized_evidence
        if _evidence_sort_text(item, "artist_name") == local_artist_key
        and _evidence_sort_text(item, title_payload_key) == local_title_key
    ]
    candidates = [
        {**item, "normalized_mbid": normalized_mbid}
        for item in exact_evidence
        if (normalized_mbid := _normalize_uuid_text(item.get("mbid"))) is not None
    ]
    source_payload = {
        "artist": artist_name,
        "title": title,
        "target_kind": target_kind,
        "evidence": normalized_evidence,
    }
    if not candidates:
        return {
            "mbid": None,
            "mbid_assertion_state": "missing",
            "evidence_source": None,
            "confidence": None,
            "explanation": f"No exact local {target_kind} MBID evidence was provided.",
            "source_payload": source_payload,
        }

    high_confidence = [
        item for item in candidates
        if _safe_float(item.get("confidence")) >= high_confidence_threshold
    ]
    if not high_confidence:
        top = max(candidates, key=lambda item: _safe_float(item.get("confidence")))
        return _non_asserted_local_mbid_classification(
            top,
            state="low_confidence",
            explanation="Exact MBID evidence exists, but no candidate reached the high-confidence threshold.",
            source_payload=source_payload,
        )

    mbids = {str(item["normalized_mbid"]) for item in high_confidence}
    top = max(high_confidence, key=lambda item: _safe_float(item.get("confidence")))
    if len(mbids) > 1:
        return _non_asserted_local_mbid_classification(
            top,
            state="conflicting",
            explanation="Multiple exact high-confidence MBID candidates disagree.",
            source_payload=source_payload,
        )
    if len(high_confidence) > 1:
        return _non_asserted_local_mbid_classification(
            top,
            state="ambiguous",
            explanation="Multiple exact high-confidence evidence rows point to the same MBID.",
            source_payload=source_payload,
        )
    return {
        "mbid": top["normalized_mbid"],
        "mbid_assertion_state": "asserted",
        "evidence_source": str(top.get("source") or top.get("evidence_source") or "").strip() or None,
        "confidence": _safe_float(top.get("confidence")),
        "explanation": "Exactly one exact high-confidence MBID candidate was found.",
        "source_payload": source_payload,
    }


def _non_asserted_local_mbid_classification(
    top: dict[str, object],
    *,
    state: str,
    explanation: str,
    source_payload: dict[str, object],
) -> dict[str, object]:
    return {
        "mbid": None,
        "mbid_assertion_state": state,
        "evidence_source": str(top.get("source") or top.get("evidence_source") or "").strip() or None,
        "confidence": _safe_float(top.get("confidence")),
        "explanation": explanation,
        "source_payload": source_payload,
    }


def _normalized_artist_mbid_evidence(
    evidence: list[dict[str, object]],
) -> list[dict[str, object]]:
    deduped: dict[str, dict[str, object]] = {}
    for item in evidence:
        if not isinstance(item, dict):
            continue
        normalized_item = dict(item)
        normalized_mbid = _normalize_uuid_text(normalized_item.get("mbid"))
        if normalized_mbid is not None:
            normalized_item["mbid"] = normalized_mbid
        identity = json.dumps(
            normalized_item,
            sort_keys=True,
            separators=(",", ":"),
            default=str,
        )
        deduped.setdefault(identity, normalized_item)
    return sorted(deduped.values(), key=_artist_mbid_evidence_sort_key)


def _artist_mbid_evidence_sort_key(
    item: dict[str, object],
) -> tuple[int, str, float, str, str, str, str, str, str]:
    normalized_mbid = _normalize_uuid_text(item.get("mbid"))
    mbid_key = normalized_mbid or str(item.get("mbid") or "").strip()
    return (
        0 if normalized_mbid is not None else 1,
        mbid_key,
        -_safe_float(item.get("confidence")),
        _evidence_sort_text(item, "source") or _evidence_sort_text(item, "evidence_source"),
        _evidence_sort_text(item, "artist_name"),
        _evidence_sort_text(item, "album_title"),
        _evidence_sort_text(item, "track_title"),
        _evidence_sort_text(item, "provider_row"),
        json.dumps(item, sort_keys=True, separators=(",", ":"), default=str),
    )


def _evidence_sort_text(item: dict[str, object], key: str) -> str:
    value = item.get(key)
    payload = item.get("payload")
    if (value is None or value == "") and isinstance(payload, dict):
        value = payload.get(key)
    return " ".join(str(value or "").strip().casefold().split())


def _load_listen_history_for_migration(source_path: Path) -> list[object]:
    if not source_path.exists():
        return []
    payload = json.loads(source_path.read_text(encoding="utf-8"))
    if isinstance(payload, list):
        return payload
    if isinstance(payload, dict):
        items = payload.get("items")
        if isinstance(items, list):
            return items
    raise ValueError("listen_history.json must contain a list or an object with an items list.")


def _track_preference_rows_from_store(store: dict[str, object]) -> tuple[list[dict[str, object]], int, int]:
    rows: list[dict[str, object]] = []
    skipped_count = 0
    actors = store.get("actors") if isinstance(store.get("actors"), dict) else {}
    for actor_id, actor_payload in actors.items():
        if not isinstance(actor_payload, dict):
            continue
        preferences = actor_payload.get("track_preferences")
        if not isinstance(preferences, dict):
            continue
        if str(actor_id) != "local":
            skipped_count += sum(1 for overlay in preferences.values() if isinstance(overlay, dict))
            continue
        for track_ref, overlay in preferences.items():
            normalized_track_ref = normalize_track_ref(track_ref)
            if not normalized_track_ref or not isinstance(overlay, dict):
                continue
            rows.append(
                {
                    "actor_id": str(actor_id),
                    "track_key": normalized_track_ref,
                    "rating": overlay.get("rating"),
                    "love_tier": overlay.get("love_tier"),
                }
            )
    return rows, skipped_count, skipped_count


def _has_legacy_track_preferences_payload(source_path: Path) -> bool:
    if not source_path.exists():
        return False
    payload = json.loads(source_path.read_text(encoding="utf-8"))
    return isinstance(payload, dict) and isinstance(payload.get("tracks"), dict)


def _legacy_track_preference_rows(source_path: Path) -> tuple[list[dict[str, object]], int, int]:
    payload = json.loads(source_path.read_text(encoding="utf-8"))
    tracks = payload.get("tracks") if isinstance(payload, dict) else {}
    if not isinstance(tracks, dict):
        return [], 0, 0
    rows: list[dict[str, object]] = []
    skipped_count = 0
    warning_count = 0
    for track_ref, overlay in tracks.items():
        normalized_track_ref = normalize_track_ref(track_ref)
        if not normalized_track_ref:
            skipped_count += 1
            warning_count += 1
            continue
        normalized_overlay = normalize_track_preference_overlay(overlay)
        normalized_rating = _normalize_legacy_track_preference_rating(normalized_overlay["rating"])
        if normalized_overlay["rating"] is not None and normalized_rating is None:
            warning_count += 1
        if normalized_rating is None and normalized_overlay["love_tier"] == "off":
            skipped_count += 1
            continue
        rows.append(
            {
                "actor_id": "local",
                "track_key": normalized_track_ref,
                "rating": normalized_rating,
                "love_tier": normalized_overlay["love_tier"],
            }
        )
    return rows, skipped_count, warning_count


def _normalize_legacy_track_preference_rating(value: object) -> int | None:
    rating = safe_int(value)
    if rating is None or not 1 <= rating <= 5:
        return None
    return rating


def _library_root_rows_from_settings(settings: dict[str, object]) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for category_key in (
        "main_library_roots",
        "hoarding_library_roots",
        "new_arrivals_roots",
    ):
        roots = settings.get(category_key)
        if not isinstance(roots, list):
            continue
        for root in roots:
            if not isinstance(root, dict):
                continue
            root_id = str(root.get("id") or "").strip()
            root_path = str(root.get("path") or "").strip()
            if not root_id or not root_path:
                continue
            category_slug = library_roots.library_category_slug(category_key)
            metadata = {
                "source": MIGRATION_NAME,
                "root_id": root_id,
                "category": category_slug,
                "category_key": category_key,
                "category_label": library_roots.library_category_label(category_slug),
                "badge_label": library_roots.library_category_badge_label(category_slug),
            }
            if "layout_mode" in root:
                metadata["layout_mode"] = root.get("layout_mode")
            rows.append(
                {
                    "root_id": root_id,
                    "root_path": root_path,
                    "root_kind": category_slug,
                    "category_key": category_key,
                    "metadata": metadata,
                }
            )
    return rows


def _library_root_settings_row(
    settings: dict[str, object],
    root_rows: list[dict[str, object]],
) -> dict[str, object]:
    root_categories = {
        str(row.get("root_id")): {
            "category": row.get("root_kind"),
            "category_key": row.get("category_key"),
        }
        for row in root_rows
    }
    main_roots = settings.get("main_library_roots")
    first_main = main_roots[0] if isinstance(main_roots, list) and main_roots else {}
    layout_mode = "artist"
    if isinstance(first_main, dict):
        layout_mode = str(first_main.get("layout_mode") or "artist")
    return {
        "layout_mode": layout_mode,
        "root_categories": root_categories,
        "settings_payload": {
            **settings,
            "source": MIGRATION_NAME,
        },
    }


def _move_policy_rows_from_settings(settings: dict[str, object]) -> list[dict[str, object]]:
    move_policy = settings.get("move_policy")
    if not isinstance(move_policy, dict):
        return []
    rows: list[dict[str, object]] = []
    for key, value in move_policy.items():
        root_id = str(value or "").strip()
        if not key or not root_id:
            continue
        rows.append(
            {
                "policy_key": str(key),
                "policy_payload": {
                    "root_id": root_id,
                    "source": MIGRATION_NAME,
                },
            }
        )
    return rows


def _library_root_provenance_rows(
    root_rows: list[dict[str, object]],
    *,
    source_path: Path,
) -> list[dict[str, object]]:
    rows: list[dict[str, object]] = []
    for row in root_rows:
        rows.append(
            {
                "root_path": row.get("root_path"),
                "source_family": "library_root_settings_backfill",
                "source_path": str(source_path),
                "source_payload": {
                    "source": MIGRATION_NAME,
                    "source_family": "library_root_settings",
                    "source_path": str(source_path),
                    "root_id": row.get("root_id"),
                    "category": row.get("root_kind"),
                    "category_key": row.get("category_key"),
                },
            }
        )
    return rows


def _pending_scrobble_row(
    source_key: object,
    payload: object,
    *,
    source_path: Path,
) -> dict[str, object]:
    source_entry_id = str(source_key or "").strip()
    source_payload = dict(payload) if isinstance(payload, dict) else {"value": payload}
    played_at = _normalize_listen_timestamp(
        source_payload.get("played_at")
        or source_payload.get("recorded_at")
        or source_payload.get("ended_at")
        or source_payload.get("started_at")
        or source_payload.get("last_attempt_at")
    )
    return {
        "source_entry_id": source_entry_id,
        "track_key": normalize_track_ref(source_payload.get("track_ref") or source_payload.get("path")),
        "played_at": played_at,
        "attempt_count": _nonnegative_int(source_payload.get("retry_count")),
        "next_attempt_at": _normalize_listen_timestamp(source_payload.get("next_attempt_at")),
        "status": str(source_payload.get("status") or "pending").strip() or "pending",
        "payload": {
            "source": MIGRATION_NAME,
            "source_family": "lastfm_sync_state",
            "source_file": "lastfm_sync_state.json",
            "source_key": source_entry_id,
            "source_path": str(source_path),
            "source_payload": source_payload,
        },
    }


def _sync_problem_retry_row(
    source_key: object,
    payload: object,
    *,
    source_path: Path,
) -> dict[str, object]:
    source_entry_id = str(source_key or "").strip()
    source_payload = dict(payload) if isinstance(payload, dict) else {"value": payload}
    return {
        "source_entry_id": source_entry_id,
        "provider_name": str(source_payload.get("provider") or "lastfm").strip() or "lastfm",
        "retry_status": str(source_payload.get("status") or "pending_retry").strip() or "pending_retry",
        "attempt_count": _nonnegative_int(source_payload.get("retry_count")),
        "last_attempt_at": _normalize_listen_timestamp(source_payload.get("last_attempt_at")),
        "next_attempt_at": _normalize_listen_timestamp(source_payload.get("next_attempt_at")),
        "last_error": str(source_payload.get("message") or source_payload.get("last_error") or "").strip() or None,
        "metadata": {
            "source": MIGRATION_NAME,
            "source_family": "lastfm_sync_state",
            "source_section": "sync_problems",
            "source_file": "lastfm_sync_state.json",
            "source_key": source_entry_id,
            "source_path": str(source_path),
            "source_payload": source_payload,
        },
    }


def _retry_summary_row(payload: dict[str, object], *, source_path: Path) -> dict[str, object]:
    source_payload = dict(payload)
    return {
        "source_entry_id": "last_retry_summary",
        "provider_name": "lastfm",
        "retry_status": "summary",
        "attempt_count": _nonnegative_int(source_payload.get("attempted")),
        "last_attempt_at": _normalize_listen_timestamp(source_payload.get("recorded_at")),
        "next_attempt_at": None,
        "last_error": None,
        "metadata": {
            "source": MIGRATION_NAME,
            "source_family": "lastfm_sync_state",
            "source_section": "last_retry_summary",
            "source_file": "lastfm_sync_state.json",
            "source_key": "last_retry_summary",
            "source_path": str(source_path),
            "source_payload": source_payload,
        },
    }


def _execute_operations(
    target: object,
    operations: list[tuple[str, object | None]],
    *,
    batch_size: int = 500,
) -> int:
    if not operations:
        return 0
    execute_batch = getattr(target, "execute_batch", None)
    if callable(execute_batch):
        applied_count = 0
        for index in range(0, len(operations), batch_size):
            applied_count += int(execute_batch(operations[index:index + batch_size]) or 0)
        return applied_count
    return sum(int(target.execute(sql, params) or 0) for sql, params in operations)


def _apply_summaries(target: object, migration_run_id: int, summaries: list[dict[str, object]]) -> None:
    target.execute(_bootstrap_sql(), None)
    for summary in summaries:
        applied_count = 0
        summary["target_count"] = applied_count
        if summary.get("source_family") == "local_library_inventory":
            rows = summary.get("rows", {})
            if isinstance(rows, dict):
                applied_count += _execute_operations(
                    target,
                    [
                        (
                            _upsert_local_artist_sql(),
                            [
                                row.get("artist_key"),
                                row.get("name"),
                                row.get("sort_name"),
                                row.get("mbid"),
                                row.get("mbid_assertion_state"),
                                row.get("evidence_source"),
                                row.get("evidence_confidence"),
                                migration_run_id,
                                None,
                                row.get("metadata"),
                            ],
                        )
                        for row in rows.get("artists", [])
                        if isinstance(row, dict)
                    ],
                )
                summary["target_count"] = applied_count
                applied_count += _execute_operations(
                    target,
                    [
                        (
                            _upsert_local_album_sql(),
                            [
                                row.get("artist_key"),
                                row.get("album_key"),
                                row.get("title"),
                                row.get("release_year"),
                                row.get("cover_path"),
                                row.get("mbid"),
                                row.get("mbid_assertion_state"),
                                row.get("evidence_source"),
                                row.get("evidence_confidence"),
                                migration_run_id,
                                None,
                                row.get("metadata"),
                            ],
                        )
                        for row in rows.get("albums", [])
                        if isinstance(row, dict)
                    ],
                )
                summary["target_count"] = applied_count
                applied_count += _execute_operations(
                    target,
                    [
                        (
                            _upsert_local_album_featured_artist_sql(),
                            [
                                row.get("album_key"),
                                row.get("artist_key"),
                                row.get("featured_kind"),
                                row.get("metadata"),
                            ],
                        )
                        for row in rows.get("featured_artists", [])
                        if isinstance(row, dict)
                    ],
                )
                summary["target_count"] = applied_count
                applied_count += _execute_operations(
                    target,
                    [
                        (
                            _upsert_local_track_sql(),
                            [
                                row.get("album_key"),
                                row.get("artist_key"),
                                row.get("track_key"),
                                row.get("title"),
                                row.get("disc_number"),
                                row.get("track_number"),
                                row.get("duration_seconds"),
                                row.get("mbid"),
                                row.get("mbid_assertion_state"),
                                row.get("evidence_source"),
                                row.get("evidence_confidence"),
                                migration_run_id,
                                None,
                                row.get("metadata"),
                            ],
                        )
                        for row in rows.get("tracks", [])
                        if isinstance(row, dict)
                    ],
                )
                summary["target_count"] = applied_count
                applied_count += _execute_operations(
                    target,
                    [
                        (
                            _upsert_local_track_file_sql(),
                            [
                                row.get("track_key"),
                                row.get("private_path"),
                                row.get("relative_path"),
                                row.get("file_size_bytes"),
                                row.get("modified_at"),
                                row.get("content_signature"),
                                row.get("metadata"),
                            ],
                        )
                        for row in rows.get("track_files", [])
                        if isinstance(row, dict)
                    ],
                )
                summary["target_count"] = applied_count
                applied_count += _execute_operations(
                    target,
                    [
                        (
                            _insert_local_mbid_assertion_sql(),
                            [
                                row.get("target_kind"),
                                row.get("target_key"),
                                row.get("artist_key"),
                                row.get("album_key"),
                                row.get("track_key"),
                                row.get("evidence_source"),
                                row.get("mbid"),
                                row.get("mbid_assertion_state"),
                                row.get("confidence"),
                                row.get("explanation"),
                                row.get("source_payload"),
                                migration_run_id,
                            ],
                        )
                        for row in rows.get("local_mbid_assertions", [])
                        if isinstance(row, dict)
                    ],
                )
                summary["target_count"] = applied_count
                applied_count += _execute_operations(
                    target,
                    [
                        (
                            _insert_local_artist_mbid_assertion_sql(),
                            [
                                row.get("artist_key"),
                                row.get("evidence_source"),
                                row.get("assertion_mbid") or row.get("mbid"),
                                row.get("mbid_assertion_state"),
                                row.get("confidence"),
                                row.get("explanation"),
                                row.get("source_payload"),
                                migration_run_id,
                            ],
                        )
                        for row in rows.get("artist_mbid_assertions", [])
                        if isinstance(row, dict)
                    ],
                )
                summary["target_count"] = applied_count
            continue
        if summary.get("source_family") == "library_root_settings":
            rows = summary.get("rows", {})
            if isinstance(rows, dict):
                for row in rows.get("roots", []):
                    if not isinstance(row, dict):
                        continue
                    applied_count += int(target.execute(
                        _upsert_library_root_sql(),
                        [
                            row.get("root_path"),
                            row.get("root_kind"),
                            row.get("metadata"),
                        ],
                    ) or 0)
                    summary["target_count"] = applied_count
                for row in rows.get("settings", []):
                    if not isinstance(row, dict):
                        continue
                    applied_count += int(target.execute(
                        _upsert_library_root_settings_sql(),
                        [
                            row.get("layout_mode"),
                            row.get("root_categories"),
                            row.get("settings_payload"),
                        ],
                    ) or 0)
                    summary["target_count"] = applied_count
                for row in rows.get("move_policy", []):
                    if not isinstance(row, dict):
                        continue
                    applied_count += int(target.execute(
                        _upsert_move_policy_setting_sql(),
                        [
                            row.get("policy_key"),
                            row.get("policy_payload"),
                        ],
                    ) or 0)
                    summary["target_count"] = applied_count
                for row in rows.get("provenance", []):
                    if not isinstance(row, dict):
                        continue
                    applied_count += int(target.execute(
                        _insert_library_root_provenance_sql(),
                        [
                            row.get("root_path"),
                            row.get("source_family"),
                            row.get("source_path"),
                            row.get("source_payload"),
                        ],
                    ) or 0)
                    summary["target_count"] = applied_count
            continue
        if summary.get("source_family") == "ignored_versions":
            for row in summary.get("rows", []):
                if not isinstance(row, dict):
                    continue
                applied_count += int(target.execute(
                    _upsert_ignored_version_sql(),
                    [
                        row.get("rule_key"),
                        row.get("metadata"),
                    ],
                ) or 0)
                summary["target_count"] = applied_count
            continue
        if summary.get("source_family") == "ignored_repairs":
            for row in summary.get("rows", []):
                if not isinstance(row, dict):
                    continue
                applied_count += int(target.execute(
                    _upsert_ignored_repair_sql(),
                    [
                        row.get("rule_key"),
                        row.get("metadata"),
                    ],
                ) or 0)
                summary["target_count"] = applied_count
            continue
        if summary.get("source_family") == "manual_versions":
            for row in summary.get("rows", []):
                if not isinstance(row, dict):
                    continue
                applied_count += int(target.execute(
                    _upsert_manual_version_sql(),
                    [
                        row.get("child_key"),
                        row.get("parent_key"),
                        row.get("metadata"),
                    ],
                ) or 0)
                summary["target_count"] = applied_count
            continue
        if summary.get("source_family") == "separate_releases":
            for row in summary.get("rows", []):
                if not isinstance(row, dict):
                    continue
                applied_count += int(target.execute(
                    _upsert_separate_release_sql(),
                    [
                        row.get("rule_key"),
                        row.get("metadata"),
                    ],
                ) or 0)
                summary["target_count"] = applied_count
            continue
        if summary.get("source_family") == "exception_overrides":
            for row in summary.get("rows", []):
                if not isinstance(row, dict):
                    continue
                applied_count += int(target.execute(
                    _upsert_exception_override_sql(),
                    [
                        row.get("track_key"),
                        row.get("override_payload"),
                    ],
                ) or 0)
                summary["target_count"] = applied_count
            continue
        if summary.get("source_family") == "lastfm_settings":
            rows = summary.get("rows", {})
            if isinstance(rows, dict):
                for row in rows.get("settings", []):
                    if not isinstance(row, dict):
                        continue
                    applied_count += int(target.execute(
                        _upsert_lastfm_settings_sql(),
                        [
                            row.get("provider_username"),
                            row.get("timezone_name"),
                            row.get("settings_payload"),
                        ],
                    ) or 0)
                    summary["target_count"] = applied_count
                for row in rows.get("sessions", []):
                    if not isinstance(row, dict):
                        continue
                    applied_count += int(target.execute(
                        _upsert_lastfm_session_sql(),
                        [
                            row.get("provider_username"),
                            row.get("session_key"),
                            row.get("metadata"),
                        ],
                    ) or 0)
                    summary["target_count"] = applied_count
            continue
        if summary.get("source_family") == "lastfm_sync_state":
            rows = summary.get("rows", {})
            if isinstance(rows, dict):
                for row in rows.get("pending_scrobbles", []):
                    if not isinstance(row, dict):
                        continue
                    applied_count += int(target.execute(
                        _upsert_pending_scrobble_sql(),
                        [
                            row.get("track_key"),
                            row.get("played_at"),
                            row.get("attempt_count"),
                            row.get("next_attempt_at"),
                            row.get("status"),
                            row.get("payload"),
                        ],
                    ) or 0)
                    summary["target_count"] = applied_count
                for row in rows.get("sync_problems", []):
                    if not isinstance(row, dict):
                        continue
                    applied_count += int(target.execute(
                        _upsert_scrobble_retry_state_sql(),
                        [
                            row.get("provider_name"),
                            row.get("retry_status"),
                            row.get("attempt_count"),
                            row.get("last_attempt_at"),
                            row.get("next_attempt_at"),
                            row.get("last_error"),
                            row.get("metadata"),
                        ],
                    ) or 0)
                    summary["target_count"] = applied_count
                for row in rows.get("last_retry_summary", []):
                    if not isinstance(row, dict):
                        continue
                    applied_count += int(target.execute(
                        _upsert_scrobble_retry_state_sql(),
                        [
                            row.get("provider_name"),
                            row.get("retry_status"),
                            row.get("attempt_count"),
                            row.get("last_attempt_at"),
                            row.get("next_attempt_at"),
                            row.get("last_error"),
                            row.get("metadata"),
                        ],
                    ) or 0)
                    summary["target_count"] = applied_count
            continue
        if summary.get("source_family") == "cover_lookup_notifications":
            for row in summary.get("rows", []):
                if not isinstance(row, dict):
                    continue
                applied_count += int(target.execute(
                    _upsert_cover_lookup_task_sql(),
                    [
                        row.get("task_key"),
                        row.get("status"),
                        row.get("requested_at"),
                        row.get("completed_at"),
                        row.get("album_key"),
                        row.get("selected_cover_private_path"),
                        row.get("provider_payload"),
                        row.get("error_message"),
                        row.get("metadata"),
                    ],
                ) or 0)
                summary["target_count"] = applied_count
            continue
        if summary.get("source_family") == "saved_loops":
            saved_loop_rows = [
                row for row in summary.get("rows", [])
                if isinstance(row, dict)
            ]
            for row in saved_loop_rows:
                applied_count += int(target.execute(
                    _upsert_saved_loop_sql(),
                    [
                        row.get("loop_key"),
                        row.get("source_private_path"),
                        row.get("loop_private_path"),
                        row.get("start_seconds"),
                        row.get("end_seconds"),
                        row.get("created_at"),
                        row.get("parent_loop_key"),
                        row.get("metadata"),
                    ],
                ) or 0)
                summary["target_count"] = applied_count
            for row in saved_loop_rows:
                if not row.get("parent_loop_key"):
                    continue
                target.execute(
                    _link_saved_loop_parent_sql(),
                    [
                        row.get("loop_key"),
                        row.get("parent_loop_key"),
                    ],
                )
            continue
        if summary.get("source_family") == "discovery_center_preferences":
            for row in summary.get("rows", []):
                if not isinstance(row, dict):
                    continue
                applied_count += int(target.execute(
                    _upsert_discovery_center_preferences_sql(),
                    [
                        row.get("preference_scope"),
                        row.get("preferences_payload"),
                        row.get("metadata"),
                    ],
                ) or 0)
                summary["target_count"] = applied_count
            continue
        for row in summary.get("rows", []):
            if not isinstance(row, dict):
                continue
            if summary.get("source_family") == "track_preferences":
                applied_count += int(target.execute(
                    _upsert_track_preference_sql(),
                    [
                        row.get("track_key"),
                        row.get("rating"),
                        row.get("love_tier"),
                        {
                            "source": MIGRATION_NAME,
                            "actor_id": row.get("actor_id"),
                        },
                    ],
                ) or 0)
                summary["target_count"] = applied_count
            elif summary.get("source_family") == "listen_history":
                source_key = _listen_history_source_key(row)
                metadata = {
                    "source": MIGRATION_NAME,
                    "source_entry_id": source_key,
                    "source_payload": row,
                }
                applied_count += int(target.execute(
                    _upsert_listen_history_sql(),
                    [
                        _listen_history_track_key(row),
                        row.get("_listen_timestamp"),
                        MIGRATION_NAME,
                        source_key,
                        _scrobble_status(row),
                        row.get("request_origin"),
                        metadata,
                    ],
                ) or 0)
                summary["target_count"] = applied_count
    _record_source_summaries(target, migration_run_id, summaries)


def _record_source_summaries(
    target: object,
    migration_run_id: int,
    summaries: list[dict[str, object]],
) -> None:
    for summary in summaries:
        target_summary = {key: value for key, value in summary.items() if key != "rows"}
        target.record_source_summary(migration_run_id, target_summary)


def _bootstrap_sql() -> str:
    owner_key = _sql_literal(BOOTSTRAP_OWNER_KEY)
    display_name = _sql_literal(BOOTSTRAP_OWNER_DISPLAY_NAME)
    migration_name = _sql_literal(MIGRATION_NAME)
    library_name = _sql_literal(BOOTSTRAP_LIBRARY_NAME)
    return f"""
        with existing_owner as (
          select account_id as id
          from app.bootstrap_owners
          where owner_key = {owner_key}
          limit 1
        ),
        inserted_owner_account as (
          insert into app.accounts (display_name, account_kind, metadata)
          select
            {display_name},
            'bootstrap_owner',
            jsonb_build_object(
              'source', {migration_name},
              'display_name', {display_name}
            )
          where not exists (select 1 from existing_owner)
          returning id
        ),
        owner_id as (
          select id from existing_owner
          union all
          select id from inserted_owner_account
          limit 1
        ),
        updated_owner_account as (
          update app.accounts
             set display_name = {display_name},
                 metadata = app.accounts.metadata || jsonb_build_object(
                   'source', {migration_name},
                   'display_name', {display_name}
                 )
          from owner_id
          where app.accounts.id = owner_id.id
          returning app.accounts.id
        ),
        bootstrap_owner as (
          insert into app.bootstrap_owners (account_id, owner_key, metadata)
          select
            id,
            {owner_key},
            jsonb_build_object(
              'source', {migration_name},
              'display_name', {display_name}
            )
          from owner_id
          on conflict (owner_key) do update
            set metadata = app.bootstrap_owners.metadata || excluded.metadata
          returning account_id
        )
        insert into library.libraries (owner_account_id, name, library_kind, metadata)
        select account_id, {library_name}, 'local', jsonb_build_object('source', {migration_name})
        from bootstrap_owner
        on conflict (owner_account_id, name, library_kind) do update
            set metadata = library.libraries.metadata || excluded.metadata;
    """


def _upsert_library_root_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
        insert into library.library_roots (
          library_id,
          root_path,
          root_kind,
          metadata
        )
        select
          bootstrap_context.library_id,
          %s,
          %s,
          %s::jsonb
        from bootstrap_context
        on conflict (library_id, root_path) do update
          set root_kind = excluded.root_kind,
              is_active = true,
              updated_at = now(),
              metadata = library.library_roots.metadata || excluded.metadata
        returning 1;
    """


def _upsert_library_root_settings_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
        insert into library.library_root_settings (
          library_id,
          layout_mode,
          root_categories,
          settings_payload
        )
        select
          bootstrap_context.library_id,
          %s,
          %s::jsonb,
          %s::jsonb
        from bootstrap_context
        on conflict (library_id) do update
          set layout_mode = excluded.layout_mode,
              root_categories = excluded.root_categories,
              settings_payload = library.library_root_settings.settings_payload || excluded.settings_payload,
              updated_at = now()
        returning 1;
    """


def _upsert_move_policy_setting_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
        insert into library.move_policy_settings (
          library_id,
          policy_key,
          policy_payload
        )
        select
          bootstrap_context.library_id,
          %s,
          %s::jsonb
        from bootstrap_context
        on conflict (library_id, policy_key) do update
          set policy_payload = library.move_policy_settings.policy_payload || excluded.policy_payload,
              updated_at = now()
        returning 1;
    """


def _insert_library_root_provenance_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        root_match as (
          select library.library_roots.id as library_root_id
          from library.library_roots
          join bootstrap_context on bootstrap_context.library_id = library.library_roots.library_id
          where library.library_roots.root_path = %s
          limit 1
        ),
        proposed_provenance as (
          select
            (select library_root_id from root_match) as library_root_id,
            %s as source_family,
            %s as source_path,
            %s::jsonb as source_payload
          where exists (select 1 from root_match)
        )
        insert into library.library_root_provenance (
          library_root_id,
          source_family,
          source_path,
          source_payload
        )
        select
          proposed_provenance.library_root_id,
          proposed_provenance.source_family,
          proposed_provenance.source_path,
          proposed_provenance.source_payload
        from proposed_provenance
        where not exists (
          select 1
          from library.library_root_provenance existing
          where existing.library_root_id = proposed_provenance.library_root_id
            and existing.source_family = proposed_provenance.source_family
            and existing.source_path is not distinct from proposed_provenance.source_path
            and existing.source_payload = proposed_provenance.source_payload
        )
        returning 1;
    """


def _upsert_ignored_version_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
        insert into library.ignored_versions (
          library_id,
          version_key,
          metadata
        )
        select
          bootstrap_context.library_id,
          %s,
          %s::jsonb
        from bootstrap_context
        on conflict (library_id, version_key) do update
          set metadata = library.ignored_versions.metadata || excluded.metadata
        returning 1;
    """


def _upsert_ignored_repair_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
        insert into library.ignored_repairs (
          library_id,
          repair_key,
          metadata
        )
        select
          bootstrap_context.library_id,
          %s,
          %s::jsonb
        from bootstrap_context
        on conflict (library_id, repair_key) do update
          set metadata = library.ignored_repairs.metadata || excluded.metadata
        returning 1;
    """


def _upsert_manual_version_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
        insert into library.manual_versions (
          library_id,
          child_key,
          parent_key,
          metadata
        )
        select
          bootstrap_context.library_id,
          %s,
          %s,
          %s::jsonb
        from bootstrap_context
        on conflict (library_id, child_key) do update
          set parent_key = excluded.parent_key,
              updated_at = now(),
              metadata = library.manual_versions.metadata || excluded.metadata
        returning 1;
    """


def _upsert_separate_release_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
        insert into library.separate_releases (
          library_id,
          release_key,
          metadata
        )
        select
          bootstrap_context.library_id,
          %s,
          %s::jsonb
        from bootstrap_context
        on conflict (library_id, release_key) do update
          set metadata = library.separate_releases.metadata || excluded.metadata
        returning 1;
    """


def _upsert_exception_override_sql() -> str:
    return """
        with input_row as (
          select
            %s as track_key,
            %s::jsonb as override_payload
        ),
        bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        track_match as (
          select library.local_tracks.id as track_id
          from library.local_tracks
          join bootstrap_context on bootstrap_context.library_id = library.local_tracks.library_id
          join input_row on input_row.track_key = library.local_tracks.track_key
          limit 1
        )
        insert into library.exception_overrides (
          library_id,
          track_id,
          track_key,
          override_payload
        )
        select
          bootstrap_context.library_id,
          (select track_id from track_match),
          input_row.track_key,
          input_row.override_payload
        from bootstrap_context
        cross join input_row
        on conflict (library_id, track_key) do update
          set track_id = coalesce(excluded.track_id, library.exception_overrides.track_id),
              override_payload = library.exception_overrides.override_payload || excluded.override_payload,
              updated_at = now()
        returning 1;
    """


def _upsert_track_preference_sql() -> str:
    return """
        with bootstrap_context as (
          select
            app.bootstrap_owners.account_id,
            library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
        insert into app.track_preferences (
          account_id,
          library_id,
          track_key,
          rating,
          love_tier,
          metadata
        )
        select
          bootstrap_context.account_id,
          bootstrap_context.library_id,
          %s,
          %s,
          %s,
          %s::jsonb
        from bootstrap_context
        on conflict (account_id, track_key) do update
          set rating = excluded.rating,
              love_tier = excluded.love_tier,
              library_id = excluded.library_id,
              updated_at = now(),
              metadata = app.track_preferences.metadata || excluded.metadata
        returning 1;
    """


def _upsert_discovery_center_preferences_sql() -> str:
    return """
        with bootstrap_context as (
          select app.bootstrap_owners.account_id
          from app.bootstrap_owners
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
        insert into app.user_discovery_preferences (
          account_id,
          preference_scope,
          preferences_payload,
          metadata
        )
        select
          bootstrap_context.account_id,
          %s,
          %s::jsonb,
          %s::jsonb
        from bootstrap_context
        on conflict (account_id, preference_scope) do update
          set preferences_payload = excluded.preferences_payload,
              metadata = app.user_discovery_preferences.metadata || excluded.metadata,
              updated_at = now()
        returning 1;
    """


def _upsert_lastfm_settings_sql() -> str:
    return """
        with bootstrap_context as (
          select account_id
          from app.bootstrap_owners
          where owner_key = 'local-bootstrap-owner'
          limit 1
        )
        insert into integration.lastfm_settings (
          account_id,
          provider_username,
          timezone_name,
          settings_payload
        )
        select
          bootstrap_context.account_id,
          %s,
          %s,
          %s::jsonb
        from bootstrap_context
        on conflict (account_id) do update
          set provider_username = excluded.provider_username,
              timezone_name = excluded.timezone_name,
              settings_payload = integration.lastfm_settings.settings_payload || excluded.settings_payload,
              updated_at = now()
        returning 1;
    """


def _upsert_lastfm_session_sql() -> str:
    return """
        with bootstrap_context as (
          select account_id
          from app.bootstrap_owners
          where owner_key = 'local-bootstrap-owner'
          limit 1
        )
        insert into integration.lastfm_sessions (
          account_id,
          provider_username,
          session_key_encrypted,
          is_active,
          metadata
        )
        select
          bootstrap_context.account_id,
          %s,
          %s,
          true,
          %s::jsonb
        from bootstrap_context
        on conflict (account_id, provider_username)
          where is_active
          do update
            set session_key_encrypted = excluded.session_key_encrypted,
                is_active = true,
                updated_at = now(),
                metadata = integration.lastfm_sessions.metadata || excluded.metadata
        returning 1;
    """


def _upsert_pending_scrobble_sql() -> str:
    return """
        with bootstrap_context as (
          select
            app.bootstrap_owners.account_id,
            library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
        insert into integration.pending_scrobbles (
          library_id,
          account_id,
          track_key,
          played_at,
          attempt_count,
          next_attempt_at,
          status,
          payload
        )
        select
          bootstrap_context.library_id,
          bootstrap_context.account_id,
          %s,
          coalesce(%s::timestamptz, '1970-01-01T00:00:00+00:00'::timestamptz),
          %s,
          %s::timestamptz,
          %s,
          %s::jsonb
        from bootstrap_context
        on conflict ((payload->>'source_family'), (payload->>'source_key'))
          where payload ? 'source_family' and payload ? 'source_key'
          do update
            set track_key = excluded.track_key,
                played_at = excluded.played_at,
                attempt_count = excluded.attempt_count,
                next_attempt_at = excluded.next_attempt_at,
                status = excluded.status,
                payload = integration.pending_scrobbles.payload || excluded.payload,
                updated_at = now()
        returning 1;
    """


def _upsert_scrobble_retry_state_sql() -> str:
    return """
        insert into integration.scrobble_retry_state (
          provider_name,
          retry_status,
          attempt_count,
          last_attempt_at,
          next_attempt_at,
          last_error,
          metadata
        )
        values (
          %s,
          %s,
          %s,
          %s::timestamptz,
          %s::timestamptz,
          %s,
          %s::jsonb
        )
        on conflict ((metadata->>'source_family'), (metadata->>'source_section'), (metadata->>'source_key'))
          where metadata ? 'source_family' and metadata ? 'source_section' and metadata ? 'source_key'
          do update
            set provider_name = excluded.provider_name,
                retry_status = excluded.retry_status,
                attempt_count = excluded.attempt_count,
                last_attempt_at = excluded.last_attempt_at,
                next_attempt_at = excluded.next_attempt_at,
                last_error = excluded.last_error,
                metadata = integration.scrobble_retry_state.metadata || excluded.metadata
        returning 1;
    """


def _upsert_listen_history_sql() -> str:
    return """
        with bootstrap_context as (
          select
            app.bootstrap_owners.account_id,
            library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
        insert into integration.listen_history (
          library_id,
          account_id,
          track_key,
          played_at,
          listen_source,
          source_family,
          source_entry_id,
          scrobble_status,
          request_origin,
          metadata
        )
        select
          bootstrap_context.library_id,
          bootstrap_context.account_id,
          %s,
          %s::timestamptz,
          'local',
          %s,
          %s,
          %s,
          %s,
          %s::jsonb
        from bootstrap_context
        on conflict (source_family, source_entry_id)
          where source_family is not null and source_entry_id is not null
          do nothing
        returning 1;
    """


def _upsert_cover_lookup_task_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
        insert into ops.cover_lookup_tasks (
          library_id,
          task_key,
          status,
          requested_at,
          completed_at,
          album_key,
          selected_cover_private_path,
          provider_payload,
          error_message,
          metadata
        )
        select
          bootstrap_context.library_id,
          %s,
          %s,
          coalesce(%s::timestamptz, '1970-01-01T00:00:00+00:00'::timestamptz),
          %s::timestamptz,
          %s,
          %s,
          %s::jsonb,
          %s,
          %s::jsonb
        from bootstrap_context
        on conflict (task_key) do update
          set status = excluded.status,
              requested_at = excluded.requested_at,
              completed_at = excluded.completed_at,
              album_key = excluded.album_key,
              selected_cover_private_path = excluded.selected_cover_private_path,
              provider_payload = ops.cover_lookup_tasks.provider_payload || excluded.provider_payload,
              error_message = excluded.error_message,
              metadata = ops.cover_lookup_tasks.metadata || excluded.metadata
        returning 1;
    """


def _upsert_saved_loop_sql() -> str:
    return """
        with input_row as (
          select
            %s as loop_key,
            %s as source_private_path,
            %s as loop_private_path,
            %s::numeric(12, 3) as start_seconds,
            %s::numeric(12, 3) as end_seconds,
            coalesce(%s::timestamptz, '1970-01-01T00:00:00+00:00'::timestamptz) as created_at,
            nullif(%s, '') as parent_loop_key,
            %s::jsonb as metadata
        ),
        bootstrap_context as (
          select
            app.bootstrap_owners.account_id,
            library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        parent_loop_match as (
          select
            app.saved_loops.id,
            app.saved_loops.track_id
          from app.saved_loops
          join input_row on app.saved_loops.loop_key = input_row.parent_loop_key
          join bootstrap_context
            on bootstrap_context.account_id = app.saved_loops.account_id
           and bootstrap_context.library_id = app.saved_loops.library_id
          limit 1
        ),
        source_track_match as (
          select library.local_track_files.track_id
          from library.local_track_files
          join library.local_tracks
            on library.local_tracks.id = library.local_track_files.track_id
          join bootstrap_context
            on bootstrap_context.library_id = library.local_tracks.library_id
          join input_row
            on library.local_track_files.private_path = input_row.source_private_path
          order by library.local_track_files.last_seen_at desc, library.local_track_files.id desc
          limit 1
        ),
        metadata_track_candidates as (
          select library.local_tracks.id as track_id
          from library.local_tracks
          join library.local_albums
            on library.local_albums.id = library.local_tracks.album_id
          left join library.local_artists
            on library.local_artists.id = coalesce(
              library.local_tracks.artist_id,
              library.local_albums.artist_id
            )
          join bootstrap_context
            on bootstrap_context.library_id = library.local_tracks.library_id
           and bootstrap_context.library_id = library.local_albums.library_id
          join input_row on true
          where nullif(btrim(input_row.metadata -> 'source_payload' ->> 'title'), '') is not null
            and nullif(btrim(input_row.metadata -> 'source_payload' ->> 'album'), '') is not null
            and nullif(btrim(input_row.metadata -> 'source_payload' ->> 'artist'), '') is not null
            and lower(btrim(library.local_tracks.title)) = lower(btrim(input_row.metadata -> 'source_payload' ->> 'title'))
            and lower(btrim(library.local_albums.title)) = lower(btrim(input_row.metadata -> 'source_payload' ->> 'album'))
            and lower(btrim(coalesce(library.local_artists.name, ''))) = lower(btrim(input_row.metadata -> 'source_payload' ->> 'artist'))
        ),
        metadata_track_match as (
          select min(track_id) as track_id
          from metadata_track_candidates
          having count(*) = 1
        )
        insert into app.saved_loops (
          account_id,
          library_id,
          track_id,
          loop_key,
          source_private_path,
          loop_private_path,
          start_seconds,
          end_seconds,
          parent_loop_id,
          created_at,
          metadata
        )
        select
          bootstrap_context.account_id,
          bootstrap_context.library_id,
          coalesce(
            (select track_id from parent_loop_match),
            (select track_id from source_track_match),
            (select track_id from metadata_track_match)
          ),
          input_row.loop_key,
          input_row.source_private_path,
          input_row.loop_private_path,
          input_row.start_seconds,
          input_row.end_seconds,
          (select id from parent_loop_match),
          input_row.created_at,
          input_row.metadata
        from input_row
        cross join bootstrap_context
        on conflict (account_id, library_id, loop_key)
          where account_id is not null
            and library_id is not null
          do update
          set account_id = excluded.account_id,
              library_id = excluded.library_id,
              track_id = coalesce(excluded.track_id, app.saved_loops.track_id),
              source_private_path = excluded.source_private_path,
              loop_private_path = excluded.loop_private_path,
              start_seconds = excluded.start_seconds,
              end_seconds = excluded.end_seconds,
              parent_loop_id = excluded.parent_loop_id,
              updated_at = now(),
              metadata = app.saved_loops.metadata || excluded.metadata
        returning 1;
    """


def _link_saved_loop_parent_sql() -> str:
    return """
        with input_row as (
          select
            %s as loop_key,
            nullif(%s, '') as parent_loop_key
        ),
        bootstrap_context as (
          select
            app.bootstrap_owners.account_id,
            library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        parent_loop_match as (
          select parent_loop.id
          from app.saved_loops as parent_loop
          join input_row on parent_loop.loop_key = input_row.parent_loop_key
          join bootstrap_context
            on bootstrap_context.account_id = parent_loop.account_id
           and bootstrap_context.library_id = parent_loop.library_id
          limit 1
        )
        update app.saved_loops as child_loop
           set parent_loop_id = (select id from parent_loop_match),
               track_id = coalesce(child_loop.track_id, (select track_id from parent_loop_match)),
               updated_at = now(),
               metadata = child_loop.metadata || jsonb_build_object(
                 'parent_loop_resolution', 'post-upsert',
                 'parent_loop_key', (select parent_loop_key from input_row)
               )
          from input_row
          cross join bootstrap_context
         where child_loop.account_id = bootstrap_context.account_id
           and child_loop.library_id = bootstrap_context.library_id
           and child_loop.loop_key = input_row.loop_key
           and input_row.parent_loop_key is not null
           and exists (select 1 from parent_loop_match)
        returning 1;
    """


def _upsert_local_artist_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        )
        insert into library.local_artists (
          library_id,
          artist_key,
          name,
          sort_name,
          mbid,
          mbid_assertion_state,
          evidence_source,
          evidence_confidence,
          mbid_assertion_migration_run_id,
          mbid_assertion_scan_run_ref,
          metadata
        )
        select
          bootstrap_context.library_id,
          %s,
          %s,
          %s,
          %s::uuid,
          %s,
          %s,
          %s,
          %s::bigint,
          %s,
          %s::jsonb
        from bootstrap_context
        on conflict (library_id, artist_key) do update
          set name = excluded.name,
              sort_name = excluded.sort_name,
              mbid = excluded.mbid,
              mbid_assertion_state = excluded.mbid_assertion_state,
              evidence_source = excluded.evidence_source,
              evidence_confidence = excluded.evidence_confidence,
              mbid_assertion_migration_run_id = excluded.mbid_assertion_migration_run_id,
              mbid_assertion_scan_run_ref = excluded.mbid_assertion_scan_run_ref,
              last_seen_at = now(),
              metadata = library.local_artists.metadata || excluded.metadata
        returning 1;
    """


def _upsert_local_album_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        artist_match as (
          select library.local_artists.id
          from library.local_artists
          join bootstrap_context on bootstrap_context.library_id = library.local_artists.library_id
          where library.local_artists.artist_key = %s
          limit 1
        )
        insert into library.local_albums (
          library_id,
          artist_id,
          album_key,
          title,
          release_year,
          cover_path,
          mbid,
          mbid_assertion_state,
          evidence_source,
          evidence_confidence,
          mbid_assertion_migration_run_id,
          mbid_assertion_scan_run_ref,
          metadata
        )
        select
          bootstrap_context.library_id,
          (select id from artist_match),
          %s,
          %s,
          %s,
          %s,
          %s::uuid,
          %s,
          %s,
          %s,
          %s::bigint,
          %s,
          %s::jsonb
        from bootstrap_context
        on conflict (library_id, album_key) do update
          set artist_id = excluded.artist_id,
              title = excluded.title,
              release_year = excluded.release_year,
              cover_path = excluded.cover_path,
              mbid = excluded.mbid,
              mbid_assertion_state = excluded.mbid_assertion_state,
              evidence_source = excluded.evidence_source,
              evidence_confidence = excluded.evidence_confidence,
              mbid_assertion_migration_run_id = excluded.mbid_assertion_migration_run_id,
              mbid_assertion_scan_run_ref = excluded.mbid_assertion_scan_run_ref,
              last_seen_at = now(),
              metadata = library.local_albums.metadata || excluded.metadata
        returning 1;
    """


def _upsert_local_album_featured_artist_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        album_match as (
          select library.local_albums.id
          from library.local_albums
          join bootstrap_context on bootstrap_context.library_id = library.local_albums.library_id
          where library.local_albums.album_key = %s
          limit 1
        ),
        artist_match as (
          select library.local_artists.id
          from library.local_artists
          join bootstrap_context on bootstrap_context.library_id = library.local_artists.library_id
          where library.local_artists.artist_key = %s
          limit 1
        )
        insert into library.local_album_featured_artists (
          library_id,
          album_id,
          artist_id,
          featured_kind,
          metadata
        )
        select
          bootstrap_context.library_id,
          (select id from album_match),
          (select id from artist_match),
          %s,
          %s::jsonb
        from bootstrap_context
        where exists (select 1 from album_match)
          and exists (select 1 from artist_match)
        on conflict (library_id, album_id, artist_id, featured_kind) do update
          set last_seen_at = now(),
              metadata = library.local_album_featured_artists.metadata || excluded.metadata
        returning 1;
    """


def _upsert_local_track_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        album_match as (
          select library.local_albums.id
          from library.local_albums
          join bootstrap_context on bootstrap_context.library_id = library.local_albums.library_id
          where library.local_albums.album_key = %s
          limit 1
        ),
        artist_match as (
          select library.local_artists.id
          from library.local_artists
          join bootstrap_context on bootstrap_context.library_id = library.local_artists.library_id
          where library.local_artists.artist_key = %s
          limit 1
        )
        insert into library.local_tracks (
          library_id,
          album_id,
          artist_id,
          track_key,
          title,
          disc_number,
          track_number,
          duration_seconds,
          mbid,
          mbid_assertion_state,
          evidence_source,
          evidence_confidence,
          mbid_assertion_migration_run_id,
          mbid_assertion_scan_run_ref,
          metadata
        )
        select
          bootstrap_context.library_id,
          (select id from album_match),
          (select id from artist_match),
          %s,
          %s,
          %s,
          %s,
          %s,
          %s::uuid,
          %s,
          %s,
          %s,
          %s::bigint,
          %s,
          %s::jsonb
        from bootstrap_context
        on conflict (library_id, track_key) do update
          set album_id = excluded.album_id,
              artist_id = excluded.artist_id,
              title = excluded.title,
              disc_number = excluded.disc_number,
              track_number = excluded.track_number,
              duration_seconds = excluded.duration_seconds,
              mbid = excluded.mbid,
              mbid_assertion_state = excluded.mbid_assertion_state,
              evidence_source = excluded.evidence_source,
              evidence_confidence = excluded.evidence_confidence,
              mbid_assertion_migration_run_id = excluded.mbid_assertion_migration_run_id,
              mbid_assertion_scan_run_ref = excluded.mbid_assertion_scan_run_ref,
              last_seen_at = now(),
              metadata = library.local_tracks.metadata || excluded.metadata
        returning 1;
    """


def _upsert_local_track_file_sql() -> str:
    return """
        with input_row as (
          select
            %s::text as track_key,
            %s::text as private_path,
            %s::text as relative_path,
            %s::bigint as file_size_bytes,
            %s::timestamptz as modified_at,
            %s::text as content_signature,
            %s::jsonb as metadata
        ),
        bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        track_match as (
          select library.local_tracks.id
          from library.local_tracks
          join bootstrap_context on bootstrap_context.library_id = library.local_tracks.library_id
          cross join input_row
          where library.local_tracks.track_key = input_row.track_key
          limit 1
        )
        insert into library.local_track_files (
          track_id,
          library_root_id,
          private_path,
          relative_path,
          file_size_bytes,
          modified_at,
          content_signature,
          metadata
        )
        select
          (select id from track_match),
          library.require_local_track_file_root_id(
            bootstrap_context.library_id,
            input_row.private_path,
            input_row.metadata
          ),
          input_row.private_path,
          input_row.relative_path,
          input_row.file_size_bytes,
          input_row.modified_at,
          input_row.content_signature,
          input_row.metadata
        from bootstrap_context
        cross join input_row
        where exists (select 1 from track_match)
        on conflict (private_path) do update
          set track_id = excluded.track_id,
              library_root_id = excluded.library_root_id,
              relative_path = excluded.relative_path,
              file_size_bytes = excluded.file_size_bytes,
              modified_at = excluded.modified_at,
              content_signature = excluded.content_signature,
              last_seen_at = now(),
              metadata = library.local_track_files.metadata || excluded.metadata
        returning 1;
    """


def _insert_local_artist_mbid_assertion_sql() -> str:
    return """
        with bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        artist_match as (
          select library.local_artists.id
          from library.local_artists
          join bootstrap_context on bootstrap_context.library_id = library.local_artists.library_id
          where library.local_artists.artist_key = %s
          limit 1
        ),
        proposed_assertion as (
          select
            (select id from artist_match) as artist_id,
            %s as evidence_source,
            %s::uuid as mbid,
            %s as mbid_assertion_state,
            %s as confidence,
            %s as explanation,
            %s::jsonb as source_payload,
            %s::bigint as migration_run_id
          where exists (select 1 from artist_match)
        )
        insert into library.local_artist_mbid_assertions (
          artist_id,
          evidence_source,
          mbid,
          mbid_assertion_state,
          confidence,
          explanation,
          migration_run_id,
          source_payload
        )
        select
          proposed_assertion.artist_id,
          proposed_assertion.evidence_source,
          proposed_assertion.mbid,
          proposed_assertion.mbid_assertion_state,
          proposed_assertion.confidence,
          proposed_assertion.explanation,
          proposed_assertion.migration_run_id,
          proposed_assertion.source_payload
        from proposed_assertion
        where not exists (
          select 1
          from library.local_artist_mbid_assertions existing
          where existing.artist_id = proposed_assertion.artist_id
            and existing.evidence_source = proposed_assertion.evidence_source
            and existing.mbid is not distinct from proposed_assertion.mbid
            and existing.mbid_assertion_state = proposed_assertion.mbid_assertion_state
            and existing.source_payload = proposed_assertion.source_payload
        )
        returning 1;
    """


def _insert_local_mbid_assertion_sql() -> str:
    return """
        with input_row as (
          select
            %s as target_kind,
            %s as target_key,
            %s as artist_key,
            %s as album_key,
            %s as track_key,
            %s as evidence_source,
            %s::uuid as mbid,
            %s as mbid_assertion_state,
            %s as confidence,
            %s as explanation,
            %s::jsonb as source_payload,
            %s::bigint as migration_run_id
        ),
        bootstrap_context as (
          select library.libraries.id as library_id
          from app.bootstrap_owners
          join library.libraries
            on library.libraries.owner_account_id = app.bootstrap_owners.account_id
           and library.libraries.name = 'Local Library'
           and library.libraries.library_kind = 'local'
          where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
          limit 1
        ),
        artist_match as (
          select library.local_artists.id
          from library.local_artists
          join bootstrap_context on bootstrap_context.library_id = library.local_artists.library_id
          join input_row on input_row.target_kind = 'artist'
          where library.local_artists.artist_key = input_row.artist_key
          limit 1
        ),
        album_match as (
          select library.local_albums.id
          from library.local_albums
          join bootstrap_context on bootstrap_context.library_id = library.local_albums.library_id
          join input_row on input_row.target_kind = 'album'
          where library.local_albums.album_key = input_row.album_key
          limit 1
        ),
        track_match as (
          select library.local_tracks.id
          from library.local_tracks
          join bootstrap_context on bootstrap_context.library_id = library.local_tracks.library_id
          join input_row on input_row.target_kind = 'track'
          where library.local_tracks.track_key = input_row.track_key
          limit 1
        ),
        proposed_assertion as (
          select
            bootstrap_context.library_id,
            (select id from artist_match) as artist_id,
            (select id from album_match) as album_id,
            (select id from track_match) as track_id,
            input_row.target_kind,
            input_row.target_key,
            input_row.evidence_source,
            input_row.mbid,
            input_row.mbid_assertion_state,
            input_row.confidence,
            input_row.explanation,
            input_row.migration_run_id,
            input_row.source_payload
          from input_row
          cross join bootstrap_context
          where (
            input_row.target_kind = 'artist'
            and exists (select 1 from artist_match)
          ) or (
            input_row.target_kind = 'album'
            and exists (select 1 from album_match)
          ) or (
            input_row.target_kind = 'track'
            and exists (select 1 from track_match)
          )
        )
        insert into library.local_mbid_assertions (
          library_id,
          artist_id,
          album_id,
          track_id,
          target_kind,
          target_key,
          evidence_source,
          mbid,
          mbid_assertion_state,
          confidence,
          explanation,
          migration_run_id,
          source_payload
        )
        select
          proposed_assertion.library_id,
          proposed_assertion.artist_id,
          proposed_assertion.album_id,
          proposed_assertion.track_id,
          proposed_assertion.target_kind,
          proposed_assertion.target_key,
          proposed_assertion.evidence_source,
          proposed_assertion.mbid,
          proposed_assertion.mbid_assertion_state,
          proposed_assertion.confidence,
          proposed_assertion.explanation,
          proposed_assertion.migration_run_id,
          proposed_assertion.source_payload
        from proposed_assertion
        where not exists (
          select 1
          from library.local_mbid_assertions existing
          where existing.library_id = proposed_assertion.library_id
            and existing.target_kind = proposed_assertion.target_kind
            and existing.artist_id is not distinct from proposed_assertion.artist_id
            and existing.album_id is not distinct from proposed_assertion.album_id
            and existing.track_id is not distinct from proposed_assertion.track_id
            and existing.evidence_source = proposed_assertion.evidence_source
            and existing.mbid is not distinct from proposed_assertion.mbid
            and existing.mbid_assertion_state = proposed_assertion.mbid_assertion_state
            and existing.source_payload = proposed_assertion.source_payload
        )
        returning 1;
    """


def _listen_history_track_key(row: dict[str, object]) -> str | None:
    for key in ("track_ref", "path", "track_key"):
        normalized = normalize_track_ref(row.get(key))
        if normalized:
            return normalized
    return None


def _listen_history_timestamp(row: dict[str, object]) -> str | None:
    for key in ("recorded_at", "played_at", "ended_at", "started_at"):
        normalized = _normalize_listen_timestamp(row.get(key))
        if normalized:
            return normalized
    return None


def _normalize_listen_timestamp(value: object) -> str | None:
    raw_timestamp = str(value or "").strip()
    if not raw_timestamp:
        return None
    candidate = raw_timestamp[:-1] + "+00:00" if raw_timestamp.endswith("Z") else raw_timestamp
    try:
        datetime.fromisoformat(candidate)
    except ValueError:
        return None
    return raw_timestamp


def _nonnegative_int(value: object) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _listen_history_source_key(row: dict[str, object]) -> str:
    explicit_id = str(row.get("id") or "").strip()
    if explicit_id:
        return explicit_id
    source_index = row.get("_source_index")
    payload = json.dumps(
        {
            "source_index": source_index,
            "row": row,
        },
        sort_keys=True,
        separators=(",", ":"),
        default=str,
    )
    return "sha256:" + hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _scrobble_status(row: dict[str, object]) -> str | None:
    if row.get("scrobble_status"):
        return str(row.get("scrobble_status"))
    if row.get("scrobbled"):
        return "scrobbled"
    if row.get("scrobble_eligible"):
        return "pending"
    return None


def _local_inventory_key(value: object) -> str:
    return " ".join(str(value or "").strip().casefold().split())


def _safe_float(value: object, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return float(default)


def _strict_float_or_none(value: object) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _normalize_uuid_text(value: object) -> str | None:
    raw_value = str(value or "").strip()
    if not raw_value:
        return None
    try:
        return str(uuid.UUID(raw_value))
    except (AttributeError, ValueError):
        return None


def _epoch_seconds_to_iso(value: object) -> str | None:
    epoch_seconds = _safe_float(value)
    if epoch_seconds <= 0:
        return None
    return datetime.fromtimestamp(epoch_seconds, tz=timezone.utc).isoformat()


def _relative_path_or_none(path_value: object, *, file_cache_root: object = None) -> str | None:
    text = str(path_value or "").strip()
    root = str(file_cache_root or "").strip()
    if not text or not root:
        return None
    try:
        return str(Path(text).relative_to(Path(root)))
    except ValueError:
        return None


def _summary(
    *,
    source_family: str,
    source_path: Path,
    source_count: int = 0,
    target_count: int = 0,
    skipped_count: int = 0,
    warning_count: int = 0,
    error_count: int = 0,
    rows: object | None = None,
) -> dict[str, object]:
    return {
        "source_family": source_family,
        "source_path": str(source_path),
        "source_count": source_count,
        "target_count": target_count,
        "skipped_count": skipped_count,
        "warning_count": warning_count,
        "error_count": error_count,
        "rows": rows or [],
    }


def _source_failure(source_family: str, source_path: Path, exc: Exception) -> dict[str, object]:
    return {
        "source_family": source_family,
        "source_path": str(source_path),
        "severity": "error",
        "message": str(exc),
    }


def _build_report(
    *,
    mode: str,
    data_dir: Path,
    summaries: list[dict[str, object]],
    failures: list[dict[str, object]],
    report_path: Path | None,
) -> dict[str, object]:
    report_summaries = [{key: value for key, value in summary.items() if key != "rows"} for summary in summaries]
    error_count = sum(int(summary.get("error_count", 0)) for summary in summaries)
    warning_count = sum(int(summary.get("warning_count", 0)) for summary in summaries)
    summarized_failure_keys = {
        (summary.get("source_family"), summary.get("source_path"))
        for summary in summaries
        if int(summary.get("error_count", 0)) or int(summary.get("warning_count", 0))
    }
    for failure in failures:
        failure_key = (failure.get("source_family"), failure.get("source_path"))
        if failure_key in summarized_failure_keys:
            continue
        if failure.get("severity") == "error":
            error_count += 1
        elif failure.get("severity") == "warning":
            warning_count += 1
    report: dict[str, object] = {
        "mode": mode,
        "data_dir": str(data_dir),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "summaries": report_summaries,
        "failures": failures,
        "source_count": sum(int(summary.get("source_count", 0)) for summary in summaries),
        "target_count": sum(int(summary.get("target_count", 0)) for summary in summaries),
        "skipped_count": sum(int(summary.get("skipped_count", 0)) for summary in summaries),
        "warning_count": warning_count,
        "error_count": error_count,
    }
    if report_path is not None:
        report["report_path"] = str(Path(report_path).expanduser().resolve(strict=False))
    return report


def _write_report(report_path: Path, report: dict[str, object]) -> None:
    resolved_report_path = Path(report_path).expanduser().resolve(strict=False)
    resolved_report_path.parent.mkdir(parents=True, exist_ok=True)
    resolved_report_path.write_text(
        json.dumps(report, indent=2, sort_keys=True),
        encoding="utf-8",
    )


def _print_report(report: dict[str, object]) -> None:
    print(
        "Migration {mode}: sources={source_count} targets={target_count} "
        "skipped={skipped_count} warnings={warning_count} errors={error_count}".format(**report)
    )
    for summary in report.get("summaries", []):
        if not isinstance(summary, dict):
            continue
        print(
            "- {source_family}: source={source_count} target={target_count} "
            "skipped={skipped_count} warnings={warning_count} errors={error_count}".format(
                **summary
            )
        )
    for failure in report.get("failures", []):
        if not isinstance(failure, dict):
            continue
        print(
            "- {severity}: {source_family}: {message}".format(
                severity=failure.get("severity", "error"),
                source_family=failure.get("source_family", "unknown"),
                message=failure.get("message", ""),
            ),
            file=sys.stderr,
        )


def _resolve_psql_path() -> str:
    path = shutil.which("psql")
    if path:
        return path
    fallback = Path(r"C:\PostgreSQL\18\bin\psql.exe")
    return str(fallback)


def _sql_guard_text(sql: str) -> str:
    chars = list(sql)
    index = 0
    while index < len(chars):
        current = chars[index]
        next_char = chars[index + 1] if index + 1 < len(chars) else ""
        if current == "'":
            chars[index] = " "
            index += 1
            while index < len(chars):
                if chars[index] == "'":
                    chars[index] = " "
                    if index + 1 < len(chars) and chars[index + 1] == "'":
                        chars[index + 1] = " "
                        index += 2
                        continue
                    index += 1
                    break
                chars[index] = " "
                index += 1
            continue
        if current == '"':
            chars[index] = " "
            index += 1
            while index < len(chars):
                if chars[index] == '"':
                    chars[index] = " "
                    if index + 1 < len(chars) and chars[index + 1] == '"':
                        chars[index + 1] = " "
                        index += 2
                        continue
                    index += 1
                    break
                chars[index] = " "
                index += 1
            continue
        if current == "-" and next_char == "-":
            chars[index] = " "
            chars[index + 1] = " "
            index += 2
            while index < len(chars) and chars[index] not in "\r\n":
                chars[index] = " "
                index += 1
            continue
        if current == "/" and next_char == "*":
            chars[index] = " "
            chars[index + 1] = " "
            index += 2
            while index < len(chars):
                if chars[index] == "*" and index + 1 < len(chars) and chars[index + 1] == "/":
                    chars[index] = " "
                    chars[index + 1] = " "
                    index += 2
                    break
                chars[index] = " "
                index += 1
            continue
        index += 1
    return "".join(chars)


def _render_sql(sql: str, params: object | None = None) -> str:
    if params is None:
        return sql
    values = list(params.values()) if isinstance(params, dict) else list(params)
    parts = sql.split("%s")
    placeholder_count = len(parts) - 1
    if placeholder_count != len(values):
        raise ValueError(
            f"SQL placeholder count ({placeholder_count}) does not match parameter count ({len(values)})."
        )
    rendered_parts: list[str] = []
    for index, part in enumerate(parts):
        rendered_parts.append(part)
        if index < len(values):
            rendered_parts.append(_sql_literal(values[index]))
    return "".join(rendered_parts)


def _sql_literal(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int | float):
        return str(value)
    if isinstance(value, dict | list):
        text = json.dumps(value, sort_keys=True, separators=(",", ":"))
    else:
        text = str(value)
    return "'" + text.replace("'", "''") + "'"


collect_lastfm_mbid_evidence_for_artists = local_mbid_assertions.collect_lastfm_mbid_evidence_for_artists
collect_lastfm_mbid_evidence_for_local_targets = (
    local_mbid_assertions.collect_lastfm_mbid_evidence_for_local_targets
)
classify_artist_mbid_evidence = local_mbid_assertions.classify_artist_mbid_evidence
classify_album_mbid_evidence = local_mbid_assertions.classify_album_mbid_evidence
classify_track_mbid_evidence = local_mbid_assertions.classify_track_mbid_evidence


if __name__ == "__main__":
    raise SystemExit(main())
