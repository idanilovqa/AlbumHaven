"""Private outer Apply reconstruction. No request factory or route is supplied.

Only a genuine native current_foobar_import_transaction may invoke these private
stages. Any failure must escape and abort that transaction. Runtime, route and
factory activation are not supplied by this draft.
"""
from datetime import date
import json

from . import foobar_account_apply_command as apply_command
from . import foobar_account_import_prepare as prepare
from . import foobar_account_prepare_gate as gate
from . import foobar_account_source_postgres as source
from . import foobar_account_import_associations as associations
from . import foobar_account_import_jobs as jobs
from .foobar_account_match_readiness import require_foobar_match_schema_on_connection
from . import track_preferences_postgres as taste
from .foobar_account_source_postgres import SourceUnavailable, SourceStale
from .private_library_authority import PrivateLibraryAuthorityError

# Same reserved-null scope frame as the account lock/clock owner. This is
# a native key lookup, not a simulated ticket or replacement storage adapter.
_APPLY_KEY_SQL = gate._FRAME + """
select k.operation,encode(k.command_sha256,'hex') command_sha256,
 k.original_receipt_ref::text original_receipt_ref,
 k.receipt_ref::text receipt_ref,k.state,clock_timestamp() observed_at
from scope x join integration.foobar_import_request_keys_v2 k
 on (k.account_id,k.source_ref,k.generation,k.request_key)=
    (x.account_id,x.source_ref,x.generation,x.request_key)
"""
_KEY_FIELDS = ('operation','command_sha256','original_receipt_ref',
               'receipt_ref','state','observed_at')


def _optional_original(original):
    if (type(original) is not tuple or len(original) != 5
            or type(original[1]) is not tuple or len(original[1]) != 17
            or type(original[2]) is not tuple or type(original[3]) is not tuple
            or type(original[4]) is not tuple or len(original[4]) != len(original[2])):
        raise SourceUnavailable()
    if original[1][1] is not None and not gate._integer(original[1][1],1,gate._MAX):
        raise SourceUnavailable()
    if original[1][1] is None or original[1][10]==gate.ENHANCED_MAPPING:
        if original[3] != () or any(type(row) is not tuple or len(row) != 12
                or row[9] is not None or row[10] is not None or row[11] is not False
                for row in original[2]):
            raise SourceUnavailable()


def _apply_key_result(rows, *, command, command_sha256, earlier):
    """Classify only the real scoped key. Missing is not permission to write."""
    if type(rows) is not list or len(rows) > 1:
        raise SourceUnavailable()
    if not rows:
        return False, earlier
    row = rows[0]
    if type(row) is not dict or tuple(row) != _KEY_FIELDS:
        raise SourceUnavailable()
    try:
        prepare._utc(row['observed_at'])
        if (row['operation'] not in ('prepare','apply')
                or not gate._hex(row['command_sha256'])
                or not gate._uuid(row['original_receipt_ref'])
                or row['state'] not in ('active','tombstone')
                or row['observed_at'] < earlier):
            raise SourceUnavailable()
        if (row['operation'] != 'apply' or row['command_sha256'] != command_sha256
                or row['original_receipt_ref'] != command.receipt_ref):
            raise SourceStale()
        if row['state'] == 'tombstone':
            if row['receipt_ref'] is not None:
                raise SourceUnavailable()
            raise SourceStale()
        if not gate._uuid(row['receipt_ref']) or row['receipt_ref'] != command.receipt_ref:
            raise SourceUnavailable()
        return True, row['observed_at']
    except SourceUnavailable:
        raise
    except Exception:
        raise SourceUnavailable() from None


def _original_command_from_scalar(row, *, command, live, earlier):
    """Derive the actual original command, never client-selected decisions.

    Only bounded database scalars enter. The genuine envelope owner validates
    header grammar here; full lifecycle/key and original-integrity validation
    still follow through their actual owners. No scalar check proves payloads.
    """
    if type(row) is not dict or tuple(row) != prepare._RECEIPT_KEYS:
        raise SourceUnavailable()
    try:
        prepare._utc(row['observed_at'])
        if (row['observed_at'] < earlier
                or not gate._integer(row['original_session_id'],1,gate._MAX)
                or not gate._integer(row['expected_revision'],0,gate._MAX)
                or not gate._integer(row['window_start'],1,100000)
                or not gate._uuid(row['prepare_key'])
                or not gate._hex(row['upload_sha256'])
                or not gate._hex(row['inventory_sha256'])
                or row['mapping_name'] not in (gate.MAPPING,gate.ENHANCED_MAPPING)):
            raise SourceUnavailable()
        prepare._utc(row['expires_at'])
        if row['observed_at'] >= row['expires_at']:
            raise SourceStale()
        if row['original_session_id'] != live.actor.session_id:
            raise SourceStale()
        original = gate.FoobarPrepareCommand(
            command.source_ref,command.generation,row['prepare_key'],
            row['expected_revision'],row['upload_sha256'],row['mapping_name'],
            row['window_start']-1,row['inventory_sha256'],command.matching_library_id)
        gate.validate_prepare_command(original)
        header=(live.actor.account_id,command.matching_library_id,row['original_session_id'],command.source_ref,
            command.generation,row['prepare_key'],command.receipt_ref,row['expected_revision'],
            row['upload_sha256'],row['parser_version'],row['mapping_name'],row['total_rows'],
            row['window_start'],row['window_end'],row['inventory_sha256'],row['authority_sha256'],
            prepare._utc(row['created_at']))
        # The actual envelope owner establishes the complete bounded header,
        # including original Unix-day generation and offset/window association.
        prepare.envelope._header(header,original)
        if (not gate._hex(row['prepared_sha256']) or not gate._hex(row['decision_sha256'])
                or row['state'] not in ('ready','committed')
                or not gate._integer(row['prepared_size'],0,prepare.envelope.MAX_BYTES)
                or not gate._integer(row['terminal_size'],0,prepare.terminal_codec.MAX_WIRE_BYTES)):
            raise SourceUnavailable()
        return original, row['observed_at']
    except SourceUnavailable:
        raise
    except Exception:
        # Stored malformed scalars are not an external malformed command.
        raise SourceUnavailable() from None


