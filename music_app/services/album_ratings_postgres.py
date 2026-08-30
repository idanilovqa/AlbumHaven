from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from contextlib import nullcontext
from typing import Any

try:  # pragma: no cover - exercised only when the optional runtime driver exists.
    import psycopg
    from psycopg.rows import dict_row
except ImportError:  # pragma: no cover - allows import-time diagnostics without the Postgres driver.
    psycopg = None
    dict_row = None


_APP_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"
_ALLOWED_IMPORT_SOURCES = frozenset({"file_tag_scan", "explicit_import"})


class PostgresAlbumRatingsService:
    def __init__(
        self,
        config: Mapping[str, object] | None,
        *,
        connect: Callable[[str], Any] | None = None,
    ) -> None:
        config_payload = config if isinstance(config, Mapping) else {}
        self._database_url = str(config_payload.get(_APP_DATABASE_URL_KEY) or "").strip()
        self._connect = connect or _connect

    def load_album_ratings(
        self,
        album_keys: Iterable[object],
        *,
        connection: Any | None = None,
    ) -> dict[str, dict[str, object]]:
        normalized_keys = _normalized_album_keys(album_keys)
        if not normalized_keys:
            return {}

        connection_context = (
            self._connect_to_database()
            if connection is None
            else nullcontext(connection)
        )
        with connection_context as ratings_connection:
            _ensure_bootstrap_context(ratings_connection)
            rows = list(
                ratings_connection.execute(
                    _load_album_ratings_sql(),
                    (normalized_keys,),
                ).fetchall()
            )

        ratings: dict[str, dict[str, object]] = {}
        for row in rows:
            payload = _row_mapping(row, ("album_key", "rating", "provenance"))
            album_key = _album_key(payload.get("album_key"))
            if not album_key:
                continue
            ratings[album_key] = {
                "rating": payload.get("rating"),
                "provenance": payload.get("provenance"),
            }
        return ratings

    def import_missing_tag_ratings(self) -> dict[str, int]:
        with self._connect_to_database() as connection:
            with _transaction(connection):
                _ensure_bootstrap_context(connection)
                row = _first_row(connection.execute(_import_missing_tag_ratings_sql()))
        return _write_counts(row)

    def seed_missing_album_ratings_in_transaction(
        self,
        connection: Any,
        candidates: Iterable[object],
        *,
        source: str,
    ) -> dict[str, int]:
        if source not in _ALLOWED_IMPORT_SOURCES:
            raise ValueError(
                "Album rating seed source must be 'file_tag_scan' or 'explicit_import'."
            )

        valid_candidates, invalid_count = _seed_candidates(candidates)
        if not valid_candidates:
            return {"created": 0, "authority_skipped": 0, "failed": invalid_count}

        album_keys = [album_key for album_key, _rating in valid_candidates]
        ratings = [rating for _album_key, rating in valid_candidates]
        row = _first_row(
            connection.execute(
                _seed_missing_album_ratings_sql(),
                (album_keys, ratings, source, source),
            )
        )
        counts = _write_counts(row)
        counts["failed"] += invalid_count
        return counts

    def _connect_to_database(self) -> Any:
        if not self._database_url:
            raise RuntimeError(
                "ALBUM_HAVEN_APP_DATABASE_URL is required for Postgres album ratings."
            )
        return self._connect(self._database_url)


class _NoopTransaction:
    def __enter__(self) -> "_NoopTransaction":
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        pass


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for Postgres album ratings.")
    return psycopg.connect(database_url, row_factory=dict_row)


def _transaction(connection: Any) -> Any:
    transaction = getattr(connection, "transaction", None)
    if callable(transaction):
        return transaction()
    return _NoopTransaction()


def _album_key(value: object) -> str:
    return str(value or "").strip()


def _normalized_album_keys(values: Iterable[object]) -> list[str]:
    return list(dict.fromkeys(key for value in values if (key := _album_key(value))))


def _seed_candidates(candidates: Iterable[object]) -> tuple[list[tuple[str, int]], int]:
    normalized: dict[str, int] = {}
    failed = 0
    for candidate in candidates:
        if not isinstance(candidate, Mapping):
            failed += 1
            continue
        album_key = _album_key(candidate.get("album_key"))
        rating = candidate.get("tag_album_rating")
        if rating is None:
            continue
        if not album_key or type(rating) is not int or not 1 <= rating <= 10:
            failed += 1
            continue
        normalized.setdefault(album_key, rating)
    return list(normalized.items()), failed


def _row_mapping(row: object, fields: tuple[str, ...]) -> dict[str, object]:
    if isinstance(row, Mapping):
        return {str(key): value for key, value in row.items()}
    if isinstance(row, (tuple, list)):
        return {field: row[index] for index, field in enumerate(fields) if index < len(row)}
    if hasattr(row, "keys"):
        return {str(key): row[key] for key in row.keys()}
    return {}


