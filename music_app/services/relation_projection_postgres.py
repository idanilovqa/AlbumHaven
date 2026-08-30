from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import datetime, timezone
from hashlib import sha256
import json
from time import perf_counter
from typing import Any

from music_app.services.artist_family_postgres import (
    replace_artist_family_projection_in_transaction,
)
from music_app.services.cache import serialize_relation_views
from music_app.services.relation_projection_builder import (
    build_postgres_relation_views,
)

try:  # pragma: no cover - exercised when psycopg is installed locally.
    import psycopg
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb
except ImportError:  # pragma: no cover - keeps the module importable without psycopg.
    psycopg = None
    dict_row = None
    Jsonb = None


RELATION_PROJECTION_BUILDER_VERSION = "local-relation-builder-v9"
RELATION_PROJECTION_METADATA_KEY = "relation_projection"
_APP_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"
_PROJECTION_READY_MAX_ATTEMPTS = 3


def relation_projection_structure_complete(relation_views: object) -> bool:
    if not isinstance(relation_views, Mapping):
        return False
    required_mappings = (
        "alias_to_canonical",
        "canonical_to_aliases",
        "family_to_artists",
        "folder_related",
    )
    required_lists = (
        "artists",
        "artists_sidebar",
        "sidebar_families",
    )
    return all(isinstance(relation_views.get(key), Mapping) for key in required_mappings) and all(
        isinstance(relation_views.get(key), list) for key in required_lists
    )


def relation_projection_stale_reason(scan_cache: object) -> str:
    if not isinstance(scan_cache, Mapping):
        return "missing_projection"
    relation_views = scan_cache.get("relation_views")
    if not relation_projection_structure_complete(relation_views):
        return "missing_projection" if not relation_views else "incomplete_projection"
    metadata = scan_cache.get(RELATION_PROJECTION_METADATA_KEY)
    if not isinstance(metadata, Mapping):
        return "missing_readiness_metadata"
    if str(metadata.get("status") or "") != "ready":
        return "projection_not_ready"
    if str(metadata.get("builder_version") or "") != RELATION_PROJECTION_BUILDER_VERSION:
        return "builder_version_changed"
    source_fingerprint = str(metadata.get("source_fingerprint") or "")
    built_from_fingerprint = str(metadata.get("built_from_fingerprint") or "")
    if not source_fingerprint or source_fingerprint != built_from_fingerprint:
        return "source_fingerprint_changed"
    return ""


def relation_source_fingerprint(rows: list[object]) -> str:
    facts = sorted(
        {
            (
                _int_value(row, "album_id"),
                _int_value(row, "owner_artist_id"),
                _text_value(row, "owner_artist_name"),
                _text_value(row, "album_artist"),
                _bool_value(row, "album_is_compilation"),
                _int_value(row, "member_artist_id"),
                _text_value(row, "member_artist_name"),
                _text_value(row, "featured_kind"),
                _bool_value(row, "member_artist_is_album_wide_track_artist"),
                _text_value(row, "relation_evidence_kind"),
                _int_value(row, "track_file_id"),
                _text_value(row, "library_root_id"),
                _text_value(row, "root_path"),
                _text_value(row, "relative_path"),
                _text_value(row, "private_path"),
            )
            for row in rows
        }
    )
    payload = json.dumps(facts, ensure_ascii=False, separators=(",", ":"))
    return sha256(payload.encode("utf-8")).hexdigest()


def build_relation_views_from_postgres_rows(
    config: Mapping[str, object],
    rows: list[object],
) -> dict[str, object]:
    del config
    return build_postgres_relation_views(rows)


def build_ready_relation_projection_metadata(
    source_fingerprint: str,
    *,
    reason: str,
    duration_ms: float,
    built_at: str | None = None,
    source_row_count: int | None = None,
    phase_timings_ms: Mapping[str, object] | None = None,
) -> dict[str, object]:
    metadata = {
        "status": "ready",
        "builder_version": RELATION_PROJECTION_BUILDER_VERSION,
        "source_fingerprint": str(source_fingerprint),
        "built_from_fingerprint": str(source_fingerprint),
        "build_timestamp": built_at or datetime.now(timezone.utc).isoformat(),
        "duration_ms": round(max(float(duration_ms), 0.0), 2),
        "rebuild_reason": str(reason or "scan_publication"),
    }
    if source_row_count is not None:
        metadata["source_row_count"] = max(int(source_row_count), 0)
    if phase_timings_ms is not None:
        metadata["phase_timings_ms"] = {
            str(name): round(max(float(value or 0.0), 0.0), 2)
            for name, value in phase_timings_ms.items()
        }
    return metadata


