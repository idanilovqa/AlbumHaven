"""Rate-native checkpoint storage; not an audio scheduler or a resampler.

Maps are trusted producer facts, not proof of hearing. Browser spans remain
application-reported evidence. All writes reuse current account authority and
one aggregate budget reservation in their transaction. No background tasks,
process registry, private paths in evidence, or age-pruning policy live here.
"""
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import re
from uuid import UUID

from music_app.services.playback_capture import (
    BODY_LIMIT, CaptureError, MAX_INTEGER, TERMINAL_REASONS, canonical_json,
)
from music_app.services.playback_capture_postgres import (
    _budgets, _final_authority, _reserve, _selector,
)
from music_app.services.playback_capture_history_revision import (
    _append_history_checkpoint, _advance_history_proof,
    _insert_reserved_history_revision, _prepare_history_revision,
)
from music_app.services.playback_decoder_observation import (
    DecoderAdmission, _bounded_connection, _source_snapshot,
)
from music_app.services.playback_edition_selection import (
    ASSOCIATION_BYTES, admit_capture_selection, insert_capture_selection,
    selection_schema_ready,
)
from music_app.services.playback_rate_evidence import (
    PROTOCOL, MAX_RATE, MIN_RATE, RateEvidenceError, RateMap, normalize_spans,
)
from music_app.services.private_library_authority import (
    current_library_transaction, require_private_action,
)

MAP_BYTES = 768
_ENVELOPE = {'protocol', 'device_uuid', 'capture_uuid', 'sequence', 'evidence'}
_EVIDENCE = {'owner_uuid', 'owner_sequence', 'coordinate_rate_hz', 'spans',
             'terminal', 'terminal_reason'}
_SPAN = {'map_ref', 'coordinate_start_frame', 'frame_count', 'repeat_count',
         'output_start_frame', 'continuity_serial'}

# pg_get_expr/pg_get_constraintdef canonical forms. Only whitespace outside
# quoted literals is ignored; operators, parentheses, casts and literals remain.
_RATE_INDEXES = {
    'playback_rate_checkpoint_owner_sequence': ('playback_capture_checkpoint', True,
        ('rate_owner_id','rate_owner_sequence'), (0,0), '(rate_owner_id IS NOT NULL)'),
    'playback_rate_checkpoint_output_tail': ('playback_capture_checkpoint', False,
        ('rate_owner_id','rate_owner_sequence'), (0,3),
        "((rate_owner_id IS NOT NULL) AND CASE WHEN (jsonb_typeof((evidence -> 'spans'::text)) = 'array'::text) "
        "THEN (jsonb_array_length((evidence -> 'spans'::text)) > 0) ELSE false END)"),
    'playback_rate_map_source_extent': ('playback_rate_map', False,
        ('account_id','original_library_id','original_file_id','inventory_source_revision',
         'source_rate_hz','source_extent_frames'), (0,0,0,0,0,0), '(source_extent_frames IS NOT NULL)'),
    'playback_rate_owner_context': ('playback_capture_owner', True,
        ('account_id','library_id','auth_session_guard','owner_uuid'), (0,0,0,0),
        '(rate_coordinate_hz IS NOT NULL)'),
}
_MAP_CHECKS = {
    'map_ref': "CHECK ((map_ref <> '00000000-0000-0000-0000-000000000000'::uuid))",
    'owner_uuid': "CHECK ((owner_uuid <> '00000000-0000-0000-0000-000000000000'::uuid))",
    'auth_session_guard': 'CHECK (((octet_length(auth_session_guard) >= 1) AND (octet_length(auth_session_guard) <= 256)))',
    'inventory_source_revision': "CHECK ((inventory_source_revision ~ '^[a-f0-9]{64}$'::text))",
    'cohort_ref': "CHECK ((cohort_ref ~ '^[a-f0-9]{64}$'::text))",
    'reservation_bytes': 'CHECK ((reservation_bytes = 768))',
}
for _column in ('original_library_id','original_track_id','original_file_id','original_root_id'):
    _MAP_CHECKS[_column] = f'CHECK (({_column} > 0))'
