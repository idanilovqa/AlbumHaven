from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

from music_app.services import virtual_release_snapshots as snapshot_module


class _FakeCursor:
    def __init__(self, rows: list[dict[str, object]] | None = None) -> None:
        self._rows = rows or []

    def fetchall(self) -> list[dict[str, object]]:
        return list(self._rows)

    def fetchone(self) -> dict[str, object] | None:
        return self._rows[0] if self._rows else None


class _FakePostgresConnection:
    def __init__(self) -> None:
        self.rows: dict[str, dict[str, object]] = {}
        self.executed_sql: list[str] = []

    def __enter__(self) -> "_FakePostgresConnection":
        return self

    def __exit__(self, exc_type: object, exc: object, tb: object) -> None:
        return None

    def execute(self, sql: str, params: tuple[object, ...] = ()) -> _FakeCursor:
        self.executed_sql.append(sql)
        normalized_sql = " ".join(sql.lower().split())
        if "bootstrap_context_ready" in normalized_sql:
            return _FakeCursor([{"bootstrap_context_ready": 1}])
        if "select ops.virtual_release_snapshots" in normalized_sql:
            return _FakeCursor(
                [
                    dict(row)
                    for row in self.rows.values()
                    if not isinstance(row.get("metadata"), dict)
                    or not row["metadata"].get("purged_at")
                ]
            )
        if "insert into ops.virtual_release_snapshots" in normalized_sql:
            (
                virtual_release_ref,
                title,
                artist_credit,
                release_kind,
                release_date,
                release_date_precision,
                source_attributions,
                source_provenance,
                created_at,
                expires_at,
                last_enriched_at,
                metadata,
            ) = params
            self.rows[str(virtual_release_ref)] = {
                "virtual_release_ref": virtual_release_ref,
                "title": title,
                "artist_credit": artist_credit,
                "release_kind": release_kind,
                "release_date": release_date,
                "release_date_precision": release_date_precision,
                "source_attributions": source_attributions,
                "source_provenance": source_provenance,
                "created_at": created_at,
                "expires_at": expires_at,
                "last_enriched_at": last_enriched_at,
                "metadata": metadata,
            }
            return _FakeCursor([{"saved": 1}])
        if "jsonb_set" in normalized_sql:
            purged_at, virtual_release_ref = params
            row = self.rows[str(virtual_release_ref)]
            metadata = row.get("metadata")
            row["metadata"] = dict(metadata) if isinstance(metadata, dict) else {}
            row["metadata"]["purged_at"] = purged_at
            return _FakeCursor([{"purged": 1}])
        raise AssertionError(f"Unexpected SQL: {sql}")


def _select_fake_postgres(
    monkeypatch: Any,
) -> tuple[dict[str, object], _FakePostgresConnection]:
    connection = _FakePostgresConnection()
    monkeypatch.setattr(snapshot_module, "psycopg", object())
    monkeypatch.setattr(snapshot_module, "Jsonb", None)
    monkeypatch.setattr(
        snapshot_module,
        "_connect",
        lambda database_url: connection,
    )
    return (
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://album_haven_app@localhost/app"},
        connection,
    )


