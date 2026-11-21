from __future__ import annotations

import re
import threading
from collections.abc import Mapping
from datetime import date, datetime, time, timedelta, timezone
from typing import Any

from music_app.services.page_resource_seams import build_source_attribution_payload

try:  # pragma: no cover - exercised only when the optional runtime driver exists.
    import psycopg
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb
except ImportError:  # pragma: no cover - keeps the module importable without psycopg.
    psycopg = None
    dict_row = None
    Jsonb = None

JsonDict = dict[str, object]

_FRESH_WINDOW = timedelta(days=7)
_RETENTION_WINDOW = timedelta(days=14)
_SUPPORTED_RELEASE_DATE_PRECISIONS = {"day", "month", "year", "unknown"}
_SUPPORTED_RELEASE_TIMING_STATES = {"upcoming", "released", "unknown"}
_SNAPSHOT_ROWS_LOCK = threading.Lock()
_APP_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"
_SOURCE = "runtime_virtual_release_snapshots_adapter"


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _serialize_datetime(value: datetime) -> str:
    return (
        value.astimezone(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def _parse_datetime(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc)
    normalized = str(value or "").strip()
    if not normalized:
        return None
    try:
        return datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    except ValueError:
        return None


def _normalize_optional_text(value: object) -> str | None:
    normalized = str(value or "").strip()
    return normalized or None


def _normalize_release_artist_credit(value: object) -> list[JsonDict]:
    artist_credits: list[JsonDict] = []
    for item in list(value or []):
        if not isinstance(item, dict):
            continue
        name = _normalize_optional_text(item.get("name"))
        if not name:
            continue
        artist_credits.append({"name": name})
    return artist_credits


def _normalize_release_date(value: object) -> str | None:
    normalized = str(value or "").strip()
    if not normalized:
        return None
    if re.fullmatch(r"\d{4}", normalized):
        return normalized
    if re.fullmatch(r"\d{4}-\d{2}", normalized):
        year_text, month_text = normalized.split("-", 1)
        month = int(month_text)
        if 1 <= month <= 12:
            return f"{int(year_text):04d}-{month:02d}"
        return None
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", normalized):
        try:
            return date.fromisoformat(normalized).isoformat()
        except ValueError:
            return None
    return None


def _infer_release_date_precision(release_date: str | None) -> str:
    normalized = str(release_date or "").strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", normalized):
        return "day"
    if re.fullmatch(r"\d{4}-\d{2}", normalized):
        return "month"
    if re.fullmatch(r"\d{4}", normalized):
        return "year"
    return "unknown"


def _normalize_release_date_precision(
    value: object,
    *,
    release_date: str | None,
) -> str:
    normalized = str(value or "").strip().casefold()
    inferred_precision = _infer_release_date_precision(release_date)
    if normalized in _SUPPORTED_RELEASE_DATE_PRECISIONS:
        if (
            release_date
            and inferred_precision != "unknown"
            and normalized != inferred_precision
        ):
            return inferred_precision
        return normalized
    return inferred_precision


def _build_release_timing_fields(
    *,
    release_date: str | None,
    release_date_precision: str,
    now: datetime,
) -> tuple[str, str | None]:
    if not release_date:
        return "unknown", None
    if release_date_precision == "day":
        try:
            release_day = date.fromisoformat(release_date)
        except ValueError:
            return "unknown", None
        if release_day > now.date():
            return (
                "upcoming",
                _serialize_datetime(
                    datetime.combine(
                        release_day,
                        time.min,
                        tzinfo=timezone.utc,
                    )
                ),
            )
        return "released", None

    if release_date_precision == "month":
        try:
            year_text, month_text = release_date.split("-", 1)
            release_year = int(year_text)
            release_month = int(month_text)
        except (TypeError, ValueError):
            return "unknown", None
        if (release_year, release_month) > (now.year, now.month):
            return "upcoming", None
        if (release_year, release_month) < (now.year, now.month):
            return "released", None
        return "unknown", None

    if release_date_precision == "year":
        try:
            release_year = int(release_date)
        except ValueError:
            return "unknown", None
        if release_year > now.year:
            return "upcoming", None
        if release_year < now.year:
            return "released", None
        return "unknown", None

    return "unknown", None


def _normalize_source_provenance(value: object) -> JsonDict:
    if not isinstance(value, dict):
        return {}
    payload: JsonDict = {}
    for key in (
        "provider",
        "provider_release_group_id",
        "provider_release_id",
        "capture_mode",
    ):
        normalized = _normalize_optional_text(value.get(key))
        if normalized:
            payload[key] = normalized
    return payload


def _jsonb(value: object) -> object:
    if Jsonb is None:
        return value
    return Jsonb(value)


def _row_mapping(row: object) -> JsonDict:
    if isinstance(row, Mapping):
        return {str(key): value for key, value in row.items()}
    if hasattr(row, "keys"):
        return {str(key): row[key] for key in row.keys()}
    if isinstance(row, (tuple, list)):
        fields = (
            "virtual_release_ref",
            "title",
            "artist_credit",
            "release_kind",
            "release_date",
            "release_date_precision",
            "source_attributions",
            "source_provenance",
            "created_at",
            "expires_at",
            "last_enriched_at",
            "metadata",
        )
        return {
            field: row[index]
            for index, field in enumerate(fields)
            if index < len(row)
        }
    return {}


def _first_row(cursor: object) -> object | None:
    fetchone = getattr(cursor, "fetchone", None)
    if callable(fetchone):
        return fetchone()
    fetchall = getattr(cursor, "fetchall", None)
    rows = list(fetchall()) if callable(fetchall) else []
    return rows[0] if rows else None


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for Postgres virtual release snapshots.")
    return psycopg.connect(database_url, row_factory=dict_row)


def _connect_to_database(config: dict[str, object]) -> Any:
    database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
    if not database_url:
        raise RuntimeError(
            "ALBUM_HAVEN_APP_DATABASE_URL is required for Postgres virtual release snapshots."
        )
    return _connect(database_url)


def _ensure_bootstrap_context(connection: Any) -> None:
    if _first_row(connection.execute(_bootstrap_context_ready_sql())) is None:
        raise RuntimeError(
            "Postgres virtual release snapshots require the bootstrap local library context."
        )


def _bootstrap_context_sql() -> str:
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
    """


def _bootstrap_context_ready_sql() -> str:
    return _bootstrap_context_sql() + " select 1 as bootstrap_context_ready from bootstrap_context;"


def _load_snapshot_rows_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        select
          ops.virtual_release_snapshots.virtual_release_ref,
          ops.virtual_release_snapshots.title,
          ops.virtual_release_snapshots.artist_credit,
          ops.virtual_release_snapshots.release_kind,
          ops.virtual_release_snapshots.release_date,
          ops.virtual_release_snapshots.release_date_precision,
          ops.virtual_release_snapshots.source_attributions,
          ops.virtual_release_snapshots.source_provenance,
          ops.virtual_release_snapshots.created_at,
          ops.virtual_release_snapshots.expires_at,
          ops.virtual_release_snapshots.last_enriched_at,
          ops.virtual_release_snapshots.metadata
        from ops.virtual_release_snapshots
        join bootstrap_context
          on bootstrap_context.library_id = ops.virtual_release_snapshots.library_id
        where not ops.virtual_release_snapshots.metadata ? 'purged_at'
        order by ops.virtual_release_snapshots.created_at desc,
                 ops.virtual_release_snapshots.virtual_release_ref asc;
    """
    )


def _upsert_snapshot_row_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        insert into ops.virtual_release_snapshots (
          library_id,
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
          metadata
        )
        select
          bootstrap_context.library_id,
          %s,
          %s,
          %s::jsonb,
          %s,
          %s,
          %s,
          %s::jsonb,
          %s::jsonb,
          %s::timestamptz,
          %s::timestamptz,
          %s::timestamptz,
          %s::jsonb
        from bootstrap_context
        on conflict (library_id, virtual_release_ref) do update
          set title = excluded.title,
              artist_credit = excluded.artist_credit,
              release_kind = excluded.release_kind,
              release_date = excluded.release_date,
              release_date_precision = excluded.release_date_precision,
              source_attributions = excluded.source_attributions,
              source_provenance = excluded.source_provenance,
              created_at = excluded.created_at,
              expires_at = excluded.expires_at,
              last_enriched_at = excluded.last_enriched_at,
              metadata = excluded.metadata
        returning 1 as saved;
    """
    )


def _purge_snapshot_row_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        update ops.virtual_release_snapshots
        set metadata = jsonb_set(
              ops.virtual_release_snapshots.metadata,
              '{purged_at}',
              to_jsonb(%s::text),
              true
            )
        from bootstrap_context
        where ops.virtual_release_snapshots.library_id = bootstrap_context.library_id
          and ops.virtual_release_snapshots.virtual_release_ref = %s
          and not ops.virtual_release_snapshots.metadata ? 'purged_at'
        returning 1 as purged;
    """
    )


