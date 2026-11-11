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
        ratings: dict[str, dict[str, object]] = {}
        for row in self._load_owner_rows(_load_album_ratings_sql(), album_keys, connection):
            payload = _row_mapping(row, ("album_key", "rating", "provenance"))
            album_key = _album_key(payload.get("album_key"))
            if not album_key:
                continue
            ratings[album_key] = {
                "rating": payload.get("rating"),
                "provenance": payload.get("provenance"),
            }
        return ratings

    def load_album_disc_ratings(
        self,
        album_keys: Iterable[object],
        *,
        connection: Any | None = None,
    ) -> dict[str, list[dict[str, object]]]:
        disc_ratings: dict[str, list[dict[str, object]]] = {}
        for row in self._load_owner_rows(_load_album_disc_ratings_sql(), album_keys, connection):
            payload = _row_mapping(row, ("album_key", "disc_key", "rating"))
            album_key = _album_key(payload.get("album_key"))
            if album_key:
                disc_ratings.setdefault(album_key, []).append(
                    {
                        "disc_key": payload.get("disc_key"),
                        "rating": payload.get("rating"),
                    }
                )
        return disc_ratings

    def import_missing_tag_ratings(self) -> dict[str, object]:
        with self._connect_to_database() as connection:
            with _transaction(connection):
                _ensure_bootstrap_context(connection)
                row = _first_row(connection.execute(_import_missing_tag_ratings_sql()))
                disc_row = _first_row(
                    connection.execute(_import_missing_tag_disc_ratings_sql())
                )
        disc_counts = _write_counts(disc_row)
        del disc_counts["failed"]
        return {**_write_counts(row), "disc_ratings": disc_counts}

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

    def seed_missing_album_disc_ratings_in_transaction(
        self,
        connection: Any,
        candidates: Iterable[Mapping[str, object]],
        *,
        source: str,
    ) -> dict[str, int]:
        if source not in _ALLOWED_IMPORT_SOURCES:
            raise ValueError(
                "Album disc rating seed source must be 'file_tag_scan' or 'explicit_import'."
            )
        rows = [
            (candidate["album_key"], candidate["disc_key"], candidate["rating"])
            for candidate in candidates
        ]
        if not rows:
            return {"created": 0, "authority_skipped": 0, "failed": 0}
        album_keys, disc_keys, ratings = (list(column) for column in zip(*rows))
        return _write_counts(
            _first_row(
                connection.execute(
                    _seed_missing_album_disc_ratings_sql(),
                    (album_keys, disc_keys, ratings, source, source),
                )
            )
        )

    def _load_owner_rows(
        self,
        sql: str,
        album_keys: Iterable[object],
        connection: Any | None,
    ) -> list[object]:
        normalized_keys = _normalized_album_keys(album_keys)
        if not normalized_keys:
            return []
        connection_context = (
            self._connect_to_database()
            if connection is None
            else nullcontext(connection)
        )
        with connection_context as ratings_connection:
            _ensure_bootstrap_context(ratings_connection)
            return list(ratings_connection.execute(sql, (normalized_keys,)).fetchall())

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


def album_disc_key(disc_number_raw: object, disc_number: object) -> str:
    """The disc's identity within its album, matching getTrackDiscRatingKey in
    the album-details runtime and the disc_key expression in the import SQL."""
    raw = " ".join(str(disc_number_raw or "").split("/")[0].split()).lower()
    if raw.isascii() and raw.isdigit():
        return str(int(raw))
    if raw:
        return raw
    return str(disc_number) if type(disc_number) is int and disc_number >= 1 else ""


def tag_disc_rating_candidates(albums: Iterable[object]) -> list[dict[str, object]]:
    """Discs of a multi-disc album whose tracks share one valid tag rating that
    differs from the album's valid tag rating. The explicit import applies the
    same rule to persisted track files in _import_missing_tag_disc_ratings_sql."""
    candidates: list[dict[str, object]] = []
    for album in albums:
        album_key = _album_key(getattr(album, "key", ""))
        album_rating = _valid_rating(getattr(album, "album_rating", None))
        if not album_key or album_rating is None:
            continue
        ratings_by_disc: dict[str, set[int | None]] = {}
        for track in getattr(album, "tracks", None) or []:
            disc_key = album_disc_key(
                getattr(track, "disc_number_raw", None),
                getattr(track, "disc_number", None),
            )
            ratings_by_disc.setdefault(disc_key, set()).add(
                _valid_rating(getattr(track, "album_rating", None))
            )
        if len(ratings_by_disc) < 2:
            continue
        for disc_key, ratings in sorted(ratings_by_disc.items()):
            rating = next(iter(ratings)) if len(ratings) == 1 else None
            if disc_key and rating is not None and rating != album_rating:
                candidates.append(
                    {"album_key": album_key, "disc_key": disc_key, "rating": rating}
                )
    return candidates


def _valid_rating(value: object) -> int | None:
    return value if type(value) is int and 1 <= value <= 10 else None


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


