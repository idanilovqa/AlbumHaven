# Composition N2 reserves one additional deadline-wrapper parameter view.
# This is a logical forwarding owner, never an alias or zero-copy discount.
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


def _selection_ctes(*, requested_refs_sql: str | None = None) -> str:
    """One bounded alias/history rule for reads, guarded DML, and observation M."""
    requested_refs_sql = requested_refs_sql or "select distinct unnest(%(track_refs)s::text[]) as track_ref"
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
          __REQUESTED_REFS_SQL__
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
    """.replace("__REQUESTED_REFS_SQL__", requested_refs_sql)


def canonical_candidate_selection_ctes(candidate_relation: str) -> str:
    """Reuse every alias/history rule for an internal restricted inventory CTE.

    The caller supplies an internal SQL identifier, never request text. Its
    relation must contain only candidate track_key values for the live library.
    Existing reads and writes retain their unchanged requested-ref selection.
    """
    import re
    if not re.fullmatch(r"[a-z][a-z0-9_]*", candidate_relation):
        raise ValueError("Invalid candidate relation.")
    return _selection_ctes(requested_refs_sql=(
        f"select distinct track_key as track_ref from {candidate_relation}"))


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


# Foobar reconstruction N1: bounded same-connection import, separate from manual patch.
from dataclasses import dataclass as _foobar_dataclass
import json as _foobar_json
from uuid import UUID as _FoobarUUID


class FoobarTasteUnavailable(RuntimeError):
    code = "import_unavailable"
    status_code = 503
    retryable = False


class FoobarTasteStale(RuntimeError):
    code = "stale_import"
    status_code = 409
    retryable = False


@_foobar_dataclass(frozen=True, slots=True)
class FoobarTasteState:
    track_id: int
    selection_status: str
    preference_id: int | None
    identity_seal: str
    rating: int | None
    love_tier: str
    rating_protected: bool
    favorite_protected: bool
    rating_marker: tuple | None
    favorite_marker: tuple | None
    state_seal: str
    browse_allowed: bool
    taste_allowed: bool


@_foobar_dataclass(frozen=True, slots=True)
class FoobarTasteChange:
    track_id: int
    observation_ref: str
    source_revision: int
    rating: int | None
    favorite: bool


@_foobar_dataclass(frozen=True, slots=True)
class FoobarTasteOutcome:
    track_id: int
    observation_ref: str
    rating_written: bool
    favorite_promoted: bool


@_foobar_dataclass(frozen=True, slots=True)
class FoobarTasteWriteResult:
    """Actual verified postimages, not a commit or caller-selected expectation."""
    outcomes: tuple[FoobarTasteOutcome, ...]
    postimages: tuple[FoobarTasteState, ...]


_FOOBAR_TASTE_LIMIT = 100
# Named finite logical contribution, NOT a physical heap/native SQL guarantee.
# Caller must reserve this alongside its actual original/source/control owners.
def _foobar_taste_phase_bytes(count):
    if type(count) is not int or not 0 <= count <= _FOOBAR_TASTE_LIMIT:
        raise FoobarTasteUnavailable("Foobar taste is unavailable.")
    # One genuine forwarding wrapper retains its items and expected tuples.
    # The reader conservatively uses the same contribution; no larger cap.
    return (524_288 + 8192 * count + max(1024, 82 + 20 * count) + 2
            + (1024 * count + 2) + (128 * count + 2) + 64)


def _foobar_taste_uuid(value):
    if type(value) is not str or len(value) != 36:
        raise FoobarTasteUnavailable("Foobar taste is unavailable.")
    try:
        valid = str(_FoobarUUID(value)) == value
    except (ValueError, AttributeError):
        valid = False
    if not valid:
        raise FoobarTasteUnavailable("Foobar taste is unavailable.")
    return value


def _foobar_taste_connection(connection):
    try:
        valid = (psycopg is not None and connection.autocommit is False
                 and connection.info.transaction_status == psycopg.pq.TransactionStatus.INTRANS)
    except Exception:
        raise FoobarTasteUnavailable("Foobar taste is unavailable.") from None
    if not valid:
        raise FoobarTasteUnavailable("Foobar taste requires the active transaction.")


def _foobar_taste_context(live_context):
    from music_app.services.policy import PolicyContext
    from music_app.services.current_actor import CurrentActor
    if not isinstance(live_context, PolicyContext) or not isinstance(live_context.actor, CurrentActor):
        raise FoobarTasteUnavailable("Foobar taste is unavailable.")
    actor = live_context.actor
    if (
        not actor.is_authenticated
        or any(type(value) is not int or not 1 <= value <= 9223372036854775807
               for value in (actor.account_id, actor.session_id, actor.current_library_id, live_context.library_id))
        or actor.current_library_id != live_context.library_id
        or (live_context.target_account_id is not None and (
            type(live_context.target_account_id) is not int or live_context.target_account_id != actor.account_id))
    ):
        raise FoobarTasteUnavailable("Foobar taste is unavailable.")


def _foobar_taste_ids(track_ids):
    if type(track_ids) is not tuple or len(track_ids) > _FOOBAR_TASTE_LIMIT:
        raise FoobarTasteUnavailable("Foobar taste is unavailable.")
    if any(type(value) is not int or not 1 <= value <= 9223372036854775807 for value in track_ids):
        raise FoobarTasteUnavailable("Foobar taste is unavailable.")
    if len(set(track_ids)) != len(track_ids):
        raise FoobarTasteUnavailable("Foobar taste is unavailable.")


def _foobar_taste_frame(value):
    # All callers validate fixed shapes/counts/widths BEFORE this allocation.
    return _foobar_json.dumps(value, ensure_ascii=False, separators=(",", ":"),
                              allow_nan=False).encode("utf-8")


def _foobar_taste_metadata_sql(alias, source_sql):
    """Fixed internal aliases only. Unknown provenance cannot confer ownership."""
    if alias not in ("p", "current_preference"):
        raise FoobarTasteUnavailable("Foobar taste is unavailable.")
    root = alias + ".metadata"
    ns = root + "->'foobar_import_v1'"
    safe = f"(jsonb_typeof({root})='object' and (not ({root} ? 'foobar_import_v1') or jsonb_typeof({ns})='object'))"
    flags = []
    for flag in ("rating_explicit", "love_tier_explicit"):
        flags.append(f"(not coalesce({safe} and (not ({root} ? '{flag}') or {root}->'{flag}'='false'::jsonb),false))")
    markers = []
    for name, value_sql in (("rating", f"to_jsonb({alias}.rating)"),
                            ("favorite", """'"loved"'::jsonb""")):
        m = f"({ns}->'{name}')"
        # No cast of untrusted marker values appears outside a CASE-valid arm.
        valid = f"""(
          jsonb_typeof({m})='array' and jsonb_array_length({m})=4
          and {m}->0=to_jsonb({source_sql}::text)
          and jsonb_typeof({m}->1)='string'
          and ({m}->>1) ~ '^[0-9a-f]{{8}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{4}}-[0-9a-f]{{12}}$'
          and jsonb_typeof({m}->2)='number' and ({m}->>2) ~ '^[1-9][0-9]{{0,18}}$'
          and (length({m}->>2)<19 or ({m}->>2)<='9223372036854775807')
          and {m}->3={value_sql}
        )"""
        # jsonb_array_length on a non-array must itself be guarded, not rely
        # on SQL AND short circuit (which PostgreSQL need not preserve).
        valid = valid.replace(f"jsonb_array_length({m})=4",
                              f"(case when jsonb_typeof({m})='array' then jsonb_array_length({m}) else 0 end)=4")
        if name == "rating":
            valid = f"({valid} and jsonb_typeof({m}->3)='number' and ({m}->>3) ~ '^[1-5]$')"
        else:
            valid = f"({valid} and {alias}.love_tier='loved')"
        markers.append(f"(case when {safe} and {valid} then {m} else null end)")
    for index, name in enumerate(("rating", "favorite")):
        flags[index] = f"({flags[index]} or coalesce(({ns} ? '{name}') and ({markers[index]} is null),false))"
    flags[0] = f"({flags[0]} or ({alias}.rating is not null and {markers[0]} is null))"
    relevant = f"jsonb_build_array({alias}.id,{alias}.rating,{alias}.love_tier,{flags[0]},{flags[1]},{markers[0]},{markers[1]})"
    seal = f"encode(sha256(convert_to(({relevant})::text,'UTF8')),'hex')"
    return flags[0], flags[1], markers[0], markers[1], seal


def _foobar_taste_read_sql():
    canonical = canonical_candidate_selection_ctes("foobar_candidates").strip()
    if not canonical.startswith("with "):
        raise FoobarTasteUnavailable("Foobar taste is unavailable.")
    rp, fp, rm, fm, seal = _foobar_taste_metadata_sql("p", "own.source_ref")
    return """
