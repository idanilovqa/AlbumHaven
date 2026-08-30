from __future__ import annotations

from collections.abc import Mapping
from contextlib import nullcontext
from typing import Any, Callable

from music_app.services.library_inventory_postgres import local_inventory_identity_key
from music_app.services.selected_artist_membership import collaboration_alias_of

try:  # pragma: no cover - exercised when psycopg is installed locally.
    import psycopg
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb
except ImportError:  # pragma: no cover - keeps the module importable without psycopg.
    psycopg = None
    dict_row = None
    Jsonb = None


_APP_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"
_BOOTSTRAP_OWNER_KEY = "local-bootstrap-owner"
_BOOTSTRAP_LIBRARY_NAME = "Local Library"
_RELATIONSHIP_SOURCE = "folder_derived_runtime"
_RESOLUTION_SAMPLE_LIMIT = 5
_RESOLUTION_SAMPLE_TEXT_LIMIT = 80


def is_artist_family_postgres_available(config: Mapping[str, object] | None) -> bool:
    if not isinstance(config, Mapping):
        return False
    database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
    return bool(database_url) and psycopg is not None and callable(getattr(psycopg, "connect", None))


def load_selected_artist_family_artists(
    config: Mapping[str, object],
    selected_artist: str,
    *,
    connect: Callable[[str], Any] | None = None,
) -> list[str]:
    return list(
        load_selected_artist_family_projection(
            config,
            selected_artist,
            connect=connect,
        ).get("family_artists", [])
    )


def load_selected_artist_family_projection(
    config: Mapping[str, object],
    selected_artist: str,
    *,
    connect: Callable[[str], Any] | None = None,
    connection: Any | None = None,
) -> dict[str, object]:
    artist_name = str(selected_artist or "").strip()
    if not artist_name:
        return _empty_selected_artist_family_projection()
    database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
    if not database_url or psycopg is None:
        return _empty_selected_artist_family_projection()
    connector = connect or _connect
    try:
        connection_context = (
            nullcontext(connection)
            if connection is not None
            else connector(database_url)
        )
        with connection_context as active_connection:
            rows = list(
                active_connection.execute(
                    _load_selected_artist_family_projection_sql(),
                    {
                        "artist_key": _artist_key(artist_name),
                        "artist_name": artist_name,
                        "relationship_source": _RELATIONSHIP_SOURCE,
                    },
                ).fetchall()
            )
            family_artists: list[str] = []
            seen_family_artist_keys: set[str] = set()
            relations_last_built = 0.0
            artist_keys: set[str] = set()
            preferred_name_by_artist_key: dict[str, str] = {}
            for row in rows:
                row_mapping = _row_mapping(row)
                selected_artist_key = str(row_mapping.get("selected_artist_key") or "").strip()
                selected_artist_name = str(row_mapping.get("selected_artist_name") or "").strip()
                if selected_artist_key:
                    artist_keys.add(selected_artist_key)
                    if selected_artist_name:
                        preferred_name_by_artist_key[selected_artist_key] = selected_artist_name
                family_artist_name = str(row_mapping.get("family_artist_name") or "").strip()
                family_artist_key = str(row_mapping.get("family_artist_key") or "").strip()
                family_identity = family_artist_key or _artist_key(family_artist_name)
                if family_artist_name and family_identity not in seen_family_artist_keys:
                    family_artists.append(family_artist_name)
                    seen_family_artist_keys.add(family_identity)
                if family_artist_key:
                    artist_keys.add(family_artist_key)
                    preferred_name_by_artist_key[family_artist_key] = family_artist_name
                relations_last_built = max(
                    relations_last_built,
                    _coerce_float(row_mapping.get("relations_last_built")),
                )
            alias_to_canonical: dict[str, str] = {}
            canonical_to_aliases: dict[str, list[str]] = {}
            if artist_keys:
                alias_rows = list(
                    active_connection.execute(
                        _load_artist_alias_rows_sql(),
                        {"artist_keys": list(artist_keys)},
                    ).fetchall()
                )
                alias_to_canonical, canonical_to_aliases = _alias_maps_from_artist_rows(
                    alias_rows,
                    preferred_name_by_artist_key=preferred_name_by_artist_key,
                )
            if not list(canonical_to_aliases.get(artist_name) or [])[1:]:
                collaboration_alias_rows = list(
                    active_connection.execute(
                        _load_collaboration_alias_candidates_sql(),
                        {"artist_name": artist_name},
                    ).fetchall()
                )
                _merge_collaboration_aliases(
                    alias_to_canonical,
                    canonical_to_aliases,
                    selected_artist=artist_name,
                    rows=collaboration_alias_rows,
                )
    except Exception:
        if connection is not None:
            raise
        return _empty_selected_artist_family_projection()
    return {
        "family_artists": family_artists,
        "relations_last_built": relations_last_built,
        "loaded": True,
        "alias_to_canonical": alias_to_canonical,
        "canonical_to_aliases": canonical_to_aliases,
    }


