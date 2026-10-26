"""One paced, account-owned derived local-album continuation; no job scheduler."""
from copy import deepcopy
from datetime import datetime, timezone
import json

from music_app.services.playback_capture import CaptureError
from music_app.services.playback_capture_postgres import _selector, _budgets, _reserve, _final_authority
from music_app.services.playback_capture_history_revision import _read_history_revision
from music_app.services.private_library_authority import current_library_transaction
from music_app.services.playback_decoder_observation import _bounded_connection, decoder_observation_ready
from music_app.services.playback_edition_selection import selection_schema_ready
from music_app.services.playback_position_transport import require_position_storage
from music_app.services.local_album_full_fold import (
    PAGE_RUNS, MAX_STATE_BYTES, LocalFullCapacity, new_geometry, advance_geometry, geometry_lower_bound)
from music_app.services.album_listening_metrics import LOCAL_FULL_POLICY
from music_app.services.local_album_track_metrics import (DETAIL_POLICY, compatible as details_compatible,
    new_details, anchor_details, advance_details, project_details)


def state_storage_ready(connection):
    present=connection.execute("select to_regclass('integration.playback_album_metrics_state') as relation").fetchone()
    if not present or present['relation'] is None:return False
    row=connection.execute("""select
      has_schema_privilege('integration','USAGE') and
      has_table_privilege(c.oid,'SELECT') and has_table_privilege(c.oid,'INSERT') and
      has_table_privilege(c.oid,'UPDATE') as allowed,
      not c.relrowsecurity and current_setting('session_replication_role')='origin' as ordinary,
      (select jsonb_object_agg(a.attname,format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull::text)
       from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped) as columns,
      not exists(select 1 from pg_constraint k where k.conrelid=c.oid and not k.convalidated) as validated,
      exists(select 1 from pg_constraint k where k.conrelid=c.oid and k.contype='p' and k.conkey=array[
        (select attnum from pg_attribute where attrelid=c.oid and attname='account_id'),
        (select attnum from pg_attribute where attrelid=c.oid and attname='original_library_id'),
        (select attnum from pg_attribute where attrelid=c.oid and attname='original_album_id')]::smallint[]) as identity,
      array(select a.attname||':'||n.nspname||'.'||target.relname||':'||ref.attname||':'||k.confdeltype::text
        from pg_constraint k join pg_attribute a on a.attrelid=c.oid and k.conkey=array[a.attnum]::smallint[]
        join pg_class target on target.oid=k.confrelid join pg_namespace n on n.oid=target.relnamespace
        join pg_attribute ref on ref.attrelid=target.oid and k.confkey=array[ref.attnum]::smallint[]
        where k.conrelid=c.oid and k.contype='f' order by a.attname) as foreign_keys,
      array(select t.tgname||':'||t.tgtype::text||':'||p.proname from pg_trigger t
        join pg_proc p on p.oid=t.tgfoid join pg_namespace n on n.oid=p.pronamespace
        where t.tgrelid=c.oid and not t.tgisinternal and t.tgenabled in ('O','A')
          and t.tgqual is null and t.tgnargs=0 and t.tgattr=''::int2vector
          and p.pronargs=0 and p.prorettype='trigger'::regtype and not p.prosecdef
          and n.nspname='integration' and has_function_privilege(p.oid,'EXECUTE') order by t.tgname) as triggers
      from pg_class c where c.oid='integration.playback_album_metrics_state'::regclass and c.relkind='r'""").fetchone()
    expected={key:'bigint:true' for key in ('account_id','original_library_id','original_album_id','state_revision','reservation_bytes')}
    expected.update(state='jsonb:true',updated_at='timestamp with time zone:true',account_budget_id='bigint:false')
    return bool(row and row['allowed'] and row['ordinary'] and row['validated'] and row['identity']
        and row['columns']==expected and row['foreign_keys']==[
            'account_budget_id:integration.playback_capture_budget:id:n','account_id:app.accounts:id:c']
        and row['triggers']==['playback_album_metrics_state_guard:23:playback_album_metrics_state_guard',
            'playback_album_metrics_state_release:9:playback_capture_release_charge'])


