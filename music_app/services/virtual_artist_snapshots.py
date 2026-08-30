from __future__ import annotations

import threading
from datetime import datetime, timedelta, timezone
from typing import Protocol
from uuid import uuid4

from music_app.services.virtual_artist_snapshots_postgres import (
    PostgresVirtualArtistSnapshotStore,
)


JsonDict = dict[str, object]

_CANDIDATE_REF_PREFIX = "musicbrainz:artist:"
_DEFAULT_RELEASE_SCOPE = "studio_ep"
_SUPPORTED_RELEASE_SCOPES = {
    "studio_ep": "Studio & EP",
    "live": "Live",
    "compilation": "Compilation",
    "others": "Other Types",
    "all": "All Release Types",
}
_FRESH_WINDOW = timedelta(days=7)
_RETENTION_WINDOW = timedelta(days=14)
_RECENT_LOOKUP_LIMIT = 25
_SNAPSHOT_ROWS_LOCK = threading.Lock()
_RECENT_LOOKUP_ROWS_LOCK = threading.Lock()
_STORE_CONFIG_KEY = "VIRTUAL_ARTIST_SNAPSHOT_STORE"


class VirtualArtistSnapshotStore(Protocol):
    def load_snapshot_rows(self) -> list[JsonDict]:
        ...

    def save_snapshot_rows(self, rows: list[JsonDict]) -> None:
        ...

    def load_recent_lookup_rows(self) -> list[JsonDict]:
        ...

    def save_recent_lookup_rows(self, rows: list[JsonDict]) -> None:
        ...


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
    normalized = str(value or "").strip()
    if not normalized:
        return None
    try:
        return datetime.fromisoformat(normalized.replace("Z", "+00:00"))
    except ValueError:
        return None


def normalize_virtual_artist_release_scope(value: object) -> str:
    normalized = str(value or "").strip().casefold()
    return (
        normalized
        if normalized in _SUPPORTED_RELEASE_SCOPES
        else _DEFAULT_RELEASE_SCOPE
    )


def get_virtual_artist_release_scope_label(scope: object) -> str:
    return _SUPPORTED_RELEASE_SCOPES[
        normalize_virtual_artist_release_scope(scope)
    ]


def _store(config: dict[str, object]) -> VirtualArtistSnapshotStore:
    configured_store = config.get(_STORE_CONFIG_KEY)
    if configured_store is not None:
        return configured_store  # type: ignore[return-value]
    return PostgresVirtualArtistSnapshotStore(config)


def _load_snapshot_rows(config: dict[str, object]) -> list[JsonDict]:
    return [
        row
        for row in _store(config).load_snapshot_rows()
        if isinstance(row, dict)
    ]


def _save_snapshot_rows(
    config: dict[str, object],
    rows: list[JsonDict],
) -> None:
    _store(config).save_snapshot_rows(rows)


def _load_recent_lookup_rows(config: dict[str, object]) -> list[JsonDict]:
    return [
        row
        for row in _store(config).load_recent_lookup_rows()
        if isinstance(row, dict)
    ]


def _save_recent_lookup_rows(
    config: dict[str, object],
    rows: list[JsonDict],
) -> None:
    _store(config).save_recent_lookup_rows(
        _cap_recent_lookup_rows_per_actor(rows)
    )


def _cap_recent_lookup_rows_per_actor(rows: list[JsonDict]) -> list[JsonDict]:
    kept_rows: list[JsonDict] = []
    counts_by_actor: dict[str, int] = {}
    for row in rows:
        actor_key = _normalize_recent_lookup_actor_key(row.get("actor_key"))
        if actor_key is None:
            continue
        current_count = counts_by_actor.get(actor_key, 0)
        if current_count >= _RECENT_LOOKUP_LIMIT:
            continue
        counts_by_actor[actor_key] = current_count + 1
        kept_rows.append(row)
    return kept_rows


def _normalize_recent_lookup_actor_key(value: object) -> str | None:
    normalized = str(value or "").strip()
    return normalized or None


def _is_expired_snapshot_row(
    row: JsonDict,
    *,
    now: datetime,
) -> bool:
    expires_at = _parse_datetime(row.get("expires_at"))
    return expires_at is None or now > expires_at


def _purge_expired_snapshot_rows(
    config: dict[str, object],
    rows: list[JsonDict],
    *,
    now: datetime,
) -> list[JsonDict]:
    kept_rows = [
        row for row in rows if not _is_expired_snapshot_row(row, now=now)
    ]
    if len(kept_rows) != len(rows):
        _save_snapshot_rows(config, kept_rows)
    return kept_rows


def _build_artist_summary(
    *,
    display_name: str,
    sort_name: str,
    disambiguation_text: str,
) -> JsonDict:
    return {
        "display_name": display_name,
        "sort_name": sort_name,
        "disambiguation_text": disambiguation_text or None,
    }


