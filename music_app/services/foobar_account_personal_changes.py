"""Separate, single-attempt own-user personal changes from a genuine review.

The service owns the same-account/session cached review and consumes it once
before dispatch. This owner rechecks current native authority/data; cached
booleans or request values cannot grant permission or select proposed values.
No import job, source evidence, receipt, quota, binding or revision is mutated.
"""
from dataclasses import dataclass, replace
from datetime import date, timezone
import json

from . import foobar_account_import_prepare as prepare
from . import foobar_account_import_preflight as preflight
from . import foobar_account_import_jobs as jobs
from . import foobar_account_import_associations as associations
from . import foobar_account_prepare_gate as gate
from . import foobar_account_source_postgres as source
from . import track_preferences_postgres as taste
from .foobar_account_matching_authority import current_foobar_import_transaction
from .foobar_account_source_postgres import SourceStale, SourceUnavailable

MAX_SELECTED_FIELDS = 32
CONTROL_BYTES = 131072


class FoobarPersonalChangesCommitUncertain(SourceUnavailable):
    """The outer commit boundary was entered; never silently redispatch."""
    commit_uncertain = True


@dataclass(frozen=True, slots=True)
class FoobarPersonalChangesResult:
    # Public safe fields only: ordinal, field, old value, selected incoming value.
    changed_fields: tuple


_F = """with f as materialized (select convert_from(%b::bytea,'UTF8')::jsonb j),
x as materialized (select (j->>0)::bigint account_id,(j->>1)::uuid source_ref,
 (j->>2)::bigint library_id from f),
inputs as materialized (select (r->>0)::integer ordinal,(r->>1)::uuid observation_ref,
 (r->>2)::bigint source_revision,decode(r->>3,'hex') identity_sha256,
 (r->>4)::bigint track_id from f cross join lateral jsonb_array_elements(j->3) r)
"""
_SOURCE = _F + """
select i.ordinal,o.observation_ref::text observation_ref,o.current_revision source_revision,
 encode(o.identity_sha256,'hex') identity_sha256
from inputs i cross join x
left join integration.foobar_import_observations_v2 o
 on (o.account_id,o.source_ref,o.identity_sha256)=(x.account_id,x.source_ref,i.identity_sha256)
order by i.ordinal,o.observation_ref
"""
_RESERVATIONS = _F + """
select i.ordinal from inputs i cross join x
where exists (
 select 1 from integration.foobar_import_local_matches_v2 m
 join library.local_tracks t on (t.library_id,t.track_key)=(m.library_id,m.track_key)
 where (m.account_id,m.source_ref,m.library_id)=(x.account_id,x.source_ref,x.library_id)
   and t.id=i.track_id and m.observation_ref is distinct from i.observation_ref
)
order by i.ordinal
"""


def _cached_review(review_progress, context):
    # Lazy import: review imports the ordinary worker/service while settling.
    from . import foobar_account_import_review as review
    if type(review_progress) is not review.FoobarReviewProgress:
        raise SourceUnavailable()
    account = prepare._account_context(context)
    if (not gate._integer(review_progress.account_id, 1, gate._MAX)
            or not gate._integer(review_progress.session_id, 1, gate._MAX)
            or (review_progress.account_id, review_progress.session_id) != (
                account.actor.account_id, account.actor.session_id)):
        raise SourceStale()
    review.validate_review_request(review_progress.request)
    result = review_progress.result
    if (review_progress.phase != 'review_ready' or review_progress.error is not None
            or type(result) is not review.FoobarReviewResult
            or type(result.proposed) is not preflight.FoobarGlobalPreflight):
        raise SourceStale()
    jobs._command(result.command)
    request, command, proposed = review_progress.request, result.command, result.proposed
    if (type(result.resume) is not bool or result.resume != request.resume
            or command.source_ref != request.source_ref or command.job_ref != request.job_ref
            or command.original_matching_library_id != request.matching_library_id
            or not gate._integer(request.matching_library_id, 1, gate._MAX)
            or not gate._hex(result.inventory_sha256)
            or proposed.source_ref != command.source_ref
            or proposed.upload_sha256 != command.upload_sha256
            or not gate._integer(proposed.generation, command.original_generation, 2147483647)
            or not gate._integer(proposed.expected_revision, 0, gate._MAX)
            or proposed.status != 'complete_preflight'
            or type(proposed.total_rows) is not int or proposed.total_rows != command.total_rows
            or not gate._integer(proposed.start_offset, 0, proposed.total_rows - 1)
            or type(proposed.checked_rows) is not int
            or proposed.checked_rows != proposed.total_rows - proposed.start_offset
            or type(proposed.remaining_rows) is not int or proposed.remaining_rows != 0
            or not gate._hex(proposed.proposal_sha256)
            or type(proposed.conflicts) is not tuple
            or not 1 <= len(proposed.conflicts) <= MAX_SELECTED_FIELDS
            or not gate._integer(proposed.conflict_after, 0, 2 * proposed.total_rows + 1)):
        raise SourceStale()
    return result


