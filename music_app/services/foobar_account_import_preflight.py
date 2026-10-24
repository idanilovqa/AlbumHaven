"""Whole-upload dry-run using real indexed candidate/transaction owners.

No persisted preflight token or job authorization. This is intended for the
existing one-worker/process job owner, not a second executor or scheduler.
"""
from dataclasses import dataclass, replace
import hashlib
import threading
from uuid import UUID, uuid5

from . import foobar_account_import_prepare as prepare
from . import foobar_account_prepare_gate as gate
from . import foobar_account_indexed_upload as indexed
from . import foobar_enhanced_raw_windows as enhanced_windows
from . import foobar_account_enhanced_prepare as enhanced_prepare
from .foobar_account_source_postgres import SourceStale, SourceUnavailable

MAX_REVIEW_WINDOWS = 4000
# Four views of each <=128-byte (offset,end,hex-digest) leaf, plus fixed
# counters/problems/hash controls. Neither raw nor prepared rows are retained.
REVIEW_AGGREGATE_BYTES = 65536+512*MAX_REVIEW_WINDOWS
CONFLICT_CONTROL_BYTES = prepare.CONFLICT_CONTROL_BYTES
CONFLICT_REVIEW_BYTES = prepare.CONFLICT_REVIEW_BYTES
PROBLEM_CONTROL_BYTES = prepare.PROBLEM_CONTROL_BYTES


@dataclass(frozen=True, slots=True)
class FoobarGlobalPreflight:
    source_ref: str
    generation: int
    upload_sha256: str
    expected_revision: int
    status: str
    total_rows: int
    checked_rows: int
    remaining_rows: int
    proposed_counts: tuple
    proposed_quota_additions: tuple
    proposed_changed_batches: int
    rows_with_field_errors: int
    field_error_count: int
    unsupported_nonempty_field_count: int
    diagnostics_truncated: bool
    planned_batches: int
    operational_budget: tuple | None
    start_offset: int
    review_counts: tuple = ()
    review_problems: tuple = ()
    review_truncated: bool = False
    proposal_sha256: str | None = None
    # Internal worker fence only; never returned in the public review DTO.
    window_seals: tuple = ()
    # Optional bounded presentation. These fields do not enter the default
    # import root, native plan, prepared-v3 receipts or preserve-only behavior.
    conflicts: tuple = ()
    conflict_count: int = 0
    conflict_after: int | None = None
    conflict_remaining: int = 0
    conflict_next: int | None = None
    problem_items: tuple = ()
    problem_count: int = 0
    problem_after: int | None = None
    problem_remaining: int = 0
    problem_next: int | None = None
    observation_items: tuple = ()
    observation_after: int | None = None
    observation_remaining: int = 0
    observation_next: int | None = None
    observation_chunk: prepare.observation_preview.RawFieldChunk | None = None


