"""Load or edit revoked Android attestation certificate serials in Postgres.

``import`` loads Google's attestation status list (https://android.googleapis.com/attestation/status,
saved to a file) into ``app.android_attestation_revocations``; ``add`` and ``remove`` manage the
operator's own revocations. The server reads only those rows; it never reads the file.
Uses ``ALBUM_HAVEN_MIGRATOR_DATABASE_URL``.
"""

from __future__ import annotations

import argparse
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime, timezone
import json
import os
import re
import sys
from typing import Any, TextIO

BATCH_SIZE = 500
_SERIAL = re.compile(r"[0-9a-f]{1,64}")
_MAX_REASON = 200


class InvalidInput(ValueError):
    pass


def normalize_serial(value: object) -> str:
    """Google prints serials in uppercase hex, sometimes with leading zeros; the server compares
    ``format(serial_number, "x")``."""
    text = str(value).strip().lower()
    if not _SERIAL.fullmatch(text):
        raise InvalidInput("a serial must be hexadecimal")
    return text.lstrip("0") or "0"


def _reason(value: object) -> str:
    return str(value or "").strip()[:_MAX_REASON]


def read_status_list(path: str) -> dict[str, str]:
    try:
        with open(path, "rb") as handle:
            entries = json.load(handle).get("entries")
    except (OSError, ValueError, AttributeError):
        entries = None
    if not isinstance(entries, dict):
        raise InvalidInput("the status list is unreadable or has no entries object")
    return {
        normalize_serial(serial): _reason(details.get("reason") if isinstance(details, dict) else "")
        for serial, details in entries.items()
    }


def import_status_list(connection, entries: Mapping[str, str], now: datetime, progress: Callable[[str], None]) -> int:
    """One transaction: upsert changed rows in batches, drop serials the list no longer has, then
    mark the list loaded. Operator revocations are never overwritten or removed."""
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
    connection.execute(
        """insert into app.android_attestation_revocation_sources (source, entry_count, loaded_at)
           values ('status-list', %s, %s)
           on conflict (source) do update set entry_count = excluded.entry_count, loaded_at = excluded.loaded_at""",
        (len(serials), now),
    )
    return removed


def add_revocation(connection, serial: str, reason: str, now: datetime) -> None:
    connection.execute(
        """insert into app.android_attestation_revocations (serial, source, reason, refreshed_at)
           values (%s, 'operator', %s, %s)
           on conflict (serial) do update set source = 'operator', reason = excluded.reason,
             refreshed_at = excluded.refreshed_at""",
        (serial, reason, now),
    )


def remove_revocation(connection, serial: str) -> bool:
    return bool(connection.execute(
        "delete from app.android_attestation_revocations where serial = %s and source = 'operator'", (serial,)
    ).rowcount)


def _connect(database_url: str) -> Any:
    import psycopg
    from psycopg.rows import dict_row

    return psycopg.connect(database_url, row_factory=dict_row)


def main(
    argv: Sequence[str] | None = None,
    *,
    environ: Mapping[str, str] | None = None,
    stdout: TextIO | None = None,
    stderr: TextIO | None = None,
    connect: Callable[[str], Any] | None = None,
    clock: Callable[[], datetime] | None = None,
) -> int:
    output = sys.stdout if stdout is None else stdout
    errors = sys.stderr if stderr is None else stderr
    arguments = _parser().parse_args(tuple(sys.argv[1:] if argv is None else argv))
    database_url = str((os.environ if environ is None else environ).get("ALBUM_HAVEN_MIGRATOR_DATABASE_URL") or "")
    if not database_url.strip():
        print("ALBUM_HAVEN_MIGRATOR_DATABASE_URL is not set.", file=errors)
        return 2
    try:
        entries = read_status_list(arguments.file) if arguments.command == "import" else None
        serial = normalize_serial(arguments.serial) if arguments.command != "import" else None
    except InvalidInput as error:
        print(f"Nothing changed: {error}.", file=errors)
        return 2
    now = (clock or (lambda: datetime.now(timezone.utc)))()
    try:
        with (connect or _connect)(database_url.strip()) as connection:
            if arguments.command == "import":
                removed = import_status_list(connection, entries, now, lambda line: print(line, file=output))
                print(f"Status list loaded: {len(entries)} revoked serials, {removed} no longer listed.", file=output)
            elif arguments.command == "add":
                add_revocation(connection, serial, _reason(arguments.reason), now)
                print(f"Serial {serial} is revoked.", file=output)
            elif remove_revocation(connection, serial):
                print(f"Serial {serial} is no longer revoked by the operator.", file=output)
            else:
                print(f"Serial {serial} has no operator revocation.", file=output)
    except Exception:
        print("Revocation update failed; nothing changed.", file=errors)
        return 1
    return 0


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Manage revoked Android attestation certificate serials.")
    commands = parser.add_subparsers(dest="command", required=True)
    load = commands.add_parser("import", help="load Google's attestation status list from a saved file")
    load.add_argument("--file", required=True, help="the saved status list JSON")
    add = commands.add_parser("add", help="revoke one certificate serial")
    add.add_argument("--serial", required=True, help="the certificate serial in hex")
    add.add_argument("--reason", default="", help="a short note, at most 200 characters")
    remove = commands.add_parser("remove", help="undo an operator revocation")
    remove.add_argument("--serial", required=True, help="the certificate serial in hex")
    return parser


if __name__ == "__main__":
    raise SystemExit(main())