with foobar_input as materialized (
  select convert_from(%b::bytea,'UTF8')::jsonb as value
), foobar_scope as materialized (
  select (value->>0)::bigint as account_id,(value->>1)::bigint as library_id,
         value->>2 as source_ref from foobar_input
), foobar_requested as materialized (
  select id::bigint as track_id,ordinality as position
  from foobar_input,jsonb_array_elements_text(value->3) with ordinality as ids(id,ordinality)
), foobar_candidates as materialized (
  select t.track_key from foobar_requested r
  join library.local_tracks t on t.id=r.track_id
  join foobar_scope own on own.library_id=t.library_id
),
""" + canonical[5:].replace("%(account_id)s", "(select account_id from foobar_scope)").replace(
        "%(library_id)s", "(select library_id from foobar_scope)") + f""",
foobar_classified as materialized (
 select r.position,r.track_id,
        case when s.selection_status='ok' and s.track_id<>r.track_id then 'conflict'
             else coalesce(s.selection_status,'missing') end as selection_status,
        p.id as preference_id,
        encode(sha256(convert_to(jsonb_build_array(r.track_id,t.track_key,s.preference_key)::text,'UTF8')),'hex') as identity_seal,
        p.rating,case when p.id is null then 'off'
          when p.love_tier in ('off','loved','obsessed') then p.love_tier
          else '!invalid' end as love_tier,
        case when p.id is null then false else {rp} end as rating_protected,
        case when p.id is null then false else {fp} end as favorite_protected,
        {rm} as rating_marker,{fm} as favorite_marker,{seal} as state_seal
 from foobar_requested r cross join foobar_scope own
 left join library.local_tracks t on t.id=r.track_id and t.library_id=own.library_id
 left join selection s on s.track_ref=t.track_key
 left join app.track_preferences p on p.id=s.preference_id
   and p.account_id=own.account_id and p.library_id=own.library_id
)
select track_id,selection_status,preference_id,identity_seal,rating,love_tier,
       rating_protected,favorite_protected,
       rating_marker->>1 as rating_observation_ref,
       (rating_marker->>2)::bigint as rating_source_revision,
       favorite_marker->>1 as favorite_observation_ref,
       (favorite_marker->>2)::bigint as favorite_source_revision,state_seal