def preflight_indexed_foobar_import(database_url, context, *, upload, command,
                                      intake_capacity, cancel_event, constraints=None,
                                      conflict_after=None, problem_after=None,
                                      observation_after=None, observation_raw=None):
    """Visit the entire original upload before any import business mutation.

    Each bounded transaction independently revalidates actual current authority,
    inventory, source, taste and associations. This is not one serial database
    snapshot or a promise the eventual Apply changes will equal predictions.
    An unchanged source revision and immutable native projection map are required
    throughout. All actual batches MUST still prepare and revalidate afresh.
    """
    gate.validate_prepare_command(command)
    prepare._check_conflict_page(conflict_after,prepare.MAX_PERSONAL_CONFLICTS)
    prepare._check_problem_page(problem_after,prepare.MAX_REVIEW_PROBLEMS)
    is_enhanced=command.mapping_name==gate.ENHANCED_MAPPING
    if observation_after is not None:
        prepare.observation_preview.validate_page(observation_after,raw=observation_raw)
        if is_enhanced or conflict_after is not None or problem_after is not None or observation_after<command.offset:
            raise gate.PrepareInvalid()
    elif observation_raw is not None:
        raise gate.PrepareInvalid()
    if type(cancel_event) is not threading.Event:
        raise gate.PrepareInvalid()
    if is_enhanced:
        if conflict_after is not None or problem_after is not None:
            raise gate.PrepareInvalid()
        enhanced_prepare._index(upload,command)
        total=upload.records
        retained_bytes=enhanced_windows.index_retained_logical_bytes(total)
        # These are TSV field diagnostics only, not claims that Enhanced raw
        # records contain no invalid/unavailable evidence. Its review is typed.
        parser_diagnostics=(0,0,0,False)
    else:
        if type(upload) is not indexed._AccountIndexedUpload:
            raise gate.PrepareInvalid()
        upload.validate(context, command)
        parser_summary = upload._upload.terminal.summary
        total = parser_summary.data_rows
        retained_bytes=upload.retained_bytes
        parser_diagnostics=(parser_summary.rows_with_field_errors,
            parser_summary.field_error_count,parser_summary.unsupported_nonempty_field_count,
            parser_summary.diagnostics_truncated)
    if not 0 <= command.offset <= total:
        raise gate.PrepareInvalid()
    # Admit the aggregate owner before constructing counters or hash controls.
    prepare.intake._admit(intake_capacity,retained_bytes+REVIEW_AGGREGATE_BYTES
        +(CONFLICT_REVIEW_BYTES if conflict_after is not None else 0)
        +(PROBLEM_CONTROL_BYTES if problem_after is not None else 0)
        +(prepare.observation_preview.CONTROL_BYTES if observation_after is not None else 0))
    # A downward-only server sub-budget keeps retained leaves charged while
    # the genuine indexed/Prepare owners perform every existing admission.
    # Optional window holds cover retained earlier plus current page entries:
    # remaining-capacity forwarding keeps each combined page at most32.
    window_capacity = replace(intake_capacity,
        logical_bytes=intake_capacity.logical_bytes-REVIEW_AGGREGATE_BYTES)
    counts, additions = [0]*7, [0]*3
    review_counts, review_problems, window_seals = [0]*6, [], []
    conflicts=[]
    conflict_count=conflict_remaining=0
    problem_items=[]
    problem_count=problem_remaining=0
    observation_items=[]
    observation_remaining=0
    observation_chunk=None
    review_truncated = False
    root = hashlib.sha256(b'albumhaven.foobar.semantic.review.v1\n')
    account = prepare._account_context(context)
    prepare._semantic_digest_update(root,(prepare.REVIEW_VERSION,
        account.actor.account_id,account.actor.session_id,command.source_ref,
        command.matching_library_id,command.generation,command.expected_revision,
        command.upload_sha256,gate.parser_for_mapping(command.mapping_name),command.mapping_name,
        command.inventory_sha256,command.offset,total))
    initial_quota = initial_budget = None
    offset = command.offset
    changed_batches = planned_batches = 0
    # Aggregate controls are fixed-size, never all prepared rows or receipts.
    while offset < total and not cancel_event.is_set():
        local = replace(command, offset=offset,
            request_key=str(uuid5(UUID(command.request_key), 'foobar-preflight:'+str(offset))))
        if is_enhanced:
            proposed=enhanced_prepare.preflight_indexed_enhanced_window(database_url,context,
                upload=upload,command=local,intake_capacity=window_capacity,constraints=constraints)
        elif observation_after is not None:
            proposed=prepare.preflight_indexed_foobar_window(database_url,context,
                upload=upload,command=local,intake_capacity=window_capacity,constraints=constraints,
                observation_after=observation_after,
                observation_limit=prepare.observation_preview.MAX_ROWS-len(observation_items),
                observation_raw=observation_raw)
        elif problem_after is not None:
            proposed=prepare.preflight_indexed_foobar_window(database_url,context,
                upload=upload,command=local,intake_capacity=window_capacity,constraints=constraints,
                conflict_after=conflict_after,conflict_limit=prepare.MAX_PERSONAL_CONFLICTS-len(conflicts),
                problem_after=problem_after,problem_limit=prepare.MAX_REVIEW_PROBLEMS-len(problem_items))
        elif conflict_after is None:
            # Preserve the ordinary Prepare/job preflight call shape, without
            # extra native metadata reads or new import-confirmation semantics.
            proposed=prepare.preflight_indexed_foobar_window(database_url,context,
                upload=upload,command=local,intake_capacity=window_capacity,constraints=constraints)
        else:
            proposed=prepare.preflight_indexed_foobar_window(database_url,context,
                upload=upload,command=local,intake_capacity=window_capacity,constraints=constraints,
                conflict_after=conflict_after,conflict_limit=prepare.MAX_PERSONAL_CONFLICTS-len(conflicts))
        if (type(proposed) is not prepare.FoobarProposedWindow
                or proposed.offset != offset or proposed.total_rows != total
                or not offset < proposed.end <= min(offset+100,total)
                or len(proposed.proposed_counts) != 7 or len(proposed.quota_additions) != 3
                or len(proposed.current_quota) != 3
                or any(type(n) is not int or not 0<=n<=limit for n,limit in
                       zip(proposed.current_quota,(100000,1000000,268435456)))
                or any(type(n) is not int or not 0<=n<=proposed.end-offset for n in proposed.proposed_counts)
                or any(type(n) is not int or n<0 for n in proposed.quota_additions[:2])
                or type(proposed.quota_additions[2]) is not int
                or type(proposed.source_bytes_peak_addition) is not int
                or proposed.source_bytes_peak_addition<max(0,proposed.quota_additions[2])
                or sum(proposed.proposed_counts[:4]) != proposed.end-offset
                or len(proposed.review_counts)!=6
                or any(type(n) is not int or not 0<=n<=proposed.end-offset for n in proposed.review_counts)
                or proposed.review_counts[0]!=proposed.end-offset
                or type(proposed.review_problems) is not tuple
                or len(proposed.review_problems)>prepare.MAX_REVIEW_PROBLEMS
                or type(proposed.review_truncated) is not bool
                or not gate._hex(proposed.proposal_sha256)):
            raise SourceUnavailable()
        if conflict_after is not None:
            _check_conflict_window(proposed,conflict_after=conflict_after,
                remaining_capacity=prepare.MAX_PERSONAL_CONFLICTS-len(conflicts))
            # The optional window reserve covers old retained page members and
            # this window's new members: their total never exceeds32. All tuple
            # and list views belong to the same fixed conflict control reserve.
            conflicts.extend(proposed.conflicts)
            conflict_count+=proposed.conflict_count
            conflict_remaining+=proposed.conflict_remaining
        if problem_after is not None:
            _check_problem_window(proposed,problem_after=problem_after,
                remaining_capacity=prepare.MAX_REVIEW_PROBLEMS-len(problem_items))
            problem_items.extend(proposed.problem_items)
            problem_count+=proposed.problem_count
            problem_remaining+=proposed.problem_remaining
        if initial_quota is None:
            initial_quota = proposed.current_quota
        elif initial_quota != proposed.current_quota:
            raise SourceStale()
        if initial_budget is None:
            initial_budget = proposed.operational_budget
        elif initial_budget != proposed.operational_budget:
            raise SourceStale()
        planned_batches += 1
        _admit_operational_budget(initial_budget, planned_batches, command.generation)
        if planned_batches>MAX_REVIEW_WINDOWS:
            raise SourceUnavailable()
        # Admission precedes append/copy, even though a full bounded reserve
        # was already withheld from all downstream candidate phases above.
        prepare.intake._admit(intake_capacity,
            retained_bytes+65536+512*planned_batches
                +(CONFLICT_CONTROL_BYTES if conflict_after is not None else 0)
                +(PROBLEM_CONTROL_BYTES if problem_after is not None else 0))
        leaf=(proposed.offset,proposed.end,proposed.proposal_sha256)
        window_seals.append(leaf)
        prepare._semantic_digest_update(root,leaf)
        counts = [a+b for a,b in zip(counts,proposed.proposed_counts)]
        # Every dry-run window sees the unchanged database revision. The only
        # revision-dependent compact codec bytes are its canonical top-level
        # decimal revision. Enhanced child bytes contain no revision at all;
        # only its one header per changed observation does. Later real batches
        # may cross a digit boundary.
        # Adjust exact final bytes by changed rows * decimal-width growth; add
        # that full nonnegative growth to the ordered peak conservatively.
        source_changed=proposed.proposed_counts[1]+proposed.proposed_counts[3]
        window_changed=any(proposed.proposed_counts[k] for k in (1,2,3,6))
        if command.expected_revision+changed_batches+int(window_changed)>gate._MAX:
            raise SourceUnavailable()
        next_revision=command.expected_revision+changed_batches+1
        revision_growth=(source_changed*(len(str(next_revision))
            -len(str(command.expected_revision+1))) if source_changed else 0)
        if revision_growth<0:
            raise SourceUnavailable()
        if (initial_quota[2]+additions[2]
                +proposed.source_bytes_peak_addition+revision_growth>268435456):
            raise prepare.source.FoobarSourceCapacityExceeded()
        additions = [a+b for a,b in zip(additions,proposed.quota_additions)]
        additions[2]+=revision_growth
        review_counts = [a+b for a,b in zip(review_counts,proposed.review_counts)]
        for ordinal,code,field in proposed.review_problems:
            review_truncated = prepare._add_review_problem(review_problems,ordinal,code,field) or review_truncated
        if observation_after is not None:
            items=proposed.observation_items
            if (type(items) is not tuple
                    or len(items)>prepare.observation_preview.MAX_ROWS-len(observation_items)
                    or type(proposed.observation_remaining) is not int
                    or not 0<=proposed.observation_remaining<=proposed.end-offset):
                raise SourceUnavailable()
            previous=observation_items[-1].ordinal if observation_items else observation_after
            for item in items:
                if (type(item) is not prepare.observation_preview.ObservationRow
                        or not max(previous,offset)<item.ordinal<=proposed.end):
                    raise SourceUnavailable()
                previous=item.ordinal
            observation_items.extend(items)
            observation_remaining+=proposed.observation_remaining
            if proposed.observation_chunk is not None:
                if observation_chunk is not None:
                    raise SourceUnavailable()
                observation_chunk=proposed.observation_chunk
            del items
        review_truncated = proposed.review_truncated or review_truncated
        changed_batches += int(window_changed)
        if any(not 0<=base+delta<=limit for base,delta,limit in
                zip(initial_quota,additions,(100000,1000000,268435456))):
            raise prepare.source.FoobarSourceCapacityExceeded()
        if command.expected_revision+changed_batches > gate._MAX:
            raise SourceUnavailable()
        offset = proposed.end
        del proposed,leaf
    status = 'complete_preflight' if offset == total and not cancel_event.is_set() else 'cancelled_preflight'
    # Receipt/READY/key/reserved/day counters are advisory admission, not user
    # intent: explicit resume may safely discard a previous uncommitted READY.
    # They remain freshly checked above but are intentionally not hashed.
    prepare._semantic_digest_update(root,(status,offset,tuple(counts),initial_quota,
        tuple(additions),changed_batches,tuple(review_counts),tuple(review_problems),
        review_truncated,*parser_diagnostics))
    if observation_raw is not None and status=='complete_preflight' and observation_chunk is None:
        raise gate.PrepareInvalid()
    return FoobarGlobalPreflight(command.source_ref,command.generation,
        command.upload_sha256,command.expected_revision,status,total,offset-command.offset,total-offset,
        tuple(counts),tuple(additions),changed_batches,*parser_diagnostics,
        planned_batches,initial_budget,command.offset,
        tuple(review_counts),tuple(review_problems),review_truncated,root.hexdigest(),tuple(window_seals),
        tuple(conflicts),conflict_count,0 if is_enhanced or observation_after is not None else conflict_after,conflict_remaining,
        conflicts[-1].cursor if conflicts and conflict_remaining else None,
        tuple(problem_items),problem_count,0 if is_enhanced or observation_after is not None else problem_after,problem_remaining,
        problem_items[-1].cursor if problem_items and problem_remaining else None,
        tuple(observation_items),observation_after,observation_remaining,
        observation_items[-1].ordinal if observation_items and observation_remaining else None,
        observation_chunk)