def ensure_relation_projection_ready(
    config: Mapping[str, object],
    *,
    logger: object | None = None,
    connect: Callable[[str], Any] | None = None,
) -> dict[str, object]:
    database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
    if not database_url:
        raise RuntimeError("ALBUM_HAVEN_APP_DATABASE_URL is required for relation projection readiness.")
    connector = connect or _connect
    started_at = perf_counter()
    phase_timings_ms: dict[str, float] = {}
    source_row_count = 0
    with connector(database_url) as connection:
        snapshot_row = _first_row(connection.execute(_load_scan_cache_sql()))
    scan_cache = _scan_cache_from_row(snapshot_row)
    reason = relation_projection_stale_reason(scan_cache)
    if not reason:
        metadata = dict(scan_cache.get(RELATION_PROJECTION_METADATA_KEY) or {})
        return _projection_result(
            scan_cache.get("relation_views"),
            metadata,
            startup_rebuilt=False,
            reason="healthy",
            duration_ms=(perf_counter() - started_at) * 1000,
        )

    try:
        for attempt in range(_PROJECTION_READY_MAX_ATTEMPTS):
            phase_timings_ms = {
                "source_load": 0.0,
                "fingerprint": 0.0,
                "pure_build": 0.0,
                "family_link_replacement": 0.0,
                "snapshot_publication": 0.0,
            }
            source_connection = connector(database_url)
            try:
                baseline_snapshot_row = _first_row(
                    source_connection.execute(_load_scan_cache_sql())
                )
                baseline_scan_cache = _scan_cache_from_row(baseline_snapshot_row)
                baseline_metadata = dict(
                    baseline_scan_cache.get(RELATION_PROJECTION_METADATA_KEY) or {}
                )
                phase_started_at = perf_counter()
                rows = list(source_connection.execute(load_relation_source_rows_sql()).fetchall())
                phase_timings_ms["source_load"] = (
                    perf_counter() - phase_started_at
                ) * 1000
                source_row_count = len(rows)
                phase_started_at = perf_counter()
                source_fingerprint = relation_source_fingerprint(rows)
                phase_timings_ms["fingerprint"] = (
                    perf_counter() - phase_started_at
                ) * 1000
                phase_started_at = perf_counter()
                relation_views = build_relation_views_from_postgres_rows(config, rows)
                phase_timings_ms["pure_build"] = (
                    perf_counter() - phase_started_at
                ) * 1000
                if not relation_projection_structure_complete(relation_views):
                    raise RuntimeError("Relation projection builder returned an incomplete projection.")
            finally:
                close_source_connection = getattr(source_connection, "close", None)
                if callable(close_source_connection):
                    close_source_connection()

            retry_with_current_sources = False
            with connector(database_url) as connection:
                connection.execute(relation_projection_advisory_lock_sql())
                locked_snapshot_row = _first_row(connection.execute(_load_scan_cache_sql()))
                locked_scan_cache = _scan_cache_from_row(locked_snapshot_row)
                locked_metadata = dict(
                    locked_scan_cache.get(RELATION_PROJECTION_METADATA_KEY) or {}
                )
                baseline_publication_identity = (
                    str(baseline_metadata.get("status") or ""),
                    str(baseline_metadata.get("builder_version") or ""),
                    str(baseline_metadata.get("source_fingerprint") or ""),
                    str(baseline_metadata.get("built_from_fingerprint") or ""),
                )
                locked_publication_identity = (
                    str(locked_metadata.get("status") or ""),
                    str(locked_metadata.get("builder_version") or ""),
                    str(locked_metadata.get("source_fingerprint") or ""),
                    str(locked_metadata.get("built_from_fingerprint") or ""),
                )
                if (
                    str(locked_metadata.get("status") or "") == "stale"
                    and locked_publication_identity != baseline_publication_identity
                ):
                    retry_with_current_sources = True
                else:
                    locked_reason = relation_projection_stale_reason(locked_scan_cache)
                    if not locked_reason:
                        return _projection_result(
                            locked_scan_cache.get("relation_views"),
                            locked_metadata,
                            startup_rebuilt=False,
                            reason="healthy",
                            duration_ms=(perf_counter() - started_at) * 1000,
                        )
                    reason = locked_reason
                    scan_cache = locked_scan_cache
                    duration_ms = (perf_counter() - started_at) * 1000
                    metadata = build_ready_relation_projection_metadata(
                        source_fingerprint,
                        reason=reason,
                        duration_ms=duration_ms,
                        source_row_count=source_row_count,
                        phase_timings_ms=phase_timings_ms,
                    )
                    relations_last_built = datetime.now(timezone.utc).timestamp()
                    next_scan_cache = dict(scan_cache)
                    next_scan_cache["relation_views"] = serialize_relation_views(relation_views)
                    next_scan_cache["relations_last_built"] = relations_last_built
                    next_scan_cache[RELATION_PROJECTION_METADATA_KEY] = metadata
                    phase_started_at = perf_counter()
                    replace_artist_family_projection_in_transaction(
                        connection,
                        relation_views,
                        relations_last_built=relations_last_built,
                    )
                    phase_timings_ms["family_link_replacement"] = (
                        perf_counter() - phase_started_at
                    ) * 1000
                    phase_started_at = perf_counter()
                    connection.execute(
                        _save_scan_cache_sql(),
                        {"scan_cache": _jsonb(next_scan_cache)},
                    )
                    phase_timings_ms["snapshot_publication"] = (
                        perf_counter() - phase_started_at
                    ) * 1000
                    duration_ms = (perf_counter() - started_at) * 1000
            if not retry_with_current_sources:
                break
            reason = "source_fingerprint_changed"
            if attempt == _PROJECTION_READY_MAX_ATTEMPTS - 1:
                raise RuntimeError(
                    "Relation projection sources changed during all bounded publication attempts."
                )
    except Exception as exc:
        _persist_failed_projection_status(
            database_url,
            reason=reason,
            duration_ms=(perf_counter() - started_at) * 1000,
            error=exc,
            connect=connector,
        )
        if logger is not None:
            logger.error(
                "Relation projection startup rebuild failed reason=%s duration_ms=%.2f error=%s",
                reason,
                (perf_counter() - started_at) * 1000,
                exc,
            )
        raise RuntimeError(f"Relation projection startup rebuild failed ({reason}): {exc}") from exc

    if logger is not None:
        logger.info(
            "Relation projection startup readiness ready=true rebuilt=true "
            "reason=%s builder_version=%s source_row_count=%d duration_ms=%.2f "
            "source_load=%.2f fingerprint=%.2f pure_build=%.2f "
            "family_link_replacement=%.2f snapshot_publication=%.2f",
            reason,
            RELATION_PROJECTION_BUILDER_VERSION,
            source_row_count,
            duration_ms,
            phase_timings_ms["source_load"],
            phase_timings_ms["fingerprint"],
            phase_timings_ms["pure_build"],
            phase_timings_ms["family_link_replacement"],
            phase_timings_ms["snapshot_publication"],
        )
    return _projection_result(
        relation_views,
        metadata,
        startup_rebuilt=True,
        reason=reason,
        duration_ms=duration_ms,
        source_row_count=source_row_count,
        phase_timings_ms=phase_timings_ms,
    )