from foobar_classified order by position
"""


def _foobar_taste_query(connection, sql, frame):
    if type(sql) is not str or len(sql) > 32_768 or not sql.isascii():
        raise FoobarTasteUnavailable("Foobar taste is unavailable.")
    if type(frame) is not bytes or len(frame) > 4096:
        raise FoobarTasteUnavailable("Foobar taste is unavailable.")
    cursor = None
    try:
        cursor = connection.execute(sql, (frame,), binary=True)
        records = cursor.fetchall()
        if type(records) is not list or len(records) > _FOOBAR_TASTE_LIMIT:
            raise FoobarTasteUnavailable("Foobar taste is unavailable.")
        return records
    except Exception:
        raise FoobarTasteUnavailable("Foobar taste is unavailable.") from None
    finally:
        if cursor is not None:
            try:
                cursor.close()
            except Exception:
                raise FoobarTasteUnavailable("Foobar taste is unavailable.") from None


def read_foobar_taste_on_connection(connection, live_context, *, source_ref, track_ids, constraints=None):
    """Current locked-context reader. Caller admits _foobar_taste_phase_bytes(n)."""
    from music_app.services.foobar_import_policy import evaluate_foobar_track_policy
    _foobar_taste_connection(connection)
    _foobar_taste_context(live_context)
    _foobar_taste_uuid(source_ref)
    _foobar_taste_ids(track_ids)
    # Real policy owner validates the supplied live own-user/library context.
    policies = tuple(evaluate_foobar_track_policy(
        live_context, track_id=track_id, constraints=constraints,
    ) for track_id in track_ids)
    if not track_ids:
        return ()
    frame = _foobar_taste_frame([
        live_context.actor.account_id, live_context.library_id, source_ref, track_ids,
    ])
    records = _foobar_taste_query(connection, _foobar_taste_read_sql(), frame)
    if len(records) != len(track_ids):
        raise FoobarTasteUnavailable("Foobar taste is unavailable.")
    expected_keys = ("track_id", "selection_status", "preference_id", "identity_seal",
                     "rating", "love_tier", "rating_protected", "favorite_protected",
                     "rating_observation_ref", "rating_source_revision",
                     "favorite_observation_ref", "favorite_source_revision", "state_seal")
    result = []
    for track_id, policy, record in zip(track_ids, policies, records):
        if type(record) is not dict or tuple(record) != expected_keys:
            raise FoobarTasteUnavailable("Foobar taste is unavailable.")
        if (
            type(record["track_id"]) is not int or record["track_id"] != track_id
            or type(record["selection_status"]) is not str
            or record["selection_status"] not in ("ok", "missing", "conflict", "forbidden")
            or (record["preference_id"] is not None and (
                type(record["preference_id"]) is not int or not 1 <= record["preference_id"] <= 9223372036854775807))
            or (record["rating"] is not None and (type(record["rating"]) is not int or not 1 <= record["rating"] <= 5))
            or type(record["love_tier"]) is not str or record["love_tier"] not in ("off", "loved", "obsessed")
            or any(type(record[name]) is not bool for name in ("rating_protected", "favorite_protected"))
            or any(type(record[name]) is not str or len(record[name]) != 64
                   or any(c not in "0123456789abcdef" for c in record[name])
                   for name in ("identity_seal", "state_seal"))
        ):
            raise FoobarTasteUnavailable("Foobar taste is unavailable.")
        markers = []
        for name, value in (("rating", record["rating"]), ("favorite", "loved")):
            observation = record[name + "_observation_ref"]
            revision = record[name + "_source_revision"]
            if observation is None and revision is None:
                markers.append(None)
            else:
                _foobar_taste_uuid(observation)
                if type(revision) is not int or not 1 <= revision <= 9223372036854775807:
                    raise FoobarTasteUnavailable("Foobar taste is unavailable.")
                markers.append((source_ref, observation, revision, value))
        result.append(FoobarTasteState(
            track_id, record["selection_status"], record["preference_id"],
            record["identity_seal"], record["rating"], record["love_tier"],
            record["rating_protected"], record["favorite_protected"],
            markers[0], markers[1], record["state_seal"],
            policy.browse_allowed, policy.taste_allowed,
        ))
    return tuple(result)



def _foobar_taste_check_state(state, source_ref):
    if (
        type(state) is not FoobarTasteState
        or type(state.track_id) is not int or not 1 <= state.track_id <= 9223372036854775807
        or type(state.selection_status) is not str
        or state.selection_status not in ("ok", "missing", "forbidden", "conflict")
        or (state.preference_id is not None and (
            type(state.preference_id) is not int or not 1 <= state.preference_id <= 9223372036854775807))
        or (state.rating is not None and (type(state.rating) is not int or not 1 <= state.rating <= 5))
        or type(state.love_tier) is not str or state.love_tier not in ("off", "loved", "obsessed")
        or any(type(value) is not bool for value in (
            state.rating_protected, state.favorite_protected, state.browse_allowed, state.taste_allowed,
        ))
        or any(type(value) is not str or len(value) != 64
               or any(c not in "0123456789abcdef" for c in value)
               for value in (state.identity_seal, state.state_seal))
    ):
        raise FoobarTasteUnavailable("Foobar taste is unavailable.")
    for marker, value in ((state.rating_marker, state.rating), (state.favorite_marker, "loved")):
        if marker is None:
            continue
        if (
            type(marker) is not tuple or len(marker) != 4 or type(marker[0]) is not str
            or marker[0] != source_ref
            or type(marker[2]) is not int or not 1 <= marker[2] <= 9223372036854775807
            or type(marker[3]) is not type(value) or marker[3] != value
            or state.preference_id is None
        ):
            raise FoobarTasteUnavailable("Foobar taste is unavailable.")
        _foobar_taste_uuid(marker[1])
    if state.rating_marker is not None and state.rating is None:
        raise FoobarTasteUnavailable("Foobar taste is unavailable.")
    if state.favorite_marker is not None and state.love_tier != "loved":
        raise FoobarTasteUnavailable("Foobar taste is unavailable.")



def _foobar_taste_write_sql():
    canonical = canonical_candidate_selection_ctes("foobar_candidates").strip()
    if not canonical.startswith("with "):
        raise FoobarTasteUnavailable("Foobar taste is unavailable.")
    *_, current_seal = _foobar_taste_metadata_sql(
        "current_preference", "(select source_ref from foobar_scope)",
    )
    return """
