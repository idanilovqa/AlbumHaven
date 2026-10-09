"""Receipt-authorized Home/Friend track selections for private Playlist creation."""
from dataclasses import replace
import json
from uuid import UUID, uuid4, uuid5

from music_app.services.allowed_actions import AllowedActions
from music_app.services.owned_playlists import (
    BROWSE, COMPLETE_ACTIVITY_PROTOCOL, MAX_PLAYLIST_ITEMS_PER_COMMAND,
    PlaylistError, evidence_digest, uuid_ref,
)
from music_app.services.policy import ResourceScope
from music_app.services.policy_evaluator import PolicyEvaluationConstraints, PolicyEvaluator
from music_app.services import playlist_creation_sources_postgres as sources


def normalize_activity_origin(value):
    if not isinstance(value,dict) or set(value)!={"audience","subject_ref","kind","period","snapshot_ref"}:
        raise PlaylistError("invalid_command")
    if (not isinstance(value["audience"],str) or value["audience"] not in {"own","friend"}
            or not isinstance(value["kind"],str) or value["kind"] not in {"tracks","listens"}):
        raise PlaylistError("invalid_command")
    if value["audience"]=="own":
        if value["subject_ref"] is not None:raise PlaylistError("invalid_command")
    else:
        uuid_ref(value["subject_ref"])
    from music_app.services.home_activity import ActivityQuery, HomeActivityError
    try:
        query=ActivityQuery(kind=value["kind"],period=value["period"],snapshot_ref=value["snapshot_ref"])
    except HomeActivityError:
        raise PlaylistError("invalid_command") from None
    if query.snapshot_ref is None:raise PlaylistError("invalid_command")
    return {key:value[key] for key in ("audience","subject_ref","kind","period","snapshot_ref")}


def _export(connection,context,origin,row_refs,*,config,constraints):
    from music_app.services.home_activity import ActivityScope, ActivityQuery, HomeActivityError
    from music_app.services.home_activity_postgres import HomeActivityPostgresRepository
    subject=None
    if origin["audience"]=="friend":
        row=connection.execute("select account_id from app.social_profiles where account_ref=%s",
            (origin["subject_ref"],)).fetchone()
        if row is None:raise PlaylistError("source_unavailable",404)
        subject=row["account_id"]
    try:
        scope=ActivityScope(context.actor.account_id,context.actor.session_id,context.library_id,
            subject_account_id=subject,audience=origin["audience"])
        query=ActivityQuery(kind=origin["kind"],period=origin["period"],snapshot_ref=origin["snapshot_ref"])
        def allowed(kind,identity):
            target=replace(context,action=scope.read_action,resource=ResourceScope(kind,str(identity)),
                target_account_id=scope.source_account_id)
            effective=constraints(target) if callable(constraints) else constraints
            if effective is not None and not isinstance(effective,PolicyEvaluationConstraints):
                raise RuntimeError("Playlist source policy constraints are invalid.")
            decision=PolicyEvaluator().evaluate(target,constraints=effective).decision.allowed
            return AllowedActions((scope.read_action,) if decision else ())
        allowed.scope_wide=not callable(constraints)
        return HomeActivityPostgresRepository(config).read_selection(connection,scope=scope,query=query,
            row_refs=row_refs,allowed_actions_for_resource=allowed)
    except HomeActivityError as error:
        raise PlaylistError("source_expired" if error.status_code==410 else "source_unavailable",
            410 if error.status_code==410 else 403 if error.status_code==403 else 409) from None


def _rows(connection,context,exported,*,config,constraints):
    ids=[entry["canonical_resource"]["id"] for entry in exported
         if entry["canonical_resource"] is not None and entry["canonical_resource"]["kind"]=="track"]
    if len(set(ids))!=len(ids):raise PlaylistError("duplicate_identity",409)
    for identity in ids:
        target=replace(context,action=BROWSE,resource=ResourceScope("track",str(identity)))
        effective=constraints(target) if callable(constraints) else constraints
        if effective is not None and not isinstance(effective,PolicyEvaluationConstraints):
            raise RuntimeError("Playlist source policy constraints are invalid.")
        if not PolicyEvaluator().evaluate(target,constraints=effective).decision.allowed:
            raise PlaylistError("source_unavailable",403)
    current=sources.inventory_rows(connection,context.library_id,ids,lock=True,config=config)
    if set(current)!=set(ids):raise PlaylistError("source_changed",409)
    result=[]
    for entry in exported:
        identity=entry["canonical_resource"]
        if identity is not None and identity["kind"]!="track":raise PlaylistError("source_unavailable",409)
        track_id=identity["id"] if identity is not None else None
        inventory=current.get(track_id,{})
        facts=entry["facts"]
        row={"original_local_track_id":track_id,"title":facts.get("title"),"artist":facts.get("artist"),
            "album_title":facts.get("album_title"),"duration_seconds":facts.get("duration_seconds"),
            "original_album_id":inventory.get("original_album_id"),"release_year":inventory.get("release_year"),
            "disc_number":inventory.get("disc_number"),"track_number":inventory.get("track_number"),
            "inventory_evidence":inventory.get("inventory_evidence"),
            # History without a current inventory match is unresolved. An absent
            # file or title-only record is not authoritative missing evidence.
            "availability":inventory.get("availability","unresolved"),
            "source_row_ref":entry["row_ref"],"source_lineage":entry["lineage"],
            "source_label":facts.get("source_label")}
        row["evidence_digest"]=sources.entry_evidence(row)
        result.append(row)
    return result


