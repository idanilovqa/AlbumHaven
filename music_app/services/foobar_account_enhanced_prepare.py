"""Enhanced-only original upload proof inside the existing account import owner.

The private indexed artifact is never a permission grant. Registered callers
must use the genuine account transaction and durable receipt/job owners.
"""
import hashlib
from dataclasses import replace
from uuid import uuid4

from . import foobar_account_import_prepare as prepare
from . import foobar_account_prepare_gate as gate
from . import foobar_enhanced_raw_windows as windows
from . import foobar_enhanced_source_evidence as evidence
from .foobar_account_source_postgres import SourceUnavailable,SourceStale


def _index(upload,command):
    gate.validate_prepare_command(command)
    if (type(upload) is not windows.EnhancedRawIndex
            or command.mapping_name!=gate.ENHANCED_MAPPING
            or upload.upload_sha256!=command.upload_sha256
            or not 1<=upload.records<=100000
            or not 0<=command.offset<upload.records):
        raise SourceUnavailable()


def _read_one(upload,ordinal,*,private_capacity_bytes):
    """Require the actual single-record terminal, not a truncated iterator.

    Per-record indexed reads do not rerun whole-file integrity/normalization.
    The caller can pack these into one <=100-observation receipt without
    retaining an oversized next raw record or losing prefix terminal proof.
    """
    stream=upload.window(ordinal,1,private_capacity_bytes=private_capacity_bytes)
    try:
        try:
            value=next(stream)
        except StopIteration:
            raise SourceUnavailable() from None
        if type(value) is not evidence.EnhancedIncomingEvidence or value.record_ordinal!=ordinal:
            raise SourceUnavailable()
        encoded=evidence.encode_enhanced_incoming(value)
        proof=hashlib.sha256(b'foobar-enhanced-raw-window-v1\x00')
        proof.update(len(encoded).to_bytes(8,'big'))
        proof.update(encoded)
        del encoded
        try:
            next(stream)
        except StopIteration as completed:
            summary=completed.value
        else:
            raise SourceUnavailable()
        if (type(summary) is not windows.EnhancedRawWindowSummary
                or summary.upload_sha256!=upload.upload_sha256
                or (summary.start,summary.end,summary.records)!=(ordinal,ordinal+1,1)
                or summary.proof_sha256!=proof.hexdigest()):
            raise SourceUnavailable()
        return value
    finally:
        stream.close()


def _seal(ordinal):
    return (ordinal,None,None,None,None,None,None,None,'no_library',None)


def _original_size(header,plans,seals=None):
    """Exact scalar wire count before allocating any source hexadecimal text."""
    size=prepare.evidence._json_size((prepare.envelope.VERSION,header,(),(),()))
    for index,planned in enumerate(plans):
        item=planned.source_write
        size+=prepare.evidence._json_size((planned.ordinal,'',item.observation_ref,
            item.previous_revision,item.previous_evidence_sha256,item.previous_display_sha256,
            '','','',None,None,False))
        size+=2*sum(map(len,(item.identity_bytes,item.incoming_evidence_bytes,item.evidence_bytes,item.display_bytes)))
        size+=prepare.evidence._json_size(_seal(planned.ordinal) if seals is None else seals[index])
    return size+2*(len(plans)-1)