with foobar_input as materialized (
  select convert_from(%b::bytea,'UTF8')::jsonb as value
), foobar_scope as materialized (
  select (value->>0)::bigint as account_id,(value->>1)::bigint as library_id,
    value->>2 as source_ref,(value->>3)::bigint as track_id,
    value->>4 as observation_ref,(value->>5)::bigint as source_revision,
    (value->>6)::integer as rating,(value->>7)::boolean as write_rating,
    (value->>8)::boolean as promote_favorite,(value->>9)::bigint as expected_id,
    value->>10 as expected_seal from foobar_input
), foobar_candidates as materialized (
  select t.track_key from library.local_tracks t
  join foobar_scope own on own.track_id=t.id and own.library_id=t.library_id
),
""" + canonical[5:].replace("%(account_id)s", "(select account_id from foobar_scope)").replace(
        "%(library_id)s", "(select library_id from foobar_scope)") + f"""
insert into app.track_preferences as current_preference
  (account_id,library_id,track_key,rating,love_tier,metadata)
select own.account_id,own.library_id,s.preference_key,
  case when own.write_rating then own.rating else s.rating end,
  case when own.promote_favorite then 'loved' else s.love_tier end,
  jsonb_build_object('foobar_import_v1',
    (case when own.write_rating then jsonb_build_object('rating',
      jsonb_build_array(own.source_ref,own.observation_ref,own.source_revision,own.rating))
      else '{{}}'::jsonb end)
    || (case when own.promote_favorite then jsonb_build_object('favorite',
      jsonb_build_array(own.source_ref,own.observation_ref,own.source_revision,'loved'))
      else '{{}}'::jsonb end))
from selection s cross join foobar_scope own
where s.selection_status='ok' and s.track_id=own.track_id
  and s.preference_id is not distinct from own.expected_id
  and (own.write_rating or own.promote_favorite)
on conflict (account_id,library_id,track_key) do update set
  rating=case when (select write_rating from foobar_scope) then excluded.rating
              else current_preference.rating end,
  love_tier=case when (select promote_favorite from foobar_scope) then 'loved'
                 else current_preference.love_tier end,
  metadata=jsonb_set(current_preference.metadata,'{{foobar_import_v1}}',
    coalesce(current_preference.metadata->'foobar_import_v1','{{}}'::jsonb)
      || (excluded.metadata->'foobar_import_v1'),true),
  updated_at=now()
where current_preference.id=(select expected_id from foobar_scope)
  and (current_preference.track_id is null
       or current_preference.track_id=(select track_id from foobar_scope))
  and {current_seal}=(select expected_seal from foobar_scope)
