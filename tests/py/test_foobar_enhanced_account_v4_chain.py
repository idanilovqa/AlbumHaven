"""Authored, not run: real v4 Prepare/Apply/job owners; controlled drivers only."""
from copy import deepcopy
from dataclasses import replace
from struct import pack
import threading

import pytest
from music_app.services import foobar_enhanced_source_evidence as codec
from music_app.services import foobar_account_import_review as review
from tests.py.foobar_enhanced_account_v4_testing import *


def vector(local=(116444736000000001, 116444736000000001), cached=(116444736000000099,)):
    return pack('<IIIi', 1, len(local), len(cached), 0)+b''.join(pack('<Q', n) for n in local+cached)


def raw_boundary(monkeypatch, count=1):
    boundary = RawBoundary(monkeypatch, count)
    for key in boundary.raw:
        boundary.raw[key] = vector()
    return boundary


def test_real_rollback_preflight_does_not_create_receipt_job_or_projection(monkeypatch):
    db = install(monkeypatch)
    raw = raw_boundary(monkeypatch)
    before = snapshot(db), db.extra_snapshot()
    with raw.open() as upload:
        result = preflight.preflight_indexed_foobar_import(URL, requested_context(None), upload=upload,
            command=seed(db, upload), intake_capacity=CAPACITY, cancel_event=threading.Event())
        assert result.checked_rows == result.total_rows == 1
        assert result.proposed_counts == (0, 1, 0, 0, 0, 0, 0)
        assert result.proposal_sha256 and len(result.window_seals) == 1
        assert db.explicit_rollbacks == 1
        assert (snapshot(db), db.extra_snapshot()) == before
        assert p._INSERT_READY_SQL not in db.calls and f._COMMIT_SQL not in db.calls
    assert raw.connection.closed == 1


def test_noop_retains_exact_raw_provenance_and_all_children_without_dml(monkeypatch):
    db = install(monkeypatch)
    raw = raw_boundary(monkeypatch)
    with raw.open() as upload:
        complete(db, upload)
    old = deepcopy((db.source_rows, db.source_versions, db.entry_headers, db.entry_children))
    old_revision = db.revision
    raw = raw_boundary(monkeypatch)
    raw.artifact = replace(raw.artifact, sha256='c'*64)
    event_start = len(db.entry_events)
    with raw.open() as upload:
        _, _, result = complete(db, upload)
    assert result.confirmed_counts == (1, 0, 0, 0, 0, 0, 0)
    assert db.revision == old_revision
    assert (db.source_rows, db.source_versions, db.entry_headers, db.entry_children) == old
    assert not {sql for sql, _ in db.entry_events[event_start:]} & {entries._INSERT, entries._HEADER, entries._DELETE}
    assert len(db.entry_children) == 2
    assert len({r['raw_filetime_le'] for r in db.entry_children.values()}) == 1
    assert sorted(r['source_ordinal'] for r in db.entry_children.values()) == [0, 1]
    assert not db.bindings and not db.native_calls


@pytest.mark.parametrize('local', [(116444736000000002,), ()])
def test_correction_and_lowered_vector_replace_children_in_same_commit(monkeypatch, local):
    db = install(monkeypatch)
    raw = raw_boundary(monkeypatch)
    with raw.open() as upload:
        complete(db, upload)
    old_revision = db.revision
    raw = raw_boundary(monkeypatch)
    raw.raw[0] = vector(local=local)
    raw.artifact = replace(raw.artifact, sha256='d'*64)
    observations = set(db.source_rows)
    event_start = len(db.entry_events)
    with raw.open() as upload:
        ctx, cmd, batch = start(db, upload)
        prepare(ctx, batch, upload)
        ready = status(ctx, cmd).current_batch
        def before_commit(owner):
            if owner.receipt and owner.receipt['state'] == 'committed':
                assert all(k[3] == old_revision+1 for k in owner.entry_children)
                assert len(owner.entry_children) == len(local)
                assert row(owner, cmd, ready)['state'] == 'confirmed'
        db.before_commit = before_commit
        apply(ctx, ready)
    assert set(db.source_rows) == observations and db.revision == old_revision+1
    assert len(db.entry_children) == len(local)
    assert all(r['local_entry_count'] == len(local) for r in db.entry_headers.values())
    writes = [sql for sql, _ in db.entry_events[event_start:] if sql in
              (entries._INSERT, entries._HEADER, entries._DELETE)]
    assert writes[-2:] == [entries._HEADER, entries._DELETE]
    if local:
        assert writes[0] == entries._INSERT


