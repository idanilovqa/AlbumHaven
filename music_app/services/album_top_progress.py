"""Private manual completion inside the existing authorized Top transaction."""
from datetime import timezone

from music_app.services.owned_album_tops import AlbumTopError


def require_member(connection, context, top, album_ref):
    member = connection.execute("""select catalog_ref from app.album_list_items
        where top_ref=%s and library_id=%s and catalog_ref=%s for share""",
        (top["ref"], context.library_id, album_ref)).fetchone()
    if member is None:
        raise AlbumTopError("album_unavailable", 409)


def read_overlay(connection, context, top):
    rows = connection.execute("""select i.catalog_ref,p.revision,p.manual_completed_at
        from app.album_list_items i left join app.album_list_item_progress p
          on p.account_id=%s and p.library_id=i.library_id
          and p.top_ref=i.top_ref and p.catalog_ref=i.catalog_ref
        where i.top_ref=%s and i.library_id=%s order by i.curator_position""",
        (context.actor.account_id, top["ref"], context.library_id)).fetchall()
    return {"item_progress": {str(row["catalog_ref"]): {
        "progress_revision": str(row["revision"] or 0),
        "manual_completed_at": row["manual_completed_at"].astimezone(timezone.utc).isoformat()
            if row["manual_completed_at"] else None,
    } for row in rows}}


def set_manual_completion(connection, context, command, top, now):
    """Set an explicit self-only value without changing listening or Top state."""
    album_ref = command.data["album_ref"]
    require_member(connection, context, top, album_ref)
    key = (context.actor.account_id, context.library_id, top["ref"], album_ref)
    row = connection.execute("""select revision,manual_completed_at from app.album_list_item_progress
        where account_id=%s and library_id=%s and top_ref=%s and catalog_ref=%s for update""", key).fetchone()
    revision = row["revision"] if row else 0
    completed_at = row["manual_completed_at"] if row else None
    if str(revision) != command.data["progress_revision"]:
        raise AlbumTopError("progress_revision_conflict", 409)
    changed = (completed_at is not None) != command.data["completed"]
    if changed:
        if revision == 9223372036854775807:
            raise AlbumTopError("progress_revision_exhausted", 409)
        revision += 1
        completed_at = now if command.data["completed"] else None
        if row is None:
            connection.execute("""insert into app.album_list_item_progress
                (account_id,library_id,top_ref,catalog_ref,revision,manual_completed_at)
                values(%s,%s,%s,%s,%s,%s)""", (*key, revision, completed_at))
        else:
            connection.execute("""update app.album_list_item_progress set revision=%s,manual_completed_at=%s
                where account_id=%s and library_id=%s and top_ref=%s and catalog_ref=%s""",
                (revision, completed_at, *key))
    return {"top_ref": str(top["ref"]), "album_ref": album_ref,
            "action": command.action, "request_key": command.request_key,
            "progress_revision": str(revision),
            "manual_completed_at": completed_at.astimezone(timezone.utc).isoformat() if completed_at else None,
            "changed": changed}