def _selected_decisions(result, choices):
    if (type(choices) is not tuple or not 1 <= len(choices) <= MAX_SELECTED_FIELDS
            or any(type(item) is not tuple or len(item) != 2
                or not gate._integer(item[0], 1, result.command.total_rows)
                or type(item[1]) is not str or item[1] not in ('rating', 'favorite')
                for item in choices)
            or len(set(choices)) != len(choices)):
        raise gate.PrepareInvalid()
    page = result.proposed.conflicts
    previous = result.proposed.conflict_after
    for decision in page:
        if (type(decision) is not prepare.FoobarPersonalConflict
                or not gate._integer(decision.ordinal, result.proposed.start_offset + 1,
                                     result.command.total_rows)
                or type(decision.field) is not str or decision.field not in ('rating', 'favorite')
                or type(decision.cursor) is not int or decision.cursor <= previous
                or decision.cursor != 2 * decision.ordinal + int(decision.field == 'favorite')
                or type(decision.eligible) is not bool
                or decision.ineligible_reason != (None if decision.eligible else 'provenance_requires_review')
                or type(decision.expected_state) is not tuple or len(decision.expected_state) != 13
                or not gate._hex(decision.fence_sha256)
                or type(decision.association_seal) is not tuple or len(decision.association_seal) != 10
                or not gate._hex(decision.source_identity_sha256)):
            raise SourceUnavailable()
        state = taste.FoobarTasteState(*decision.expected_state)
        taste._foobar_taste_check_state(state, result.command.source_ref)
        if (decision.association_seal[0] != decision.ordinal
                or type(decision.association_seal[0]) is not int
                or type(decision.association_seal[9]) is not int
                or decision.association_seal[9] != state.track_id):
            raise SourceUnavailable()
        if decision.observation_ref is None:
            if (decision.source_revision is not None
                    or decision.association_seal != (decision.ordinal, None, None, None,
                        None, None, None, None, 'never_decided', state.track_id)):
                raise SourceUnavailable()
        else:
            if (not gate._uuid(decision.observation_ref)
                    or not gate._integer(decision.source_revision, 1, result.proposed.expected_revision)):
                raise SourceUnavailable()
            associations._seals(((decision.ordinal, decision.observation_ref),),
                (decision.association_seal,), result.command.original_matching_library_id)
        if decision.field == 'rating':
            if (type(decision.incoming) is not int or not 1 <= decision.incoming <= 5
                    or type(decision.existing) is not type(state.rating) or decision.existing != state.rating
                    or decision.incoming == decision.existing
                    or decision.consequence != 'replace_personal_rating'):
                raise SourceUnavailable()
        elif (type(decision.existing) is not str or decision.existing != 'off'
                or state.love_tier != 'off' or type(decision.incoming) is not str
                or decision.incoming != 'loved' or decision.consequence != 'set_personal_favorite'):
            raise SourceUnavailable()
        previous = decision.cursor
    selected = tuple(next((decision for decision in page
        if (decision.ordinal, decision.field) == choice), None) for choice in choices)
    if any(decision is None or decision.eligible is not True for decision in selected):
        raise gate.PrepareInvalid()
    # Both fields on one source row share exactly the same retained native and
    # association observation. Distinct source rows may not claim one target.
    by_ordinal, targets = {}, {}
    for decision in selected:
        retained = (decision.expected_state, decision.fence_sha256, decision.association_seal,
                    decision.observation_ref, decision.source_revision, decision.source_identity_sha256)
        if decision.ordinal in by_ordinal and by_ordinal[decision.ordinal][0] != retained:
            raise SourceUnavailable()
        track_id = decision.expected_state[0]
        if track_id in targets and targets[track_id] != decision.ordinal:
            raise SourceStale()
        by_ordinal[decision.ordinal] = (retained, decision)
        targets[track_id] = decision.ordinal
    unique = tuple(by_ordinal[ordinal][1] for ordinal in sorted(by_ordinal))
    return selected, unique