def _save_snapshot_row(
    connection: Any,
    row: JsonDict,
) -> None:
    cursor = connection.execute(
        _upsert_snapshot_row_sql(),
        (
            row["virtual_release_ref"],
            row["title"],
            _jsonb(row["artist_credit"]),
            row["release_kind"],
            row["release_date"],
            row["release_date_precision"],
            _jsonb(row["source_attributions"]),
            _jsonb(row["source_provenance"]),
            row["created_at"],
            row["expires_at"],
            row["last_enriched_at"],
            _jsonb({"source": _SOURCE}),
        ),
    )
    if _first_row(cursor) is None:
        raise RuntimeError(
            "Postgres virtual release snapshot write did not write a row."
        )


def _purge_snapshot_row(
    connection: Any,
    *,
    virtual_release_ref: str,
    purged_at: datetime,
) -> None:
    connection.execute(
        _purge_snapshot_row_sql(),
        (_serialize_datetime(purged_at), virtual_release_ref),
    )


def _normalize_release_detail_payload(
    raw_payload: object,
    *,
    now: datetime,
) -> JsonDict:
    payload = dict(raw_payload) if isinstance(raw_payload, dict) else {}
    virtual_release_ref = str(payload.get("virtual_release_ref") or "").strip()
    if not virtual_release_ref:
        return {
            "ok": False,
            "error": "Virtual release snapshot requires a virtual_release_ref.",
            "status_code": 400,
        }

    title = _normalize_optional_text(payload.get("title"))
    if not title:
        return {
            "ok": False,
            "error": "Virtual release snapshot requires a title.",
            "status_code": 400,
        }

    release_date = _normalize_release_date(payload.get("release_date"))
    release_date_precision = _normalize_release_date_precision(
        payload.get("release_date_precision"),
        release_date=release_date,
    )
    release_timing_state, countdown_target_at = _build_release_timing_fields(
        release_date=release_date,
        release_date_precision=release_date_precision,
        now=now,
    )
    if release_timing_state not in _SUPPORTED_RELEASE_TIMING_STATES:
        release_timing_state = "unknown"

    return {
        "ok": True,
        "virtual_release_ref": virtual_release_ref,
        "title": title,
        "artist_credit": _normalize_release_artist_credit(
            payload.get("artist_credit")
        ),
        "release_kind": _normalize_optional_text(payload.get("release_kind")),
        "release_date": release_date,
        "release_date_precision": release_date_precision,
        "release_timing_state": release_timing_state,
        "countdown_target_at": countdown_target_at,
        "source_attributions": [
            build_source_attribution_payload(item)
            for item in list(payload.get("source_attributions") or [])
            if isinstance(item, dict)
        ],
        "source_provenance": _normalize_source_provenance(
            payload.get("source_provenance")
        ),
    }