def _prefix_required(live,command,header,plans,seals=None):
    """Same actual future writer/Apply/validator owners, not a size-only ticket."""
    from . import foobar_account_import_apply as apply
    p=_original_size(header,plans,seals)
    if not 1<=p<=prepare.MAX_PRIVATE_BYTES:
        return prepare.MAX_PRIVATE_BYTES+1,p
    k=len(plans)
    held=apply._association_hold_bytes(k,p)
    retained=plans[-1].retained_phase_bytes
    items=tuple(value.source_write for value in plans)
    phase,frame,base,result=prepare.source.source_write_phase_bytes(items,
        account_id=live.actor.account_id,source_ref=command.source_ref,
        generation=command.generation,expected_revision=command.expected_revision)
    scalars=[dict(ordinal=index,candidate_count=value.candidate_count,comparison_bytes=value.comparison_bytes)
        for index,value in enumerate(plans,1)]
    phase=max(phase,prepare.source.source_comparison_phase_bytes(scalars,items,
        base=base,frame_size=frame,result_size=result))
    del scalars,items
    controls=(32768+12+5*(1024+128*k)+4*(1024+640*k)+2*(1024+128*k)+held)
    maximum=max(max(map(len,(value.source_write.identity_bytes,value.source_write.incoming_evidence_bytes,
        value.source_write.evidence_bytes,value.source_write.display_bytes))) for value in plans)
    authority=prepare.authority.authority_snapshot_phase_bytes(live,track_ids=())
    peaks=[
        65536+prepare.associations.association_phase_bytes(k)+8192*k+max(retained,5*p),
        32768+retained+3*p+2*maximum+held,
        32768+retained+prepare.envelope.prepared_envelope_phase_bytes(p,decode=False)+held,
        32768+prepare.envelope.prepared_envelope_phase_bytes(p,decode=True)+held,
        prepare._ready_insert_phase_bytes(p,prepare.MAX_INSERT_FRAME)+held,
        apply._later_apply_peak_bytes(controls=controls,prepared_bytes=p,write_owner=base,
            outcomes=4096+320*k,taste_count=0,source_phase=phase,authority_phase=authority,
            maximum_component=maximum,source_count=k),
    ]
    for value in plans:
        item=value.source_write
        i,n,m,s=map(len,(item.identity_bytes,item.incoming_evidence_bytes,item.evidence_bytes,item.display_bytes))
        controls=(header[0],header[1],header[3],item.observation_ref,item.previous_revision,
            item.previous_evidence_sha256,item.previous_display_sha256)
        if item.previous_revision is not None:
            controls+=(value.prior_identity_bytes,value.prior_effective_bytes,value.prior_display_bytes,
                hashlib.sha256(item.identity_bytes).hexdigest(),'store_key',
                value.prior_incoming_bytes,value.prior_incoming_sha256)
        peaks.append(32768+prepare.original_sources.enhanced_source_phase_bytes(
            prepared_bytes=p,held=held,identity_bytes=i,incoming_bytes=n,merged_bytes=m,display_bytes=s,
            prior_identity_bytes=value.prior_identity_bytes,prior_bytes=value.prior_effective_bytes,
            prior_display_bytes=value.prior_display_bytes,prior_incoming_bytes=value.prior_incoming_bytes,
            frame_bytes=prepare.evidence._json_size(controls)))
        peaks.append(32768+5*p+held+2*n+evidence.codec_phase_bytes(n))
        peaks.append(prepare.source.enhanced_history.projection_write_phase_bytes(
            retained_bytes=32768+5*p+held+2*(m+s),effective_length=m,display_length=s))
    return max(peaks)+prepare.REVIEW_CONTROL_BYTES,p


def verify_enhanced_upload(original,*,upload,command):
    """Bind all genuine original raw rows to the same finalized indexed bytes.

    Original source validation independently proves prior/effective merge,
    canonical identity, display, and account/session/source authorization.
    """
    _index(upload,command)
    if (type(original) is not tuple or len(original)!=5 or original[0]!=prepare.envelope.VERSION
            or original[1][9]!=gate.ENHANCED_PARSER or original[1][10]!=gate.ENHANCED_MAPPING
            or original[1][11]!=upload.records or original[1][12]!=command.offset+1
            or original[1][13]!=command.offset+len(original[2])+1):
        raise SourceUnavailable()
    p=prepare.evidence._json_size(original)
    from .foobar_account_import_apply import _association_hold_bytes
    retained=32768+5*p+_association_hold_bytes(len(original[2]),p)
    for row in original[2]:
        incoming_length=len(row[6])//2
        required=retained+2*incoming_length+evidence.codec_phase_bytes(incoming_length)
        prepare._private(required)
        value=_read_one(upload,row[0]-1,private_capacity_bytes=prepare.MAX_PRIVATE_BYTES-retained)
        encoded=evidence.encode_enhanced_incoming(value)
        if encoded.hex()!=row[6]:
            raise SourceStale()
        del value,encoded
    # Includes private artifact lifetime and original stat/currentness check.
    _index(upload,command)


