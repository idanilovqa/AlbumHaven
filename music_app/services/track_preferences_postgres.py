from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from typing import Any

from music_app.services.postgres_connections import pooled_connection as _connect

try:  # Keep the persistence-selection probe importable without the driver.
    import psycopg
except ImportError:  # pragma: no cover
    psycopg = None


_APP_DATABASE_URL_KEY = "ALBUM_HAVEN_APP_DATABASE_URL"


class TrackPreferenceScopeError(PermissionError):
    """The active account/library membership no longer permits this operation."""


class TrackPreferenceNotFoundError(LookupError):
    """The requested identity is absent from the authorized active inventory."""


class TrackPreferenceConflictError(ValueError):
    """Inventory aliases or preserved preference history are ambiguous."""


def is_track_preferences_postgres_available(config: dict[str, object] | None) -> bool:
    return (
        isinstance(config, dict)
        and psycopg is not None
        and bool(str(config.get(_APP_DATABASE_URL_KEY) or "").strip())
    )


class PostgresTrackPreferencesStore:
    def __init__(
        self,
        config: dict[str, object],
        *,
        connect: Callable[[str], Any] | None = None,
    ) -> None:
        self._database_url = str(config.get(_APP_DATABASE_URL_KEY) or "").strip()
        self._connect = connect or _connect

    def resolve_track(
        self, track_ref: object, *, account_id: int, library_id: int,
    ) -> dict[str, object]:
        params = _selection_params([track_ref], account_id, library_id)
        with self._connect_to_database() as connection:
            row = connection.execute(_selection_sql(), params).fetchone()
            result = _checked_selection(row)
        return result

    def load_track_preferences(
        self, track_refs: Iterable[object], *, account_id: int, library_id: int,
    ) -> dict[str, dict[str, object]]:
        params = _selection_params(track_refs, account_id, library_id)
        if not params["track_refs"]:
            return {}
        with self._connect_to_database() as connection:
            return load_track_preferences_on_connection(
                connection, params["track_refs"], account_id=account_id, library_id=library_id,
            )

    def patch_preference(
        self,
        track_ref: object,
        patch: object,
        *,
        account_id: int,
        library_id: int,
        expected_track_id: int,
    ) -> dict[str, object]:
        from music_app.services.track_preferences import normalize_track_preference_patch

        normalized_patch = normalize_track_preference_patch(patch)
        params = _selection_params([track_ref], account_id, library_id)
        if type(expected_track_id) is not int or expected_track_id <= 0:
            raise TrackPreferenceNotFoundError("Track not found.")
        with self._connect_to_database() as connection:
            selected = _checked_selection(
                connection.execute(_selection_sql(), params).fetchone(),
                expected_track_id=expected_track_id,
            )
            if normalized_patch:
                params.update({
                    "expected_track_id": expected_track_id,
                    "preference_key": selected["preference_key"],
                    "has_rating": "rating" in normalized_patch,
                    "rating": normalized_patch.get("rating"),
                    "has_love_tier": "love_tier" in normalized_patch,
                    "love_tier": normalized_patch.get("love_tier", "off"),
                })
                provisional = connection.execute(_patch_preference_sql(), params).fetchone()
                # M is a NEW statement after the upsert and all its conflict waits.
                # Its failure must escape this context, rolling back even an INSERT.
                selected = _checked_selection(
                    connection.execute(_selection_sql(), params).fetchone(),
                    expected_track_id=expected_track_id,
                )
                if (
                    not isinstance(provisional, Mapping)
                    or selected["preference_id"] != provisional.get("id")
                    or selected["preference_key"] != provisional.get("track_key")
                ):
                    raise TrackPreferenceConflictError("Track preference identity conflict.")
            # For an empty patch the sole selection above is M: no DML/intent.
            # Scope/inventory changes after M may affect the next request.
        return selected

    def _connect_to_database(self) -> Any:
        if not self._database_url:
            raise RuntimeError("ALBUM_HAVEN_APP_DATABASE_URL is required for Postgres track preferences.")
        return self._connect(self._database_url)


def load_track_preferences_on_connection(
    connection, track_refs: Iterable[object], *, account_id: int, library_id: int,
) -> dict[str, dict[str, object]]:
    """Read canonical taste inside the caller's existing guarded transaction."""
    params = _selection_params(track_refs, account_id, library_id)
    if not params["track_refs"]:
        return {}
    result = {}
    for row in connection.execute(_selection_sql(), params).fetchall():
        try:
            selected = _checked_selection(row)
        except (TrackPreferenceNotFoundError, TrackPreferenceConflictError):
            continue
        result[selected["track_ref"]] = selected
    return result


def _selection_params(track_refs: Iterable[object], account_id: int, library_id: int) -> dict[str, object]:
    if any(type(value) is not int or value <= 0 for value in (account_id, library_id)):
        raise TrackPreferenceScopeError("Track preference scope is unavailable.")
    refs = list(dict.fromkeys(str(ref or "").strip() for ref in track_refs))
    return {"account_id": account_id, "library_id": library_id, "track_refs": refs}


def _checked_selection(row: object, *, expected_track_id: int | None = None) -> dict[str, object]:
    if not isinstance(row, Mapping) or row.get("selection_status") == "missing":
        raise TrackPreferenceNotFoundError("Track not found.")
    if row.get("selection_status") == "forbidden":
        raise TrackPreferenceScopeError("Track preference scope is unavailable.")
    if row.get("selection_status") != "ok":
        raise TrackPreferenceConflictError("Track preference identity conflict.")
    if expected_track_id is not None and row.get("track_id") != expected_track_id:
        raise TrackPreferenceNotFoundError("Track not found.")
    return {key: row[key] for key in (
        "track_id", "track_ref", "track_key", "preference_id", "preference_key",
        "rating", "love_tier", "is_active_path",
    )}