def _load_snapshot_rows(config: dict[str, object]) -> list[JsonDict]:
    with _connect_to_database(config) as connection:
        _ensure_bootstrap_context(connection)
        return [
            row
            for row in (_row_mapping(item) for item in connection.execute(_load_snapshot_rows_sql()).fetchall())
            if str(row.get("virtual_release_ref") or "").strip()
        ]


def _save_snapshot_rows(
    config: dict[str, object],
    rows: list[JsonDict],
) -> None:
    with _connect_to_database(config) as connection:
        _ensure_bootstrap_context(connection)
        for row in rows:
            _save_snapshot_row(connection, row)


def _purge_snapshot_rows(
    config: dict[str, object],
    *,
    virtual_release_refs: list[str],
    purged_at: datetime,
) -> None:
    refs = [str(item or "").strip() for item in virtual_release_refs if str(item or "").strip()]
    if not refs:
        return
    with _connect_to_database(config) as connection:
        _ensure_bootstrap_context(connection)
        for virtual_release_ref in refs:
            _purge_snapshot_row(
                connection,
                virtual_release_ref=virtual_release_ref,
                purged_at=purged_at,
            )


def _is_expired_snapshot_row(
    row: JsonDict,
    *,
    now: datetime,
) -> bool:
    expires_at = _parse_datetime(row.get("expires_at"))
    return expires_at is None or now > expires_at