def _check_problem_window(proposed, *, problem_after, remaining_capacity):
    """Validate the genuine optional presentation without touching root inputs."""
    maximum=(len(prepare.parser.FIELD_NAMES)+3)*(proposed.end-proposed.offset)
    if (type(proposed.problem_items) is not tuple or len(proposed.problem_items)>remaining_capacity
            or type(proposed.problem_count) is not int or not 0<=proposed.problem_count<=maximum
            or type(proposed.problem_after) is not int or proposed.problem_after!=problem_after
            or type(proposed.problem_remaining) is not int
            or not 0<=proposed.problem_remaining<=proposed.problem_count
            or len(proposed.problem_items)+proposed.problem_remaining>proposed.problem_count
            or proposed.problem_remaining>0 and len(proposed.problem_items)!=remaining_capacity):
        raise SourceUnavailable()
    previous=problem_after
    for item in proposed.problem_items:
        if (type(item) is not prepare.FoobarDiagnosticProblem
                or type(item.cursor) is not int or item.cursor<=previous
                or type(item.ordinal) is not int or not proposed.offset<item.ordinal<=proposed.end
                or item.cursor//prepare.PROBLEM_CURSOR_STRIDE!=item.ordinal
                or not 0<=item.cursor%prepare.PROBLEM_CURSOR_STRIDE<len(prepare.parser.FIELD_NAMES)+3
                or type(item.code) is not str or item.code not in prepare._REVIEW_PROBLEM_CODES
                or item.field is not None and (type(item.field) is not str
                    or item.field not in prepare.parser.FIELD_NAMES)):
            raise SourceUnavailable()
        for value,limit in ((item.source_artist,48),(item.source_title,96),(item.source_album,48)):
            if (type(value) is not str or len(value)>limit
                    or prepare._bounded_personal_label(value,limit)!=value):
                raise SourceUnavailable()
        previous=item.cursor


