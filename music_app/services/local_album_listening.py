"""On-demand own-account local edition metrics; no catalog authority or jobs."""
from datetime import datetime,timezone
import json
from music_app.services.playback_capture import CaptureError
from music_app.services.private_library_authority import current_library_transaction
from music_app.services.playback_capture_postgres import _selector,_final_authority
from music_app.services.playback_edition_selection import prepare_edition_selection,selection_schema_ready
from music_app.services.playback_decoder_observation import decoder_observation_ready,_inventory_revision,_bounded_connection
from music_app.services.playback_position_transport import require_position_storage
from music_app.services.album_listening_metrics import compute_local_edition_recorded_metrics


def _require_local_metrics_indexes(connection):
    rows=connection.execute("""select c.relname as table_name,i.indnkeyatts,i.indisvalid,i.indisready,
        i.indexprs is null as plain,am.amname,pg_get_expr(i.indpred,i.indrelid) as predicate,
        array(select coalesce(a.attname,'') from unnest(i.indkey) with ordinality k(attnum,ord)
          left join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum
          where k.ord<=i.indnkeyatts order by k.ord) as keys
        from pg_index i join pg_class c on c.oid=i.indrelid
        join pg_namespace n on n.oid=c.relnamespace join pg_class ix on ix.oid=i.indexrelid
        join pg_am am on am.oid=ix.relam
        where n.nspname='integration' and c.relname=any(%s)""",
        (['playback_decoder_observation','playback_capture_session'],)).fetchall()
    expected={
      'playback_decoder_observation':(['account_id','original_library_id','original_file_id','inventory_source_revision','coordinate_basis','extent_frames48'],'extent_frames48 IS NOT NULL'),
      'playback_capture_session':(['account_id','library_id','original_album_id','id'],None)}
    found=set()
    for row in rows:
        keys,predicate=expected[row['table_name']]
        actual=row['predicate'];actual=actual.strip('() ') if type(actual) is str else actual
        if (row['indisvalid'] and row['indisready'] and row['plain'] and row['amname']=='btree'
                and row['indnkeyatts']==len(keys) and row['keys']==keys and actual==predicate):
            found.add(row['table_name'])
    if found!=set(expected):raise CaptureError('capture_unavailable',503)


def _edition(connection,live,key,constraints):
    albums=connection.execute('''select id,album_key from library.local_albums
        where library_id=%s and album_key=%s order by id limit 2 for share''',(live.library_id,key)).fetchall()
    if len(albums)!=1:raise CaptureError('source_unavailable',404)
    rows=connection.execute('''select id,album_id,track_key,disc_number,track_number from library.local_tracks
        where library_id=%s and album_id=%s order by id limit 513 for share''',(live.library_id,albums[0]['id'])).fetchall()
    selected=prepare_edition_selection(live,albums[0],rows,constraints=constraints)
    if selected is None:raise CaptureError('capture_unavailable',503)
    return selected,rows


def _versions(connection,live,selected,rows):
    files=connection.execute('''select f.id as file_id,f.track_id,f.library_root_id as root_id,f.private_path,
        f.file_size_bytes,f.modified_at,f.content_signature,r.root_path,r.metadata->>'root_id' as root_identity,
        f.metadata#>>'{scan_cache,stale_marked_at}' as stale_marked_at,
        coalesce(health.metadata->'library_watch_health','{}'::jsonb) ?
          coalesce(nullif(r.metadata->>'root_id',''),f.metadata->>'library_root_id','') as unhealthy
        from library.local_track_files f join library.library_roots r on r.id=f.library_root_id
        join library.libraries health on health.id=r.library_id
        where f.track_id=any(%s) and r.library_id=%s and r.is_active and not f.scan_cache_stale
        order by f.id limit 1025 for share of f,r,health''',(list(selected.track_ids),live.library_id)).fetchall()
    if len(files)>1024:return {}
    tracks={row['id']:row for row in rows};versions={}
    for row in files:
        track=tracks[row['track_id']]
        source=dict(track_id=row['track_id'],file_id=row['file_id'],root_id=row['root_id'],
            album_id=selected.album_id,disc_number=track['disc_number'],track_number=track['track_number'])
        try:version=_inventory_revision(source,row,row['private_path'])
        except CaptureError:continue
        versions[(row['track_id'],row['file_id'],row['root_id'])]=version
    return versions


