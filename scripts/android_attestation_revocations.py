"""Load or edit revoked Android attestation certificate serials in Postgres.

``import`` loads Google's attestation status list (https://android.googleapis.com/attestation/status,
saved to a file) into ``app.android_attestation_revocations``; ``add`` and ``remove`` manage the
operator's own revocations. Attestation reads only those rows. Re-run ``import`` to refresh the list.
Uses ``ALBUM_HAVEN_MIGRATOR_DATABASE_URL``.
"""

from __future__ import annotations

import argparse
from collections.abc import Callable, Mapping, Sequence
from datetime import datetime, timezone
import os
from pathlib import Path
import sys
from typing import Any, TextIO

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from music_app.services.android_attestation_revocations import (  # noqa: E402
    InvalidStatusList,
    clip_reason,
    normalize_serial,
    read_status_list,
    replace_status_list,
)


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
    except InvalidStatusList as error:
        print(f"Nothing changed: {error}.", file=errors)
        return 2
    now = (clock or (lambda: datetime.now(timezone.utc)))()
    try:
        with (connect or _connect)(database_url.strip()) as connection:
            if arguments.command == "import":
                removed = replace_status_list(connection, entries, now, lambda line: print(line, file=output))
                print(f"Status list loaded: {len(entries)} revoked serials, {removed} no longer listed.", file=output)
            elif arguments.command == "add":
                add_revocation(connection, serial, clip_reason(arguments.reason), now)
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