@pytest.mark.parametrize('failure', [entries._HEADER, entries._DELETE, f._COMMIT_SQL, jobs._CONFIRM_SQL])
def test_projection_or_finalizer_checkpoint_failure_restores_entire_previous_effect(monkeypatch, failure):
    db = install(monkeypatch)
    raw = raw_boundary(monkeypatch)
    with raw.open() as upload:
        complete(db, upload)
    raw = raw_boundary(monkeypatch)
    raw.raw[0] = vector(local=())
    with raw.open() as upload:
        ctx, cmd, batch = start(db, upload)
        prepare(ctx, batch, upload)
        ready = status(ctx, cmd).current_batch
        before = snapshot(db), db.extra_snapshot()
        db.fail_sql = failure
        with pytest.raises(p.source.SourceUnavailable):
            apply(ctx, ready)
        assert (snapshot(db), db.extra_snapshot()) == before


def test_aliases_do_not_merge_distinct_store_keys_and_cached_lane_never_becomes_local(monkeypatch):
    db = install(monkeypatch)
    raw = raw_boundary(monkeypatch, 2)
    raw.aliases = {0: ('same.flac',), 1: ('same.flac',)}
    raw.raw[1] = vector(local=(), cached=(116444736000000001,)*3)
    with raw.open() as upload:
        complete(db, upload)
    assert len(db.source_rows) == 2 and len(db.entry_headers) == 2
    assert len(db.entry_children) == 2
    assert sorted(r['local_entry_count'] for r in db.entry_headers.values()) == [0, 2]
    assert {codec.decode_enhanced_identity(payload(r, 2)) for r in db.source_rows.values()} == {0, 1}
    assert not db.bindings and not db.native_calls


def test_lost_apply_ack_is_reconciled_without_second_effect_or_keys(monkeypatch):
    db = install(monkeypatch)
    raw = raw_boundary(monkeypatch)
    with raw.open() as upload:
        ctx, cmd, batch = start(db, upload)
        prepare(ctx, batch, upload)
        ready = status(ctx, cmd).current_batch
        db.lose_ack = True
        with pytest.raises(p.source.SourceUnavailable):
            apply(ctx, ready)
        durable = snapshot(db), db.extra_snapshot()
        result = reconcile(ctx, cmd, ready)
        assert result.status.disposition == 'completed'
        assert result.status.confirmed_through == 1
        assert (snapshot(db), db.extra_snapshot()) == durable
        assert db.calls.count(f._COMMIT_SQL) == 1 and len(db.keys) == 2


def test_same_artifact_resume_keeps_checkpoint_and_exact_keys(monkeypatch):
    db = install(monkeypatch)
    raw = raw_boundary(monkeypatch, 101)
    with raw.open() as upload:
        ctx, cmd, first = start(db, upload)
        prepare(ctx, first, upload)
        ready = status(ctx, cmd).current_batch
        apply(ctx, ready)
        confirmed = status(ctx, cmd).confirmed_through
        assert 0 < confirmed < 101
        first_keys = set(db.keys)
    # New private reader/index lifetime, same artifact fingerprint/hash/data.
    raw = raw_boundary(monkeypatch, 101)
    with raw.open() as upload:
        current = resume(ctx, cmd)
        batch = claim(ctx, cmd, first.prepare_command.inventory_sha256)
        assert batch.prepare_command.offset == confirmed
        assert batch.prepare_command.upload_sha256 == upload.upload_sha256
        while current.disposition != 'completed':
            prepare(ctx, batch, upload)
            ready = status(ctx, cmd).current_batch
            apply(ctx, ready)
            current = reconcile(ctx, cmd, ready).status
            if current.disposition != 'completed':
                batch = claim(ctx, cmd, first.prepare_command.inventory_sha256)
    assert current.confirmed_through == 101 and len(db.source_rows) == 101
    assert len(db.entry_children) == 202 and db.revision_rows == 101
    assert first_keys <= set(db.keys)
    assert len(db.keys) == 2*len(db.attempts)