def _apply_receipt_entry(connection, live, *, command, constraints):
    """Real locked stream/key/scalar entry; no ready/replay public result.

    Fixed entry phase: 32768 caller/control bytes plus the genuine gate's
    complete frame/result/forwarding phase and actual Apply command encoding.
    Initial entry has no payload or typed source/taste arrays. Rechecks must
    separately admit every retained original/source/postimage/terminal owner
    PLUS this phase; neither this local guard nor returning proves that sum.
    The caller owns original verification, fresh final checks and commit.
    """
    apply_command.validate_apply_command(command)
    prepare._private(32768+gate.PREPARE_GATE_BYTES+apply_command.MAX_PHASE_BYTES)
    try:
        if type(connection) is not prepare._Connection:
            raise SourceUnavailable()
        source._foobar_taste_connection(connection)
        prepare._account_context(live)
        source._authority(live,constraints)
        digest = apply_command.apply_command_digest(command,account_id=live.actor.account_id,
            library_id=command.matching_library_id,session_id=live.actor.session_id)
        values = (live.actor.account_id,live.library_id,live.actor.session_id,
                  command.source_ref,command.generation,command.request_key)
        frame = json.dumps(values,ensure_ascii=True,separators=(',',':'),allow_nan=False).encode('ascii')
        if len(frame) > gate.MAX_FRAME_BYTES:
            raise SourceUnavailable()
        locked = source._query(connection,gate._LOCK_SQL,frame,maximum=1)
        locked_state = gate._stream_result(locked)
        earlier = locked_state['observed_at']
        prepare._utc(earlier)
        del locked,locked_state
        # Mandatory accepted clock/high-water/current-generation touch remains
        # even on exact replay. It does not consume a request key/reservation.
        rolled = source._query(connection,gate._ROLL_SQL,frame,maximum=1)
        stream = gate._stream_result(rolled)
        prepare._utc(stream['observed_at'])
        if (stream['observed_at'] < earlier or stream['current_generation'] !=
                (stream['observed_at'].date()-date(1970,1,1)).days):
            raise SourceUnavailable()
        if not stream['retired_through'] < command.generation <= stream['current_generation']:
            raise SourceStale()
        earlier = stream['observed_at']
        del rolled,stream
        # Watermark check above precedes every key/receipt lookup.
        keys = source._query(connection,_APPLY_KEY_SQL,frame,maximum=1)
        key_exists,earlier = _apply_key_result(keys,command=command,
                                              command_sha256=digest,earlier=earlier)
        del keys,frame,values,digest
        values = (live.actor.account_id,live.library_id,command.source_ref,
                  command.generation,command.receipt_ref)
        frame = json.dumps(values,ensure_ascii=True,separators=(',',':'),allow_nan=False).encode('ascii')
        rows = source._query(connection,prepare._RECEIPT_SCALAR_SQL,frame,maximum=1)
        if not rows:
            if key_exists:
                raise SourceUnavailable()
            raise SourceStale()
        original_command,earlier = _original_command_from_scalar(rows[0],command=command,
                                                                 live=live,earlier=earlier)
        del rows,frame,values
        # Verify the mandatory original-key association as trusted receipt
        # integrity before invoking the external-request classifier. Otherwise
        # a malformed stored header/key pair could be mislabeled client stale.
        values=(live.actor.account_id,live.library_id,live.actor.session_id,
                command.source_ref,command.generation,original_command.request_key)
        frame=json.dumps(values,ensure_ascii=True,separators=(',',':'),allow_nan=False).encode('ascii')
        keys=source._query(connection,_APPLY_KEY_SQL,frame,maximum=1)
        if len(keys)!=1 or type(keys[0]) is not dict or tuple(keys[0])!=_KEY_FIELDS:
            raise SourceUnavailable()
        key=keys[0]
        prepare._utc(key['observed_at'])
        original_digest=gate.prepare_command_digest(original_command,
            account_id=live.actor.account_id,library_id=command.matching_library_id,session_id=live.actor.session_id)
        if (key['operation']!='prepare' or not gate._hex(key['command_sha256'])
                or key['original_receipt_ref']!=command.receipt_ref
                or key['receipt_ref']!=command.receipt_ref or key['state']!='active'
                or key['observed_at']<earlier):
            raise SourceUnavailable()
        # Original scope is command data on replay. A different scope cannot
        # reinterpret an existing account-owned receipt or its original key.
        if key['command_sha256']!=original_digest:
            raise SourceStale()
        earlier=key['observed_at']
        del keys,key,frame,values,original_digest
        # This is the genuine original Prepare-key lookup/receipt classifier,
        # not a manufactured FoobarPrepareTicket carrying client assertions.
        ticket = gate.begin_foobar_prepare_on_connection(connection,live,
            command=original_command,constraints=constraints)
        if (ticket.disposition not in ('ready_replay','committed_replay')
                or ticket.receipt_ref != command.receipt_ref or ticket.observed_at < earlier):
            raise SourceUnavailable()
        header,scalar = prepare._receipt_scalar(connection,live,command=original_command,ticket=ticket)
        if ticket.disposition == 'ready_replay':
            if key_exists:
                raise SourceUnavailable()
        else:
            if scalar['apply_key'] != command.request_key:
                raise SourceStale()
            if not key_exists:
                raise SourceUnavailable()
        # External decision mismatch is deliberately NOT classified here. The
        # next stage first verifies the trusted original or immutable terminal.
        source._authority(live,constraints)
        return original_command,header,scalar,ticket
    except (SourceUnavailable,apply_command.ApplyInvalid):
        raise
    except Exception:
        raise SourceUnavailable() from None