def _projection_result(
    relation_views: object,
    metadata: Mapping[str, object],
    *,
    startup_rebuilt: bool,
    reason: str,
    duration_ms: float,
    source_row_count: int | None = None,
    phase_timings_ms: Mapping[str, object] | None = None,
) -> dict[str, object]:
    stored_timings = metadata.get("phase_timings_ms")
    timings = phase_timings_ms if phase_timings_ms is not None else stored_timings
    if not isinstance(timings, Mapping):
        timings = {}
    result = {
        "ready": True,
        "builder_version": str(metadata.get("builder_version") or RELATION_PROJECTION_BUILDER_VERSION),
        "startup_rebuilt": bool(startup_rebuilt),
        "rebuild_reason": str(reason),
        "duration_ms": round(max(float(duration_ms), 0.0), 2),
        "relation_views": dict(relation_views or {}),
    }
    if source_row_count is not None or "source_row_count" in metadata:
        result["source_row_count"] = max(
            int(source_row_count if source_row_count is not None else metadata.get("source_row_count") or 0),
            0,
        )
    if timings:
        result["phase_timings_ms"] = {
            str(name): round(max(float(value or 0.0), 0.0), 2)
            for name, value in timings.items()
        }
    return result


def _persist_failed_projection_status(
    database_url: str,
    *,
    reason: str,
    duration_ms: float,
    error: Exception,
    connect: Callable[[str], Any],
) -> None:
    failure_metadata = {
        "status": "failed",
        "builder_version": RELATION_PROJECTION_BUILDER_VERSION,
        "duration_ms": round(max(float(duration_ms), 0.0), 2),
        "rebuild_reason": str(reason),
        "failed_at": datetime.now(timezone.utc).isoformat(),
        "error_type": type(error).__name__,
    }
    try:
        with connect(database_url) as connection:
            connection.execute(relation_projection_advisory_lock_sql())
            locked_snapshot_row = _first_row(connection.execute(_load_scan_cache_sql()))
            locked_scan_cache = _scan_cache_from_row(locked_snapshot_row)
            if not relation_projection_stale_reason(locked_scan_cache):
                return
            connection.execute(
                _merge_failed_projection_status_sql(),
                {"relation_projection": _jsonb(failure_metadata)},
            )
    except Exception:
        pass


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for Postgres relation projection readiness.")
    return psycopg.connect(database_url, row_factory=dict_row)


