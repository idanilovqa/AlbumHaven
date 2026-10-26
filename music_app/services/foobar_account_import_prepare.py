"""Draft same-transaction Prepare composition. Not published or activated."""
from dataclasses import dataclass, replace
from datetime import datetime, timedelta, timezone
import hashlib
import json
import unicodedata
from uuid import uuid4

from . import foobar_account_apply_command as apply_command
from . import foobar_account_prepare_gate as gate
from . import foobar_account_prepared_envelope as envelope
from . import foobar_source_evidence as evidence
from . import foobar_account_observation_preview as observation_preview
from . import foobar_account_source_postgres as source
from . import foobar_account_prepared_source_validation as original_sources
from . import foobar_account_import_associations as associations
from . import foobar_account_import_jobs as jobs
from . import foobar_account_indexed_upload as indexed
from . import track_preferences_postgres as taste
from .foobar_account_source_postgres import SourceUnavailable, SourceStale

MAX_PRIVATE_BYTES = 4_194_304
MAX_INSERT_FRAME = 2048
# Native inventory SQL has only fixed scope parameters or <=100 IDs per path
# batch. This separately admits the deadline forwarding view, not raw paths.
INVENTORY_FORWARDING_BYTES = 16384
# Fixed review counters, <=32 public problems, bounded tuple views, and two
# 4096-byte hash-chunk views. Reserved alongside EVERY candidate phase before
# retaining any review output; never one prepared tree per uploaded row.
REVIEW_CONTROL_BYTES = 65536
MAX_REVIEW_PROBLEMS = 32
# Optional presentation only, separate from the unchanged candidate/private
# prefix budget. Reserve the complete helper phase plus all retained page views
# from server intake before any per-window work. Never retain all conflicts.
MAX_PERSONAL_CONFLICTS = 32
# Label extension ledger: four1024-byte fixed decision views per member,
# four6144-byte aggregate label views, two(3*6144+512)-byte escaped-label
# views, two256-byte public fixed-field views per member and32768 scratch:
# 242688 logical bytes, below the conservative262144-byte control reserve.
CONFLICT_CONTROL_BYTES = 262144
CONFLICT_REVIEW_BYTES = 2097152+CONFLICT_CONTROL_BYTES
# Independent optional presentation: <=32 labelled problem instances and one
# <=30-item per-row classifier scratch. No native metadata/fence read phase.
PROBLEM_CONTROL_BYTES = 262144
PROBLEM_CURSOR_STRIDE = 32
_CONFLICT_LABEL_LIMITS = (('artist',48),('title',96),('album',48))
REVIEW_VERSION = 'foobar_account_semantic_review_v1'
_REVIEW_PROBLEM_CODES = frozenset((
    'no_matching_library', 'explicit_detach', 'association_unavailable',
    'duplicate_source_identity', 'ambiguous_library_identity',
    'duplicate_local_target', 'association_conflict', 'target_not_eligible',
    'no_local_match', 'invalid_rating', 'invalid_favorite', 'invalid_count',
    'unsupported_history_field', 'protected_rating', 'protected_favorite'))


@dataclass(frozen=True, slots=True)
class FoobarPreparedReceipt:
    """Only constructed from a verified persisted receipt, returned after commit."""
    source_ref: str
    generation: int
    receipt_ref: str
    prepared_sha256: str
    decision_sha256: str
    window_start: int
    window_end: int
    total_rows: int
    expires_at: datetime
    terminal_bytes: bytes | None
    association_review: tuple | None = None
    # Internal per-window semantic fence, not another client authority token.
    proposal_sha256: str | None = None


def _association_review(original):
    """Small public projection of an already authenticated strict envelope."""
    if (type(original) is not tuple or len(original)!=5
            or type(original[2]) is not tuple or type(original[4]) is not tuple
            or not 1<=len(original[2])<=100 or len(original[2])!=len(original[4])):
        raise SourceUnavailable()
    return tuple((row[0],row[2],seal[8],seal[9] is not None)
                 for row,seal in zip(original[2],original[4]))


def _private(required):
    if type(required) is not int or required < 0 or required > MAX_PRIVATE_BYTES:
        raise SourceUnavailable()


def _utc(value):
    if type(value) is not datetime or value.utcoffset() != timedelta(0):
        raise SourceUnavailable()
    text = value.isoformat(timespec='microseconds').replace('+00:00','Z')
    if len(text) != 27:
        raise SourceUnavailable()
    return text


def _parameters_query(connection, sql, parameters, *, maximum=1):
    # Only admitted native binary parameters; cleanup survives ordinary errors.
    cursor = connection.execute(sql, parameters, binary=True)
    try:
        rows = cursor.fetchmany(maximum+1)
        if type(rows) is not list or len(rows) > maximum:
            raise SourceUnavailable()
        return rows
    finally:
        cursor.close()


_INSERT_READY_SQL = """
with f as materialized (select convert_from(%b::bytea,'UTF8')::jsonb j),
b as materialized (select %b::bytea payload),
x as materialized (select j->0 h,j->>1 prepared_sha256,j->>2 decision_sha256,
 j->>3 command_sha256,(j->>4)::bigint prepared_size from f),
receipt as (
 insert into integration.foobar_import_receipts_v2
 (account_id,source_ref,generation,receipt_ref,prepare_key,
  original_session_id,state,expected_revision,upload_sha256,parser_version,
  mapping_name,total_rows,window_start,window_end,inventory_sha256,
  authority_sha256,decision_sha256,prepared_bytes,prepared_sha256,
  created_at,ready_until,expires_at)
 select (h->>0)::bigint,(h->>3)::uuid,(h->>4)::bigint,
  (h->>6)::uuid,(h->>5)::uuid,(h->>2)::bigint,'ready',(h->>7)::bigint,
  decode(h->>8,'hex'),h->>9,h->>10,(h->>11)::integer,(h->>12)::integer,
  (h->>13)::integer,decode(h->>14,'hex'),decode(h->>15,'hex'),
  decode(decision_sha256,'hex'),b.payload,decode(prepared_sha256,'hex'),
  (h->>16)::timestamptz,(h->>16)::timestamptz+interval '1 hour',
  (h->>16)::timestamptz+interval '1 hour'
 from x cross join b
 where octet_length(b.payload)=prepared_size
   and sha256(b.payload)=decode(prepared_sha256,'hex')
 returning account_id,source_ref,generation,receipt_ref,prepare_key,created_at,ready_until
), request_key as (
 insert into integration.foobar_import_request_keys_v2
 (account_id,source_ref,generation,request_key,operation,
  command_sha256,original_receipt_ref,receipt_ref,state,created_at)
 select r.account_id,r.source_ref,r.generation,r.prepare_key,
  'prepare',decode(x.command_sha256,'hex'),r.receipt_ref,r.receipt_ref,'active',r.created_at
 from receipt r cross join x
 returning original_receipt_ref
)
select r.receipt_ref::text receipt_ref,r.created_at,r.ready_until,
 clock_timestamp() observed_at
from receipt r join request_key k on k.original_receipt_ref=r.receipt_ref
"""


def _ready_insert_phase_bytes(prepared_bytes, frame_bytes):
    if (type(prepared_bytes) is not int or prepared_bytes < 1
            or type(frame_bytes) is not int or not 1 <= frame_bytes <= MAX_INSERT_FRAME):
        raise SourceUnavailable()
    # Two original root views; two raw payload views; parameter tuple in caller
    # and query callee; deadline-wrapper params; native binary parameter and
    # server-bound bytea: 9P. Ten frame views and two parameter-holder envelopes.
    # Fixed header/result/clock controls are unchanged.
    return 9*prepared_bytes+10*frame_bytes+5+16384


def _insert_ready_on_connection(connection, live, *, original_value, payload,
                                prepared_sha256, decision_sha256, command,
                                expected_header, ticket, constraints):
    """Paired DML only; outer caller owns complete original/future admission.

    Entry requires no retained source outputs or typed taste arrays. This helper
    does not turn a framing-valid envelope into an admitted decision, commit the
    transaction, or produce a public success response.
    """
    taste._foobar_taste_connection(connection)
    _account_context(live)
    if type(payload) is not bytes:
        raise SourceUnavailable()
    p = len(payload)
    controls = (expected_header,prepared_sha256,decision_sha256,ticket.command_sha256,p)
    f = evidence._json_size(controls)
    from .foobar_account_import_apply import _association_hold_bytes
    _private(_ready_insert_phase_bytes(p,f)+_association_hold_bytes(len(original_value[2]),p))
    envelope._validate(original_value,original_command=command,expected_header=expected_header)
    if (original_value[1][:3] != (live.actor.account_id,live.library_id,live.actor.session_id)
            or evidence._json_size(original_value) != p
            or envelope._digests(payload) != (prepared_sha256,decision_sha256)
            or ticket.disposition != 'new'
            or ticket.command_sha256 != gate.prepare_command_digest(command,
                account_id=live.actor.account_id,library_id=command.matching_library_id,session_id=live.actor.session_id)):
        raise SourceUnavailable()
    source._authority(live,constraints)
    frame = json.dumps(controls,ensure_ascii=True,separators=(',',':')).encode('ascii')
    if len(frame) != f:
        raise SourceUnavailable()
    rows = _parameters_query(connection,_INSERT_READY_SQL,(frame,payload))
    del frame,controls
    if (len(rows) != 1 or type(rows[0]) is not dict
            or set(rows[0]) != {'receipt_ref','created_at','ready_until','observed_at'}):
        raise SourceUnavailable()
    row = rows[0]
    if (row['receipt_ref'] != expected_header[6]
            or any(type(row[name]) is not datetime or row[name].utcoffset() != timedelta(0)
                   for name in ('created_at','ready_until','observed_at'))
            or _utc(row['created_at']) != expected_header[16]
            or row['ready_until'] != row['created_at']+timedelta(hours=1)
            or row['observed_at'] < row['created_at']
            or row['observed_at'] < ticket.observed_at):
        raise SourceUnavailable()
    if row['observed_at'] >= row['ready_until']:
        raise SourceStale()
    return row['observed_at'],row['ready_until']

# Genuine published/accepted owners, not injectable stand-ins.
from . import foobar_snapshot_parser as parser
from . import foobar_source_window as window
from . import foobar_account_source_lookup as lookup
from . import foobar_account_source_merge_sizes as sizing
from . import foobar_account_source_prior_merge as prior_merge
from . import foobar_account_authority_snapshot as authority
from . import foobar_account_import_terminal as terminal_codec
from . import foobar_import_preparation as intake
from . import foobar_preview_service as preview
from .foobar_account_authority import account_foobar_context, require_account_foobar
from .foobar_account_matching_authority import current_foobar_import_transaction, lock_foobar_matching_context
from .foobar_preview_inventory_postgres import read_foobar_inventory_scalars_on_connection
from .foobar_preview_inventory_bridge import read_foobar_preview_inventory_on_connection, FoobarInventoryTarget
from .foobar_import_policy import evaluate_foobar_track_policy
from .foobar_snapshot_preview import _path_projections
from .policy_evaluator import PolicyEvaluationConstraints


@dataclass(frozen=True, slots=True)
class _SourcePlan:
    ordinal: int
    observation_ref: str
    track_id: int | None
    allow_taste: bool
    rating: int | None
    favorite: bool
    association_seal: tuple


def _state_values(state):
    return (state.track_id,state.selection_status,state.preference_id,state.identity_seal,
            state.rating,state.love_tier,state.rating_protected,state.favorite_protected,
            state.rating_marker,state.favorite_marker,state.state_seal,
            state.browse_allowed,state.taste_allowed)


def _states_bytes(states):
    # One fixed <=1024-byte member view at a time, never a whole copied array.
    return 2+max(0,len(states)-1)+sum(evidence._json_size(_state_values(s)) for s in states)


def _caller_controls(plans, states, lookup_count):
    # Six typed/ordered/candidate/counter state views; five source-plan views;
    # four outer lookup/counter views (identity128 + prior384 + bucket64,
    # rounded to640 per row) and two merged-size/row-length
    # arrays beyond each accepted callee's own ledger.
    # 32KiB names fixed commands/tickets/header/hash/clock, <=2048 changed-row
    # list/tuple controls and bounded counter scratch.
    return (32768+6*_states_bytes(states)+5*(1024+128*len(plans))
            +4*(1024+640*lookup_count)+2*(1024+128*lookup_count)
            +6*(217*len(plans)+1))


def _terminal_matches(value, first):
    if type(value) is not parser.FoobarScanResult or value.status != 'parsed' or value != first:
        raise SourceUnavailable()


def _resolve_import_target(row, seal, *, proof, projections, target_counts, by_ref, by_id,
                           identity_conflict):
    """Shared new/replay resolver. History outranks all current path guesses."""
    projection=preview._match(row,projections)
    suggested=projection[4] if projection is not None and projection[0]=='exact_unique' else None
    if seal[8]=='saved':
        target=by_id.get(seal[3])
    elif seal[8]=='never_decided':
        target=by_ref.get(suggested)
    else:
        target=None
    if target is None:
        return None,False
    # A browse denial/offline/conflicting identity may not become a planned
    # association. A taste-only denial still retains its native denial state.
    path_count=target_counts.get(target.canonical_track_ref,0)
    own_path=suggested==target.canonical_track_ref
    if (target.selection_status!='ok' or not target.browse_allowed
            or path_count>(1 if own_path else 0)
            or seal[8]=='never_decided' and path_count!=1
            or proof.raw_path_row_counts[row.ordinal-proof.offset-1]!=1
            or identity_conflict):
        return None,False
    return target,True