def _require_full_indexes(connection):
    rows=connection.execute("""select c.relname,i.indnkeyatts,i.indisvalid,i.indisready,i.indisunique,
      i.indexprs is null as plain,i.indpred is null as whole,am.amname,
      array(select coalesce(a.attname,'') from unnest(i.indkey) with ordinality k(attnum,ord)
        left join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.attnum
        where k.ord<=i.indnkeyatts order by k.ord) as keys
      from pg_index i join pg_class c on c.oid=i.indrelid join pg_namespace n on n.oid=c.relnamespace
      join pg_class ix on ix.oid=i.indexrelid join pg_am am on am.oid=ix.relam
      where n.nspname='integration' and c.relname=any(%s)""",
      (['playback_capture_owner','playback_capture_run'],)).fetchall()
    owner=any(r['relname']=='playback_capture_owner' and r['plain'] and r['whole']
        and r['indisvalid'] and r['indisready'] and r['amname']=='btree'
        and r['indnkeyatts']==3 and r['keys']==['account_id','library_id','id'] for r in rows)
    # Existing v2 run index is partial owner_id IS NOT NULL; actual query always
    # supplies one non-null owned ID. Core position readiness validates its shape.
    run=any(r['relname']=='playback_capture_run' and r['plain'] and r['indisunique']
        and r['indisvalid'] and r['indisready'] and r['amname']=='btree'
        and r['indnkeyatts']==2 and r['keys']==['owner_id','ordinal_start'] for r in rows)
    if not owner or not run:raise CaptureError('capture_unavailable',503)


def _version_list(versions):
    return [[*key,value] for key,value in sorted(versions.items())]


def _compatible(state, selected, versions, history, extents, *, best_only=False):
    if (state.get('policy')!=LOCAL_FULL_POLICY or state.get('membership')!=selected.membership_revision
        or state.get('invalidation')!=history['invalidation_revision']):return False
    # Added files/EOF facts are monotonic. Removed/changed versions or a formerly
    # trusted denominator becoming ambiguous invalidate the derived lower bound.
    if any(versions.get(tuple(row[:3]))!=row[3] for row in state.get('best_versions' if best_only else 'versions',[])):return False
    return all(extents.get((row[0],row[1]))==row[2] for row in state.get('best_extents' if best_only else 'extents',[]))


FRESH_PLAY_POLICY = 'server-admitted-rendered-track-over-ten-seconds-v1'
FRESH_FRAME_THRESHOLD = 480000
MAX_FRESH_STREAMS = 128


def _fresh_compatible(state, versions):
    return all(versions.get(tuple(row[:3])) == row[3]
               for row in state.get('fresh_versions', []))


def _new_pass(selected,versions,history,extents,prior=None):
    membership=json.loads(selected.canonical_membership)
    full_supported=membership['order_status']=='supported'
    ids=[int(m['track_id']) for m in membership['members']]
    previous_details=prior.get('completed_details') if prior else None
    if not details_compatible(previous_details,versions,extents):previous_details=None
    return dict(details_policy=DETAIL_POLICY,details=new_details(ids,previous_details),completed_details=previous_details,
        details_pruned=False,policy=LOCAL_FULL_POLICY,membership=selected.membership_revision,
        invalidation=history['invalidation_revision'],proof=history['proof_revision'],append=history['append_revision'],
        cutoff=history['raw_checkpoint_cut'],versions=_version_list(versions),
        extents=[[file,version,extent] for (file,version),extent in sorted(extents.items())],
        phase='anchors' if full_supported else 'fresh',full_supported=full_supported,owner=0,ordinal=-1,anchors={},geometry=None,
        best_full=prior['best_full'] if prior else 0,
        best_uninterrupted=prior['best_uninterrupted'] if prior else 0,
        completed_cutoff=prior.get('completed_cutoff') if prior else None,
        best_versions=prior.get('best_versions',[]) if prior else [],best_extents=prior.get('best_extents',[]) if prior else [],
        track_ids=ids,blocked=None,ever_pruned=prior.get('ever_pruned',False) if prior else False,
        fresh_policy=FRESH_PLAY_POLICY,fresh_streams={},fresh_pruned=False,
        fresh_after=prior.get('fresh_after') if prior and _fresh_compatible(prior,versions) else None,
        fresh_versions=prior.get('fresh_versions',[]) if prior and _fresh_compatible(prior,versions) else [])