def _jsonb(value: object) -> object:
    return Jsonb(value) if Jsonb is not None else value


def _row_mapping(row: object) -> dict[str, object]:
    if isinstance(row, dict):
        return row
    if hasattr(row, "keys"):
        return {str(key): row[key] for key in row.keys()}
    return {}


def _first_row(cursor: object) -> object | None:
    fetchone = getattr(cursor, "fetchone", None)
    return fetchone() if callable(fetchone) else None


def _scan_cache_from_row(row: object | None) -> dict[str, object]:
    payload = _row_mapping(row).get("scan_cache") if row is not None else None
    return dict(payload) if isinstance(payload, Mapping) else {}


def _text_value(row: object, key: str) -> str:
    return str(_row_mapping(row).get(key) or "").strip()


def _int_value(row: object, key: str) -> int:
    try:
        return int(_row_mapping(row).get(key) or 0)
    except (TypeError, ValueError):
        return 0


def _bool_value(row: object, key: str) -> bool:
    value = _row_mapping(row).get(key)
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value == 1
    return str(value or "").strip().casefold() in {
        "1",
        "t",
        "true",
        "y",
        "yes",
        "on",
    }


def _load_scan_cache_sql() -> str:
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
        select library.libraries.metadata -> 'scan_cache' as scan_cache
        from library.libraries
        join bootstrap_context on bootstrap_context.library_id = library.libraries.id
        limit 1;
    """


def _save_scan_cache_sql() -> str:
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
        update library.libraries
           set metadata = library.libraries.metadata || jsonb_build_object('scan_cache', %(scan_cache)s::jsonb),
               updated_at = now()
        from bootstrap_context
        where library.libraries.id = bootstrap_context.library_id;
    """