returning id
"""


def _foobar_taste_mutation_flags(state, *, rating, favorite):
    """Shared decision only; callers still validate the genuine state and inputs.

    This is not a write, authority grant, receipt or proof of current state.
    """
    eligible = state.selection_status == "ok" and state.browse_allowed and state.taste_allowed
    write_rating = bool(
        eligible and rating is not None and not state.rating_protected
        and (state.rating is None or state.rating_marker is not None)
        and state.rating != rating
    )
    promote_favorite = bool(
        eligible and favorite and not state.favorite_protected
        and state.love_tier == "off"
    )
    return write_rating, promote_favorite


def _foobar_taste_postimage_phase_bytes(count):
    """Caller reserves this plus its original/source/control owners BEFORE entry."""
    base = _foobar_taste_phase_bytes(count)
    # Four additional paired result views cover constructor/return handoff.
    # Native records/metadata/driver and the forwarded inputs remain in base.
    return base + 4 * ((1024 * count + 2) + (128 * count + 2) + 3) + 64


def apply_foobar_taste_on_connection(
    connection, live_context, *, source_ref, items, expected, constraints=None,
):
    """Unchanged outcomes-only API, using the one genuine mutation owner."""
    return _foobar_apply_taste_impl(connection, live_context, source_ref=source_ref,
        items=items, expected=expected, constraints=constraints, capture_postimages=False)


def apply_foobar_taste_with_postimages_on_connection(
    connection, live_context, *, source_ref, items, expected, constraints=None,
):
    """Private Apply handoff. Requires the full postimage phase admitted first.

    Returned snapshots are the actual final read that the writer checked, not
    a second read after the writer returned. Keep them charged until the actual
    outer caller releases them; a local return never proves outer ownership.
    """
    return _foobar_apply_taste_impl(connection, live_context, source_ref=source_ref,
        items=items, expected=expected, constraints=constraints, capture_postimages=True)


def _foobar_apply_taste_impl(
    connection, live_context, *, source_ref, items, expected, constraints,
    capture_postimages,
):
    """Apply one admitted batch on the caller's transaction, with rollback on failure.

    The caller owns source/receipt idempotency and admits the fixed logical
    contribution PLUS its original/source/controls. This is not a public route.
    """
    from music_app.services.foobar_import_policy import evaluate_foobar_track_policy
    if type(capture_postimages) is not bool:
        raise FoobarTasteUnavailable("Foobar taste is unavailable.")
    _foobar_taste_connection(connection)
    _foobar_taste_context(live_context)
    _foobar_taste_uuid(source_ref)
    if (
        type(items) is not tuple or type(expected) is not tuple
        or len(items) != len(expected) or len(items) > _FOOBAR_TASTE_LIMIT
        or any(type(item) is not FoobarTasteChange for item in items)
        or any(type(state) is not FoobarTasteState for state in expected)
    ):
        raise FoobarTasteUnavailable("Foobar taste is unavailable.")
    track_ids = tuple(item.track_id for item in items)
    _foobar_taste_ids(track_ids)
    for item, state in zip(items, expected):
        _foobar_taste_check_state(state, source_ref)
        _foobar_taste_uuid(item.observation_ref)
        if (
            state.track_id != item.track_id
            or type(item.source_revision) is not int
            or not 1 <= item.source_revision <= 9223372036854775807
            or (item.rating is not None and (type(item.rating) is not int or not 1 <= item.rating <= 5))
            or type(item.favorite) is not bool
        ):
            raise FoobarTasteUnavailable("Foobar taste is unavailable.")
    # A nested real psycopg transaction owns a SAVEPOINT. Failure of ANY later
    # row/postcheck must roll back earlier rows before escaping to the caller.
    try:
        with connection.transaction():
            current = read_foobar_taste_on_connection(
                connection, live_context, source_ref=source_ref,
                track_ids=track_ids, constraints=constraints,
            )
            if current != expected:
                raise FoobarTasteStale("Foobar taste changed; prepare again.")
            outcomes = []
            returned_ids = []
            for item, state in zip(items, current):
                write_rating, promote_favorite = _foobar_taste_mutation_flags(
                    state, rating=item.rating, favorite=item.favorite,
                )
                preference_id = state.preference_id
                if write_rating or promote_favorite:
                    frame = _foobar_taste_frame([
                        live_context.actor.account_id, live_context.library_id, source_ref,
                        item.track_id, item.observation_ref, item.source_revision,
                        item.rating, write_rating, promote_favorite,
                        state.preference_id, state.state_seal,
                    ])
                    rows = _foobar_taste_query(connection, _foobar_taste_write_sql(), frame)
                    if not rows:
                        raise FoobarTasteStale("Foobar taste changed; prepare again.")
                    if (
                        len(rows) != 1 or type(rows[0]) is not dict or tuple(rows[0]) != ("id",)
                        or type(rows[0]["id"]) is not int or not 1 <= rows[0]["id"] <= 9223372036854775807
                    ):
                        raise FoobarTasteUnavailable("Foobar taste is unavailable.")
                    if state.preference_id is not None and rows[0]["id"] != state.preference_id:
                        raise FoobarTasteStale("Foobar taste changed; prepare again.")
                    preference_id = rows[0]["id"]
                    # These owners end here at their actual function owner; this
                    # does not release expected/source values held by the caller.
                    del rows, frame
                returned_ids.append(preference_id)
                outcomes.append(FoobarTasteOutcome(
                    item.track_id, item.observation_ref, write_rating, promote_favorite,
                ))
            # Fresh statement AFTER every upsert and all conflict waits, not a
            # reused pre-write CTE snapshot. It also re-evaluates current policy.
            post = read_foobar_taste_on_connection(
                connection, live_context, source_ref=source_ref,
                track_ids=track_ids, constraints=constraints,
            )
            for item, before, after, outcome, preference_id in zip(
                items, current, post, outcomes, returned_ids,
            ):
                if not outcome.rating_written and not outcome.favorite_promoted:
                    if after != before:
                        raise FoobarTasteStale("Foobar taste changed; prepare again.")
                    continue
                if (
                    after.track_id != before.track_id
                    or after.selection_status != "ok"
                    or after.preference_id != preference_id
                    or after.identity_seal != before.identity_seal
                    or after.browse_allowed != before.browse_allowed
                    or after.taste_allowed != before.taste_allowed
                    or after.rating_protected != before.rating_protected
                    or after.favorite_protected != before.favorite_protected
                    or after.rating != (item.rating if outcome.rating_written else before.rating)
                    or after.love_tier != ("loved" if outcome.favorite_promoted else before.love_tier)
                    or after.rating_marker != (
                        (source_ref, item.observation_ref, item.source_revision, item.rating)
                        if outcome.rating_written else before.rating_marker
                    )
                    or after.favorite_marker != (
                        (source_ref, item.observation_ref, item.source_revision, "loved")
                        if outcome.favorite_promoted else before.favorite_marker
                    )
                ):
                    raise FoobarTasteStale("Foobar taste changed; prepare again.")
            for state in post:
                policy = evaluate_foobar_track_policy(
                    live_context, track_id=state.track_id, constraints=constraints,
                )
                if (policy.browse_allowed, policy.taste_allowed) != (state.browse_allowed, state.taste_allowed):
                    raise FoobarTasteStale("Foobar taste changed; prepare again.")
            if capture_postimages:
                return FoobarTasteWriteResult(tuple(outcomes), post)
            return tuple(outcomes)

    except FoobarTasteStale:
        raise
    except Exception:
        raise FoobarTasteUnavailable("Foobar taste is unavailable.") from None


# Foobar selected personal conflicts N1: separate from automatic import/default APIs.
_FOOBAR_PERSONAL_LIMIT = 32


@_foobar_dataclass(frozen=True, slots=True)
class FoobarPersonalFence:
    track_id: int
    state: FoobarTasteState
    fence_sha256: str
    eligible_rating: bool
    eligible_favorite: bool


@_foobar_dataclass(frozen=True, slots=True)
class FoobarPersonalChoice:
    state: FoobarTasteState
    fence_sha256: str
    field: str
    proposed: int | str


@_foobar_dataclass(frozen=True, slots=True)
class FoobarPersonalOutcome:
    track_id: int
    field: str
    proposed: int | str


@_foobar_dataclass(frozen=True, slots=True)
class FoobarPersonalWriteResult:
    """Verified native observations, never a receipt or proof of outer commit."""
    outcomes: tuple[FoobarPersonalOutcome, ...]
    postimages: tuple[FoobarTasteState, ...]


def _foobar_personal_phase_bytes(count):
    """Fixed conservative logical Python views, not a native/SQL heap claim.

    The outer owner additionally retains its source, original review, inventory
    locks, cache and transaction. It must admit those actual owners separately.
    """
    if type(count) is not int or not 0 <= count <= _FOOBAR_PERSONAL_LIMIT:
        raise FoobarTasteUnavailable("Foobar personal changes are unavailable.")
    return 1_048_576 + 32_768 * count


def _foobar_personal_hash(value):
    if (type(value) is not str or len(value) != 64
            or any(c not in "0123456789abcdef" for c in value)):
        raise FoobarTasteUnavailable("Foobar personal changes are unavailable.")


def _foobar_personal_fence_sql(alias, track_id, track_key, preference_key):
    # Callers supply only fixed internal SQL identifiers, never request strings.
    # Include the ENTIRE native row: metadata, updated_at, identity and any
    # otherwise unselected columns. No unbounded row value crosses into Python.
    return ("encode(sha256(convert_to(jsonb_build_array(own.source_ref,"
            f"{track_id},{track_key},{preference_key},to_jsonb({alias}))::text,"
            "'UTF8')),'hex')")


def _foobar_personal_marker_sql(name):
    """Validate ownership shape/value, not ownership by this particular source."""
    if name not in ("rating", "favorite"):
        raise FoobarTasteUnavailable("Foobar personal changes are unavailable.")
    marker = f"(p.metadata->'foobar_import_v1'->'{name}')"
    uuid_pattern = "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
    value = (f"jsonb_typeof({marker}->3)='number' and ({marker}->>3) ~ '^[1-5]$'"
             f" and {marker}->3=to_jsonb(p.rating)" if name == "rating" else
             f"{marker}->3='\"loved\"'::jsonb and p.love_tier='loved'")
    return f"""coalesce((jsonb_typeof({marker})='array'
      and (case when jsonb_typeof({marker})='array' then jsonb_array_length({marker}) else 0 end)=4
      and jsonb_typeof({marker}->0)='string' and ({marker}->>0) ~ '{uuid_pattern}'
      and jsonb_typeof({marker}->1)='string' and ({marker}->>1) ~ '{uuid_pattern}'
      and jsonb_typeof({marker}->2)='number' and ({marker}->>2) ~ '^[1-9][0-9]{{0,18}}$'
      and (length({marker}->>2)<19 or ({marker}->>2)<='9223372036854775807')
      and ({value})),false)"""


def _foobar_personal_read_sql():
    canonical = canonical_candidate_selection_ctes("foobar_candidates").strip()
    if not canonical.startswith("with "):
        raise FoobarTasteUnavailable("Foobar personal changes are unavailable.")
    rp, fp, _, _, seal = _foobar_taste_metadata_sql("p", "own.source_ref")
    rating_sound = _foobar_personal_marker_sql("rating")
    favorite_sound = _foobar_personal_marker_sql("favorite")
    fence = _foobar_personal_fence_sql("p", "r.track_id", "t.track_key", "s.preference_key")
    return """