def _check_conflict_window(proposed, *, conflict_after, remaining_capacity):
    """Fail closed before retaining any bounded native decision from a window."""
    if (type(proposed.conflicts) is not tuple or len(proposed.conflicts)>remaining_capacity
            or type(proposed.conflict_count) is not int
            or not 0<=proposed.conflict_count<=2*(proposed.end-proposed.offset)
            or proposed.conflict_after!=conflict_after
            or type(proposed.conflict_remaining) is not int
            or not 0<=proposed.conflict_remaining<=proposed.conflict_count
            or len(proposed.conflicts)+proposed.conflict_remaining>proposed.conflict_count):
        raise SourceUnavailable()
    previous=conflict_after
    for decision in proposed.conflicts:
        if (type(decision) is not prepare.FoobarPersonalConflict
                or type(decision.cursor) is not int or decision.cursor<=previous
                or type(decision.ordinal) is not int
                or not proposed.offset<decision.ordinal<=proposed.end
                or decision.field not in ('rating','favorite')
                or decision.cursor!=2*decision.ordinal+int(decision.field=='favorite')
                or type(decision.eligible) is not bool
                or decision.ineligible_reason!=(None if decision.eligible else 'provenance_requires_review')
                or type(decision.expected_state) is not tuple or len(decision.expected_state)!=13
                or type(decision.association_seal) is not tuple or len(decision.association_seal)!=10
                or not gate._hex(decision.fence_sha256)
                or not gate._hex(decision.source_identity_sha256)):
            raise SourceUnavailable()
        if decision.field=='rating':
            if (type(decision.incoming) is not int or not 1<=decision.incoming<=5
                    or decision.existing is not None and (type(decision.existing) is not int
                        or not 1<=decision.existing<=5)
                    or decision.existing==decision.incoming
                    or decision.consequence!='replace_personal_rating'):
                raise SourceUnavailable()
        elif (decision.existing!='off' or decision.incoming!='loved'
                or decision.consequence!='set_personal_favorite'):
            raise SourceUnavailable()
        previous=decision.cursor


def _admit_operational_budget(snapshot, batches, generation):
    """Conservative sequential receipt headroom, not a future reservation.

    Existing accounting reserves 4 MiB for READY, then actual <=669-byte terminal
    after Apply. At most one new READY is needed for this one-worker sequence.
    Existing READY reservations and their future Apply keys remain charged.
    """
    if (type(snapshot) is not tuple or len(snapshot)!=6
            or any(type(value) is not int for value in snapshot)
            or type(batches) is not int or not 1<=batches<=100000
            or snapshot[0]!=generation):
        raise SourceUnavailable()
    _, prepared, receipts, ready, reserved, keys = snapshot
    if (not 0<=prepared<=4000 or not 0<=receipts<=40000
            or not 0<=ready<=8 or not 0<=reserved<=67108864
            or not 0<=keys<=80000):
        raise SourceUnavailable()
    if (prepared+batches>4000 or receipts+batches>40000
            or ready+1>8 or keys+ready+2*batches>80000
            or reserved+prepare.terminal_codec.MAX_WIRE_BYTES*(batches-1)
                +prepare.MAX_PRIVATE_BYTES>67108864):
        raise SourceUnavailable()
