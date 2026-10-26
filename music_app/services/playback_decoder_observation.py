"""Server admitted-open / EOF facts. Inventory association is NOT content identity.

No worker, queue, schema activation or playback grant is constructed here.
The actual socket's retained open/credit lifecycle calls these bounded methods.
"""
from dataclasses import dataclass
from datetime import datetime,timezone
import hashlib
from uuid import UUID

from music_app.services.playback_capture import CaptureError,canonical_json
from music_app.services.private_library_authority import current_library_transaction

OBSERVATION_BYTES=512
_MAX=2**53-1


def decoder_observation_ready(connection):
    row=connection.execute("select to_regclass('integration.playback_decoder_observation') as relation").fetchone()
    if not row or row['relation'] is None:return False
    row=connection.execute('''select
        has_schema_privilege('integration','USAGE') and
        has_table_privilege('integration.playback_decoder_observation','SELECT') and
        has_table_privilege('integration.playback_decoder_observation','INSERT') and
        has_column_privilege('integration.playback_decoder_observation','extent_frames48','UPDATE') as allowed,
        not c.relrowsecurity and current_setting('session_replication_role')='origin' as ordinary,
        (select jsonb_object_agg(a.attname,format_type(a.atttypid,a.atttypmod)||':'||a.attnotnull::text)
          from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped) as columns,
        array(select t.tgname||':'||t.tgtype::text||':'||p.proname from pg_trigger t
          join pg_proc p on p.oid=t.tgfoid join pg_namespace n on n.oid=p.pronamespace
          where t.tgrelid=c.oid and not t.tgisinternal and t.tgenabled in ('O','A')
          and t.tgqual is null and t.tgnargs=0 and t.tgattr=''::int2vector
          and p.pronargs=0 and p.prorettype='trigger'::regtype and not p.prosecdef
          and n.nspname='integration' and has_function_privilege(p.oid,'EXECUTE') order by t.tgname) as triggers,
        not exists(select 1 from pg_constraint k where k.conrelid=c.oid and not k.convalidated) as validated,
        exists(select 1 from pg_constraint k where k.conrelid=c.oid and k.contype='p'
          and k.conkey=array[(select attnum from pg_attribute where attrelid=c.oid and attname='account_id'),
            (select attnum from pg_attribute where attrelid=c.oid and attname='observation_ref')]::smallint[]) as identity,
        array(select a.attname||':'||n.nspname||'.'||target.relname||':'||ref.attname||':'||k.confdeltype::text
          from pg_constraint k join pg_attribute a on a.attrelid=c.oid and k.conkey=array[a.attnum]::smallint[]
          join pg_class target on target.oid=k.confrelid join pg_namespace n on n.oid=target.relnamespace
          join pg_attribute ref on ref.attrelid=target.oid and k.confkey=array[ref.attnum]::smallint[]
          where k.conrelid=c.oid and k.contype='f' order by a.attname) as foreign_keys
        from pg_class c where c.oid='integration.playback_decoder_observation'::regclass and c.relkind='r'
        ''').fetchone()
    columns={key:'bigint:true' for key in ('account_id','original_library_id','original_track_id',
        'original_file_id','original_root_id','generation','stream_id','source_base48','reservation_bytes','requested_start48')}
    columns.update(coordinate_basis='text:true',observation_ref='uuid:true',auth_session_guard='text:true',inventory_source_revision='text:true',
        observed_at='timestamp with time zone:true',account_budget_id='bigint:false',extent_frames48='bigint:false')
    return bool(row and row['allowed'] and row['ordinary'] and row['validated'] and row['identity']
        and row['columns']==columns and row['foreign_keys']==[
            'account_budget_id:integration.playback_capture_budget:id:n','account_id:app.accounts:id:c']
        and row['triggers']==['playback_decoder_observation_immutable:23:playback_decoder_observation_guard',
            'playback_decoder_observation_release:9:playback_capture_release_charge',
            'playback_decoder_observation_revision:11:playback_decoder_observation_invalidate'])


def absolute_wav_observation_ready(connection):
    """Explicit separately installed schema marker; never install it here."""
    row = connection.execute("""select exists(select 1 from pg_constraint c
        where c.conrelid=to_regclass('integration.playback_decoder_observation')
          and c.conname='playback_decoder_observation_absolute_wav48_v1'
          and c.contype='c' and c.convalidated
          and pg_get_constraintdef(c.oid) =
            'CHECK (((coordinate_basis <> ''decoded-output-absolute-wav48''::text) OR (requested_start48 > 0)))'
        ) as ready""").fetchone()
    return bool(row and row['ready'] is True)


