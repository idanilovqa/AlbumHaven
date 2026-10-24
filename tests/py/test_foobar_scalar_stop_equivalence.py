"""Differential execution of genuine baseline and successor owners, synthetic SQL only."""
from pathlib import Path
from time import monotonic
import json
import pytest
from tests.py.foobar_account_review_testing import (
    running, reviewed, begin_review, settled_review, payload_rows, PAYLOAD, p,
    snapshot,
)

SUCCESSOR = p._collect_sources
namespace = dict(vars(p))
exec(compile(Path(__file__).with_name('foobar_scalar_stop_baseline.txt').read_text(),
             'frozen_baseline_collect_sources', 'exec'), namespace)
BASELINE = namespace['_collect_sources']


def exercise(monkeypatch, implementation, payload, library, *, failure=False, protected=False, ambiguous=False, late_failure=False):
    with monkeypatch.context() as patch:
        patch.setattr(p, '_collect_sources', implementation)
        with running(patch) as (db, handle, _):
            if protected:
                db.tastes[21].update(rating=2, rating_protected=True)
            if ambiguous:
                db.files[22] = db.files[21]
            before = snapshot(db)
            if failure:
                db.fail_sql = p.sizing._MERGED_SIZE_SQL
            if late_failure:
                execute = db.execute
                def fail_discarded_suffix(sql, params=None, **kwargs):
                    if sql == p.sizing._MERGED_SIZE_SQL and json.loads(params[0])[15] == 23:
                        raise OSError('Synthetic ordinal23 source size unavailable')
                    return execute(sql, params, **kwargs)
                patch.setattr(db, 'execute', fail_discarded_suffix)
            started = monotonic()
            begin_review(handle, payload, library=library)
            outcome = settled_review(handle, timeout=30.0)
            seconds = monotonic()-started
            assert snapshot(db) == before
            assert not db.job_rows and not db.source_rows and not db.receipts
            count = db.calls.count(p.sizing._MERGED_SIZE_SQL)
            return outcome, count, seconds


@pytest.mark.parametrize('kind', ['203_rows', '23_rows', 'matched_taste', 'protected_taste', 'ambiguous_target', 'duplicate_source', 'wide_prefix', 'oversized', 'malformed_late', 'merge_failure', 'late_merge_failure'])
def test_genuine_review_equivalence_and_query_count(monkeypatch, record_property, kind):
    payload = PAYLOAD if kind in ('matched_taste', 'protected_taste', 'ambiguous_target') else payload_rows(203 if kind == '203_rows' else 23)
    if kind == 'duplicate_source':
        payload = payload.replace(b'/unknown-1.flac', b'/unknown-0.flac')
    if kind in ('wide_prefix', 'oversized'):
        payload = payload_rows(8, wide=True)
        if kind == 'wide_prefix':
            payload = payload.replace(b'x'*8192, b'x'*2048)
    if kind == 'malformed_late':
        payload += b'bad\textra\n'
    library = 7 if kind in ('matched_taste', 'protected_taste', 'ambiguous_target') else None
    old, old_count, old_seconds = exercise(monkeypatch, BASELINE, payload, library, failure=kind=='merge_failure', protected=kind=='protected_taste', ambiguous=kind=='ambiguous_target', late_failure=kind=='late_merge_failure')
    new, new_count, new_seconds = exercise(monkeypatch, SUCCESSOR, payload, library, failure=kind=='merge_failure', protected=kind=='protected_taste', ambiguous=kind=='ambiguous_target', late_failure=kind=='late_merge_failure')
    assert new.phase == old.phase
    if kind in ('merge_failure', 'late_merge_failure', 'oversized', 'malformed_late'):
        assert old.phase != 'review_ready'
    if old.result is not None:
        # Genuine semantic seals ignore fresh opaque receipt IDs and clock values.
        assert new.result.proposed == old.result.proposed
        assert new.result.inventory_sha256 == old.result.inventory_sha256
        assert new.result.command == old.result.command
    else:
        assert new.result is None
    if kind in ('203_rows', '23_rows'):
        assert old.phase == 'review_ready'
        assert 0 < new_count < old_count
    elif kind == 'late_merge_failure':
        # The rejected suffix is checked in a later rollback-only window.
        # Failure discovery can cost more queries; it still precedes writes.
        assert (old_count, new_count) == (22, 26)
    else:
        assert new_count <= old_count
    metrics = dict(case=kind, baseline_queries=old_count, successor_queries=new_count,
        baseline_seconds=old_seconds, successor_seconds=new_seconds)
    record_property('measurement', json.dumps(metrics))


def test_existing_source_update_and_duplicate_target_are_semantically_identical(monkeypatch, record_property):
    from tests.py.foobar_account_review_testing import confirm, settled, NEXT_JOB
    with running(monkeypatch) as (db, handle, _):
        first = reviewed(handle, PAYLOAD, library=7)
        confirm(handle, first, PAYLOAD)
        assert settled(handle).phase == 'completed'
        # Existing raw/effective source plus duplicate local target decisions.
        lines = PAYLOAD.splitlines(keepends=True)
        update = lines[0] + lines[1].replace(b'\t19', b'\t23') + lines[1].replace(b'\t19', b'\t24')
        before = snapshot(db)
        results = []
        counts = []
        for implementation in (BASELINE, SUCCESSOR):
            monkeypatch.setattr(p, '_collect_sources', implementation)
            start = db.calls.count(p.sizing._MERGED_SIZE_SQL)
            progress = reviewed(handle, update, library=7, job_ref=NEXT_JOB)
            results.append(progress.result.proposed)
            counts.append(db.calls.count(p.sizing._MERGED_SIZE_SQL)-start)
            assert snapshot(db) == before
        assert results[0] == results[1]
        assert counts[1] <= counts[0]
        record_property('sizing_queries', json.dumps(counts))


def test_lower_bound_reservation_is_monotone_and_not_alias_discounted():
    from music_app.services.foobar_account_import_apply import _scalar_counter_phase_bytes
    from music_app.services import foobar_account_prepared_envelope as envelope
    assert p.MAX_PRIVATE_BYTES == 4194304
    for step in (1, 128, 2048, 8192):
        previous = 0
        for count in range(1, 101):
            lower_bytes = count*step
            assert lower_bytes <= envelope.MAX_BYTES
            value = _scalar_counter_phase_bytes(lower_bytes, source_count=count, taste_count=0)
            assert value > previous
            assert value <= _scalar_counter_phase_bytes(lower_bytes+1, source_count=count, taste_count=count)
            previous = value