def _plans_from_upload(connection, live, payload, *, command, constraints, proof, first,
                       projections, target_counts, targets, lookup_result):
    # At most100 entries. This fixed construction is admitted before the scan.
    count=len(lookup_result.identities)
    _private(sizing._base(count)+32768+6*(1024+345*count)
             +associations.association_phase_bytes(count))
    by_ref = {target.canonical_track_ref:target for target in targets}
    by_id = {target.track_id:target for target in targets}
    observations=tuple((proof.offset+i+1,p.observation_ref if p.observation_ref is not None else str(uuid4()))
                       for i,p in enumerate(lookup_result.prior))
    seals=associations.read_import_associations_on_connection(connection,live,
        source_ref=command.source_ref,library_id=command.matching_library_id,
        observations=observations,constraints=constraints)
    # by_ref belongs to the separately admitted complete inventory/intake ledger.
    result = []
    scan = indexed.iter_source_rows(payload, offset=command.offset)
    try:
        while True:
            try:
                row = next(scan)
            except StopIteration as done:
                _terminal_matches(done.value,first)
                break
            index = row.ordinal-proof.offset-1
            if not 0 <= index < len(lookup_result.prior):
                continue
            raw_path = row.cells[row.fields[parser.FIELD_NAMES.index('path')].column_index]
            if raw_path != proof.paths[index]:
                raise SourceUnavailable()
            target,allow=_resolve_import_target(row,seals[index],proof=proof,projections=projections,
                target_counts=target_counts,by_ref=by_ref,by_id=by_id,
                identity_conflict=lookup_result.identities[index].identity_conflict)
            rating_field = row.fields[parser.FIELD_NAMES.index('rating')]
            favorite_field = row.fields[parser.FIELD_NAMES.index('favorite')]
            # No rating_stars fallback and no count/date inference.
            rating = rating_field.value if allow and rating_field.state=='valid' else None
            favorite = bool(allow and favorite_field.state=='valid' and favorite_field.value is True)
            observation_ref=observations[index][1]
            track_id=None if target is None else target.track_id
            result.append(_SourcePlan(row.ordinal,observation_ref,None if target is None else target.track_id,
                                      allow,rating,favorite,seals[index][:9]+(track_id,)))
        if len(result) != len(lookup_result.prior):
            raise SourceUnavailable()
        ids=tuple(sorted({plan.track_id for plan in result if plan.track_id is not None}))
        external=(associations.projection_conflicts_on_connection(connection,live,
            source_ref=command.source_ref,observations=observations,track_ids=ids,
            constraints=constraints) if ids else frozenset())
        # Saved bindings reserve their target even when their current projection
        # is suppressed. Excluding candidate observations from the external
        # query must not let another candidate take such a retained binding.
        # Both rows also lose projection for duplicate newly proposed targets.
        from dataclasses import replace
        return tuple(replace(plan,track_id=None,allow_taste=False,rating=None,favorite=False,
            association_seal=plan.association_seal[:9]+(None,))
            if plan.track_id is not None and (plan.track_id in external
                or any(other.observation_ref!=plan.observation_ref
                       and other.association_seal[8]=='saved'
                       and other.association_seal[3]==plan.track_id for other in result)
                or sum(other.track_id==plan.track_id for other in result)>1) else plan
            for plan in result)
    finally:
        scan.close()


def _record_bytes(row):
    return max(1,len(row.cells)-1+sum(evidence._text_bytes(cell) for cell in row.cells))


def _size_frame_bytes(live, command, item, previous, incoming_bytes):
    fixed = (live.actor.account_id,live.library_id,command.source_ref,
             previous.observation_ref,previous.source_revision,previous.evidence_sha256,
             previous.display_sha256,previous.evidence_bytes,previous.display_bytes,
             incoming_bytes,item.identity_kind,item.identity_sha256,item.identity_bytes,
             command.upload_sha256,item.ordinal,previous.incoming_evidence_sha256,previous.incoming_evidence_bytes)
    return evidence._json_size(fixed)+2*incoming_bytes+3


def _merge_frame_bytes(live, command, item, previous):
    fixed = (live.actor.account_id,live.library_id,command.source_ref,
             previous.observation_ref,previous.source_revision,previous.evidence_sha256,
             previous.display_sha256,item.identity_sha256,item.identity_bytes,
             previous.evidence_bytes,previous.display_bytes,previous.incoming_evidence_sha256,
             previous.incoming_evidence_bytes)
    return evidence._json_size(fixed)+2*item.identity_bytes+3


def _collect_sources(connection, live, *, payload, proof, first, command, ticket,
                     lookup_result, plans, states, receipt_ref, constraints):
    """All selected scalar sizing completes before any prior raw projection.

    Both complete scans must terminate successfully, even after a capacity stop.
    These are private source records, never a ready or committed response.
    """
    from .foobar_account_import_apply import _scalar_counter_phase_bytes
    controls = _caller_controls(plans,states,len(lookup_result.identities))
    sizes = []
    # Scalar-only lower bound; it excludes every header/state/row delimiter.
    # Each additional row adds positive disjoint hex bytes, so this bound and
    # the existing scalar-counter reservation are monotone in prefix length.
    # No suffix can fit after this lower bound fails. Still drain both scans.
    minimum_prepared_bytes = 0
    stopped = False
    scan = indexed.iter_source_rows(payload, offset=command.offset)
    try:
        while True:
            try:
                row = next(scan)
            except StopIteration as done:
                _terminal_matches(done.value,first)
                break
            index = row.ordinal-command.offset-1
            if stopped or not 0 <= index < len(plans):
                continue
            record_size = _record_bytes(row)
            if controls+sizing._base(len(lookup_result.identities))+evidence.row_phase_bytes(record_size) > MAX_PRIVATE_BYTES:
                stopped = True
                continue
            fields = evidence.fields_from_row(row,upload_sha256=command.upload_sha256)
            n = evidence.evidence_size(fields)
            item,previous = lookup_result.identities[index],lookup_result.prior[index]
            f = _size_frame_bytes(live,command,item,previous,n)
            phase = max(sizing._base(len(lookup_result.identities))+6*n+evidence.CLASSIFIER_WORK_BYTES,
                sizing.merged_source_size_phase_bytes(count=len(lookup_result.identities),incoming_bytes=n,
                                                       prior_bytes=previous.evidence_bytes,prior_incoming_bytes=previous.incoming_evidence_bytes,frame_bytes=f))
            if controls+phase > MAX_PRIVATE_BYTES:
                del fields
                stopped = True
                continue
            incoming = evidence.encode_evidence(fields)
            size = sizing.size_foobar_source_merge_on_connection(connection,live,command=command,
                ticket=ticket,lookup_result=lookup_result,index=index,incoming_payload=incoming,constraints=constraints)
            del incoming,fields
            if size is None:
                stopped = True
                continue
            sizes.append(_SizedSource(size,n,record_size))
            minimum_prepared_bytes += 2*(item.identity_bytes+n+size.evidence_bytes+size.display_bytes)
            if (minimum_prepared_bytes > envelope.MAX_BYTES
                    or _scalar_counter_phase_bytes(minimum_prepared_bytes,
                        source_count=len(sizes),taste_count=0)+REVIEW_CONTROL_BYTES > MAX_PRIVATE_BYTES):
                stopped = True
    finally:
        scan.close()
    sizes = tuple(sizes)
    retained = ()
    stopped = False
    scan = indexed.iter_source_rows(payload, offset=command.offset)
    try:
        while True:
            try:
                row = next(scan)
            except StopIteration as done:
                _terminal_matches(done.value,first)
                break
            index = row.ordinal-command.offset-1
            if stopped or not 0 <= index < len(sizes):
                continue
            candidate_peak,unused_size = _candidate_phase_bytes(live,command=command,proof=proof,
                plans=plans,states=states,lookup_result=lookup_result,sizes=sizes,count=index+1,
                receipt_ref=receipt_ref,created_at=ticket.observed_at)
            del unused_size
            if candidate_peak > MAX_PRIVATE_BYTES:
                stopped = True
                continue
            retained_cost = prior_merge._retained_bytes(retained)
            if controls+sizing._base(len(lookup_result.identities))+retained_cost+evidence.row_phase_bytes(_record_bytes(row)) > MAX_PRIVATE_BYTES:
                stopped = True
                continue
            fields = evidence.fields_from_row(row,upload_sha256=command.upload_sha256)
            n = evidence.evidence_size(fields)
            item,previous = lookup_result.identities[index],lookup_result.prior[index]
            phase = prior_merge.source_prior_merge_phase_bytes(count=len(lookup_result.identities),retained=retained,
                incoming_bytes=n,identity_bytes=item.identity_bytes,prior_bytes=previous.evidence_bytes,
                prior_display_bytes=previous.display_bytes,prior_incoming_bytes=previous.incoming_evidence_bytes,merged_bytes=sizes[index].merge.evidence_bytes,
                display_bytes=sizes[index].merge.display_bytes,frame_bytes=_merge_frame_bytes(live,command,item,previous))
            row_bytes = 1024+item.identity_bytes+n+sizes[index].merge.evidence_bytes+sizes[index].merge.display_bytes
            phase = max(phase,sizing._base(len(lookup_result.identities))+retained_cost+2*row_bytes+1024)
            if controls+phase > MAX_PRIVATE_BYTES:
                del fields
                stopped = True
                continue
            value = prior_merge.reconstruct_foobar_source_on_connection(connection,live,command=command,
                ticket=ticket,lookup_result=lookup_result,index=index,merged_sizes=sizes[index].merge,incoming_fields=fields,
                retained=retained,constraints=constraints)
            del fields
            if value is None:
                stopped = True
                continue
            # Name the old tuple, current result and new tuple before allocation.
            row_bytes = 1024+len(value.identity_bytes)+len(value.incoming_evidence_bytes)+len(value.merged_evidence_bytes)+len(value.display_bytes)
            _private(controls+sizing._base(len(lookup_result.identities))+retained_cost+2*row_bytes+1024)
            retained = retained+(value,)
            del value
    finally:
        scan.close()
    return retained,sizes


@dataclass(frozen=True, slots=True)
class _SizedSource:
    merge: sizing.MergedSourceSizes
    incoming_bytes: int
    record_bytes: int


def _selected_states(states, plans, count):
    # At most100 references, after the fixed scalar-control admission.
    return tuple(state for state in states if any(plans[j].track_id==state.track_id for j in range(count)))


def _header_without_authority(live, command, proof, count, receipt_ref, created_at):
    return (live.actor.account_id,command.matching_library_id,live.actor.session_id,command.source_ref,
            command.generation,command.request_key,receipt_ref,command.expected_revision,
            command.upload_sha256,evidence.PARSER_VERSION,gate.MAPPING,proof.total_rows,
            command.offset+1,command.offset+count+1,command.inventory_sha256,_utc(created_at))


def _prepared_size_from_scalars(header_without_authority, plans, states, lookup_result, sizes, count):
    # Authority digest contributes exactly66 JSON bytes and one new comma.
    header_bytes = evidence._json_size(header_without_authority)+67
    row_bytes = 2+max(0,count-1)
    for index in range(count):
        item,previous,plan,size = lookup_result.identities[index],lookup_result.prior[index],plans[index],sizes[index]
        target_index = next((j for j,state in enumerate(states) if state.track_id==plan.track_id),None)
        rating,favorite = _proposed_taste(plan,states,target_index)
        # Twelve ordered members, eleven commas and brackets; no hex allocation.
        row_bytes += 13+evidence._json_size(plan.ordinal)+2*item.identity_bytes+2+38
        row_bytes += sum(evidence._json_size(v) for v in
                         (previous.source_revision,previous.evidence_sha256,previous.display_sha256))
        row_bytes += 2*(size.incoming_bytes+size.merge.evidence_bytes+size.merge.display_bytes)+6
        row_bytes += evidence._json_size(target_index)+evidence._json_size(rating)+evidence._json_size(favorite)
    seal_bytes=2+max(0,count-1)+sum(evidence._json_size(plans[i].association_seal) for i in range(count))
    return 6+evidence._json_size(envelope.VERSION)+header_bytes+row_bytes+_states_bytes(states)+seal_bytes


def _proposed_taste(plan, states, target_index):
    if target_index is None or not plan.allow_taste:
        return None,False
    state = states[target_index]
    if state.selection_status != 'ok' or not state.browse_allowed or not state.taste_allowed:
        return None,False
    return plan.rating,plan.favorite


def _source_writer_sizes(live, command, plans, lookup_result, sizes, count):
    raw = rows = max_i = max_m = max_d = max_n = 0
    comparison = occurrences = 0
    for index in range(count):
        item,previous,size = lookup_result.identities[index],lookup_result.prior[index],sizes[index]
        i,m,d,n = item.identity_bytes,size.merge.evidence_bytes,size.merge.display_bytes,size.incoming_bytes
        raw += i+m+d+n
        rows += (9+38+evidence._json_size(item.identity_kind)+evidence._json_size(previous.source_revision)
                 +evidence._json_size(previous.evidence_sha256)+evidence._json_size(previous.display_sha256)
                 +2*(i+m+d+n)+9)
        max_i,max_m,max_d,max_n = max(max_i,i),max(max_m,m),max(max_d,d),max(max_n,n)
        bucket_count,bucket_bytes = lookup_result.candidates[index]
        comparison += bucket_bytes
        occurrences += bucket_count
        added = 0
        for other_index in range(count):
            other = lookup_result.identities[other_index]
            if (item.identity_kind,item.identity_sha256)==(other.identity_kind,other.identity_sha256):
                other_size = sizes[other_index]
                comparison += other.identity_bytes+other_size.merge.evidence_bytes+other_size.merge.display_bytes+other_size.incoming_bytes
                added += lookup_result.prior[other_index].observation_ref is None
        if bucket_count+added > 100:
            raise SourceUnavailable()
        occurrences += added
    scope = evidence._json_size((live.actor.account_id,command.source_ref,
                                command.generation,command.expected_revision,()))
    phase,frame,base,result = source._source_write_phase_from_sizes(count=count,raw=raw,row_sizes=rows,
        maximum_identity=max_i,maximum_evidence=max_m,maximum_display=max_d,
        maximum_incoming_evidence=max_n,scope_size=scope)
    comparison_phase = base+6*frame+4+2*result+11*comparison+384*occurrences+evidence.CLASSIFIER_WORK_BYTES
    return max(phase,comparison_phase),raw,frame