def _apply_inventory(connection, live, *, original_command, constraints, capacity):
    inventory=prepare._read_account_inventory(connection,live,original_command,
        constraints=constraints,capacity=capacity)
    if inventory.revision != original_command.inventory_sha256:
        raise SourceStale()
    return inventory


def _complete_inventory_fence(connection, live, *, original_command, files, targets, constraints):
    if original_command.matching_library_id is None:
        prepare._account_context(live)
        if type(files) is not tuple or files != () or type(targets) is not tuple or targets != ():
            raise SourceUnavailable()
        inventory=prepare._account_inventory(live,original_command,constraints=constraints)
        if inventory.files != files or inventory.targets != targets:
            raise SourceStale()
    else:
        if live.library_id != original_command.matching_library_id:
            raise SourceStale()
        current=prepare.read_foobar_inventory_scalars_on_connection(connection,live,constraints=constraints)
        if current != files:
            raise SourceStale()
        del current
        prepare._check_complete_inventory_policy(live,targets,constraints=constraints)


def _postimage_hold_bytes(target_count):
    if type(target_count) is not int or not 0 <= target_count <= 100:
        raise SourceUnavailable()
    # Six separately retained/forwarded post-state and outcome array views:
    # paired result, caller extraction, fence input, comparison/read handoff,
    # finalizer adjacency and final private output transition. No alias credit.
    return 6*((1024*target_count+2)+(128*target_count+2))+256


def _association_hold_bytes(count, prepared_bytes):
    """Conservative v3 association reservation shared with Prepare/finalizer.

    Flat ten-member seals are at most216 bytes each, plus array separators.
    Count separate retained/forwarded views without alias credit. The extra
    whole-original views cover row handoffs through the genuine adapters; the
    association owner supplies its actual bounded scalar/SQL phase separately.
    """
    if (type(count) is not int or not 1 <= count <= 100
            or type(prepared_bytes) is not int or not 1 <= prepared_bytes <= prepare.envelope.MAX_BYTES):
        raise SourceUnavailable()
    return (jobs.JOB_PHASE_BYTES+8*prepared_bytes+6*(217*count+1)
            +6*associations.association_outcome_bytes(count)
            +associations.association_phase_bytes(count))


def _scalar_counter_phase_bytes(prepared_bytes, *, source_count, taste_count):
    """Pre-admit the complete recursive counter prefix using trusted scalars.

    P is the fetched READY body's length, established before decoding and bound
    to the immutable canonical original by the genuine envelope owner. This is
    not a public budget or an unverified caller assertion. Envelope arrays have
    depth at most four. Every argument/local, iterator, item and conservative
    call-forwarding occurrence below is charged without an alias discount.
    The identical bound is reserved by genuine Prepare prefix admission.
    """
    if (type(prepared_bytes) is not int or not 1 <= prepared_bytes <= prepare.envelope.MAX_BYTES
            or type(source_count) is not int or not 1 <= source_count <= 100
            or type(taste_count) is not int or not 0 <= taste_count <= source_count):
        raise SourceUnavailable()
    p,k,m=prepared_bytes,source_count,taste_count
    states=1024*m+2  # Accepted strict native-state array envelope, not raw metadata.
    controls=(32768+6*states+5*(1024+128*k)+4*(1024+640*k)+2*(1024+128*k)
              +_association_hold_bytes(k,p))
    # The original contains identity/incoming/merged/display bytea as disjoint hex
    # members, so their total R is <= floor(P/2) before any payload conversion.
    write_owner=p//2+1024+640*k
    outcomes=4096+320*k
    outer_original_views=4*p       # Outer, current fence, source fence, layout.
    outer_forwarding_views=4*p     # Conservatively retain their call arguments.
    partition_view=p              # Header + rows + states + seals, subtrees of P.
    recursive_array_views=4*4*p    # Four levels: argument, iterator, item, forwarding.
    # Each sum-owned generator view includes its collection AND active item.
    # Each subtree is <= P; no largest-hex-leaf <= P/2 assumption is made.
    sum_handoff_views=4*2*p        # Four levels, collection + active item per handoff.
    sum_held_views=4*2*p           # Separate sum-held views, no alias discount.
    text_views=4*p                 # String counter, text call/argument, iterator.
    fixed_counter_work=8192        # Bounded scalar/scope/return controls; see proof.
    return (controls+outer_original_views+outer_forwarding_views+partition_view
            +recursive_array_views+sum_handoff_views+sum_held_views
            +text_views+6*write_owner+2*outcomes
            +_postimage_hold_bytes(m)+fixed_counter_work)


