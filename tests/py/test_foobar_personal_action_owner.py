"""AUTHORED ONLY: actual separate transaction owner and consumed service action."""
from copy import deepcopy
from dataclasses import replace
from datetime import timedelta

import pytest

from tests.py.foobar_account_personal_testing import (
    install, seed, matched_payload, changes, personal_snapshot, CAPACITY, URL, p,
)
from tests.py.foobar_account_review_testing import (
    running, reviewed, review_sha, requested_context, PolicyEvaluationConstraints,
    begin_review, settled_review, business_snapshot, confirm, settled, PAYLOAD,
    SOURCE, JOB, NEXT_JOB, s, block_sql,
)
from tests.py.foobar_account_associations_v3_testing import history


def apply_review(db, progress, choices=((1, 'rating'),), *, context=None, constraints=None):
    return changes.apply_foobar_personal_changes(URL, context or requested_context(7),
        review_progress=progress, choices=choices, intake_capacity=CAPACITY,
        constraints=constraints or PolicyEvaluationConstraints())


def begin_action(handle, progress, choices=((1, 'rating'),), *, context=None):
    return handle.begin_personal_changes(context=context or requested_context(7),
        constraints=PolicyEvaluationConstraints(), source_ref=SOURCE,
        job_ref=progress.request.job_ref, review_sha256=review_sha(progress), choices=choices)


def delivery(handle, ticket):
    with handle.owner.condition:
        assert handle.owner.condition.wait_for(lambda: handle.owner.current is not None
            and handle.owner.current.stage is s._Stage.DELIVERY, timeout=5.0)
    value = handle.take_delivery(ticket)
    assert value is not None and handle.owner.current is None
    return value


def test_actual_action_owner_changes_only_selected_field_without_import_or_receipt(monkeypatch):
    db = install(monkeypatch)
    seed(db)
    with running(monkeypatch, db=db) as (db, handle, catalog):
        progress = reviewed(handle, PAYLOAD, library=7)
        before = business_snapshot(db)
        result = apply_review(db, progress)
        assert type(result) is changes.FoobarPersonalChangesResult
        assert result.changed_fields == ((1, 'rating', 2, 4),)
        assert db.tastes[21]['rating'] == 4 and db.tastes[21]['love_tier'] == 'off'
        assert len(db.personal_frames) == 1
        after = business_snapshot(db)
        assert after[:3] == before[:3] and after[4:] == before[4:]
        assert not db.job_rows and not db.attempts and not db.receipts and not db.keys
        assert changes._SOURCE in db.calls and changes._RESERVATIONS in db.calls
        assert db.calls.count(changes._SOURCE) == db.calls.count(changes._RESERVATIONS) == 2


@pytest.mark.parametrize('change', ['revision', 'generation', 'day', 'retired', 'source_deleted',
    'session_revoked', 'account_disabled', 'membership_deleted', 'browse_revoked', 'taste_revoked', 'all_grants_revoked',
    'inventory_changed', 'target_reserved', 'metadata_changed', 'timestamp_changed'])
def test_actual_action_owner_rechecks_current_source_lifecycle_and_authority(monkeypatch, change):
    db = install(monkeypatch)
    seed(db)
    with running(monkeypatch, db=db) as (db, handle, catalog):
        progress = reviewed(handle, PAYLOAD, library=7)
        if change == 'revision': db.revision += 1
        elif change == 'generation': db.current_generation += 1
        elif change == 'day': db.now += timedelta(days=1)
        elif change == 'retired': db.retired_through = db.current_generation
        elif change == 'source_deleted': db.sources.remove((1, SOURCE))
        elif change == 'session_revoked': db.sessions[(1, 3)] = False
        elif change == 'account_disabled': db.accounts[1] = False
        elif change == 'membership_deleted': db.membership = False
        elif change == 'browse_revoked': db.grants = ('library.track_preferences.manage',)
        elif change == 'taste_revoked': db.grants = ('library.browse.read',)
        elif change == 'all_grants_revoked': db.grants = ()
        elif change == 'inventory_changed': db.files[21] = '/changed-synthetic.flac'
        elif change == 'target_reserved': db.external_conflicts.add(21)
        elif change == 'metadata_changed': db.native_rows[21]['metadata']['external'] = True
        else: db.native_rows[21]['updated_at'] = 'external-timestamp'
        before = personal_snapshot(db)
        with pytest.raises((p.SourceStale, p.SourceUnavailable)):
            # Browse is a supported personal-taste alias. Deny the actual
            # taste action with its supported narrowing input, not a removed
            # redundant direct grant while the alias remains authorized.
            narrow = (lambda context: PolicyEvaluationConstraints(
                deployment_allowed=context.action != 'library.track_preferences.manage'))
            apply_review(db, progress, constraints=narrow if change == 'taste_revoked' else None)
        assert personal_snapshot(db) == before and not db.personal_frames
        assert not db.job_rows and not db.attempts and not db.receipts