@pytest.mark.parametrize('drift', ['session', 'account', 'source'])
def test_apply_revalidates_current_authority_and_source_without_new_effect(monkeypatch, drift):
    db = install(monkeypatch)
    raw = raw_boundary(monkeypatch)
    with raw.open() as upload:
        ctx, cmd, batch = start(db, upload)
        prepare(ctx, batch, upload)
        ready = status(ctx, cmd).current_batch
        if drift == 'session':
            db.sessions[(1, 3)] = False
        elif drift == 'account':
            db.accounts[1] = False
        else:
            db.revision += 1
        before = snapshot(db), db.extra_snapshot()
        with pytest.raises((p.source.SourceUnavailable, p.source.SourceStale)):
            apply(ctx, ready)
        assert (snapshot(db), db.extra_snapshot()) == before
        assert not db.entry_children


def test_cancelled_claim_does_not_apply_or_mint_replacement_job(monkeypatch):
    db = install(monkeypatch)
    raw = raw_boundary(monkeypatch)
    with raw.open() as upload:
        ctx, cmd, batch = start(db, upload)
        cancel(ctx, cmd)
        with pytest.raises((p.source.SourceUnavailable, p.source.SourceStale)):
            prepare(ctx, batch, upload)
    assert not db.entry_children and not db.source_rows and len(db.job_rows) == 1


def test_exact_intent_binds_proposal_mapping_and_artifact(monkeypatch):
    db = install(monkeypatch)
    raw = raw_boundary(monkeypatch)
    with raw.open() as upload:
        ctx, cmd, batch = start(db, upload)
        inventory = batch.prepare_command.inventory_sha256
        first = review.review_intent_sha256(cmd, inventory, False, 'a'*64)
        assert first != review.review_intent_sha256(cmd, inventory, False, 'b'*64)
        assert first != review.review_intent_sha256(replace(cmd, upload_sha256='c'*64), inventory, False, 'a'*64)
        assert first != review.review_intent_sha256(cmd, inventory, True, 'a'*64)
    # Digest contract only. Worker cached-review/confirmation is tested separately.


class MalformedBoundary(RawBoundary):
    def record(self, key):
        from music_app.services import foobar_enhanced_record_decoder as decoder
        from music_app.services import foobar_enhanced_sqlite_reader as reader
        result = decoder.decode_enhanced_playcount_record(self.raw[key], store_guid=decoder.ENHANCED_PLAYCOUNT_STORE_GUID)
        state = 'parsed' if result.status == 'parsed' else result.diagnostics[0].category
        return reader.StoreRecord(reader.StoreIdentity(decoder.ENHANCED_PLAYCOUNT_STORE_GUID, key),
            state, 'mapped', result.record, result.diagnostics)

    def read_raw(self, connection, budget, key, **kwargs):
        budget.check()
        record = self.record(key)
        raw = self.raw[key]
        return record, raw, len(raw), (None if record.data_state == 'parsed'
            else record.diagnostics[0].code), digest(raw)


def test_malformed_incoming_commits_raw_evidence_but_preserves_effective_vector(monkeypatch):
    db = install(monkeypatch)
    raw = raw_boundary(monkeypatch)
    with raw.open() as upload:
        complete(db, upload)
    observation, old = next(iter(db.source_rows.items()))
    old_effective = payload(old, 6)
    old_children = [r['projection_bytes'] for r in db.entry_children.values()]
    raw = MalformedBoundary(monkeypatch, 1)
    raw.raw[0] = b'\x01\x02'
    raw.artifact = replace(raw.artifact, sha256='e'*64)
    with raw.open() as upload:
        _, _, result = complete(db, upload)
    assert result.confirmed_counts == (0, 1, 0, 0, 0, 0, 0)
    assert payload(db.source_rows[observation], 6) == old_effective
    assert codec.decode_enhanced_incoming(payload(db.source_rows[observation], 8)).data_state == 'malformed'
    assert [r['projection_bytes'] for r in db.entry_children.values()] == old_children
    assert all(k[3] == db.revision for k in db.entry_children)