def _later_apply_peak_bytes(*, controls, prepared_bytes, write_owner, outcomes,
                           taste_count, source_phase, authority_phase, maximum_component, source_count):
    """Shared private Prepare/Apply arithmetic over actual owner-derived sizes.

    These are not client budgets, callbacks or authorization. Prepare supplies
    its genuine prefix recipe; Apply supplies verified-original sizes and its
    actual native source scalar admission. The same fixed cap remains external.
    """
    values=(controls,prepared_bytes,write_owner,outcomes,source_phase,authority_phase,maximum_component)
    if any(type(value) is not int or value < 0 for value in values):
        raise SourceUnavailable()
    held=_postimage_hold_bytes(taste_count)
    root=controls+5*prepared_bytes
    terminal= (prepare.terminal_codec.ENCODE_CONTRIBUTION
        +prepare.terminal_codec.DECODE_CONTRIBUTION+apply_command.MAX_PHASE_BYTES
        +10*2048+5+2*4096+prepare.terminal_codec.MAX_WIRE_BYTES)
    return max(
        _scalar_counter_phase_bytes(prepared_bytes,source_count=source_count,taste_count=taste_count),
        32768+4*prepare.terminal_codec.MAX_WIRE_BYTES+prepare.terminal_codec.DECODE_CONTRIBUTION
            +gate.PREPARE_GATE_BYTES+apply_command.MAX_PHASE_BYTES,
        root+3*write_owner+2*maximum_component,
        root+2*write_owner+outcomes+source_phase,
        root+2*write_owner+outcomes+taste._foobar_taste_postimage_phase_bytes(taste_count),
        root+3*write_owner+outcomes+held+source_phase,
        root+2*write_owner+outcomes+held+taste._foobar_taste_phase_bytes(taste_count),
        root+2*write_owner+outcomes+held+authority_phase,
        root+2*write_owner+outcomes+held+terminal,
        root+2*write_owner+outcomes+held+32768+gate.PREPARE_GATE_BYTES+apply_command.MAX_PHASE_BYTES,
    )


