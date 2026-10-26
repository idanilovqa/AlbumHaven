"""Transactional private app-reported playback ledger; no statistics cutover."""
from datetime import datetime, timedelta, timezone
import hmac

from music_app.services.admin_member_mutation_postgres import lock_current_actor_session
from music_app.services.current_library_selector import canonical_library_selector_sql
from music_app.services.playback_capture import (
    CaptureError, MAX_INTEGER, PROTOCOL, POSITION_PROTOCOL, canonical_json, capture_digest,
    normalize_capture_envelope, _validate_position_lineage,
)
from music_app.services.policy import ResourceScope
from music_app.services.private_library_authority import (
    current_library_transaction, require_private_action,
)

ACCOUNT_BYTES = 256 * 1024 * 1024
GLOBAL_BYTES = 4 * 1024 * 1024 * 1024
ANCHOR_COLUMNS = ('epoch', 'probe_id', 'output_frame', 'utc_lower_ms', 'utc_upper_ms',
                  'monotonic_probe_span_ms', 'max_quantum_frames', 'quality')


def _selector(connection, context):
    row = connection.execute(canonical_library_selector_sql()).fetchone()
    if row is None or row['id'] != context.library_id:
        raise CaptureError('capture_scope_changed', 409)


def _final_authority(connection, context, constraints, clock, track_id=None):
    lock_current_actor_session(connection, actor_account_id=context.actor.account_id,
                               actor_session_id=context.actor.session_id, clock=clock)
    _selector(connection, context)
    require_private_action(context, 'library.browse.read', constraints=constraints)
    resource = ResourceScope('track', str(track_id)) if track_id is not None else None
    require_private_action(context, 'library.media.read', resource=resource, constraints=constraints)


def check_capture_context(database_url, context, *, constraints=None, connect=None, clock=None):
    clock = clock or (lambda: datetime.now(timezone.utc))
    with current_library_transaction(database_url, context, constraints=constraints,
                                     connect=connect, clock=clock, read_only=True,
                                     inventory_publication_first=True) as (connection, live, _now):
        _selector(connection, live)
        _final_authority(connection, live, constraints, clock)


def _source(connection, context, path, constraints):
    if path is None:
        raise CaptureError('source_unavailable', 403)
    rows = connection.execute('''select t.id as track_id, f.id as file_id,
            r.id as root_id,t.album_id,t.disc_number,t.track_number
        from library.local_tracks t
        join library.local_track_files f on f.track_id=t.id
        join library.library_roots r on r.id=f.library_root_id
        where t.library_id=%s and r.library_id=%s and f.private_path=%s
          and f.scan_cache_stale=false and r.is_active=true
        limit 2 for share of t,f,r''', (context.library_id, context.library_id, path)).fetchall()
    if len(rows) != 1:
        raise CaptureError('source_unavailable', 403)
    source = rows[0]
    if source['album_id'] is not None:
        album = connection.execute('''select id from library.local_albums
            where id=%s and library_id=%s for share''',
            (source['album_id'], context.library_id)).fetchone()
        if album is None:
            raise CaptureError('source_unavailable', 403)
    require_private_action(context, 'library.media.read',
                           resource=ResourceScope('track', str(source['track_id'])), constraints=constraints)
    return source


def _budgets(connection, account_id, now):
    connection.execute('''insert into integration.playback_capture_budget(account_id,rate_updated_at)
        values(%s,%s) on conflict(account_id) do nothing''', (account_id, now))
    account = connection.execute('''select * from integration.playback_capture_budget
        where account_id=%s for update''', (account_id,)).fetchone()
    global_budget = connection.execute('''select * from integration.playback_capture_budget
        where is_global for update''').fetchone()
    if account is None or global_budget is None:
        raise CaptureError('capture_unavailable', 503)
    # PostgreSQL arithmetic keeps the bounded token bucket independent of binary
    # floating point. Replays consume a token but never consume storage again.
    charged = connection.execute('''update integration.playback_capture_budget
        set rate_tokens=least(8,rate_tokens+greatest(0,extract(epoch from (%s-rate_updated_at)))*2)-1,
            rate_updated_at=greatest(rate_updated_at,%s)
        where id=%s and least(8,rate_tokens+greatest(0,extract(epoch from (%s-rate_updated_at)))*2)>=1
        returning id''', (now, now, account['id'], now)).fetchone()
    if charged is None:
        raise CaptureError('capture_rate_limited', 429)
    return account, global_budget