def _facts(connection,live,versions):
    if not versions:return {}
    wanted=sorted({(key[1],version) for key,version in versions.items()})
    rows=connection.execute('''select wanted.file_id,wanted.version,lo.extent_frames48 as lo,hi.extent_frames48 as hi
      from jsonb_to_recordset(%s::jsonb) as wanted(file_id bigint,version text)
      left join lateral(select extent_frames48 from integration.playback_decoder_observation
        where account_id=%s and original_library_id=%s and original_file_id=wanted.file_id
          and inventory_source_revision=wanted.version and coordinate_basis in ('decoded-output-zero','decoded-output-absolute-wav48') and extent_frames48 is not null
        order by extent_frames48 limit 1) lo on true
      left join lateral(select extent_frames48 from integration.playback_decoder_observation
        where account_id=%s and original_library_id=%s and original_file_id=wanted.file_id
          and inventory_source_revision=wanted.version and coordinate_basis in ('decoded-output-zero','decoded-output-absolute-wav48') and extent_frames48 is not null
        order by extent_frames48 desc limit 1) hi on true''',
      (json.dumps([dict(file_id=f,version=v) for f,v in wanted]),live.actor.account_id,live.library_id,
       live.actor.account_id,live.library_id)).fetchall()
    return {(r['file_id'],r['version']):r['lo'] for r in rows if r['lo'] is not None and r['lo']==r['hi']}


# These joins are the same actual capture/observation lineage as the visible S2
# reader, with original owner and loss evidence retained for continuity folding.
_RUN_SELECT='''select r.id,r.owner_id,r.binding_serial,r.generation,r.stream_id,r.epoch,r.continuity_serial,
 r.ordinal_start,r.output_start,r.source_base48,r.source_start48,r.frames,p.id as parent_id,
 p.original_track_id as track_id,o.original_file_id as observed_file,o.original_root_id as observed_root,
 o.coordinate_basis as observed_coordinate_basis,o.inventory_source_revision as observed_version,o.observation_ref as observed_ref,o.observed_at as observed_opened_at,
 s.membership_revision as selected_revision,
 exists(select 1 from integration.playback_capture_loss loss
   join integration.playback_capture_checkpoint lcp on lcp.id=loss.checkpoint_id
   where loss.owner_id=r.owner_id and lcp.id<=%s and not lcp.evidence_redacted
     and (int8range(loss.ordinal_start,loss.ordinal_end,'[)') && int8range(r.ordinal_start,r.ordinal_start+r.frames,'[)')
       or int8range(loss.output_start,loss.output_end,'[)') && int8range(r.output_start,r.output_start+r.frames,'[)'))) as has_loss
 from integration.playback_capture_session p
 join integration.playback_capture_checkpoint cp on cp.session_id=p.id
 join integration.playback_capture_run r on r.checkpoint_id=cp.id
 join integration.playback_capture_owner owner on owner.id=r.owner_id and owner.id=p.owner_id
   and owner.account_id=p.account_id and owner.library_id=p.library_id and owner.auth_session_guard=p.auth_session_guard
 left join integration.playback_decoder_observation o on o.account_id=p.account_id
   and o.observation_ref::text=(cp.evidence->'runs'->r.run_index->>'source_observation_ref')
   and o.auth_session_guard=p.auth_session_guard and o.original_library_id=p.library_id
   and o.original_track_id=p.original_track_id and o.original_file_id=p.original_file_id
   and o.original_root_id=p.original_root_id and o.generation=r.generation and o.stream_id=r.stream_id
   and o.source_base48=r.source_base48
 left join integration.playback_edition_capture ec on ec.account_id=p.account_id
   and ec.original_capture_session_id=p.id and ec.live_capture_session_id=p.id and ec.original_track_id=p.original_track_id
 left join integration.playback_edition_selection s on s.account_id=ec.account_id
   and s.selection_ref=ec.selection_ref and s.original_library_id=p.library_id and s.original_album_id=p.original_album_id
 where p.account_id=%s and p.library_id=%s and p.original_album_id=%s
   and p.original_track_id=any(%s) and p.evidence_version='app-rendered-position-v2'
   and not cp.evidence_redacted and cp.id<=%s '''


