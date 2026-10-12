"""Fresh confirmed-missing Playlist snapshots for the unsaved Inspect page."""
import json
from uuid import UUID, uuid4, uuid5

from music_app.services.admin_member_mutation_postgres import lock_current_actor_session
from music_app.services.owned_playlists import BROWSE, CREATE, MAX_PLAYLIST_ITEMS_PER_COMMAND, PlaylistError, uuid_ref, playlist_revision
from music_app.services.policy import ResourceScope
from music_app.services import playlist_creation_sources_postgres as sources

MISSING_PROTOCOL="missing_playlist_selection_v1"


def _playlist(owner,connection,context,ref,revision,constraints):
    playlist=owner._playlist(connection,context,ref)
    owner._require(context,(BROWSE,),constraints,playlist)
    if str(playlist["revision"])!=revision:raise PlaylistError("source_changed",409)
    return playlist


def _missing_rows(owner,connection,context,playlist,*,constraints,item_refs=None,current=None):
    query="select * from app.playlist_items where playlist_ref=%s"
    params=[str(playlist["ref"])]
    if item_refs is not None:
        query+=" and ref=any(%s::uuid[])";params.append(item_refs)
    query+=" order by position"
    rows=connection.execute(query,tuple(params)).fetchall()
    if current is None:current=sources.inventory_rows(connection,context.library_id,
        [row["local_track_id"] for row in rows if row["local_track_id"] is not None
         and owner._resource_allowed(context,BROWSE,ResourceScope("track",str(row["local_track_id"])),constraints)],
        lock=True,config=owner._config)
    result=[]
    for item in rows:
        if item["local_track_id"] is None or not owner._resource_allowed(
                context,BROWSE,ResourceScope("track",str(item["local_track_id"])),constraints):continue
        inventory=current.get(item["local_track_id"])
        if inventory is None or inventory["availability"]!="missing":continue
        album=item["original_album_id"] if item["original_album_id"]==inventory["original_album_id"] else None
        row={key:item.get(key) for key in ("title","artist","album_title","release_year","disc_number","track_number","duration_seconds")}
        row.update(original_local_track_id=item["local_track_id"],original_album_id=album,
            inventory_evidence=inventory["inventory_evidence"],availability="missing",
            source_row_ref=str(item["ref"]),source_label=playlist["title"],
            source_lineage={"playlist_ref":str(playlist["ref"]),"playlist_item_ref":str(item["ref"]),
                            "playlist_revision":str(playlist["revision"])})
        row=sources._plain(row)
        row["evidence_digest"]=sources.entry_evidence(row)
        result.append(row)
    return result


def inspect(owner,context,playlist_ref,revision,*,constraints=None):
    from psycopg.types.json import Jsonb
    from music_app.services.playlist_complete_sources import _header
    playlist_ref,revision=uuid_ref(playlist_ref),playlist_revision(revision)
    with owner._authorized(context,constraints) as (connection,live,now):
        owner._require(live,(BROWSE,CREATE),constraints)
        playlist=_playlist(owner,connection,live,playlist_ref,revision,constraints)
        rows=_missing_rows(owner,connection,live,playlist,constraints=constraints)
        if not rows:raise PlaylistError("no_confirmed_missing_tracks",409)
        if len(rows)>MAX_PLAYLIST_ITEMS_PER_COMMAND:raise PlaylistError("source_too_large",413)
        now=lock_current_actor_session(connection,actor_account_id=live.actor.account_id,
            actor_session_id=live.actor.session_id,clock=owner._clock)
        origin={"playlist_ref":playlist_ref,"playlist_revision":revision}
        source=_header(connection,live,now,protocol=MISSING_PROTOCOL,kind="playlist",origin=origin)
        values=[]
        for row in rows:
            values.append({key:row.get(key) for key in (*sources._FACT_FIELDS,"original_local_track_id",
                "source_row_ref","source_lineage","source_label","evidence_digest")})
            values[-1].update(ref=str(uuid4()),source_ref=source["ref"],
                selection_ref=str(uuid5(UUID(source["ref"]),row["source_row_ref"])))
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
        connection.execute("update app.playlist_creation_sources set origin_descriptor=%s where ref=%s",
            (Jsonb({**origin,"entry_order":[row["ref"] for row in values]}),source["ref"]))
        return _envelope(owner,live,source,values,playlist,constraints)


def _envelope(owner,context,source,rows,playlist,constraints):
    entries=[]
    for row in rows:
        entry=sources.project_entry(source,row,album_readable=lambda album_id:owner._resource_allowed(
            context,BROWSE,ResourceScope("album",str(album_id)),constraints))
        if row.get('validated_match_track_id') is not None:
            entry.update(inventory_track_ref=f"inventory-track:{context.library_id}:{row['validated_match_track_id']}",
                availability='local',match_state='accepted')
        entries.append(entry)
    parents={}
    for entry in entries:
        parent=entry['parent_album']
        if parent['album_ref'] is not None and parent['allowed_actions']['can_read']:
            parent['completeness']='incomplete'
            retained=parents.setdefault(parent['album_ref'],{**parent,'entry_refs':[]})
            retained['entry_refs'].append(entry['entry_ref'])
    origin=source['origin_descriptor']
    return {'status':'ready','data':{**sources.source_envelope(source),'mode':'missing',
        'source':{'kind':'playlist','ref':origin['playlist_ref'],'revision':origin['playlist_revision']},
        'capture_ref':str(source['ref']),'entries_complete':True,'entries':entries,
        'retained_parent_albums':list(parents.values()),
        'title':playlist['title']+' · Missing tracks','actor_scope':owner._scope(context)}}