def _candidate_phase_bytes(live, *, command, proof, plans, states, lookup_result, sizes,
                           count, receipt_ref, created_at):
    """Exact prefix recipe over actual scalar proofs, never raw payload fetch."""
    selected = _selected_states(states,plans,count)
    ids = tuple(state.track_id for state in selected)
    header_parts = _header_without_authority(live,command,proof,count,receipt_ref,created_at)
    p = _prepared_size_from_scalars(header_parts,plans,selected,lookup_result,sizes,count)
    if p > MAX_PRIVATE_BYTES:
        return MAX_PRIVATE_BYTES+1,p
    from .foobar_account_import_apply import _association_hold_bytes
    association_hold=_association_hold_bytes(count,p)
    c_prepare = _caller_controls(plans,states,len(lookup_result.identities))+association_hold
    c_future = _caller_controls(plans[:count],selected,count)+association_hold
    auth = authority.authority_snapshot_phase_bytes(live,track_ids=ids)
    writer,raw_write,unused_frame = _source_writer_sizes(live,command,plans,lookup_result,sizes,count)
    del unused_frame
    raw_all = sum(lookup_result.identities[j].identity_bytes+sizes[j].incoming_bytes+
                  sizes[j].merge.evidence_bytes+sizes[j].merge.display_bytes for j in range(count))
    maximum_component = max(max(lookup_result.identities[j].identity_bytes,sizes[j].incoming_bytes,
                        sizes[j].merge.evidence_bytes,sizes[j].merge.display_bytes) for j in range(count))
    ready_owners = 2*(1024+1024*count+raw_all)
    write_owner = raw_write+1024+640*count
    outcomes = 4096+320*count  # Both source/taste outcome arrays and return/construction views.
    peaks = [
        c_prepare+ready_owners+3*p+2*maximum_component, # Root/list/tuple/hex construction.
        c_prepare+ready_owners+envelope.prepared_envelope_phase_bytes(p,decode=False),
        c_prepare+ready_owners+auth,                   # Genuine selected authority digest.
        c_future+envelope.prepared_envelope_phase_bytes(p,decode=True),
        c_future+_ready_insert_phase_bytes(p,MAX_INSERT_FRAME),
        c_future+5*p+write_owner+writer,              # Root views, caller items, real writer.
        c_future+5*p+2*write_owner+outcomes+taste._foobar_taste_phase_bytes(len(ids)),
        c_future+5*p+gate.PREPARE_GATE_BYTES,
        c_future+5*p+6*(2048+256*count)+4+2*(1024+32*count),
        c_future+5*p+auth,                         # Final current authority/target snapshot.
        c_future+5*p+2*write_owner+outcomes+terminal_codec.ENCODE_CONTRIBUTION
            +terminal_codec.DECODE_CONTRIBUTION+apply_command.MAX_PHASE_BYTES+10*2048+5+2*4096
            +terminal_codec.MAX_WIRE_BYTES,
        c_future+5*p+2*write_owner+2*maximum_component, # Apply hex reconstruction/constructor overlap.
    ]
    # Actual outer Apply successor uses the same owner-derived prefix sizes.
    # Local import avoids an import-time cycle; no runtime callback/budget DTO.
    from .foobar_account_import_apply import _later_apply_peak_bytes
    peaks.append(_later_apply_peak_bytes(controls=c_future,prepared_bytes=p,
        write_owner=write_owner,outcomes=outcomes,taste_count=len(ids),source_phase=writer,
        authority_phase=auth,maximum_component=maximum_component,source_count=count))
    # Immutable original prior verifier, serial per row. Native scalar evidence
    # already supplies these exact lengths/hashes/kind before any prior bytea.
    for j in range(count):
        item,previous,size,plan = lookup_result.identities[j],lookup_result.prior[j],sizes[j],plans[j]
        controls = (live.actor.account_id,live.library_id,command.source_ref,plan.observation_ref,
                    previous.source_revision,previous.evidence_sha256,previous.display_sha256)
        if previous.observation_ref is not None:
            controls += (previous.identity_bytes,previous.evidence_bytes,previous.display_bytes,
                         item.identity_sha256,item.identity_kind,previous.incoming_evidence_bytes,
                         previous.incoming_evidence_sha256)
        peaks.extend((c_future+5*p+evidence.row_phase_bytes(size.record_bytes),
                      c_future+5*p+5*size.incoming_bytes+evidence.CLASSIFIER_WORK_BYTES,
                      c_future+5*p+5*item.identity_bytes+128))
        peaks.append(c_future+original_sources._phase_bytes(prepared_bytes=p,identity_bytes=item.identity_bytes,
            incoming_bytes=size.incoming_bytes,merged_bytes=size.merge.evidence_bytes,
            display_bytes=size.merge.display_bytes,prior_identity_bytes=previous.identity_bytes,
            prior_bytes=previous.evidence_bytes,prior_display_bytes=previous.display_bytes,
            prior_incoming_bytes=previous.incoming_evidence_bytes,frame_bytes=evidence._json_size(controls))+original_sources.CLASSIFICATION_BYTES)
    return max(peaks)+REVIEW_CONTROL_BYTES,p


_CURRENT_SOURCE_SQL = """
with f as materialized (select convert_from(%b::bytea,'UTF8')::jsonb j),
x as materialized (select (j->>0)::bigint account_id,(j->>1)::bigint library_id,
 (j->>2)::uuid source_ref,(j->>3)::bigint expected_revision,j->4 rows from f),
r as materialized (select x.*,a.v,a.ordinality::integer ordinal
 from x cross join lateral jsonb_array_elements(x.rows) with ordinality a(v,ordinality))
select r.ordinal,
 case when r.v->>1 is null then o.observation_ref is null
 else o.observation_ref is not null and o.current_revision=(r.v->>1)::bigint
  and q.evidence_sha256=decode(r.v->>2,'hex') and q.display_sha256=decode(r.v->>3,'hex')
 end as valid
from r join integration.foobar_import_streams_v2 s
 on (s.account_id,s.source_ref,s.revision)=
    (r.account_id,r.source_ref,r.expected_revision)
left join integration.foobar_import_observations_v2 o
 on (o.account_id,o.source_ref,o.observation_ref)=
    (r.account_id,r.source_ref,(r.v->>0)::uuid)
left join integration.foobar_import_revisions_v2 q
 on (q.account_id,q.source_ref,q.observation_ref,q.source_revision)=
    (o.account_id,o.source_ref,o.observation_ref,o.current_revision)
order by r.ordinal
"""


def _current_source_check(connection, live, command, original_value):
    p = evidence._json_size(original_value)
    count = len(original_value[2])
    f_bound,v_bound = 2048+256*count,1024+32*count
    from .foobar_account_import_apply import _association_hold_bytes
    _private(32768+5*p+6*f_bound+4+2*v_bound+_association_hold_bytes(count,p))
    rows = tuple((row[2],row[3],row[4],row[5]) for row in original_value[2])
    frame_value = (live.actor.account_id,live.library_id,command.source_ref,command.expected_revision,rows)
    if evidence._json_size(frame_value) > f_bound:
        raise SourceUnavailable()
    frame = json.dumps(frame_value,ensure_ascii=True,separators=(',',':'),allow_nan=False).encode('ascii')
    del frame_value,rows
    found = source._query(connection,_CURRENT_SOURCE_SQL,frame,maximum=count)
    if len(found) != count:
        raise SourceStale()
    for ordinal,row in enumerate(found,1):
        if (type(row) is not dict or set(row) != {'ordinal','valid'}
                or type(row['ordinal']) is not int or row['ordinal'] != ordinal
                or type(row['valid']) is not bool):
            raise SourceUnavailable()
        if not row['valid']:
            raise SourceStale()