def _runs(connection,live,selected,state):
    params=[state['cutoff'],live.actor.account_id,live.library_id,selected.album_id,state['track_ids'],state['cutoff']]
    rows=connection.execute(_RUN_SELECT+' and r.owner_id=%s and r.ordinal_start>%s order by r.ordinal_start limit 257',
        (*params,state['owner'],state['ordinal'])).fetchall()
    versions={tuple(row[:3]):row[3] for row in state['versions']}
    extents={(row[0],row[1]):row[2] for row in state['extents']}
    for run in rows:
        version=versions.get((run['track_id'],run['observed_file'],run['observed_root']))
        run['source_version']=version if version is not None and version==run['observed_version'] else None
        run['source_extent_frames48']=extents.get((run['observed_file'],version)) if run['source_version'] is not None else None
        supported=(run['source_version'] is not None and run['selected_revision']==state['membership']
            and run['observed_coordinate_basis'] in ('decoded-output-zero','decoded-output-absolute-wav48'))
        run['local_version']=version if supported else None
        run['extent_frames48']=extents.get((run['observed_file'],version)) if supported else None
    return rows


def _next_owner(connection,live,selected,state):
    row=connection.execute('''select o.id from integration.playback_capture_owner o
      where o.account_id=%s and o.library_id=%s and o.id>%s and exists(
        select 1 from integration.playback_capture_session p join integration.playback_capture_checkpoint cp on cp.session_id=p.id
        where p.owner_id=o.id and p.account_id=o.account_id and p.library_id=o.library_id
          and p.original_album_id=%s and p.evidence_version='app-rendered-position-v2'
          and cp.id<=%s and not cp.evidence_redacted)
      order by o.id limit 1''',(live.actor.account_id,live.library_id,state['owner'],selected.album_id,state['cutoff'])).fetchone()
    return row['id'] if row else None


def _preserve_best(state, counts):
    if counts['full']<=state['best_full'] and counts['uninterrupted_full']<=state['best_uninterrupted']:return
    # Only versions actually supporting completed traversals/allocated overlap
    # geometry are dependencies of an already supported count. Unused duplicate
    # files cannot erase that lower bound merely by changing or disappearing.
    needed=set(counts['support_versions'])
    prior_versions={tuple(v) for v in state['best_versions']}
    prior_extents={tuple(v) for v in state['best_extents']}
    state['best_versions']=[list(v) for v in sorted(prior_versions|{tuple(v) for v in state['versions'] if v[3] in needed})]
    state['best_extents']=[list(v) for v in sorted(prior_extents|{tuple(v) for v in state['extents'] if v[1] in needed})]
    state['best_full']=max(state['best_full'],counts['full'])
    state['best_uninterrupted']=max(state['best_uninterrupted'],counts['uninterrupted_full'])


def _advance_fresh(state, runs):
    """Positive-only ordinary track qualification from actual rendered evidence.

    Count rendered frames, not elapsed/arrival/client time. One server-admitted
    stream must exceed ten seconds; its open lower bound applies to every counted
    frame. Split streams are conservatively not combined. No Full/EOF condition.
    The bounded pending map may prune unsupported leftovers, never raw evidence.
    """
    streams = state['fresh_streams']
    versions = {tuple(row[:3]):row[3] for row in state['versions']}
    for run in runs:
        opened = run.get('observed_opened_at')
        if (run.get('source_version') is None or run.get('has_loss') is not False
            or type(run.get('frames')) is not int or run['frames'] <= 0
            or run.get('observed_ref') is None
            or not isinstance(opened,datetime) or opened.tzinfo is None):
            continue
        # Timestamp is server admission before decoder open, not an assertion
        # that every sample was played at that instant.
        lower = opened.astimezone(timezone.utc).isoformat(timespec='microseconds')
        key = str(run['parent_id']) + ':' + str(run['observed_ref'])
        if key not in streams:
            if len(streams) >= MAX_FRESH_STREAMS:
                streams.pop(next(iter(streams)))
                state['fresh_pruned'] = True
            streams[key] = 0
        streams[key] = min(FRESH_FRAME_THRESHOLD + 1, streams[key] + run['frames'])
        if streams[key] > FRESH_FRAME_THRESHOLD and (state['fresh_after'] is None or lower > state['fresh_after']):
            identity = (run['track_id'],run['observed_file'],run['observed_root'])
            if versions.get(identity) == run['source_version']:
                state['fresh_after'] = lower
                state['fresh_versions'] = [[*identity,run['source_version']]]