@dataclass(frozen=True)
class DecoderAdmission:
    account_id:int
    session_id:int
    library_id:int
    track_id:int
    file_id:int
    root_id:int
    auth_session_guard:str
    inventory_source_revision:str
    path:str
    resolved_path:str


def _source_snapshot(connection,live,path,constraints):
    from music_app.services.playback_capture_postgres import _source
    source=_source(connection,live,path,constraints)
    row=connection.execute('''select f.file_size_bytes,f.modified_at,f.content_signature,r.root_path,
        r.metadata->>'root_id' as root_identity,f.metadata#>>'{scan_cache,stale_marked_at}' as stale_marked_at,
        coalesce(health.metadata->'library_watch_health','{}'::jsonb) ?
          coalesce(nullif(r.metadata->>'root_id',''),f.metadata->>'library_root_id','') as unhealthy
        from library.local_track_files f join library.library_roots r on r.id=f.library_root_id
        join library.libraries health on health.id=r.library_id
        where f.id=%s and f.track_id=%s for share of f,r,health''',
        (source['file_id'],source['track_id'])).fetchone()
    return source,_inventory_revision(source,row,path)


def _inventory_revision(source,row,path):
    """Healthy scanner-version policy, not a cryptographic content identity."""
    if not row or type(row['file_size_bytes']) is not int or row['file_size_bytes']<0 or row['modified_at'] is None or row['unhealthy'] is not False:
        raise CaptureError('capture_unavailable',503)
    for value,nullable,limit in ((path,False,8192),(row['root_path'],False,8192),
            (row['root_identity'],True,1024),(row['stale_marked_at'],True,256)):
        if value is None and nullable:continue
        if type(value) is not str or (not nullable and not value) or len(value.encode('utf-8'))>limit:
            raise CaptureError('capture_unavailable',503)
    if not isinstance(row['modified_at'],datetime):raise CaptureError('capture_unavailable',503)
    signature=row['content_signature']
    if signature is not None and (type(signature) is not str or len(signature)>1024):
        raise CaptureError('capture_unavailable',503)
    # A revision detects ordinary inventory association changes, never proves
    # that matching metadata means matching file content across decoder opens.
    revision=hashlib.sha256(canonical_json(dict(source=source,size=row['file_size_bytes'],
        modified=row['modified_at'].isoformat(),signature=signature,path=path,
        root_path=row['root_path'],root_identity=row['root_identity'],stale_marked_at=row['stale_marked_at'],
        policy='healthy-local-inventory-version-v1')).encode()).hexdigest()
    return revision


def _bounded_connection(database_url):
    # Reuse the actual default pool; do not construct a workload/pool per stream.
    from music_app.services.postgres_connections import pooled_connection
    return pooled_connection(database_url,timeout=0.25)


def prepare_decoder_admission(database_url,context,path,resolved_path,scope,*,constraints=None,connect=None,clock=None):
    from music_app.services.playback_capture_postgres import _selector,_final_authority
    clock=clock or (lambda:datetime.now(timezone.utc))
    with current_library_transaction(database_url,context,constraints=constraints,connect=connect or _bounded_connection,clock=clock,
            read_only=True,inventory_publication_first=True) as (connection,live,_now):
        _selector(connection,live)
        if not decoder_observation_ready(connection):return None
        source,revision=_source_snapshot(connection,live,path,constraints)
        _final_authority(connection,live,constraints,clock,source['track_id'])
        return DecoderAdmission(live.actor.account_id,live.actor.session_id,live.library_id,
            source['track_id'],source['file_id'],source['root_id'],scope,revision,path,str(resolved_path))


def record_decoder_open(database_url,context,admission,command,metadata,**kwargs):
    return _record_decoder_observation(database_url,context,admission,command,metadata,complete=False,**kwargs)


def record_decoder_eof(database_url,context,admission,command,metadata,**kwargs):
    return _record_decoder_observation(database_url,context,admission,command,metadata,complete=True,**kwargs)