def _source_layout_from_original(original, *, prepared_bytes):
    """Count only after admitting every live recursive counter owner.

    The outer caller supplies its genuine verified body length; the original
    remains immutable. This private seam must not accept a client budget.
    """
    if (type(original) is not tuple or len(original)!=5
            or type(original[2]) is not tuple or type(original[3]) is not tuple
            or type(original[4]) is not tuple or len(original[4])!=len(original[2])):
        raise SourceUnavailable()
    prepare._private(_scalar_counter_phase_bytes(prepared_bytes,
        source_count=len(original[2]),taste_count=len(original[3])))
    header,rows,states=original[1],original[2],original[3]
    _optional_original(original)
    p=prepare.evidence._json_size(original)
    if p!=prepared_bytes:
        raise SourceUnavailable()
    raw=row_sizes=max_i=max_e=max_d=max_n=0
    for row in rows:
        i,e,d,n=(len(row[index])//2 for index in (1,7,8,6))
        if row[1].startswith('5b2270617468222c'):
            kind='path'
        elif row[1].startswith('5b226f6363757272656e6365222c'):
            kind='occurrence'
        elif row[1].startswith('5b2273746f72655f6b6579222c') and header[10]==gate.ENHANCED_MAPPING:
            kind='store_key'
        else:
            raise SourceUnavailable()
        raw+=i+e+d+n
        row_sizes+=(9+38+prepare.evidence._json_size(kind)+prepare.evidence._json_size(row[3])
            +prepare.evidence._json_size(row[4])+prepare.evidence._json_size(row[5])+2*(i+e+d+n)+9)
        max_i,max_e,max_d,max_n=max(max_i,i),max(max_e,e),max(max_d,d),max(max_n,n)
    phase,frame,base,result=source._source_write_phase_from_sizes(count=len(rows),raw=raw,
        row_sizes=row_sizes,maximum_identity=max_i,maximum_evidence=max_e,maximum_display=max_d,maximum_incoming_evidence=max_n,
        scope_size=prepare.evidence._json_size((header[0],header[3],header[4],header[7],())),
        enhanced_format=header[10]==gate.ENHANCED_MAPPING)
    k=len(rows)
    controls=(32768+6*prepare.evidence._json_size(states)+5*(1024+128*k)
              +4*(1024+640*k)+2*(1024+128*k)+_association_hold_bytes(k,p))
    return p,controls,base,4096+320*k,phase,frame,result,max(max_i,max_e,max_d,max_n)


def _reconstruct_source_items(original, *, prepared_bytes):
    p,c,b,o,phase,f,v,x=_source_layout_from_original(original,prepared_bytes=prepared_bytes)
    prepare._private(c+5*p+3*b+2*x)
    items=[]
    for row in original[2]:
        identity=bytes.fromhex(row[1])
        merged=bytes.fromhex(row[7])
        display=bytes.fromhex(row[8])
        incoming=bytes.fromhex(row[6])
        item=source.SourceWrite(row[2],identity,row[3],row[4],row[5],merged,display,incoming)
        items.append(item)
        del item,identity,merged,display,incoming
    # List, tuple and caller handoff are explicitly covered by three B views.
    return tuple(items)


def _source_comparison_admission(connection, live, *, original, items, prepared_bytes):
    p,c,b,o,phase,f,v,x=_source_layout_from_original(original,prepared_bytes=prepared_bytes)
    prepare._private(c+5*p+2*b+o+phase)
    header=original[1]
    frame=source._frame(items,header[0],header[3],header[4],header[7])
    if len(frame)!=f:
        raise SourceUnavailable()
    rows=source._query(connection,source._cardinality_sql(),frame)
    actual=source.source_comparison_phase_bytes(rows,items,base=b,frame_size=f,result_size=v)
    prepare._private(c+5*p+2*b+o+actual)
    # This is the actual complete pre-write native comparison phase, including
    # all prospective candidate occurrences. It is never inferred from max().
    return max(phase,actual)


def _post_source_fence(connection, live, *, original, items, outcomes, prepared_bytes):
    p,c,b,o,phase,f,v,x=_source_layout_from_original(original,prepared_bytes=prepared_bytes)
    held=_postimage_hold_bytes(len(original[3]))
    outer=c+5*p+3*b+o+held
    prepare._private(outer+phase)
    header=original[1]
    frame=source._frame(items,header[0],header[3],header[4],header[7])
    if len(frame)!=f:
        raise SourceUnavailable()
    counts=source._query(connection,source._cardinality_sql(),frame)
    if len(counts)!=len(items):
        raise SourceUnavailable()
    comparison=occurrences=0
    for ordinal,row in enumerate(counts,1):
        if (type(row) is not dict or set(row)!={'ordinal','candidate_count','comparison_bytes'}
                or type(row['ordinal']) is not int or row['ordinal']!=ordinal
                or type(row['candidate_count']) is not int or not 0<=row['candidate_count']<=100
                or type(row['comparison_bytes']) is not int or row['comparison_bytes']<0
                or (row['candidate_count']==0)!=(row['comparison_bytes']==0)
                or row['comparison_bytes']>row['candidate_count']*(source.evidence.MAX_IDENTITY_BYTES
                    +2*source.evidence.MAX_EVIDENCE_BYTES+source.display.MAX_BYTES)):
            raise SourceUnavailable()
        comparison+=row['comparison_bytes']
        occurrences+=row['candidate_count']
    factor=64 if header[10]==gate.ENHANCED_MAPPING else 11
    prepare._private(outer+b+6*f+4+2*v+factor*comparison+384*occurrences+prepare.evidence.CLASSIFIER_WORK_BYTES)
    del counts,row
    # No prospective insertion is added again: these are actual post-write
    # buckets. Every requested bucket has passed the global <=100 scalar gate.
    current=source._query(connection,source._current_sql(),frame)
    changed=tuple(outcome.source_changed for outcome in outcomes)
    incoming_digests=tuple(outcome.incoming_evidence_sha256 for outcome in outcomes)
    source._check_current(current,items,incoming_digests=incoming_digests,
                          postcheck=True,changed=changed,revision=header[7])


def _post_current_checks(connection, live, *, original, original_command,
                         items, outcomes, postimages, association_outcomes,
                         files, targets, constraints, prepared_bytes):
    p,c,b,o,phase,f,v,x=_source_layout_from_original(original,prepared_bytes=prepared_bytes)
    held=_postimage_hold_bytes(len(original[3]))
    _post_source_fence(connection,live,original=original,items=items,outcomes=outcomes,
        prepared_bytes=prepared_bytes)
    _optional_original(original)
    associations.check_foobar_association_postimages_on_connection(connection,live,
        source_ref=original_command.source_ref,matching_library_id=original_command.matching_library_id,
        receipt_ref=original[1][6],rows=original[2],seals=original[4],
        outcomes=association_outcomes,constraints=constraints)
    prepare._private(c+5*p+2*b+o+held+taste._foobar_taste_phase_bytes(len(postimages)))
    ids=tuple(values[0] for values in original[3])
    current=()
    if original_command.matching_library_id is not None and original_command.mapping_name!=gate.ENHANCED_MAPPING:
        current=taste.read_foobar_taste_on_connection(connection,live,
            source_ref=original_command.source_ref,track_ids=ids,constraints=constraints)
    # Expected values are the real writer's already-verified postimages, not
    # another later read relabelled as an expected state.
    if current!=postimages:
        raise SourceStale()
    del current
    _complete_inventory_fence(connection,live,original_command=original_command,files=files,targets=targets,constraints=constraints)
    auth=prepare.authority.authority_snapshot_phase_bytes(live,track_ids=ids)
    prepare._private(c+5*p+2*b+o+held+auth)
    digest,policies=prepare.authority.authority_snapshot_on_connection(
        connection,live,track_ids=ids,constraints=constraints)
    if (digest!=original[1][15] or type(policies) is not tuple
            or len(policies)!=len(original[3]) or any((values[11],values[12])!=(policy[1],policy[2])
            for values,policy in zip(original[3],policies))):
        raise SourceStale()
    source._authority(live,constraints)


def _terminal_replay(connection, live, *, command, original_command, header,
                     scalar, ticket, constraints):
    """Exact original-key replay; only mandatory clock touch is mutating."""
    body,observed=prepare._receipt_payload(connection,live,command=original_command,
        ticket=ticket,scalar=scalar,terminal=True)
    prepare._private(32768+4*len(body)+prepare.terminal_codec.DECODE_CONTRIBUTION)
    if prepare.hashlib.sha256(body).hexdigest()!=scalar['terminal_sha256']:
        raise SourceUnavailable()
    expected=(prepare.terminal_codec.VERSION,prepare.terminal_codec.terminal_scope_sha256(
        header[0],header[3],header[4]),header[3],header[6],header[5],command.request_key,
        ticket.prepared_sha256,ticket.decision_sha256,header[8],header[14],header[15],header[7],
        scalar['committed_revision'],header[11],header[12],header[13],header[4])
    record=prepare.terminal_codec.decode_foobar_terminal(body,expected_header=expected)
    if command.matching_library_id is None and any(record[k] for k in (18,19,20,21,22)):
        raise SourceUnavailable()
    del record
    if command.decision_sha256!=ticket.decision_sha256:
        raise SourceStale()
    source._authority(live,constraints)
    prepare._private(32768+4*len(body)+prepare.terminal_codec.DECODE_CONTRIBUTION
        +gate.PREPARE_GATE_BYTES+apply_command.MAX_PHASE_BYTES)
    original2,header2,scalar2,ticket2=_apply_receipt_entry(connection,live,command=command,constraints=constraints)
    if (original2!=original_command or header2!=header or ticket2.disposition!='committed_replay'
            or ticket2.prepared_sha256!=ticket.prepared_sha256
            or ticket2.decision_sha256!=ticket.decision_sha256
            or ticket2.terminal_bytes_size!=len(body) or ticket2.expires_at!=ticket.expires_at
            or scalar2['terminal_sha256']!=scalar['terminal_sha256']
            or scalar2['committed_revision']!=scalar['committed_revision']
            or scalar2['committed_at']!=scalar['committed_at'] or scalar2['observed_at']<observed):
        raise SourceUnavailable()
    source._authority(live,constraints)
    prepare._clock_fence(connection,live,command=original_command,earlier=scalar2['observed_at'],
        prepared_bytes=0,expires_at=scalar2['expires_at'])
    return body,scalar2['expires_at']


# The dataclass is a private service result, not a new wire serializer or route.
from dataclasses import dataclass
from datetime import datetime
from . import foobar_account_import_finalize as finalize


class FoobarApplyCommitUncertain(SourceUnavailable):
    """Same safe 503 vocabulary; never a claim that the outer commit rolled back.

    Reconcile only with the exact retained original command and key. This is
    not automatic retry permission or a new externally serialized error code.
    """
    commit_uncertain = True


@dataclass(frozen=True, slots=True)
class FoobarAppliedReceipt:
    source_ref: str
    generation: int
    receipt_ref: str
    terminal_bytes: bytes
    expires_at: datetime


def apply_foobar_import(database_url, context, *, command, intake_capacity, constraints=None):
    """Genuine outer transaction; only successful exit permits a committed result.

    Factory, request/CSRF boundary and publication are intentionally absent.
    Unknown outer commit acknowledgement is unavailable/uncertain, never a
    claimed rollback. Reconciliation must retain this exact original command.
    """
    apply_command.validate_apply_command(command)
    commit_attempted=False
    try:
        prepare._account_context(context)
        # A server-owned capacity must be present even on replay. No inventory
        # allocation is implied by this zero-size configuration validation.
        prepare.intake._admit(intake_capacity,0)
        prepare._private(32768+gate.PREPARE_GATE_BYTES+apply_command.MAX_PHASE_BYTES)
        checked=prepare._checked_constraints(constraints)
        deadline=prepare._Deadline()
        with prepare.current_foobar_import_transaction(database_url,context,
                matching_library_id=command.matching_library_id,constraints=checked) as (raw,live,sampled_now):
            connection=prepare._Connection(raw,deadline)
            deadline.check()
            source._authority(live,checked)
            original_command,header,scalar,ticket=_apply_receipt_entry(
                connection,live,command=command,constraints=checked)
            prepare._private(32768+gate.PREPARE_GATE_BYTES+apply_command.MAX_PHASE_BYTES+jobs.JOB_PHASE_BYTES)
            jobs.guard_foobar_job_protocol_on_connection(connection,live,
                command=command,operation='apply',constraints=checked)
            if ticket.disposition=='committed_replay':
                body,expires_at=_terminal_replay(connection,live,command=command,
                    original_command=original_command,header=header,scalar=scalar,
                    ticket=ticket,constraints=checked)
                prepare._private(32768+jobs.JOB_PHASE_BYTES+8*prepare.terminal_codec.MAX_WIRE_BYTES)
                jobs.record_foobar_job_protocol_on_connection(connection,live,
                    command=command,operation='apply',constraints=checked)
                private_output=(command.source_ref,command.generation,command.receipt_ref,body,expires_at)
            elif ticket.disposition=='ready_replay':
                # Reuse this guarded connection: no nested pool checkout or
                # transaction settings beneath the account/source locks.
                # Immutable committed replay above has no association-schema
                # or current-library prerequisite.
                if command.matching_library_id is not None:
                    require_foobar_match_schema_on_connection(connection)
                body,observed=prepare._receipt_payload(connection,live,command=original_command,
                    ticket=ticket,scalar=scalar,terminal=False)
                prepared_bytes=len(body)
                original=prepare.envelope.decode_prepared_envelope(body,original_command=original_command,
                    expected_header=header,prepared_sha256=ticket.prepared_sha256,
                    decision_sha256=ticket.decision_sha256)
                del body
                _optional_original(original)
                live=prepare._matching_context(connection,live,context,
                    command.matching_library_id,constraints=checked)
                # All later whole-original counters share this pre-entry gate,
                # including accepted Prepare validators and the finalizer.
                prepare._private(_scalar_counter_phase_bytes(prepared_bytes,
                    source_count=len(original[2]),taste_count=len(original[3])))
                prepare._original_source_admission(connection,live,original)
                changes=prepare.original_sources.validate_prepared_sources_on_connection(
                    connection,live,original_value=original,original_command=original_command,
                    expected_header=header,constraints=checked)
                if command.decision_sha256!=ticket.decision_sha256:
                    raise SourceStale()
                inventory=_apply_inventory(connection,live,original_command=original_command,
                    constraints=checked,capacity=intake_capacity)
                files,targets=inventory.files,inventory.targets
                del inventory
                prepare._source_capacity_check(connection,live,command=original_command,
                    original_value=original,source_changes=changes)
                fresh=prepare._current_checks(connection,live,command=original_command,
                    original_value=original,inventory_files=files,inventory_targets=targets,constraints=checked)
                if (fresh.disposition!='ready_replay' or fresh.receipt_ref!=command.receipt_ref
                        or fresh.prepared_sha256!=ticket.prepared_sha256
                        or fresh.decision_sha256!=ticket.decision_sha256 or fresh.observed_at<observed):
                    raise SourceUnavailable()
                observed=fresh.observed_at
                del fresh
                items=_reconstruct_source_items(original,prepared_bytes=prepared_bytes)
                source_phase=_source_comparison_admission(connection,live,original=original,items=items,
                    prepared_bytes=prepared_bytes)
                p,c,b,o,phase,f,v,x=_source_layout_from_original(original,prepared_bytes=prepared_bytes)
                ids=tuple(values[0] for values in original[3])
                auth=prepare.authority.authority_snapshot_phase_bytes(live,track_ids=ids)
                prepare._private(_later_apply_peak_bytes(controls=c,prepared_bytes=p,write_owner=b,
                    outcomes=o,taste_count=len(ids),source_phase=source_phase,
                    authority_phase=auth,maximum_component=x,source_count=len(original[2])))
                # Every binding and retained history head is sealed before any
                # source, association or native taste mutation may begin.
                associations.check_foobar_association_seals_on_connection(connection,live,
                    source_ref=command.source_ref,matching_library_id=command.matching_library_id,
                    rows=original[2],seals=original[4],constraints=checked)
                source_outcomes=source.write_foobar_source_on_connection(connection,live,
                    source_ref=command.source_ref,generation=command.generation,
                    expected_revision=header[7],items=items,constraints=checked)
                if (type(source_outcomes) is not tuple or len(source_outcomes)!=len(items)
                        or any(type(outcome) is not source.SourceWriteOutcome
                            or type(outcome.source_changed) is not bool or outcome.source_changed is not changed
                            or outcome.observation_ref!=item.observation_ref
                            or type(outcome.source_revision) is not int
                            or outcome.source_revision!=(header[7]+1 if changed else item.previous_revision)
                            for outcome,item,changed in zip(source_outcomes,items,changes))):
                    raise SourceUnavailable()
                del changes
                association_outcomes=associations.apply_foobar_associations_on_connection(
                    connection,live,source_ref=command.source_ref,
                    matching_library_id=command.matching_library_id,receipt_ref=command.receipt_ref,
                    rows=original[2],seals=original[4],constraints=checked)
                taste_items=taste_outcomes=postimages=()
                if command.matching_library_id is not None and original_command.mapping_name!=gate.ENHANCED_MAPPING:
                    expected=tuple(taste.FoobarTasteState(*values) for values in original[3])
                    taste_list=[]
                    for target_index,values in enumerate(original[3]):
                        representative=next(index for index,row in enumerate(original[2]) if row[9]==target_index)
                        row=original[2][representative]
                        taste_item=taste.FoobarTasteChange(values[0],row[2],
                            source_outcomes[representative].source_revision,row[10],row[11])
                        taste_list.append(taste_item)
                        del taste_item,row
                    taste_items=tuple(taste_list)
                    del taste_list
                    written=taste.apply_foobar_taste_with_postimages_on_connection(connection,live,
                        source_ref=command.source_ref,items=taste_items,expected=expected,constraints=checked)
                    taste_outcomes,postimages=written.outcomes,written.postimages
                    del written
                _post_current_checks(connection,live,original=original,original_command=original_command,
                    items=items,outcomes=source_outcomes,postimages=postimages,
                    association_outcomes=association_outcomes,
                    files=files,targets=targets,constraints=checked,prepared_bytes=prepared_bytes)
                # Actual already-produced outcomes only; no prediction or fake
                # ownership adapter reaches the paired metadata writer.
                prepare._private(_scalar_counter_phase_bytes(prepared_bytes,
                    source_count=len(original[2]),taste_count=len(original[3])))
                finalized=finalize.finalize_foobar_apply_on_connection(connection,live,
                    original_value=original,original_command=original_command,expected_header=header,
                    command=command,prepared_sha256=ticket.prepared_sha256,decision_sha256=ticket.decision_sha256,
                    source_items=items,source_outcomes=source_outcomes,taste_items=taste_items,
                    taste_outcomes=taste_outcomes,association_outcomes=association_outcomes,
                    observed_at=observed,constraints=checked)
                original2,header2,scalar2,ticket2=_apply_receipt_entry(connection,live,
                    command=command,constraints=checked)
                if (original2!=original_command or header2!=header or ticket2.disposition!='committed_replay'
                        or ticket2.prepared_sha256!=ticket.prepared_sha256
                        or ticket2.decision_sha256!=ticket.decision_sha256
                        or ticket2.terminal_bytes_size!=len(finalized.terminal_bytes)
                        or scalar2['terminal_sha256']!=finalized.terminal_sha256
                        or scalar2['committed_revision']!=finalized.source_revision
                        or scalar2['committed_at']!=finalized.committed_at
                        or scalar2['expires_at']!=finalized.expires_at
                        or scalar2['observed_at']<finalized.observed_at):
                    raise SourceUnavailable()
                # Actual finalized receipt and both request-key digests are
                # read again by the job owner. Its checkpoint shares this
                # source/taste/association/receipt transaction and rollback.
                prepare._private(c+5*p+2*b+o+_postimage_hold_bytes(len(ids))
                    +4*prepare.terminal_codec.MAX_WIRE_BYTES+4096)
                jobs.record_foobar_job_protocol_on_connection(connection,live,
                    command=command,operation='apply',constraints=checked)
                _post_current_checks(connection,live,original=original,original_command=original_command,
                    items=items,outcomes=source_outcomes,postimages=postimages,
                    association_outcomes=association_outcomes,
                    files=files,targets=targets,constraints=checked,prepared_bytes=prepared_bytes)
                source._authority(live,checked)
                deadline.check()
                # Original READY expiry still governs this new commit. Terminal
                # replay uses its distinct immutable seven-day expiry above.
                prepare._clock_fence(connection,live,command=original_command,
                    earlier=scalar2['observed_at'],prepared_bytes=p,expires_at=scalar['ready_until'],
                    association_hold=_association_hold_bytes(len(original[2]),p))
                prepare._private(c+5*p+2*b+o+_postimage_hold_bytes(len(ids))
                    +4*prepare.terminal_codec.MAX_WIRE_BYTES+4096)
                private_output=(command.source_ref,command.generation,command.receipt_ref,
                                finalized.terminal_bytes,finalized.expires_at)
            else:
                raise SourceUnavailable()
            deadline.check()
            commit_attempted=True
        # No failure escaping the real outer context is reported as success.
        # A failure after its commit may be uncertain, reconciled by exact key.
        deadline.check()
        return FoobarAppliedReceipt(*private_output)
    except (SourceUnavailable,apply_command.ApplyInvalid,prepare.intake.FoobarPreparationRejected):
        if commit_attempted:
            raise FoobarApplyCommitUncertain() from None
        raise
    except (PrivateLibraryAuthorityError,taste.FoobarTasteStale):
        if commit_attempted:
            raise FoobarApplyCommitUncertain() from None
        raise SourceStale() from None
    except Exception:
        if commit_attempted:
            raise FoobarApplyCommitUncertain() from None
        raise SourceUnavailable() from None