@pytest.mark.parametrize('change', ['session', 'account', 'other_source', 'job', 'digest'])
def test_cached_service_review_never_transfers_to_another_identity_or_command(monkeypatch, change):
    db = install(monkeypatch)
    seed(db)
    with running(monkeypatch, db=db) as (db, handle, catalog):
        progress = reviewed(handle, PAYLOAD, library=7)
        ctx, source, job, digest = requested_context(7), SOURCE, JOB, review_sha(progress)
        if change == 'session': ctx = replace(ctx, actor=replace(ctx.actor, session_id=4))
        elif change == 'account':
            ctx = replace(ctx, actor=replace(ctx.actor, account_id=2, session_id=5), target_account_id=2)
        elif change == 'other_source': source = '44444444-4444-4444-8444-444444444444'
        elif change == 'job': job = NEXT_JOB
        else: digest = '0' * 64
        before, ticket_number = personal_snapshot(db), handle.owner.next_ticket
        with pytest.raises(p.SourceStale):
            handle.begin_personal_changes(context=ctx, constraints=PolicyEvaluationConstraints(),
                source_ref=source, job_ref=job, review_sha256=digest, choices=((1, 'rating'),))
        assert personal_snapshot(db) == before and handle.owner.next_ticket == ticket_number
        assert handle.owner.last_review is progress and handle.owner.current is None


@pytest.mark.parametrize('change', ['new_history', 'rematch', 'detach', 'observation_revision', 'observation_missing'])
def test_existing_source_and_association_must_still_equal_the_genuine_review(monkeypatch, change):
    db = install(monkeypatch)
    seed(db)
    with running(monkeypatch, db=db) as (db, handle, catalog):
        initial = reviewed(handle, PAYLOAD, library=7)
        confirm(handle, initial, PAYLOAD)
        assert settled(handle).phase == 'completed'
        reference = next(iter(db.source_rows))
        progress = reviewed(handle, PAYLOAD, library=7, job_ref=NEXT_JOB)
        assert progress.result.proposed.conflicts[0].observation_ref == reference
        if change == 'new_history': history(db, reference, track=21, version=2)
        elif change == 'rematch': history(db, reference, track=22, version=2)
        elif change == 'detach': history(db, reference, action='detach', version=2, binding=False)
        elif change == 'observation_revision': db.source_versions[reference] += 1
        else: del db.source_rows[reference]
        before, commits = personal_snapshot(db), db.calls.count(p.taste._foobar_personal_write_sql())
        with pytest.raises((p.SourceStale, p.SourceUnavailable)):
            apply_review(db, progress)
        assert personal_snapshot(db) == before
        assert db.calls.count(p.taste._foobar_personal_write_sql()) == commits


def test_new_source_identity_appearing_after_review_is_not_silently_accepted(monkeypatch):
    db = install(monkeypatch)
    seed(db)
    with running(monkeypatch, db=db) as (db, handle, catalog):
        progress = reviewed(handle, PAYLOAD, library=7)
        confirm(handle, progress, PAYLOAD)
        assert settled(handle).phase == 'completed'
        # Freeze stream revision to isolate the source-identity existence fence.
        # This is deliberately an inconsistent external-result corruption case,
        # not a claim a legitimate writer can omit its stream revision update.
        db.revision = progress.result.proposed.expected_revision
        before = personal_snapshot(db)
        with pytest.raises(p.SourceStale):
            apply_review(db, progress)
        assert personal_snapshot(db) == before and not db.personal_frames