def _reserve(connection, account, global_budget, amount):
    if account['reserved_bytes'] + amount > ACCOUNT_BYTES or global_budget['reserved_bytes'] + amount > GLOBAL_BYTES:
        raise CaptureError('capture_quota', 503)
    connection.execute('''update integration.playback_capture_budget
        set reserved_bytes=reserved_bytes+%s where id=any(%s)''',
        (amount, [account['id'], global_budget['id']]))


def _anchors(connection, parent, evidence):
    existing = {}
    needed = {(a['epoch'], a['probe_id']) for a in evidence['anchors']}
    needed.update(tuple(r[key]) for r in evidence['runs'] for key in ('anchor_before', 'anchor_after') if r[key] is not None)
    # Bounded by 520 references, independent of lifetime/history length.
    if parent is not None:
        for epoch, probe_id in sorted(needed):
            row = connection.execute('''select epoch,probe_id,output_frame,utc_lower_ms,utc_upper_ms,
                monotonic_probe_span_ms,max_quantum_frames,quality from integration.playback_capture_anchor
                where session_id=%s and epoch=%s and probe_id=%s''',
                (parent['id'], epoch, probe_id)).fetchone()
            if row is not None:
                existing[(epoch, probe_id)] = dict(row)
    additions = []
    for anchor in evidence['anchors']:
        key = anchor['epoch'], anchor['probe_id']
        if key in existing:
            if existing[key] != anchor:
                raise CaptureError('capture_conflict', 409)
        else:
            existing[key] = anchor
            additions.append(anchor)
    if (parent['anchor_count'] if parent else 0) + len(additions) > 17282:
        raise CaptureError('capture_limit', 409)
    for run in evidence['runs']:
        for key in ('anchor_before', 'anchor_after'):
            if run[key] is not None and tuple(run[key]) not in existing:
                raise CaptureError()
        if run['quality'] == 'bounded':
            before, after = (existing[tuple(run[key])] for key in ('anchor_before', 'anchor_after'))
            if (before['quality'] != 'bounded' or after['quality'] != 'bounded'
                    or before['output_frame'] > run['output_start']
                    or after['output_frame'] < run['output_start'] + run['frames']
                    or not 0 < after['output_frame'] - before['output_frame'] <= 480_000):
                raise CaptureError()
            # Reject impossible anchor intervals. Never substitute receipt time.
            for frame in (run['output_start'], run['output_start'] + run['frames']):
                lower = max(a['utc_lower_ms'] * 48 + frame - a['output_frame'] - 4800 for a in (before, after))
                upper = min(a['utc_upper_ms'] * 48 + frame - a['output_frame'] + 4800 for a in (before, after))
                if lower > upper:
                    raise CaptureError()
    return additions


