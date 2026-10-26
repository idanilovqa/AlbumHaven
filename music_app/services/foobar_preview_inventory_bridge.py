"""New reconstruction: current-policy, guarded Foobar preview inventory.

Internal transaction seam only. No receipt, canonical write, public success
route, retained upload, or imported history is implemented here.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json

from music_app.services.foobar_import_policy import evaluate_foobar_track_policy
from music_app.services.foobar_preview_inventory_postgres import (
    FoobarInventoryUnavailable, read_foobar_inventory_scalars_on_connection,
)
from music_app.services.foobar_snapshot_preview import InventoryEntry


@dataclass(frozen=True, slots=True)
class FoobarInventoryTarget:
    track_id: int
    canonical_track_ref: str
    browse_allowed: bool
    taste_allowed: bool
    selection_status: str


@dataclass(frozen=True, slots=True)
class FoobarInventorySnapshot:
    inventory: tuple[InventoryEntry, ...]
    targets: tuple[FoobarInventoryTarget, ...]
    files: tuple
    revision: str


def _framed_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"),
                      allow_nan=False).encode("utf-8")


def _opaque_reference(kind, account_id, library_id, native_id):
    if kind not in ("file", "track"):
        raise FoobarInventoryUnavailable()
    return hashlib.sha256(_framed_json([
        "albumhaven.foobar." + kind + ".v1", account_id, library_id, native_id,
    ])).hexdigest()


def _path_projection_sql():
    # The binary JSON frame is a bounded server-owned batch, not client SQL.
    return """