def _frame(live, source_ref, decisions):
    payload = json.dumps((live.actor.account_id, source_ref, live.library_id, tuple(
        (d.ordinal, d.observation_ref, d.source_revision, d.source_identity_sha256,
         d.expected_state[0]) for d in decisions)),
        ensure_ascii=True, separators=(',', ':'), allow_nan=False).encode('ascii')
    if len(payload) > 8192:
        raise SourceUnavailable()
    return payload


def _check_source_and_associations(connection, live, *, source_ref, decisions, constraints):
    frame = _frame(live, source_ref, decisions)
    rows = source._query(connection, _SOURCE, frame, maximum=len(decisions))
    if len(rows) != len(decisions):
        raise SourceStale()
    for decision, row in zip(decisions, rows):
        if (type(row) is not dict or set(row) != {
                'ordinal', 'observation_ref', 'source_revision', 'identity_sha256'}
                or type(row['ordinal']) is not int or row['ordinal'] != decision.ordinal):
            raise SourceUnavailable()
        expected = (decision.observation_ref, decision.source_revision,
                    decision.source_identity_sha256 if decision.observation_ref is not None else None)
        if decision.observation_ref is not None and (
                not gate._uuid(row['observation_ref'])
                or not gate._integer(row['source_revision'], 1, gate._MAX)
                or not gate._hex(row['identity_sha256'])):
            raise SourceUnavailable()
        if tuple(row[key] for key in ('observation_ref', 'source_revision', 'identity_sha256')) != expected:
            raise SourceStale()
    observations = tuple((d.ordinal, d.observation_ref) for d in decisions if d.observation_ref is not None)
    if observations:
        seals = tuple(d.association_seal for d in decisions if d.observation_ref is not None)
        associations._seals(observations, seals, live.library_id)
        actual = associations.read_import_associations_on_connection(connection, live,
            source_ref=source_ref, library_id=live.library_id,
            observations=observations, constraints=constraints)
        if any(a[:9] != s[:9] for a, s in zip(actual, seals)) or len(actual) != len(seals):
            raise SourceStale()
    # Unlike the importer helper this read permits no observation for a new
    # source identity. SQL NULL means exclude nobody, not a fabricated UUID.
    if source._query(connection, _RESERVATIONS, frame, maximum=len(decisions)):
        raise SourceStale()


def _stream(connection, live, proposed, *, not_before):
    frame = json.dumps((live.actor.account_id, None, live.actor.session_id,
                        proposed.source_ref, proposed.generation, None),
                       separators=(',', ':')).encode('ascii')
    stream = gate._stream_result(source._query(connection, gate._LOCK_SQL, frame, maximum=1))
    current_day = (stream['observed_at'].astimezone(timezone.utc).date() - date(1970, 1, 1)).days
    if (stream['observed_at'] < not_before
            or stream['current_generation'] != proposed.generation
            or stream['current_generation'] != current_day
            or stream['revision'] != proposed.expected_revision
            or not stream['retired_through'] < proposed.generation):
        raise SourceStale()
    return stream['observed_at']


