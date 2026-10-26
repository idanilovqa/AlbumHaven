"""Private companion intake and bounded structural readiness, never schema setup.

Column/trigger expectations are transcribed from accepted0142/0154/H3 source.
Matching structure is not deployed trigger-body, RLS or concurrency qualification.
"""
import json
from datetime import datetime, timezone
from music_app.services.playback_capture import BODY_LIMIT, CaptureError, POSITION_PROTOCOL

_COLUMNS = {'playback_capture_anchor': {'account_budget_id': ('bigint', False),
                             'epoch': ('bigint', True),
                             'id': ('bigint', True),
                             'max_quantum_frames': ('bigint', True),
                             'monotonic_probe_span_ms': ('bigint', True),
                             'output_frame': ('bigint', True),
                             'probe_id': ('bigint', True),
                             'quality': ('text', True),
                             'reservation_bytes': ('bigint', True),
                             'session_id': ('bigint', True),
                             'utc_lower_ms': ('bigint', False),
                             'utc_upper_ms': ('bigint', False)},
 'playback_capture_budget': {'account_id': ('bigint', False),
                             'id': ('bigint', True),
                             'is_global': ('boolean', True),
                             'rate_tokens': ('numeric', True),
                             'rate_updated_at': ('timestamp with time zone', True),
                             'reserved_bytes': ('bigint', True)},
 'playback_capture_checkpoint': {'accepted_at': ('timestamp with time zone', True),
                                 'account_budget_id': ('bigint', False),
                                 'digest': ('text', False),
                                 'evidence': ('jsonb', True),
                                 'evidence_redacted': ('boolean', True),
                                 'id': ('bigint', True),
                                 'known_frames': ('bigint', True),
                                 'lost_frames': ('bigint', True),
                                 'receipt_body': ('jsonb', True),
                                 'receipt_status': ('integer', True),
                                 'reservation_bytes': ('bigint', True),
                                 'sequence': ('bigint', True),
                                 'session_id': ('bigint', True),
                                 'terminal': ('boolean', True),
                                 'terminal_reason': ('text', False)},
 'playback_capture_history_revision': {'account_budget_id': ('bigint', False),
                                       'account_id': ('bigint', True),
                                       'append_revision': ('bigint', True),
                                       'invalidation_revision': ('bigint', True),
                                       'proof_revision': ('bigint', True),
                                       'raw_checkpoint_cut': ('bigint', False),
                                       'reservation_bytes': ('bigint', True)},
 'playback_capture_loss': {'account_budget_id': ('bigint', False),
                           'checkpoint_id': ('bigint', True),
                           'gap_index': ('integer', True),
                           'id': ('bigint', True),
                           'ordinal_end': ('bigint', True),
                           'ordinal_start': ('bigint', True),
                           'output_end': ('bigint', True),
                           'output_start': ('bigint', True),
                           'owner_id': ('bigint', False),
                           'reservation_bytes': ('bigint', True)},
 'playback_capture_owner': {'account_budget_id': ('bigint', False),
                            'account_id': ('bigint', True),
                            'auth_session_guard': ('text', True),
                            'device_uuid': ('uuid', True),
                            'id': ('bigint', True),
                            'library_id': ('bigint', True),
                            'owner_uuid': ('uuid', True),
                            'reservation_bytes': ('bigint', True)},
 'playback_capture_run': {'account_budget_id': ('bigint', False),
                          'anchor_after': ('bigint', False),
                          'anchor_before': ('bigint', False),
                          'binding_serial': ('bigint', False),
                          'checkpoint_id': ('bigint', True),
                          'continuity_serial': ('bigint', False),
                          'epoch': ('bigint', True),
                          'frames': ('bigint', True),
                          'generation': ('bigint', False),
                          'id': ('bigint', True),
                          'ordinal_start': ('bigint', True),
                          'output_start': ('bigint', True),
                          'owner_id': ('bigint', False),
                          'quality': ('text', True),
                          'reservation_bytes': ('bigint', True),
                          'run_index': ('integer', True),
                          'source_base48': ('bigint', False),
                          'source_start48': ('bigint', True),
                          'stream_id': ('bigint', False)},
 'playback_capture_session': {'accepted_known_frames': ('bigint', True),
                              'accepted_lost_frames': ('bigint', True),
                              'account_budget_id': ('bigint', False),
                              'account_id': ('bigint', False),
                              'admitted_at': ('timestamp with time zone', True),
                              'anchor_count': ('integer', True),
                              'auth_session_guard': ('text', False),
                              'capture_uuid': ('uuid', False),
                              'device_uuid': ('uuid', False),
                              'disc_number': ('integer', False),
                              'evidence_version': ('text', True),
                              'has_gaps': ('boolean', True),
                              'id': ('bigint', True),
                              'last_activity_at': ('timestamp with time zone', True),
                              'last_known_ordinal_end': ('bigint', False),
                              'last_known_output_end': ('bigint', False),
                              'last_sequence': ('bigint', True),
                              'library_id': ('bigint', True),
                              'live_album_id': ('bigint', False),
                              'live_track_id': ('bigint', False),
                              'ordinal_end': ('bigint', False),
                              'ordinal_start': ('bigint', False),
                              'original_album_id': ('bigint', False),
                              'original_file_id': ('bigint', True),
                              'original_root_id': ('bigint', True),
                              'original_track_id': ('bigint', True),
                              'owner_id': ('bigint', False),
                              'owner_uuid': ('uuid', False),
                              'reservation_bytes': ('bigint', True),
                              'terminal_at': ('timestamp with time zone', False),
                              'terminal_reason': ('text', False),
                              'timing_unknown': ('boolean', True),
                              'track_number': ('integer', False),
                              'v1_session_uuid': ('uuid', False)}}