def replace_artist_family_projection_in_transaction(
    connection: Any,
    relation_views: Mapping[str, object],
    *,
    relations_last_built: float | None = None,
) -> int:
    """Replace only runtime projection-owned family links on the caller transaction."""
    if not isinstance(relation_views, Mapping):
        raise TypeError("relation_views must be a mapping")
    rows = _projection_rows(
        relation_views,
        relations_last_built=relations_last_built,
    )
    params = {
        "rows": _jsonb(rows),
        "row_count": len(rows),
    }
    if rows:
        replacement_count = connection.execute(
            _count_artist_family_projection_replacement_rows_sql(),
            params,
        ).fetchone()
        resolved_count = int(
            _row_mapping(replacement_count).get("replacement_row_count") or 0
        )
        if resolved_count != len(rows):
            mismatch_diagnostics = _projection_resolution_mismatch_diagnostics(
                replacement_count
            )
            raise RuntimeError(
                "Artist-family projection rows did not resolve to the current library "
                f"({resolved_count}/{len(rows)}); {mismatch_diagnostics}."
            )
    connection.execute(
        _replace_artist_family_projection_sql(),
        {
            **params,
            "relationship_source": _RELATIONSHIP_SOURCE,
        },
    )
    return len(rows)


def _connect(database_url: str) -> Any:
    if psycopg is None:
        raise RuntimeError("psycopg is required for Postgres artist-family projection.")
    return psycopg.connect(database_url, row_factory=dict_row)


def _jsonb(value: object) -> object:
    if Jsonb is None:
        return value
    return Jsonb(value)


def _artist_key(value: object) -> str:
    return local_inventory_identity_key(value)


def _projection_resolution_mismatch_diagnostics(row: object) -> str:
    row_mapping = _row_mapping(row)
    diagnostic_parts: list[str] = []
    for side in ("selected", "family"):
        count = int(row_mapping.get(f"unresolved_{side}_count") or 0)
        samples = row_mapping.get(f"unresolved_{side}_samples")
        if not isinstance(samples, list):
            samples = []
        bounded_samples = []
        for sample in samples[:_RESOLUTION_SAMPLE_LIMIT]:
            sample_mapping = _row_mapping(sample)
            bounded_samples.append(
                {
                    "display": _redact_resolution_sample_text(sample_mapping.get("display")),
                    "key": _redact_resolution_sample_text(sample_mapping.get("key")),
                }
            )
        diagnostic_parts.append(
            f"unresolved_{side}_count={count} "
            f"unresolved_{side}_samples={bounded_samples!r}"
        )
    return " ".join(diagnostic_parts)


def _redact_resolution_sample_text(value: object) -> str:
    text = str(value or "")
    if "/" in text or "\\" in text or "://" in text:
        return "<redacted>"
    return "".join(character if character.isprintable() else "?" for character in text)[
        :_RESOLUTION_SAMPLE_TEXT_LIMIT
    ]


def _row_mapping(row: object) -> dict[str, object]:
    if isinstance(row, dict):
        return row
    if hasattr(row, "keys"):
        return {str(key): row[key] for key in row.keys()}
    return {}