@pytest.mark.parametrize('choices', [((1, 'rating'), (1, 'rating')), ((1, 'rating'), (99, 'favorite')),
    ((1, 'rating'), (1, 'clear')), (), ((True, 'rating'),)])
def test_malformed_or_partial_page_selection_cannot_apply_the_valid_subset(monkeypatch, choices):
    db = install(monkeypatch)
    seed(db)
    with running(monkeypatch, db=db) as (db, handle, catalog):
        progress = reviewed(handle, PAYLOAD, library=7)
        before = personal_snapshot(db)
        with pytest.raises(p.gate.PrepareInvalid):
            apply_review(db, progress, choices)
        assert personal_snapshot(db) == before and not db.personal_frames


def test_ineligible_member_rejects_entire_selection_before_the_other_target_is_written(monkeypatch):
    db = install(monkeypatch)
    payload = matched_payload(db, 2)
    db.native_rows[22]['metadata']['foobar_import_v1'] = {'rating': 'malformed'}
    db.project_native(22)
    with running(monkeypatch, db=db) as (db, handle, catalog):
        progress = reviewed(handle, payload, library=7)
        before = personal_snapshot(db)
        with pytest.raises(p.gate.PrepareInvalid):
            apply_review(db, progress, ((1, 'rating'), (2, 'rating')))
        assert personal_snapshot(db) == before and not db.personal_frames


@pytest.mark.parametrize('change_after_write', ['source_revision', 'reservation', 'inventory', 'constraints'])
def test_postwrite_revalidation_failure_rolls_back_every_selected_personal_change(monkeypatch, change_after_write):
    db = install(monkeypatch)
    seed(db)
    narrowed = [False]
    def constraints(target):
        return PolicyEvaluationConstraints(client_surface_allowed=not (
            narrowed[0] and target.action == 'library.track_preferences.manage'))
    def drift(database, frame):
        if change_after_write == 'source_revision': database.revision += 1
        elif change_after_write == 'reservation': database.external_conflicts.add(21)
        elif change_after_write == 'inventory': database.files[22] = '/changed-after-write.flac'
        else: narrowed[0] = True
    with running(monkeypatch, db=db) as (db, handle, catalog):
        progress = reviewed(handle, PAYLOAD, library=7)
        before = personal_snapshot(db)
        db.after_personal_write = drift
        with pytest.raises((p.SourceStale, p.SourceUnavailable)):
            apply_review(db, progress, ((1, 'rating'), (1, 'favorite')), constraints=constraints)
        assert personal_snapshot(db) == before and len(db.personal_frames) == 1
        assert not db.job_rows and not db.attempts


def test_service_consumes_review_before_dispatch_and_never_redispatches_lost_commit(monkeypatch):
    db = install(monkeypatch)
    seed(db)
    with running(monkeypatch, db=db) as (db, handle, catalog):
        progress = reviewed(handle, PAYLOAD, library=7)
        db.lose_ack = True
        ticket = begin_action(handle, progress)
        assert handle.owner.last_review is None
        result = delivery(handle, ticket)
        assert result.outcome is s._Outcome.COMMIT_UNCERTAIN
        assert db.tastes[21]['rating'] == 4 and len(db.personal_frames) == 1
        assert handle.owner.last_review is None and handle.owner.last_job is None
        calls, next_ticket = len(db.personal_frames), handle.owner.next_ticket
        with pytest.raises(p.SourceStale):
            begin_action(handle, progress)
        assert len(db.personal_frames) == calls and handle.owner.next_ticket == next_ticket
        assert not db.job_rows and not db.attempts and not db.receipts
        fresh = reviewed(handle, PAYLOAD, library=7)
        assert [(item.ordinal, item.field) for item in fresh.result.proposed.conflicts] == [(1, 'favorite')]


def test_service_error_consumes_review_and_does_not_retry_or_start_import(monkeypatch):
    db = install(monkeypatch)
    seed(db)
    with running(monkeypatch, db=db) as (db, handle, catalog):
        progress = reviewed(handle, PAYLOAD, library=7)
        before = personal_snapshot(db)
        db.fail_sql = changes._SOURCE
        result = delivery(handle, begin_action(handle, progress))
        assert result.outcome is s._Outcome.UNAVAILABLE
        assert personal_snapshot(db) == before and not db.personal_frames
        assert db.calls.count(changes._SOURCE) == 1
        assert handle.owner.last_review is None and handle.owner.last_job is None
        with pytest.raises(p.SourceStale):
            begin_action(handle, progress)
        assert not db.job_rows and not db.attempts