with foobar_input as materialized (
 select convert_from(%b::bytea,'UTF8')::jsonb as value
), foobar_scope as materialized (
 select (value->>0)::bigint as account_id,(value->>1)::bigint as library_id,
        value->>2 as source_ref from foobar_input
), foobar_requested as materialized (
 select id::bigint as track_id,ordinality as position
 from foobar_input,jsonb_array_elements_text(value->3) with ordinality as ids(id,ordinality)
), foobar_candidates as materialized (
 select t.track_key from foobar_requested r
 join library.local_tracks t on t.id=r.track_id
 join foobar_scope own on own.library_id=t.library_id
),
""" + canonical[5:].replace("%(account_id)s", "(select account_id from foobar_scope)").replace(
        "%(library_id)s", "(select library_id from foobar_scope)") + f""",
foobar_personal_rows as materialized (
 select r.position,r.track_id,
        case when s.selection_status='ok' and s.track_id<>r.track_id then 'conflict'
             else coalesce(s.selection_status,'missing') end as selection_status,
        p.id as preference_id,
        encode(sha256(convert_to(jsonb_build_array(r.track_id,t.track_key,s.preference_key)::text,'UTF8')),'hex') as identity_seal,
        {seal} as state_seal,{fence} as fence_sha256,
        {rp} as rating_protected,{fp} as favorite_protected,
        {rating_sound} as rating_marker_sound,{favorite_sound} as favorite_marker_sound,p.love_tier,
        coalesce(jsonb_typeof(p.metadata)='object'
          and (not (p.metadata ? 'rating_explicit')
               or jsonb_typeof(p.metadata->'rating_explicit')='boolean')
          and (not (p.metadata ? 'love_tier_explicit')
               or jsonb_typeof(p.metadata->'love_tier_explicit')='boolean')
          and (not (p.metadata ? 'foobar_import_v1')
               or (case when jsonb_typeof(p.metadata->'foobar_import_v1')='object'
                   then (p.metadata->'foobar_import_v1') - array['rating','favorite']
                   else null end)='{{}}'::jsonb),false) as metadata_shape,
        coalesce(p.metadata->'foobar_import_v1' ? 'rating',false) as has_rating_marker,
        coalesce(p.metadata->'foobar_import_v1' ? 'favorite',false) as has_favorite_marker
 from foobar_requested r cross join foobar_scope own
 left join library.local_tracks t on t.id=r.track_id and t.library_id=own.library_id
 left join selection s on s.track_ref=t.track_key
 left join app.track_preferences p on p.id=s.preference_id
   and p.account_id=own.account_id and p.library_id=own.library_id
), foobar_personal_sound as materialized (
 select *, (metadata_shape and (not has_rating_marker or rating_marker_sound)
              and (not has_favorite_marker or favorite_marker_sound)) as provenance_sound
 from foobar_personal_rows
)
select track_id,selection_status,preference_id,identity_seal,state_seal,fence_sha256,
       coalesce(selection_status='ok' and preference_id is not null
                and provenance_sound and rating_protected,false) as eligible_rating,
       coalesce(selection_status='ok' and preference_id is not null
                and provenance_sound and favorite_protected and love_tier='off',false) as eligible_favorite