def _coerce_float(value: object) -> float:
    try:
        return float(value or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _empty_selected_artist_family_projection() -> dict[str, object]:
    return {
        "family_artists": [],
        "relations_last_built": 0.0,
        "loaded": False,
        "alias_to_canonical": {},
        "canonical_to_aliases": {},
    }


def _alias_maps_from_artist_rows(
    rows: list[object],
    *,
    preferred_name_by_artist_key: Mapping[str, str],
) -> tuple[dict[str, str], dict[str, list[str]]]:
    alias_to_canonical: dict[str, str] = {}
    canonical_to_aliases: dict[str, list[str]] = {}
    for row in rows:
        row_mapping = _row_mapping(row)
        artist_key = str(row_mapping.get("artist_key") or "").strip()
        alias_name = str(row_mapping.get("alias_artist_name") or "").strip()
        canonical_name = str(preferred_name_by_artist_key.get(artist_key) or alias_name).strip()
        if not canonical_name or not alias_name:
            continue
        alias_to_canonical[alias_name] = canonical_name
        aliases = canonical_to_aliases.setdefault(canonical_name, [])
        if alias_name not in aliases:
            aliases.append(alias_name)
    return alias_to_canonical, canonical_to_aliases


def _merge_collaboration_aliases(
    alias_to_canonical: dict[str, str],
    canonical_to_aliases: dict[str, list[str]],
    *,
    selected_artist: str,
    rows: list[object],
) -> None:
    selected_name = str(selected_artist or "").strip()
    if not selected_name:
        return
    aliases = canonical_to_aliases.setdefault(selected_name, [selected_name])
    if selected_name not in aliases:
        aliases.insert(0, selected_name)
    alias_to_canonical[selected_name] = selected_name
    for row in rows:
        alias_name = str(_row_mapping(row).get("alias_artist_name") or "").strip()
        if not alias_name or not collaboration_alias_of(alias_name, selected_name):
            continue
        alias_to_canonical[alias_name] = selected_name
        if alias_name not in aliases:
            aliases.append(alias_name)


def _projection_rows(
    relation_views: Mapping[str, object],
    *,
    relations_last_built: float | None = None,
) -> list[dict[str, object]]:
    folder_related = relation_views.get("folder_related") or {}
    if not isinstance(folder_related, Mapping):
        return []
    rows: list[dict[str, object]] = []
    seen: set[tuple[str, str]] = set()
    for selected_artist, related_values in folder_related.items():
        selected_name = str(selected_artist or "").strip()
        selected_key = _artist_key(selected_name)
        if not selected_name or not selected_key:
            continue
        if isinstance(related_values, str):
            related_artists = [related_values]
        elif isinstance(related_values, (list, tuple, set)):
            related_artists = list(related_values)
        else:
            related_artists = []
        for related_artist in related_artists:
            related_name = str(related_artist or "").strip()
            related_key = _artist_key(related_name)
            if not related_name or not related_key or related_key == selected_key:
                continue
            pair = (selected_key, related_key)
            if pair in seen:
                continue
            seen.add(pair)
            rows.append(
                {
                    "artist_key": selected_key,
                    "family_artist_key": related_key,
                    "metadata": {
                        "source": _RELATIONSHIP_SOURCE,
                        "selected_artist": selected_name,
                        "family_artist": related_name,
                        "relations_last_built": relations_last_built,
                    },
                }
            )
    return rows


def _replace_artist_family_projection_sql() -> str:
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
        delete_existing as (
          delete from library.local_artist_family_links
          using bootstrap_context
          where library.local_artist_family_links.library_id = bootstrap_context.library_id
            and library.local_artist_family_links.source_family = %(relationship_source)s
        ),
        input_row as (
          select
            rows.artist_key,
            rows.family_artist_key,
            rows.metadata
          from jsonb_to_recordset(
            case
              when %(row_count)s::int > 0 then %(rows)s::jsonb
              else '[]'::jsonb
            end
          ) as rows(
            artist_key text,
            family_artist_key text,
            metadata jsonb
          )
        ),
        artist_lookup as (
          select library.local_artists.id, library.local_artists.artist_key
          from library.local_artists
          join bootstrap_context on bootstrap_context.library_id = library.local_artists.library_id
        )
        insert into library.local_artist_family_links (
          library_id,
          artist_id,
          related_artist_id,
          relationship_weight,
          source_family,
          source_ref,
          metadata
        )
        select
          bootstrap_context.library_id,
          selected_artist.id,
          family_artist.id,
          1,
          %(relationship_source)s,
          'relation_views.folder_related',
          coalesce(input_row.metadata, '{}'::jsonb)
        from bootstrap_context
        join input_row on true
        join artist_lookup as selected_artist on selected_artist.artist_key = input_row.artist_key
        join artist_lookup as family_artist on family_artist.artist_key = input_row.family_artist_key
        where selected_artist.id <> family_artist.id
        on conflict (library_id, artist_id, related_artist_id, relationship_weight, source_family) do update
          set source_ref = excluded.source_ref,
              metadata = library.local_artist_family_links.metadata || excluded.metadata;
    """


def _count_artist_family_projection_replacement_rows_sql() -> str:
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
        input_row as (
          select
            rows.artist_key,
            rows.family_artist_key,
            rows.metadata
          from jsonb_to_recordset(
            case
              when %(row_count)s::int > 0 then %(rows)s::jsonb
              else '[]'::jsonb
            end
          ) as rows(
            artist_key text,
            family_artist_key text,
            metadata jsonb
          )
        ),
        artist_lookup as (
          select library.local_artists.id, library.local_artists.artist_key
          from library.local_artists
          join bootstrap_context on bootstrap_context.library_id = library.local_artists.library_id
        ),
        resolved_row as (
          select input_row.artist_key, input_row.family_artist_key
          from input_row
          join artist_lookup as selected_artist on selected_artist.artist_key = input_row.artist_key
          join artist_lookup as family_artist on family_artist.artist_key = input_row.family_artist_key
          where selected_artist.id <> family_artist.id
        ),
        unresolved as (
          select
            'selected'::text as side,
            input_row.metadata ->> 'selected_artist' as display_name,
            input_row.artist_key
          from input_row
          where not exists (
            select 1 from artist_lookup where artist_lookup.artist_key = input_row.artist_key
          )
          union all
          select
            'family'::text as side,
            input_row.metadata ->> 'family_artist' as display_name,
            input_row.family_artist_key as artist_key
          from input_row
          where not exists (
            select 1 from artist_lookup where artist_lookup.artist_key = input_row.family_artist_key
          )
        )
        select
          (select count(*) from resolved_row) as replacement_row_count,
          (select count(*) from unresolved where side = 'selected') as unresolved_selected_count,
          (select count(*) from unresolved where side = 'family') as unresolved_family_count,
          coalesce(
            (
              select jsonb_agg(sample order by sample ->> 'key', sample ->> 'display')
              from (
                select jsonb_build_object(
                  'display', left(coalesce(display_name, ''), 80),
                  'key', left(coalesce(artist_key, ''), 80)
                ) as sample
                from unresolved
                where side = 'selected'
                order by artist_key, display_name
                limit 5
              ) as selected_samples
            ),
            '[]'::jsonb
          ) as unresolved_selected_samples,
          coalesce(
            (
              select jsonb_agg(sample order by sample ->> 'key', sample ->> 'display')
              from (
                select jsonb_build_object(
                  'display', left(coalesce(display_name, ''), 80),
                  'key', left(coalesce(artist_key, ''), 80)
                ) as sample
                from unresolved
                where side = 'family'
                order by artist_key, display_name
                limit 5
              ) as family_samples
            ),
            '[]'::jsonb
          ) as unresolved_family_samples;
    """


def _load_selected_artist_family_projection_sql() -> str:
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
        target_artist as (
          select
            library.local_artists.id,
            library.local_artists.name,
            library.local_artists.artist_key
          from library.local_artists
          join bootstrap_context on bootstrap_context.library_id = library.local_artists.library_id
          where library.local_artists.artist_key = %(artist_key)s
             or lower(library.local_artists.name) = lower(%(artist_name)s)
          order by case when library.local_artists.artist_key = %(artist_key)s then 0 else 1 end
          limit 1
        )
        select target_artist.artist_key as selected_artist_key
             , target_artist.name as selected_artist_name
             , family_artist.name as family_artist_name
             , family_artist.artist_key as family_artist_key
             , coalesce(
                    nullif(library.local_artist_family_links.metadata->>'relations_last_built', '')::double precision,
                    0
                ) as relations_last_built
        from target_artist
        left join library.local_artist_family_links
          on library.local_artist_family_links.artist_id = target_artist.id
         and library.local_artist_family_links.library_id = (select library_id from bootstrap_context)
        left join bootstrap_context on bootstrap_context.library_id = library.local_artist_family_links.library_id
        left join library.local_artists as family_artist on family_artist.id = library.local_artist_family_links.related_artist_id
        order by lower(family_artist.name),
                 family_artist.name,
                 case when library.local_artist_family_links.source_family = %(relationship_source)s then 0 else 1 end;
    """


def _load_artist_alias_rows_sql() -> str:
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
        select
          library.local_artists.artist_key,
          library.local_artists.name as alias_artist_name
        from library.local_artists
        join bootstrap_context on bootstrap_context.library_id = library.local_artists.library_id
        where library.local_artists.artist_key = any(%(artist_keys)s)
        order by lower(library.local_artists.name), library.local_artists.name;
    """


def _load_collaboration_alias_candidates_sql() -> str:
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
        select library.local_artists.name as alias_artist_name
        from library.local_artists
        join bootstrap_context on bootstrap_context.library_id = library.local_artists.library_id
        where lower(library.local_artists.name) like lower(%(artist_name)s) || '%%'
          and lower(library.local_artists.name) <> lower(%(artist_name)s)
        order by lower(library.local_artists.name), library.local_artists.name;
    """