def _complete_details(state):
    if state['details'] is not None:
        state['details']['cutoff']=None if state['cutoff'] is None else str(state['cutoff'])
        state['completed_details']=deepcopy(state['details'])


def _bound_optional_details(state):
    """Optional detail retention can never block the existing Full page.

    Raw evidence and Full geometry/counts stay untouched. A finite detail pass
    that exhausts this budget becomes explicitly unavailable, not a successful
    prefix. Future bounded rebuilds may retry; no self-restarting loop.
    """
    keys=('details','completed_details')
    base={key:value for key,value in state.items() if key not in keys}
    budget=max(0,min(512*1024,MAX_STATE_BYTES-len(json.dumps(base).encode())-256))
    def size():return len(json.dumps({key:state.get(key) for key in keys}).encode())
    if size()>budget:
        state['details']=None;state['details_pruned']=True
    if size()>budget:
        state['completed_details']=None;state['details_pruned']=True


def _advance(connection,live,selected,original):
    state=deepcopy(original)
    if state['phase']=='complete':return state
    if state['phase']=='allocate':
        counts=geometry_lower_bound(state['geometry'])
        _preserve_best(state,counts)
        if state['details'] is not None:
            state['details']['partial_stretches']=counts['partial_stretches']
            state['details']['partial_incomplete']=True  # Finite cut, never exact lifetime leftovers.
        _complete_details(state)
        state['phase']='complete';state['completed_cutoff']=state['cutoff']
        return state
    if state['owner']==0:
        following=_next_owner(connection,live,selected,state)
        if following is None:
            _complete_details(state)
            state['phase']='complete';state['completed_cutoff']=state['cutoff'];return state
        state['owner']=following;state['ordinal']=-1
    if state['phase']=='anchors':
        rows=_runs(connection,live,selected,state)
        if state['details'] is not None:anchor_details(state['details'],rows[:PAGE_RUNS])
        for run in rows[:PAGE_RUNS]:
            key=str(run['track_id']);old=state['anchors'].get(key)
            if run['local_version'] is not None and (old is None or run['id']<old['run_id']):
                state['anchors'][key]=dict(run_id=run['id'],version=run['local_version'],extent_frames48=run['extent_frames48'])
        if rows:state['ordinal']=rows[min(PAGE_RUNS,len(rows))-1]['ordinal_start']
        if len(rows)<=PAGE_RUNS:
            following=_next_owner(connection,live,selected,state)
            if following is None:
                state['phase']='fold';state['geometry']=new_geometry(state['track_ids'],state['anchors'])
                state['owner']=0;state['ordinal']=-1
            else:state['owner']=following;state['ordinal']=-1
        return state
    rows=_runs(connection,live,selected,state)
    _advance_fresh(state, rows[:PAGE_RUNS])
    if state['details'] is not None:
        if state['phase']=='fresh':anchor_details(state['details'],rows[:PAGE_RUNS])
        advance_details(state['details'],rows[:PAGE_RUNS])
    if state['phase']=='fresh':
        if rows:state['ordinal']=rows[min(PAGE_RUNS,len(rows))-1]['ordinal_start']
        if len(rows)<=PAGE_RUNS:
            following=_next_owner(connection,live,selected,state)
            if following is None:
                _complete_details(state)
                state['phase']='complete';state['completed_cutoff']=state['cutoff']
            else:state['owner']=following;state['ordinal']=-1
        return state
    state['geometry']=advance_geometry(state['geometry'],rows[:PAGE_RUNS],owner_finished=len(rows)<=PAGE_RUNS)
    state['ever_pruned']=state['ever_pruned'] or state['geometry']['pruned_segments']>0
    if rows:state['ordinal']=rows[min(PAGE_RUNS,len(rows))-1]['ordinal_start']
    if len(rows)<=PAGE_RUNS:
        _preserve_best(state,dict(full=state['geometry']['uninterrupted'],
            uninterrupted_full=state['geometry']['uninterrupted'],support_versions=state['geometry']['completed_versions']))
        following=_next_owner(connection,live,selected,state)
        if following is None:
            state['phase']='allocate'
        else:state['owner']=following;state['ordinal']=-1
    return state


