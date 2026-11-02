"""Validate applied SQL history before a migration runner changes the database."""
from __future__ import annotations

from collections.abc import Mapping
from contextlib import contextmanager
import hashlib
from pathlib import Path
from typing import Any


LEGACY_TRACK_PREFERENCES = "0081_scope_track_preferences_by_library.sql"
LEGACY_TRACK_PREFERENCES_SHA256 = (
    "90e9ebdc18257df4f85df8da2a6e312fdda81b844dfed6f856792d345eed1d23"
)
SCOPED_TRACK_PREFERENCES = "0087_reconcile_track_preferences_library_scope.sql"
CURRENT_PLAYBACK_PRESENCE = "0096_create_current_playback_presence.sql"
FRIEND_CONNECTIONS = "app.friend_connections"


@contextmanager
def migration_compatibility_context(
    connection: Any,
    migration_name: str,
):
    """Supply narrowly scoped transactional authority to historical SQL.

    Migration 0090 intentionally revoked every ordinary privilege from the
    non-superuser migration owner before granting its runtime DML set.  The
    already-published 0096 bytes later create friend-connection triggers and
    therefore require TRIGGER for that one transaction.  Keep both migration
    checksums immutable and leave no durable ACL change.
    """
    if migration_name != CURRENT_PLAYBACK_PRESENCE:
        yield
        return

    row = connection.execute(
        "select has_table_privilege(current_user, %s, 'TRIGGER') as has_trigger",
        (FRIEND_CONNECTIONS,),
    ).fetchone()
    value = (
        row.get("has_trigger")
        if isinstance(row, Mapping)
        else row[0]
        if row
        else None
    )
    if not isinstance(value, bool):
        raise RuntimeError("Could not verify friend-connection migration authority.")

    granted = not value
    if granted:
        connection.execute(
            f"grant trigger on table {FRIEND_CONNECTIONS} to current_user"
        )
    try:
        yield
    except Exception:
        # The surrounding transaction owns rollback. Avoid masking the primary
        # migration or ledger error with cleanup SQL on an aborted transaction.
        raise
    else:
        if granted:
            connection.execute(
                f"revoke trigger on table {FRIEND_CONNECTIONS} from current_user"
            )


def validate_applied_migrations(
    connection: Any,
    migrations_root: Path,
    applied: Mapping[str, str],
) -> None:
    """Fail before pending SQL on unknown history, changed bytes, or incompatible scope.

    Historical filenames, checksums and timestamps remain untouched. The legacy
    inventory is validation evidence, never part of the active migration sequence.
    """
    active = {
        path.name: hashlib.sha256(path.read_bytes()).hexdigest()
        for path in migrations_root.glob("*.sql")
        if path.is_file()
    }
    if LEGACY_TRACK_PREFERENCES in active:
        raise RuntimeError("Legacy track preference SQL must not be an active migration.")
    for name, checksum in applied.items():
        if name == LEGACY_TRACK_PREFERENCES:
            archived = migrations_root / "legacy" / name
            if (
                checksum != LEGACY_TRACK_PREFERENCES_SHA256
                or not archived.is_file()
                or hashlib.sha256(archived.read_bytes()).hexdigest()
                != LEGACY_TRACK_PREFERENCES_SHA256
            ):
                raise RuntimeError(f"Legacy migration checksum mismatch: {name}")
        elif name not in active:
            raise RuntimeError(f"Unknown applied migration: {name}")
        elif checksum != active[name]:
            raise RuntimeError(f"Migration checksum mismatch: {name}")

    legacy_applied = LEGACY_TRACK_PREFERENCES in applied
    forward_applied = SCOPED_TRACK_PREFERENCES in applied
    if not legacy_applied and SCOPED_TRACK_PREFERENCES not in active:
        return
    verifier = migrations_root.parents[1] / "scripts/postgres/verify_track_preferences_scope.sql"
    if not verifier.is_file():
        raise RuntimeError("Track preference scope verifier is missing.")
    row = connection.execute(verifier.read_text(encoding="utf-8")).fetchone()
    state = row.get("scope_state") if isinstance(row, Mapping) else row[0] if row else None
    expected = "scoped" if legacy_applied or forward_applied else "legacy"
    if state != expected:
        raise RuntimeError(
            f"Incompatible track preference index state: expected {expected}, received {state!r}."
        )