def _original_source_admission(connection, live, original_value):
    """Repeat only fixed immutable-prior scalars before the genuine verifier."""
    p = evidence._json_size(original_value)
    from .foobar_account_import_apply import _association_hold_bytes
    held=_association_hold_bytes(len(original_value[2]),p)
    _private(32768+5*p+16384+held)
    header = original_value[1]
    for row in original_value[2]:
        i,n,m,s = (len(row[k])//2 for k in (1,6,7,8))
        ip=o=d=prior_incoming_size=0
        controls = original_sources._frame_values(header,row)
        full_controls = controls
        if row[3] is not None:
            frame = original_sources._encode_frame(controls)
            scalar = original_sources._one(connection,original_sources._SCALAR_SQL,frame,{
                'identity_bytes_size','evidence_bytes_size','display_bytes_size','identity_sha256','identity_kind',
                'incoming_evidence_bytes_size','incoming_evidence_sha256'})
            del frame
            ip,o,d,prior_hash,prior_kind,prior_incoming_size,prior_incoming_hash = original_sources._scalar(scalar)
            del scalar
            full_controls = controls+(ip,o,d,prior_hash,prior_kind,prior_incoming_size,prior_incoming_hash)
        if header[10]==gate.ENHANCED_MAPPING:
            _private(32768+original_sources.enhanced_source_phase_bytes(prepared_bytes=p,held=held,
                identity_bytes=i,incoming_bytes=n,merged_bytes=m,display_bytes=s,
                prior_identity_bytes=ip,prior_bytes=o,prior_display_bytes=d,
                prior_incoming_bytes=prior_incoming_size,frame_bytes=evidence._json_size(full_controls)))
        else:
            _private(32768+original_sources._phase_bytes(prepared_bytes=p,identity_bytes=i,
                incoming_bytes=n,merged_bytes=m,display_bytes=s,prior_identity_bytes=ip,
                prior_bytes=o,prior_display_bytes=d,prior_incoming_bytes=prior_incoming_size,frame_bytes=evidence._json_size(full_controls))+original_sources.CLASSIFICATION_BYTES+held)


def _inventory_intake_bytes(payload_bytes, proof_bytes, file_count, path_bytes):
    # Seven full-upload argument/decoder views. Four real proof views. Existing
    # bridge/matcher owners plus three extra scalar snapshots and three extra
    # target tuples (outer, current-check and full-policy helper). Also retain
    # the by-ref target map and fourth nested matching-map view.
    return (7*payload_bytes+window.PARSER_WORK_BYTES+4*proof_bytes
            +intake._inventory_reservation(file_count,path_bytes)
            +3*(132*file_count+2)+3*(113*file_count+1)+2*(202*file_count+2)
            +6*path_bytes+1024*file_count+2+INVENTORY_FORWARDING_BYTES)


NO_LIBRARY_INVENTORY_SHA256 = hashlib.sha256(b'albumhaven.foobar.account.no-library.v1\n').hexdigest()


def _account_context(context):
    # Account authority alone never grants the optional local scope.
    return account_foobar_context(context)


def _matching_context(connection, account_live, request_context, matching_library_id, *, constraints=None):
    return lock_foobar_matching_context(connection, account_live, request_context,
                                        matching_library_id, constraints=constraints)


@dataclass(frozen=True, slots=True)
class _AccountInventory:
    revision: str = NO_LIBRARY_INVENTORY_SHA256
    files: tuple = ()
    targets: tuple = ()


def _account_inventory(live, command, constraints=None):
    _account_context(live)
    require_account_foobar(live, constraints)
    if command.matching_library_id is not None or command.inventory_sha256 != NO_LIBRARY_INVENTORY_SHA256:
        raise SourceStale()
    return _AccountInventory()


def _read_account_inventory(connection, live, command, *, constraints, capacity):
    if command.matching_library_id is None:
        return _account_inventory(live, command, constraints)
    if live.library_id != command.matching_library_id:
        raise SourceStale()
    intake._admit(capacity,preview.SCALAR_WORK_BYTES+INVENTORY_FORWARDING_BYTES)
    preliminary = read_foobar_inventory_scalars_on_connection(connection, live, constraints=constraints)
    intake._admit(capacity, _inventory_intake_bytes(0, 0, len(preliminary),
                  sum(row.path_bytes for row in preliminary)))
    inventory = read_foobar_preview_inventory_on_connection(connection, live,
        expected_files=preliminary, constraints=constraints)
    if inventory.revision != command.inventory_sha256:
        raise SourceStale()
    return inventory


def _read_inventory(connection, live, *, payload, proof, command, constraints, capacity):
    proof_bytes = window.source_window_proof_bytes(proof)
    intake._admit(capacity,indexed.retained_bytes(payload)+7*len(payload)+window.PARSER_WORK_BYTES+4*proof_bytes+preview.SCALAR_WORK_BYTES+INVENTORY_FORWARDING_BYTES)
    if command.matching_library_id is None:
        inventory = _account_inventory(live, command, constraints)
        projections = {}
    else:
        if live.library_id != command.matching_library_id:
            raise SourceStale()
        preliminary = read_foobar_inventory_scalars_on_connection(connection,live,constraints=constraints)
        cache_reservation = (intake._inventory_reservation(len(preliminary), sum(row.path_bytes for row in preliminary))
                             if type(payload) is indexed._AccountIndexedUpload else 0)
        intake._admit(capacity,indexed.retained_bytes(payload)+cache_reservation+_inventory_intake_bytes(len(payload),proof_bytes,len(preliminary),
                                                     sum(row.path_bytes for row in preliminary)))
        inventory = read_foobar_preview_inventory_on_connection(connection,live,
            expected_files=preliminary,constraints=constraints)
        if inventory.revision != command.inventory_sha256:
            raise SourceStale()
        projections = _path_projections(inventory.inventory)
    if type(payload) is indexed._AccountIndexedUpload:
        # Source-only scope has no native cache; empty projections still prove
        # a complete global pass once. Native cache admission includes old/new.
        if command.matching_library_id is None:
            cache_reservation = 4096
            intake._admit(capacity,indexed.retained_bytes(payload)+cache_reservation
                          +window.PARSER_WORK_BYTES+4*proof_bytes)
        first,target_counts = payload._global_target_counts(projections, reservation=cache_reservation)
    else:
        first,matches,target_counts,unused = preview._scan(payload,projections)
        del matches,unused
    if (first.source_sha256 != proof.source_sha256 or first.summary.data_rows != proof.total_rows
            or proof.source_sha256 != command.upload_sha256):
        raise SourceUnavailable()
    return inventory,projections,first,target_counts


def _build_original(live, *, command, proof, plans, states, lookup_result, sizes,
                    sources, receipt_ref, authority_sha256, created_at):
    count = len(sources)
    peak,p = _candidate_phase_bytes(live,command=command,proof=proof,plans=plans,states=states,
        lookup_result=lookup_result,sizes=sizes,count=count,receipt_ref=receipt_ref,created_at=created_at)
    _private(peak)
    selected = _selected_states(states,plans,count)
    parts = _header_without_authority(live,command,proof,count,receipt_ref,created_at)
    header = parts[:-1]+(authority_sha256,parts[-1])
    rows=[]
    source_changed=taste_changed=False
    for index,value in enumerate(sources):
        plan,previous = plans[index],lookup_result.prior[index]
        target_index = next((j for j,state in enumerate(selected) if state.track_id==plan.track_id),None)
        rating,favorite = _proposed_taste(plan,selected,target_index)
        source_changed = source_changed or not value.matches_prior
        if target_index is not None:
            write_rating,promote = taste._foobar_taste_mutation_flags(selected[target_index],rating=rating,favorite=favorite)
            taste_changed = taste_changed or write_rating or promote
        rows.append((plan.ordinal,value.identity_bytes.hex(),plan.observation_ref,previous.source_revision,
            previous.evidence_sha256,previous.display_sha256,value.incoming_evidence_bytes.hex(),
            value.merged_evidence_bytes.hex(),value.display_bytes.hex(),target_index,rating,favorite))
    association_changed=any(plan.association_seal[8]=='never_decided'
                            and plan.association_seal[9] is not None for plan in plans[:count])
    _revision_after(command.expected_revision,source_changed,taste_changed,
                    association_changed=association_changed)
    frozen_rows=tuple(rows)
    del rows
    state_values=tuple(_state_values(state) for state in selected)
    seal_values=tuple(plan.association_seal for plan in plans[:count])
    original=(envelope.VERSION,header,frozen_rows,state_values,seal_values)
    del frozen_rows,state_values,seal_values
    if evidence._json_size(original) != p:
        raise SourceUnavailable()
    payload,prepared_sha256,decision_sha256=envelope.encode_prepared_envelope(
        original,original_command=command,expected_header=header)
    return original,payload,prepared_sha256,decision_sha256


def _verify_upload(original_value, *, payload, proof, first, projections, target_counts, targets, replaying, review=False,
                   problem_after=None, problem_limit=MAX_REVIEW_PROBLEMS):
    """No original incoming row is trusted merely because its digest matches."""
    if type(replaying) is not bool or type(review) is not bool:
        raise SourceUnavailable()
    _check_problem_page(problem_after,problem_limit)
    if problem_after is not None and (not review or type(payload) is not indexed._AccountIndexedUpload):
        raise SourceUnavailable()
    p=evidence._json_size(original_value)
    from .foobar_account_import_apply import _association_hold_bytes
    held=_association_hold_bytes(len(original_value[2]),p)
    review_hold=REVIEW_CONTROL_BYTES if review else 0
    _private(32768+5*p+16384+held+review_hold)
    by_ref={target.canonical_track_ref:target for target in targets}
    by_id={target.track_id:target for target in targets}
    header=original_value[1]
    # Collected during the already required exact-upload verification pass.
    # These fixed safe-code projections contain no raw source cell values.
    review_counts = [len(original_value[2]),0,0,0,0,0] if review else None
    review_problems = [] if review else None
    review_truncated = False
    problem_items=[] if problem_after is not None else None
    problem_count=problem_remaining=0
    stream=indexed.iter_source_rows(payload, offset=proof.offset)
    seen=0
    try:
        while True:
            try:
                parsed=next(stream)
            except StopIteration as done:
                _terminal_matches(done.value,first)
                break
            if not header[12] <= parsed.ordinal < header[13]:
                continue
            row=original_value[2][parsed.ordinal-header[12]]
            path=parsed.cells[parsed.fields[0].column_index]
            seal=original_value[4][parsed.ordinal-header[12]]
            native_conflict=False  # Library conflicts affect matching, never personal identity.
            conflict=window.source_window_identity_conflict(proof,ordinal=parsed.ordinal,raw_path=path,
                                                           native_identity_conflict=native_conflict)
            identity_value=('path',path) if path and not conflict else ('occurrence',header[8],str(parsed.ordinal))
            i=evidence._json_size(identity_value)
            del identity_value
            if i != len(row[1])//2:
                raise SourceUnavailable()
            _private(32768+5*p+5*i+128+held+review_hold)
            identity=evidence._source_identity_bytes(path,upload_sha256=header[8],ordinal=parsed.ordinal,
                                                     identity_conflict=conflict)
            expected_identity=bytes.fromhex(row[1])
            if identity != expected_identity:
                raise SourceUnavailable()
            del identity,expected_identity
            _private(32768+5*p+evidence.row_phase_bytes(_record_bytes(parsed))+held+review_hold)
            fields=evidence.fields_from_row(parsed,upload_sha256=header[8])
            n=evidence.evidence_size(fields)
            if n != len(row[6])//2:
                raise SourceUnavailable()
            _private(32768+5*p+5*n+evidence.CLASSIFIER_WORK_BYTES+held+review_hold)
            incoming=evidence.encode_evidence(fields)
            del fields
            expected_incoming=bytes.fromhex(row[6])
            if incoming != expected_incoming:
                raise SourceUnavailable()
            del incoming,expected_incoming
            target,allow=_resolve_import_target(parsed,seal,proof=proof,projections=projections,
                target_counts=target_counts,by_ref=by_ref,by_id=by_id,identity_conflict=conflict)
            association_conflict=False
            if target is not None and any(other_row[2]!=row[2]
                    and other_seal[8]=='saved' and other_seal[3]==target.track_id
                    for other_row,other_seal in zip(original_value[2],original_value[4])):
                association_conflict=True
                target,allow=None,False
            # Suppression is durable and conservative: a retained prefix may
            # have excluded a conflicting candidate from the full window. It
            # must never promote an authenticated plannedNone during replay.
            if seal[9] is None:
                association_conflict=association_conflict or target is not None
                target,allow=None,False
            elif target is None or target.track_id!=seal[9]:
                raise SourceStale() if replaying else SourceUnavailable()
            if target is None:
                if row[9] is not None:
                    raise SourceStale() if replaying else SourceUnavailable()
                eligible=False
            else:
                if row[9] is None or original_value[3][row[9]][0] != target.track_id:
                    raise SourceStale() if replaying else SourceUnavailable()
                state=original_value[3][row[9]]
                eligible=(allow and state[1]=='ok' and state[11] and state[12])
            raw_rating=parsed.fields[parser.FIELD_NAMES.index('rating')]
            raw_favorite=parsed.fields[parser.FIELD_NAMES.index('favorite')]
            rating=raw_rating.value if eligible and raw_rating.state=='valid' else None
            favorite=bool(eligible and raw_favorite.state=='valid' and raw_favorite.value is True)
            if row[10] != rating or row[11] is not favorite:
                raise SourceUnavailable()
            if review:
                review_truncated = _review_parsed_row(parsed, row, seal,
                    matching_library_id=header[1], proof=proof,
                    projections=projections, target_counts=target_counts,
                    by_id=by_id, by_ref=by_ref, review_counts=review_counts,
                    review_problems=review_problems,
                    association_conflict=association_conflict) or review_truncated
                if problem_after is not None:
                    # Presentation has separate counters and scratch. The old
                    # first32 diagnostic append order above is untouched.
                    row_problems=_diagnostic_row_problems(parsed,row,seal,
                        native_values=None if row[9] is None else original_value[3][row[9]],
                        matching_library_id=header[1],proof=proof,projections=projections,
                        target_counts=target_counts,by_id=by_id,by_ref=by_ref,
                        association_conflict=association_conflict)
                    problem_count+=len(row_problems)
                    labels=None
                    for index,(ordinal,code,field) in enumerate(row_problems):
                        cursor=ordinal*PROBLEM_CURSOR_STRIDE+index
                        if cursor<=problem_after:
                            continue
                        if len(problem_items)==problem_limit:
                            problem_remaining+=1
                            continue
                        if labels is None:
                            labels=tuple(_bounded_personal_label(
                                parsed.fields[parser.FIELD_NAMES.index(name)].value,limit)
                                if parsed.fields[parser.FIELD_NAMES.index(name)].state=='valid' else ''
                                for name,limit in _CONFLICT_LABEL_LIMITS)
                        problem_items.append(FoobarDiagnosticProblem(cursor,ordinal,code,field,*labels))
                    del row_problems,labels
            seen+=1
        if seen != len(original_value[2]):
            raise SourceUnavailable()
        if review:
            if problem_after is not None:
                return (tuple(review_counts),tuple(review_problems),review_truncated,
                        tuple(problem_items),problem_count,problem_remaining)
            return tuple(review_counts),tuple(review_problems),review_truncated
    finally:
        stream.close()


def _check_complete_inventory_policy(live, targets, *, constraints):
    """Compare every genuine retained policy component; never re-project paths.

    Caller already admits all three extra target tuple views. The genuine bridge
    constructs complete unique targets and binds them to its complete files and
    framed digest. This helper is not a new client snapshot authentication seam.
    """
    _account_context(live)
    if type(targets) is not tuple or len(targets) > 100000:
        raise SourceUnavailable()
    if live.library_id is None and targets:
        raise SourceUnavailable()
    for target in targets:
        if type(target) is not FoobarInventoryTarget:
            raise SourceUnavailable()
        policy = evaluate_foobar_track_policy(live,track_id=target.track_id,constraints=constraints)
        if (policy.browse_allowed,policy.taste_allowed) != (target.browse_allowed,target.taste_allowed):
            raise SourceStale()
    require_account_foobar(live, constraints)


def _current_checks(connection, live, *, command, original_value, inventory_files,
                    inventory_targets, constraints):
    p=evidence._json_size(original_value)
    count=len(original_value[2])
    from .foobar_account_import_apply import _association_hold_bytes
    held=_association_hold_bytes(count,p)
    _private(32768+5*p+held+taste._foobar_taste_phase_bytes(len(original_value[3])))
    associations.check_foobar_association_seals_on_connection(connection,live,
        source_ref=command.source_ref,matching_library_id=command.matching_library_id,
        rows=original_value[2],seals=original_value[4],constraints=constraints)
    ids=tuple(row[0] for row in original_value[3])
    if command.matching_library_id is None or command.mapping_name==gate.ENHANCED_MAPPING:
        if ids or original_value[3]:
            raise SourceUnavailable()
        current=()
    else:
        current=taste.read_foobar_taste_on_connection(connection,live,source_ref=command.source_ref,
                                                    track_ids=ids,constraints=constraints)
    if len(current) != len(original_value[3]):
        raise SourceUnavailable()
    for state,original_state in zip(current,original_value[3]):
        if _state_values(state) != original_state:
            raise SourceStale()
    del current
    _private(32768+5*p+held+authority.authority_snapshot_phase_bytes(live,track_ids=ids))
    digest,policies=authority.authority_snapshot_on_connection(connection,live,track_ids=ids,constraints=constraints)
    if digest != original_value[1][15] or any((row[11],row[12])!=(policy[1],policy[2])
            for row,policy in zip(original_value[3],policies)):
        raise SourceStale()
    del policies,digest
    _current_source_check(connection,live,command,original_value)
    current_files=(_account_inventory(live, command, constraints).files if command.matching_library_id is None
        else read_foobar_inventory_scalars_on_connection(connection,live,constraints=constraints))
    if current_files != inventory_files:
        raise SourceStale()
    del current_files
    _check_complete_inventory_policy(live,inventory_targets,constraints=constraints)
    _private(32768+5*p+held+gate.PREPARE_GATE_BYTES)
    fresh=gate.begin_foobar_prepare_on_connection(connection,live,command=command,constraints=constraints)
    _clock_fence(connection,live,command=command,earlier=fresh.observed_at,prepared_bytes=p,
                 expires_at=fresh.expires_at,association_hold=held)
    return fresh


_CAPACITY_SQL = """
with f as materialized (select convert_from(%b::bytea,'UTF8')::jsonb j)
select s.observation_count,s.revision_count,s.source_bytes
from integration.foobar_import_streams_v2 s cross join f
where (s.account_id,s.source_ref,s.revision)=
 ((j->>0)::bigint,(j->>2)::uuid,(j->>3)::bigint)
"""


def _source_capacity_check(connection, live, *, command, original_value, source_changes):
    # A hard existing persistent quota is never silently enlarged or converted
    # into partial success. Earlier ordinary private-size prefix stops differ.
    p=evidence._json_size(original_value)
    from .foobar_account_import_apply import _association_hold_bytes
    _private(32768+5*p+8*1024+4+2*1024+_association_hold_bytes(len(original_value[2]),p))
    frame=json.dumps((live.actor.account_id,live.library_id,command.source_ref,command.expected_revision),
                     ensure_ascii=True,separators=(',',':')).encode('ascii')
    rows=source._query(connection,_CAPACITY_SQL,frame,maximum=1)
    if len(rows)!=1:
        raise SourceStale()
    row=rows[0]
    names=('observation_count','revision_count','source_bytes')
    limits=(100000,1000000,268435456)
    if (type(row) is not dict or set(row)!=set(names)
            or any(type(row[name]) is not int or not 0<=row[name]<=limit for name,limit in zip(names,limits))):
        raise SourceUnavailable()
    if (type(source_changes) is not tuple or len(source_changes)!=len(original_value[2])
            or any(type(changed) is not bool for changed in source_changes)):
        raise SourceUnavailable()
    # Same actual-size source owner as the genuine prefix planner. This phase
    # keeps the original but reconstructs only one effective/display pair.
    maximum_evidence=max(len(value[7])//2 for value in original_value[2])
    maximum_display=max(len(value[8])//2 for value in original_value[2])
    if command.mapping_name==gate.ENHANCED_MAPPING:
        if any(source_changes) and command.expected_revision==gate._MAX:
            raise SourceStale()
        projection_delta=projection_peak=0
        retained=32768+5*p+_association_hold_bytes(len(original_value[2]),p)
        for value,changed in zip(original_value[2],source_changes):
            if not changed:
                continue
            effective_length,display_length=len(value[7])//2,len(value[8])//2
            held=retained+2*(effective_length+display_length)
            _private(source.enhanced_history.projection_write_phase_bytes(retained_bytes=held,
                effective_length=effective_length,display_length=display_length))
            effective_bytes,display_bytes=bytes.fromhex(value[7]),bytes.fromhex(value[8])
            quota=source.enhanced_history.enhanced_projection_quota_on_connection(connection,
                account_id=live.actor.account_id,source_ref=command.source_ref,
                observation_ref=value[2],source_revision=command.expected_revision+1,
                previous_revision=value[3],effective_bytes=effective_bytes,
                display_bytes=display_bytes,retained_bytes=held)
            projection_peak=max(projection_peak,projection_delta+quota.peak_delta)
            projection_delta+=quota.final_delta
            del effective_bytes,display_bytes,quota
    else:
        _private(32768+5*p+_association_hold_bytes(len(original_value[2]),p)
            +source.history.history_capacity_phase_bytes(maximum_evidence,maximum_display))
        projection_delta,projection_peak=source.history.projection_quota_delta_on_connection(connection,
            account_id=live.actor.account_id,source_ref=command.source_ref,
            expected_revision=command.expected_revision,original_rows=original_value[2],
            source_changes=source_changes)
    observations=revisions=added_bytes=0
    taste_changed=False
    for value,changed in zip(original_value[2],source_changes):
        if value[3] is None:
            if not changed:
                raise SourceUnavailable()
            observations+=1
            added_bytes+=len(value[1])//2
        if changed:
            revisions+=1
            added_bytes+=(len(value[6])+len(value[7])+len(value[8]))//2
        if value[9] is not None:
            state=taste.FoobarTasteState(*original_value[3][value[9]])
            rating,favorite=taste._foobar_taste_mutation_flags(state,rating=value[10],favorite=value[11])
            taste_changed=taste_changed or rating or favorite
            del state
    association_changed=any(s[8]=='never_decided' and s[9] is not None for s in original_value[4])
    _revision_after(command.expected_revision,bool(revisions),taste_changed,
                    association_changed=association_changed,trusted=True)
    # The real writer inserts all raw revisions first, then replaces compact
    # projections in original order. Admit the intermediate peak as well as the
    # exact signed final delta. Net-fit changes can conservatively be rejected.
    source_bytes_peak_addition=added_bytes+projection_peak
    added_bytes+=projection_delta
    if (any(not 0<=row[name]+addition<=limit for name,addition,limit in zip(names,
            (observations,revisions,added_bytes),limits))
            or row['source_bytes']+source_bytes_peak_addition>limits[2]):
        raise source.FoobarSourceCapacityExceeded()
    return (tuple(row[name] for name in names),(observations,revisions,added_bytes),source_bytes_peak_addition)


def _prepare_candidate(connection, live, *, payload, command, proof, ticket, inventory_files,
                 targets, projections, first, target_counts, constraints,
                 problem_after=None, problem_limit=MAX_REVIEW_PROBLEMS):
    # Personal identity never changes because another library has conflicts.
    # Source/upload duplicate-path ambiguity remains in the genuine proof.
    native_conflicts=tuple(False for path in proof.paths)
    lookup_result=lookup.lookup_foobar_source_scalars_on_connection(connection,live,command=command,
        ticket=ticket,proof=proof,native_conflicts=native_conflicts,constraints=constraints)
    del native_conflicts
    if not lookup_result.prior:
        raise SourceUnavailable()
    plans=_plans_from_upload(connection,live,payload,command=command,constraints=constraints,
                            proof=proof,first=first,projections=projections,
                            target_counts=target_counts,targets=targets,lookup_result=lookup_result)
    ids=tuple(sorted({plan.track_id for plan in plans if plan.track_id is not None}))
    # Native read's complete fixed phase plus retained lookup/plan/scalar controls.
    _private(taste._foobar_taste_phase_bytes(len(ids))+sizing._base(len(lookup_result.identities))
             +32768+5*(1024+345*len(plans))+4*(1024+640*len(lookup_result.identities)))
    if command.matching_library_id is None:
        if ids or targets or projections or target_counts:
            raise SourceUnavailable()
        states=()
    else:
        states=taste.read_foobar_taste_on_connection(connection,live,source_ref=command.source_ref,
                                                   track_ids=ids,constraints=constraints)
    del ids
    receipt_ref=str(uuid4())
    sources,sizes=_collect_sources(connection,live,payload=payload,proof=proof,first=first,
        command=command,ticket=ticket,lookup_result=lookup_result,plans=plans,states=states,
        receipt_ref=receipt_ref,constraints=constraints)
    if not sources:
        raise SourceUnavailable()
    selected=_selected_states(states,plans,len(sources))
    ids=tuple(state.track_id for state in selected)
    controls=_caller_controls(plans,states,len(lookup_result.identities))
    _private(controls+prior_merge._retained_bytes(sources)
             +authority.authority_snapshot_phase_bytes(live,track_ids=ids))
    authority_sha256,policies=authority.authority_snapshot_on_connection(connection,live,
                                                                       track_ids=ids,constraints=constraints)
    if len(policies)!=len(selected) or any((state.track_id,state.browse_allowed,state.taste_allowed)!=policy
                                         for state,policy in zip(selected,policies)):
        raise SourceStale()
    del policies,selected,ids
    original,body,prepared_sha256,decision_sha256=_build_original(live,command=command,proof=proof,
        plans=plans,states=states,lookup_result=lookup_result,sizes=sizes,sources=sources,
        receipt_ref=receipt_ref,authority_sha256=authority_sha256,created_at=ticket.observed_at)
    # These complete arrays were created in THIS frame, not in an outer caller.
    # The original owns independent hexadecimal values; no inline-argument
    # lifetime or callee-del assumption is used for caller-held predecessor data.
    del sources,sizes,states,plans,lookup_result,controls
    if problem_after is None:
        review = _verify_upload(original,payload=payload,proof=proof,first=first,projections=projections,
                       target_counts=target_counts,targets=targets,replaying=False,review=True)
    else:
        review = _verify_upload(original,payload=payload,proof=proof,first=first,projections=projections,
                       target_counts=target_counts,targets=targets,replaying=False,review=True,
                       problem_after=problem_after,problem_limit=problem_limit)
    _original_source_admission(connection,live,original)
    source_changes=original_sources.validate_prepared_sources_on_connection(connection,live,original_value=original,
        original_command=command,expected_header=original[1],constraints=constraints)
    quota = _source_capacity_check(connection,live,command=command,original_value=original,source_changes=source_changes)
    proposed = _proposed_window(original,source_changes,quota,review=review)
    if problem_after is not None:
        proposed=replace(proposed,problem_items=review[3],problem_count=review[4],
            problem_after=problem_after,problem_remaining=review[5])
    del source_changes,review
    fresh=_current_checks(connection,live,command=command,original_value=original,
                          inventory_files=inventory_files,inventory_targets=targets,constraints=constraints)
    if fresh.disposition!='new':
        raise SourceStale()
    return original,body,prepared_sha256,decision_sha256,fresh,proposed


def _new_receipt(connection, live, *, payload, command, proof, ticket, inventory_files,
                 targets, projections, first, target_counts, constraints,enhanced_matching_cache=None):
    if command.mapping_name==gate.ENHANCED_MAPPING:
        from . import foobar_account_enhanced_prepare as enhanced_prepare
        if projections or target_counts or proof is not None or first is not None:
            raise SourceUnavailable()
        original,body,prepared_sha256,decision_sha256,fresh,proposed=enhanced_prepare.candidate_on_connection(
            connection,live,upload=payload,command=command,ticket=ticket,constraints=constraints,
            matching_cache=enhanced_matching_cache)
    else:
        original,body,prepared_sha256,decision_sha256,fresh,proposed = _prepare_candidate(
            connection,live,payload=payload,command=command,proof=proof,ticket=ticket,
            inventory_files=inventory_files,targets=targets,projections=projections,
            first=first,target_counts=target_counts,constraints=constraints)
    proposal_sha256 = proposed.proposal_sha256
    del proposed
    receipt_ref = original[1][6]
    authority_sha256 = original[1][15]
    _insert_ready_on_connection(connection,live,original_value=original,payload=body,
        prepared_sha256=prepared_sha256,decision_sha256=decision_sha256,command=command,
        expected_header=original[1],ticket=fresh,constraints=constraints)
    final=_current_checks(connection,live,command=command,original_value=original,
                          inventory_files=inventory_files,inventory_targets=targets,constraints=constraints)
    if (final.disposition!='ready_replay' or final.receipt_ref!=receipt_ref
            or final.prepared_sha256!=prepared_sha256 or final.decision_sha256!=decision_sha256
            or final.prepared_bytes_size!=len(body) or final.authority_sha256!=authority_sha256):
        raise SourceUnavailable()
    return (command.source_ref,command.generation,receipt_ref,prepared_sha256,decision_sha256,
            original[1][12],original[1][13],original[1][11],final.expires_at,None,
            _association_review(original),proposal_sha256)


_RECEIPT_SCALAR_SQL = """
with f as materialized (select convert_from(%b::bytea,'UTF8')::jsonb j)
select r.original_session_id,
 case when r.parser_version in ('foobar_text_tools_snapshot_v1','foobar_enhanced_sqlite_record_v1') then r.parser_version else null end parser_version,
 case when r.mapping_name in ('foobar_text_tools_snapshot_v1','foobar_enhanced_playcount_store_v1') then r.mapping_name else null end mapping_name,
 r.total_rows,r.window_start,r.window_end,r.created_at,r.ready_until,
 r.apply_key::text apply_key,r.committed_revision,r.committed_at,r.expires_at,r.state,r.expected_revision,
 encode(r.upload_sha256,'hex') upload_sha256,encode(r.inventory_sha256,'hex') inventory_sha256,
 encode(r.authority_sha256,'hex') authority_sha256,encode(r.decision_sha256,'hex') decision_sha256,
 encode(r.prepared_sha256,'hex') prepared_sha256,
 coalesce(octet_length(r.prepared_bytes),0)::bigint prepared_size,
 coalesce(octet_length(r.terminal_bytes),0)::bigint terminal_size,
 encode(r.terminal_sha256,'hex') terminal_sha256,r.prepare_key::text prepare_key,
 clock_timestamp() observed_at
from integration.foobar_import_receipts_v2 r cross join f
where (r.account_id,r.source_ref,r.generation,r.receipt_ref)=
 ((j->>0)::bigint,(j->>2)::uuid,(j->>3)::bigint,(j->>4)::uuid)
"""

_RECEIPT_KEYS=('original_session_id','parser_version','mapping_name','total_rows','window_start',
 'window_end','created_at','ready_until','apply_key','committed_revision','committed_at','expires_at',
 'state','expected_revision','upload_sha256','inventory_sha256','authority_sha256','decision_sha256',
 'prepared_sha256','prepared_size','terminal_size','terminal_sha256','prepare_key','observed_at')


def _receipt_scalar(connection, live, *, command, ticket):
    _private(32768+6*1024+4+2*8192)
    frame_value=(live.actor.account_id,live.library_id,command.source_ref,command.generation,ticket.receipt_ref)
    frame=json.dumps(frame_value,ensure_ascii=True,separators=(',',':')).encode('ascii')
    result=source._query(connection,_RECEIPT_SCALAR_SQL,frame,maximum=1)
    if len(result)!=1:
        raise SourceStale()
    row=result[0]
    if type(row) is not dict or tuple(row)!=_RECEIPT_KEYS:
        raise SourceUnavailable()
    header=(live.actor.account_id,command.matching_library_id,row['original_session_id'],command.source_ref,
            command.generation,row['prepare_key'],ticket.receipt_ref,row['expected_revision'],row['upload_sha256'],
            row['parser_version'],row['mapping_name'],row['total_rows'],row['window_start'],row['window_end'],
            row['inventory_sha256'],row['authority_sha256'],_utc(row['created_at']))
    envelope._header(header,command)
    if (header[2]!=live.actor.session_id
            or row['prepared_sha256']!=ticket.prepared_sha256 or row['decision_sha256']!=ticket.decision_sha256
            or row['authority_sha256']!=ticket.authority_sha256 or row['inventory_sha256']!=ticket.inventory_sha256
            or type(row['prepared_size']) is not int or row['prepared_size']!=ticket.prepared_bytes_size
            or type(row['terminal_size']) is not int or row['terminal_size']!=ticket.terminal_bytes_size
            or any(type(row[key]) is not datetime or row[key].utcoffset()!=timedelta(0)
                   for key in ('ready_until','expires_at','observed_at'))
            or row['ready_until']!=row['created_at']+timedelta(hours=1)
            or row['expires_at']!=ticket.expires_at or row['observed_at']<ticket.observed_at):
        raise SourceUnavailable()
    if row['observed_at']>=row['expires_at']:
        raise SourceStale()
    ready=ticket.disposition=='ready_replay'
    if ready:
        if (row['state']!='ready' or row['apply_key'] is not None or row['committed_revision'] is not None
                or row['committed_at'] is not None or row['terminal_sha256'] is not None
                or row['expires_at']!=row['ready_until']):
            raise SourceUnavailable()
    else:
        if (ticket.disposition!='committed_replay' or row['state']!='committed'
                or not gate._uuid(row['apply_key']) or not gate._hex(row['terminal_sha256'])
                or not gate._integer(row['committed_revision'],command.expected_revision,gate._MAX)
                or row['committed_revision']-command.expected_revision not in (0,1)
                or type(row['committed_at']) is not datetime or row['committed_at'].utcoffset()!=timedelta(0)
                or not row['created_at']<=row['committed_at']<row['ready_until']
                or row['expires_at']!=row['committed_at']+timedelta(hours=168)):
            raise SourceUnavailable()
    return header,row


def _receipt_payload_sql(terminal):
    # Only this closed internal bool selects an identifier, never request text.
    if type(terminal) is not bool:
        raise SourceUnavailable()
    column='terminal_bytes' if terminal else 'prepared_bytes'
    digest='terminal_sha256' if terminal else 'prepared_sha256'
    state='committed' if terminal else 'ready'
    return f"""with f as materialized (select convert_from(%b::bytea,'UTF8')::jsonb j),
    sampled as materialized (select clock_timestamp() observed_at)
    select r.{column} payload,sampled.observed_at
    from integration.foobar_import_receipts_v2 r cross join f cross join sampled
    where (r.account_id,r.source_ref,r.generation,r.receipt_ref)=
     ((j->>0)::bigint,(j->>2)::uuid,(j->>3)::bigint,(j->>4)::uuid)
      and r.state='{state}' and r.{digest}=decode(j->>5,'hex')
      and octet_length(r.{column})=(j->>6)::bigint
      and r.expires_at= (j->>7)::timestamptz and r.expires_at>sampled.observed_at
    """


def _receipt_payload(connection, live, *, command, ticket, scalar, terminal):
    size=scalar['terminal_size'] if terminal else scalar['prepared_size']
    digest=scalar['terminal_sha256'] if terminal else scalar['prepared_sha256']
    if type(size) is not int or not 1<=size<=(terminal_codec.MAX_WIRE_BYTES if terminal else envelope.MAX_BYTES):
        raise SourceUnavailable()
    # Both native result bytes and Python bytes survive until cursor close;
    # returned dict/tuple and outer receiver are distinct named logical views.
    _private(32768+4*size+8*1024+4+2*1024)
    if not terminal:
        _private(32768+envelope.prepared_envelope_phase_bytes(size,decode=True))
    values=(live.actor.account_id,live.library_id,command.source_ref,command.generation,
            ticket.receipt_ref,digest,size,_utc(scalar['expires_at']))
    frame=json.dumps(values,ensure_ascii=True,separators=(',',':')).encode('ascii')
    result=source._query(connection,_receipt_payload_sql(terminal),frame,maximum=1)
    if len(result)!=1:
        raise SourceStale()
    row=result[0]
    if (type(row) is not dict or tuple(row)!=('payload','observed_at')
            or type(row['payload']) is not bytes or len(row['payload'])!=size
            or type(row['observed_at']) is not datetime or row['observed_at'].utcoffset()!=timedelta(0)
            or row['observed_at']<scalar['observed_at']):
        raise SourceUnavailable()
    if row['observed_at']>=scalar['expires_at']:
        raise SourceStale()
    return row['payload'],row['observed_at']


def _replay_receipt(connection, live, *, payload, command, proof, ticket, constraints, capacity):
    header,scalar=_receipt_scalar(connection,live,command=command,ticket=ticket)
    total_rows=payload.records if command.mapping_name==gate.ENHANCED_MAPPING else proof.total_rows
    if header[11]!=total_rows:
        raise SourceUnavailable()
    terminal=ticket.disposition=='committed_replay'
    body,observed=_receipt_payload(connection,live,command=command,ticket=ticket,scalar=scalar,terminal=terminal)
    if terminal:
        _private(32768+4*len(body)+terminal_codec.DECODE_CONTRIBUTION)
        if hashlib.sha256(body).hexdigest()!=scalar['terminal_sha256']:
            raise SourceUnavailable()
        expected=(terminal_codec.VERSION,terminal_codec.terminal_scope_sha256(
            live.actor.account_id,command.source_ref,command.generation),
            command.source_ref,ticket.receipt_ref,command.request_key,scalar['apply_key'],
            ticket.prepared_sha256,ticket.decision_sha256,command.upload_sha256,
            ticket.inventory_sha256,ticket.authority_sha256,command.expected_revision,
            scalar['committed_revision'],header[11],header[12],header[13],command.generation)
        record=terminal_codec.decode_foobar_terminal(body,expected_header=expected)
        if command.matching_library_id is None and any(record[k] for k in (18,19,20,21,22)):
            raise SourceUnavailable()
        del record
        source._authority(live,constraints)
        final=gate.begin_foobar_prepare_on_connection(connection,live,command=command,constraints=constraints)
        if (final.disposition!='committed_replay' or final.receipt_ref!=ticket.receipt_ref
                or final.prepared_sha256!=ticket.prepared_sha256 or final.decision_sha256!=ticket.decision_sha256
                or final.terminal_bytes_size!=len(body) or final.expires_at!=ticket.expires_at
                or final.observed_at<observed):
            raise SourceUnavailable()
        _clock_fence(connection,live,command=command,earlier=final.observed_at,prepared_bytes=0,expires_at=final.expires_at)
        return (command.source_ref,command.generation,ticket.receipt_ref,ticket.prepared_sha256,
                ticket.decision_sha256,header[12],header[13],header[11],final.expires_at,body,None)
    original=envelope.decode_prepared_envelope(body,original_command=command,expected_header=header,
        prepared_sha256=ticket.prepared_sha256,decision_sha256=ticket.decision_sha256)
    # Strict embedded immutable evidence precedes classification of changed
    # current matching. The bounded bool result remains a fixed control owner.
    _original_source_admission(connection,live,original)
    source_changes=original_sources.validate_prepared_sources_on_connection(connection,live,original_value=original,
        original_command=command,expected_header=header,constraints=constraints)
    if command.mapping_name==gate.ENHANCED_MAPPING:
        from . import foobar_account_enhanced_prepare as enhanced_prepare
        matching_cache=None
        if command.matching_library_id is None:
            inventory=_account_inventory(live,command,constraints)
        else:
            from . import foobar_account_enhanced_matching as enhanced_matching
            matching_cache=enhanced_matching.matching_cache_on_connection(connection,live,
                upload=payload,command=command,capacity=capacity,constraints=constraints)
            inventory=matching_cache.inventory
        enhanced_prepare.verify_enhanced_upload(original,upload=payload,command=command)
        enhanced_prepare.verify_matching_on_connection(connection,live,original=original,
            upload=payload,command=command,matching_cache=matching_cache,constraints=constraints)
    else:
        inventory,projections,first,target_counts=_read_inventory(connection,live,payload=payload,proof=proof,
            command=command,constraints=constraints,capacity=capacity)
        _verify_upload(original,payload=payload,proof=proof,first=first,projections=projections,
                       target_counts=target_counts,targets=inventory.targets,replaying=True)
    _source_capacity_check(connection,live,command=command,original_value=original,source_changes=source_changes)
    proposal_sha256=_semantic_window_digest(original,source_changes)
    del source_changes
    final=_current_checks(connection,live,command=command,original_value=original,
                          inventory_files=inventory.files,inventory_targets=inventory.targets,constraints=constraints)
    if (final.disposition!='ready_replay' or final.receipt_ref!=ticket.receipt_ref
            or final.prepared_sha256!=ticket.prepared_sha256 or final.decision_sha256!=ticket.decision_sha256
            or final.prepared_bytes_size!=len(body) or final.observed_at<observed):
        raise SourceUnavailable()
    return (command.source_ref,command.generation,ticket.receipt_ref,ticket.prepared_sha256,
            ticket.decision_sha256,header[12],header[13],header[11],final.expires_at,None,
            _association_review(original),proposal_sha256)


def _revision_after(expected_revision, source_changed, taste_changed, *, association_changed=False,trusted=False):
    if (not gate._integer(expected_revision,0,gate._MAX) or type(source_changed) is not bool
            or type(taste_changed) is not bool or type(association_changed) is not bool
            or type(trusted) is not bool):
        raise SourceUnavailable()
    changed=source_changed or taste_changed or association_changed
    if expected_revision==gate._MAX and changed:
        raise SourceUnavailable() if trusted else SourceStale()
    return expected_revision+int(changed)


from contextlib import contextmanager
import time


class _Deadline:
    """Observed10-second budget, NOT an interruptible physical deadline."""
    def __init__(self):
        self.end=time.monotonic()+10.0

    def check(self):
        remaining=self.end-time.monotonic()
        if remaining<=0:
            raise SourceUnavailable()
        return remaining

    def arm(self, raw):
        milliseconds=min(1000,max(1,int(self.check()*1000)))
        cursor=raw.execute("select set_config('statement_timeout',%s,true)",
                           (str(milliseconds)+'ms',),binary=True)
        try:
            self.check()
        finally:
            cursor.close()
        # Arming itself can consume time; the timeout is sampled, not an outer
        # socket/provider cancellation guarantee. Never start after observed expiry.
        self.check()


class _Cursor:
    def __init__(self, raw, deadline):
        self.raw,self.deadline=raw,deadline

    def _fetch(self, name, *args):
        self.deadline.check()
        method=getattr(self.raw,name)
        self.deadline.check()
        result=method(*args)
        try:
            self.deadline.check()
        except BaseException:
            self.raw.close()
            raise
        return result

    def fetchmany(self, size):
        return self._fetch('fetchmany',size)

    def fetchone(self):
        return self._fetch('fetchone')

    def fetchall(self):
        return self._fetch('fetchall')

    def close(self):
        # Cleanup remains allowed after expiry.
        return self.raw.close()


class _Connection:
    def __init__(self, raw, deadline):
        self.raw,self.deadline=raw,deadline

    @property
    def autocommit(self):
        return self.raw.autocommit

    @property
    def info(self):
        return self.raw.info

    def execute(self, query, params=None, **kwargs):
        self.deadline.arm(self.raw)
        cursor=self.raw.execute(query,params,**kwargs)
        try:
            self.deadline.check()
        except BaseException:
            cursor.close()
            raise
        return _Cursor(cursor,self.deadline)

    @contextmanager
    def transaction(self, *args, **kwargs):
        self.deadline.check()
        with self.raw.transaction(*args,**kwargs):
            self.deadline.check()
            yield
            self.deadline.check()


def _checked_constraints(constraints):
    def checked(target):
        try:
            result=constraints(target) if callable(constraints) else constraints
            if result is not None and not isinstance(result,PolicyEvaluationConstraints):
                raise SourceUnavailable()
            return result
        except Exception:
            # A callback throwing an authority-denial-shaped exception is an
            # operational failure, not the evaluator's ordinary explicit denial.
            raise SourceUnavailable() from None
    return checked


def _prepare_foobar_import(database_url, context, *, payload, command, intake_capacity, constraints=None):
    """Genuine receipt-backed private Prepare, requiring the actual server factory.

    No raw file is persisted. This is not a route, CSRF owner, upload-capability
    grant, request-controlled capacity, complete Apply implementation or promise
    of scalable transport. Existing native transaction authority is mandatory.
    """
    gate.validate_prepare_command(command)
    if type(payload) not in (bytes,indexed._AccountIndexedUpload) or not 1<=len(payload)<=parser.MAX_INPUT_BYTES:
        raise gate.PrepareInvalid()
    if type(payload) is indexed._AccountIndexedUpload:
        payload.validate(context,command)
    try:
        _account_context(context)
        # At most one outer immutable-upload owner is included in this bound.
        # A future route must admit/release its own body/chunk owners before entry.
        intake._admit(intake_capacity,indexed.retained_bytes(payload)+7*len(payload)+window.PARSER_WORK_BYTES+window.WINDOW_WORK_BYTES)
        checked=_checked_constraints(constraints)
        deadline=_Deadline()
        with current_foobar_import_transaction(database_url,context,matching_library_id=command.matching_library_id,constraints=checked) as (raw,live,sampled_now):
            connection=_Connection(raw,deadline)
            deadline.check()
            source._authority(live,checked)
            if type(payload) is indexed._AccountIndexedUpload:
                proof=payload.proof(command.offset,intake_capacity)
            else:
                proof=window.prove_foobar_source_window(payload,offset=command.offset,
                    mapping_name=command.mapping_name,intake_capacity=intake_capacity)
            deadline.check()
            if proof.source_sha256!=command.upload_sha256:
                raise gate.PrepareInvalid()
            _private(32768+gate.PREPARE_GATE_BYTES)
            ticket=gate.begin_foobar_prepare_on_connection(connection,live,command=command,constraints=checked)
            # Only the real Prepare path discovers durable job ownership.
            # The rollback-only dry-run candidate never invokes these hooks.
            _private(32768+gate.PREPARE_GATE_BYTES+jobs.JOB_PHASE_BYTES)
            jobs.guard_foobar_job_protocol_on_connection(connection,live,
                command=command,operation='prepare',constraints=checked)
            # Committed account/session replay never touches a deleted library.
            # New/READY work separately rebuilds native membership and grants.
            if ticket.disposition != 'committed_replay':
                if command.matching_library_id is not None:
                    from .foobar_account_match_readiness import require_foobar_match_schema_on_connection
                    require_foobar_match_schema_on_connection(connection)
                live=_matching_context(connection,live,context,command.matching_library_id,constraints=checked)
            if ticket.disposition=='new':
                inventory,projections,first,target_counts=_read_inventory(connection,live,payload=payload,
                    proof=proof,command=command,constraints=checked,capacity=intake_capacity)
                deadline.check()
                values=_new_receipt(connection,live,payload=payload,command=command,proof=proof,ticket=ticket,
                    inventory_files=inventory.files,targets=inventory.targets,projections=projections,
                    first=first,target_counts=target_counts,constraints=checked)
            elif ticket.disposition in ('ready_replay','committed_replay'):
                values=_replay_receipt(connection,live,payload=payload,command=command,proof=proof,
                    ticket=ticket,constraints=checked,capacity=intake_capacity)
            else:
                raise SourceUnavailable()
            _private(32768+jobs.JOB_PHASE_BYTES+8*terminal_codec.MAX_WIRE_BYTES)
            jobs.record_foobar_job_protocol_on_connection(connection,live,
                command=command,operation='prepare',constraints=checked)
            deadline.check()
            source._authority(live,checked)
            deadline.check()
        # Only a successfully exited genuine outer transaction can yield ready
        # or immutable terminal replay. A late/uncertain commit is never called
        # rollback here; its unchanged request key supports a later real replay.
        deadline.check()
        return FoobarPreparedReceipt(*values)
    except (SourceUnavailable,gate.PrepareInvalid,intake.FoobarPreparationRejected):
        raise
    except taste.FoobarTasteStale:
        raise SourceStale() from None
    except Exception:
        raise SourceUnavailable() from None


_CLOCK_SQL = """
with f as materialized (select convert_from(%b::bytea,'UTF8')::jsonb j)
select s.updated_at,s.clock_high_water,s.current_generation,s.retired_through,clock_timestamp() observed_at
from integration.foobar_import_streams_v2 s cross join f
where (s.account_id,s.source_ref)=((j->>0)::bigint,(j->>2)::uuid)
"""


def _check_sampled_receipt_expiry(observed_at, expires_at):
    if type(observed_at) is not datetime or observed_at.utcoffset() != timedelta(0):
        raise SourceUnavailable()
    if expires_at is None:
        return  # Genuine new-ticket pre-insert fence has no receipt yet.
    if type(expires_at) is not datetime or expires_at.utcoffset() != timedelta(0):
        raise SourceUnavailable()
    if observed_at >= expires_at:
        raise SourceStale()


def _clock_fence(connection, live, *, command, earlier, prepared_bytes, expires_at, association_hold=0):
    from datetime import date
    if type(association_hold) is not int or association_hold<0:
        raise SourceUnavailable()
    _private(32768+5*prepared_bytes+8*1024+4+2*2048+association_hold)
    frame=json.dumps((live.actor.account_id,live.library_id,command.source_ref),
                     ensure_ascii=True,separators=(',',':')).encode('ascii')
    rows=source._query(connection,_CLOCK_SQL,frame,maximum=1)
    if len(rows)!=1:
        raise SourceStale()
    row=rows[0]
    if (type(row) is not dict or set(row)!={'updated_at','clock_high_water','current_generation','retired_through','observed_at'}
            or any(type(row[key]) is not datetime or row[key].utcoffset()!=timedelta(0)
                   for key in ('updated_at','clock_high_water','observed_at'))
            or not row['updated_at']<=row['clock_high_water']<=row['observed_at']
            or row['observed_at']<earlier
            or not gate._integer(row['current_generation'],1,2147483647)
            or not gate._integer(row['retired_through'],0,row['current_generation']-1)
            or row['current_generation']!=(row['observed_at'].date()-date(1970,1,1)).days):
        raise SourceUnavailable()
    if not row['retired_through']<command.generation<=row['current_generation']:
        raise SourceStale()
    _check_sampled_receipt_expiry(row['observed_at'],expires_at)



def prepare_foobar_import(database_url, context, *, payload, command, intake_capacity, constraints=None):
    """Unchanged raw-upload entry; private indexed objects are not request data."""
    if type(payload) is not bytes:
        raise gate.PrepareInvalid()
    return _prepare_foobar_import(database_url,context,payload=payload,command=command,
                                 intake_capacity=intake_capacity,constraints=constraints)


def prepare_indexed_foobar_import(database_url, context, *, upload, command, intake_capacity, constraints=None):
    """Worker-only entry retaining genuine preparation/verification owners."""
    if type(upload) is not indexed._AccountIndexedUpload:
        raise gate.PrepareInvalid()
    return _prepare_foobar_import(database_url,context,payload=upload,command=command,
                                 intake_capacity=intake_capacity,constraints=constraints)


@dataclass(frozen=True, slots=True)
class FoobarPersonalConflict:
    """Internal genuine-review decision; native fields MUST NOT cross the wire."""
    cursor: int
    ordinal: int
    field: str
    existing: int | str | None
    incoming: int | str
    consequence: str
    eligible: bool
    ineligible_reason: str | None
    expected_state: tuple
    fence_sha256: str | None
    association_seal: tuple
    observation_ref: str | None
    source_revision: int | None
    source_identity_sha256: str
    source_artist: str = ''
    source_title: str = ''
    source_album: str = ''


@dataclass(frozen=True, slots=True)
class FoobarDiagnosticProblem:
    """One genuine diagnostic instance, not a track or an override decision."""
    cursor: int
    ordinal: int
    code: str
    field: str | None
    source_artist: str = ''
    source_title: str = ''
    source_album: str = ''


@dataclass(frozen=True, slots=True)
class FoobarProposedWindow:
    """A planning observation, never a receipt or future mutation guarantee."""
    offset: int
    end: int
    total_rows: int
    proposed_counts: tuple
    current_quota: tuple
    quota_additions: tuple
    operational_budget: tuple | None = None
    review_counts: tuple = ()
    review_problems: tuple = ()
    review_truncated: bool = False
    proposal_sha256: str | None = None
    conflicts: tuple = ()
    conflict_count: int = 0
    conflict_after: int | None = None
    conflict_remaining: int = 0
    problem_items: tuple = ()
    problem_count: int = 0
    problem_after: int | None = None
    problem_remaining: int = 0
    # Internal persistent write-sequence bound; not a public import count.
    source_bytes_peak_addition: int = 0
    observation_items: tuple = ()
    observation_remaining: int = 0
    observation_chunk: observation_preview.RawFieldChunk | None = None


def _check_problem_page(problem_after, problem_limit):
    if (problem_after is not None and (type(problem_after) is not int
            or not 0<=problem_after<=PROBLEM_CURSOR_STRIDE*parser.MAX_DATA_ROWS+PROBLEM_CURSOR_STRIDE-1)
            or type(problem_limit) is not int or not 0<=problem_limit<=MAX_REVIEW_PROBLEMS):
        raise gate.PrepareInvalid()
    # A parser contract expansion must explicitly revise cursor slots/bounds,
    # rather than silently allowing one row to overlap the next row's cursor.
    if problem_after is not None and len(parser.FIELD_NAMES)+3>PROBLEM_CURSOR_STRIDE:
        raise SourceUnavailable()


def _check_conflict_page(conflict_after, conflict_limit):
    if (conflict_after is not None and (type(conflict_after) is not int
            or not 0<=conflict_after<=2*parser.MAX_DATA_ROWS+1)
            or type(conflict_limit) is not int
            or not 0<=conflict_limit<=MAX_PERSONAL_CONFLICTS):
        raise gate.PrepareInvalid()


def _bounded_personal_label(value, maximum_bytes):
    """A short source label, not markup, a path or native display metadata."""
    if type(value) is not str:
        return ''
    chars=[]
    used=0
    for char in value:
        # All Unicode C categories are excluded, matching the public decoder;
        # this includes bidi formats, private-use, unassigned and surrogates.
        category=unicodedata.category(char)
        if category.startswith('C') or category in ('Zl','Zp'):
            continue
        codepoint=ord(char)
        size=1 if codepoint<128 else 2 if codepoint<2048 else 3 if codepoint<65536 else 4
        if used+size>maximum_bytes:
            break
        chars.append(char)
        used+=size
    return ''.join(chars).strip()


def _personal_conflict_labels(payload, first, original, selected):
    """Read only genuine current parsed artist/title/album for selected rows.

    One additional bounded indexed-window visitor, not a full-upload rescan or
    display-evidence decode. Each field is sanitized directly from its existing
    parsed string; no complete raw cell is copied. At most32 row label tuples
    retain at most6144 UTF-8 source bytes, even when all fields are nonempty.
    """
    if (type(payload) is not indexed._AccountIndexedUpload
            or type(first) is not parser.FoobarScanResult
            or first.source_sha256!=original[1][8]):
        raise SourceUnavailable()
    p=evidence._json_size(original)
    from .foobar_account_import_apply import _association_hold_bytes
    held=_association_hold_bytes(len(original[2]),p)
    # Reuse the exact-upload verification admission recipe; every yielded row
    # is checked separately below. Labels are in the separate optional hold.
    _private(32768+5*p+16384+held+REVIEW_CONTROL_BYTES)
    labels=[]
    scan=indexed.iter_source_rows(payload,offset=original[1][12]-1)
    try:
        while True:
            try:
                parsed=next(scan)
            except StopIteration as done:
                _terminal_matches(done.value,first)
                break
            # Every yielded row exists alongside the retained original, even
            # if it is unselected or beyond a smaller admitted prefix.
            _private(32768+5*p+evidence.row_phase_bytes(_record_bytes(parsed))+held+REVIEW_CONTROL_BYTES)
            if (not any(item[2][0]==parsed.ordinal for item in selected)
                    or any(item[0]==parsed.ordinal for item in labels)):
                continue
            values=[]
            for name,limit in _CONFLICT_LABEL_LIMITS:
                field=parsed.fields[parser.FIELD_NAMES.index(name)]
                values.append(_bounded_personal_label(field.value,limit) if field.state=='valid' else '')
            labels.append((parsed.ordinal,*values))
        if any(not any(label[0]==item[2][0] for label in labels) for item in selected):
            raise SourceUnavailable()
        return tuple(labels)
    finally:
        scan.close()


def _personal_conflicts_on_connection(connection, live, *, original, source_ref,
                                      conflict_after, conflict_limit, constraints,
                                      payload, first):
    """Count every preserved field delta and retain only the requested page.

    This runs AFTER genuine candidate sizing, upload/source verification and
    current-state checks, while that same transaction is still open. The actual
    authenticated original, never client fields or a fresh path guess, supplies
    proposed values, targets, source and association context. The caller has
    already withheld CONFLICT_REVIEW_BYTES from every ordinary intake phase.
    """
    _check_conflict_page(conflict_after,conflict_limit)
    if conflict_after is None:
        return (),0,0
    selected=[]
    total=after=0
    for row,seal in zip(original[2],original[4]):
        if row[9] is None:
            continue
        values=original[3][row[9]]
        state=taste.FoobarTasteState(*values)
        # Same protected-delta semantics as the existing summary. The extra
        # positive-value guard explicitly excludes zeros, clears and demotions.
        protected_rating=(type(row[10]) is int and 1<=row[10]<=5
            and state.rating!=row[10] and (state.rating_protected
                or state.rating is not None and state.rating_marker is None))
        protected_favorite=(row[11] is True and state.love_tier=='off'
            and state.favorite_protected)
        for field_index,protected in enumerate((protected_rating,protected_favorite)):
            if not protected:
                continue
            cursor=2*row[0]+field_index
            total+=1
            if cursor<=conflict_after:
                continue
            after+=1
            if len(selected)<conflict_limit:
                # At most32 references; no raw-cell/identity copy or all-row
                # conflict list exists, including after the page is full.
                selected.append((cursor,field_index,row,seal,values))
    if not selected:
        return (),total,after
    # Real selected pages cannot silently omit labels because their genuine
    # upload owner is missing. Empty text is only a real parsed/sanitized value.
    labels=_personal_conflict_labels(payload,first,original,selected)
    states=tuple(taste.FoobarTasteState(*item[4]) for index,item in enumerate(selected)
        if not any(previous[4][0]==item[4][0] for previous in selected[:index]))
    phase=taste._foobar_personal_phase_bytes(len(states))
    if (type(phase) is not int or not 0<=phase<=CONFLICT_REVIEW_BYTES-CONFLICT_CONTROL_BYTES):
        raise SourceUnavailable()
    fences=taste.read_foobar_personal_fences_on_connection(connection,live,
        source_ref=source_ref,states=states,constraints=constraints)
    if (type(fences) is not tuple or len(fences)!=len(states)
            or any(type(fence) is not taste.FoobarPersonalFence
                or fence.track_id!=state.track_id or _state_values(fence.state)!=_state_values(state)
                or not gate._hex(fence.fence_sha256)
                or type(fence.eligible_rating) is not bool or type(fence.eligible_favorite) is not bool
                for state,fence in zip(states,fences))):
        raise SourceUnavailable()
    result=[]
    for cursor,field_index,row,seal,values in selected:
        fence=next(fence for fence in fences if fence.track_id==values[0])
        eligible=fence.eligible_rating if field_index==0 else fence.eligible_favorite
        # Standard persisted identity SHA, with at most4096 hex characters and
        # 2048 decoded bytes live per chunk, never the whole decoded identity.
        identity=hashlib.sha256()
        for start in range(0,len(row[1]),4096):
            identity.update(bytes.fromhex(row[1][start:start+4096]))
        label=next(item[1:] for item in labels if item[0]==row[0])
        result.append(FoobarPersonalConflict(cursor,row[0],
            'rating' if field_index==0 else 'favorite',values[4] if field_index==0 else values[5],
            row[10] if field_index==0 else 'loved',
            'replace_personal_rating' if field_index==0 else 'set_personal_favorite',
            eligible,None if eligible else 'provenance_requires_review',values,
            fence.fence_sha256,seal,None if row[3] is None else row[2],row[3],identity.hexdigest(),*label))
    return tuple(result),total,after-len(result)


def _add_review_problem(problems, ordinal, code, field=None):
    """Only parser-owned fields and literal public codes may cross the wire."""
    if (type(ordinal) is not int or not 1<=ordinal<=parser.MAX_DATA_ROWS
            or type(code) is not str or code not in _REVIEW_PROBLEM_CODES
            or field is not None and field not in parser.FIELD_NAMES):
        raise SourceUnavailable()
    if len(problems) == MAX_REVIEW_PROBLEMS:
        return True
    if len(problems) > MAX_REVIEW_PROBLEMS:
        raise SourceUnavailable()
    problems.append((ordinal,code,field))
    return False


def _review_parsed_row(parsed, row, seal, *, matching_library_id, proof,
                       projections, target_counts, by_id, by_ref, review_counts,
                       review_problems, association_conflict):
    """Safe diagnostics from actual verified rows; categories may overlap."""
    truncated = False
    invalid = False
    for name,field in zip(parser.FIELD_NAMES,parsed.fields):
        if field.state in ('invalid','unsupported'):
            invalid = True
            truncated = _add_review_problem(review_problems,row[0],field.code,name) or truncated
    review_counts[3] += int(invalid)
    if row[9] is not None:
        return truncated
    projection = preview._match(parsed,projections)
    suggested = projection[4] if projection is not None and projection[0]=='exact_unique' else None
    target = by_id.get(seal[3]) if seal[8]=='saved' else by_ref.get(suggested)
    ambiguous = False
    if matching_library_id is None:
        code = 'no_matching_library'
    elif seal[8]=='explicit_detach':
        code = 'explicit_detach'
    elif seal[8]=='availability_lost':
        code = 'association_unavailable'
    elif proof.raw_path_row_counts[row[0]-proof.offset-1]!=1:
        code,ambiguous = 'duplicate_source_identity',True
    elif projection is not None and projection[0] in ('ambiguous','identity_conflict'):
        code,ambiguous = 'ambiguous_library_identity',True
    elif (suggested is not None and target_counts.get(suggested,0)>1
            or target is not None and target_counts.get(target.canonical_track_ref,0)
                >(1 if suggested==target.canonical_track_ref else 0)):
        code,ambiguous = 'duplicate_local_target',True
    elif seal[8]=='saved' and target is None:
        code = 'association_unavailable'
    elif (target is not None and (target.selection_status!='ok' or not target.browse_allowed)):
        code = 'target_not_eligible'
    elif association_conflict:
        # The genuine resolver had a current eligible target, but the actual
        # authenticated plan suppressed it for an association reservation.
        code,ambiguous = 'association_conflict',True
    elif suggested is not None or target is not None:
        code = 'target_not_eligible'
    else:
        code = 'no_local_match'
    review_counts[2 if ambiguous else 1] += 1
    return _add_review_problem(review_problems,row[0],code) or truncated


def _diagnostic_row_problems(parsed, row, seal, *, native_values, matching_library_id,
                             proof, projections, target_counts, by_id, by_ref,
                             association_conflict):
    """Exact existing classifier and protection predicates, separate output.

    FIELD_NAMES order, then at most one matching diagnostic, then protected
    rating/favorite. Current27 fields imply at most30 fixed safe-code entries.
    This does not append to or replace the original first32 summary list.
    """
    problems=[]
    counts=[0]*6
    truncated=_review_parsed_row(parsed,row,seal,matching_library_id=matching_library_id,
        proof=proof,projections=projections,target_counts=target_counts,by_id=by_id,by_ref=by_ref,
        review_counts=counts,review_problems=problems,association_conflict=association_conflict)
    if native_values is not None:
        state=taste.FoobarTasteState(*native_values)
        # Keep the actual planner's protected-delta predicates exact. Original
        # upload verification already proved only valid positive proposals.
        protected_rating=(row[10] is not None and state.rating!=row[10]
            and (state.rating_protected or state.rating is not None and state.rating_marker is None))
        protected_favorite=bool(row[11] and state.love_tier=='off' and state.favorite_protected)
        if protected_rating:
            truncated=_add_review_problem(problems,row[0],'protected_rating','rating') or truncated
        if protected_favorite:
            truncated=_add_review_problem(problems,row[0],'protected_favorite','favorite') or truncated
    if truncated or len(problems)>len(parser.FIELD_NAMES)+3:
        raise SourceUnavailable()
    return tuple(problems)


def _semantic_digest_update(digest, value, *, depth=0):
    """Typed length-framed canonical stream, using <=4096-byte ASCII chunks.

    This never dumps a second prepared tree or decodes source hex. The genuine
    envelope owner already checked every included value's type and bounds.
    """
    if depth>8:
        raise SourceUnavailable()
    if value is None:
        digest.update(b'n')
    elif type(value) is bool:
        digest.update(b't' if value else b'f')
    elif type(value) is int:
        if not 0<=value<=gate._MAX:
            raise SourceUnavailable()
        digest.update(b'i'+str(value).encode('ascii')+b':')
    elif type(value) is str:
        if not value.isascii():
            raise SourceUnavailable()
        digest.update(b's'+str(len(value)).encode('ascii')+b':')
        for start in range(0,len(value),4096):
            digest.update(value[start:start+4096].encode('ascii'))
    elif type(value) is tuple:
        digest.update(b'[')
        for item in value:
            _semantic_digest_update(digest,item,depth=depth+1)
        digest.update(b']')
    else:
        raise SourceUnavailable()


def _semantic_window_digest(original, source_changes):
    """Material Prepare leaf, including exact current source/taste/association.

    Exclude ONLY transport request/receipt UUIDs, sampled creation time, and a
    new observation UUID when the verified row has no prior source revision.
    Global expected revision and aggregate quota are deliberately bound by the
    whole-review root, not leaves: our own earlier Apply batches change them.
    Existing observation/decision refs and all native state seals stay exact.
    """
    p=evidence._json_size(original)
    from .foobar_account_import_apply import _association_hold_bytes
    _private(32768+5*p+REVIEW_CONTROL_BYTES+_association_hold_bytes(len(original[2]),p))
    if (type(source_changes) is not tuple or len(source_changes)!=len(original[2])
            or any(type(changed) is not bool for changed in source_changes)):
        raise SourceUnavailable()
    digest=hashlib.sha256(b'albumhaven.foobar.semantic.window.v1\n')
    header=original[1]
    _semantic_digest_update(digest,(REVIEW_VERSION,original[0],header[:5],header[8:16]))
    for row,changed in zip(original[2],source_changes):
        # This null is justified only by the genuinely verified NEW prior.
        observation_ref = None if row[3] is None else row[2]
        _semantic_digest_update(digest,(row[:2],observation_ref,row[3:],changed))
    _semantic_digest_update(digest,(original[3],original[4]))
    return digest.hexdigest()


def _proposed_window(original, source_changes, quota, *, review):
    p = evidence._json_size(original)
    from .foobar_account_import_apply import _association_hold_bytes
    _private(32768+5*p+REVIEW_CONTROL_BYTES+_association_hold_bytes(len(original[2]),p))
    counts = [0] * 7
    review_counts = list(review[0])
    review_problems = list(review[1])
    truncated = review[2]
    for row, seal, changed in zip(original[2], original[4], source_changes):
        rating = favorite = False
        if row[9] is not None:
            state = taste.FoobarTasteState(*original[3][row[9]])
            rating, favorite = taste._foobar_taste_mutation_flags(state,
                rating=row[10], favorite=row[11])
            # The native owner protects both explicit flags AND an existing
            # manual rating without an import marker. No override is offered.
            protected_rating = (row[10] is not None and state.rating!=row[10]
                and (state.rating_protected or state.rating is not None and state.rating_marker is None))
            protected_favorite = bool(row[11] and state.love_tier=='off' and state.favorite_protected)
            review_counts[4] += int(protected_rating or protected_favorite)
            if protected_rating:
                truncated = _add_review_problem(review_problems,row[0],'protected_rating','rating') or truncated
            if protected_favorite:
                truncated = _add_review_problem(review_problems,row[0],'protected_favorite','favorite') or truncated
        taste_changed = rating or favorite
        counts[(1 if changed else 0) + (2 if taste_changed else 0)] += 1
        counts[4] += int(rating)
        counts[5] += int(favorite)
        counts[6] += int(seal[8] == 'never_decided' and seal[9] is not None)
        review_counts[5] += int(not changed and not taste_changed
            and not (seal[8]=='never_decided' and seal[9] is not None))
    # First four use the same unchanged/source-only/taste-only/both order as
    # actual terminals, but these are predictions from real current owners.
    return FoobarProposedWindow(original[1][12]-1, original[1][13]-1,
        original[1][11], tuple(counts), quota[0], quota[1],
        review_counts=tuple(review_counts),review_problems=tuple(review_problems),
        review_truncated=truncated,proposal_sha256=_semantic_window_digest(original,source_changes),
        source_bytes_peak_addition=quota[2])


class _PreflightRolledBack(Exception):
    def __init__(self, result):
        super().__init__('Rollback private preflight transaction.')
        self.result = result


def preflight_indexed_foobar_window(database_url, context, *, upload, command,
                                     intake_capacity, constraints=None,
                                     conflict_after=None, conflict_limit=MAX_PERSONAL_CONFLICTS,
                                     problem_after=None, problem_limit=MAX_REVIEW_PROBLEMS,
                                     observation_after=None, observation_limit=observation_preview.MAX_ROWS,
                                     observation_raw=None):
    """Genuine candidate planning with explicit rollback, no prepared receipt.

    The gate may touch metadata inside this transaction. Explicit native rollback
    and IDLE/open checks precede a sentinel which exits the real transaction before returning
    the bounded proposed summary. A rollback failure never returns the summary.
    It neither calls native taste/source writers nor inserts a READY receipt.
    """
    gate.validate_prepare_command(command)
    _check_conflict_page(conflict_after,conflict_limit)
    _check_problem_page(problem_after,problem_limit)
    if observation_after is not None:
        observation_preview.validate_page(observation_after,observation_limit,observation_raw)
        if conflict_after is not None or problem_after is not None:
            raise gate.PrepareInvalid()
    elif observation_raw is not None:
        raise gate.PrepareInvalid()
    if type(upload) is not indexed._AccountIndexedUpload:
        raise gate.PrepareInvalid()
    upload.validate(context, command)
    checked = _checked_constraints(constraints)
    presentation_hold=((CONFLICT_REVIEW_BYTES if conflict_after is not None else 0)
        +(PROBLEM_CONTROL_BYTES if problem_after is not None else 0)
        +(observation_preview.CONTROL_BYTES if observation_after is not None else 0))
    if presentation_hold:
        intake._admit(intake_capacity,indexed.retained_bytes(upload)+presentation_hold)
        # Intake admissions only reject; they never select a smaller candidate
        # prefix. The 4MiB private candidate owner and its hashes stay unchanged.
        intake_capacity=replace(intake_capacity,
            logical_bytes=intake_capacity.logical_bytes-presentation_hold)
    intake._admit(intake_capacity, indexed.retained_bytes(upload)+7*len(upload)
        +window.PARSER_WORK_BYTES+window.WINDOW_WORK_BYTES)
    try:
        deadline = _Deadline()
        with current_foobar_import_transaction(database_url, context,
                matching_library_id=command.matching_library_id,
                constraints=checked) as (raw, live, sampled_now):
            connection = _Connection(raw, deadline)
            source._authority(live, checked)
            proof = upload.proof(command.offset, intake_capacity)
            if proof.source_sha256 != command.upload_sha256:
                raise gate.PrepareInvalid()
            _private(32768+gate.PREPARE_GATE_BYTES)
            ticket = gate.begin_foobar_prepare_on_connection(connection, live,
                command=command, constraints=checked)
            if ticket.disposition != 'new':
                # A preflight key must not reinterpret an old receipt as a new
                # dry-run result. Durable job recovery has its separate owner.
                raise SourceStale()
            if command.matching_library_id is not None:
                from .foobar_account_match_readiness import require_foobar_match_schema_on_connection
                require_foobar_match_schema_on_connection(connection)
            live = _matching_context(connection, live, context,
                command.matching_library_id, constraints=checked)
            inventory, projections, first, counts = _read_inventory(connection, live,
                payload=upload, proof=proof, command=command,
                constraints=checked, capacity=intake_capacity)
            if problem_after is None:
                original, body, prepared_sha256, decision_sha256, fresh, result = _prepare_candidate(
                    connection,live,payload=upload,command=command,proof=proof,ticket=ticket,
                    inventory_files=inventory.files,targets=inventory.targets,
                    projections=projections,first=first,target_counts=counts,constraints=checked)
            else:
                original, body, prepared_sha256, decision_sha256, fresh, result = _prepare_candidate(
                    connection,live,payload=upload,command=command,proof=proof,ticket=ticket,
                    inventory_files=inventory.files,targets=inventory.targets,
                    projections=projections,first=first,target_counts=counts,constraints=checked,
                    problem_after=problem_after,problem_limit=problem_limit)
            if conflict_after is not None:
                conflicts,conflict_count,conflict_remaining=_personal_conflicts_on_connection(
                    connection,live,original=original,source_ref=command.source_ref,
                    conflict_after=conflict_after,conflict_limit=conflict_limit,constraints=checked,
                    payload=upload,first=first)
                result=replace(result,conflicts=conflicts,conflict_count=conflict_count,
                    conflict_after=conflict_after,conflict_remaining=conflict_remaining)
                del conflicts
            if observation_after is not None:
                p=evidence._json_size(original)
                from .foobar_account_import_apply import _association_hold_bytes
                held=_association_hold_bytes(len(original[2]),p)
                def admit_observation(size):
                    # The separately charged presentation hold owns only
                    # bounded DTOs; current candidate/codec scratch remains
                    # subject to the genuine existing private phase ceiling.
                    _private(32768+5*p+held+evidence.decode_phase_bytes(size))
                items,remaining,chunk=observation_preview.collect(original,
                    after=observation_after,limit=observation_limit,raw=observation_raw,
                    admit=admit_observation,label=_bounded_personal_label)
                result=replace(result,observation_items=items,
                    observation_remaining=remaining,observation_chunk=chunk)
                del items,remaining,chunk,admit_observation
            del original, body, prepared_sha256, decision_sha256, fresh
            result = replace(result, operational_budget=_preflight_operational_budget(
                connection,live,command))
            source._authority(live, checked)
            deadline.check()
            # Pool exception cleanup may suppress rollback errors to preserve
            # an earlier exception. Confirm rollback explicitly BEFORE raising
            # our control sentinel; failures here must never yield a summary.
            raw.rollback()
            if (raw.closed is not False or taste.psycopg is None
                    or raw.info.transaction_status != taste.psycopg.pq.TransactionStatus.IDLE):
                raise SourceUnavailable()
            deadline.check()
            raise _PreflightRolledBack(result)
    except _PreflightRolledBack as completed:
        return completed.result
    except (SourceStale, SourceUnavailable, gate.PrepareInvalid, intake.FoobarPreparationRejected):
        raise
    except taste.FoobarTasteStale:
        raise SourceStale() from None
    except Exception:
        raise SourceUnavailable() from None


def _preflight_operational_budget(connection,live,command):
    """Current actual stream counters under its existing source lock."""
    _private(32768+gate.PREPARE_GATE_BYTES+8192)
    frame=json.dumps((live.actor.account_id,None,live.actor.session_id,
        command.source_ref,command.generation,command.request_key),
        ensure_ascii=True,separators=(',',':')).encode('ascii')
    stream=gate._stream_result(source._query(connection,gate._LOCK_SQL,frame,maximum=1))
    if stream['revision']!=command.expected_revision or stream['current_generation']!=command.generation:
        raise SourceStale()
    return tuple(stream[name] for name in ('current_generation','prepared_today',
        'receipt_count','ready_count','receipt_reserved_bytes','request_key_count'))