def _build_release_detail_from_row(
    row: JsonDict,
    *,
    now: datetime,
) -> JsonDict:
    release_date = _normalize_release_date(row.get("release_date"))
    release_date_precision = _normalize_release_date_precision(
        row.get("release_date_precision"),
        release_date=release_date,
    )
    release_timing_state, countdown_target_at = _build_release_timing_fields(
        release_date=release_date,
        release_date_precision=release_date_precision,
        now=now,
    )
    last_enriched_at = _parse_datetime(row.get("last_enriched_at")) or now
    return {
        "title": _normalize_optional_text(row.get("title")),
        "artist_credit": _normalize_release_artist_credit(
            row.get("artist_credit")
        ),
        "release_kind": _normalize_optional_text(row.get("release_kind")),
        "release_date": release_date,
        "release_date_precision": release_date_precision,
        "release_timing_state": release_timing_state,
        "countdown_target_at": countdown_target_at,
        "source_attributions": [
            build_source_attribution_payload(item)
            for item in list(row.get("source_attributions") or [])
            if isinstance(item, dict)
        ],
        "source_provenance": _normalize_source_provenance(
            row.get("source_provenance")
        ),
        "freshness_state": (
            "fresh"
            if now
            - (_parse_datetime(row.get("created_at")) or now)
            <= _FRESH_WINDOW
            else "stale"
        ),
        "last_enriched_at": _serialize_datetime(last_enriched_at),
        "queued_refresh_state": "not_queued",
    }


def _build_snapshot_payload_from_row(
    row: JsonDict,
    *,
    now: datetime,
) -> JsonDict:
    created_at = _parse_datetime(row.get("created_at")) or now
    expires_at = _parse_datetime(row.get("expires_at")) or now
    freshness_state = (
        "fresh" if now - created_at <= _FRESH_WINDOW else "stale"
    )
    return {
        "virtual_release_ref": str(row.get("virtual_release_ref") or "").strip(),
        "created_at": _serialize_datetime(created_at),
        "expires_at": _serialize_datetime(expires_at),
        "freshness_state": freshness_state,
        "refresh_state": (
            "not_needed"
            if freshness_state == "fresh"
            else "fast_first_refresh_later"
        ),
        "release_detail": _build_release_detail_from_row(row, now=now),
    }


def create_virtual_release_snapshot(
    config: dict[str, object],
    raw_payload: object,
) -> JsonDict:
    now = _utc_now()
    normalized = _normalize_release_detail_payload(raw_payload, now=now)
    if not normalized.get("ok"):
        return normalized

    with _SNAPSHOT_ROWS_LOCK:
        rows = [
            row
            for row in _load_snapshot_rows(config)
            if not _is_expired_snapshot_row(row, now=now)
            and str(row.get("virtual_release_ref") or "").strip()
            != normalized["virtual_release_ref"]
        ]
        expires_at = now + _RETENTION_WINDOW
        row = {
            "virtual_release_ref": normalized["virtual_release_ref"],
            "title": normalized["title"],
            "artist_credit": list(normalized["artist_credit"]),
            "release_kind": normalized["release_kind"],
            "release_date": normalized["release_date"],
            "release_date_precision": normalized["release_date_precision"],
            "source_attributions": list(normalized["source_attributions"]),
            "source_provenance": dict(normalized["source_provenance"]),
            "created_at": _serialize_datetime(now),
            "expires_at": _serialize_datetime(expires_at),
            "last_enriched_at": _serialize_datetime(now),
        }
        rows.insert(0, row)
        _save_snapshot_rows(config, rows)
    return {
        "ok": True,
        **_build_snapshot_payload_from_row(row, now=now),
    }


def read_virtual_release_snapshot(
    config: dict[str, object],
    virtual_release_ref: object,
) -> JsonDict:
    normalized_ref = str(virtual_release_ref or "").strip()
    if not normalized_ref:
        return {
            "ok": False,
            "status": "missing",
        }

    now = _utc_now()
    with _SNAPSHOT_ROWS_LOCK:
        rows = _load_snapshot_rows(config)
        matched_row: JsonDict | None = None
        kept_rows: list[JsonDict] = []
        expired_refs: list[str] = []

        for row in rows:
            if _is_expired_snapshot_row(row, now=now):
                expired_refs.append(
                    str(row.get("virtual_release_ref") or "").strip()
                )
                continue
            kept_rows.append(row)
            if str(row.get("virtual_release_ref") or "").strip() == normalized_ref:
                matched_row = row

        if expired_refs:
            _purge_snapshot_rows(
                config,
                virtual_release_refs=expired_refs,
                purged_at=now,
            )

        if matched_row is None:
            expired_row = next(
                (
                    row
                    for row in rows
                    if str(row.get("virtual_release_ref") or "").strip()
                    == normalized_ref
                ),
                None,
            )
            if expired_row is not None:
                expires_at = _parse_datetime(expired_row.get("expires_at")) or now
                return {
                    "ok": False,
                    "status": "expired",
                    "virtual_release_ref": normalized_ref,
                    "expires_at": _serialize_datetime(expires_at),
                    "freshness_state": "expired",
                    "refresh_state": "requires_new_lookup",
                }
            return {
                "ok": False,
                "status": "missing",
            }

    return {
        "ok": True,
        "status": "found",
        **_build_snapshot_payload_from_row(matched_row, now=now),
    }
