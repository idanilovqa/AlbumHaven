"""Bounded comparison materialization inside the activity receipt transaction."""
from datetime import datetime, timezone
import hashlib
import hmac

from music_app.services.allowed_actions import AllowedActions
from music_app.services.home_activity import HomeActivityError, _display

_HISTORY = "library.social.history.read"
_TASTE = "library.social.taste.read"


def _zero_side():
    return {"listen_count": 0, "last_listened_at": None, "rating": None,
            "favorite": None, "taste_state": "unavailable", "play_count": None, "full_listen_count": None}


def _resources(connection, scope, kind, ids):
    if kind == "tracks":
        rows = connection.execute("""select t.id,a.id as album_id,ar.id as artist_id,aa.id as album_artist_id
            from library.local_tracks t
            left join library.local_albums a on a.id=t.album_id and a.library_id=t.library_id
            left join library.local_artists ar on ar.id=t.artist_id and ar.library_id=t.library_id
            left join library.local_artists aa on aa.id=a.artist_id and aa.library_id=t.library_id
            where t.library_id=%s and t.id=any(%s)""", (scope.library_id, ids)).fetchall()
        result = {}
        for row in rows:
            values = [("track", row["id"])]
            values.extend((name, row[field]) for name, field in
                (("album", "album_id"), ("artist", "artist_id"), ("artist", "album_artist_id")) if row[field] is not None)
            result[row["id"]] = sorted(set(values))
        return result
    rows = connection.execute("""select a.id,ar.id as artist_id from library.local_albums a
        left join library.local_artists ar on ar.id=a.artist_id and ar.library_id=a.library_id
        where a.library_id=%s and a.id=any(%s)""", (scope.library_id, ids)).fetchall()
    return {row["id"]: [("album", row["id"])] + ([("artist", row["artist_id"])] if row["artist_id"] else []) for row in rows}


def _readable(project, resources, *, subject_id=None):
    if not resources:
        return False
    if subject_id is not None:
        account_actions = project.policy("account", str(subject_id))
        if (not isinstance(account_actions, AllowedActions)
                or not account_actions.allows(_HISTORY) or not account_actions.allows(_TASTE)):
            return False
    for kind, reference in resources:
        actions = project.policy(kind, reference)
        if not isinstance(actions, AllowedActions):
            raise HomeActivityError("Activity policy is unavailable.", 503, "activity_unavailable")
        if not actions.allows(_HISTORY) or not actions.allows(_TASTE):
            return False
        if subject_id is not None and kind == "album" and not actions.allows("library.browse.read"):
            return False
    return True


def _provenance(resources, *, subject_id=None):
    result = [[kind, reference, action] for kind, reference in resources for action in (_HISTORY, _TASTE)]
    if subject_id is not None:
        result.extend([["account", subject_id, action] for action in (_HISTORY, _TASTE)])
        result.extend([[kind, reference, "library.browse.read"]
                       for kind, reference in resources if kind == "album"])
    return result


