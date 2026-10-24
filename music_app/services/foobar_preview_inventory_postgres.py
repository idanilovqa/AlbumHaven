"""Scalar-first complete known-file inventory for Foobar reconstruction N2.

No private path, track key, title or native taste payload crosses this seam.
The caller owns current_library_transaction and its inventory publication lock.
This is not yet the complete Preview InventoryEntry/path-projection adapter.
"""
from __future__ import annotations

from dataclasses import dataclass

from music_app.services.policy import PolicyContext
from music_app.services.private_library_authority import require_private_action
from music_app.services.track_preferences_postgres import canonical_candidate_selection_ctes


MAX_INVENTORY_FILES = 100_000
MAX_INVENTORY_FIELD_BYTES = 67_108_864
MAX_PATH_BYTES = 16_384


class FoobarInventoryUnavailable(RuntimeError):
    code = "import_unavailable"
    status_code = 503
    retryable = False

    def __init__(self):
        super().__init__("Foobar inventory is unavailable.")


@dataclass(frozen=True, slots=True)
class FoobarInventoryScalar:
    file_id: int
    track_id: int
    path_bytes: int
    path_sha256: str
    selection_status: str
    file_available: bool


def _foobar_inventory_scalar_sql():
    # Candidate relation is fixed source text, never a request identifier.
    canonical = canonical_candidate_selection_ctes("foobar_candidates").strip()
    if not canonical.startswith("with "):
        raise FoobarInventoryUnavailable()
    return """
with foobar_scope as materialized (
  select a.id as account_id,l.id as library_id
  from app.accounts a
  join library.library_memberships m on m.account_id=a.id
  join library.libraries l on l.id=m.library_id
  where a.id=%(account_id)s and l.id=%(library_id)s
    and a.is_active is true and a.disabled_at is null
),
foobar_file_sizes as materialized (
  select f.id as file_id,t.id as track_id,octet_length(f.private_path) as path_bytes
  from library.local_tracks t
  join library.local_track_files f on f.track_id=t.id
  join foobar_scope own on own.library_id=t.library_id
  order by f.id limit 100001
),
foobar_gate as materialized (
  select exists(select 1 from foobar_scope)
    and count(*)<=100000
    and coalesce(bool_and((path_bytes between 1 and 16384) is true),true)
    and coalesce(sum(path_bytes::bigint+128),0)<=67108864 as admitted
  from foobar_file_sizes
),
foobar_candidates as materialized (
  select distinct t.track_key
  from foobar_file_sizes f
  join library.local_tracks t on t.id=f.track_id and t.library_id=%(library_id)s
  cross join foobar_gate gate where gate.admitted
),
""" + canonical[5:] + """,
foobar_scalars as materialized (
  select true as admitted,f.id as file_id,t.id as track_id,sizes.path_bytes,
    encode(sha256(convert_to(f.private_path,'UTF8')),'hex') as path_sha256,
    case when s.selection_status='ok' and s.track_id<>t.id then 'conflict'
         else coalesce(s.selection_status,'missing') end as selection_status,
    (f.scan_cache_stale is false and r.is_active is true
      and r.library_id=t.library_id
      and not exists(select 1 from library.libraries health
        where health.id=t.library_id
          and coalesce(health.metadata->'library_watch_health','{}'::jsonb)
            ? coalesce(nullif(r.metadata->>'root_id',''),f.metadata->>'library_root_id')))
      is true as file_available
  from foobar_file_sizes sizes
  cross join foobar_gate gate
  join library.local_tracks t on t.id=sizes.track_id and t.library_id=%(library_id)s
  join library.local_track_files f on f.id=sizes.file_id and f.track_id=t.id
  left join library.library_roots r on r.id=f.library_root_id
  left join selection s on s.track_ref=t.track_key
  where gate.admitted
)
select admitted,file_id,track_id,path_bytes,path_sha256,selection_status,file_available
from foobar_scalars
union all
select false,null,null,null,null,null,null from foobar_gate where not admitted
order by file_id nulls first
"""


def read_foobar_inventory_scalars_on_connection(connection, live_context, *, constraints=None):
    """Read genuine complete scalar membership in one statement snapshot.

    Required entry: live locked own-library context, inventory-publication lock,
    and inventory intake capacity. This does not certify lock ownership by
    duck typing, acquire a second connection, or claim a hard command deadline.
    The six-field output uses only bounded IDs, lengths, digest, enum and bool.
    """
    if not isinstance(live_context, PolicyContext):
        raise FoobarInventoryUnavailable()
    actor = live_context.actor
    if (
        not actor.is_authenticated
        or any(type(value) is not int or not 1 <= value <= 9223372036854775807 for value in (
            actor.account_id, actor.session_id, actor.current_library_id, live_context.library_id,
        ))
        or actor.current_library_id != live_context.library_id
        or live_context.target_account_id not in (None, actor.account_id)
    ):
        raise FoobarInventoryUnavailable()
    # Preserve the real endpoint denial behavior; a resolver exception is not
    # converted to an empty inventory or a normal resource-level denial.
    require_private_action(live_context, "library.browse.read", constraints=constraints)
    params = {"account_id": actor.account_id, "library_id": live_context.library_id}
    cursor = None
    try:
        cursor = connection.execute(_foobar_inventory_scalar_sql(), params)
        records = cursor.fetchall()
        if type(records) is not list or len(records) > MAX_INVENTORY_FILES:
            raise FoobarInventoryUnavailable()
        previous = 0
        total = 0
        for record in records:
            if (
                type(record) is not dict
                or tuple(record) != ("admitted", "file_id", "track_id", "path_bytes",
                                     "path_sha256", "selection_status", "file_available")
                or record["admitted"] is not True
                or any(type(record[name]) is not int or not 1 <= record[name] <= 9223372036854775807
                       for name in ("file_id", "track_id", "path_bytes"))
                or record["file_id"] <= previous
                or record["path_bytes"] > MAX_PATH_BYTES
                or type(record["path_sha256"]) is not str or len(record["path_sha256"]) != 64
                or any(character not in "0123456789abcdef" for character in record["path_sha256"])
                or type(record["selection_status"]) is not str
                or record["selection_status"] not in ("ok", "missing", "forbidden", "conflict")
                or type(record["file_available"]) is not bool
            ):
                raise FoobarInventoryUnavailable()
            previous = record["file_id"]
            total += record["path_bytes"] + 128
        if total > MAX_INVENTORY_FIELD_BYTES:
            raise FoobarInventoryUnavailable()
        # Output construction overlaps the actual fetched records. This is an
        # explicit inventory-intake owner, not a free private4MiB payload slot.
        return tuple(FoobarInventoryScalar(
            row["file_id"], row["track_id"], row["path_bytes"], row["path_sha256"],
            row["selection_status"], row["file_available"],
        ) for row in records)
    except Exception:
        raise FoobarInventoryUnavailable() from None
    finally:
        if cursor is not None:
            try:
                cursor.close()
            except Exception:
                raise FoobarInventoryUnavailable() from None