for _column, _lower, _upper in (
        ('generation',1,'2147483647'),('stream_id',1,'2147483647'),
        ('coordinate_rate_hz',8000,'192000'),('source_rate_hz',8000,'192000'),
        ('window_start_frame',0,"'9007199254740991'::bigint"),
        ('window_frames',0,"'9007199254740991'::bigint"),
        ('source_extent_frames',0,"'9007199254740991'::bigint")):
    _MAP_CHECKS[_column] = f'CHECK ((({_column} >= {_lower}) AND ({_column} <= {_upper})))'
_MAP_CHECKS = {f'playback_rate_map_{key}_check': value for key,value in _MAP_CHECKS.items()}
_MAP_CHECKS.update(
    playback_rate_map_window_bound="CHECK (((window_start_frame + window_frames) <= '9007199254740991'::bigint))",
    playback_rate_map_open_order='CHECK ((opened_at <= observed_at))')


def _catalog_sql(value):
    # Preserve every quoted literal, including case and embedded whitespace.
    return re.sub(r"'(?:''|[^'])*'|\s+", lambda match: match[0] if match[0].startswith("'") else '', value or '')


def _require_rate_indexes_and_checks(connection):
    indexes = connection.execute('''select idx.relname as name,t.relname as relation,
            tn.nspname as table_schema,am.amname,i.indisunique,i.indisvalid,i.indisready,i.indimmediate,
            i.indnkeyatts,i.indnatts,i.indexprs is null as plain,
            pg_get_expr(i.indpred,i.indrelid,false) as predicate,
            array(select a.attname from unnest(i.indkey) with ordinality k(num,pos)
              join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.num order by k.pos) as keys,
            array(select unnest(i.indoption)) as options,
            not exists(select 1 from unnest(i.indclass) cls(oid)
              join pg_opclass op on op.oid=cls.oid where not op.opcdefault) as default_ops,
            not exists(select 1 from unnest(i.indkey) with ordinality k(num,pos)
              join pg_attribute a on a.attrelid=i.indrelid and a.attnum=k.num
              where i.indcollation[(k.pos-1)::integer]<>a.attcollation) as default_collation
        from pg_index i join pg_class idx on idx.oid=i.indexrelid
        join pg_namespace ns on ns.oid=idx.relnamespace join pg_class t on t.oid=i.indrelid
        join pg_namespace tn on tn.oid=t.relnamespace join pg_am am on am.oid=idx.relam
        where ns.nspname='integration' and idx.relname=any(%s::text[])''',
        (list(_RATE_INDEXES),)).fetchall()
    if len(indexes)!=len(_RATE_INDEXES):
        raise CaptureError('capture_unavailable', 503)
    for row in indexes:
        relation, unique, keys, options, predicate = _RATE_INDEXES[row['name']]
        if (row['table_schema']!='integration' or row['relation']!=relation or row['amname']!='btree'
                or row['indisunique'] is not unique or not row['indisvalid'] or not row['indisready']
                or not row['indimmediate']
                or not row['plain'] or not row['default_ops'] or not row['default_collation']
                or row['indnkeyatts']!=len(keys) or row['indnatts']!=len(keys)
                or tuple(row['keys'])!=keys or tuple(row['options'])!=options
                or _catalog_sql(row['predicate'])!=_catalog_sql(predicate)):
            raise CaptureError('capture_unavailable', 503)
    checks = connection.execute('''select conname,convalidated,pg_get_constraintdef(oid,false) as definition
        from pg_constraint where conrelid='integration.playback_rate_map'::regclass
          and contype='c' ''').fetchall()
    actual = {row['conname']: row for row in checks}
    if any(name not in actual or not actual[name]['convalidated']
           or _catalog_sql(actual[name]['definition'])!=_catalog_sql(expected)
           for name,expected in _MAP_CHECKS.items()):
        raise CaptureError('capture_unavailable', 503)


def _integer(value, minimum=0, maximum=MAX_INTEGER):
    if type(value) is not int or not minimum <= value <= maximum:
        raise CaptureError()
    return value


def _uuid(value):
    try:
        parsed = UUID(value) if type(value) is str else None
    except ValueError:
        parsed = None
    if parsed is None or parsed.version != 4 or str(parsed) != value:
        raise CaptureError()
    return value