@pytest.mark.parametrize('revision', [8, 98])
def test_global_quota_adjusts_only_one_header_per_changed_row_across_decimal_width(monkeypatch, revision):
    db = install(monkeypatch)
    db.revision = revision
    raw = raw_boundary(monkeypatch, 101)
    with raw.open() as upload:
        command = seed(db, upload)
        before = snapshot(db), db.extra_snapshot()
        windows, offset = [], 0
        while offset < 101:
            window = enhanced_prepare.preflight_indexed_enhanced_window(URL, requested_context(None),
                upload=upload, command=replace(command, offset=offset, request_key=str(uuid4())),
                intake_capacity=CAPACITY)
            assert window.offset == offset and 0 < window.end - offset <= 100
            assert window.proposed_counts == (0, window.end - offset, 0, 0, 0, 0, 0)
            windows.append(window)
            offset = window.end
        covered = [row for window in windows for row in range(window.offset, window.end)]
        assert covered == list(range(101)) and len(set(covered)) == 101
        assert p.MAX_PRIVATE_BYTES == 4 * 1024 * 1024
        assert 0 < windows[0].end < 100  # genuine private-byte-limited prefix
        combined = preflight.preflight_indexed_foobar_import(URL, requested_context(None), upload=upload,
            command=command, intake_capacity=CAPACITY, cancel_event=threading.Event())
        assert [(start, end) for start, end, _ in combined.window_seals] == [
            (window.offset, window.end) for window in windows]
        # Every dry run uses revision+1. Each actual changed window advances
        # once: only one header per source row contains this decimal revision,
        # not either of that row's two retained local-history children.
        header_growth = sum(
            len(str(revision + batch_number)) - len(str(revision + 1))
            for batch_number, window in enumerate(windows, 1)
            for _ in range(window.offset, window.end))
        assert header_growth > 0  # both 9->10 and 99->100 boundaries are exercised
        assert combined.proposed_changed_batches == combined.planned_batches == len(windows)
        assert combined.proposed_quota_additions[:2] == (101, 101)
        assert combined.proposed_quota_additions[2] == (
            sum(window.quota_additions[2] for window in windows) + header_growth)
        assert (snapshot(db), db.extra_snapshot()) == before
        assert not db.source_rows and db.revision == revision
        _, _, completed = complete(db, upload)
    actual = db.dispatch(p._CAPACITY_SQL, (json.dumps([1, None, SOURCE, db.revision]).encode(),))[0]
    assert actual['source_bytes'] == combined.proposed_quota_additions[2]
    assert completed.confirmed_through == 101 and completed.confirmed_counts == (0, 101, 0, 0, 0, 0, 0)
    assert db.revision == revision + len(windows)
    assert len(db.source_rows) == len(db.entry_headers) == 101
    assert len(db.entry_children) == 202
    for batch_number, window in enumerate(windows, 1):
        assert sum(header['source_revision'] == revision + batch_number
            for header in db.entry_headers.values()) == window.end - window.offset
    assert all(header['local_entry_count'] == 2 for header in db.entry_headers.values())
    attempts = sorted(db.attempts.values(), key=lambda attempt: attempt['batch_no'])
    assert len(attempts) == len(db.receipts) == len(windows)
    assert all(attempt['state'] == 'confirmed' and attempt['attempt_no'] == 1 for attempt in attempts)
    keys = [attempt[field] for attempt in attempts for field in ('prepare_key', 'apply_key')]
    assert len(keys) == len(set(keys)) == len(db.keys) == 2 * len(windows)
    assert set(keys) == set(db.keys)
    terminals = [json.loads(attempt['terminal_bytes']) for attempt in attempts]
    assert [(terminal[14] - 1, terminal[15] - 1) for terminal in terminals] == [
        (window.offset, window.end) for window in windows]
    assert db.calls.count(p._INSERT_READY_SQL) == db.calls.count(f._COMMIT_SQL) == len(windows)