_TRIGGERS = {'playback_capture_anchor_final': ('playback_capture_anchor',
                                   'playback_capture_v2_check_graph',
                                   21,
                                   True,
                                   True),
 'playback_capture_anchor_release': ('playback_capture_anchor',
                                     'playback_capture_release_charge',
                                     9,
                                     False,
                                     False),
 'playback_capture_anonymize_owner': ('playback_capture_session',
                                      'playback_capture_anonymize',
                                      19,
                                      False,
                                      False),
 'playback_capture_checkpoint_final': ('playback_capture_checkpoint',
                                       'playback_capture_v2_check_graph',
                                       21,
                                       True,
                                       True),
 'playback_capture_checkpoint_release': ('playback_capture_checkpoint',
                                         'playback_capture_release_charge',
                                         9,
                                         False,
                                         False),
 'playback_capture_history_anchor': ('playback_capture_anchor',
                                     'playback_capture_history_raw_mutation',
                                     27,
                                     False,
                                     False),
 'playback_capture_history_checkpoint': ('playback_capture_checkpoint',
                                         'playback_capture_history_raw_mutation',
                                         27,
                                         False,
                                         False),
 'playback_capture_history_loss': ('playback_capture_loss',
                                   'playback_capture_history_raw_mutation',
                                   27,
                                   False,
                                   False),
 'playback_capture_history_owner': ('playback_capture_owner',
                                    'playback_capture_history_raw_mutation',
                                    27,
                                    False,
                                    False),
 'playback_capture_history_revision_final': ('playback_capture_history_revision',
                                             'playback_capture_history_check_revision',
                                             21,
                                             True,
                                             True),
 'playback_capture_history_revision_guard': ('playback_capture_history_revision',
                                             'playback_capture_history_guard_revision',
                                             27,
                                             False,
                                             False),
 'playback_capture_history_revision_release': ('playback_capture_history_revision',
                                               'playback_capture_release_charge',
                                               9,
                                               False,
                                               False),
 'playback_capture_history_run': ('playback_capture_run',
                                  'playback_capture_history_raw_mutation',
                                  27,
                                  False,
                                  False),
 'playback_capture_history_session': ('playback_capture_session',
                                      'playback_capture_history_raw_mutation',
                                      27,
                                      False,
                                      False),
 'playback_capture_loss_final': ('playback_capture_loss', 'playback_capture_v2_check_graph', 29, True, True),
 'playback_capture_loss_release': ('playback_capture_loss',
                                   'playback_capture_release_charge',
                                   9,
                                   False,
                                   False),
 'playback_capture_owner_cleanup': ('playback_capture_session',
                                    'playback_capture_v2_cleanup_owner',
                                    9,
                                    True,
                                    True),
 'playback_capture_owner_final': ('playback_capture_owner',
                                  'playback_capture_v2_check_graph',
                                  29,
                                  True,
                                  True),
 'playback_capture_owner_immutable': ('playback_capture_owner',
                                      'playback_capture_v2_guard_owner',
                                      19,
                                      False,
                                      False),
 'playback_capture_owner_release': ('playback_capture_owner',
                                    'playback_capture_release_charge',
                                    9,
                                    False,
                                    False),
 'playback_capture_run_final': ('playback_capture_run', 'playback_capture_v2_check_graph', 21, True, True),
 'playback_capture_run_release': ('playback_capture_run', 'playback_capture_release_charge', 9, False, False),
 'playback_capture_session_final': ('playback_capture_session',
                                    'playback_capture_v2_check_graph',
                                    21,
                                    True,
                                    True),
 'playback_capture_session_release': ('playback_capture_session',
                                      'playback_capture_release_charge',
                                      9,
                                      False,
                                      False),
 'playback_capture_v2_checkpoint_immutable': ('playback_capture_checkpoint',
                                              'playback_capture_v2_guard_checkpoint',
                                              19,
                                              False,
                                              False),
 'playback_capture_v2_session_guard': ('playback_capture_session',
                                       'playback_capture_v2_guard_session',
                                       23,
                                       False,
                                       False)}