def _merge_failed_projection_status_sql() -> str:
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
        update library.libraries
           set metadata = library.libraries.metadata || jsonb_build_object(
                 'scan_cache',
                 coalesce(library.libraries.metadata -> 'scan_cache', '{}'::jsonb)
                   || jsonb_build_object(
                        'relation_projection',
                        %(relation_projection)s::jsonb
                      )
               ),
               updated_at = now()
        from bootstrap_context
        where library.libraries.id = bootstrap_context.library_id;
    """


def load_relation_source_rows_sql() -> str:
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
        album_track_artist_summary as (
          select
            library.local_tracks.library_id,
            library.local_tracks.album_id,
            min(library.local_tracks.artist_id) as sole_track_artist_id
          from library.local_tracks
          join bootstrap_context
            on bootstrap_context.library_id = library.local_tracks.library_id
          join library.local_track_files
            on library.local_track_files.track_id = library.local_tracks.id
           and library.local_track_files.scan_cache_stale is false
          where library.local_tracks.album_id is not null
          group by
            library.local_tracks.library_id,
            library.local_tracks.album_id
          having count(*) = count(library.local_tracks.artist_id)
             and count(distinct library.local_tracks.artist_id) = 1
        )
        select
          library.local_albums.id as album_id,
          owner_artist.id as owner_artist_id,
          owner_artist.name as owner_artist_name,
          coalesce(nullif(library.local_albums.metadata ->> 'album_artist', ''), owner_artist.name) as album_artist,
          lower(btrim(coalesce(
            library.local_albums.metadata ->> 'is_compilation',
            'false'
          ))) in ('true', 't', 'yes', 'y', 'on', '1') as album_is_compilation,
          member_artist.id as member_artist_id,
          member_artist.name as member_artist_name,
          library.local_album_featured_artists.featured_kind,
          coalesce(
            album_track_artist_summary.sole_track_artist_id = member_artist.id,
            false
          ) as member_artist_is_album_wide_track_artist,
          coalesce(
            case
              when regexp_replace(
                     replace(lower(btrim(coalesce(library.library_roots.root_path, ''))), chr(92), '/'),
                     '/+$',
                     ''
                   ) ~ '(^|/)(soundtracks?|ost)$'
                or regexp_replace(
                     replace(lower(btrim(coalesce(library.local_track_files.relative_path, ''))), chr(92), '/'),
                     '^/+',
                     ''
                   ) ~ '^(soundtracks?|ost)(/|$)'
                or (
                     nullif(btrim(coalesce(library.local_track_files.relative_path, '')), '') is null
                 and regexp_replace(
                       replace(lower(btrim(coalesce(library.library_roots.root_path, ''))), chr(92), '/'),
                       '/+$',
                       ''
                     ) <> ''
                 and left(
                       replace(
                         lower(btrim(coalesce(library.local_track_files.private_path, ''))),
                         chr(92),
                         '/'
                       ),
                       char_length(
                         regexp_replace(
                           replace(lower(btrim(coalesce(library.library_roots.root_path, ''))), chr(92), '/'),
                           '/+$',
                           ''
                         )
                       ) + 1
                     ) = regexp_replace(
                           replace(lower(btrim(coalesce(library.library_roots.root_path, ''))), chr(92), '/'),
                           '/+$',
                           ''
                         ) || '/'
                 and substring(
                       replace(
                         lower(btrim(coalesce(library.local_track_files.private_path, ''))),
                         chr(92),
                         '/'
                       )
                       from char_length(
                         regexp_replace(
                           replace(lower(btrim(coalesce(library.library_roots.root_path, ''))), chr(92), '/'),
                           '/+$',
                           ''
                         )
                       ) + 2
                     ) ~ '^(soundtracks?|ost)(/|$)'
                   )
              then 'soundtrack_root'
            end,
            nullif(library.local_album_featured_artists.metadata ->> 'relation_evidence_kind', ''),
            nullif(library.local_albums.metadata ->> 'relation_evidence_kind', ''),
            ''
          ) as relation_evidence_kind,
          library.local_track_files.id as track_file_id,
          library.local_track_files.library_root_id,
          library.library_roots.root_path,
          library.local_track_files.relative_path,
          library.local_track_files.private_path as private_path
        from library.local_albums
        join bootstrap_context on bootstrap_context.library_id = library.local_albums.library_id
        left join album_track_artist_summary
          on album_track_artist_summary.library_id = library.local_albums.library_id
         and album_track_artist_summary.album_id = library.local_albums.id
        left join library.local_artists as owner_artist
          on owner_artist.id = library.local_albums.artist_id
        left join library.local_album_featured_artists
          on library.local_album_featured_artists.library_id = library.local_albums.library_id
         and library.local_album_featured_artists.album_id = library.local_albums.id
        left join library.local_artists as member_artist
          on member_artist.id = library.local_album_featured_artists.artist_id
        join library.local_tracks
          on library.local_tracks.library_id = library.local_albums.library_id
         and library.local_tracks.album_id = library.local_albums.id
        join library.local_track_files
          on library.local_track_files.track_id = library.local_tracks.id
         and library.local_track_files.scan_cache_stale is false
        join library.library_roots
          on library.library_roots.id = library.local_track_files.library_root_id
         and library.library_roots.library_id = bootstrap_context.library_id
        order by
          library.local_albums.id,
          member_artist.id nulls first,
          library.local_track_files.id nulls first;
    """


def relation_projection_advisory_lock_sql() -> str:
    return """
        select pg_advisory_xact_lock(
          hashtextextended('album-haven:local-relation-projection', 0)
        );
    """