def normalize_rate_capture_envelope(value):
    """Isolated protocol parser; never broadens the public v1/v2 parsers."""
    if type(value) is not dict or value.get('protocol') != PROTOCOL:
        raise CaptureError('unsupported_capture_version')
    if not _ENVELOPE <= value.keys() or value.keys()-_ENVELOPE-{'edition_selection_ref'}:
        raise CaptureError()
    evidence = value['evidence']
    if type(evidence) is not dict or evidence.keys() != _EVIDENCE:
        raise CaptureError()
    _uuid(value['device_uuid']); _uuid(value['capture_uuid']); _uuid(evidence['owner_uuid'])
    _integer(value['sequence'], 1); _integer(evidence['owner_sequence'], 1)
    _integer(evidence['coordinate_rate_hz'], MIN_RATE, MAX_RATE)
    if 'edition_selection_ref' in value:
        _uuid(value['edition_selection_ref'])
    if type(evidence['terminal']) is not bool:
        raise CaptureError()
    reason = evidence['terminal_reason']
    if ((evidence['terminal'] and (type(reason) is not str or reason not in TERMINAL_REASONS))
            or (not evidence['terminal'] and reason is not None)):
        raise CaptureError()
    spans = evidence['spans']
    if type(spans) is not list or len(spans)>256 or not spans and not evidence['terminal']:
        raise CaptureError()
    previous_end = None
    normalized = []
    for span in spans:
        if type(span) is not dict or span.keys() != _SPAN:
            raise CaptureError()
        _uuid(span['map_ref'])
        for key in _SPAN-{'map_ref'}:
            _integer(span[key], 1 if key in {'frame_count','repeat_count','continuity_serial'} else 0)
        _integer(span['coordinate_start_frame']+span['frame_count'])
        rendered = _integer(span['frame_count']*span['repeat_count'], 1)
        end = _integer(span['output_start_frame']+rendered)
        if previous_end is not None and span['output_start_frame']<previous_end:
            raise CaptureError('capture_conflict', 409)
        previous_end = end
        normalized.append(dict(span))
    result = dict(value, evidence=dict(evidence, spans=normalized))
    if len(canonical_json(result).encode('utf-8'))>BODY_LIMIT:
        raise CaptureError('capture_too_large', 413)
    return result


def parse_rate_capture_body(raw):
    if len(raw)>BODY_LIMIT:
        raise CaptureError('capture_too_large', 413)
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise CaptureError()
            result[key] = value
        return result
    def invalid(_value):
        raise CaptureError()
    try:
        value = json.loads(raw.decode('utf-8'),object_pairs_hook=pairs,
                           parse_constant=invalid,parse_float=invalid)
    except (UnicodeError,ValueError,RecursionError):
        raise CaptureError() from None
    return normalize_rate_capture_envelope(value)


def rate_source_cohort(admission):
    """Server source identity policy, not a content hash or client credential."""
    if not isinstance(admission, DecoderAdmission):
        raise CaptureError('capture_unavailable', 503)
    body = [admission.library_id, admission.track_id, admission.file_id,
            admission.root_id, admission.inventory_source_revision]
    return hashlib.sha256(('rate-source-cohort-v1\n'+canonical_json(body)).encode()).hexdigest()