def apply_foobar_personal_changes(database_url, context, *, review_progress, choices,
                                   intake_capacity, constraints=None):
    """Apply selected cached row/field proposals once, returning only after commit."""
    commit_attempted = False
    try:
        result = _cached_review(review_progress, context)
        selected, unique = _selected_decisions(result, choices)
        held = CONTROL_BYTES + taste._foobar_personal_phase_bytes(len(selected))
        held += associations.association_phase_bytes(len(unique))
        prepare._private(held)
        prepare.intake._admit(intake_capacity, held)
        available = replace(intake_capacity, logical_bytes=intake_capacity.logical_bytes - held)
        checked = prepare._checked_constraints(constraints)
        deadline = prepare._Deadline()
        proposed = result.proposed
        command = gate.FoobarPrepareCommand(result.command.source_ref, proposed.generation,
            result.command.job_ref, proposed.expected_revision, result.command.upload_sha256,
            result.command.mapping_name, proposed.start_offset, result.inventory_sha256,
            result.command.original_matching_library_id)
        gate.validate_prepare_command(command)
        with current_foobar_import_transaction(database_url, context,
                matching_library_id=command.matching_library_id, constraints=checked) as (raw, live, now):
            connection = prepare._Connection(raw, deadline)
            if (live.actor.account_id, live.actor.session_id) != (
                    review_progress.account_id, review_progress.session_id):
                raise SourceStale()
            observed = _stream(connection, live, proposed, not_before=now)
            live = prepare._matching_context(connection, live, context,
                command.matching_library_id, constraints=checked)
            from .foobar_account_match_readiness import require_foobar_match_schema_on_connection
            require_foobar_match_schema_on_connection(connection)
            inventory = prepare._read_account_inventory(connection, live, command,
                constraints=checked, capacity=available)
            _check_source_and_associations(connection, live, source_ref=command.source_ref,
                decisions=unique, constraints=checked)
            native_choices = tuple(taste.FoobarPersonalChoice(
                taste.FoobarTasteState(*d.expected_state), d.fence_sha256, d.field, d.incoming,
            ) for d in selected)
            written = taste.apply_foobar_personal_changes_on_connection(connection, live,
                source_ref=command.source_ref, choices=native_choices, constraints=checked)
            if (type(written) is not taste.FoobarPersonalWriteResult
                    or type(written.outcomes) is not tuple or len(written.outcomes) != len(selected)
                    or type(written.postimages) is not tuple or len(written.postimages) != len(unique)
                    or any(type(outcome) is not taste.FoobarPersonalOutcome
                        or type(outcome.track_id) is not int
                        or type(outcome.field) is not str
                        or type(outcome.proposed) is not type(d.incoming)
                        or (outcome.track_id, outcome.field, outcome.proposed) !=
                           (d.expected_state[0], d.field, d.incoming)
                        for outcome, d in zip(written.outcomes, selected))):
                raise SourceUnavailable()
            for state in written.postimages:
                taste._foobar_taste_check_state(state, command.source_ref)
            if (len({state.track_id for state in written.postimages}) != len(unique)
                    or {state.track_id for state in written.postimages} !=
                       {d.expected_state[0] for d in unique}):
                raise SourceUnavailable()
            _check_source_and_associations(connection, live, source_ref=command.source_ref,
                decisions=unique, constraints=checked)
            current_files = prepare.read_foobar_inventory_scalars_on_connection(
                connection, live, constraints=checked)
            if current_files != inventory.files:
                raise SourceStale()
            prepare._check_complete_inventory_policy(live, inventory.targets, constraints=checked)
            _stream(connection, live, proposed, not_before=observed)
            prepare.require_account_foobar(live, checked)
            safe = FoobarPersonalChangesResult(tuple(
                (d.ordinal, d.field, d.existing, d.incoming) for d in selected))
            deadline.check()
            # No success escapes before real outer account/session rechecks and
            # commit. Any exception after this point has an uncertain outcome.
            commit_attempted = True
        deadline.check()
        return safe
    except Exception as exc:
        if commit_attempted:
            raise FoobarPersonalChangesCommitUncertain() from None
        if isinstance(exc, (SourceStale, SourceUnavailable, gate.PrepareInvalid)):
            raise
        if isinstance(exc, taste.FoobarTasteStale):
            raise SourceStale() from None
        raise SourceUnavailable() from None