_FOREIGN_KEYS = {('playback_capture_anchor', 'account_budget_id'): ('integration',
                                                    'playback_capture_budget',
                                                    'id',
                                                    'set null'),
 ('playback_capture_anchor', 'session_id'): ('integration', 'playback_capture_session', 'id', 'cascade'),
 ('playback_capture_budget', 'account_id'): ('app', 'accounts', 'id', 'cascade'),
 ('playback_capture_checkpoint', 'account_budget_id'): ('integration',
                                                        'playback_capture_budget',
                                                        'id',
                                                        'set null'),
 ('playback_capture_checkpoint', 'session_id'): ('integration', 'playback_capture_session', 'id', 'cascade'),
 ('playback_capture_history_revision', 'account_budget_id'): ('integration',
                                                              'playback_capture_budget',
                                                              'id',
                                                              'set null'),
 ('playback_capture_history_revision', 'account_id'): ('app', 'accounts', 'id', 'cascade'),
 ('playback_capture_loss', 'account_budget_id'): ('integration', 'playback_capture_budget', 'id', 'set null'),
 ('playback_capture_loss', 'checkpoint_id'): ('integration', 'playback_capture_checkpoint', 'id', 'cascade'),
 ('playback_capture_loss', 'owner_id'): ('integration', 'playback_capture_owner', 'id', 'set null'),
 ('playback_capture_owner', 'account_budget_id'): ('integration',
                                                   'playback_capture_budget',
                                                   'id',
                                                   'set null'),
 ('playback_capture_owner', 'account_id'): ('app', 'accounts', 'id', 'cascade'),
 ('playback_capture_run', 'account_budget_id'): ('integration', 'playback_capture_budget', 'id', 'set null'),
 ('playback_capture_run', 'checkpoint_id'): ('integration', 'playback_capture_checkpoint', 'id', 'cascade'),
 ('playback_capture_run', 'owner_id'): ('integration', 'playback_capture_owner', 'id', 'set null'),
 ('playback_capture_session', 'account_budget_id'): ('integration',
                                                     'playback_capture_budget',
                                                     'id',
                                                     'set null'),
 ('playback_capture_session', 'account_id'): ('app', 'accounts', 'id', 'set null'),
 ('playback_capture_session', 'live_album_id'): ('library', 'local_albums', 'id', 'set null'),
 ('playback_capture_session', 'live_track_id'): ('library', 'local_tracks', 'id', 'set null'),
 ('playback_capture_session', 'owner_id'): ('integration', 'playback_capture_owner', 'id', 'set null')}

# Exact required identities, not merely similarly named indexes.
_KEYS = {
    'playback_capture_budget': [(('id',), ''), (('account_id',), ''), (('is_global',), 'is_global')],
    'playback_capture_session': [(('id',), ''), (('account_id','device_uuid','capture_uuid'), 'account_idisnotnull')],
    'playback_capture_checkpoint': [(('id',), ''), (('session_id','sequence'), '')],
    'playback_capture_anchor': [(('id',), ''), (('session_id','epoch','probe_id'), '')],
    'playback_capture_run': [(('id',), ''), (('checkpoint_id','run_index'), ''), (('owner_id','ordinal_start'), 'owner_idisnotnull')],
    'playback_capture_owner': [(('id',), ''), (('account_id','library_id','device_uuid','auth_session_guard','owner_uuid'), '')],
    'playback_capture_loss': [(('id',), ''), (('checkpoint_id','gap_index'), '')],
    'playback_capture_history_revision': [(('account_id',), '')],
}
_REQUIRED_CHECKS = {
    'playback_capture_session': {'playback_capture_session_version_check','playback_capture_session_charge_check'},
    'playback_capture_checkpoint': {'playback_capture_checkpoint_redaction_check'},
    'playback_capture_run': {'playback_capture_run_charge_check'},
}


def _unavailable():
    raise CaptureError('capture_unavailable', 503)