def require_rate_storage(connection):
    from music_app.services.playback_position_transport import require_position_storage
    require_position_storage(connection)
    row = connection.execute("""select
        to_regclass('integration.playback_rate_map') is not null as present,
        exists(select 1 from pg_constraint where
          conrelid=to_regclass('integration.playback_capture_session')
          and conname='playback_capture_session_rate_check' and convalidated) as versioned
        """).fetchone()
    if not row or not row['present'] or not row['versioned']:
        raise CaptureError('capture_unavailable', 503)
    row = connection.execute("""select
        has_table_privilege('integration.playback_rate_map','SELECT') and
        has_table_privilege('integration.playback_rate_map','INSERT') as allowed,
        not c.relrowsecurity as ordinary,
        (select jsonb_object_agg(attname,format_type(atttypid,atttypmod)||':'||attnotnull::text)
          from pg_attribute where attrelid=c.oid and attnum>0 and not attisdropped) as columns,
        array(select t.tgname||':'||t.tgtype::text||':'||p.proname
          from pg_trigger t join pg_proc p on p.oid=t.tgfoid
          join pg_namespace n on n.oid=p.pronamespace where t.tgrelid=c.oid
          and tgenabled in ('O','A') and not tgisinternal and tgqual is null
          and tgnargs=0 and tgattr=''::int2vector and p.pronargs=0
          and p.prorettype='trigger'::regtype and not p.prosecdef
          and n.nspname='integration' and has_function_privilege(p.oid,'EXECUTE')) as triggers,
        exists(select 1 from pg_constraint k where k.conrelid=c.oid and k.contype='p'
          and k.conkey=array[(select attnum from pg_attribute where attrelid=c.oid and attname='account_id'),
            (select attnum from pg_attribute where attrelid=c.oid and attname='map_ref')]::smallint[]) as identity,
        array(select a.attname||':'||n.nspname||'.'||target.relname||':'||ref.attname||':'||k.confdeltype::text
          from pg_constraint k join pg_attribute a on a.attrelid=c.oid and k.conkey=array[a.attnum]::smallint[]
          join pg_class target on target.oid=k.confrelid join pg_namespace n on n.oid=target.relnamespace
          join pg_attribute ref on ref.attrelid=target.oid and k.confkey=array[ref.attnum]::smallint[]
          where k.conrelid=c.oid and k.contype='f' order by a.attname) as foreign_keys,
        not exists(select 1 from pg_constraint where conrelid=c.oid and not convalidated) as validated,
        exists(select 1 from pg_trigger t join pg_proc p on p.oid=t.tgfoid
          where t.tgrelid='integration.playback_capture_checkpoint'::regclass
          and t.tgname='playback_rate_checkpoint_admission' and t.tgtype=7
          and t.tgenabled in ('O','A') and t.tgqual is null and t.tgnargs=0
          and t.tgattr=''::int2vector and p.proname='playback_rate_admit_checkpoint'
          and p.pronamespace='integration'::regnamespace and p.pronargs=0
          and p.prorettype='trigger'::regtype and not p.prosecdef
          and has_function_privilege(p.oid,'EXECUTE')) as admission
        from pg_class c where c.oid='integration.playback_rate_map'::regclass and c.relkind='r'
        """).fetchone()
    columns = {key:'bigint:true' for key in ('account_id','original_library_id','original_track_id',
        'original_file_id','original_root_id','generation','stream_id','window_start_frame',
        'window_frames','reservation_bytes')}
    columns.update(map_ref='uuid:true',owner_uuid='uuid:true',auth_session_guard='text:true',
        inventory_source_revision='text:true',cohort_ref='text:true',
        coordinate_rate_hz='integer:true',source_rate_hz='integer:true',source_extent_frames='bigint:false',
        opened_at='timestamp with time zone:true',observed_at='timestamp with time zone:true',
        account_budget_id='bigint:false')
    if (not row or not all(row[key] for key in
            ('allowed','ordinary','validated','admission','identity'))
            or row['columns'] != columns
            or row['foreign_keys'] != ['account_budget_id:integration.playback_capture_budget:id:n',
                                      'account_id:app.accounts:id:c']
            or not {'playback_rate_map_immutable:23:playback_rate_map_guard',
                    'playback_rate_map_revision:11:playback_rate_map_invalidate',
                    'playback_rate_map_release:9:playback_capture_release_charge'} <= set(row['triggers'])):
        raise CaptureError('capture_unavailable', 503)
    _require_rate_indexes_and_checks(connection)
    extensions = connection.execute("""select c.relname,a.attname,
            format_type(a.atttypid,a.atttypmod) as kind,a.attnotnull
        from pg_attribute a join pg_class c on c.oid=a.attrelid
        where a.attrelid=any(array['integration.playback_capture_owner'::regclass,
              'integration.playback_capture_session'::regclass,'integration.playback_capture_checkpoint'::regclass])
          and a.attname in ('rate_coordinate_hz','rate_owner_id','rate_owner_sequence')
          and not a.attisdropped""").fetchall()
    if {(r['relname'],r['attname'],r['kind'],r['attnotnull']) for r in extensions} != {
            ('playback_capture_owner','rate_coordinate_hz','integer',False),
            ('playback_capture_session','rate_coordinate_hz','integer',False),
            ('playback_capture_checkpoint','rate_owner_id','bigint',False),
            ('playback_capture_checkpoint','rate_owner_sequence','bigint',False)}:
        raise CaptureError('capture_unavailable', 503)


def _gate(enabled):
    if not callable(enabled) or enabled() is not True:
        raise CaptureError('capture_unavailable', 503)


