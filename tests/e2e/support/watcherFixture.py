"""Remove only the disposable watcher's owned inventory after its writers drain."""

import os
from pathlib import Path

from tests.e2e.support import isolatedPostgres


def remove_watched_inventory(owned_root: Path) -> dict[str, int]:
    owned_root = Path(owned_root).resolve()
    if owned_root.name != "watcher-reconciliation" or owned_root.parent.name != "cases":
        raise ValueError("Watcher cleanup requires its exact owned directory.")
    setup_url, _ = isolatedPostgres.resolve_isolated_database_urls()
    prefix = owned_root.as_posix() + "/"
    path_expression = "replace(file.private_path, chr(92), '/')"
    if os.name == "nt":
        prefix = prefix.lower()
        path_expression = f"lower({path_expression})"
    with isolatedPostgres._connect(setup_url) as connection:
        isolatedPostgres._assert_connected_role(connection, isolatedPostgres.SETUP_ROLE)
        connection.execute("select pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'))")
        files = connection.execute(f"""
            select file.id, file.private_path, track.album_id
            from library.local_track_files file
            join library.local_tracks track on track.id = file.track_id
            where left({path_expression}, length(%s)) = %s
            for update of file
        """, (prefix, prefix)).fetchall()
        if not files:
            return {"removed_albums": 0, "removed_files": 0}
        if any(Path(row["private_path"]).exists() for row in files):
            raise RuntimeError("Watcher fixture media still exists; inventory retained.")
        if any(row["album_id"] is None for row in files):
            raise RuntimeError("Watcher fixture contains unassigned inventory; retained for diagnosis.")
        album_ids = sorted({row["album_id"] for row in files})
        outside = connection.execute(f"""
            select file.id from library.local_track_files file
            join library.local_tracks track on track.id = file.track_id
            where track.album_id = any(%s)
              and left({path_expression}, length(%s)) <> %s
            limit 1
        """, (album_ids, prefix, prefix)).fetchone()
        if outside:
            raise RuntimeError("Watcher fixture album contains outside files; inventory retained.")
        album_keys = [row["album_key"] for row in connection.execute(
            "select album_key from library.local_albums where id = any(%s) order by id for update", (album_ids,),
        ).fetchall()]
        # The old watcher has exited and every owned physical file is absent.
        # Reuse the product removal transaction's cascades and revision contract.
        connection.execute("""
            update library.local_track_files
            set metadata = jsonb_set(metadata, '{scan_cache,stale}', 'true'::jsonb, true)
            where id = any(%s)
        """, ([row["id"] for row in files],))
        for album_key in album_keys:
            result = connection.execute(
                "select * from library.confirm_missing_album_removal(%s)", (album_key,),
            ).fetchone()
            if not result or result["removed_album_count"] != 1:
                raise RuntimeError("Watcher fixture removal failed; transaction rolled back.")
        return {"removed_albums": len(album_keys), "removed_files": len(files)}


if __name__ == "__main__":
    import argparse
    import json

    parser = argparse.ArgumentParser()
    parser.add_argument("--owned-root", type=Path, required=True)
    arguments = parser.parse_args()
    print(json.dumps(remove_watched_inventory(arguments.owned_root)))