def _record_decoder_observation(database_url,context,admission,command,metadata,*,complete,
        constraints=None,connect=None,clock=None,enabled=lambda:False):
    """Called only with actual decoder command/finish result, never HTTP data."""
    from music_app.services.playback_capture_postgres import _selector,_final_authority,_budgets,_reserve
    from music_app.services.playback_capture_history_revision import (
        _prepare_history_revision,_insert_reserved_history_revision,_advance_history_proof)
    if not isinstance(admission,DecoderAdmission) or enabled() is not True:return False
    absolute = getattr(metadata, "capture_absolute_coordinates", False) is True
    extent=metadata.capture_extent_frames48 if complete else None
    if (complete and (type(extent) is not int or not 0<extent<=_MAX
            or metadata.authoritative_total_frames!=(extent if absolute else metadata.timeline_start_frame+extent))):return False
    basis=metadata.capture_coordinate_basis
    if (metadata.capture_source_base48!=0 or metadata.sample_rate!=48000
            or type(command.start_frame) is not int or not 0<=command.start_frame<=_MAX
            or metadata.requested_start_frame!=command.start_frame or metadata.timeline_start_frame!=command.start_frame
            or basis!=("decoded-output-absolute-wav48" if absolute else
                "decoded-output-zero" if command.start_frame==0 else "decoded-output-local")
            or (absolute and (getattr(command,"capture_absolute_coordinates",False) is not True
                or command.start_frame==0))
            or (command.start_frame>0 and command.capture_local_coordinates is not True)
            or command.sample_rate!=48000 or str(command.path)!=admission.resolved_path
            or metadata.generation!=command.generation or metadata.stream_id!=command.stream_id):return False
    try:ref=UUID(metadata.capture_source_id)
    except (ValueError,TypeError,AttributeError):return False
    if ref.version!=4 or str(ref)!=metadata.capture_source_id:return False
    clock=clock or (lambda:datetime.now(timezone.utc))
    with current_library_transaction(database_url,context,constraints=constraints,connect=connect or _bounded_connection,clock=clock,
            inventory_publication_first=True) as (connection,live,now):
        if (live.actor.account_id,live.actor.session_id,live.library_id)!=(admission.account_id,admission.session_id,admission.library_id):return False
        _selector(connection,live)
        if enabled() is not True or not decoder_observation_ready(connection):return False
        if absolute and not absolute_wav_observation_ready(connection):return False
        source,revision=_source_snapshot(connection,live,admission.path,constraints)
        if (source['track_id'],source['file_id'],source['root_id'],revision)!=(admission.track_id,admission.file_id,admission.root_id,admission.inventory_source_revision):return False
        values=dict(account_id=admission.account_id,observation_ref=str(ref),auth_session_guard=admission.auth_session_guard,
            original_library_id=admission.library_id,original_track_id=admission.track_id,
            original_file_id=admission.file_id,original_root_id=admission.root_id,generation=command.generation,
            stream_id=command.stream_id,source_base48=0,extent_frames48=extent,inventory_source_revision=revision,
            coordinate_basis=basis,requested_start48=command.start_frame)
        old=connection.execute('''select * from integration.playback_decoder_observation
            where account_id=%s and observation_ref=%s''',(admission.account_id,str(ref))).fetchone()
        if old:
            if any(str(old[k])!=str(v) for k,v in values.items() if k!='extent_frames48'):
                raise CaptureError('capture_conflict',409)
            if complete:
                if old['extent_frames48'] is not None and old['extent_frames48']!=extent:
                    raise CaptureError('capture_conflict',409)
                if old['extent_frames48'] is None:
                    connection.execute('''update integration.playback_decoder_observation
                        set extent_frames48=%s where account_id=%s and observation_ref=%s
                        and extent_frames48 is null''',(extent,admission.account_id,str(ref)))
                    _advance_history_proof(connection,live.actor.account_id)
            _final_authority(connection,live,constraints,clock,admission.track_id)
            if enabled() is not True:raise CaptureError('capture_unavailable',503)
            return True
        if complete:return False  # EOF cannot invent a missing admitted-open source.
        account,global_budget=_budgets(connection,live.actor.account_id,now)
        history,history_charge=_prepare_history_revision(connection,account)
        _reserve(connection,account,global_budget,OBSERVATION_BYTES+history_charge)
        if history is None:_insert_reserved_history_revision(connection,account)
        connection.execute('''insert into integration.playback_decoder_observation
            (account_id,observation_ref,auth_session_guard,original_library_id,original_track_id,original_file_id,
             original_root_id,generation,stream_id,source_base48,extent_frames48,inventory_source_revision,
             coordinate_basis,requested_start48,observed_at,reservation_bytes,account_budget_id)
            values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,512,%s)''',(*values.values(),now,account['id']))
        _advance_history_proof(connection,live.actor.account_id)
        _final_authority(connection,live,constraints,clock,admission.track_id)
        if enabled() is not True:raise CaptureError('capture_unavailable',503)
        return True