def _header(live,command,upload,receipt_ref,authority_sha256,observed_at,count):
    return (live.actor.account_id,command.matching_library_id,live.actor.session_id,command.source_ref,
        command.generation,command.request_key,receipt_ref,command.expected_revision,
        command.upload_sha256,gate.ENHANCED_PARSER,gate.ENHANCED_MAPPING,upload.records,
        command.offset+1,command.offset+count+1,command.inventory_sha256,authority_sha256,
        prepare._utc(observed_at))


def _row(planned):
    item=planned.source_write
    return (planned.ordinal,item.identity_bytes.hex(),item.observation_ref,item.previous_revision,
        item.previous_evidence_sha256,item.previous_display_sha256,item.incoming_evidence_bytes.hex(),
        item.evidence_bytes.hex(),item.display_bytes.hex(),None,None,False)


def candidate_on_connection(connection,live,*,upload,command,ticket,constraints,matching_cache=None):
    """Actual indexed planning, original verification and capacity before READY.

    This stage performs no receipt/job writes and is also the rollback-only
    whole-import preflight's genuine decision owner.
    """
    from . import foobar_account_enhanced_source_plan as planner
    _index(upload,command)
    if ticket.disposition!='new':
        raise SourceStale()
    if command.matching_library_id is None:
        if matching_cache is not None:
            raise SourceUnavailable()
        inventory=prepare._account_inventory(live,command,constraints)
    else:
        from . import foobar_account_enhanced_matching as matching
        if (type(matching_cache) is not matching._MatchingCache
                or matching_cache.scope!=matching._scope(live,command,upload)):
            raise SourceUnavailable()
        inventory=matching_cache.inventory
    prepare._private(32768+prepare.authority.authority_snapshot_phase_bytes(live,track_ids=()))
    authority_sha256,policies=prepare.authority.authority_snapshot_on_connection(
        connection,live,track_ids=(),constraints=constraints)
    if policies:
        raise SourceUnavailable()
    del policies
    receipt_ref=str(uuid4())
    plans=()
    unavailable_flags=()
    unavailable_records=0
    expected_size=None
    for ordinal in range(command.offset,min(command.offset+100,upload.records)):
        retained=32768+(plans[-1].retained_phase_bytes if plans else 0)
        available=prepare.MAX_PRIVATE_BYTES-retained
        if available<=0:
            break
        try:
            incoming=_read_one(upload,ordinal,private_capacity_bytes=available)
        except windows.EnhancedRawIndexRejected as exc:
            if plans and str(exc) in ('private_phase_capacity_exceeded','record_payload_limit_exceeded'):
                break
            raise
        planned=planner.plan_enhanced_source_record_on_connection(connection,live,
            command=command,ticket=ticket,incoming=incoming,retained=plans,
            caller_retained_bytes=32768,constraints=constraints)
        incoming_unavailable=incoming.data_state!='parsed'
        del incoming
        if planned is None:
            break
        prospective=plans+(planned,)
        header=_header(live,command,upload,receipt_ref,authority_sha256,ticket.observed_at,len(prospective))
        required,size=_prefix_required(live,command,header,prospective)
        if required>prepare.MAX_PRIVATE_BYTES:
            del prospective,planned
            break
        plans=prospective
        unavailable_flags=unavailable_flags+(incoming_unavailable,)
        unavailable_records+=int(incoming_unavailable)
        expected_size=size
        del prospective,planned
    if not plans or expected_size is None:
        raise SourceUnavailable()
    if matching_cache is None:
        seals=tuple(_seal(value.ordinal) for value in plans)
    else:
        seals=matching.association_seals_on_connection(connection,live,command=command,
            observations=tuple((value.ordinal,value.source_write.observation_ref) for value in plans),
            cache=matching_cache,retained_bytes=plans[-1].retained_phase_bytes,constraints=constraints)
    # Actual association seals replace the conservative source-only sizing
    # placeholders before selecting the final receipt prefix. No writes occur.
    while plans:
        header=_header(live,command,upload,receipt_ref,authority_sha256,ticket.observed_at,len(plans))
        required,size=_prefix_required(live,command,header,plans,seals)
        if required<=prepare.MAX_PRIVATE_BYTES:
            break
        plans=plans[:-1]
        seals=seals[:-1]
        unavailable_flags=unavailable_flags[:-1]
    if not plans:
        raise SourceUnavailable()
    prepare._private(required)
    planned_changes=tuple(value.material_changed for value in plans)
    prepare._revision_after(command.expected_revision,any(planned_changes),False,
        association_changed=any(seal[8]=='never_decided' and seal[9] is not None for seal in seals))
    unavailable_records=sum(unavailable_flags)
    original=(prepare.envelope.VERSION,header,tuple(_row(value) for value in plans),(),
        seals)
    body,prepared_sha256,decision_sha256=prepare.envelope.encode_prepared_envelope(
        original,original_command=command,expected_header=header)
    if len(body)!=size:
        raise SourceUnavailable()
    del plans
    verify_enhanced_upload(original,upload=upload,command=command)
    verify_matching_on_connection(connection,live,original=original,upload=upload,
        command=command,matching_cache=matching_cache,constraints=constraints)
    prepare._original_source_admission(connection,live,original)
    changes=prepare.original_sources.validate_prepared_sources_on_connection(connection,live,
        original_value=original,original_command=command,expected_header=header,constraints=constraints)
    if changes!=planned_changes:
        raise SourceUnavailable()
    quota=prepare._source_capacity_check(connection,live,command=command,
        original_value=original,source_changes=changes)
    # Timestamp-only evidence never proposes rating/favorite mutations.
    matched=sum(seal[9] is not None for seal in seals)
    ambiguous=(sum(matching_cache.candidates[row[0]-1][0]=='ambiguous'
        or seal[8]=='never_decided' and matching_cache.candidates[row[0]-1][0]=='unique'
            and seal[9] is None for row,seal in zip(original[2],seals))
        if matching_cache is not None else 0)
    proposed=prepare._proposed_window(original,changes,quota,
        review=((len(changes),matched,ambiguous,unavailable_records,0,0),(),False))
    fresh=prepare._current_checks(connection,live,command=command,original_value=original,
        inventory_files=inventory.files,inventory_targets=inventory.targets,constraints=constraints)
    if fresh.disposition!='new':
        raise SourceStale()
    return original,body,prepared_sha256,decision_sha256,fresh,proposed


