"""Private activity persistence within the authorized Album Top transaction.

The caller holds the current account lock and an authorized parent Top lock.
There is no independent connection, actor selection, or publication state here.
"""
from music_app.services import album_top_activity as domain
from music_app.services.owned_album_tops import AlbumTopError


def read_activity(connection, context, refs):
    """Read one bounded page of private projections without materializing state."""
    if not refs:
        return {}
    rows = connection.execute("""select top_ref,active,activity_revision
        from app.album_list_activity where account_id=%s and library_id=%s
          and top_ref=any(%s::uuid[])""",
        (context.actor.account_id, context.library_id, refs)).fetchall()
    result = {str(ref): {"active": True, "activity_revision": "0"} for ref in refs}
    result.update({str(row["top_ref"]): {"active": row["active"],
        "activity_revision": str(row["activity_revision"])} for row in rows})
    return result


def _state(connection, context, top, now):
    key = (context.actor.account_id, context.library_id, top["ref"])
    row = connection.execute("""select active,activity_revision,started_at
        from app.album_list_activity where account_id=%s and library_id=%s
          and top_ref=%s for update""", key).fetchone()
    if row is None:
        state = domain.new_activity(now)
        connection.execute("""insert into app.album_list_activity
            (account_id,library_id,top_ref,activity_revision,active,started_at)
            values(%s,%s,%s,0,true,%s)""", (*key, now))
        connection.execute("""insert into app.album_list_activity_transitions
            (account_id,library_id,top_ref,revision,occurred_at)
            values(%s,%s,%s,0,%s)""", (*key, now))
        return state
    rows = connection.execute("""select revision,occurred_at
        from app.album_list_activity_transitions
        where account_id=%s and library_id=%s and top_ref=%s order by revision""", key).fetchall()
    if not rows or rows[0]["occurred_at"] != row["started_at"]:
        raise domain.ActivityError("Activity baseline must match its history")
    return domain.restore_activity({"active": row["active"],
        "revision": row["activity_revision"], "transitions": [dict(item) for item in rows]})


def require_active(connection, context, top, now):
    """Gate fresh manual progress; historical receipts bypass this mutation gate."""
    projection = read_activity(connection, context, [str(top["ref"])])[str(top["ref"])]
    if not projection["active"]:
        raise AlbumTopError("top_inactive", 409)
    # Establish a truthful baseline on the first write, never on ordinary reads.
    # The account lock makes both the absent-row check and this insert atomic.
    created = connection.execute("""insert into app.album_list_activity
        (account_id,library_id,top_ref,activity_revision,active,started_at)
        values(%s,%s,%s,0,true,%s) on conflict do nothing returning started_at""",
        (context.actor.account_id, context.library_id, top["ref"], now)).fetchone()
    if created is not None:
        connection.execute("""insert into app.album_list_activity_transitions
            (account_id,library_id,top_ref,revision,occurred_at)
            values(%s,%s,%s,0,%s)""",
            (context.actor.account_id, context.library_id, top["ref"], created["started_at"]))


def set_activity(connection, context, command, top, now):
    state = _state(connection, context, top, now)
    if str(state.revision) != command.data["activity_revision"]:
        raise AlbumTopError("activity_revision_conflict", 409)
    if state.active != command.data["active"] and state.revision == 9223372036854775807:
        raise AlbumTopError("activity_revision_exhausted", 409)
    updated = domain.set_activity(state, command.data["active"], now)
    changed = updated.revision != state.revision
    if changed:
        key = (context.actor.account_id, context.library_id, top["ref"])
        connection.execute("""insert into app.album_list_activity_transitions
            (account_id,library_id,top_ref,revision,occurred_at)
            values(%s,%s,%s,%s,%s)""", (*key, updated.revision, now))
        connection.execute("""update app.album_list_activity set activity_revision=%s,active=%s
            where account_id=%s and library_id=%s and top_ref=%s""",
            (updated.revision, updated.active, *key))
    return {"top_ref": str(top["ref"]), "action": command.action,
        "request_key": command.request_key, "activity_revision": str(updated.revision),
        "active": updated.active, "changed": changed}