def _projection(row,state,history,*,pending_facts=False,target=None):
    pending=pending_facts or state.get('details_policy') != DETAIL_POLICY or state.get('fresh_policy') != FRESH_PLAY_POLICY or state['phase']!='complete' or state['append']!=history['append_revision'] or state['proof']!=history['proof_revision']
    return dict(available=True,policy_version=LOCAL_FULL_POLICY,state_revision=str(row['state_revision']),
        recorded_details=project_details(state.get('completed_details'),target) if state.get('full_supported',True) else None,
        recorded_details_reason='derived_detail_capacity' if state.get('details_pruned') else None,
        full=state['best_full'] if state.get('full_supported',True) else None,
        uninterrupted_full=state['best_uninterrupted'] if state.get('full_supported',True) else None,
        listened=True if state['best_full']>0 else 'unknown',partial=None,
        status='not_started' if not state.get('full_supported',True) else 'blocked' if state['blocked'] else ('processing' if pending else ('lower_bound_at_cutoff' if state['ever_pruned'] else 'complete_at_cutoff')),
        derived_pruned=state['ever_pruned'],
        continuation=pending and not state['blocked'],reason=state['blocked'] if state.get('full_supported',True) else 'membership_order_unavailable',
        cutoff_checkpoint_id=None if state['cutoff'] is None else str(state['cutoff']),
        completed_cutoff_checkpoint_id=None if state['completed_cutoff'] is None else str(state['completed_cutoff']),
        history_complete=False,basis='healthy-local-inventory-version-v1',
        fresh_play=dict(policy=FRESH_PLAY_POLICY,server_open_lower_bound=state.get('fresh_after'),
            status='supported' if state.get('fresh_after') else 'unknown',
            incomplete=True,pruned=state.get('fresh_pruned',False)))


def read_full_state(connection,live,selected,versions,history,*,extents=None,allow_fresh_only=False,target=None):
    if not allow_fresh_only and json.loads(selected.canonical_membership)['order_status']!='supported':
        return dict(available=False,reason='membership_order_unavailable')
    if not state_storage_ready(connection) or not decoder_observation_ready(connection) or not selection_schema_ready(connection):return dict(available=False,reason='storage_unavailable')
    row=connection.execute('''select state_revision,state from integration.playback_album_metrics_state
        where account_id=%s and original_library_id=%s and original_album_id=%s''',
        (live.actor.account_id,live.library_id,selected.album_id)).fetchone()
    if row is None:return dict(available=True,state_revision='0',status='not_started',continuation=True)
    if extents is None:extents=_facts(connection,live,versions)
    if not _compatible(row['state'],selected,versions,history,extents,best_only=True):
        return dict(available=True,state_revision=str(row['state_revision']),status='recalculating',continuation=True)
    projected_state=deepcopy(row['state'])
    if not details_compatible(projected_state.get('completed_details'),versions,extents):
        projected_state['completed_details']=None
    if not _fresh_compatible(projected_state,versions):
        projected_state['fresh_after']=None
    return _projection(row,projected_state,history,target=target,pending_facts=_version_list(versions)!=row['state']['versions']
        or [[f,v,e] for (f,v),e in sorted(extents.items())]!=row['state']['extents'])


def advance_local_album_full(database_url,context,album_key,expected_revision,*,constraints=None,connect=None,clock=None,enabled=lambda:False):
    from music_app.services.local_album_listening import _edition,_versions,_require_local_metrics_indexes
    if (type(album_key) is not str or not album_key or len(album_key.encode())>1024
        or type(expected_revision) is not int or not 0<=expected_revision<2**53-1):raise CaptureError('invalid_album_key',422)
    if enabled() is not True:raise CaptureError('capture_unavailable',503)
    clock=clock or (lambda:datetime.now(timezone.utc))
    with current_library_transaction(database_url,context,constraints=constraints,connect=connect or _bounded_connection,
            clock=clock,inventory_publication_first=True) as (connection,live,now):
        return advance_local_album_full_on_connection(connection,live,now,album_key,expected_revision,
            constraints=constraints,clock=clock,enabled=enabled)


