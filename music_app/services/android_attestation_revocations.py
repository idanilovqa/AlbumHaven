"""Google's Android attestation status list, loaded into ``app.android_attestation_revocations``.

Attestation reads only those rows. ``scripts/android_attestation_revocations.py`` refreshes the list;
``import_status_list_on_startup`` is the one-time backfill for servers that used to read the file on
every request, so upgrading never leaves a configured list unloaded.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from datetime import datetime, timezone
import json
import logging
import os
import re

from music_app.services.android_artifact_access import ATTESTATION_STATUS_ENV
from music_app.services.postgres_connections import pooled_connection

BATCH_SIZE = 500
_SERIAL = re.compile(r"[0-9a-f]{1,64}")
_MAX_REASON = 200
_LOGGER = logging.getLogger(__name__)

_MARK_LOADED_SQL = """insert into app.android_attestation_revocation_sources (source, entry_count, loaded_at)
    values ('status-list', %s, %s)
    on conflict (source) do update set entry_count = excluded.entry_count, loaded_at = excluded.loaded_at"""


class InvalidStatusList(ValueError):
    pass


def normalize_serial(value: object) -> str:
    """Google prints serials in uppercase hex, sometimes with leading zeros; attestation compares
    ``format(serial_number, "x")``."""
    text = str(value).strip().lower()
    if not _SERIAL.fullmatch(text):
        raise InvalidStatusList("a serial must be hexadecimal")
    return text.lstrip("0") or "0"


def clip_reason(value: object) -> str:
    return str(value or "").strip()[:_MAX_REASON]


def read_status_list(path: str) -> dict[str, str]:
    """Serial -> reason; raises ``InvalidStatusList`` for an unreadable file or malformed entry."""
    try:
        with open(path, "rb") as handle:
            entries = json.load(handle).get("entries")
    except (OSError, ValueError, AttributeError):
        entries = None
    if not isinstance(entries, dict):
        raise InvalidStatusList("the status list is unreadable or has no entries object")
    return {
        normalize_serial(serial): clip_reason(details.get("reason") if isinstance(details, dict) else "")
        for serial, details in entries.items()
    }


def replace_status_list(connection, entries: Mapping[str, str], now: datetime,
                        progress: Callable[[str], None]) -> int:
    """In the caller's transaction: upsert changed rows in batches, drop serials the list no longer
    has, then mark the list loaded. Operator revocations are never overwritten or removed."""
    serials = sorted(entries)
    for start in range(0, len(serials), BATCH_SIZE):
        batch = serials[start:start + BATCH_SIZE]
        connection.execute(
            """insert into app.android_attestation_revocations (serial, source, reason, refreshed_at)
               select serial, 'status-list', reason, %s from unnest(%s::text[], %s::text[]) as t(serial, reason)
               on conflict (serial) do update set reason = excluded.reason, refreshed_at = excluded.refreshed_at
                where app.android_attestation_revocations.source = 'status-list'
                  and app.android_attestation_revocations.reason is distinct from excluded.reason""",
            (now, batch, [entries[serial] for serial in batch]),
        )
        progress(f"Loaded {min(start + BATCH_SIZE, len(serials))} of {len(serials)} serials.")
    removed = connection.execute(
        "delete from app.android_attestation_revocations where source = 'status-list' and serial <> all(%s)",
        (serials,),
    ).rowcount
    connection.execute(_MARK_LOADED_SQL, (len(serials), now))
    return removed


def import_status_list_on_startup(config, *, environ=None, connect=None, clock=None, stop_requested=None) -> str:
    """One-time backfill: when the status list is configured and was never loaded, import the file
    the server used to read, one batch per transaction, then record it as loaded. Once recorded,
    startup reads only that row and never opens the file again."""
    path = str((os.environ if environ is None else environ).get(ATTESTATION_STATUS_ENV) or "").strip()
    database_url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
    if not path or not database_url:
        return "skipped"
    connector = connect or pooled_connection
    with connector(database_url) as connection:
        if connection.execute(
            "select 1 from app.android_attestation_revocation_sources where source = 'status-list'"
        ).fetchone() is not None:
            return "done"
    try:
        entries = read_status_list(path)
    except InvalidStatusList:
        # Attestation keeps refusing with attestation_unavailable until an import succeeds.
        _LOGGER.warning("Attestation status list import could not read the configured file.")
        return "failed"
    now = (clock or (lambda: datetime.now(timezone.utc)))()
    serials = sorted(entries)
    _LOGGER.info("Attestation status list import started entries=%d", len(serials))
    for start in range(0, len(serials), BATCH_SIZE):
        if stop_requested is not None and stop_requested.is_set():
            _LOGGER.info("Attestation status list import paused imported=%d of %d", start, len(serials))
            return "stopped"
        batch = serials[start:start + BATCH_SIZE]
        with connector(database_url) as connection:
            connection.execute(
                """insert into app.android_attestation_revocations (serial, source, reason, refreshed_at)
                   select serial, 'status-list', reason, %s
                     from unnest(%s::text[], %s::text[]) as t(serial, reason)
                   on conflict (serial) do nothing""",
                (now, batch, [entries[serial] for serial in batch]),
            )
        _LOGGER.info("Attestation status list import progress imported=%d of %d",
                     start + len(batch), len(serials))
    with connector(database_url) as connection:
        connection.execute(
            """insert into app.android_attestation_revocation_sources (source, entry_count, loaded_at)
               values ('status-list', %s, %s) on conflict (source) do nothing""",
            (len(serials), now),
        )
    _LOGGER.info("Attestation status list import finished entries=%d", len(serials))
    return "imported"
