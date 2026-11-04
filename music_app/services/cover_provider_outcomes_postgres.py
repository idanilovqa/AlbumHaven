"""Durable automatic cover-provider outcomes.

This uses the existing operations table with a private source family.  It does
not share notification cleanup or expose provider response bodies.
"""
from __future__ import annotations

import json
from collections.abc import Mapping
from typing import Any

try:
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover
    psycopg = None
    dict_row = None

SOURCE_FAMILY = "automatic_cover_provider_outcomes_v1"


def _connect(url: str):
    if psycopg is None:
        raise RuntimeError("psycopg is required for provider outcomes")
    return psycopg.connect(url, row_factory=dict_row)


def persist_cover_provider_outcomes(
    config: Mapping[str, object] | None,
    *,
    album_id: object,
    album_key: object,
    outcomes: Mapping[str, Mapping[str, object]],
    connect=None,
) -> None:
    """Upsert current provider outcomes for one album, scoped to bootstrap library."""
    url = str((config or {}).get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
    if not url or not outcomes:
        return
    connector = connect or _connect
    with connector(url) as connection:
        with connection.transaction():
            for provider, outcome in outcomes.items():
                provider_name = str(provider or "unknown").strip().lower() or "unknown"
                task_key = f"{album_id}:{provider_name}"
                safe = {
                    "provider": provider_name,
                    "category": str(outcome.get("category") or "unknown"),
                    "http_status": outcome.get("http_status"),
                    "retry_at": outcome.get("retry_at"),
                }
                connection.execute(
                    """
                    with bootstrap_context as (
                      select library.libraries.id as library_id
                      from app.bootstrap_owners
                      join library.libraries on library.libraries.owner_account_id = app.bootstrap_owners.account_id
                       and library.libraries.name = 'Local Library'
                       and library.libraries.library_kind = 'local'
                      where app.bootstrap_owners.owner_key = 'local-bootstrap-owner'
                      limit 1
                    )
                    insert into ops.cover_lookup_tasks (
                      library_id, task_key, status, requested_at, completed_at,
                      album_key, selected_cover_private_path, provider_payload,
                      error_message, metadata
                    )
                    select library_id, %s, %s, now(), now(), %s, null, %s::jsonb,
                           %s, %s::jsonb from bootstrap_context
                    on conflict (library_id, (metadata->>'source_family'), task_key)
                    where library_id is not null and metadata ? 'source_family'
                    do update set status = excluded.status,
                      completed_at = excluded.completed_at,
                      album_key = excluded.album_key,
                      provider_payload = excluded.provider_payload,
                      error_message = excluded.error_message,
                      metadata = excluded.metadata
                    """,
                    (
                        task_key,
                        "failed" if safe["category"] not in {"no_candidate", "recovered"} else "completed",
                        str(album_key or ""),
                        json.dumps(safe),
                        f"{safe['category']} ({provider_name})",
                        json.dumps({"source_family": SOURCE_FAMILY, **safe}),
                    ),
                )
    if "search_spotify" in outcomes:
        from music_app.services.library_browse_postgres import invalidate_postgres_utility_projection_cache

        invalidate_postgres_utility_projection_cache(database_url=url, kinds=("problematic-files",))