def test_virtual_release_snapshot_round_trip_is_fresh_and_postgres_backed(
    monkeypatch,
):
    base_now = datetime(2026, 6, 22, 12, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(snapshot_module, "_utc_now", lambda: base_now)

    config, _connection = _select_fake_postgres(monkeypatch)
    created = snapshot_module.create_virtual_release_snapshot(
        config,
        {
            "virtual_release_ref": "  mb-release-group-123  ",
            "title": "  Heligoland  ",
            "artist_credit": [
                {"name": "  Massive Attack  "},
            ],
            "release_kind": " Album ",
            "release_date": "2026-07-10",
            "release_date_precision": "day",
            "source_attributions": [
                {
                    "provider_key": "musicbrainz",
                    "provider_label": "MusicBrainz",
                    "source_url": " https://musicbrainz.org/release-group/rg-123 ",
                    "source_label": "Release group",
                }
            ],
            "source_provenance": {
                "provider": "musicbrainz",
                "provider_release_group_id": "rg-123",
                "provider_release_id": "rel-456",
                "capture_mode": "test_seed",
            },
        },
    )

    assert created == {
        "ok": True,
        "virtual_release_ref": "mb-release-group-123",
        "created_at": "2026-06-22T12:00:00Z",
        "expires_at": "2026-07-06T12:00:00Z",
        "freshness_state": "fresh",
        "refresh_state": "not_needed",
        "release_detail": {
            "title": "Heligoland",
            "artist_credit": [
                {"name": "Massive Attack"},
            ],
            "release_kind": "Album",
            "release_date": "2026-07-10",
            "release_date_precision": "day",
            "release_timing_state": "upcoming",
            "countdown_target_at": "2026-07-10T00:00:00Z",
            "source_attributions": [
                {
                    "provider_key": "musicbrainz",
                    "provider_label": "MusicBrainz",
                    "source_url": "https://musicbrainz.org/release-group/rg-123",
                    "source_label": "Release group",
                    "creator_name": None,
                    "license_label": None,
                    "license_url": None,
                    "attribution_text": None,
                }
            ],
            "source_provenance": {
                "provider": "musicbrainz",
                "provider_release_group_id": "rg-123",
                "provider_release_id": "rel-456",
                "capture_mode": "test_seed",
            },
            "freshness_state": "fresh",
            "last_enriched_at": "2026-06-22T12:00:00Z",
            "queued_refresh_state": "not_queued",
        },
    }

    loaded = snapshot_module.read_virtual_release_snapshot(
        config,
        "mb-release-group-123",
    )

    assert loaded == {
        "ok": True,
        "status": "found",
        **created,
    }


def test_virtual_release_snapshot_round_trip_uses_postgres_without_json_fallback(
    monkeypatch,
):
    base_now = datetime(2026, 6, 22, 12, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(snapshot_module, "_utc_now", lambda: base_now)
    monkeypatch.setattr(
        snapshot_module,
        "save_json_file",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("virtual release snapshots must not write JSON")
        ),
        raising=False,
    )
    monkeypatch.setattr(
        snapshot_module,
        "load_json_file",
        lambda *args, **kwargs: (_ for _ in ()).throw(
            AssertionError("virtual release snapshots must not read JSON")
        ),
        raising=False,
    )
    config, connection = _select_fake_postgres(monkeypatch)

    created = snapshot_module.create_virtual_release_snapshot(
        config,
        {
            "virtual_release_ref": "mb-release-group-123",
            "title": "Heligoland",
        },
    )
    loaded = snapshot_module.read_virtual_release_snapshot(
        config,
        "mb-release-group-123",
    )

    assert created["ok"] is True
    assert loaded["ok"] is True
    assert loaded["status"] == "found"
    assert connection.rows["mb-release-group-123"]["title"] == "Heligoland"


def test_virtual_release_snapshot_expired_postgres_row_is_purged_after_first_read(
    monkeypatch,
):
    base_now = datetime(2026, 6, 22, 12, 0, tzinfo=timezone.utc)
    config, connection = _select_fake_postgres(monkeypatch)

    monkeypatch.setattr(snapshot_module, "_utc_now", lambda: base_now)
    snapshot_module.create_virtual_release_snapshot(
        config,
        {
            "virtual_release_ref": "mb-release-group-123",
            "title": "Heligoland",
        },
    )

    monkeypatch.setattr(
        snapshot_module,
        "_utc_now",
        lambda: base_now + timedelta(days=15),
    )
    expired = snapshot_module.read_virtual_release_snapshot(
        config,
        "mb-release-group-123",
    )
    missing = snapshot_module.read_virtual_release_snapshot(
        config,
        "mb-release-group-123",
    )

    assert expired == {
        "ok": False,
        "status": "expired",
        "virtual_release_ref": "mb-release-group-123",
        "expires_at": "2026-07-06T12:00:00Z",
        "freshness_state": "expired",
        "refresh_state": "requires_new_lookup",
    }
    assert missing == {
        "ok": False,
        "status": "missing",
    }
    assert connection.rows["mb-release-group-123"]["metadata"]["purged_at"]


def test_virtual_release_snapshot_round_trip_becomes_stale_before_expiry(
    monkeypatch,
):
    base_now = datetime(2026, 6, 22, 12, 0, tzinfo=timezone.utc)
    config, _connection = _select_fake_postgres(monkeypatch)

    monkeypatch.setattr(snapshot_module, "_utc_now", lambda: base_now)
    snapshot_module.create_virtual_release_snapshot(
        config,
        {
            "virtual_release_ref": "mb-release-group-123",
            "title": "Heligoland",
        },
    )

    monkeypatch.setattr(
        snapshot_module,
        "_utc_now",
        lambda: base_now + timedelta(days=8),
    )
    loaded = snapshot_module.read_virtual_release_snapshot(
        config,
        "mb-release-group-123",
    )

    assert loaded["ok"] is True
    assert loaded["status"] == "found"
    assert loaded["freshness_state"] == "stale"
    assert loaded["refresh_state"] == "fast_first_refresh_later"
    assert loaded["expires_at"] == "2026-07-06T12:00:00Z"


def test_virtual_release_snapshot_read_expires_and_is_removed(
    monkeypatch,
):
    base_now = datetime(2026, 6, 22, 12, 0, tzinfo=timezone.utc)
    config, _connection = _select_fake_postgres(monkeypatch)

    monkeypatch.setattr(snapshot_module, "_utc_now", lambda: base_now)
    snapshot_module.create_virtual_release_snapshot(
        config,
        {
            "virtual_release_ref": "mb-release-group-123",
            "title": "Heligoland",
        },
    )

    monkeypatch.setattr(
        snapshot_module,
        "_utc_now",
        lambda: base_now + timedelta(days=15),
    )
    expired = snapshot_module.read_virtual_release_snapshot(
        config,
        "mb-release-group-123",
    )
    missing = snapshot_module.read_virtual_release_snapshot(
        config,
        "mb-release-group-123",
    )

    assert expired == {
        "ok": False,
        "status": "expired",
        "virtual_release_ref": "mb-release-group-123",
        "expires_at": "2026-07-06T12:00:00Z",
        "freshness_state": "expired",
        "refresh_state": "requires_new_lookup",
    }
    assert missing == {
        "ok": False,
        "status": "missing",
    }


def test_virtual_release_snapshot_runtime_requires_postgres_database_url():
    try:
        snapshot_module.read_virtual_release_snapshot(
            {},
            "mb-release-group-123",
        )
    except RuntimeError as exc:
        assert "ALBUM_HAVEN_APP_DATABASE_URL" in str(exc)
    else:
        raise AssertionError("runtime virtual release snapshots must require Postgres")


def test_virtual_release_snapshot_submit_rejects_missing_ref_or_title():
    assert snapshot_module.create_virtual_release_snapshot(
        {},
        {
            "title": "Heligoland",
        },
    ) == {
        "ok": False,
        "error": "Virtual release snapshot requires a virtual_release_ref.",
        "status_code": 400,
    }

    assert snapshot_module.create_virtual_release_snapshot(
        {},
        {
            "virtual_release_ref": "mb-release-group-123",
        },
    ) == {
        "ok": False,
        "error": "Virtual release snapshot requires a title.",
        "status_code": 400,
    }


def test_virtual_release_snapshot_preserves_year_month_dates_without_day_countdown(
    monkeypatch,
):
    base_now = datetime(2026, 6, 22, 12, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(snapshot_module, "_utc_now", lambda: base_now)
    config, _connection = _select_fake_postgres(monkeypatch)

    payload = snapshot_module.create_virtual_release_snapshot(
        config,
        {
            "virtual_release_ref": "mb-release-group-month",
            "title": "Month Precision Release",
            "release_date": "2026-07",
            "release_date_precision": "month",
        },
    )

    assert payload["release_detail"]["release_date"] == "2026-07"
    assert payload["release_detail"]["release_date_precision"] == "month"
    assert payload["release_detail"]["release_timing_state"] == "upcoming"
    assert payload["release_detail"]["countdown_target_at"] is None


def test_virtual_release_snapshot_preserves_year_only_dates_without_forcing_state(
    monkeypatch,
):
    base_now = datetime(2026, 6, 22, 12, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(snapshot_module, "_utc_now", lambda: base_now)
    config, _connection = _select_fake_postgres(monkeypatch)

    payload = snapshot_module.create_virtual_release_snapshot(
        config,
        {
            "virtual_release_ref": "mb-release-group-year",
            "title": "Year Precision Release",
            "release_date": "2026",
            "release_date_precision": "year",
        },
    )

    assert payload["release_detail"]["release_date"] == "2026"
    assert payload["release_detail"]["release_date_precision"] == "year"
    assert payload["release_detail"]["release_timing_state"] == "unknown"
    assert payload["release_detail"]["countdown_target_at"] is None