def test_net_fit_replacement_is_rejected_when_ordered_intermediate_peak_does_not_fit(monkeypatch):
    db = install(monkeypatch)
    raw = raw_boundary(monkeypatch)
    raw.raw[0] = vector(local=(116444736000000001,)*128)
    with raw.open() as upload:
        complete(db, upload)
    raw = raw_boundary(monkeypatch)
    raw.raw[0] = vector(local=(116444736000000002,))
    raw.artifact = replace(raw.artifact, sha256='f'*64)
    with raw.open() as upload:
        command = seed(db, upload)
        proposed = enhanced_prepare.preflight_indexed_enhanced_window(URL, requested_context(None),
            upload=upload, command=command, intake_capacity=CAPACITY)
        assert proposed.source_bytes_peak_addition > max(0, proposed.quota_additions[2])
        # There is exactly enough room for the final postimage, but not the new
        # raw revision plus replacement children before old children are removed.
        db.override_source_bytes = 268435456-max(0, proposed.quota_additions[2])
        before = snapshot(db), db.extra_snapshot()
        with pytest.raises(p.source.FoobarSourceCapacityExceeded):
            enhanced_prepare.preflight_indexed_enhanced_window(URL, requested_context(None),
                upload=upload, command=command, intake_capacity=CAPACITY)
        assert (snapshot(db), db.extra_snapshot()) == before


def test_resume_prepare_requires_same_artifact_and_keeps_original_attempt_keys(monkeypatch):
    db = install(monkeypatch)
    raw = raw_boundary(monkeypatch)
    with raw.open() as upload:
        ctx, cmd, batch = start(db, upload)
    before = snapshot(db), db.extra_snapshot()
    raw = raw_boundary(monkeypatch)
    raw.artifact = replace(raw.artifact, sha256='9'*64)
    with raw.open() as upload:
        with pytest.raises(p.source.SourceUnavailable):
            prepare(ctx, batch, upload)
    assert (snapshot(db), db.extra_snapshot()) == before
    assert len(db.attempts) == 1 and not db.keys and not db.source_rows


def test_actual_committed_child_bytes_are_read_back_by_genuine_account_only_consumer(monkeypatch):
    db = install(monkeypatch)
    raw = raw_boundary(monkeypatch)
    with raw.open() as upload:
        ctx, cmd, completed = complete(db, upload)
    assert len(db.entry_headers) == 1 and len(db.entry_children) == 2
    scope, header = next(iter(db.entry_headers.items()))
    source = db.source_rows[scope[2]]
    # Exact driver projection of already committed columns, not reconstructed
    # codec values or a manufactured history DTO. Prescribe this known SQL page.
    expected_rows = []
    for key, child in sorted(db.entry_children.items(), reverse=True):
        assert key[:3] == scope and key[3] == header['source_revision']
        expected_rows.append(dict(observation_ref=scope[2], source_revision=key[3],
            ordinal=child['source_ordinal'], sort_key=child['sort_key'],
            raw_filetime_le=child['raw_filetime_le'], resolved=child['resolved'],
            entry_bytes=child['projection_bytes'], entry_sha256=child['projection_sha256'],
            evidence_kind=header['evidence_kind'], header_revision=header['source_revision'],
            header_bytes=header['projection_bytes'], header_sha256=header['projection_sha256'],
            effective_sha256=header['effective_sha256'], display_sha256=header['display_sha256'],
            local_entry_count=header['local_entry_count'], local_vector_sha256=header['local_vector_sha256'],
            current_revision=db.source_versions[scope[2]],
            current_effective_sha256=digest(payload(source, 6)), current_display_sha256=digest(payload(source, 7))))
    db.readback_rows = expected_rows
    before = snapshot(db), db.extra_snapshot()
    page = history_reader.read_enhanced_history(URL, ctx,
        history_reader.EnhancedHistoryRequest(SOURCE, 'entries'))
    assert page.source_revision == completed.source_revision
    assert [item.entry.ordinal for item in page.items] == [1, 0]
    assert {item.entry.raw_filetime_ticks for item in page.items} == {'116444736000000001'}
    assert {item.observation_ref for item in page.items} == {scope[2]}
    assert db.readback_rows is None and not db.native_calls
    assert (snapshot(db), db.extra_snapshot()) == before