def finalize_comparison(connection, *, snapshot_id, scope, query, project, secret, window):
    """Merge separately qualified sides, then freeze the existing taste owner."""
    from psycopg.types.json import Jsonb
    from music_app.services.friends_postgres import load_friend_taste, read_friend_taste_page

    # Only canonical IDs join. Event keys remain disjoint even when names match.
    connection.execute("""with grouped as (
        select split_part(row_key,'/',2) as canonical_key,
          max(latest_at) as latest_at,
          (array_agg(latest_event_id order by latest_at desc,latest_event_id desc))[1] as latest_event_id,
          sum(listen_count) as listen_count,
          (array_agg(payload order by latest_at desc,latest_event_id desc))[1] as display,
          jsonb_object_agg(split_part(row_key,'/',1),jsonb_build_object(
            'listen_count',listen_count,'last_listened_at',latest_at,
            'rating',null,'favorite',null,'taste_state','unavailable','play_count',null,'full_listen_count',null)) as sides
        from app.activity_snapshot_rows where snapshot_id=%s group by split_part(row_key,'/',2)
      ) insert into app.activity_snapshot_rows(
          snapshot_id,row_key,latest_at,latest_event_id,listen_count,source_labels,payload)
      select %s,canonical_key,latest_at,latest_event_id,listen_count,array[]::text[],
          (display-'listen_count'-'last_listened_at'-'source_label') || jsonb_build_object(
            'yours',coalesce(sides->'yours',case when canonical_key not like '%%:event:%%' then %s::jsonb else 'null'::jsonb end),
            'friend',coalesce(sides->'friend',case when canonical_key not like '%%:event:%%' then %s::jsonb else 'null'::jsonb end))
      from grouped""", (snapshot_id, snapshot_id, Jsonb(_zero_side()), Jsonb(_zero_side())))
    connection.execute("delete from app.activity_snapshot_rows where snapshot_id=%s and position('/' in row_key)>0", (snapshot_id,))
    if query.kind == "artists":
        return  # There is no durable artist rating/favorite source.

    shared = {"account_id": scope.account_id, "library_id": scope.library_id,
              "target_account_id": scope.source_account_id, "kind": query.kind}
    singular = {"tracks": "track", "albums": "album"}[query.kind]
    subject_id = scope.source_account_id if query.kind == "albums" else None

    def resource_allowed(identity):
        # The candidate page must use this before its internal taste loader.
        resources = _resources(connection, scope, query.kind, [identity])
        return _readable(project, resources.get(identity, []), subject_id=subject_id)

    after = 0
    while True:
        page = read_friend_taste_page(connection, **shared, after=after, limit=100,
            resource_allowed=resource_allowed)
        resources = _resources(connection, scope, query.kind, [row["resource_id"] for row in page["rows"]])
        for row in page["rows"]:
            identity = row["resource_id"]
            permitted = resources.get(identity, [])
            if not _readable(project, permitted, subject_id=subject_id):
                continue
            key = f"{singular}:{identity}"
            payload = {"id": "activity_" + hmac.new(secret, key.encode(), hashlib.sha256).hexdigest(),
                "kind": singular, "title": _display(row.get("title")), "artist": _display(row.get("artist_name")),
                "album_title": _display(row.get("album_title")), "source_readable": True,
                "artwork_url": None, "detail_ref": None, "allowed_actions": {"can_view_details": False},
                "yours": _zero_side(), "friend": _zero_side()}
            connection.execute("""insert into app.activity_snapshot_rows(
                snapshot_id,row_key,latest_at,latest_event_id,listen_count,source_labels,payload,resource_ids)
                values(%s,%s,%s,0,0,array[]::text[],%s,%s) on conflict(snapshot_id,row_key) do nothing""",
                (snapshot_id, key, window.start or datetime.min.replace(tzinfo=timezone.utc),
                 Jsonb(payload), Jsonb(_provenance(permitted, subject_id=subject_id))))
        if page["next_after"] is None:
            break
        after = page["next_after"]

    # Read only exact canonical IDs. Unresolved occurrences retain null tastes.
    after_key = ""
    while True:
        rows = connection.execute("""select row_key,payload from app.activity_snapshot_rows
            where snapshot_id=%s and row_key>%s and row_key ~ '^(track|album):[1-9][0-9]*$'
            order by row_key limit 500""", (snapshot_id, after_key)).fetchall()
        if not rows:
            break
        ids = [int(row["row_key"].split(":")[1]) for row in rows]
        resources = _resources(connection, scope, query.kind, ids)
        admitted = [identity for identity in ids
                    if _readable(project, resources.get(identity, []), subject_id=subject_id)]
        tastes = load_friend_taste(connection, **shared, resource_ids=admitted)["items"] if admitted else {}
        # Source acquisition may wait. Repeat constraints on the same identities
        # before retaining any personal data; final receipt checks run again.
        resources = _resources(connection, scope, query.kind, ids)
        for row, identity in zip(rows, ids):
            facts, permitted = tastes.get(identity), resources.get(identity, [])
            if facts is None or not _readable(project, permitted, subject_id=subject_id):
                continue
            payload = dict(row["payload"])
            for side, prefix in (("yours", "own"), ("friend", "friend")):
                values = dict(payload[side])
                available = facts.get(prefix + "_taste_state") == "available"
                values["rating"] = facts.get(prefix + "_rating") if available else None
                values["taste_state"] = "available" if available else "unavailable"
                tier = facts.get(prefix + "_love_tier")
                favorite = (tier in {"loved", "obsessed"} if tier in {"off", "loved", "obsessed"}
                            else facts.get(prefix + "_favorite"))
                values["favorite"] = favorite if available and type(favorite) is bool else None
                payload[side] = values
            connection.execute("""update app.activity_snapshot_rows set payload=%s,resource_ids=%s
                where snapshot_id=%s and row_key=%s""", (Jsonb(payload), Jsonb(_provenance(permitted, subject_id=subject_id)), snapshot_id, row["row_key"]))
        after_key = rows[-1]["row_key"]
