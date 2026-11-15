from __future__ import annotations

import argparse
import os

from music_app.services.cover_lookup_action_repair import (
    apply_repair,
    plan_repair,
    rollback_repair,
)


def main() -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--rollback-batch")
    args = parser.parse_args()

    database_url = str(os.environ.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
    if not database_url:
        raise SystemExit("ALBUM_HAVEN_APP_DATABASE_URL is required")

    import psycopg
    from psycopg.rows import dict_row

    with psycopg.connect(database_url, row_factory=dict_row) as connection:
        if args.rollback_batch:
            task_keys = rollback_repair(connection, args.rollback_batch)
            connection.commit()
            print(f"Rolled back {len(task_keys)} repaired notification(s).")
            return 0

        rows = plan_repair(connection)
        print(f"Proven post-search explicit cover actions: {len(rows)}")
        for row in rows:
            print(f"{row['task_key']}\t{row['title']}")
        if not args.apply:
            print("Dry run only; pass --apply to persist.")
            return 0

        batch_id, task_keys = apply_repair(connection, rows)
        connection.commit()
        print(f"Applied {len(task_keys)} notification repair(s); rollback batch: {batch_id}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