from foobar_personal_sound order by position
"""


def read_foobar_personal_fences_on_connection(
    connection, live_context, *, source_ref, states, constraints=None,
):
    """Fence <=32 actual native states inside the genuine live transaction.

    Soundness is separate from generic protected flags. Unknown/malformed/stale
    provenance makes BOTH fields ineligible, not an authorization. Well-formed
    foreign-source ownership alone is not malformed. Ineligibility does not
    make an otherwise well-shaped review unreadable.
    """
    _foobar_taste_connection(connection)
    _foobar_taste_context(live_context)
    _foobar_taste_uuid(source_ref)
    if type(states) is not tuple or len(states) > _FOOBAR_PERSONAL_LIMIT:
        raise FoobarTasteUnavailable("Foobar personal changes are unavailable.")
    for state in states:
        _foobar_taste_check_state(state, source_ref)
    track_ids = tuple(state.track_id for state in states)
    _foobar_taste_ids(track_ids)
    current = read_foobar_taste_on_connection(connection, live_context,
        source_ref=source_ref, track_ids=track_ids, constraints=constraints)
    if current != states:
        raise FoobarTasteStale("Foobar personal state changed; review again.")
    if not states:
        return ()
    rows = _foobar_taste_query(connection, _foobar_personal_read_sql(),
        _foobar_taste_frame([live_context.actor.account_id, live_context.library_id,
                             source_ref, track_ids]))
    if len(rows) != len(states):
        raise FoobarTasteUnavailable("Foobar personal changes are unavailable.")
    expected_keys = ("track_id", "selection_status", "preference_id", "identity_seal",
                     "state_seal", "fence_sha256", "eligible_rating", "eligible_favorite")
    fences = []
    for state, row in zip(states, rows):
        if type(row) is not dict or tuple(row) != expected_keys:
            raise FoobarTasteUnavailable("Foobar personal changes are unavailable.")
        for key in ("identity_seal", "state_seal", "fence_sha256"):
            _foobar_personal_hash(row[key])
        if (type(row["track_id"]) is not int
                or type(row["selection_status"]) is not str
                or (row["preference_id"] is not None and type(row["preference_id"]) is not int)
                or any(type(row[key]) is not bool for key in ("eligible_rating", "eligible_favorite"))):
            raise FoobarTasteUnavailable("Foobar personal changes are unavailable.")
        if any(row[key] != getattr(state, key) for key in (
            "track_id", "selection_status", "preference_id", "identity_seal", "state_seal",
        )):
            raise FoobarTasteStale("Foobar personal state changed; review again.")
        permitted = state.browse_allowed and state.taste_allowed
        fences.append(FoobarPersonalFence(state.track_id, state, row["fence_sha256"],
            permitted and row["eligible_rating"], permitted and row["eligible_favorite"]))
    return tuple(fences)


def _foobar_personal_write_sql():
    canonical = canonical_candidate_selection_ctes("foobar_candidates").strip()
    if not canonical.startswith("with "):
        raise FoobarTasteUnavailable("Foobar personal changes are unavailable.")
    before_fence = _foobar_personal_fence_sql("p", "s.track_id", "s.track_key", "s.preference_key")
    current_fence = _foobar_personal_fence_sql(
        "current_preference", "s.track_id", "s.track_key", "s.preference_key")
    return """
with foobar_input as materialized (
 select convert_from(%b::bytea,'UTF8')::jsonb as value
), foobar_scope as materialized (
 select (value->>0)::bigint as account_id,(value->>1)::bigint as library_id,
        value->>2 as source_ref,(value->>3)::bigint as track_id,
        (value->>4)::bigint as expected_id,value->>5 as expected_fence,
        (value->>6)::boolean as write_rating,(value->>7)::integer as rating,
        (value->>8)::boolean as promote_favorite from foobar_input
), foobar_candidates as materialized (
 select t.track_key from library.local_tracks t
 join foobar_scope own on own.track_id=t.id and own.library_id=t.library_id
),
""" + canonical[5:].replace("%(account_id)s", "(select account_id from foobar_scope)").replace(
        "%(library_id)s", "(select library_id from foobar_scope)") + f""",
foobar_before as materialized (
 select p.id,p.rating as before_rating,p.love_tier as before_love_tier,
        to_jsonb(p) - array['rating','love_tier','metadata','updated_at'] as other_fields,
        (case when p.metadata ? 'foobar_import_v1' then
          jsonb_set(p.metadata,'{{foobar_import_v1}}',
            (p.metadata->'foobar_import_v1')
              - (case when own.write_rating then array['rating'] else array[]::text[] end)
              - (case when own.promote_favorite then array['favorite'] else array[]::text[] end),false)
          else p.metadata end)
          || case when own.write_rating then '{{"rating_explicit":true}}'::jsonb else '{{}}'::jsonb end
          || case when own.promote_favorite then '{{"love_tier_explicit":true}}'::jsonb else '{{}}'::jsonb end as after_metadata
 from selection s cross join foobar_scope own
 join app.track_preferences p on p.id=own.expected_id
   and p.account_id=own.account_id and p.library_id=own.library_id
 where s.selection_status='ok' and s.track_id=own.track_id
   and s.preference_id=own.expected_id and p.track_key=s.preference_key
   and (p.track_id is null or p.track_id=own.track_id)
   and {before_fence}=own.expected_fence
 for update of p
)
update app.track_preferences as current_preference set
 rating=case when own.write_rating then own.rating else current_preference.rating end,
 love_tier=case when own.promote_favorite then 'loved' else current_preference.love_tier end,
 metadata=before.after_metadata,updated_at=now()