def publish_rate_map(database_url, context, admission, mapping, *, owner_uuid, generation,
                     stream_id, opened_at, constraints=None, connect=None,
                     clock=None, enabled=lambda: False):
    """Caller supplies qualified actual-open facts, never an HTTP map body.

    Failure does not own playback cancellation; the caller handles optional
    observation failure independently. owner_uuid is captured on the actual
    open, never selected from the first arriving report. Maps survive decoder closure. Unknown
    alignment must not call this function. Extents cannot later mutate a map.
    """
    _gate(enabled)
    _uuid(owner_uuid)
    if (type(mapping) is not RateMap or not isinstance(admission, DecoderAdmission)
            or mapping.cohort_ref != rate_source_cohort(admission)
            or (mapping.owner_uuid,mapping.generation,mapping.stream_id)!=(owner_uuid,generation,stream_id)
            or not isinstance(opened_at, datetime) or opened_at.tzinfo is None):
        raise CaptureError('capture_unavailable', 503)
    _integer(generation, 1, 2147483647); _integer(stream_id, 1, 2147483647)
    # Validate the existing playback policy; this does not perform conversion.
    # The producer separately owns the bandwidth-only fallback admission rule.
    from music_app.services.playback_encoded import fallback_sample_rate
    if mapping.coordinate_rate_hz not in {mapping.source_rate_hz, fallback_sample_rate(mapping.source_rate_hz)}:
        raise CaptureError('capture_unavailable', 503)
    clock = clock or (lambda: datetime.now(timezone.utc))
    with current_library_transaction(database_url, context, constraints=constraints,
            connect=connect or _bounded_connection, clock=clock,
            inventory_publication_first=True) as (connection, live, now):
        _selector(connection, live); require_rate_storage(connection); _gate(enabled)
        if ((live.actor.account_id, live.actor.session_id, live.library_id) !=
                (admission.account_id, admission.session_id, admission.library_id)
                or opened_at>now):
            raise CaptureError('capture_scope_changed', 409)
        source, revision = _source_snapshot(connection, live, admission.path, constraints)
        if ((source['track_id'],source['file_id'],source['root_id'],revision) !=
                (admission.track_id,admission.file_id,admission.root_id,admission.inventory_source_revision)):
            raise CaptureError('capture_scope_changed', 409)
        values = dict(account_id=admission.account_id, map_ref=mapping.map_ref, owner_uuid=owner_uuid,
            auth_session_guard=admission.auth_session_guard, original_library_id=admission.library_id,
            original_track_id=admission.track_id, original_file_id=admission.file_id,
            original_root_id=admission.root_id, inventory_source_revision=revision,
            cohort_ref=mapping.cohort_ref, generation=generation, stream_id=stream_id,
            coordinate_rate_hz=mapping.coordinate_rate_hz, source_rate_hz=mapping.source_rate_hz,
            window_start_frame=mapping.window_start_frame, window_frames=mapping.window_frames,
            source_extent_frames=mapping.source_extent_frames, opened_at=opened_at)
        old = connection.execute('''select * from integration.playback_rate_map
            where account_id=%s and map_ref=%s''', (admission.account_id,mapping.map_ref)).fetchone()
        if old is not None:
            if any((str(old[k]) != v if k in {'map_ref','owner_uuid'} else old[k] != v) for k,v in values.items()):
                raise CaptureError('capture_conflict', 409)
            _final_authority(connection, live, constraints, clock, admission.track_id); _gate(enabled)
            return mapping.map_ref
        account, global_budget = _budgets(connection, live.actor.account_id, now)
        history, history_charge = _prepare_history_revision(connection, account)
        _reserve(connection, account, global_budget, MAP_BYTES+history_charge)
        if history is None:
            _insert_reserved_history_revision(connection, account)
        connection.execute('''insert into integration.playback_rate_map
            (account_id,map_ref,owner_uuid,auth_session_guard,original_library_id,original_track_id,
             original_file_id,original_root_id,inventory_source_revision,cohort_ref,generation,
             stream_id,coordinate_rate_hz,source_rate_hz,window_start_frame,window_frames,
             source_extent_frames,opened_at,observed_at,reservation_bytes,account_budget_id)
            values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,768,%s)''',
            (*values.values(), now, account['id']))
        _advance_history_proof(connection, live.actor.account_id)
        _final_authority(connection, live, constraints, clock, admission.track_id); _gate(enabled)
        return mapping.map_ref