def record_capture_checkpoint(database_url, context, envelope, *, expected_scope,
                              constraints=None, connect=None, clock=None):
    """Commit one immutable batch, or return its original authorized receipt."""
    envelope = normalize_capture_envelope(envelope)
    # Pure v2 validation is staged independently of v2 storage. Never digest or
    # persist v2 with the legacy schema/charges merely because parsing succeeds.
    if envelope['protocol'] != PROTOCOL:
        raise CaptureError('unsupported_capture_version')
    clock = clock or (lambda: datetime.now(timezone.utc))
    evidence = envelope['evidence']
    sequence = envelope['sequence']
    digest = capture_digest(sequence, evidence)
    with current_library_transaction(database_url, context, constraints=constraints,
                                     connect=connect, clock=clock,
                                     inventory_publication_first=True) as (connection, live, now):
        _selector(connection, live)
        require_private_action(live, 'library.media.read', constraints=constraints)
        owner_key = f"playback-capture:{live.actor.account_id}:{envelope['device_uuid']}:{envelope['capture_uuid']}"
        connection.execute('select pg_advisory_xact_lock(hashtextextended(%s,0))', (owner_key,))
        parent = connection.execute('''select * from integration.playback_capture_session
            where account_id=%s and device_uuid=%s and capture_uuid=%s for update''',
            (live.actor.account_id, envelope['device_uuid'], envelope['capture_uuid'])).fetchone()
        source = None
        duplicate = None
        if parent is not None:
            if parent['evidence_version'] != PROTOCOL:
                raise CaptureError('capture_conflict', 409)
            if parent['library_id'] != live.library_id or not hmac.compare_digest(parent['auth_session_guard'], expected_scope):
                raise CaptureError('capture_scope_changed', 409)
            require_private_action(live, 'library.media.read',
                resource=ResourceScope('track', str(parent['original_track_id'])), constraints=constraints)
            duplicate = connection.execute('''select digest,receipt_body from integration.playback_capture_checkpoint
                where session_id=%s and sequence=%s''', (parent['id'], sequence)).fetchone()
            if duplicate is not None and duplicate['digest'] != digest:
                raise CaptureError('capture_conflict', 409)
            if duplicate is None:
                if parent['terminal_at'] is not None:
                    raise CaptureError('capture_terminal', 409)
                if sequence != parent['last_sequence'] + 1:
                    raise CaptureError('capture_sequence', 409)
                if now > parent['admitted_at'] + timedelta(hours=24) and not (
                        evidence['terminal'] and not evidence['runs'] and not evidence['gaps'] and not evidence['anchors']):
                    raise CaptureError('capture_limit', 409)
        else:
            if sequence != 1:
                raise CaptureError('capture_sequence', 409)
            if not evidence['runs']:
                raise CaptureError()
            source = _source(connection, live, envelope.get('initial_path'), constraints)
            count = connection.execute('''select count(*) as n from integration.playback_capture_session
                where account_id=%s and terminal_at is null and last_activity_at>%s''',
                (live.actor.account_id, now-timedelta(seconds=120))).fetchone()['n']
            if count >= 32:
                raise CaptureError('capture_limit', 409)
        account, global_budget = _budgets(connection, live.actor.account_id, now)
        if duplicate is not None:
            _final_authority(connection, live, constraints, clock, parent['original_track_id'])
            return dict(ok=True, capture_uuid=str(parent['capture_uuid']), **duplicate['receipt_body'])
        if parent is not None and evidence['runs']:
            first = evidence['runs'][0]
            if ((parent['last_known_ordinal_end'] is not None and first['ordinal_start'] < parent['last_known_ordinal_end'])
                    or (parent['last_known_output_end'] is not None and first['output_start'] < parent['last_known_output_end'])):
                raise CaptureError('capture_conflict', 409)
        additions = _anchors(connection, parent, evidence)
        if not evidence['runs'] and not evidence['gaps'] and not evidence['terminal'] and not additions:
            raise CaptureError()
        known = sum(run['frames'] for run in evidence['runs'])
        lost = sum(gap['positive_frames'] for gap in evidence['gaps'])
        total_known = (parent['accepted_known_frames'] if parent else 0) + known
        total_lost = (parent['accepted_lost_frames'] if parent else 0) + lost
        if total_known + total_lost > MAX_INTEGER:
            raise CaptureError('capture_limit', 409)
        receipt = dict(sequence=sequence, digest=digest, accepted_known_frames=total_known,
                       accepted_lost_frames=total_lost, terminal=evidence['terminal'])
        body = canonical_json(evidence)
        receipt_json = canonical_json(receipt)
        checkpoint_charge = 192 + len(body.encode('utf-8')) + len(receipt_json.encode('utf-8'))
        amount = (256 if parent is None else 0) + checkpoint_charge + len(evidence['runs'])*128 + len(additions)*128
        _reserve(connection, account, global_budget, amount)
        if parent is None:
            parent = connection.execute('''insert into integration.playback_capture_session
                (account_id,library_id,auth_session_guard,device_uuid,capture_uuid,v1_session_uuid,evidence_version,
                 original_track_id,original_file_id,original_root_id,original_album_id,live_track_id,live_album_id,
                 disc_number,track_number,admitted_at,last_activity_at,reservation_bytes,account_budget_id)
                values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,256,%s) returning *''',
                (live.actor.account_id, live.library_id, expected_scope, envelope['device_uuid'], envelope['capture_uuid'],
                 envelope.get('v1_session_uuid'), PROTOCOL, source['track_id'], source['file_id'], source['root_id'],
                 source['album_id'], source['track_id'], source['album_id'], source['disc_number'], source['track_number'],
                 now, now, account['id'])).fetchone()
        checkpoint = connection.execute('''insert into integration.playback_capture_checkpoint
            (session_id,sequence,digest,evidence,accepted_at,known_frames,lost_frames,terminal,terminal_reason,
             receipt_status,receipt_body,reservation_bytes,account_budget_id)
            values(%s,%s,%s,%s::jsonb,%s,%s,%s,%s,%s,200,%s::jsonb,%s,%s) returning id''',
            (parent['id'], sequence, digest, body, now, known, lost, evidence['terminal'], evidence['terminal_reason'],
             receipt_json, checkpoint_charge, account['id'])).fetchone()
        for anchor in additions:
            connection.execute('''insert into integration.playback_capture_anchor
                (session_id,epoch,probe_id,output_frame,utc_lower_ms,utc_upper_ms,monotonic_probe_span_ms,
                 max_quantum_frames,quality,reservation_bytes,account_budget_id)
                values(%s,%s,%s,%s,%s,%s,%s,%s,%s,128,%s)''',
                (parent['id'], *(anchor[key] for key in ANCHOR_COLUMNS), account['id']))
        for index, run in enumerate(evidence['runs']):
            connection.execute('''insert into integration.playback_capture_run
                (checkpoint_id,run_index,source_start48,frames,output_start,ordinal_start,epoch,
                 anchor_before,anchor_after,quality,reservation_bytes,account_budget_id)
                values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,128,%s)''',
                (checkpoint['id'], index, run['source_start48'], run['frames'], run['output_start'],
                 run['ordinal_start'], run['epoch'], run['anchor_before'][1] if run['anchor_before'] else None,
                 run['anchor_after'][1] if run['anchor_after'] else None, run['quality'], account['id']))
        starts = [r['ordinal_start'] for r in evidence['runs']] + [g['ordinal_start'] for g in evidence['gaps']]
        ends = [r['ordinal_start']+r['frames'] for r in evidence['runs']] + [g['ordinal_end'] for g in evidence['gaps']]
        connection.execute('''update integration.playback_capture_session set last_sequence=%s,
            accepted_known_frames=%s,accepted_lost_frames=%s,last_activity_at=%s,
            ordinal_start=least(ordinal_start,%s),ordinal_end=greatest(ordinal_end,%s),
            last_known_ordinal_end=coalesce(%s,last_known_ordinal_end),
            last_known_output_end=coalesce(%s,last_known_output_end),
            terminal_at=%s,terminal_reason=%s,has_gaps=has_gaps or %s,
            timing_unknown=timing_unknown or %s,anchor_count=anchor_count+%s where id=%s''',
            (sequence, total_known, total_lost, now, min(starts) if starts else None, max(ends) if ends else None,
             evidence['runs'][-1]['ordinal_start']+evidence['runs'][-1]['frames'] if evidence['runs'] else None,
             evidence['runs'][-1]['output_start']+evidence['runs'][-1]['frames'] if evidence['runs'] else None,
             now if evidence['terminal'] else None, evidence['terminal_reason'], bool(evidence['gaps']),
             any(r['quality']=='unknown' for r in evidence['runs']) or bool(evidence['gaps']), len(additions), parent['id']))
        _final_authority(connection, live, constraints, clock, parent['original_track_id'])
        return dict(ok=True, capture_uuid=str(parent['capture_uuid']), **receipt)