with input as materialized (
  select convert_from(%b::bytea,'UTF8')::jsonb as value
), scope as materialized (
  select (value->>0)::bigint as account_id,
         (value->>1)::bigint as library_id from input
), requested as materialized (
  select (row->>0)::bigint as file_id,(row->>1)::bigint as track_id,
         (row->>2)::integer as path_bytes,row->>3 as path_sha256
  from input,jsonb_array_elements(value->2) as rows(row)
), owned as materialized (
  select scope.library_id from scope
  join app.accounts a on a.id=scope.account_id
    and a.is_active is true and a.disabled_at is null
  join library.library_memberships m
    on m.account_id=a.id and m.library_id=scope.library_id
), candidates as materialized (
  select r.file_id,r.track_id,r.path_bytes,r.path_sha256,f.private_path
  from requested r
  join library.local_tracks t on t.id=r.track_id
  join owned own on own.library_id=t.library_id
  join library.local_track_files f on f.id=r.file_id and f.track_id=t.id
  where octet_length(f.private_path)=r.path_bytes
    and encode(sha256(convert_to(f.private_path,'UTF8')),'hex')=r.path_sha256
), admitted as materialized (
  select count(*)=(select count(*) from requested) as valid from candidates
)
select c.file_id,c.track_id,c.private_path
from candidates c cross join admitted a where a.valid
order by c.file_id
"""


def _project_path_batch(connection, account_id, library_id, batch, targets, entries):
    """Append at most100 browse-authorized paths from scalar-admitted rows.

    Caller retains complete scalars, target map and prior InventoryEntry output.
    Ordinary frame encoding and both native/Python path-result holders are live
    owners. No free alias or private4MiB lifetime is inferred here.
    """
    frame = [account_id, library_id, [
        [row.file_id, row.track_id, row.path_bytes, row.path_sha256] for row in batch
    ]]
    encoded = _framed_json(frame)
    cursor = None
    try:
        cursor = connection.execute(_path_projection_sql(), (encoded,), binary=True)
        records = cursor.fetchall()
        if type(records) is not list or len(records) != len(batch):
            raise FoobarInventoryUnavailable()
        for scalar, record in zip(batch, records):
            if (
                type(record) is not dict
                or tuple(record) != ("file_id", "track_id", "private_path")
                or type(record["file_id"]) is not int
                or type(record["track_id"]) is not int
                or record["file_id"] != scalar.file_id
                or record["track_id"] != scalar.track_id
                or type(record["private_path"]) is not str
            ):
                raise FoobarInventoryUnavailable()
            path = record["private_path"]
            raw = path.encode("utf-8")
            if len(raw) != scalar.path_bytes or hashlib.sha256(raw).hexdigest() != scalar.path_sha256:
                raise FoobarInventoryUnavailable()
            del raw
            target = targets[scalar.track_id]
            if not target.browse_allowed:
                raise FoobarInventoryUnavailable()
            entries.append(InventoryEntry(
                file_ref=_opaque_reference("file", account_id, library_id, scalar.file_id),
                canonical_track_ref=target.canonical_track_ref,
                path=path,
                identity_conflict=scalar.selection_status == "conflict",
            ))
    except Exception:
        raise FoobarInventoryUnavailable() from None
    finally:
        if cursor is not None:
            try:
                cursor.close()
            except Exception:
                raise FoobarInventoryUnavailable() from None


def read_foobar_preview_inventory_on_connection(
    connection, live_context, *, constraints=None, expected_files=None,
):
    """Build actual published InventoryEntry values under a real locked context.

    Entry requires current_library_transaction(inventory_publication_first=True)
    and separately admitted complete intake owners. N2's scalar gate is not a
    proof of aggregate Python or server memory or a hard deadline.
    """
    scalars = read_foobar_inventory_scalars_on_connection(
        connection, live_context, constraints=constraints,
    )
    # A caller deriving a smaller compound path/target reservation from an
    # earlier complete scalar snapshot must fence it BEFORE variable projection.
    # The scalar reader itself still requires its whole published fixed reserve.
    if expected_files is not None and scalars != expected_files:
        raise FoobarInventoryUnavailable()
    account_id = live_context.actor.account_id
    library_id = live_context.library_id
    targets = {}
    for row in scalars:
        existing = targets.get(row.track_id)
        if existing is not None:
            if existing.selection_status != row.selection_status:
                raise FoobarInventoryUnavailable()
            continue
        policy = evaluate_foobar_track_policy(
            live_context, track_id=row.track_id, constraints=constraints,
        )
        targets[row.track_id] = FoobarInventoryTarget(
            row.track_id, _opaque_reference("track", account_id, library_id, row.track_id),
            policy.browse_allowed, policy.taste_allowed, row.selection_status,
        )

    # Exact framed stream: J(domain/scope) followed by LF+J(row) for EVERY
    # scalar row in increasing file_id order, including hidden/offline rows.
    # JSON strings escape LF, so framing is unambiguous; no whole frame copy.
    digest = hashlib.sha256()
    digest.update(_framed_json(["albumhaven.foobar.inventory.v1", account_id, library_id]))
    for row in scalars:
        policy = targets[row.track_id]
        digest.update(b"\n")
        digest.update(_framed_json([
            row.file_id, row.track_id, row.path_bytes, row.path_sha256,
            row.selection_status, row.file_available,
            policy.browse_allowed, policy.taste_allowed,
        ]))

    entries = []
    batch = []
    for row in scalars:
        if not targets[row.track_id].browse_allowed:
            continue
        batch.append(row)
        if len(batch) == 100:
            _project_path_batch(connection, account_id, library_id, batch, targets, entries)
            batch.clear()
    if batch:
        _project_path_batch(connection, account_id, library_id, batch, targets, entries)
    batch.clear()

    # READ COMMITTED statements can see different snapshots. Re-read COMPLETE
    # membership, not only projected/browse-visible rows, before exposing a result.
    current = read_foobar_inventory_scalars_on_connection(
        connection, live_context, constraints=constraints,
    )
    if current != scalars:
        raise FoobarInventoryUnavailable()
    # Constraints may be dynamic. An ordinary deny is a changed snapshot; an
    # evaluator/resolver exception retains its genuine safe503 behavior.
    for target in targets.values():
        policy = evaluate_foobar_track_policy(
            live_context, track_id=target.track_id, constraints=constraints,
        )
        if (policy.browse_allowed, policy.taste_allowed) != (
            target.browse_allowed, target.taste_allowed,
        ):
            raise FoobarInventoryUnavailable()
    return FoobarInventorySnapshot(
        tuple(entries), tuple(targets.values()), scalars, digest.hexdigest(),
    )

