# Composition N2 reserves one additional deadline-wrapper parameter view.
# This is a logical forwarding owner, never an alias or zero-copy discount.
"""Strict admitted source reconstruction; no receipt or committed outcome."""
from dataclasses import dataclass
from hashlib import sha256

from . import foobar_source_evidence as evidence
from . import foobar_source_display as display
from . import foobar_source_lookup as lookup
from . import foobar_source_merge_sizes as sizing
from . import foobar_prepare_gate as gate
from .foobar_source_postgres import SourceUnavailable, SourceStale, _query


@dataclass(frozen=True, slots=True)
class PreparedSourceEvidence:
    ordinal: int
    identity_bytes: bytes
    incoming_evidence_bytes: bytes
    merged_evidence_bytes: bytes
    display_bytes: bytes
    matches_prior: bool


def _retained_bytes(retained):
    if type(retained) is not tuple or len(retained) > 100:
        raise SourceUnavailable()
    size = 1024
    last = 0
    for item in retained:
        if (type(item) is not PreparedSourceEvidence or type(item.ordinal) is not int
                or not last < item.ordinal <= 100000 or type(item.matches_prior) is not bool):
            raise SourceUnavailable()
        last = item.ordinal
        size += 1024
        for payload,maximum in ((item.identity_bytes,131072),
                                (item.incoming_evidence_bytes,4194304),
                                (item.merged_evidence_bytes,4194304),
                                (item.display_bytes,1048576)):
            if type(payload) is not bytes or not 1 <= len(payload) <= maximum:
                raise SourceUnavailable()
            size += len(payload)
    # Caller collection plus explicit immutable handoff may coexist.
    return 2*size


def source_prior_merge_phase_bytes(*, count, retained, incoming_bytes, identity_bytes,
                                  prior_bytes, prior_display_bytes, prior_incoming_bytes,
                                  merged_bytes, display_bytes, frame_bytes):
    values = ((incoming_bytes,1,4194304),(identity_bytes,1,131072),
              (prior_bytes,0,4194304),(prior_display_bytes,0,1048576),
              (prior_incoming_bytes,0,4194304),
              (merged_bytes,1,4194304),(display_bytes,1,1048576),(frame_bytes,1,1048576))
    if any(type(v) is not int or not lo <= v <= hi for v,lo,hi in values):
        raise SourceUnavailable()
    if (prior_bytes == 0) != (prior_display_bytes == 0):
        raise SourceUnavailable()
    b = sizing._base(count)+_retained_bytes(retained)
    n,i,a,d,m,s,f = incoming_bytes,identity_bytes,prior_bytes,prior_display_bytes,merged_bytes,display_bytes,frame_bytes
    c = evidence.CLASSIFIER_WORK_BYTES
    phases = (
        b+n+5*i+c+96,                  # Canonical identity encoding/hash.
        b+i+5*n+c,                     # Original incoming evidence encoding.
        b+2*n+5*i+8*f+4+2*(a+d)+8192 if a else 0, # Binary fetch, native/Python raw.
        b+2*n+i+d+8*a+c+96 if a else 0, # Strict prior evidence decode/canonical check.
        b+2*n+i+a+6*d+c+96 if a else 0, # Prior display association, old evidence raw gone.
        b+i+n+3*(a+n)+c,               # Both typed inputs and merge destination views.
        b+2*n+i+5*m+c,                 # Merged evidence encoding.
        b+2*n+i+2*m+5*s+c,             # Merged fields/bytes plus safe display encoder.
        b+3*n+2*i+2*m+2*s+1024,        # Local bytes AND result byte views, plus caller fields.
    )
    return max(phases) + 10*prior_incoming_bytes + evidence.CLASSIFIER_WORK_BYTES
    # Extra raw holders, canonical decode/round-trip and semantic comparison.


_PRIOR_SQL = r'''
with f as materialized (select convert_from(%b::bytea,'UTF8')::jsonb j)
select r.evidence_bytes,r.display_bytes,r.incoming_evidence_bytes
from f join integration.foobar_import_observations o on
 (o.account_id,o.library_id,o.source_ref,o.observation_ref)=
 ((j->>0)::bigint,(j->>1)::bigint,(j->>2)::uuid,(j->>3)::uuid)
join integration.foobar_import_revisions r on
 (r.account_id,r.library_id,r.source_ref,r.observation_ref,r.source_revision)=
 (o.account_id,o.library_id,o.source_ref,o.observation_ref,o.current_revision)
where o.current_revision=(j->>4)::bigint
 and r.evidence_sha256=decode(j->>5,'hex') and r.display_sha256=decode(j->>6,'hex')
 and o.identity_sha256=decode(j->>7,'hex') and octet_length(o.identity_bytes)=(j->>8)::bigint
 and octet_length(r.evidence_bytes)=(j->>9)::bigint
 and octet_length(r.display_bytes)=(j->>10)::bigint
 and o.identity_bytes=decode(j->>13,'hex')
 and r.incoming_evidence_sha256 is not distinct from decode(j->>11,'hex')
 and coalesce(octet_length(r.incoming_evidence_bytes),0)=(j->>12)::bigint
'''