def advance_local_album_full_on_connection(connection,live,now,album_key,expected_revision,*,constraints,clock,enabled,top_freshness=False,target=None):
    """The same bounded advance under an already authorized owning transaction.

    The caller must own inventory-publication/account/session/Top locks. No new
    connection, nested commit, actor selection or independent policy is created.
    """
    from music_app.services.local_album_listening import _edition,_versions,_require_local_metrics_indexes
    if enabled() is not True:raise CaptureError('capture_unavailable',503)
    _selector(connection,live);require_position_storage(connection);_require_local_metrics_indexes(connection)
    if not state_storage_ready(connection) or not decoder_observation_ready(connection) or not selection_schema_ready(connection):
        raise CaptureError('capture_unavailable',503)
    _require_full_indexes(connection)
    if top_freshness:
        from music_app.services.album_top_fresh_scope import current_top_listening_scope
        scope_reader=current_top_listening_scope
    else:scope_reader=_edition
    selected,members=scope_reader(connection,live,album_key,constraints)
    if not top_freshness and json.loads(selected.canonical_membership)['order_status']!='supported':
        raise CaptureError('capture_unavailable',503)
    versions=_versions(connection,live,selected,members)
    account,global_budget=_budgets(connection,live.actor.account_id,now)
    history=_read_history_revision(connection,live.actor.account_id)
    extents=_facts(connection,live,versions)
    row=connection.execute('''select * from integration.playback_album_metrics_state
        where account_id=%s and original_library_id=%s and original_album_id=%s for update''',
        (live.actor.account_id,live.library_id,selected.album_id)).fetchone()
    revision=row['state_revision'] if row else 0
    compatible=row is not None and _compatible(row['state'],selected,versions,history,extents)
    prior=row['state'] if row and _compatible(row['state'],selected,versions,history,extents,best_only=True) else None
    state=row['state'] if compatible and row['state'].get('fresh_policy') == FRESH_PLAY_POLICY and row['state'].get('details_policy') == DETAIL_POLICY else _new_pass(selected,versions,history,extents,prior=prior)
    if revision==expected_revision and (row is None or (now-row['updated_at']).total_seconds()>=1):
        if state['phase']=='complete' and (state['append']!=history['append_revision'] or state['proof']!=history['proof_revision']
            or state['versions']!=_version_list(versions) or state['extents']!=[[f,v,e] for (f,v),e in sorted(extents.items())]):
            state=_new_pass(selected,versions,history,extents,prior=state)
        try:
            state['blocked']=None
            advanced=_advance(connection,live,selected,state)
            _bound_optional_details(advanced)
            if len(json.dumps(advanced).encode())>MAX_STATE_BYTES:raise LocalFullCapacity('state_capacity')
            state=advanced
        except LocalFullCapacity as error:
            state['blocked']=str(error)
        encoded=json.dumps(state)
        charge=max(row['reservation_bytes'] if row else 0,1024+len(encoded.encode()))
        _reserve(connection,account,global_budget,charge-(row['reservation_bytes'] if row else 0))
        if row:
            row=connection.execute('''update integration.playback_album_metrics_state set state=%s::jsonb,
                state_revision=state_revision+1,updated_at=%s,reservation_bytes=%s
                where account_id=%s and original_library_id=%s and original_album_id=%s returning *''',
                (encoded,now,charge,live.actor.account_id,live.library_id,selected.album_id)).fetchone()
        else:
            row=connection.execute('''insert into integration.playback_album_metrics_state
                (account_id,original_library_id,original_album_id,state_revision,state,updated_at,reservation_bytes,account_budget_id)
                values(%s,%s,%s,1,%s::jsonb,%s,%s,%s) returning *''',
                (live.actor.account_id,live.library_id,selected.album_id,encoded,now,charge,account['id'])).fetchone()
    final,final_members=scope_reader(connection,live,album_key,constraints)
    if final!=selected or _versions(connection,live,final,final_members)!=versions:raise CaptureError('capture_scope_changed',409)
    _final_authority(connection,live,constraints,clock)
    if enabled() is not True:raise CaptureError('capture_unavailable',503)
    # A stale retry does not mutate or count the same page a second time.
    result=_projection(row or {'state_revision':0},state,history,target=target,pending_facts=state['versions']!=_version_list(versions)
        or state['extents']!=[[f,v,e] for (f,v),e in sorted(extents.items())])
    if not compatible and prior is None and revision!=expected_revision:
        result=dict(available=True,state_revision=str(revision),status='recalculating',continuation=True)
    return dict(ok=True,version='local-album-full-progress-v1',album_key=album_key,
        account_id=str(live.actor.account_id),library_id=str(live.library_id),
        membership_revision=selected.membership_revision,full_progress=result)
