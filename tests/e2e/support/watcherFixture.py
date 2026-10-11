"""Remove only the disposable watcher's owned inventory after its writers drain."""

import json
import os
import shutil
from pathlib import Path

from tests.e2e.support import isolatedPostgres


def _path_prefix_sql(path_expression: str, count: int) -> str:
    return " or ".join(
        f"left({path_expression}, length(%s)) = %s" for _ in range(count)
    )


def _remove_owned_directories(paths: tuple[Path, ...]) -> None:
    for path in paths:
        if not path.exists():
            continue
        if not path.is_dir():
            raise RuntimeError("Watcher recovery owned path is not a directory.")
        shutil.rmtree(path)


def _remove_watcher_recovery_inventory(
    root_paths: tuple[Path, Path],
    *,
    owned_paths: tuple[Path, Path, Path],
) -> dict[str, int]:
    setup_url, _ = isolatedPostgres.resolve_isolated_database_urls()
    prefixes = tuple(path.as_posix() + "/" for path in root_paths)
    path_expression = "replace(file.private_path, chr(92), '/')"
    if os.name == "nt":
        prefixes = tuple(prefix.lower() for prefix in prefixes)
        path_expression = f"lower({path_expression})"
    prefix_parameters = tuple(value for prefix in prefixes for value in (prefix, prefix))
    prefix_sql = _path_prefix_sql(path_expression, len(prefixes))

    with isolatedPostgres._connect(setup_url) as connection:
        isolatedPostgres._assert_connected_role(connection, isolatedPostgres.SETUP_ROLE)
        connection.execute(
            "select pg_advisory_xact_lock(hashtext('album-haven:local-inventory-publication'))"
        )
        files = connection.execute(
            f"""
            select file.id, file.private_path, track.album_id
            from library.local_track_files file
            join library.local_tracks track on track.id = file.track_id
            where {prefix_sql}
            for update of file
            """,
            prefix_parameters,
        ).fetchall()
        album_keys: list[str] = []
        if files:
            if any(row["album_id"] is None for row in files):
                raise RuntimeError(
                    "Watcher recovery inventory is unassigned; retained for diagnosis."
                )

            album_ids = sorted({row["album_id"] for row in files})
            outside = connection.execute(
                f"""
                select file.id
                from library.local_track_files file
                join library.local_tracks track on track.id = file.track_id
                where track.album_id = any(%s)
                  and not ({prefix_sql})
                limit 1
                """,
                (album_ids, *prefix_parameters),
            ).fetchone()
            if outside is not None:
                raise RuntimeError(
                    "Watcher recovery albums include inventory outside owned roots; retained."
                )

            album_keys = [
                row["album_key"]
                for row in connection.execute(
                    """
                    select album_key
                    from library.local_albums
                    where id = any(%s)
                    order by id
                    for update
                    """,
                    (album_ids,),
                ).fetchall()
            ]
            connection.execute(
                """
                update library.local_track_files
                set metadata = jsonb_set(metadata, '{scan_cache,stale}', 'true'::jsonb, true)
                where id = any(%s)
                """,
                ([row["id"] for row in files],),
            )
            for album_key in album_keys:
                result = connection.execute(
                    "select * from library.confirm_missing_album_removal(%s)",
                    (album_key,),
                ).fetchone()
                if not result or result["removed_album_count"] != 1:
                    raise RuntimeError(
                        "Watcher recovery fixture removal failed; transaction rolled back."
                    )

    _remove_owned_directories(owned_paths)
    return {"removed_albums": len(album_keys), "removed_files": len(files)}


def remove_watcher_recovery_fixture(manifest_path: Path) -> dict[str, int]:
    """Remove only manifest-proven recovery roots after the runner stopped all writers."""
    configured_temp_root = str(os.environ.get("ALBUM_HAVEN_E2E_TEMP_ROOT") or "").strip()
    if not configured_temp_root:
        raise ValueError("Watcher recovery cleanup requires the runner-owned temp root.")
    temp_root = Path(configured_temp_root).resolve(strict=True)
    expected_manifest = (temp_root / "app-data" / "watcher-recovery-fixture.json").resolve(
        strict=False
    )
    resolved_manifest = Path(manifest_path).resolve(strict=True)
    if resolved_manifest != expected_manifest:
        raise ValueError(
            "Watcher recovery manifest must be the exact runner-owned manifest."
        )
    payload = json.loads(resolved_manifest.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("Watcher recovery manifest must contain an object.")

    names = {
        "failure_root_path": "failure-root",
        "failure_root_staging_path": "failure-root-staging",
        "healthy_root_path": "healthy-root",
    }
    paths = {
        field: Path(str(payload.get(field) or "")).resolve(strict=False)
        for field in names
    }
    boundary = paths["failure_root_path"].parent
    if (
        boundary.parent != temp_root / "cases"
        or not boundary.name.startswith("watcher-recovery-")
        or any(
            path.parent != boundary or path.name != names[field]
            for field, path in paths.items()
        )
    ):
        raise ValueError("Watcher recovery roots escaped the exact runner-owned boundary.")
    path_values = tuple(paths.values())
    if any(
        left == right
        or left.is_relative_to(right)
        or right.is_relative_to(left)
        for index, left in enumerate(path_values)
        for right in path_values[index + 1 :]
    ):
        raise ValueError("Watcher recovery roots must be distinct and non-overlapping.")

    return _remove_watcher_recovery_inventory(
        (paths["failure_root_path"], paths["healthy_root_path"]),
        owned_paths=(
            paths["failure_root_path"],
            paths["failure_root_staging_path"],
            paths["healthy_root_path"],
        ),
    )


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

    parser = argparse.ArgumentParser()
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument("--owned-root", type=Path)
    target.add_argument("--recovery-manifest", type=Path)
    arguments = parser.parse_args()
    result = (
        remove_watcher_recovery_fixture(arguments.recovery_manifest)
        if arguments.recovery_manifest is not None
        else remove_watched_inventory(arguments.owned_root)
    )
    print(json.dumps(result))