def test_real_continuation_reaches_later_pages_and_only_current_page_can_authorize(monkeypatch):
    db = install(monkeypatch)
    payload = matched_payload(db, 40)
    with running(monkeypatch, db=db) as (db, handle, catalog):
        first = reviewed(handle, payload, library=7)
        second = reviewed(handle, payload, library=7,
            conflict_after=first.result.proposed.conflict_next, previous_review_sha256=review_sha(first))
        assert second.result.proposed.conflict_count == 80
        assert second.result.proposed.conflict_remaining == 16
        assert second.result.proposed.conflicts[0].ordinal == 17
        assert review_sha(second) == review_sha(first)
        # Same whole-file digest is not authority for old-page field choices.
        result = delivery(handle, begin_action(handle, second, ((1, 'rating'),)))
        assert result.outcome is s._Outcome.INVALID and not db.personal_frames
        assert handle.owner.last_review is None


@pytest.mark.parametrize('change', ['cursor', 'scope', 'resume', 'digest', 'file', 'native', 'source'])
def test_continuation_cannot_reuse_a_page_after_material_context_or_content_change(monkeypatch, change):
    db = install(monkeypatch)
    payload = matched_payload(db, 20)
    with running(monkeypatch, db=db) as (db, handle, catalog):
        first = reviewed(handle, payload, library=7)
        options = dict(library=7, conflict_after=first.result.proposed.conflict_next,
            previous_review_sha256=review_sha(first))
        if change == 'cursor': options['conflict_after'] += 1
        elif change == 'scope': options['library'] = None
        elif change == 'resume': options['resume'] = True
        elif change == 'digest': options['previous_review_sha256'] = '0' * 64
        elif change == 'file': payload = payload.replace(b'Synthetic', b'Changed', 1)
        elif change == 'native':
            db.tastes[21]['rating'] = 3
            db.project_native(21)
        else: db.revision += 1
        before = personal_snapshot(db)
        if change in ('cursor', 'scope', 'resume', 'digest'):
            with pytest.raises(p.SourceStale):
                begin_review(handle, payload, **options)
            assert handle.owner.last_review is first
        else:
            begin_review(handle, payload, **options)
            result = settled_review(handle, first)
            assert result.phase == 'needs_review' and result.error == 'stale_import'
        assert personal_snapshot(db) == before and not db.personal_frames


def test_cancelling_settled_review_removes_personal_and_continuation_authority(monkeypatch):
    db = install(monkeypatch)
    payload = matched_payload(db, 20)
    with running(monkeypatch, db=db) as (db, handle, catalog):
        ready = reviewed(handle, payload, library=7)
        result = handle.current_review_progress(context=requested_context(7),
            constraints=PolicyEvaluationConstraints(), source_ref=SOURCE, job_ref=JOB, cancel=True)
        assert result.phase == 'cancelled_review' and result.result is None
        assert handle.owner.last_review is result
        with pytest.raises(p.SourceStale):
            begin_action(handle, ready)
        with pytest.raises(p.SourceStale):
            begin_review(handle, payload, library=7, conflict_after=ready.result.proposed.conflict_next,
                previous_review_sha256=review_sha(ready))
        assert not db.personal_frames and not db.job_rows