def _resolve_maps(connection, live, evidence, scope, parent, constraints):
    refs = sorted({span['map_ref'] for span in evidence['spans']})
    if not refs:
        return {}, None
    rows = connection.execute('''select * from integration.playback_rate_map
        where account_id=%s and map_ref=any(%s::uuid[]) order by map_ref for share''',
        (live.actor.account_id,refs)).fetchall()
    if len(rows)!=len(refs):
        # Publication can finish after the first consumed report. Retry the same
        # immutable batch; never credit unknown maps or skip its owner sequence.
        raise CaptureError('capture_map_not_ready', 503)
    first = rows[0]
    source_row = connection.execute('''select private_path from library.local_track_files
        where id=%s and track_id=%s for share''',
        (first['original_file_id'],first['original_track_id'])).fetchone()
    if source_row is None:
        raise CaptureError('source_unavailable', 403)
    source, revision = _source_snapshot(connection, live, source_row['private_path'], constraints)
    mappings = {}
    for row in rows:
        if (row['original_library_id']!=live.library_id
                or str(row['owner_uuid'])!=evidence['owner_uuid']
                or not hmac.compare_digest(row['auth_session_guard'],scope)
                or row['coordinate_rate_hz']!=evidence['coordinate_rate_hz']
                or row['inventory_source_revision']!=revision
                or (row['original_track_id'],row['original_file_id'],row['original_root_id']) !=
                   (source['track_id'],source['file_id'],source['root_id'])
                or parent is not None and any(row[k]!=parent[k] for k in
                   ('original_track_id','original_file_id','original_root_id'))):
            raise CaptureError('capture_conflict', 409)
        mapping = RateMap(map_ref=str(row['map_ref']),cohort_ref=row['cohort_ref'],
            coordinate_rate_hz=row['coordinate_rate_hz'],source_rate_hz=row['source_rate_hz'],
            window_start_frame=row['window_start_frame'],window_frames=row['window_frames'],
            source_extent_frames=row['source_extent_frames'],owner_uuid=str(row['owner_uuid']),
            generation=row['generation'],stream_id=row['stream_id'])
        mappings[mapping.map_ref] = mapping
    try:
        normalize_spans(evidence['spans'],evidence['coordinate_rate_hz'],mappings)
    except RateEvidenceError:
        raise CaptureError('capture_conflict', 409) from None
    return mappings, source