def _build_source_provenance(
    *,
    candidate_ref: str,
    provider: str,
    provider_artist_id: str,
) -> JsonDict:
    return {
        "provider": provider,
        "provider_artist_id": provider_artist_id,
        "candidate_ref": candidate_ref,
        "capture_mode": "candidate_search_selection",
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
    provider = str(row.get("provider") or "musicbrainz").strip() or "musicbrainz"
    provider_artist_id = str(row.get("provider_artist_id") or "").strip()
    candidate_ref = str(row.get("candidate_ref") or "").strip()
    display_name = str(row.get("display_name") or "").strip()
    sort_name = str(row.get("sort_name") or display_name).strip() or display_name
    disambiguation_text = str(row.get("disambiguation_text") or "").strip()
    default_release_scope = normalize_virtual_artist_release_scope(
        row.get("default_release_scope")
    )
    return {
        "virtual_artist_ref": str(row.get("virtual_artist_ref") or "").strip(),
        "created_at": _serialize_datetime(created_at),
        "expires_at": _serialize_datetime(expires_at),
        "freshness_state": freshness_state,
        "refresh_state": (
            "not_needed"
            if freshness_state == "fresh"
            else "fast_first_refresh_later"
        ),
        "default_release_scope": default_release_scope,
        "artist_summary": _build_artist_summary(
            display_name=display_name,
            sort_name=sort_name,
            disambiguation_text=disambiguation_text,
        ),
        "source_provenance": _build_source_provenance(
            candidate_ref=candidate_ref,
            provider=provider,
            provider_artist_id=provider_artist_id,
        ),
    }


def _record_recent_lookup_row(
    config: dict[str, object],
    *,
    actor_key: object,
    virtual_artist_ref: str,
    active_release_scope: str,
    recorded_at: datetime,
) -> None:
    normalized_actor_key = _normalize_recent_lookup_actor_key(actor_key)
    if normalized_actor_key is None:
        return
    normalized_ref = str(virtual_artist_ref or "").strip()
    with _RECENT_LOOKUP_ROWS_LOCK:
        rows = _load_recent_lookup_rows(config)
        rows = [
            row
            for row in rows
            if not (
                str(row.get("virtual_artist_ref") or "").strip() == normalized_ref
                and _normalize_recent_lookup_actor_key(row.get("actor_key"))
                == normalized_actor_key
            )
        ]
        rows.insert(
            0,
            {
                "actor_key": normalized_actor_key,
                "virtual_artist_ref": normalized_ref,
                "active_release_scope": normalize_virtual_artist_release_scope(
                    active_release_scope
                ),
                "recorded_at": _serialize_datetime(recorded_at),
            },
        )
        _save_recent_lookup_rows(config, rows)


def record_recent_virtual_artist_lookup(
    config: dict[str, object],
    *,
    actor_key: object,
    virtual_artist_ref: str,
    active_release_scope: str,
    recorded_at: datetime | None = None,
) -> None:
    _record_recent_lookup_row(
        config,
        actor_key=actor_key,
        virtual_artist_ref=virtual_artist_ref,
        active_release_scope=active_release_scope,
        recorded_at=recorded_at or _utc_now(),
    )


def list_recent_virtual_artist_lookups(
    config: dict[str, object],
    *,
    actor_key: object,
) -> list[JsonDict]:
    normalized_actor_key = _normalize_recent_lookup_actor_key(actor_key)
    if normalized_actor_key is None:
        return []
    now = _utc_now()
    with _SNAPSHOT_ROWS_LOCK:
        snapshot_rows = _purge_expired_snapshot_rows(
            config,
            _load_snapshot_rows(config),
            now=now,
        )
    snapshots_by_ref = {
        str(row.get("virtual_artist_ref") or "").strip(): row
        for row in snapshot_rows
    }
    hydrated_rows: list[JsonDict] = []
    with _RECENT_LOOKUP_ROWS_LOCK:
        recent_rows = _load_recent_lookup_rows(config)
        kept_recent_rows: list[JsonDict] = []

        for row in recent_rows:
            row_actor_key = _normalize_recent_lookup_actor_key(row.get("actor_key"))
            if row_actor_key is None:
                continue
            virtual_artist_ref = str(row.get("virtual_artist_ref") or "").strip()
            snapshot_row = snapshots_by_ref.get(virtual_artist_ref)
            if snapshot_row is None:
                continue
            active_release_scope = normalize_virtual_artist_release_scope(
                row.get("active_release_scope")
                or snapshot_row.get("default_release_scope")
            )
            kept_recent_rows.append(
                {
                    "actor_key": row_actor_key,
                    "virtual_artist_ref": virtual_artist_ref,
                    "active_release_scope": active_release_scope,
                    "recorded_at": str(row.get("recorded_at") or "").strip() or None,
                }
            )
            if row_actor_key != normalized_actor_key:
                continue
            snapshot_payload = _build_snapshot_payload_from_row(
                snapshot_row,
                now=now,
            )
            hydrated_rows.append(
                {
                    "virtual_artist_ref": virtual_artist_ref,
                    "artist_summary": dict(
                        snapshot_payload.get("artist_summary") or {}
                    ),
                    "active_release_scope": active_release_scope,
                    "active_release_scope_label": get_virtual_artist_release_scope_label(
                        active_release_scope
                    ),
                    "freshness_state": snapshot_payload.get("freshness_state"),
                    "refresh_state": snapshot_payload.get("refresh_state"),
                    "created_at": snapshot_payload.get("created_at"),
                    "expires_at": snapshot_payload.get("expires_at"),
                    "read_route": (
                        f"/virtual-artists/{virtual_artist_ref}"
                        f"?release_scope={active_release_scope}"
                    ),
                }
            )

        if kept_recent_rows != recent_rows:
            _save_recent_lookup_rows(config, kept_recent_rows)

    return hydrated_rows


def _normalize_submit_payload(raw_payload: object) -> JsonDict:
    payload = dict(raw_payload) if isinstance(raw_payload, dict) else {}
    candidate_ref = str(payload.get("candidate_ref") or "").strip()
    if not candidate_ref.startswith(_CANDIDATE_REF_PREFIX):
        return {
            "ok": False,
            "error": (
                "Virtual Discography submit requires a MusicBrainz artist "
                "candidate_ref from /virtual-artists/search."
            ),
            "status_code": 400,
        }
    provider_artist_id = candidate_ref.removeprefix(_CANDIDATE_REF_PREFIX).strip()
    if not provider_artist_id:
        return {
            "ok": False,
            "error": (
                "Virtual Discography submit requires a MusicBrainz artist "
                "candidate_ref from /virtual-artists/search."
            ),
            "status_code": 400,
        }
    display_name = str(payload.get("display_name") or "").strip()
    if not display_name:
        return {
            "ok": False,
            "error": (
                "Virtual Discography submit requires the selected candidate "
                "display_name."
            ),
            "status_code": 400,
        }
    sort_name = str(payload.get("sort_name") or display_name).strip() or display_name
    disambiguation_text = str(payload.get("disambiguation_text") or "").strip()
    return {
        "ok": True,
        "candidate_ref": candidate_ref,
        "provider": "musicbrainz",
        "provider_artist_id": provider_artist_id,
        "display_name": display_name,
        "sort_name": sort_name,
        "disambiguation_text": disambiguation_text,
        "default_release_scope": normalize_virtual_artist_release_scope(
            payload.get("release_scope")
        ),
    }


def create_virtual_artist_snapshot(
    config: dict[str, object],
    raw_payload: object,
    *,
    actor_key: object,
) -> JsonDict:
    normalized = _normalize_submit_payload(raw_payload)
    if not normalized.get("ok"):
        return normalized

    now = _utc_now()
    with _SNAPSHOT_ROWS_LOCK:
        rows = _purge_expired_snapshot_rows(
            config,
            _load_snapshot_rows(config),
            now=now,
        )
        virtual_artist_ref = f"virtual-artist-{uuid4().hex[:12]}"
        expires_at = now + _RETENTION_WINDOW
        row = {
            "virtual_artist_ref": virtual_artist_ref,
            "candidate_ref": normalized["candidate_ref"],
            "provider": normalized["provider"],
            "provider_artist_id": normalized["provider_artist_id"],
            "display_name": normalized["display_name"],
            "sort_name": normalized["sort_name"],
            "disambiguation_text": normalized["disambiguation_text"],
            "default_release_scope": normalized["default_release_scope"],
            "created_at": _serialize_datetime(now),
            "expires_at": _serialize_datetime(expires_at),
        }
        rows.insert(0, row)
        _save_snapshot_rows(config, rows)
    record_recent_virtual_artist_lookup(
        config,
        actor_key=actor_key,
        virtual_artist_ref=virtual_artist_ref,
        active_release_scope=str(normalized["default_release_scope"]),
        recorded_at=now,
    )
    return {
        "ok": True,
        **_build_snapshot_payload_from_row(row, now=now),
    }


def read_virtual_artist_snapshot(
    config: dict[str, object],
    virtual_artist_ref: object,
) -> JsonDict:
    normalized_ref = str(virtual_artist_ref or "").strip()
    if not normalized_ref:
        return {
            "ok": False,
            "status": "missing",
        }
    now = _utc_now()
    with _SNAPSHOT_ROWS_LOCK:
        rows = _load_snapshot_rows(config)
        matched_index = None
        matched_row: JsonDict | None = None
        for index, row in enumerate(rows):
            if str(row.get("virtual_artist_ref") or "").strip() == normalized_ref:
                matched_index = index
                matched_row = row
                break
        if matched_row is None:
            return {
                "ok": False,
                "status": "missing",
            }
        if _is_expired_snapshot_row(matched_row, now=now):
            rows.pop(matched_index)
            _save_snapshot_rows(config, rows)
            expires_at = _parse_datetime(matched_row.get("expires_at")) or now
            return {
                "ok": False,
                "status": "expired",
                "virtual_artist_ref": normalized_ref,
                "expires_at": _serialize_datetime(expires_at),
                "freshness_state": "expired",
                "refresh_state": "requires_new_lookup",
            }
    return {
        "ok": True,
        "status": "found",
        **_build_snapshot_payload_from_row(matched_row, now=now),
    }