def _first_row(cursor: object) -> object | None:
    fetchone = getattr(cursor, "fetchone", None)
    if callable(fetchone):
        return fetchone()
    fetchall = getattr(cursor, "fetchall", None)
    rows = list(fetchall()) if callable(fetchall) else []
    return rows[0] if rows else None


def _write_counts(row: object | None) -> dict[str, int]:
    payload = _row_mapping(row, ("created", "authority_skipped", "failed"))
    return {
        "created": int(payload.get("created") or 0),
        "authority_skipped": int(payload.get("authority_skipped") or 0),
        "failed": int(payload.get("failed") or 0),
    }


def _ensure_bootstrap_context(connection: Any) -> None:
    if _first_row(connection.execute(_bootstrap_context_ready_sql())) is None:
        raise RuntimeError(
            "Postgres album ratings require the bootstrap local library context."
        )


def _bootstrap_context_sql() -> str:
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
    """


def _bootstrap_context_ready_sql() -> str:
    return _bootstrap_context_sql() + " select 1 as bootstrap_context_ready from bootstrap_context;"


def _load_album_ratings_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        select
          app.album_ratings.album_key,
          app.album_ratings.rating,
          app.album_ratings.provenance
        from app.album_ratings
        join bootstrap_context
          on app.album_ratings.account_id = bootstrap_context.account_id
         and app.album_ratings.library_id = bootstrap_context.library_id
        where app.album_ratings.album_key = any(%s::text[]);
    """
    )


def _import_missing_tag_ratings_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        , source_rows as (
          select
            bootstrap_context.account_id,
            bootstrap_context.library_id,
            library.local_albums.album_key,
            library.local_albums.metadata -> 'tag_album_rating' as tag_album_rating
          from bootstrap_context
          join library.local_albums
            on library.local_albums.library_id = bootstrap_context.library_id
        ),
        classified as (
          select
            source_rows.*,
            case
              when source_rows.tag_album_rating is null
                or jsonb_typeof(source_rows.tag_album_rating) = 'null'
                then 'absent'
              when jsonb_typeof(source_rows.tag_album_rating) = 'number' then
                case
                  when (source_rows.tag_album_rating #>> '{}') ~ '^[0-9]+$' then
                    case
                      when (source_rows.tag_album_rating #>> '{}')::numeric between 1 and 10
                        then 'valid'
                      else 'invalid'
                    end
                  else 'invalid'
                end
              else 'invalid'
            end as rating_state,
            case
              when jsonb_typeof(source_rows.tag_album_rating) = 'number' then
                case
                  when (source_rows.tag_album_rating #>> '{}') ~ '^[0-9]+$' then
                    case
                      when (source_rows.tag_album_rating #>> '{}')::numeric between 1 and 10
                        then (source_rows.tag_album_rating #>> '{}')::smallint
                      else null
                    end
                  else null
                end
              else null
            end as normalized_rating
          from source_rows
        ),
        valid_candidates as (
          select
            classified.account_id,
            classified.library_id,
            classified.album_key,
            classified.normalized_rating as rating
          from classified
          where classified.rating_state = 'valid'
        ),
        inserted as (
          insert into app.album_ratings (
            account_id,
            library_id,
            album_key,
            rating,
            provenance,
            metadata
          )
          select
            valid_candidates.account_id,
            valid_candidates.library_id,
            valid_candidates.album_key,
            valid_candidates.rating,
            'explicit_import',
            jsonb_build_object('source', 'explicit_import')
          from valid_candidates
          on conflict (account_id, library_id, album_key) do nothing
          returning 1
        )
        select
          (select count(*) from inserted)::integer as created,
          (
            (select count(*) from valid_candidates)
            - (select count(*) from inserted)
          )::integer as authority_skipped,
          (
            select count(*)
            from classified
            where classified.rating_state = 'invalid'
          )::integer as failed;
    """
    )


def _seed_missing_album_ratings_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        , candidates as (
          select candidate.album_key, candidate.rating
          from unnest(%s::text[], %s::smallint[]) as candidate(album_key, rating)
        ),
        eligible as (
          select
            bootstrap_context.account_id,
            bootstrap_context.library_id,
            library.local_albums.album_key,
            candidates.rating
          from candidates
          cross join bootstrap_context
          join library.local_albums
            on library.local_albums.library_id = bootstrap_context.library_id
           and library.local_albums.album_key = candidates.album_key
        ),
        inserted as (
          insert into app.album_ratings (
            account_id,
            library_id,
            album_key,
            rating,
            provenance,
            metadata
          )
          select
            eligible.account_id,
            eligible.library_id,
            eligible.album_key,
            eligible.rating,
            %s::text,
            jsonb_build_object('source', %s::text)
          from eligible
          on conflict (account_id, library_id, album_key) do nothing
          returning 1
        )
        select
          (select count(*) from inserted)::integer as created,
          (
            (select count(*) from eligible)
            - (select count(*) from inserted)
          )::integer as authority_skipped,
          (
            (select count(*) from candidates)
            - (select count(*) from eligible)
          )::integer as failed;
    """
    )