def record_rate_checkpoint(database_url, context, envelope, *, expected_scope,
                           constraints=None, connect=None, clock=None,
                           enabled=lambda: False):
    """Persist one real checkpoint or return its unchanged authorized receipt.

    One owner is one actual AudioContext lifetime. Reports across track parents
    must flush/retry in owner_sequence order. Neither timestamp nor checkpoint
    arrival alone establishes continuity. Exact duplicates never advance history.
    """
    _gate(enabled)
    envelope = normalize_rate_capture_envelope(envelope)
    if (type(expected_scope) is not str or not expected_scope or not expected_scope.isascii()
            or len(expected_scope.encode())>256):
        raise CaptureError('capture_scope_changed', 409)
    evidence, sequence = envelope['evidence'], envelope['sequence']
    body = canonical_json(evidence)
    digest = hashlib.sha256(f'{PROTOCOL}\n{sequence}\n{body}'.encode()).hexdigest()
    clock = clock or (lambda: datetime.now(timezone.utc))
    with current_library_transaction(database_url, context, constraints=constraints,
            connect=connect or _bounded_connection, clock=clock,
            inventory_publication_first=True) as (connection, live, now):
        _selector(connection, live); require_rate_storage(connection); _gate(enabled)
        require_private_action(live, 'library.media.read', constraints=constraints)
        owner_key = f"rate-capture:{live.actor.account_id}:{expected_scope}:{evidence['owner_uuid']}"
        connection.execute('select pg_advisory_xact_lock(hashtextextended(%s,0))', (owner_key,))
        owner = connection.execute('''select * from integration.playback_capture_owner
            where account_id=%s and library_id=%s and auth_session_guard=%s
              and owner_uuid=%s and rate_coordinate_hz is not null''',
            (live.actor.account_id,live.library_id,expected_scope,evidence['owner_uuid'])).fetchone()
        if owner is not None and str(owner['device_uuid'])!=envelope['device_uuid']:
            raise CaptureError('capture_conflict', 409)
        if owner is None:
            # Do not silently convert an existing legacy owner to native rates.
            owner = connection.execute('''select * from integration.playback_capture_owner
                where account_id=%s and library_id=%s and device_uuid=%s
                  and auth_session_guard=%s and owner_uuid=%s''',
                (live.actor.account_id,live.library_id,envelope['device_uuid'],
                 expected_scope,evidence['owner_uuid'])).fetchone()
        parent = connection.execute('''select * from integration.playback_capture_session
            where account_id=%s and device_uuid=%s and capture_uuid=%s for update''',
            (live.actor.account_id,envelope['device_uuid'],envelope['capture_uuid'])).fetchone()
        if owner is not None and owner['rate_coordinate_hz']!=evidence['coordinate_rate_hz']:
            raise CaptureError('capture_conflict', 409)
        duplicate = None
        if parent is not None:
            if (parent['evidence_version']!=PROTOCOL or owner is None or parent['owner_id']!=owner['id']
                    or parent['library_id']!=live.library_id
                    or not hmac.compare_digest(parent['auth_session_guard'],expected_scope)
                    or str(parent['owner_uuid'])!=evidence['owner_uuid']
                    or parent['rate_coordinate_hz']!=evidence['coordinate_rate_hz']):
                raise CaptureError('capture_conflict', 409)
            duplicate = connection.execute('''select digest,receipt_body from integration.playback_capture_checkpoint
                where session_id=%s and sequence=%s''', (parent['id'],sequence)).fetchone()
            if duplicate is not None and duplicate['digest']!=digest:
                raise CaptureError('capture_conflict', 409)
        selection_ready = selection_schema_ready(connection)
        if duplicate is not None:
            # Re-authenticate original source and selection; deletion of optional
            # proof does not turn a committed receipt into a new admission.
            admit_capture_selection(connection,live,envelope,parent,None,
                constraints=constraints,schema_ready=selection_ready)
            _budgets(connection,live.actor.account_id,now)
            _final_authority(connection,live,constraints,clock,parent['original_track_id']); _gate(enabled)
            return dict(ok=True,capture_uuid=str(parent['capture_uuid']),**duplicate['receipt_body'])
        if parent is not None:
            if parent['terminal_at'] is not None:
                raise CaptureError('capture_terminal', 409)
            if sequence!=parent['last_sequence']+1:
                raise CaptureError('capture_sequence', 409)
            if now>parent['admitted_at']+timedelta(hours=24) and not (
                    evidence['terminal'] and not evidence['spans']):
                raise CaptureError('capture_limit', 409)
        elif sequence!=1 or not evidence['spans']:
            raise CaptureError('capture_sequence', 409)
        _mappings, source = _resolve_maps(connection,live,evidence,expected_scope,parent,constraints)
        if parent is None:
            count = connection.execute('''select count(*) as n from integration.playback_capture_session
                where account_id=%s and terminal_at is null and last_activity_at>%s''',
                (live.actor.account_id,now-timedelta(seconds=120))).fetchone()['n']
            if count>=32:
                raise CaptureError('capture_limit', 409)
        selected = admit_capture_selection(connection,live,envelope,parent,source,
            constraints=constraints,schema_ready=selection_ready)
        account, global_budget = _budgets(connection,live.actor.account_id,now)
        # Account/global budgets precede owner row locks, matching owner cleanup.
        previous = tail = None
        if owner is not None:
            owner = connection.execute('''select * from integration.playback_capture_owner
                where id=%s for update''', (owner['id'],)).fetchone()
            if owner is None or owner['account_budget_id']!=account['id']:
                raise CaptureError('capture_conflict', 409)
            previous = connection.execute('''select rate_owner_sequence from integration.playback_capture_checkpoint
                where rate_owner_id=%s order by rate_owner_sequence desc limit 1''', (owner['id'],)).fetchone()
            tail = connection.execute('''select evidence->'spans'->-1 as span
                from integration.playback_capture_checkpoint where rate_owner_id=%s
                  and case when jsonb_typeof(evidence->'spans')='array'
                    then jsonb_array_length(evidence->'spans')>0 else false end
                order by rate_owner_sequence desc limit 1''', (owner['id'],)).fetchone()
        if evidence['owner_sequence']!=(previous['rate_owner_sequence']+1 if previous else 1):
            raise CaptureError('capture_sequence', 409)
        previous_end = (tail['span']['output_start_frame']+
                        tail['span']['frame_count']*tail['span']['repeat_count']) if tail else None
        spans = evidence['spans']
        if spans and previous_end is not None and spans[0]['output_start_frame']<previous_end:
            raise CaptureError('capture_conflict', 409)
        has_gap = bool(spans and previous_end is not None and spans[0]['output_start_frame']>previous_end)
        has_gap = has_gap or any(b['output_start_frame']>a['output_start_frame']+a['frame_count']*a['repeat_count']
                                 for a,b in zip(spans,spans[1:]))
        known = sum(span['frame_count']*span['repeat_count'] for span in spans)
        total = (parent['accepted_known_frames'] if parent else 0)+known
        if total>MAX_INTEGER:
            raise CaptureError('capture_limit', 409)
        receipt = dict(sequence=sequence,owner_sequence=evidence['owner_sequence'],digest=digest,
            accepted_known_frames=total,accepted_lost_frames=0,terminal=evidence['terminal'])
        receipt_json = canonical_json(receipt)
        charge = 192+len(body.encode())+len(receipt_json.encode())
        history, history_charge = _prepare_history_revision(connection,account)
        amount = charge+history_charge+(1024 if owner is None else 0)+(384 if parent is None else 0)
        amount += ASSOCIATION_BYTES if selected is not None and selected['is_new'] else 0
        _reserve(connection,account,global_budget,amount)
        if history is None:
            _insert_reserved_history_revision(connection,account)
        if owner is None:
            owner = connection.execute('''insert into integration.playback_capture_owner
                (account_id,library_id,device_uuid,auth_session_guard,owner_uuid,account_budget_id,
                 reservation_bytes,rate_coordinate_hz) values(%s,%s,%s,%s,%s,%s,1024,%s) returning *''',
                (live.actor.account_id,live.library_id,envelope['device_uuid'],expected_scope,
                 evidence['owner_uuid'],account['id'],evidence['coordinate_rate_hz'])).fetchone()
        if parent is None:
            parent = connection.execute('''insert into integration.playback_capture_session
                (account_id,library_id,auth_session_guard,device_uuid,capture_uuid,evidence_version,
                 original_track_id,original_file_id,original_root_id,original_album_id,live_track_id,
                 live_album_id,disc_number,track_number,admitted_at,last_activity_at,reservation_bytes,
                 account_budget_id,owner_id,owner_uuid,rate_coordinate_hz)
                values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,384,%s,%s,%s,%s) returning *''',
                (live.actor.account_id,live.library_id,expected_scope,envelope['device_uuid'],envelope['capture_uuid'],
                 PROTOCOL,source['track_id'],source['file_id'],source['root_id'],source['album_id'],
                 source['track_id'],source['album_id'],source['disc_number'],source['track_number'],now,now,
                 account['id'],owner['id'],evidence['owner_uuid'],evidence['coordinate_rate_hz'])).fetchone()
        insert_capture_selection(connection,live,parent,selected,account)
        checkpoint = connection.execute('''insert into integration.playback_capture_checkpoint
            (session_id,sequence,digest,evidence,accepted_at,known_frames,lost_frames,terminal,
             terminal_reason,receipt_status,receipt_body,reservation_bytes,account_budget_id,
             rate_owner_id,rate_owner_sequence)
            values(%s,%s,%s,%s::jsonb,%s,%s,0,%s,%s,200,%s::jsonb,%s,%s,%s,%s) returning id''',
            (parent['id'],sequence,digest,body,now,known,evidence['terminal'],evidence['terminal_reason'],
             receipt_json,charge,account['id'],owner['id'],evidence['owner_sequence'])).fetchone()
        connection.execute('''update integration.playback_capture_session
            set last_sequence=%s,accepted_known_frames=%s,last_activity_at=%s,
                terminal_at=%s,terminal_reason=%s,has_gaps=has_gaps or %s,timing_unknown=true
            where id=%s''',
            (sequence,total,now,now if evidence['terminal'] else None,evidence['terminal_reason'],has_gap,parent['id']))
        _append_history_checkpoint(connection,live.actor.account_id,checkpoint['id'],has_loss=has_gap)
        admit_capture_selection(connection,live,envelope,parent,None,constraints=constraints,
            verify_current=selected is not None and selected['is_new'],schema_ready=selection_ready)
        _final_authority(connection,live,constraints,clock,parent['original_track_id']); _gate(enabled)
        return dict(ok=True,capture_uuid=str(parent['capture_uuid']),**receipt)