def _position_edge(before, after):
    """Necessary ordered-lineage laws only, never proof of uninterrupted audio."""
    if (before['ordinal_start'] + before['frames'] > after['ordinal_start']
            or before['output_start'] + before['frames'] > after['output_start']):
        raise CaptureError('capture_conflict', 409)
    try:
        _validate_position_lineage((before, after))
    except CaptureError:
        raise CaptureError('capture_conflict', 409) from None


def _position_witnesses(connection, owner, parent, runs):
    """Three indexed witnesses/run, at most768 rows, not a fixed I/O/time bound.

    The enclosing real authority transaction holds the account UPDATE lock.
    Do not replace ordinal neighbors with receipt-order owner high-water marks.
    Driver timeout/cancellation/error propagates and aborts the transaction;
    never reinterpret incomplete probes as absent evidence.
    """
    if owner is None:
        return
    parent_id = parent['id'] if parent else None
    for run in runs:
        witness = connection.execute('''select r.*,c.session_id as parent_id
            from integration.playback_capture_run r
            join integration.playback_capture_checkpoint c on c.id=r.checkpoint_id
            where r.owner_id=%s and r.binding_serial=%s limit 1''',
            (owner['id'], run['binding_serial'])).fetchone()
        if witness is not None and (
                witness['parent_id'] != parent_id
                or any(witness[key] != run[key] for key in
                       ('generation', 'stream_id', 'source_base48'))):
            raise CaptureError('capture_conflict', 409)
        before = connection.execute('''select * from integration.playback_capture_run
            where owner_id=%s and ordinal_start<%s
            order by ordinal_start desc limit 1''',
            (owner['id'], run['ordinal_start'])).fetchone()
        after = connection.execute('''select * from integration.playback_capture_run
            where owner_id=%s and ordinal_start>=%s
            order by ordinal_start asc limit 1''',
            (owner['id'], run['ordinal_start'])).fetchone()
        if before is not None:
            _position_edge(before, run)
        if after is not None:
            _position_edge(run, after)
    # normalize_capture_envelope already checked adjacent new runs and every
    # new same-binding group. Combined with both stored neighbors this preserves
    # the induction without loading/merging unbounded retained owner history.