def read_capture(owner,context,playlist_ref,revision,capture_ref,*,constraints=None):
    playlist_ref,revision,capture_ref=uuid_ref(playlist_ref),playlist_revision(revision),uuid_ref(capture_ref)
    with owner._authorized(context,constraints) as (connection,live,now):
        owner._require(live,(BROWSE,CREATE),constraints)
        source=connection.execute("""select * from app.playlist_creation_sources
            where ref=%s and actor_account_id=%s and session_id=%s and library_id=%s
              and protocol='missing_playlist_selection_v1' and source_kind='playlist' for share""",
            (capture_ref,live.actor.account_id,live.actor.session_id,live.library_id)).fetchone()
        if source is None:raise PlaylistError('source_unavailable',404)
        source=dict(source)
        origin=source['origin_descriptor'] or {}
        if origin.get('playlist_ref')!=playlist_ref or origin.get('playlist_revision')!=revision:
            raise PlaylistError('source_changed',409)
        if source['expires_at']<=now:raise PlaylistError('source_expired',410)
        refs=origin.get('entry_order')
        if not isinstance(refs,list) or not 1<=len(refs)<=MAX_PLAYLIST_ITEMS_PER_COMMAND:
            raise PlaylistError('source_changed',409)
        refs=[uuid_ref(ref) for ref in refs]
        if len(set(refs))!=len(refs):raise PlaylistError('source_changed',409)
        # Revalidate the retained snapshot and explicit choices, never allocate
        # replacement entry IDs or mutate the user's authored selection.
        rows=selected(owner,connection,live,source,refs,constraints=constraints)
        playlist=_playlist(owner,connection,live,playlist_ref,revision,constraints)
        now=lock_current_actor_session(connection,actor_account_id=live.actor.account_id,
            actor_session_id=live.actor.session_id,clock=owner._clock)
        if source['expires_at']<=now:raise PlaylistError('source_expired',410)
        return _envelope(owner,live,source,rows,playlist,constraints)


def source_for_command(connection,context,command,now):
    refs=command.data["entry_refs"]
    if not refs:raise PlaylistError("no_confirmed_missing_tracks",409)
    return load_source(connection,context,command.data["source"],refs[0],now)


def load_source(connection,context,supplied,entry_ref,now):
    source=connection.execute("""select s.* from app.playlist_creation_sources s
        join app.playlist_creation_entries e on e.source_ref=s.ref
        where e.ref=%s and s.actor_account_id=%s and s.session_id=%s and s.library_id=%s
          and s.protocol='missing_playlist_selection_v1' and s.source_kind='playlist'
        for share of s""",(entry_ref,context.actor.account_id,context.actor.session_id,context.library_id)).fetchone()
    if source is None:raise PlaylistError("source_unavailable",404)
    origin=source["origin_descriptor"]
    if origin.get("playlist_ref")!=supplied["ref"] or origin.get("playlist_revision")!=supplied["revision"]:
        raise PlaylistError("source_changed",409)
    if source["expires_at"]<=now:raise PlaylistError("source_expired",410)
    return dict(source)


def validated_selection(owner,connection,context,source,entry_refs,*,constraints,extra_track_ids=(),write_receipts=False):
    origin=source["origin_descriptor"]
    playlist=_playlist(owner,connection,context,origin["playlist_ref"],origin["playlist_revision"],constraints)
    rows=connection.execute("select * from app.playlist_creation_entries where source_ref=%s and ref=any(%s::uuid[])",
        (source["ref"],entry_refs)).fetchall()
    stored={str(row["ref"]):sources._plain(row) for row in rows}
    if set(stored)!=set(entry_refs):raise PlaylistError("source_unavailable",409)
    ordered=[stored[ref] for ref in entry_refs]
    # Lock private choices before all inventory IDs in one global numeric order.
    # Original A -> chosen B must not deadlock with original B -> chosen A.
    receipts=connection.execute(f"""select * from app.playlist_local_match_receipts
        where source_ref=%s and entry_ref=any(%s::uuid[]) order by entry_ref
        for {'update' if write_receipts else 'share'}""",(source['ref'],entry_refs)).fetchall()
    track_ids={row.get('original_local_track_id') for row in ordered}
    track_ids.update(row['chosen_track_id'] for row in receipts)
    track_ids.update(extra_track_ids)
    allowed=[identity for identity in track_ids if identity is not None and owner._resource_allowed(
        context,BROWSE,ResourceScope('track',str(identity)),constraints)]
    current=sources.inventory_rows(connection,context.library_id,allowed,lock=True,config=owner._config)
    fresh=_missing_rows(owner,connection,context,playlist,constraints=constraints,
        item_refs=[row["source_row_ref"] for row in ordered],current=current)
    by_item={row["source_row_ref"]:row for row in fresh}
    if any(row["source_row_ref"] not in by_item or row["evidence_digest"]!=by_item[row["source_row_ref"]]["evidence_digest"]
           or row["source_lineage"]!=by_item[row["source_row_ref"]]["source_lineage"] for row in ordered):
        raise PlaylistError("source_changed",409)
    return ordered,current,{str(row['entry_ref']):dict(row) for row in receipts}


def selected(owner,connection,context,source,entry_refs,*,constraints):
    from music_app.services.playlist_local_matches import apply_choices
    ordered,current,receipts=validated_selection(owner,connection,context,source,entry_refs,constraints=constraints)
    return apply_choices(owner,connection,context,ordered,current,receipts,constraints=constraints)