from foobar_before before,selection s,foobar_scope own
where current_preference.id=before.id and current_preference.id=own.expected_id
  and current_preference.account_id=own.account_id and current_preference.library_id=own.library_id
  and s.selection_status='ok' and s.track_id=own.track_id and s.preference_id=own.expected_id
  and current_preference.track_key=s.preference_key
  and (current_preference.track_id is null or current_preference.track_id=own.track_id)
  and {current_fence}=own.expected_fence
  and (own.write_rating or own.promote_favorite)
returning current_preference.id,{current_fence} as fence_sha256,
  ((current_preference.rating is not distinct from
      case when own.write_rating then own.rating else before.before_rating end)
   and current_preference.love_tier=
      case when own.promote_favorite then 'loved' else before.before_love_tier end
   and current_preference.metadata=before.after_metadata
   and (to_jsonb(current_preference) - array['rating','love_tier','metadata','updated_at'])=before.other_fields) as preserved
"""


def apply_foobar_personal_changes_on_connection(
    connection, live_context, *, source_ref, choices, constraints=None,
):
    """One checked manual attempt, <=32 selected fields, no default/import API.

    The outer owner consumes the bound review once and owns commit/lost-ack
    behavior. This helper neither opens a new connection nor dispatches again.
    """
    _foobar_taste_connection(connection)
    _foobar_taste_context(live_context)
    _foobar_taste_uuid(source_ref)
    if type(choices) is not tuple or not 1 <= len(choices) <= _FOOBAR_PERSONAL_LIMIT:
        raise FoobarTasteUnavailable("Foobar personal changes are unavailable.")
    grouped = {}
    selected_fields = set()
    for choice in choices:
        if type(choice) is not FoobarPersonalChoice:
            raise FoobarTasteUnavailable("Foobar personal changes are unavailable.")
        _foobar_taste_check_state(choice.state, source_ref)
        _foobar_personal_hash(choice.fence_sha256)
        if (type(choice.field) is not str or choice.field not in ("rating", "favorite")
                or (choice.field == "rating" and (
                    type(choice.proposed) is not int or not 1 <= choice.proposed <= 5))
                or (choice.field == "favorite" and (
                    type(choice.proposed) is not str or choice.proposed != "loved"))):
            raise FoobarTasteUnavailable("Foobar personal changes are unavailable.")
        key = (choice.state.track_id, choice.field)
        if key in selected_fields:
            raise FoobarTasteUnavailable("Foobar personal changes are unavailable.")
        selected_fields.add(key)
        existing = grouped.get(choice.state.track_id)
        if existing is None:
            grouped[choice.state.track_id] = [choice.state, choice.fence_sha256, {}]
        elif existing[0] != choice.state or existing[1] != choice.fence_sha256:
            raise FoobarTasteUnavailable("Foobar personal changes are unavailable.")
        grouped[choice.state.track_id][2][choice.field] = choice.proposed
    states = tuple(group[0] for group in grouped.values())
    track_ids = tuple(grouped)
    try:
        # A real nested psycopg transaction is a SAVEPOINT; ANY later failure
        # rolls back every selected target, before it reaches the outer owner.
        with connection.transaction():
            fences = read_foobar_personal_fences_on_connection(connection, live_context,
                source_ref=source_ref, states=states, constraints=constraints)
            for fence in fences:
                before, expected_fence, fields = grouped[fence.track_id]
                if (fence.fence_sha256 != expected_fence
                        or ("rating" in fields and (not fence.eligible_rating or fields["rating"] == before.rating))
                        or ("favorite" in fields and (not fence.eligible_favorite or before.love_tier != "off"))):
                    raise FoobarTasteStale("Foobar personal state changed; review again.")
            returned = {}
            # Stable lock acquisition order, independent of selected page order.
            for track_id in sorted(grouped):
                before, expected_fence, fields = grouped[track_id]
                rows = _foobar_taste_query(connection, _foobar_personal_write_sql(),
                    _foobar_taste_frame([live_context.actor.account_id, live_context.library_id,
                        source_ref, track_id, before.preference_id, expected_fence,
                        "rating" in fields, fields.get("rating"), "favorite" in fields]))
                if not rows:
                    raise FoobarTasteStale("Foobar personal state changed; review again.")
                if (len(rows) != 1 or type(rows[0]) is not dict
                        or tuple(rows[0]) != ("id", "fence_sha256", "preserved")
                        or type(rows[0]["id"]) is not int or rows[0]["id"] != before.preference_id
                        or rows[0]["preserved"] is not True):
                    raise FoobarTasteUnavailable("Foobar personal changes are unavailable.")
                _foobar_personal_hash(rows[0]["fence_sha256"])
                returned[track_id] = rows[0]["fence_sha256"]
            # Fresh statements after all UPDATEs/conflict waits; not the DML CTE.
            post = read_foobar_taste_on_connection(connection, live_context,
                source_ref=source_ref, track_ids=track_ids, constraints=constraints)
            post_fences = read_foobar_personal_fences_on_connection(connection, live_context,
                source_ref=source_ref, states=post, constraints=constraints)
            for after, fence in zip(post, post_fences):
                before, _, fields = grouped[after.track_id]
                if (after.selection_status != "ok" or after.preference_id != before.preference_id
                        or after.identity_seal != before.identity_seal
                        or not after.browse_allowed or not after.taste_allowed
                        or after.rating != fields.get("rating", before.rating)
                        or after.love_tier != ("loved" if "favorite" in fields else before.love_tier)
                        or ("rating" in fields and not after.rating_protected)
                        or ("favorite" in fields and not after.favorite_protected)
                        or fence.fence_sha256 != returned[after.track_id]):
                    raise FoobarTasteStale("Foobar personal state changed; review again.")
            return FoobarPersonalWriteResult(tuple(FoobarPersonalOutcome(
                choice.state.track_id, choice.field, choice.proposed,
            ) for choice in choices), post)
    except FoobarTasteStale:
        raise
    except Exception:
        raise FoobarTasteUnavailable("Foobar personal changes are unavailable.") from None
