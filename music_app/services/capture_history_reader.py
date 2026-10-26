"""Own-account raw position evidence, independent of current library access.

Not a scrobble ledger, playback grant, current-edition metric or hosted identity
mapping. Original numeric identities are provenance, never inventory resolvers.
"""
from .playback_capture import CaptureError, POSITION_PROTOCOL
from .playback_position_transport import require_position_storage
from .playback_capture_history_revision import _read_history_revision
from .capture_history_authority import current_capture_history_account_read_transaction

SESSION_PAGE = 32
MAX_ID = 9223372036854775807


def _number(value, minimum=0):
    if type(value) is not int or not minimum <= value <= MAX_ID:
        raise CaptureError()
    return value


def _ready(connection):
    require_position_storage(connection)
    indexes=connection.execute("""select am.amname,i.indisvalid,i.indisready,i.indnkeyatts,
        i.indpred is null as no_predicate,i.indexprs is null as no_expressions,
        (select array_agg(a.attname::text order by k.pos)
         from unnest(i.indkey::smallint[]) with ordinality k(num,pos)
         left join pg_attribute a on a.attrelid=t.oid and a.attnum=k.num
         where k.pos<=i.indnkeyatts) as keys
        from pg_index i join pg_class t on t.oid=i.indrelid
        join pg_namespace n on n.oid=t.relnamespace
        join pg_class idx on idx.oid=i.indexrelid join pg_am am on am.oid=idx.relam
        where n.nspname='integration' and t.relname='playback_capture_session'
        order by idx.oid limit 33""").fetchall()
    if len(indexes)>32 or not any(x['amname']=='btree' and x['indisvalid'] is True
            and x['indisready'] is True and x['no_predicate'] is True
            and x['no_expressions'] is True and x['indnkeyatts']==3
            and x['keys']==['account_id','evidence_version','id'] for x in indexes):
        raise CaptureError('capture_unavailable',503)


def read_account_capture_history(database_url, context, *, after_session_id=0,
        session_id=None, after_sequence=0, constraints=None, connect=None, clock=None):
    """One indexed 32-parent page OR one immutable checkpoint's bounded evidence.

    Each page has its genuine account H3 cut/revisions. No claim that separate
    requests form one lifetime snapshot; consumers discard on invalidation and
    may refresh for later appends/EOF. No read initializes metadata or spends quota.
    """
    _number(after_session_id);_number(after_sequence)
    if session_id is not None:_number(session_id,1)
    if session_id is None and after_sequence or session_id is not None and after_session_id:
        raise CaptureError()
    with current_capture_history_account_read_transaction(database_url,context,
            constraints=constraints,connect=connect,clock=clock) as (connection,live,_now):
        _ready(connection)
        revision=_read_history_revision(connection,live.actor.account_id)
        result=dict(protocol='account_capture_history_v1',basis='raw-app-rendered-position-v2',
            raw_checkpoint_cut=None if revision['raw_checkpoint_cut'] is None else str(revision['raw_checkpoint_cut']),
            append_revision=str(revision['append_revision']),
            invalidation_revision=str(revision['invalidation_revision']),
            proof_revision=str(revision['proof_revision']),playback_authorized=False)
        if session_id is None:
            rows=connection.execute('''select id,library_id,original_track_id,original_file_id,
                original_root_id,original_album_id,admitted_at,terminal_at,terminal_reason
                from integration.playback_capture_session
                where account_id=%s and id>%s and evidence_version=%s
                order by id limit %s''',(live.actor.account_id,after_session_id,POSITION_PROTOCOL,SESSION_PAGE+1)).fetchall()
            page=rows[:SESSION_PAGE]
            result.update(captures=[dict(capture_id=str(r['id']),
                original_library_id=str(r['library_id']),original_track_id=str(r['original_track_id']),
                original_file_id=str(r['original_file_id']),original_root_id=str(r['original_root_id']),
                original_album_id=None if r['original_album_id'] is None else str(r['original_album_id']),
                admitted_at=r['admitted_at'].isoformat(),
                terminal_at=None if r['terminal_at'] is None else r['terminal_at'].isoformat(),
                terminal_reason=r['terminal_reason']) for r in page],
                next_after_session_id=str(page[-1]['id']) if page else str(after_session_id),
                has_more=len(rows)>SESSION_PAGE)
            return result
        parent=connection.execute('''select id from integration.playback_capture_session
            where id=%s and account_id=%s and evidence_version=%s''',
            (session_id,live.actor.account_id,POSITION_PROTOCOL)).fetchone()
        if parent is None:raise CaptureError('capture_not_found',404)
        cp=connection.execute('''select id,sequence,accepted_at,known_frames,lost_frames,terminal,terminal_reason
            from integration.playback_capture_checkpoint where session_id=%s and sequence>%s
              and id<=%s and not evidence_redacted order by sequence limit 1''',
            (session_id,after_sequence,revision['raw_checkpoint_cut'] or 0)).fetchone()
        if cp is None:
            result.update(capture_id=str(session_id),checkpoint=None,next_after_sequence=str(after_sequence),has_more=False)
            return result
        # Read normalized rows, never return checkpoint JSON containing source paths,
        # device/owner UUIDs, session guards, transport receipts or other identities.
        runs=connection.execute('''select run_index,source_start48,frames,output_start,ordinal_start,
            epoch,binding_serial,generation,stream_id,source_base48,continuity_serial,quality
            from integration.playback_capture_run where checkpoint_id=%s order by run_index limit 257''',(cp['id'],)).fetchall()
        losses=connection.execute('''select gap_index,ordinal_start,ordinal_end,output_start,output_end
            from integration.playback_capture_loss where checkpoint_id=%s order by gap_index limit 9''',(cp['id'],)).fetchall()
        if len(runs)>256 or len(losses)>8:raise CaptureError('capture_unavailable',503)
        result.update(capture_id=str(session_id),checkpoint=dict(sequence=str(cp['sequence']),
            accepted_at=cp['accepted_at'].isoformat(),known_frames=str(cp['known_frames']),
            lost_frames=str(cp['lost_frames']),terminal=cp['terminal'],terminal_reason=cp['terminal_reason'],
            runs=[dict(r) for r in runs],losses=[dict(r) for r in losses]),
            next_after_sequence=str(cp['sequence']),has_more=True)
        # has_more means a continuation may be requested; the final empty page
        # establishes exhaustion at this cut without a second unbounded query.
        return result
