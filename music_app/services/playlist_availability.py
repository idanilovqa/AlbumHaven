"""Conservative missing evidence from scanner state and authorized root probes."""
from datetime import datetime
from pathlib import Path
import stat

from music_app.services.library_roots import resolve_configured_media_path


def files_confirmed_missing(records, *, config, authorized_root_paths, stat_path=None):
    """No file, offline root, denied stat, stale-only guess or external probe."""
    if not records or not authorized_root_paths:
        return False
    probe=stat_path or (lambda path:path.stat())
    for row in records:
        if (row.get("scan_cache_stale") is not True or row.get("root_active") is not True
                or not row.get("root_id") or row.get("root_unhealthy") is not False
                or not row.get("private_path") or not row.get("root_path")):
            return False
        try:
            marked=datetime.fromisoformat(str(row.get("stale_marked_at") or ""))
            if marked.tzinfo is None or marked.utcoffset() is None:
                return False
            # Both probes must be in configured roots before any filesystem stat.
            root=resolve_configured_media_path(config,row["root_path"],require_exists=False,require_file=False,
                configured_root_paths=authorized_root_paths)
            file=resolve_configured_media_path(config,row["private_path"],require_exists=False,require_file=False,
                configured_root_paths=authorized_root_paths)
            if root is None or file is None or file==root:
                return False
            file.relative_to(root)
            if not stat.S_ISDIR(probe(root).st_mode):
                return False
            try:
                probe(file)
            except FileNotFoundError:
                continue
            # Exists, including a directory/symlink replacing a file: unresolved.
            return False
        except (OSError,ValueError,TypeError):
            return False
    return True


def confirm_missing_availability(connection, library_id, rows, *, config):
    candidates=[identity for identity,row in rows.items() if row["availability"]=="unresolved"]
    if not candidates or not config:
        return rows
    records=_file_records(connection,library_id,candidates)
    groups={identity:[] for identity in candidates}
    for row in records:groups[row["track_id"]].append(row)
    authorized_roots=tuple(Path(row["root_path"]) for row in records
        if row.get("root_path") and row.get("root_active") is True and row.get("root_id")
        and row.get("root_unhealthy") is False)
    for identity,files in groups.items():
        if files_confirmed_missing(files,config=config,authorized_root_paths=authorized_roots):
            rows[identity]={**rows[identity],"availability":"missing"}
    return rows


def _file_records(connection,library_id,track_ids):
    return connection.execute("""select f.track_id,f.private_path,f.scan_cache_stale,
        f.metadata#>>'{scan_cache,stale_marked_at}' as stale_marked_at,
        r.root_path,r.is_active as root_active,
        coalesce(nullif(r.metadata->>'root_id',''),f.metadata->>'library_root_id') as root_id,
        coalesce(l.metadata->'library_watch_health','{}'::jsonb) ?
          coalesce(nullif(r.metadata->>'root_id',''),f.metadata->>'library_root_id') as root_unhealthy
        from library.local_tracks t join library.local_track_files f on f.track_id=t.id
        join library.libraries l on l.id=t.library_id
        left join library.library_roots r on r.id=f.library_root_id and r.library_id=t.library_id
        where t.library_id=%s and t.id=any(%s::bigint[]) order by t.id,f.id""",
        (library_id,track_ids)).fetchall()


def confirmed_local_evidence(connection, library_id, rows, *, config):
    """Prove real healthy, confined local files; return only private evidence hashes.

    Call after inventory_rows(lock=True). Metadata alone is never presence proof.
    Browse authorization is the caller's independent responsibility, not Media.
    """
    from music_app.services.owned_playlists import evidence_digest
    identities=[identity for identity,row in rows.items() if row['availability']=='local']
    if not identities:return {}
    records=_file_records(connection,library_id,identities)
    evidence={}
    for row in records:
        if (row.get('scan_cache_stale') is not False or row.get('root_active') is not True
                or not row.get('root_id') or row.get('root_unhealthy') is not False
                or not row.get('root_path') or not row.get('private_path')):
            continue
        try:
            roots=(Path(row['root_path']),)
            root=resolve_configured_media_path(config,row['root_path'],require_file=False,
                configured_root_paths=roots)
            file=resolve_configured_media_path(config,row['private_path'],configured_root_paths=roots)
            if root is None or file is None or root==file or not root.is_dir():continue
            file.relative_to(root)
            observed=file.stat()
            if not stat.S_ISREG(observed.st_mode):continue
            evidence.setdefault(row['track_id'],[]).append([
                str(file),observed.st_dev,observed.st_ino,observed.st_size,
                observed.st_mtime_ns,observed.st_ctime_ns])
        except (OSError,ValueError,TypeError):
            continue
    return {identity:evidence_digest(files) for identity,files in evidence.items()}