def capture(connection,context,source,origin,row_refs,*,config,constraints):
    exported=_export(connection,context,origin,row_refs,config=config,constraints=constraints)
    rows=_rows(connection,context,exported,config=config,constraints=constraints)
    values=[]
    for row in rows:
        values.append({key:row.get(key) for key in (*sources._FACT_FIELDS,"original_local_track_id",
            "source_row_ref","source_lineage","source_label","evidence_digest")})
        values[-1].update(ref=str(uuid4()),source_ref=str(source["ref"]),
            selection_ref=str(uuid5(UUID(str(source["ref"])),row["source_row_ref"])))
    connection.execute("""insert into app.playlist_creation_entries
      (ref,source_ref,selection_ref,original_local_track_id,evidence_digest,title,artist,album_title,
       original_album_id,release_year,disc_number,track_number,duration_seconds,availability,source_row_ref,source_lineage,source_label)
      select ref,source_ref,selection_ref,original_local_track_id,evidence_digest,title,artist,album_title,
       original_album_id,release_year,disc_number,track_number,duration_seconds,availability,source_row_ref,source_lineage,source_label
      from jsonb_to_recordset(%s::jsonb) as input(ref uuid,source_ref uuid,selection_ref uuid,
       original_local_track_id bigint,evidence_digest text,title text,artist text,album_title text,
       original_album_id bigint,release_year integer,disc_number integer,track_number integer,
       duration_seconds numeric,availability text,source_row_ref text,source_lineage jsonb,source_label text)""",
      (json.dumps(values,allow_nan=False),))
    return values


def selected(connection,context,source,entry_refs,*,config,constraints):
    requested=list(entry_refs)
    if not requested:
        order=(source.get("origin_descriptor") or {}).get("entry_order",[])
        if not order:raise PlaylistError("source_changed",409)
        entry_refs=order[:1]
    stored=connection.execute("select * from app.playlist_creation_entries where source_ref=%s and ref=any(%s::uuid[])",
        (source["ref"],entry_refs)).fetchall()
    by_ref={str(row["ref"]):sources._plain(row) for row in stored}
    if set(by_ref)!=set(entry_refs):raise PlaylistError("source_unavailable",409)
    ordered=[by_ref[ref] for ref in entry_refs]
    origin=(source.get("origin_descriptor") or {}).get("activity")
    if origin is None:raise PlaylistError("source_changed",409)
    origin=normalize_activity_origin(origin)
    row_refs=[row["source_row_ref"] for row in ordered]
    exported=_export(connection,context,origin,row_refs,config=config,constraints=constraints)
    current=_rows(connection,context,exported,config=config,constraints=constraints)
    if any(current_row["evidence_digest"]!=saved["evidence_digest"]
           or current_row["source_lineage"]!=saved["source_lineage"]
           for current_row,saved in zip(current,ordered)):
        raise PlaylistError("source_changed",409)
    return ordered if requested else []


def lock_target(owner,context,*,source_ref=None,origin=None,constraints=None):
    """Resolve only the account lock key before taking ordered authority locks.

    The scoped metadata read discloses nothing and never authorizes a source.
    Full current actor/session/source/relationship checks still happen inside the
    mutation transaction. It also does not reject an expired source before a
    committed same-key replay can be found.
    """
    owner._require(context,(BROWSE,),constraints)
    actor=context.actor
    with owner._connect(owner._url) as connection:
        if source_ref is not None:
            row=connection.execute('''select p.account_id from app.playlist_creation_sources s
                join app.account_sessions session on session.id=s.session_id and session.account_id=s.actor_account_id
                join app.accounts a on a.id=s.actor_account_id and a.is_active and a.disabled_at is null
                join library.library_memberships m on m.account_id=a.id and m.library_id=s.library_id
                join app.social_profiles p on p.account_ref::text=s.origin_descriptor#>>'{activity,subject_ref}'
                where s.ref=%s and s.actor_account_id=%s and s.session_id=%s and s.library_id=%s
                  and s.protocol='complete_activity_selection_v1'
                  and session.revoked_at is null and session.idle_expires_at>clock_timestamp()
                  and session.absolute_expires_at>clock_timestamp()''',
                (source_ref,actor.account_id,actor.session_id,context.library_id)).fetchone()
        elif origin is not None and origin['audience']=='friend':
            row=connection.execute('''select p.account_id from app.social_profiles p
                join library.library_memberships target on target.account_id=p.account_id and target.library_id=%s
                join app.account_sessions session on session.id=%s and session.account_id=%s
                join app.accounts a on a.id=session.account_id and a.is_active and a.disabled_at is null
                join library.library_memberships viewer on viewer.account_id=a.id and viewer.library_id=target.library_id
                where p.account_ref=%s and session.revoked_at is null
                  and session.idle_expires_at>clock_timestamp() and session.absolute_expires_at>clock_timestamp()''',
                (context.library_id,actor.session_id,actor.account_id,origin['subject_ref'])).fetchone()
        else:return None
    return row['account_id'] if row is not None else None