def verify_matching_on_connection(connection,live,*,original,upload,command,matching_cache,constraints):
    if command.matching_library_id is None:
        if matching_cache is not None or any(seal!=_seal(row[0])
                for row,seal in zip(original[2],original[4])):
            raise SourceUnavailable()
        return
    from . import foobar_account_enhanced_matching as matching
    if (type(matching_cache) is not matching._MatchingCache
            or matching_cache.scope!=matching._scope(live,command,upload)):
        raise SourceUnavailable()
    current=matching.association_seals_on_connection(connection,live,command=command,
        observations=tuple((row[0],row[2]) for row in original[2]),cache=matching_cache,
        retained_bytes=5*prepare.evidence._json_size(original),constraints=constraints)
    if current!=original[4]:
        raise SourceStale()


def _run(database_url,context,*,upload,command,intake_capacity,constraints,preflight):
    """One real account transaction, using the existing native connection owner."""
    _index(upload,command)
    prepare._account_context(context)
    prepare.intake._admit(intake_capacity,windows.index_retained_logical_bytes(upload.records)
        +windows.READER_PHASE_LOGICAL_BYTES+prepare.MAX_PRIVATE_BYTES)
    checked=prepare._checked_constraints(constraints)
    try:
        deadline=prepare._Deadline()
        with prepare.current_foobar_import_transaction(database_url,context,
                matching_library_id=command.matching_library_id,constraints=checked) as (raw,live,sampled_now):
            connection=prepare._Connection(raw,deadline)
            prepare.source._authority(live,checked)
            prepare._private(32768+gate.PREPARE_GATE_BYTES+prepare.jobs.JOB_PHASE_BYTES)
            ticket=gate.begin_foobar_prepare_on_connection(connection,live,command=command,constraints=checked)
            matching_cache=None
            if ticket.disposition!='committed_replay':
                if command.matching_library_id is not None:
                    from .foobar_account_match_readiness import require_foobar_match_schema_on_connection
                    require_foobar_match_schema_on_connection(connection)
                live=prepare._matching_context(connection,live,context,command.matching_library_id,constraints=checked)
                if command.matching_library_id is not None:
                    from . import foobar_account_enhanced_matching as matching
                    matching_cache=matching.matching_cache_on_connection(connection,live,
                        upload=upload,command=command,capacity=intake_capacity,constraints=checked)
            if preflight:
                if ticket.disposition!='new':
                    raise SourceStale()
                original,body,prepared_hash,decision_hash,fresh,result=candidate_on_connection(
                    connection,live,upload=upload,command=command,ticket=ticket,constraints=checked,
                    matching_cache=matching_cache)
                del original,body,prepared_hash,decision_hash,fresh
                result=replace(result,operational_budget=prepare._preflight_operational_budget(connection,live,command))
                prepare.source._authority(live,checked)
                _index(upload,command)
                deadline.check()
                raw.rollback()
                if (raw.closed is not False or prepare.taste.psycopg is None
                        or raw.info.transaction_status!=prepare.taste.psycopg.pq.TransactionStatus.IDLE):
                    raise SourceUnavailable()
                deadline.check()
                raise prepare._PreflightRolledBack(result)
            prepare.jobs.guard_foobar_job_protocol_on_connection(connection,live,
                command=command,operation='prepare',constraints=checked)
            if ticket.disposition=='new':
                inventory=(prepare._account_inventory(live,command,checked)
                    if matching_cache is None else matching_cache.inventory)
                values=prepare._new_receipt(connection,live,payload=upload,command=command,
                    proof=None,ticket=ticket,inventory_files=inventory.files,targets=inventory.targets,projections=(),
                    first=None,target_counts=(),constraints=checked,enhanced_matching_cache=matching_cache)
            elif ticket.disposition in ('ready_replay','committed_replay'):
                values=prepare._replay_receipt(connection,live,payload=upload,command=command,
                    proof=None,ticket=ticket,constraints=checked,capacity=intake_capacity)
            else:
                raise SourceUnavailable()
            prepare._private(32768+prepare.jobs.JOB_PHASE_BYTES+8*prepare.terminal_codec.MAX_WIRE_BYTES)
            prepare.jobs.record_foobar_job_protocol_on_connection(connection,live,
                command=command,operation='prepare',constraints=checked)
            prepare.source._authority(live,checked)
            _index(upload,command)
            deadline.check()
        deadline.check()
        return prepare.FoobarPreparedReceipt(*values)
    except prepare._PreflightRolledBack as completed:
        if not preflight:
            raise SourceUnavailable() from None
        return completed.result
    except (SourceUnavailable,gate.PrepareInvalid,prepare.intake.FoobarPreparationRejected):
        raise
    except prepare.taste.FoobarTasteStale:
        raise SourceStale() from None
    except Exception:
        raise SourceUnavailable() from None


def prepare_indexed_enhanced_import(database_url,context,*,upload,command,intake_capacity,constraints=None):
    return _run(database_url,context,upload=upload,command=command,intake_capacity=intake_capacity,
        constraints=constraints,preflight=False)


def preflight_indexed_enhanced_window(database_url,context,*,upload,command,intake_capacity,constraints=None):
    return _run(database_url,context,upload=upload,command=command,intake_capacity=intake_capacity,
        constraints=constraints,preflight=True)