def validate_known_observations(connection,live,parent,evidence,scope):
    """Known mismatched claims reject; absent/late facts never invent coverage.

    No equality between different observation UUIDs is inferred. The durable
    reference remains inside the immutable checkpoint JSON at each run_index.
    """
    refs={run['source_observation_ref'] for run in evidence['runs'] if 'source_observation_ref' in run}
    if not refs:return
    if not decoder_observation_ready(connection):return
    rows=connection.execute('''select * from integration.playback_decoder_observation
        where account_id=%s and observation_ref=any(%s::uuid[])''',(live.actor.account_id,sorted(refs))).fetchall()
    observations={str(row['observation_ref']):row for row in rows}
    for run in evidence['runs']:
        observation=observations.get(run.get('source_observation_ref'))
        if observation is None:continue
        if (observation['auth_session_guard']!=scope or observation['original_library_id']!=live.library_id
                or any(observation[key]!=parent[key] for key in ('original_track_id','original_file_id','original_root_id'))
                or observation['generation']!=run['generation'] or observation['stream_id']!=run['stream_id']
                or observation['source_base48']!=run['source_base48']
                or observation['extent_frames48'] is not None and run['source_start48']+run['frames']>observation['extent_frames48']):
            raise CaptureError('capture_conflict',409)


def read_decoder_observed_runs(database_url,context,*,after_run_id=0,limit=256,constraints=None,connect=None,clock=None):
    """Bounded actual stored-span reader; late EOF facts join without raw mutation.

    Local observations retain time identity, not source position/extent authority.
    This reports only per-observation extent qualification. It never merges
    different observations, fills gaps, grants playback or computes album Full.
    Existing current-library authority remains required; LS-11 is separate.
    """
    from music_app.services.playback_capture_postgres import _selector,_final_authority
    from music_app.services.playback_capture_history_revision import _read_history_revision
    if type(after_run_id) is not int or after_run_id<0 or type(limit) is not int or not 1<=limit<=256:
        raise CaptureError()
    clock=clock or (lambda:datetime.now(timezone.utc))
    with current_library_transaction(database_url,context,constraints=constraints,connect=connect or _bounded_connection,clock=clock,
            read_only=True,inventory_publication_first=True) as (connection,live,_now):
        _selector(connection,live)
        if not decoder_observation_ready(connection):raise CaptureError('capture_unavailable',503)
        revision=_read_history_revision(connection,live.actor.account_id)
        rows=connection.execute('''select r.id as run_id,p.id as capture_session_id,r.binding_serial,r.generation,
            r.stream_id,case when o.coordinate_basis in ('decoded-output-zero','decoded-output-absolute-wav48') then r.source_start48
              else null end as source_start48,r.frames,r.ordinal_start,r.quality,
            case when o.coordinate_basis in ('decoded-output-zero','decoded-output-absolute-wav48') and o.extent_frames48 is not null
              then 'observed_extent' else 'unknown' end as extent_status,
            o.observation_ref,o.coordinate_basis,
            case when o.coordinate_basis in ('decoded-output-zero','decoded-output-absolute-wav48') then o.extent_frames48 else null end as extent_frames48
            from integration.playback_capture_run r
            join integration.playback_capture_checkpoint cp on cp.id=r.checkpoint_id
            join integration.playback_capture_session p on p.id=cp.session_id
            left join integration.playback_decoder_observation o on o.account_id=p.account_id
              and o.observation_ref::text=(cp.evidence->'runs'->r.run_index->>'source_observation_ref')
              and o.auth_session_guard=p.auth_session_guard and o.original_library_id=p.library_id
              and o.original_track_id=p.original_track_id and o.original_file_id=p.original_file_id
              and o.original_root_id=p.original_root_id and o.generation=r.generation and o.stream_id=r.stream_id
              and o.source_base48=r.source_base48 and r.source_start48>=o.source_base48
              and (o.extent_frames48 is null or r.source_start48+r.frames<=o.extent_frames48)
            where p.account_id=%s and p.library_id=%s and p.evidence_version='app-rendered-position-v2'
              and not cp.evidence_redacted and r.id>%s order by r.id limit %s''',
            (live.actor.account_id,live.library_id,after_run_id,limit)).fetchall()
        _final_authority(connection,live,constraints,clock)
        return dict(runs=[dict(row) for row in rows],proof_revision=revision['proof_revision'],
            next_after_run_id=rows[-1]['run_id'] if rows else after_run_id)