def _check_prior_identity(previous, incoming_fields, *, identity_kind, upload_sha256, ordinal):
    """Inputs already strictly decoded; current identity recipe is verified above.

    Mirror the real writer's path/raw or occurrence/origin association without
    constructing another identity view or decoding the generated identity again.
    """
    if identity_kind == 'path':
        if previous[0][1] != incoming_fields[0][1]:
            raise SourceUnavailable()
    elif identity_kind == 'occurrence':
        origin = previous[0][4]
        if origin is None or origin[0] != upload_sha256 or origin[1] != ordinal:
            raise SourceUnavailable()
    else:
        raise SourceUnavailable()


def _same_ticket(fresh, previous):
    if (fresh.disposition != 'new' or fresh.command_sha256 != previous.command_sha256
            or fresh.observed_at < previous.observed_at):
        raise SourceUnavailable()


def reconstruct_foobar_source_on_connection(
    connection,live_context,*,command,ticket,lookup_result,index,merged_sizes,
    incoming_fields,retained,constraints=None,
):
    """Consume actual scalar proof and incoming parser fields, not client budgets.

    The incoming fields' creation/counter traversal needs its previously admitted
    parser row contribution. All window scalar queries must already be complete.
    Retained prior outputs must be supplied explicitly, including caller copies.
    """
    gate.validate_prepare_command(command)
    try:
        lookup._admit(8192+32768+evidence.CLASSIFIER_WORK_BYTES)
        if (type(lookup_result) is not lookup.SourceLookupScalars or type(index) is not int
                or not 0 <= index < len(lookup_result.prior)
                or type(merged_sizes) is not sizing.MergedSourceSizes
                or type(ticket) is not gate.FoobarPrepareTicket or ticket.disposition != 'new'
                or type(incoming_fields) is not tuple or len(incoming_fields) != 27):
            raise SourceUnavailable()
        item,prior = lookup_result.identities[index],lookup_result.prior[index]
        if (type(item) is not lookup.SourceIdentityScalar or type(prior) is not lookup.PriorSourceScalar
                or item.ordinal != command.offset+index+1 or prior.ordinal != item.ordinal
                or merged_sizes.ordinal != item.ordinal or type(merged_sizes.evidence_unchanged) is not bool):
            raise SourceUnavailable()
        if prior.observation_ref is None:
            if (any(v is not None for v in (prior.source_revision,prior.evidence_sha256,prior.display_sha256,
                                             prior.incoming_evidence_sha256))
                    or prior.evidence_bytes != 0 or prior.display_bytes != 0 or prior.incoming_evidence_bytes != 0):
                raise SourceUnavailable()
        elif (not gate._uuid(prior.observation_ref) or not gate._integer(prior.source_revision,1,command.expected_revision)
              or not gate._hex(prior.evidence_sha256) or not gate._hex(prior.display_sha256)):
            raise SourceUnavailable()
        if (type(prior.incoming_evidence_bytes) is not int or not 0 <= prior.incoming_evidence_bytes <= 4194304
                or (prior.incoming_evidence_bytes == 0 and prior.incoming_evidence_sha256 is not None)
                or (prior.incoming_evidence_bytes > 0 and not gate._hex(prior.incoming_evidence_sha256))):
            raise SourceUnavailable()
        if len(retained) != index or any(row.ordinal != command.offset+k+1 for k,row in enumerate(retained)):
            raise SourceUnavailable()
        # No encoding or semantic classifier scratch before the phase gate.
        n = evidence._json_size((evidence.VERSION,evidence.PARSER_VERSION,incoming_fields))
        actor = live_context.actor
        fixed = (actor.account_id,live_context.library_id,command.source_ref,
                 prior.observation_ref,prior.source_revision,prior.evidence_sha256,
                 prior.display_sha256,item.identity_sha256,item.identity_bytes,
                 prior.evidence_bytes,prior.display_bytes,prior.incoming_evidence_sha256,
                 prior.incoming_evidence_bytes)
        frame_size = evidence._json_size(fixed)+2*item.identity_bytes+3
        required = source_prior_merge_phase_bytes(
            count=len(lookup_result.identities),retained=retained,incoming_bytes=n,
            identity_bytes=item.identity_bytes,prior_bytes=prior.evidence_bytes,
            prior_display_bytes=prior.display_bytes,prior_incoming_bytes=prior.incoming_evidence_bytes,merged_bytes=merged_sizes.evidence_bytes,
            display_bytes=merged_sizes.display_bytes,frame_bytes=frame_size,
        )
        if required > 4194304:
            return None
        evidence._validate_fields(incoming_fields)
        for field in incoming_fields:
            if field[0] != 'absent' and field[4][:2] != (command.upload_sha256,item.ordinal):
                raise SourceUnavailable()
        del field
        identity = evidence._source_identity_bytes(
            incoming_fields[0][1],upload_sha256=command.upload_sha256,
            ordinal=item.ordinal,identity_conflict=item.identity_conflict,
        )
        kind = 'path' if incoming_fields[0][1] != '' and not item.identity_conflict else 'occurrence'
        if kind != item.identity_kind or len(identity) != item.identity_bytes or sha256(identity).hexdigest() != item.identity_sha256:
            raise SourceUnavailable()
        incoming_payload = evidence.encode_evidence(incoming_fields)
        if len(incoming_payload) != n:
            raise SourceUnavailable()
        fresh = gate.begin_foobar_prepare_on_connection(
            connection,live_context,command=command,constraints=constraints,
        )
        _same_ticket(fresh,ticket)
        previous = previous_incoming = None
        if prior.observation_ref is not None:
            values = list(fixed)
            values.append(identity.hex())
            frame = lookup._encode(values)
            del values
            if len(frame) != frame_size:
                raise SourceUnavailable()
            rows = _query(connection,_PRIOR_SQL,frame,maximum=1)
            del frame
            if not rows:
                raise SourceStale()
            if len(rows) != 1 or type(rows[0]) is not dict or set(rows[0]) != {'evidence_bytes','display_bytes','incoming_evidence_bytes'}:
                raise SourceUnavailable()
            raw,old_display = rows[0]['evidence_bytes'],rows[0]['display_bytes']
            old_incoming = rows[0]['incoming_evidence_bytes']
            del rows
            if (type(raw) is not bytes or len(raw) != prior.evidence_bytes
                    or type(old_display) is not bytes or len(old_display) != prior.display_bytes
                    or sha256(raw).hexdigest() != prior.evidence_sha256
                    or sha256(old_display).hexdigest() != prior.display_sha256):
                raise SourceUnavailable()
            if prior.incoming_evidence_bytes == 0:
                if old_incoming is not None or prior.incoming_evidence_sha256 is not None:
                    raise SourceUnavailable()
            elif (type(old_incoming) is not bytes
                  or len(old_incoming) != prior.incoming_evidence_bytes
                  or sha256(old_incoming).hexdigest() != prior.incoming_evidence_sha256):
                raise SourceUnavailable()
            else:
                previous_incoming = evidence.decode_evidence(old_incoming)
                _check_prior_identity(previous_incoming,incoming_fields,identity_kind=kind,
                    upload_sha256=command.upload_sha256,ordinal=item.ordinal)
            del old_incoming
            previous = evidence.decode_evidence(raw)
            del raw
            display.check_display(old_display,previous)
            del old_display
            _check_prior_identity(
                previous,incoming_fields,identity_kind=kind,
                upload_sha256=command.upload_sha256,ordinal=item.ordinal,
            )
        merged = evidence.merge_fields(previous,incoming_fields)
        matches_prior = evidence.same_observation(previous_incoming,incoming_fields) and previous is not None and all(
            evidence._same(old[k],new[k]) for old,new in zip(previous,merged) for k in range(5)
        )
        if matches_prior != merged_sizes.evidence_unchanged:
            raise SourceUnavailable()
        del previous,previous_incoming
        if evidence.evidence_size(merged) != merged_sizes.evidence_bytes or display.display_size(merged) != merged_sizes.display_bytes:
            raise SourceUnavailable()
        encoded = evidence.encode_evidence(merged)
        labels = display.encode_display(merged)
        del merged
        result = PreparedSourceEvidence(item.ordinal,identity,incoming_payload,encoded,labels,matches_prior)
        final = gate.begin_foobar_prepare_on_connection(
            connection,live_context,command=command,constraints=constraints,
        )
        _same_ticket(final,fresh)
        return result
    except (SourceUnavailable,gate.PrepareInvalid):
        raise
    except Exception as exc:
        raise SourceUnavailable() from exc