def _record_position_checkpoint(database_url, context, envelope, *, expected_scope,
                              constraints=None, connect=None, clock=None, require_position_storage_ready=False, position_enabled=None):
    """Private v2 writer, called only by the opt-in companion transport.

    Public v1 intake never dispatches here. Companion requests require fresh
    structural storage readiness inside this transaction before any admission.
    All database failures abort; post-commit acknowledgement can be uncertain.
    """
    from music_app.services.playback_edition_selection import (
        normalize_selected_position_envelope, admit_capture_selection,
        insert_capture_selection, selection_schema_ready, ASSOCIATION_BYTES,
    )
    def require_current_gate():
        if require_position_storage_ready and (not callable(position_enabled) or position_enabled() is not True):
            raise CaptureError('capture_unavailable',503)
    require_current_gate()
    envelope = normalize_selected_position_envelope(envelope)
    if envelope['protocol'] != POSITION_PROTOCOL:
        raise CaptureError('unsupported_capture_version')
    if (type(expected_scope) is not str or not expected_scope or not expected_scope.isascii()
            or len(expected_scope.encode('utf-8')) > 256):
        raise CaptureError('capture_scope_changed', 409)
    clock = clock or (lambda: datetime.now(timezone.utc))
    evidence = envelope['evidence']
    sequence = envelope['sequence']
    digest = capture_digest(sequence, evidence, protocol=POSITION_PROTOCOL)
    with current_library_transaction(database_url, context, constraints=constraints,
                                     connect=connect, clock=clock,
                                     inventory_publication_first=True) as (connection, live, now):
        _selector(connection, live)
        require_private_action(live, 'library.media.read', constraints=constraints)
        require_current_gate()
        if require_position_storage_ready is True:
            from music_app.services.playback_position_transport import require_position_storage
            require_position_storage(connection)
        # Nonlocking owner resolution under the authority account UPDATE lock.
        # Owner insertion/FK locks come only after account/global budgets.
        owner = connection.execute('''select * from integration.playback_capture_owner
            where account_id=%s and library_id=%s and device_uuid=%s
              and auth_session_guard=%s and owner_uuid=%s''',
            (live.actor.account_id, live.library_id, envelope['device_uuid'],
             expected_scope, evidence['owner_uuid'])).fetchone()
        owner_key = f"playback-capture:{live.actor.account_id}:{envelope['device_uuid']}:{envelope['capture_uuid']}"
        connection.execute('select pg_advisory_xact_lock(hashtextextended(%s,0))', (owner_key,))
        parent = connection.execute('''select * from integration.playback_capture_session
            where account_id=%s and device_uuid=%s and capture_uuid=%s for update''',
            (live.actor.account_id, envelope['device_uuid'], envelope['capture_uuid'])).fetchone()
        source = None
        duplicate = None
        if parent is not None:
            # Bind protocol and original owner BEFORE retry/receipt lookup.
            if (parent['evidence_version'] != POSITION_PROTOCOL or owner is None
                    or parent['owner_id'] != owner['id']
                    or str(parent['owner_uuid']) != evidence['owner_uuid']):
                raise CaptureError('capture_conflict', 409)
            if parent['library_id'] != live.library_id or not hmac.compare_digest(parent['auth_session_guard'], expected_scope):
                raise CaptureError('capture_scope_changed', 409)
            require_private_action(live, 'library.media.read',
                resource=ResourceScope('track', str(parent['original_track_id'])), constraints=constraints)
            duplicate = connection.execute('''select digest,receipt_body from integration.playback_capture_checkpoint
                where session_id=%s and sequence=%s''', (parent['id'], sequence)).fetchone()
            if duplicate is not None and duplicate['digest'] != digest:
                raise CaptureError('capture_conflict', 409)
            if duplicate is None:
                if parent['terminal_at'] is not None:
                    raise CaptureError('capture_terminal', 409)
                if sequence != parent['last_sequence'] + 1:
                    raise CaptureError('capture_sequence', 409)
                if now > parent['admitted_at'] + timedelta(hours=24) and not (
                        evidence['terminal'] and not evidence['runs'] and not evidence['gaps'] and not evidence['anchors']):
                    raise CaptureError('capture_limit', 409)
        else:
            if sequence != 1:
                raise CaptureError('capture_sequence', 409)
            if not evidence['runs']:
                raise CaptureError()
            source = _source(connection, live, envelope.get('initial_path'), constraints)
            count = connection.execute('''select count(*) as n from integration.playback_capture_session
                where account_id=%s and terminal_at is null and last_activity_at>%s''',
                (live.actor.account_id, now-timedelta(seconds=120))).fetchone()['n']
            if count >= 32:
                raise CaptureError('capture_limit', 409)
        # Reuse only within this one transaction, never as cross-request authority.
        selection_ready = selection_schema_ready(connection)
        selected = admit_capture_selection(connection, live, envelope, parent, source,
            constraints=constraints, schema_ready=selection_ready)
        if duplicate is None:
            _position_witnesses(connection, owner, parent, evidence['runs'])
        account, global_budget = _budgets(connection, live.actor.account_id, now)
        if owner is not None and owner['account_budget_id'] != account['id']:
            raise CaptureError('capture_conflict', 409)
        if duplicate is not None:
            from music_app.services.playback_decoder_observation import validate_known_observations
            validate_known_observations(connection,live,parent,evidence,expected_scope)
            _final_authority(connection, live, constraints, clock, parent['original_track_id'])
            require_current_gate()
            return dict(ok=True, capture_uuid=str(parent['capture_uuid']), **duplicate['receipt_body'])
        if parent is not None and evidence['runs']:
            first = evidence['runs'][0]
            if ((parent['last_known_ordinal_end'] is not None and first['ordinal_start'] < parent['last_known_ordinal_end'])
                    or (parent['last_known_output_end'] is not None and first['output_start'] < parent['last_known_output_end'])):
                raise CaptureError('capture_conflict', 409)
        additions = _anchors(connection, parent, evidence)
        if not evidence['runs'] and not evidence['gaps'] and not evidence['terminal'] and not additions:
            raise CaptureError()
        known = sum(run['frames'] for run in evidence['runs'])
        lost = sum(gap['positive_frames'] for gap in evidence['gaps'])
        total_known = (parent['accepted_known_frames'] if parent else 0) + known
        total_lost = (parent['accepted_lost_frames'] if parent else 0) + lost
        if total_known + total_lost > MAX_INTEGER:
            raise CaptureError('capture_limit', 409)
        receipt = dict(sequence=sequence, digest=digest, accepted_known_frames=total_known,
                       accepted_lost_frames=total_lost, terminal=evidence['terminal'])
        body = canonical_json(evidence)
        receipt_json = canonical_json(receipt)
        checkpoint_charge = 192 + len(body.encode('utf-8')) + len(receipt_json.encode('utf-8'))
        from music_app.services.playback_capture_history_revision import (
            _prepare_history_revision, _insert_reserved_history_revision,
            _append_history_checkpoint,
        )
        history_revision, history_charge = _prepare_history_revision(connection, account)
        amount = ((1024 if owner is None else 0) + (384 if parent is None else 0)
                  + checkpoint_charge + len(evidence['runs'])*320
                  + len(additions)*128 + len(evidence['gaps'])*384 + history_charge
                  + (ASSOCIATION_BYTES if selected is not None and selected['is_new'] else 0))
        # Exactly one debit against the locked pre-reservation budget snapshots.
        # Future co-created sidecars must join this amount, never reserve again.
        _reserve(connection, account, global_budget, amount)
        if history_revision is None:
            _insert_reserved_history_revision(connection, account)
        if owner is None:
            # A new owner is reserved and inserted only with this new parent in
            # the same transaction; no owner-only success path is reachable.
            owner = connection.execute('''insert into integration.playback_capture_owner
                (account_id,library_id,device_uuid,auth_session_guard,owner_uuid,
                 account_budget_id,reservation_bytes) values(%s,%s,%s,%s,%s,%s,1024) returning *''',
                (live.actor.account_id, live.library_id, envelope['device_uuid'],
                 expected_scope, evidence['owner_uuid'], account['id'])).fetchone()
        if parent is None:
            parent = connection.execute('''insert into integration.playback_capture_session
                (account_id,library_id,auth_session_guard,device_uuid,capture_uuid,v1_session_uuid,evidence_version,
                 original_track_id,original_file_id,original_root_id,original_album_id,live_track_id,live_album_id,
                 disc_number,track_number,admitted_at,last_activity_at,reservation_bytes,account_budget_id,owner_id,owner_uuid)
                values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,384,%s,%s,%s) returning *''',
                (live.actor.account_id, live.library_id, expected_scope, envelope['device_uuid'], envelope['capture_uuid'],
                 envelope.get('v1_session_uuid'), POSITION_PROTOCOL, source['track_id'], source['file_id'], source['root_id'],
                 source['album_id'], source['track_id'], source['album_id'], source['disc_number'], source['track_number'],
                 now, now, account['id'], owner['id'], evidence['owner_uuid'])).fetchone()
        from music_app.services.playback_decoder_observation import validate_known_observations
        validate_known_observations(connection,live,parent,evidence,expected_scope)
        insert_capture_selection(connection, live, parent, selected, account)
        checkpoint = connection.execute('''insert into integration.playback_capture_checkpoint
            (session_id,sequence,digest,evidence,accepted_at,known_frames,lost_frames,terminal,terminal_reason,
             receipt_status,receipt_body,reservation_bytes,account_budget_id)
            values(%s,%s,%s,%s::jsonb,%s,%s,%s,%s,%s,200,%s::jsonb,%s,%s) returning id''',
            (parent['id'], sequence, digest, body, now, known, lost, evidence['terminal'], evidence['terminal_reason'],
             receipt_json, checkpoint_charge, account['id'])).fetchone()
        for anchor in additions:
            connection.execute('''insert into integration.playback_capture_anchor
                (session_id,epoch,probe_id,output_frame,utc_lower_ms,utc_upper_ms,monotonic_probe_span_ms,
                 max_quantum_frames,quality,reservation_bytes,account_budget_id)
                values(%s,%s,%s,%s,%s,%s,%s,%s,%s,128,%s)''',
                (parent['id'], *(anchor[key] for key in ANCHOR_COLUMNS), account['id']))
        for index, run in enumerate(evidence['runs']):
            connection.execute('''insert into integration.playback_capture_run
                (checkpoint_id,run_index,source_start48,frames,output_start,ordinal_start,epoch,
                 anchor_before,anchor_after,quality,reservation_bytes,account_budget_id,
                 owner_id,binding_serial,generation,stream_id,source_base48,continuity_serial)
                values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,320,%s,%s,%s,%s,%s,%s,%s)''',
                (checkpoint['id'], index, run['source_start48'], run['frames'], run['output_start'],
                 run['ordinal_start'], run['epoch'], run['anchor_before'][1] if run['anchor_before'] else None,
                 run['anchor_after'][1] if run['anchor_after'] else None, run['quality'], account['id'],
                 owner['id'], run['binding_serial'], run['generation'], run['stream_id'],
                 run['source_base48'], run['continuity_serial']))
        for index, gap in enumerate(evidence['gaps']):
            connection.execute('''insert into integration.playback_capture_loss
                (checkpoint_id,gap_index,owner_id,ordinal_start,ordinal_end,output_start,
                 output_end,account_budget_id,reservation_bytes)
                values(%s,%s,%s,%s,%s,%s,%s,%s,384)''',
                (checkpoint['id'], index, owner['id'], gap['ordinal_start'], gap['ordinal_end'],
                 gap['output_start'], gap['output_end'], account['id']))
        starts = [r['ordinal_start'] for r in evidence['runs']] + [g['ordinal_start'] for g in evidence['gaps']]
        ends = [r['ordinal_start']+r['frames'] for r in evidence['runs']] + [g['ordinal_end'] for g in evidence['gaps']]
        connection.execute('''update integration.playback_capture_session set last_sequence=%s,
            accepted_known_frames=%s,accepted_lost_frames=%s,last_activity_at=%s,
            ordinal_start=least(ordinal_start,%s),ordinal_end=greatest(ordinal_end,%s),
            last_known_ordinal_end=coalesce(%s,last_known_ordinal_end),
            last_known_output_end=coalesce(%s,last_known_output_end),
            terminal_at=%s,terminal_reason=%s,has_gaps=has_gaps or %s,
            timing_unknown=timing_unknown or %s,anchor_count=anchor_count+%s where id=%s''',
            (sequence, total_known, total_lost, now, min(starts) if starts else None, max(ends) if ends else None,
             evidence['runs'][-1]['ordinal_start']+evidence['runs'][-1]['frames'] if evidence['runs'] else None,
             evidence['runs'][-1]['output_start']+evidence['runs'][-1]['frames'] if evidence['runs'] else None,
             now if evidence['terminal'] else None, evidence['terminal_reason'], bool(evidence['gaps']),
             any(r['quality']=='unknown' for r in evidence['runs']) or bool(evidence['gaps']), len(additions), parent['id']))
        _append_history_checkpoint(connection, live.actor.account_id, checkpoint['id'],
                                   has_loss=bool(evidence['gaps']))
        admit_capture_selection(connection, live, envelope, parent, None, constraints=constraints,
            verify_current=selected is not None and selected['is_new'], schema_ready=selection_ready)
        _final_authority(connection, live, constraints, clock, parent['original_track_id'])
        require_current_gate()
        return dict(ok=True, capture_uuid=str(parent['capture_uuid']), **receipt)