def read_local_album_metrics(database_url,context,album_key,*,constraints=None,connect=None,clock=None):
    if type(album_key) is not str or not album_key or len(album_key.encode('utf-8'))>1024:
        raise CaptureError('invalid_album_key',422)
    clock=clock or (lambda:datetime.now(timezone.utc))
    with current_library_transaction(database_url,context,constraints=constraints,connect=connect or _bounded_connection,
            clock=clock,read_only=True,inventory_publication_first=True) as (connection,live,now):
        _selector(connection,live);require_position_storage(connection)
        _require_local_metrics_indexes(connection)
        from music_app.services.playback_capture_history_revision import _read_history_revision
        history=_read_history_revision(connection,live.actor.account_id)
        selected,members=_edition(connection,live,album_key,constraints)
        versions=_versions(connection,live,selected,members)
        observation_ready=decoder_observation_ready(connection)
        selection_ready=selection_schema_ready(connection)
        # Only this account/current album, not a global listening-history scan.
        # The immutable checkpoint/run identity makes duplicate imports irrelevant.
        joins='';fields='null as observed_version,null as observed_file,null as observed_root,null as selected_revision,null as observed_coordinate_basis'
        if observation_ready and selection_ready:
            fields='o.inventory_source_revision as observed_version,o.original_file_id as observed_file,o.original_root_id as observed_root,s.membership_revision as selected_revision,o.coordinate_basis as observed_coordinate_basis'
            joins='''left join integration.playback_decoder_observation o on o.account_id=p.account_id
              and o.observation_ref::text=(cp.evidence->'runs'->r.run_index->>'source_observation_ref')
              and o.auth_session_guard=p.auth_session_guard and o.original_library_id=p.library_id
              and o.original_track_id=p.original_track_id and o.original_file_id=p.original_file_id
              and o.original_root_id=p.original_root_id and o.generation=r.generation and o.stream_id=r.stream_id
              and o.source_base48=r.source_base48
            left join integration.playback_edition_capture ec on ec.account_id=p.account_id
              and ec.original_capture_session_id=p.id and ec.live_capture_session_id=p.id
              and ec.original_track_id=p.original_track_id
            left join integration.playback_edition_selection s on s.account_id=ec.account_id
              and s.selection_ref=ec.selection_ref and s.original_library_id=p.library_id
              and s.original_album_id=p.original_album_id'''
        runs=connection.execute('''select r.id,r.frames,r.source_start48,p.original_track_id as track_id,
            cp.id as checkpoint_id,'''+fields+''' from integration.playback_capture_session p
            join integration.playback_capture_checkpoint cp on cp.session_id=p.id
            join integration.playback_capture_run r on r.checkpoint_id=cp.id '''+joins+'''
            where p.account_id=%s and p.library_id=%s and p.original_album_id=%s
              and p.original_track_id=any(%s) and p.evidence_version='app-rendered-position-v2'
              and not cp.evidence_redacted and cp.id<=%s order by r.id desc limit 4097''',
            (live.actor.account_id,live.library_id,selected.album_id,list(selected.track_ids),history['raw_checkpoint_cut'])).fetchall()
        truncated=len(runs)>4096;runs=runs[:4096]
        extents={}
        if observation_ready and versions:
            # Indexed min/max seeks establish consistency without scanning every
            # duplicate observation of a popular track. Missing EOF stays unknown.
            wanted=sorted({(key[1],version) for key,version in versions.items()})
            donors=connection.execute('''select wanted.file_id,wanted.version,lo.extent_frames48 as lo,hi.extent_frames48 as hi
                from jsonb_to_recordset(%s::jsonb) as wanted(file_id bigint,version text)
                left join lateral (select extent_frames48 from integration.playback_decoder_observation
                  where account_id=%s and original_library_id=%s and original_file_id=wanted.file_id
                    and inventory_source_revision=wanted.version and coordinate_basis in ('decoded-output-zero','decoded-output-absolute-wav48')
                    and extent_frames48 is not null
                  order by extent_frames48 limit 1) lo on true
                left join lateral (select extent_frames48 from integration.playback_decoder_observation
                  where account_id=%s and original_library_id=%s and original_file_id=wanted.file_id
                    and inventory_source_revision=wanted.version and coordinate_basis in ('decoded-output-zero','decoded-output-absolute-wav48')
                    and extent_frames48 is not null
                  order by extent_frames48 desc limit 1) hi on true''',
                (json.dumps([dict(file_id=f,version=v) for f,v in wanted]),live.actor.account_id,live.library_id,
                 live.actor.account_id,live.library_id)).fetchall()
            for row in donors:
                if row['lo'] is not None and row['lo']==row['hi']:extents[(row['file_id'],row['version'])]=row['lo']
        projected=[]
        for run in runs:
            key=(run['track_id'],run['observed_file'],run['observed_root']);version=versions.get(key)
            supported=(run['observed_coordinate_basis'] in ('decoded-output-zero','decoded-output-absolute-wav48')
                and version is not None and version==run['observed_version']
                and run['selected_revision']==selected.membership_revision)
            projected.append(dict(track_id=run['track_id'],frames=run['frames'],source_start48=run['source_start48'],
                local_version=version if supported else None,
                extent_frames48=extents.get((run['observed_file'],version)) if supported else None))
        ordered=json.loads(selected.canonical_membership)['members']
        result=compute_local_edition_recorded_metrics([dict(track_id=int(m['track_id'])) for m in ordered],projected)
        from music_app.services.local_album_full_state import read_full_state
        full_progress=read_full_state(connection,live,selected,versions,history,extents=extents)
        final,final_members=_edition(connection,live,album_key,constraints)
        if final!=selected or _versions(connection,live,final,final_members)!=versions:
            raise CaptureError('capture_scope_changed',409)
        _final_authority(connection,live,constraints,clock)
        return dict(ok=True,version='local-album-recorded-metrics-v1',album_key=album_key,
            album_id=str(selected.album_id),library_id=str(live.library_id),account_id=str(live.actor.account_id),
            membership_revision=selected.membership_revision,proof_revision=str(history['proof_revision']),
            append_revision=str(history['append_revision']),invalidation_revision=str(history['invalidation_revision']),
            cutoff_checkpoint_id=None if history['raw_checkpoint_cut'] is None else str(history['raw_checkpoint_cut']),cutoff_run_id=str(runs[0]['id']) if runs else None,
            read_at=now.isoformat(),window_truncated=truncated,history_complete=False,
            compatibility_policy='healthy-local-inventory-version-v1',metrics=result,full_progress=full_progress)