def _selection_ctes() -> str:
    """One bounded alias/history rule for reads, guarded DML, and observation M."""
    return """
        with authorized_scope as (
          select a.id as account_id, l.id as library_id
          from app.accounts a
          join library.library_memberships m on m.account_id = a.id
          join library.libraries l on l.id = m.library_id
          where a.id = %(account_id)s and l.id = %(library_id)s
            and a.is_active is true and a.disabled_at is null
        ),
        requested_refs as (
          select distinct unnest(%(track_refs)s::text[]) as track_ref
        ),
        matches as (
          select r.track_ref, t.id as track_id, t.track_key
          from requested_refs r
          join library.local_tracks t on t.track_key = r.track_ref
          join authorized_scope s on s.library_id = t.library_id
          where exists (
            select 1 from library.local_track_files f
            where f.track_id = t.id and f.scan_cache_stale is false
          )
          union
          select r.track_ref, t.id, t.track_key
          from requested_refs r
          join library.local_track_files f on f.private_path = r.track_ref
            and f.scan_cache_stale is false
          join library.local_tracks t on t.id = f.track_id
          join authorized_scope s on s.library_id = t.library_id
        ),
        candidates as (
          select track_ref, count(*) as track_count,
                 min(track_id) as track_id, min(track_key) as track_key
          from matches group by track_ref
        ),
        resolved_tracks as (
          select distinct track_id, track_key from candidates where track_count = 1
        ),
        active_paths as (
          select t.track_id, f.private_path
          from resolved_tracks t
          join library.local_track_files f on f.track_id = t.track_id
            and f.scan_cache_stale is false
        ),
        aliases as (
          select track_id, track_key as alias from resolved_tracks
          union
          select track_id, private_path from active_paths
        ),
        alias_targets as (
          select a.track_id, a.alias, t.id as target_id
          from aliases a
          join library.local_tracks t on t.track_key = a.alias
          join authorized_scope s on s.library_id = t.library_id
          where exists (
            select 1 from library.local_track_files f
            where f.track_id = t.id and f.scan_cache_stale is false
          )
          union
          select a.track_id, a.alias, t.id
          from aliases a
          join library.local_track_files f on f.private_path = a.alias
            and f.scan_cache_stale is false
          join library.local_tracks t on t.id = f.track_id
          join authorized_scope s on s.library_id = t.library_id
        ),
        alias_counts as (
          select a.track_id, a.alias, count(t.target_id) as target_count,
                 min(t.target_id) as target_id
          from aliases a
          left join alias_targets t on t.track_id = a.track_id and t.alias = a.alias
          group by a.track_id, a.alias
        ),
        valid_aliases as (
          select track_id, bool_and(target_count = 1 and target_id = track_id) as valid
          from alias_counts group by track_id
        ),
        preference_selection as (
          select a.track_id, count(p.id) as preference_count,
                 min(p.id) as preference_id, min(p.track_key) as preference_key,
                 min(p.rating) as rating, min(p.love_tier) as love_tier,
                 bool_or(p.track_id is not null and p.track_id <> a.track_id) as wrong_track
          from aliases a
          left join app.track_preferences p
            on p.account_id = %(account_id)s and p.library_id = %(library_id)s
           and p.track_key = a.alias
          group by a.track_id
        ),
        selection as (
          select r.track_ref, c.track_id, c.track_key,
                 p.preference_id, coalesce(p.preference_key, c.track_key) as preference_key,
                 p.rating, coalesce(p.love_tier, 'off') as love_tier,
                 exists (
                   select 1 from active_paths f
                   where f.track_id = c.track_id and f.private_path = r.track_ref
                 ) as is_active_path,
                 case
                   when not exists (select 1 from authorized_scope) then 'forbidden'
                   when c.track_id is null then 'missing'
                   when c.track_count <> 1 or v.valid is not true
                     or p.preference_count > 1 or p.wrong_track is true then 'conflict'
                   else 'ok'
                 end as selection_status
          from requested_refs r
          left join candidates c on c.track_ref = r.track_ref
          left join valid_aliases v on v.track_id = c.track_id
          left join preference_selection p on p.track_id = c.track_id
        )
    """


def _selection_sql() -> str:
    return _selection_ctes() + "select * from selection;"


def _patch_preference_sql() -> str:
    return _selection_ctes() + """
        insert into app.track_preferences as current_preference (
          account_id, library_id, track_key, rating, love_tier, metadata
        )
        select %(account_id)s, %(library_id)s, preference_key,
               %(rating)s::integer, %(love_tier)s::text,
               jsonb_build_object('source', 'runtime_track_preferences_adapter',
                                  'actor_id', %(account_id)s::text)
               || case when %(has_rating)s then '{"rating_explicit":true}'::jsonb else '{}'::jsonb end
               || case when %(has_love_tier)s then '{"love_tier_explicit":true}'::jsonb else '{}'::jsonb end
        from selection
        where selection_status = 'ok' and track_id = %(expected_track_id)s
          and preference_key = %(preference_key)s
        on conflict (account_id, library_id, track_key) do update
          set rating = case when %(has_rating)s then excluded.rating else current_preference.rating end,
              love_tier = case when %(has_love_tier)s then excluded.love_tier else current_preference.love_tier end,
              updated_at = now(),
              metadata = current_preference.metadata
                || case when %(has_rating)s then '{"rating_explicit":true}'::jsonb else '{}'::jsonb end
                || case when %(has_love_tier)s then '{"love_tier_explicit":true}'::jsonb else '{}'::jsonb end
        where current_preference.track_id is null
           or current_preference.track_id = %(expected_track_id)s
        returning id, track_key;
    """