def parse_position_capture_body(raw):
    """The private parser cannot fall through to the legacy public writer."""
    if len(raw) > BODY_LIMIT:
        raise CaptureError('capture_too_large', 413)
    def pairs(items):
        value = {}
        for key, item in items:
            if key in value:
                raise CaptureError()
            value[key] = item
        return value
    def invalid(_):
        raise CaptureError()
    try:
        value = json.loads(raw.decode('utf-8'), object_pairs_hook=pairs,
                           parse_constant=invalid, parse_float=invalid)
    except (UnicodeError, ValueError, RecursionError):
        raise CaptureError() from None
    if type(value) is not dict or value.get('protocol') != POSITION_PROTOCOL:
        raise CaptureError('unsupported_capture_version')
    from music_app.services.playback_edition_selection import normalize_selected_position_envelope
    return normalize_selected_position_envelope(value)


def require_position_storage(connection):
    """One transaction-local catalog read; no cross-request authority cache.

    Limits bound malformed/expanded schemas. This verifies types, nullability,
    FK targets/deletion behavior, real unique identities, enabled trigger
    attachment/signatures and current-role privileges, not function bodies/RLS.
    Real deployment and concurrency qualification remains a separate release gate.
    """
    row = connection.execute('''with wanted as (
          select c.oid,c.relname,c.relrowsecurity from pg_class c
          join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='integration' and c.relname=any(%s) and c.relkind='r'
        ) select current_setting('session_replication_role') as replication_role,
        has_schema_privilege('integration','USAGE') as schema_usage,
        (select jsonb_agg(to_jsonb(x)) from (select relname,
          has_table_privilege(oid,'SELECT') as can_select,
          has_table_privilege(oid,'INSERT') as can_insert,
          has_table_privilege(oid,'UPDATE') as can_update,
          relrowsecurity from wanted) x) as tables,
        (select jsonb_agg(to_jsonb(x)) from (select w.relname,a.attname,
          format_type(a.atttypid,a.atttypmod) as kind,a.attnotnull,a.attidentity
          from wanted w join pg_attribute a on a.attrelid=w.oid
          where a.attnum>0 and not a.attisdropped limit 1025) x) as columns,
        (select jsonb_agg(to_jsonb(x)) from (select w.relname,c.conname,c.contype,c.convalidated,
          array(select a.attname from unnest(c.conkey) with ordinality k(num,pos)
            join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.num order by k.pos) as keys,
          fn.nspname as foreign_schema,fc.relname as foreign_table,c.confdeltype,
          array(select a.attname from unnest(c.confkey) with ordinality k(num,pos)
            join pg_attribute a on a.attrelid=c.confrelid and a.attnum=k.num order by k.pos) as foreign_keys
          from wanted w join pg_constraint c on c.conrelid=w.oid
          left join pg_class fc on fc.oid=c.confrelid left join pg_namespace fn on fn.oid=fc.relnamespace
          limit 1025) x) as constraints,
        (select jsonb_agg(to_jsonb(x)) from (select w.relname,t.tgname,t.tgtype,t.tgenabled,
          t.tgdeferrable,t.tginitdeferred,t.tgnargs,t.tgqual is null as unconditional,
          array(select a.attname from unnest(t.tgattr) with ordinality k(num,pos)
            join pg_attribute a on a.attrelid=t.tgrelid and a.attnum=k.num order by k.pos) as attrs,
          n.nspname as function_schema,p.proname,p.pronargs,p.prorettype='trigger'::regtype as returns_trigger,
          p.prosecdef,has_function_privilege(p.oid,'EXECUTE') as can_execute
          from wanted w join pg_trigger t on t.tgrelid=w.oid
          join pg_proc p on p.oid=t.tgfoid join pg_namespace n on n.oid=p.pronamespace
          where not t.tgisinternal limit 257) x) as triggers,
        (select jsonb_agg(to_jsonb(x)) from (select w.relname,i.indisunique,i.indisvalid,i.indisready,i.indnkeyatts,
          i.indexprs is null as no_expressions,
          pg_get_expr(i.indpred,i.indrelid) as predicate,
          array(select a.attname from unnest(i.indkey) with ordinality k(num,pos)
            join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.num
            where k.pos<=i.indnkeyatts order by k.pos) as keys
          from wanted w join pg_index i on i.indrelid=w.oid limit 257) x) as indexes''',
        (list(_COLUMNS),)).fetchone()
    if not row or row.get('replication_role')!='origin' or row.get('schema_usage') is not True or any(not isinstance(row.get(k),list) or len(row[k])>=limit for k,limit in
            [('tables',9),('columns',1025),('constraints',1025),('triggers',257),('indexes',257)]):
        _unavailable()
    tables = {x['relname']:x for x in row['tables']}
    if set(tables) != set(_COLUMNS):
        _unavailable()
    for name, table in tables.items():
        if table['relrowsecurity'] or not table['can_select'] or not table['can_insert']:
            _unavailable()
        # These updates are used by the runtime writer and revision owner.
        # Parent/owner deletion and its cleanup triggers remain privileged.
        if name in {'playback_capture_budget','playback_capture_session','playback_capture_history_revision'} and not table['can_update']:
            _unavailable()
    columns = {(x['relname'],x['attname']):(x['kind'],x['attnotnull']) for x in row['columns']}
    if any(x['attidentity'] != ('a' if x['attname']=='id' else '')
            for x in row['columns'] if x['attname'] in _COLUMNS.get(x['relname'],{})):
        _unavailable()
    if any(columns.get((table,name)) != expected for table,cols in _COLUMNS.items() for name,expected in cols.items()):
        _unavailable()
    constraints = row['constraints']
    if any(not x['convalidated'] for x in constraints):
        _unavailable()
    for table,names in _REQUIRED_CHECKS.items():
        if not names <= {x['conname'] for x in constraints if x['relname']==table and x['contype']=='c'}:
            _unavailable()
    for (table,key),(schema,target,target_key,delete) in _FOREIGN_KEYS.items():
        if not any(x['relname']==table and x['contype']=='f' and x['keys']==[key]
                and x['foreign_schema']==schema and x['foreign_table']==target
                and x['foreign_keys']==[target_key] and x['confdeltype']=={'cascade':'c','set null':'n'}[delete]
                for x in constraints):
            _unavailable()
    # Historical original library identity is not a live inventory dependency.
    # Reject every FK involving this column, including unexpected composite FKs.
    if any(x['contype']=='f' and x['relname'] in
            {'playback_capture_owner','playback_capture_session'}
            and 'library_id' in x['keys'] for x in constraints):
        _unavailable()
    def predicate(value):
        return ''.join(c for c in (value or '').casefold() if not c.isspace() and c not in '()')
    for table,keys in _KEYS.items():
        for key,where in keys:
            if not any(x['relname']==table and x['indisunique'] and x['indisvalid'] and x['indisready']
                    and x['no_expressions'] and x['indnkeyatts']==len(key)
                    and tuple(x['keys'])==key and predicate(x['predicate'])==where for x in row['indexes']):
                _unavailable()
    triggers = {x['tgname']:x for x in row['triggers']}
    for name,(table,function,kind,deferred,initial) in _TRIGGERS.items():
        x=triggers.get(name)
        if not x or (x['relname'],x['proname'],x['tgtype'],x['tgdeferrable'],x['tginitdeferred']) != (table,function,kind,deferred,initial):
            _unavailable()
        if (x['tgenabled'] not in ('O','A') or x['function_schema']!='integration'
                or x['tgnargs']!=0 or not x['unconditional']
                or x['pronargs']!=0 or not x['returns_trigger'] or x['prosecdef'] or not x['can_execute']):
            _unavailable()
        # Only the accepted account anonymization trigger has a column filter.
        if x['attrs'] != (['account_id'] if name=='playback_capture_anonymize_owner' else []):
            _unavailable()


def check_position_capture_context(database_url,context,*,constraints=None,connect=None,clock=None,selections=False,include_observations=False):
    from music_app.services.private_library_authority import current_library_transaction,require_private_action
    from music_app.services.playback_capture_postgres import _selector,_final_authority
    from music_app.services.playback_edition_selection import selection_schema_ready
    clock=clock or (lambda:datetime.now(timezone.utc))
    with current_library_transaction(database_url,context,constraints=constraints,connect=connect,
            clock=clock,read_only=True,inventory_publication_first=True) as (connection,live,_now):
        _selector(connection,live)
        require_private_action(live,'library.media.read',constraints=constraints)
        require_position_storage(connection)
        ready = selection_schema_ready(connection)
        if not ready:
            state=connection.execute('''select
                to_regclass('integration.playback_edition_selection') is not null
                or to_regclass('integration.playback_edition_capture') is not null as present''').fetchone()
            if state is None or state['present']:
                _unavailable()
        available = selections is True and ready
        observations=False
        if include_observations:
            from music_app.services.playback_decoder_observation import decoder_observation_ready
            observations=decoder_observation_ready(connection)
        _final_authority(connection,live,constraints,clock)
        return dict(selections=bool(available),observations=observations) if include_observations else bool(available)