def _load_album_disc_ratings_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        select
          app.album_disc_ratings.album_key,
          app.album_disc_ratings.disc_key,
          app.album_disc_ratings.rating
        from app.album_disc_ratings
        join bootstrap_context
          on app.album_disc_ratings.account_id = bootstrap_context.account_id
         and app.album_disc_ratings.library_id = bootstrap_context.library_id
        where app.album_disc_ratings.album_key = any(%s::text[])
        order by app.album_disc_ratings.album_key, app.album_disc_ratings.disc_key;
    """
    )


def valid_tag_rating_sql(value: str) -> str:
    return f"""
        case
          when jsonb_typeof({value}) = 'number'
           and ({value} #>> '{{}}') ~ '^[0-9]+$'
           and ({value} #>> '{{}}')::numeric between 1 and 10
            then ({value} #>> '{{}}')::smallint
        end
    """


def _import_missing_tag_disc_ratings_sql() -> str:
    album_rating = valid_tag_rating_sql("library.local_albums.metadata -> 'tag_album_rating'")
    track_rating = valid_tag_rating_sql(
        "library.local_track_files.metadata #> '{scan_cache,file_entry,album_rating}'"
    )
    return (
        _bootstrap_context_sql()
        + f"""
        , track_tags as (
          select
            bootstrap_context.account_id,
            bootstrap_context.library_id,
            library.local_albums.album_key,
            case
              when raw_disc.part ~ '^[0-9]+$'
                then coalesce(nullif(ltrim(raw_disc.part, '0'), ''), '0')
              when raw_disc.part <> '' then raw_disc.part
              when library.local_tracks.disc_number >= 1
                then library.local_tracks.disc_number::text
              else ''
            end as disc_key,
            {album_rating} as album_rating,
            {track_rating} as track_rating
          from bootstrap_context
          join library.local_albums
            on library.local_albums.library_id = bootstrap_context.library_id
          join library.local_tracks
            on library.local_tracks.library_id = library.local_albums.library_id
           and library.local_tracks.album_id = library.local_albums.id
          join library.local_track_files
            on library.local_track_files.track_id = library.local_tracks.id
           and library.local_track_files.scan_cache_stale is false
          cross join lateral (
            select lower(regexp_replace(btrim(split_part(
              coalesce(
                library.local_track_files.metadata #>> '{{scan_cache,file_entry,disc_number_raw}}',
                ''
              ),
              '/',
              1
            )), '\\s+', ' ', 'g')) as part
          ) as raw_disc
        ),
        disc_tags as (
          select
            account_id,
            library_id,
            album_key,
            disc_key,
            min(album_rating) as album_rating,
            min(track_rating) as rating,
            bool_and(track_rating is not null)
              and min(track_rating) = max(track_rating) as is_consistent,
            count(*) over (partition by library_id, album_key) as album_disc_count
          from track_tags
          group by account_id, library_id, album_key, disc_key
        ),
        valid_candidates as (
          select *
          from disc_tags
          where is_consistent
            and album_disc_count > 1
            and disc_key <> ''
            and rating <> album_rating
        ),
        inserted as (
          insert into app.album_disc_ratings (
            account_id,
            library_id,
            album_key,
            disc_key,
            rating,
            provenance,
            metadata
          )
          select
            valid_candidates.account_id,
            valid_candidates.library_id,
            valid_candidates.album_key,
            valid_candidates.disc_key,
            valid_candidates.rating,
            'explicit_import',
            jsonb_build_object('source', 'explicit_import')
          from valid_candidates
          on conflict (account_id, library_id, album_key, disc_key) do nothing
          returning 1
        )
        select
          (select count(*) from inserted)::integer as created,
          (
            (select count(*) from valid_candidates)
            - (select count(*) from inserted)
          )::integer as authority_skipped;
    """
    )


def _seed_missing_album_disc_ratings_sql() -> str:
    return (
        _bootstrap_context_sql()
        + """
        , candidates as (
          select candidate.album_key, candidate.disc_key, candidate.rating
          from unnest(%s::text[], %s::text[], %s::smallint[])
            as candidate(album_key, disc_key, rating)
        ),
        eligible as (
          select
            bootstrap_context.account_id,
            bootstrap_context.library_id,
            library.local_albums.album_key,
            candidates.disc_key,
            candidates.rating
          from candidates
          cross join bootstrap_context
          join library.local_albums
            on library.local_albums.library_id = bootstrap_context.library_id
           and library.local_albums.album_key = candidates.album_key
        ),
        inserted as (
          insert into app.album_disc_ratings (
            account_id,
            library_id,
            album_key,
            disc_key,
            rating,
            provenance,
            metadata
          )
          select
            eligible.account_id,
            eligible.library_id,
            eligible.album_key,
            eligible.disc_key,
            eligible.rating,
            %s::text,
            jsonb_build_object('source', %s::text)
          from eligible
          on conflict (account_id, library_id, album_key, disc_key) do nothing
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
