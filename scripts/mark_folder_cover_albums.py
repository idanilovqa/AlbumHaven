"""One-time step: re-check the albums that now show their folder's image.

A coverless album that shows its folder-album's image no longer counts as "Missing cover art".
Run this once the code that shows it is serving: marks made earlier are evaluated by the old rule.
It marks only those albums for the Problematic Files index, which then re-checks them album by
album. It repairs nothing stored and changes no builder version.

    python scripts/mark_folder_cover_albums.py         read-only: how many albums it would mark
    python scripts/mark_folder_cover_albums.py --mark  mark them
"""
from __future__ import annotations

import argparse
from collections.abc import Sequence
from pathlib import Path
import sys
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def mark_folder_cover_albums(connection: Any, *, mark: bool) -> int:
    """The albums the display fallback fills, marked when asked; only coverless albums are read."""
    from music_app.services.album_display_cover import album_display_cover_sql

    marking = "library.mark_problematic_album_dirty(filled.library_id, filled.id)" if mark else "filled.id"
    return len(connection.execute(f"""
        with filled as materialized (
          select albums.library_id, albums.id from library.local_albums albums
          where nullif(btrim(albums.cover_path), '') is null
            and ({album_display_cover_sql("albums")}) is not null
        )
        select {marking} from filled
    """).fetchall())


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Re-check the albums that show their folder's image.")
    parser.add_argument("--mark", action="store_true", help="mark them; without it nothing changes")
    arguments = parser.parse_args(argv)
    try:
        from music_app import _build_runtime_config
        from music_app.services.postgres_connections import pooled_connection

        database_url = str(_build_runtime_config().get("ALBUM_HAVEN_APP_DATABASE_URL") or "")
        with pooled_connection(database_url) as connection:
            if not arguments.mark:
                connection.execute("set transaction read only")
            count = mark_folder_cover_albums(connection, mark=arguments.mark)
    except Exception as error:
        # A driver's message can quote the connection string: name the failure only.
        code = getattr(error, "sqlstate", None)
        print(f"FAILED: {type(error).__name__}" + (f" (SQLSTATE {code})" if code else ""), file=sys.stderr)
        return 1
    print(f"{'marked' if arguments.mark else 'would mark'}={count}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