@pytest.mark.parametrize('boundary', ['before_publish', 'after_return_before_settlement'])
def test_late_review_cancel_cannot_restore_a_ready_actionable_cache(monkeypatch, boundary):
    from threading import Event
    from tests.py.foobar_account_review_testing import review
    db = install(monkeypatch)
    seed(db)
    entered, release = Event(), Event()
    if boundary == 'before_publish':
        original = review._publish
        def observed(owner, operation, phase, **kwargs):
            if phase == 'review_ready':
                entered.set()
                assert release.wait(5.0)
            return original(owner, operation, phase, **kwargs)
        monkeypatch.setattr(review, '_publish', observed)
    else:
        original = review.run_foobar_review
        def observed(owner, operation):
            value = original(owner, operation)
            if value.phase == 'review_ready':
                entered.set()
                assert release.wait(5.0)
            return value
        monkeypatch.setattr(review, 'run_foobar_review', observed)
    with running(monkeypatch, db=db, release=release) as (db, handle, catalog):
        before = personal_snapshot(db)
        begin_review(handle, PAYLOAD, library=7)
        assert entered.wait(3.0)
        operation = handle.owner.current
        current = handle.current_review_progress(context=requested_context(7),
            constraints=PolicyEvaluationConstraints(), source_ref=SOURCE, job_ref=JOB, cancel=True)
        assert operation.job_cancel.is_set() and handle.owner.current is operation
        assert current.phase == 'cancelled_review' and current.result is None
        release.set()
        final = settled_review(handle)
        assert final.phase == 'cancelled_review' and final.result is None
        assert handle.owner.last_review is final
        assert personal_snapshot(db) == before and not db.personal_frames and not db.job_rows


def test_review_admission_charges_conflict_scan_and_cache_before_allocating_or_consuming(monkeypatch):
    from tests.py.foobar_account_review_testing import review, jobs
    db = install(monkeypatch)
    seed(db)
    with running(monkeypatch, db=db) as (db, handle, catalog):
        progress = reviewed(handle, PAYLOAD, library=7)
        owner, original_limits = handle.owner, handle.owner.limits
        charge = s.known_prepare_data_charge(original_limits, len(PAYLOAD))
        explicit = (charge.total + 2 * jobs.JOB_PHASE_BYTES + review.REVIEW_HOLD_BYTES
            + p.CONFLICT_REVIEW_BYTES + p.PROBLEM_CONTROL_BYTES + review.DETAIL_HOLD_BYTES)
        simultaneous = (original_limits.intake_bytes + p.MAX_PRIVATE_BYTES + s.HISTORY_SCHEMA_PHASE_BYTES
            + 2 * jobs.JOB_PHASE_BYTES + review.REVIEW_HOLD_BYTES
            + p.CONFLICT_REVIEW_BYTES + p.PROBLEM_CONTROL_BYTES + review.DETAIL_HOLD_BYTES)
        threshold = max(explicit, simultaneous)
        before, ticket_number = personal_snapshot(db), owner.next_ticket
        owner.limits = replace(original_limits, total_logical_bytes=threshold - 1)
        with pytest.raises(p.SourceUnavailable):
            begin_review(handle, PAYLOAD, library=7)
        assert personal_snapshot(db) == before and owner.last_review is progress
        assert owner.current is None and owner.next_ticket == ticket_number
        owner.limits = replace(original_limits, total_logical_bytes=threshold)
        ticket = begin_review(handle, PAYLOAD, library=7)
        # The genuine worker may already be running; abandon and wait instead
        # of replacing an unresolved operation or treating cancel as rollback.
        handle.abandon(ticket)
        with owner.condition:
            assert owner.condition.wait_for(lambda: owner.current is None, timeout=5.0)
        owner.limits = original_limits
        assert personal_snapshot(db) == before and not db.personal_frames


def test_personal_admission_failure_does_not_consume_review_or_allocate_ticket(monkeypatch):
    from tests.py.foobar_account_review_testing import review
    db = install(monkeypatch)
    seed(db)
    with running(monkeypatch, db=db) as (db, handle, catalog):
        progress = reviewed(handle, PAYLOAD, library=7)
        owner, original_limits = handle.owner, handle.owner.limits
        threshold = (original_limits.intake_bytes + p.MAX_PRIVATE_BYTES
            + p.CONFLICT_REVIEW_BYTES + p.PROBLEM_CONTROL_BYTES + review.DETAIL_HOLD_BYTES + review.REVIEW_HOLD_BYTES)
        owner.limits = replace(original_limits, total_logical_bytes=threshold - 1)
        next_ticket, before = owner.next_ticket, personal_snapshot(db)
        with pytest.raises(p.SourceUnavailable):
            begin_action(handle, progress)
        assert owner.last_review is progress and owner.current is None
        assert owner.next_ticket == next_ticket and personal_snapshot(db) == before
        owner.limits = original_limits
