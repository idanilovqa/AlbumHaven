"""Saved shared-phase acceptance over the unchanged real PostgreSQL fixture.

Actual ready rows are created only by the admitted <=4-item SQL helpers and
real descriptor acquisition/Pillow sanitization. Observation wrappers retain
real SQL/transactions. The explicitly named adversarial projection tests alter
one collaborator result, never immutable proof storage or the existing fixture.

Source authored only: no execution, SQL acceptance, latency, lock-duration or
RSS result is implied. In particular the 5000-ready setup (1250 real batches),
5000-row four-phase case, concurrent gate/lock cases and deadline waits are
expensive acceptance cases awaiting the root executor. POSIX marks are limited
to cases that require actual capture/resolution; staging/SQL cases run on all
hosts supported by the admitted database fixture.

The 5000-ready setup must finish within the real original 60-minute lifetime.
It never renews the key/generation or extends expiry to accommodate a slow host;
an expired setup is a real acceptance limitation, not permission to forge one.
"""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from copy import copy, deepcopy
from dataclasses import asdict
from datetime import timedelta
import json
import os
from threading import Event
from time import monotonic, sleep
from uuid import uuid4

import psycopg
import pytest

from music_app.services import album_top_artwork_preparation as preparation
from music_app.services import album_top_artwork_draft as shared
from music_app.services import _top_artwork_draft_proof as proof
from music_app.services import artwork_proof_codec as codec
from music_app.services import public_top_artwork_acquisition as acquisition
from music_app.services.album_top_artwork_preparation import TopArtworkPreparationService
from music_app.services.owned_album_tops import ACCESS, AlbumTopError
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.test_owned_album_tops_postgres import db, urls, assert_error
from tests.py.test_album_top_artwork_preparation_postgres import (
    artwork, CONTEXT, png_file,
)
from tests.py.test_top_artwork_draft_preparation_postgres import (
    draft_case, command as draft_command, start as start_draft,
)
from tests.py.test_top_artwork_draft_capture_postgres import advance_draft


requires_posix_artwork = pytest.mark.skipif(
    os.name != 'posix', reason='Requires genuine POSIX descriptor capture or bounded root observation')
STATUS_PREFIX = 'select i.item_ref,i.catalog_ref,i.position,i.included,i.status,i.error_code'


def forbidden(*args, **kwargs):
    raise AssertionError('This operation must not reach image, resolver or codec work')


def header(case, status):
    with case.db.connect() as connection:
        return connection.execute(
            'select * from app.album_top_artwork_preparations where ref=%s',
            (status['preparation_ref'],)).fetchone()


def refresh_revision(case, status):
    return {**status, 'preparation_revision': str(header(case, status)['revision'])}


def genuine_ready(case, *, batches=None):
    """Populate real saved legacy proofs without manufacturing ready storage.

    Direct helper setup is intentionally distinct from the service phase tests.
    Every claim is <=4 and every PNG/proof is produced by ArtworkCase.results.
    """
    status = case.start()
    count = (len(case.items) + 3) // 4 if batches is None else batches
    for _ in range(count):
        key, lease, chosen = case.claim(status)
        assert 1 <= len(chosen) <= 4
        results, pngs = case.results(chosen)
        case.complete(status, key, lease, results, pngs)
        status = refresh_revision(case, status)
    return case.read(status)


def fail_one_batch(case, status):
    """Portable SQL failure completion, with no simulated successful capture."""
    key, lease, chosen = case.claim(status)
    case.complete(status, key, lease,
        [{'item_ref': str(ref), 'status': 'failed', 'error_code': 'artwork_unavailable'}
         for ref in chosen], [None] * len(chosen))
    return refresh_revision(case, status)


def set_cover(case, number, value):
    with case.db.connect() as connection:
        connection.execute('update library.local_albums set cover_path=%s where library_id=%s and id=%s',
                           (value, case.db.library, case.album_ids[number]))


def stored_proof_text(case, status):
    with case.db.connect() as connection:
        return connection.execute('''select item_ref,source_stamp::text as source_text,
            acquisition_stamp::text as acquisition_text,asset_ref from app.album_top_artwork_preparation_items
            where preparation_ref=%s and status='ready' order by position''',
            (status['preparation_ref'],)).fetchall()


class OwnerTrace:
    """Observe real authority connections and fetched rows without replacing them."""
    def __init__(self, case, monkeypatch, *, executed=None, fetched=None):
        self.active = []
        self.phases = []
        self.events = []
        connect = case.db.service._connect
        trace = self

        class Cursor:
            def __init__(self, real, sql, params, phase):
                self.real, self.sql, self.params, self.phase = real, sql, params, phase

            def __getattr__(self, name):
                return getattr(self.real, name)

            def fetchall(self):
                rows = self.real.fetchall()
                if fetched is not None:
                    fetched(self.sql, self.params, rows, self.phase)
                return rows

            def fetchone(self):
                row = self.real.fetchone()
                if fetched is not None:
                    fetched(self.sql, self.params, [] if row is None else [row], self.phase)
                return row

        class Connection:
            def __init__(self, real, phase):
                self.real, self.phase = real, phase

            def __getattr__(self, name):
                return getattr(self.real, name)

            def execute(self, sql, params=None):
                normalized = ' '.join(str(sql).lower().split())
                result = self.real.execute(sql, params)
                trace.phases[self.phase].append((normalized, params))
                if executed is not None:
                    executed(normalized, params, self.phase)
                return Cursor(result, normalized, params, self.phase)

        @contextmanager
        def observed(*args, **kwargs):
            assert not trace.active, 'An authority connection was nested inside another phase'
            phase = len(trace.phases)
            trace.phases.append([])
            with connect(*args, **kwargs) as real:
                trace.active.append(real)
                trace.events.append(('enter', phase))
                try:
                    yield Connection(real, phase)
                finally:
                    trace.active.pop()
                    trace.events.append(('exit', phase))
            trace.events.append(('committed', phase))

        monkeypatch.setattr(case.db.service, '_connect', observed)

    def outside(self, label):
        assert not self.active, label + ' ran with an authority connection open'
        assert self.events and self.events[-1][0] in ('committed', 'probe', 'capture', 'read', 'sanitize')
        self.events.append((label, len(self.phases)))

    @property
    def statements(self):
        return [sql for phase in self.phases for sql, _ in phase]


def snapshot_categories(phase):
    statements = [sql for sql, _ in phase]
    return {
        'manifest': sum('from app.album_top_artwork_preparation_items i' in sql
            and 'selected_local_album_id' in sql and 'limit 101' in sql for sql in statements),
        'source': sum(sql.startswith('with wanted as') for sql in statements),
        'locks': sum(sql.startswith('select id from library.local_albums') for sql in statements),
        'proof': sum(sql.startswith('select item_ref as row_ref,position,') for sql in statements),
        'inventory': sum(sql.startswith('select id, case when octet_length(root_path)') for sql in statements),
        'status': sum(sql.startswith(STATUS_PREFIX) for sql in statements),
    }


def assert_page_ledger(phase, count, ready, *, inventory, status, maximum):
    pages, proofs = (count + 99) // 100, (ready + 99) // 100
    assert snapshot_categories(phase) == {
        'manifest': pages, 'source': pages, 'locks': pages,
        'proof': proofs, 'inventory': int(inventory), 'status': int(status),
    }
    assert len(phase) <= maximum
    assert not any(sql.startswith('select cover_path') or sql.startswith('select s.ref,s.library_id')
                   for sql, _ in phase)
    locked = [params[1] for sql, params in phase if sql.startswith('select id from library.local_albums')]
    assert all(0 < len(ids) <= 100 and ids == sorted(set(ids)) for ids in locked)
    flattened = [value for ids in locked for value in ids]
    assert flattened == sorted(set(flattened))


def trap_image_work(case, monkeypatch):
    for name in ('capture', 'describe', 'resolver', '_draft_probe'):
        monkeypatch.setattr(case.service, name, forbidden)
    monkeypatch.setattr(preparation, 'resolve_typed_artwork_observations', forbidden)
    monkeypatch.setattr(codec, 'prepare_inventory_binding', forbidden)
    monkeypatch.setattr(codec, 'validate_pair', forbidden)
    monkeypatch.setattr(proof, 'saved_ready_binding', forbidden)


@pytest.mark.parametrize('state', ['pending', 'failed', 'excluded'])
@pytest.mark.parametrize('cover', [None, '', 'x' * 16385, '\u00e9' * 8193])
def test_staging_start_replay_and_read_have_no_artwork_requirements_on_any_host(
        artwork, monkeypatch, state, cover):
    case = artwork.build(2, excluded=range(2) if state == 'excluded' else ())
    for index in range(2):
        set_cover(case, index, cover)
    trap_image_work(case, monkeypatch)

    def fetched(sql, params, rows, phase):
        if sql.startswith('with wanted as'):
            assert all(row['cover_path'] is None for row in rows)
        if 'as current_cover_valid' in sql:
            assert all(row['current_cover_valid'] is None and row['current_cover_path'] is None
                       for row in rows)

    trace = OwnerTrace(case, monkeypatch, fetched=fetched)
    status = case.start()
    assert len(trace.phases) == 1
    assert_page_ledger(trace.phases[0], 2, 0, inventory=False, status=True, maximum=21)
    if state == 'failed':
        status = fail_one_batch(case, status)
    retained = case.snapshot()
    trace.phases.clear()
    replay = case.start()
    assert replay['ready_count'] == 0
    assert replay['failed_count'] == (2 if state == 'failed' else 0)
    assert len(trace.phases) == 1
    assert_page_ledger(trace.phases[0], 2, 0, inventory=False, status=True, maximum=21)
    trace.phases.clear()
    assert case.read(replay) == replay
    assert len(trace.phases) == 1
    assert_page_ledger(trace.phases[0], 2, 0, inventory=False, status=True, maximum=20)
    assert case.snapshot() == retained


@pytest.mark.parametrize('count', [0, 1, 100, 101, 5000])
def test_saved_no_image_start_read_advance_fixed_sql_pages_on_all_hosts(
        artwork, monkeypatch, count, record_property):
    case = artwork.build(count, excluded=range(count))
    trap_image_work(case, monkeypatch)
    trace = OwnerTrace(case, monkeypatch)
    pages = (count + 99) // 100
    started = case.start()
    assert len(trace.phases) == 1
    assert_page_ledger(trace.phases[0], count, 0, inventory=False, status=True, maximum=18 + 3 * pages)
    record_property('saved_no_image_start_sql_count', len(trace.statements))
    trace.phases.clear()
    result = case.read(started, after=5000, limit=1)
    assert result['items'] == [] and result['included_count'] == 0
    assert len(trace.phases) == 1
    assert_page_ledger(trace.phases[0], count, 0, inventory=False, status=True, maximum=17 + 3 * pages)
    trace.phases.clear()
    gate = preparation._DECODE_REQUESTS
    assert gate.acquire(blocking=False)
    try:
        assert gate.acquire(blocking=False)
        try:
            result = case.advance(started)
        finally:
            gate.release()
    finally:
        gate.release()
    assert result['state'] == 'ready' and result['included_count'] == 0
    assert len(trace.phases) == 1
    assert_page_ledger(trace.phases[0], count, 0, inventory=False, status=True, maximum=19 + 3 * pages)


@requires_posix_artwork
def test_saved_image_phases_keep_real_resolver_reads_and_sanitizer_outside_authority(artwork, monkeypatch):
    case = artwork.build(2)
    started = case.start()
    trace = OwnerTrace(case, monkeypatch)
    actual_probe = case.service._draft_probe
    actual_resolver = preparation.resolve_typed_artwork_observations
    actual_capture = case.service.capture
    actual_read = acquisition._read_bounded
    actual_sanitize = acquisition.sanitize_artwork_pixels
    monkeypatch.setattr(case.service, 'describe', forbidden)
    monkeypatch.setattr(case.service, 'resolver', forbidden)

    def probe(snapshot):
        trace.outside('probe')
        return actual_probe(snapshot)

    def resolver(request):
        assert not trace.active
        return actual_resolver(request)

    def capture(source):
        trace.outside('capture')
        return actual_capture(source)

    def read(fd):
        trace.outside('read')
        return actual_read(fd)

    def sanitize(*args, **kwargs):
        trace.outside('sanitize')
        return actual_sanitize(*args, **kwargs)

    monkeypatch.setattr(case.service, '_draft_probe', probe)
    monkeypatch.setattr(preparation, 'resolve_typed_artwork_observations', resolver)
    monkeypatch.setattr(case.service, 'capture', capture)
    monkeypatch.setattr(acquisition, '_read_bounded', read)
    monkeypatch.setattr(acquisition, 'sanitize_artwork_pixels', sanitize)
    ready = case.advance(started)
    assert ready['ready_count'] == 2 and len(trace.phases) == 4
    assert [event for event in trace.events if event[0] in ('probe', 'capture')] == [
        ('probe', 1), ('capture', 2), ('capture', 2), ('probe', 3)]
    assert sum(label == 'read' for label, _ in trace.events) == 2
    assert sum(label == 'sanitize' for label, _ in trace.events) == 2
    assert sum(sql.startswith(STATUS_PREFIX) for sql in trace.statements) == 1
    monkeypatch.setattr(case.service, 'capture', forbidden)
    for invoke in (lambda: case.read(ready, limit=1), case.start):
        trace.phases.clear()
        trace.events.clear()
        assert invoke()['ready_count'] == 2
        assert len(trace.phases) == 2
        assert [event for event in trace.events if event[0] == 'probe'] == [('probe', 1)]
        assert sum(sql.startswith(STATUS_PREFIX) for sql in trace.statements) == 1


@pytest.mark.parametrize('partial', [False, True])
@requires_posix_artwork
def test_ready_start_replay_rejects_off_first_page_current_cover_before_probe(
        artwork, monkeypatch, partial):
    case = artwork.build(105 if partial else 101, same_pixels=True)
    ready = genuine_ready(case, batches=26 if partial else None)
    assert ready['ready_count'] == (104 if partial else 101)
    assert len(ready['items']) == 100
    retained = case.snapshot()
    proofs = stored_proof_text(case, ready)
    replacement = png_file(case.artwork_path / 'new-off-page-choice.png', 93)
    set_cover(case, 100, str(replacement))
    monkeypatch.setattr(case.service, '_draft_probe', forbidden)
    monkeypatch.setattr(case.service, 'capture', forbidden)
    trace = OwnerTrace(case, monkeypatch)
    for _ in range(2):
        assert_error(case.start, 'artwork_source_changed', 409)
        assert case.snapshot() == retained
        assert stored_proof_text(case, ready) == proofs
    assert sum(sql.startswith('select app.start_top_artwork_preparation') for sql in trace.statements) == 2
    assert not any(sql.startswith(STATUS_PREFIX) for sql in trace.statements)
    assert not any('cancel_top_artwork' in sql or 'cleanup_top_artwork' in sql for sql in trace.statements)


@pytest.mark.parametrize('cover,valid', [
    (None, False), ('', False), ('x' * 16385, False), ('\u00e9' * 8193, False),
    ('x' * 16384, True), ('\u00e9' * 8192, True),
])
@requires_posix_artwork
def test_d1_ready_cover_projection_sql_bounds_utf8_before_driver_retention(
        artwork, monkeypatch, cover, valid):
    case = artwork.build(1)
    ready = genuine_ready(case)
    before = case.snapshot()
    set_cover(case, 0, cover)
    seen = []

    def fetched(sql, params, rows, phase):
        if 'as current_cover_valid' in sql:
            assert len(rows) == 1
            seen.append(rows[0]['current_cover_valid'])
            assert rows[0]['current_cover_valid'] is valid
            assert rows[0]['current_cover_path'] == (cover if valid else None)
            if valid:
                assert len(rows[0]['current_cover_path'].encode('utf-8')) == 16384

    OwnerTrace(case, monkeypatch, fetched=fetched)
    monkeypatch.setattr(case.service, '_draft_probe', forbidden)
    monkeypatch.setattr(case.service, 'capture', forbidden)
    # Exact-boundary text is SQL-eligible, but is still a changed historical
    # selection. This does not claim a 16KiB native filesystem path is supported.
    assert_error(case.start, 'artwork_source_changed', 409)
    assert seen == [valid] and case.snapshot() == before


@requires_posix_artwork
def test_adversarial_legacy_proof_projection_cannot_supply_current_cover(artwork, monkeypatch):
    case = artwork.build(3)
    ready = genuine_ready(case)
    before = case.snapshot()
    actual = proof.saved_ready_binding
    changed = []

    def mismatching_historical_source(source, acquired, **identity):
        # Adversarial collaborator case: the fetched genuine source is copied;
        # immutable database proof bytes and the current local cover stay intact.
        altered = deepcopy(codec.source_object(source))
        altered['stored_cover_path'] = 'otherwise-shaped-historical-choice.png'
        codec.validate_pair(altered, acquired)
        changed.append(identity['stored_cover_path'])
        return actual(altered, acquired, **identity)

    monkeypatch.setattr(proof, 'saved_ready_binding', mismatching_historical_source)
    monkeypatch.setattr(case.service, '_draft_probe', forbidden)
    monkeypatch.setattr(case.service, 'capture', forbidden)
    assert_error(case.start, 'artwork_source_changed', 409)
    assert changed == [str(case.cover_paths[0])] and case.snapshot() == before


@pytest.mark.parametrize('operation', ['read', 'empty_read', 'start_replay'])
@requires_posix_artwork
def test_complete_ready_proof_vector_rejects_off_page_adversarial_projection(
        artwork, monkeypatch, operation):
    case = artwork.build(101 if operation == 'start_replay' else 3, same_pixels=True)
    ready = genuine_ready(case)
    before = case.snapshot()
    actual = proof.saved_ready_binding
    seen = []

    def corrupted_tail(source, acquired, **identity):
        seen.append(identity['local_album_id'])
        if identity['local_album_id'] == case.album_ids[-1]:
            # Explicit fetched-proof fault, not direct mutation of trusted storage.
            source = deepcopy(codec.source_object(source))
            source['library_id'] = case.db.library + 1
        return actual(source, acquired, **identity)

    monkeypatch.setattr(proof, 'saved_ready_binding', corrupted_tail)
    monkeypatch.setattr(case.service, '_draft_probe', forbidden)
    monkeypatch.setattr(case.service, 'capture', forbidden)
    invoke = case.start if operation == 'start_replay' else lambda: case.read(
        ready, after=5000 if operation == 'empty_read' else 0, limit=1)
    assert_error(invoke, 'artwork_source_changed', 409)
    assert seen == case.album_ids and case.snapshot() == before


@pytest.mark.parametrize('partial', [False, True])
@requires_posix_artwork
def test_d1_start_gap_change_off_page_rejects_without_status_and_recovers_original_key(
        artwork, monkeypatch, partial):
    case = artwork.build(105 if partial else 101, same_pixels=True)
    ready = genuine_ready(case, batches=26 if partial else None)
    before = case.snapshot()
    original_header = dict(header(case, ready))
    original_payload = deepcopy(case.payload)
    actual_probe = case.service._draft_probe
    alternate = png_file(case.artwork_path / 'gap-off-page.png', 94)
    trace = OwnerTrace(case, monkeypatch)
    observations = []

    def observe_then_change(snapshot):
        assert not trace.active and len(trace.phases) == 1
        observed = actual_probe(snapshot)
        observations.append(tuple(observed))
        set_cover(case, 100, str(alternate))
        return observed

    monkeypatch.setattr(case.service, '_draft_probe', observe_then_change)
    monkeypatch.setattr(case.service, 'capture', forbidden)
    assert_error(case.start, 'artwork_source_changed', 409)
    assert len(observations) == 1 and case.items[100]['item_ref'] in observations[0]
    assert len(trace.phases) == 2
    assert ('committed', 0) in trace.events
    assert not any(sql.startswith(STATUS_PREFIX) for sql in trace.statements)
    assert case.snapshot() == before and dict(header(case, ready)) == original_header
    assert case.payload == original_payload
    # The first real helper transaction committed. Failed acknowledgement does
    # not cancel staging, reserve again, recapture or extend its original expiry.
    monkeypatch.setattr(case.service, '_draft_probe', forbidden)
    assert_error(case.start, 'artwork_source_changed', 409)
    assert case.snapshot() == before
    set_cover(case, 100, str(case.cover_paths[100]))
    monkeypatch.setattr(case.service, '_draft_probe', actual_probe)
    assert case.start() == ready
    assert case.snapshot() == before and dict(header(case, ready)) == original_header


@pytest.mark.parametrize('failure', ['probe', 'fresh_source', 'final_policy'])
@requires_posix_artwork
def test_post_commit_ready_start_ack_failure_retains_exact_request_for_retry(
        artwork, monkeypatch, failure):
    case = artwork.build(2)
    ready = genuine_ready(case)
    retained = case.snapshot()
    original_payload = deepcopy(case.payload)
    actual_probe = case.service._draft_probe
    deny = [False]

    def probe_then_fail(snapshot):
        assert not trace.active and ('committed', 0) in trace.events
        observed = actual_probe(snapshot)
        if failure == 'probe':
            raise AlbumTopError('artwork_probe_unavailable', 409)
        if failure == 'fresh_source':
            with case.db.connect() as connection:
                connection.execute("update library.album_metadata_sources set state='invalid' where ref=%s",
                                   (case.source_refs[-1],))
        return observed

    def executed(sql, params, phase):
        if sql.startswith(STATUS_PREFIX):
            deny[0] = True

    # Only the final-policy case changes authorization after response SQL.
    trace = OwnerTrace(case, monkeypatch,
                       executed=executed if failure == 'final_policy' else None)

    def constraints(context):
        return PolicyEvaluationConstraints(request_origin_allowed=not (
            deny[0] and context.action == ACCESS))

    monkeypatch.setattr(case.service, '_draft_probe', probe_then_fail)
    monkeypatch.setattr(case.service, 'capture', forbidden)
    expected = {'probe': ('artwork_probe_unavailable', 409),
                'fresh_source': ('evidence_unavailable', 409),
                'final_policy': ('forbidden', 403)}[failure]
    assert_error(lambda: case.start(constraints=constraints), *expected)
    assert ('committed', 0) in trace.events
    assert case.snapshot() == retained and case.payload == original_payload
    if failure == 'fresh_source':
        with case.db.connect() as connection:
            connection.execute("update library.album_metadata_sources set state='active' where ref=%s",
                               (case.source_refs[-1],))
    deny[0] = False
    monkeypatch.setattr(case.service, '_draft_probe', actual_probe)
    # Use ordinary current policy for recovery; the fault callback only governs
    # the failed invocation. Exact key/body/generation are unchanged.
    assert case.start() == ready and case.snapshot() == retained


def test_unknown_start_commit_ack_retries_same_key_without_second_reservation(artwork, monkeypatch):
    case = artwork.build(2)
    trap_image_work(case, monkeypatch)
    original_payload = deepcopy(case.payload)
    connect = case.db.service._connect
    lost = []

    @contextmanager
    def lose_first_commit_ack(*args, **kwargs):
        with connect(*args, **kwargs) as connection:
            yield connection
        if not lost:
            lost.append(True)
            raise RuntimeError('Synthetic response loss AFTER the genuine transaction committed')

    monkeypatch.setattr(case.db.service, '_connect', lose_first_commit_ack)
    with pytest.raises(RuntimeError, match='AFTER the genuine transaction committed'):
        case.start()
    durable = case.snapshot()
    assert len(durable['album_top_artwork_preparations']) == 1
    old_header = durable['album_top_artwork_preparations'][0]
    assert str(old_header['start_request_key']) == original_payload['request_key']
    recovered = case.start()
    assert recovered['preparation_ref'] == str(old_header['ref'])
    assert recovered['expires_at'] == old_header['expires_at'].isoformat()
    assert case.payload == original_payload and case.snapshot() == durable


@pytest.mark.parametrize('operation', ['read', 'start_replay'])
@requires_posix_artwork
def test_ready_selected_cover_share_locks_survive_each_database_phase_and_release_in_gap(
        artwork, monkeypatch, operation):
    case = artwork.build(3)
    ready = genuine_ready(case)
    actual_probe = case.service._draft_probe
    locked_phases = set()
    gap = []

    def executed(sql, params, phase):
        if not sql.startswith('select clock_timestamp() as now') or phase in locked_phases:
            return
        with pytest.raises(psycopg.errors.LockNotAvailable):
            with psycopg.connect(case.db.app_url) as concurrent:
                concurrent.execute("set local lock_timeout='150ms'")
                concurrent.execute('update library.local_albums set cover_path=cover_path where library_id=%s and id=%s',
                                   (case.db.library, case.album_ids[-1]))
        locked_phases.add(phase)

    trace = OwnerTrace(case, monkeypatch, executed=executed)

    def probe(snapshot):
        assert not trace.active
        observed = actual_probe(snapshot)
        with psycopg.connect(case.db.app_url) as concurrent:
            concurrent.execute("set local lock_timeout='500ms'")
            concurrent.execute('update library.local_albums set cover_path=cover_path where library_id=%s and id=%s',
                               (case.db.library, case.album_ids[-1]))
        gap.append(True)
        return observed

    monkeypatch.setattr(case.service, '_draft_probe', probe)
    result = case.start() if operation == 'start_replay' else case.read(ready, limit=1)
    assert result['ready_count'] == 3
    assert locked_phases == {0, 1} and gap == [True] and len(trace.phases) == 2


@pytest.mark.parametrize('count', [100, 101, 5000])
@requires_posix_artwork
def test_ready_exact_start_and_empty_read_full_vector_sql_ceilings(
        artwork, monkeypatch, count, record_property):
    case = artwork.build(count, same_pixels=True)
    ready = genuine_ready(case)
    before = case.snapshot()
    proof_lookahead = []

    def fetched(sql, params, rows, phase):
        if 'limit 101' in sql:
            assert len(rows) <= 101
        if sql.startswith('select item_ref as row_ref,position,'):
            proof_lookahead.append(len(rows))

    trace = OwnerTrace(case, monkeypatch, fetched=fetched)
    monkeypatch.setattr(case.service, 'capture', forbidden)
    pages = (count + 99) // 100
    start = monotonic()
    assert case.start() == ready
    assert len(trace.phases) == 2
    assert_page_ledger(trace.phases[0], count, count, inventory=True, status=False,
                       maximum=17 + 4 * pages)
    assert_page_ledger(trace.phases[1], count, count, inventory=True, status=True,
                       maximum=18 + 4 * pages)
    assert len(trace.statements) <= 435
    assert sum(sql.startswith('select app.start_top_artwork_preparation') for sql in trace.statements) == 1
    record_property('saved_ready_start_sql_count', len(trace.statements))
    record_property('saved_ready_start_wall_seconds', monotonic() - start)
    trace.phases.clear()
    result = case.read(ready, after=5000, limit=1)
    assert result['items'] == [] and result['ready_count'] == count
    assert len(trace.phases) == 2
    assert_page_ledger(trace.phases[0], count, count, inventory=True, status=False,
                       maximum=16 + 4 * pages)
    assert_page_ledger(trace.phases[1], count, count, inventory=True, status=True,
                       maximum=18 + 4 * pages)
    assert len(trace.statements) <= 434
    assert max(proof_lookahead) == min(count, 101)
    assert case.snapshot() == before


@pytest.mark.parametrize('count', [250, 5000])
@requires_posix_artwork
def test_saved_four_image_phases_have_fixed_page_and_query_ceilings(
        artwork, monkeypatch, count, record_property):
    case = artwork.build(count, same_pixels=True)
    started = case.start()
    trace = OwnerTrace(case, monkeypatch)
    ready = case.advance(started)
    assert ready['ready_count'] == 4 and len(trace.phases) == 4
    pages = (count + 99) // 100
    for index, phase in enumerate(trace.phases):
        # A2 refreshes the claimed header but returns no status if work exists.
        # A4 includes completion, refreshed header and the two safe status SQLs.
        extra = 2 if index == 1 else 4 if index == 3 else 0
        assert_page_ledger(phase, count, 0, inventory=True, status=index == 3,
                           maximum=16 + 3 * pages + extra)
        assert len(phase) <= (220 if index in (1, 3) else 216)
        record_property('saved_phase_' + str(index + 1) + '_sql_count', len(phase))
    assert len(trace.statements) <= 872


@pytest.mark.parametrize('boundary', ['p1', 'capture', 'p2'])
@pytest.mark.parametrize('change', ['cover', 'source', 'inventory', 'owner', 'session', 'deadline'])
@requires_posix_artwork
def test_saved_every_outside_gap_rechecks_off_batch_authority_and_original_deadline(
        artwork, monkeypatch, boundary, change):
    case = artwork.build(5)
    started = case.start()
    actual_probe = case.service._draft_probe
    actual_capture = case.service.capture
    altered = []
    probes = []
    trace = OwnerTrace(case, monkeypatch)
    alternate = png_file(case.artwork_path / 'off-batch-gap.png', 12)
    extra_root = case.directory / 'gap-inventory-root'
    extra_root.mkdir()

    def mutate():
        assert not trace.active
        with case.db.connect() as connection:
            if change == 'cover':
                connection.execute('update library.local_albums set cover_path=%s where id=%s',
                                   (str(alternate), case.album_ids[-1]))
            elif change == 'source':
                connection.execute("update library.album_metadata_sources set state='invalid' where ref=%s",
                                   (case.source_refs[-1],))
            elif change == 'inventory':
                case.root(connection, extra_root)
            elif change == 'owner':
                connection.execute('update app.accounts set is_active=false,disabled_at=clock_timestamp() where id=%s',
                                   (case.db.owner.account_id,))
            elif change == 'session':
                connection.execute('update app.account_sessions set revoked_at=clock_timestamp() where id=%s',
                                   (case.db.owner.session_id,))
            else:
                connection.execute("""with t as (select clock_timestamp()-interval '1 second' as expiry)
                    update app.album_top_artwork_preparations set created_at=t.expiry-interval '60 minutes',
                      expires_at=t.expiry,
                      lease_expires_at=case when lease_ref is not null then least(lease_expires_at,t.expiry) end
                      from t where ref=%s""", (started['preparation_ref'],))
        altered.append(True)

    def probe(snapshot):
        observed = actual_probe(snapshot)
        probes.append(True)
        if boundary == ('p1' if len(probes) == 1 else 'p2'):
            mutate()
        return observed

    def capture(source):
        result = actual_capture(source)
        if boundary == 'capture' and not altered:
            mutate()
        return result

    monkeypatch.setattr(case.service, '_draft_probe', probe)
    monkeypatch.setattr(case.service, 'capture', capture)
    before = case.durable()
    expected = {'source': ('evidence_unavailable', 409), 'cover': ('artwork_source_changed', 409),
        'inventory': ('artwork_source_changed', 409), 'owner': ('forbidden', 403),
        'session': ('forbidden', 403), 'deadline': ('artwork_preparation_unavailable', 409)}[change]
    assert_error(lambda: case.advance(started), *expected)
    assert altered == [True]
    after = case.durable()
    if change == 'deadline':
        for row in before['album_top_artwork_preparations'] + after['album_top_artwork_preparations']:
            row.pop('created_at')
            row.pop('expires_at')
    assert after == before
    assert not any(sql.startswith('select app.complete_top_artwork_batch') for sql in trace.statements)


@pytest.mark.parametrize('operation', ['read', 'start_replay', 'advance'])
@pytest.mark.parametrize('deny', ['source', 'artwork_root', 'owner', 'session'])
@requires_posix_artwork
def test_saved_final_response_sql_precedes_policy_and_held_session_fences(
        artwork, monkeypatch, operation, deny):
    case = artwork.build(2)
    status = case.start() if operation == 'advance' else genuine_ready(case)
    response_seen = []

    def executed(sql, params, phase):
        if sql.startswith(STATUS_PREFIX):
            response_seen.append(phase)
            if deny == 'session':
                monkeypatch.setattr(case.db.service, '_clock', lambda: case.db.now + timedelta(hours=2))

    trace = OwnerTrace(case, monkeypatch, executed=executed)

    def constraints(context):
        resource = context.resource
        blocked = bool(response_seen) and (
            deny == 'owner' and context.action == ACCESS
            or deny == 'source' and resource is not None and resource.resource_kind == 'album_metadata_source'
            or deny == 'artwork_root' and resource is not None and resource.resource_kind == 'library_root'
                and resource.resource_ref == str(case.artwork_root))
        return PolicyEvaluationConstraints(request_origin_allowed=not blocked)

    before = case.durable()
    invoke = (lambda: case.start(constraints=constraints)) if operation == 'start_replay' else lambda: getattr(
        case, operation)(status, constraints=constraints)
    assert_error(invoke, 'forbidden', 403)
    assert len(response_seen) == 1 and response_seen[0] == (3 if operation == 'advance' else 1)
    assert case.durable() == before
    assert sum(sql.startswith('select app.complete_top_artwork_batch') for sql in trace.statements) == int(operation == 'advance')


def test_slow_final_policy_cannot_outlive_original_pending_preparation_deadline(
        artwork, monkeypatch, record_property):
    case = artwork.build(1)
    started = case.start()
    # Portable genuine DB-clock test. The longer window permits ordinary source
    # queries to finish; the final callback itself deliberately consumes it.
    with case.db.connect() as connection:
        deadline = connection.execute("""with t as (select clock_timestamp()+interval '5 seconds' as expiry)
            update app.album_top_artwork_preparations set created_at=t.expiry-interval '60 minutes',
                expires_at=t.expiry from t where ref=%s returning expires_at""",
            (started['preparation_ref'],)).fetchone()['expires_at']
    response_seen, waited = [], []

    def executed(sql, params, phase):
        if sql.startswith(STATUS_PREFIX):
            response_seen.append(True)

    trace = OwnerTrace(case, monkeypatch, executed=executed)

    def constraints(context):
        if response_seen and not waited:
            with case.db.connect() as connection:
                now = connection.execute('select clock_timestamp() as now').fetchone()['now']
            delay = max(0, (deadline - now).total_seconds()) + 0.05
            sleep(delay)
            waited.append(delay)
        return PolicyEvaluationConstraints()

    retained = case.snapshot()
    assert_error(lambda: case.read(started, constraints=constraints), 'artwork_preparation_unavailable', 409)
    assert response_seen == [True] and len(waited) == 1
    assert case.snapshot() == retained and len(trace.phases) == 1
    assert trace.statements.index(next(sql for sql in trace.statements if sql.startswith(STATUS_PREFIX))) < \
        len(trace.statements) - 1
    record_property('saved_slow_final_policy_seconds', waited[0])


@requires_posix_artwork
def test_genuine_legacy_proofs_and_pixels_survive_leaf_replacement_and_deletion(artwork, monkeypatch):
    case = artwork.build(3)
    captured = []
    actual_capture = case.service.capture

    def observe(source):
        result = actual_capture(source)
        captured.append(result)
        return result

    monkeypatch.setattr(case.service, 'capture', observe)
    ready = case.advance(case.start())
    assert len(captured) == 3
    stored = stored_proof_text(case, ready)
    retained = case.snapshot()
    for row, actual in zip(stored, captured):
        source = json.loads(row['source_text'])
        acquired = json.loads(row['acquisition_text'])
        assert source == {**asdict(actual.source), 'relative_parts': list(actual.source.relative_parts)}
        assert acquired == {'file': asdict(actual.file_observation),
                            'input_bytes': actual.input_bytes, 'input_pixels': actual.input_pixels}
        codec.validate_pair(source, acquired)
        assert 'descriptor_version' not in source and 'acquisition_version' not in acquired
        assert type(source['root_device']) is int and type(source['root_inode']) is int
    monkeypatch.setattr(case.service, 'capture', forbidden)
    png_file(case.cover_paths[0], 251)
    for path in case.cover_paths[1:]:
        path.unlink()
    assert case.read(ready) == ready
    assert case.read(ready, after=5000, limit=1)['items'] == []
    assert case.start() == ready
    assert case.snapshot() == retained and stored_proof_text(case, ready) == stored


@requires_posix_artwork
def test_saved_and_draft_captures_hold_the_same_two_slot_gate_until_real_cleanup(
        draft_case, monkeypatch):
    case = draft_case.build(1)
    saved = case.start()
    other = copy(case)
    other.top, _ = case.db.create(refs=case.catalog_refs)
    member = case.db.read(other.top)['items'][0]
    other.items = [{**case.items[0], 'item_ref': member['ref'], 'album_ref': member['catalog_ref']}]
    other.payload = {**case.payload, 'revision': other.top['revision'],
                     'request_key': str(uuid4()), 'items': other.items}
    other.service = TopArtworkPreparationService(case.db.service)
    draft = draft_command(other)
    drafted = start_draft(other, draft)
    release, saved_entered, draft_entered = Event(), Event(), Event()
    saved_capture, draft_capture = case.service.capture, other.service.capture

    def hold(actual, entered):
        def captured(source):
            result = actual(source)
            entered.set()
            assert release.wait(20), 'Timed out waiting for the shared-gate race to finish'
            return result
        return captured

    monkeypatch.setattr(case.service, 'capture', hold(saved_capture, saved_entered))
    monkeypatch.setattr(other.service, 'capture', hold(draft_capture, draft_entered))
    with ThreadPoolExecutor(max_workers=2) as workers:
        saved_future = workers.submit(case.advance, saved)
        draft_future = None
        try:
            assert saved_entered.wait(15)
            draft_future = workers.submit(advance_draft, other, drafted, draft)
            assert draft_entered.wait(15)
            before = case.snapshot()
            assert_error(lambda: case.advance(saved), 'artwork_busy', 409)
            assert case.snapshot() == before
            assert preparation._DECODE_REQUESTS.acquire(blocking=False) is False
        finally:
            release.set()
        assert saved_future.result(timeout=20)['ready_count'] == 1
        assert draft_future is not None and draft_future.result(timeout=20)['ready_count'] == 1
    gate = preparation._DECODE_REQUESTS
    assert gate.acquire(blocking=False)
    try:
        assert gate.acquire(blocking=False)
        gate.release()
    finally:
        gate.release()


@requires_posix_artwork
def test_ready_start_current_cover_and_legacy_digests_share_one_encoded_budget(
        artwork, monkeypatch, record_property):
    case = artwork.build(3)
    ready = genuine_ready(case)
    retained = case.snapshot()
    actual_finish = shared.finish_snapshot
    measured = []

    def observe_snapshot(*args, **kwargs):
        snapshot, context = actual_finish(*args, **kwargs)
        if snapshot['kind'] == 'saved' and snapshot['mode'] == 'start_ack':
            header_bytes = len(shared.bounded_json(shared._header_values(snapshot['header'])).encode('utf-8')) + 512
            row_bytes = 0
            for index, row in enumerate(snapshot['rows']):
                assert row['cover_path'] == str(case.cover_paths[index])
                assert row['facts'][-1] == row['cover_path']
                assert row['facts'][16:18] == [row['proof_digest'], row['acquisition_digest']]
                assert len(row['proof_digest']) == len(row['acquisition_digest']) == 64
                row_bytes += len(shared.bounded_json(row['facts']).encode('utf-8')) + 1
            # R2 carries the already retained admission/header/manifest into
            # final compact facts; keep this injection at the proof-digest bound.
            measured.append(max(header_bytes, kwargs['admission'].retained_bytes) + row_bytes)
        return snapshot, context

    monkeypatch.setattr(shared, 'finish_snapshot', observe_snapshot)
    monkeypatch.setattr(case.service, 'capture', forbidden)
    assert case.start() == ready and len(measured) == 1
    assert shared._MAX_SNAPSHOT == 32 * 1024 * 1024
    record_property('saved_start_combined_retained_and_final_row_bytes', measured[0])

    def bounded_final_snapshot(*args, **kwargs):
        assert kwargs['kind'] == 'saved' and kwargs['mode'] == 'start_ack'
        assert kwargs['admission'] is not None
        original_limit = shared._MAX_SNAPSHOT
        assert original_limit == 32 * 1024 * 1024
        # Specific final-snapshot budget injection, after real admission facts
        # were charged under the original bound. Genuine proofs still pass
        # through the unchanged incremental accounting and codec validation.
        monkeypatch.setattr(shared, '_MAX_SNAPSHOT', measured[0] - 1)
        try:
            return actual_finish(*args, **kwargs)
        finally:
            monkeypatch.setattr(shared, '_MAX_SNAPSHOT', original_limit)

    # This is not a 32MiB RSS or large-input runtime claim. The admission path
    # has no bypass, and rejection must occur at ready-proof accounting below.
    monkeypatch.setattr(shared, 'finish_snapshot', bounded_final_snapshot)
    monkeypatch.setattr(case.service, '_draft_probe', forbidden)
    trace = OwnerTrace(case, monkeypatch)
    assert_error(case.start, 'artwork_validation_limit', 409)
    assert shared._MAX_SNAPSHOT == 32 * 1024 * 1024
    assert any(sql.startswith('select item_ref as row_ref,position,') for sql in trace.statements)
    assert not any(sql.startswith(STATUS_PREFIX) for sql in trace.statements)
    assert case.snapshot() == retained


@requires_posix_artwork
def test_saved_post_complete_exception_rolls_back_and_releases_both_image_slots(
        artwork, monkeypatch):
    case = artwork.build(2)
    started = case.start()
    before = case.durable()
    completed = []

    def executed(sql, params, phase):
        if sql.startswith('select app.complete_top_artwork_batch'):
            completed.append(phase)
            raise RuntimeError('Synthetic failure after the actual completion SQL')

    trace = OwnerTrace(case, monkeypatch, executed=executed)
    with pytest.raises(RuntimeError, match='after the actual completion SQL'):
        case.advance(started)
    assert completed == [3] and len(trace.phases) == 4
    assert case.durable() == before
    assert ('committed', 3) not in trace.events
    gate = preparation._DECODE_REQUESTS
    assert gate.acquire(blocking=False)
    try:
        assert gate.acquire(blocking=False)
        gate.release()
    finally:
        gate.release()


@pytest.mark.parametrize('boundary', ['capture', 'p2'])
@requires_posix_artwork
def test_saved_expired_lease_keeps_existing_error_boundary_without_completed_proof(
        artwork, monkeypatch, boundary):
    case = artwork.build(2)
    started = case.start()
    retained = case.durable()
    original_header = header(case, started)
    actual_probe, actual_capture = case.service._draft_probe, case.service.capture
    expired, probes = [], []

    def expire_lease():
        with case.db.connect() as connection:
            connection.execute("""update app.album_top_artwork_preparations
                set lease_expires_at=clock_timestamp()-interval '1 second'
                where ref=%s and lease_ref is not null""", (started['preparation_ref'],))
        expired.append(True)

    def probe(snapshot):
        observed = actual_probe(snapshot)
        probes.append(True)
        if boundary == 'p2' and len(probes) == 2:
            expire_lease()
        return observed

    def capture(source):
        result = actual_capture(source)
        if boundary == 'capture' and not expired:
            expire_lease()
        return result

    monkeypatch.setattr(case.service, '_draft_probe', probe)
    monkeypatch.setattr(case.service, 'capture', capture)
    assert_error(lambda: case.advance(started), 'artwork_preparation_unavailable', 409)
    assert expired == [True] and case.durable() == retained
    assert header(case, started)['expires_at'] == original_header['expires_at']


# S R2: additive regressions for the separately authorized shared-phase fixes.
def _successor_guard_sql(case, monkeypatch, guard):
    """Reject forbidden statements BEFORE delegating to a real connection."""
    connect = case.db.service._connect

    class Connection:
        def __init__(self, real):
            self.real = real

        def __getattr__(self, name):
            return getattr(self.real, name)

        def execute(self, sql, params=None):
            guard(' '.join(str(sql).lower().split()), params)
            return self.real.execute(sql, params)

    @contextmanager
    def guarded(*args, **kwargs):
        with connect(*args, **kwargs) as connection:
            yield Connection(connection)

    monkeypatch.setattr(case.db.service, '_connect', guarded)


@pytest.mark.parametrize('reject_position', [1, 101])
@requires_posix_artwork
def test_ready_start_replay_combined_budget_rejects_during_manifest_before_later_pages(
        artwork, monkeypatch, reject_position, record_property):
    case = artwork.build(201, same_pixels=True)
    ready = genuine_ready(case)
    assert ready['ready_count'] == 201
    retained = case.snapshot()
    original_header = dict(header(case, ready))
    original_payload = deepcopy(case.payload)
    original_proofs = stored_proof_text(case, ready)
    # These are SQL-valid text values, not claimed native filesystem paths.
    # All genuine immutable proofs and PNGs predate this current-source change.
    changed = '\u00e9' * 8192
    assert len(changed.encode('utf-8')) == 16384
    with case.db.connect() as connection:
        connection.execute('update library.local_albums set cover_path=%s where library_id=%s and id=any(%s)',
                           (changed, case.db.library, case.album_ids))

    saved = preparation.saved_artwork
    actual_manifest, actual_encode = saved.manifest, shared.bounded_json
    admission_charges, row_charges, rejected, fetched_offsets = [], [], [], []
    ledger = {}
    original_limit = shared._MAX_SNAPSHOT
    assert original_limit == 32 * 1024 * 1024

    def compact(value):
        return json.dumps(value, sort_keys=True, separators=(',', ':'),
                          ensure_ascii=False, allow_nan=False)

    def normalized_manifest(item):
        row = dict(item)
        for key in ('item_ref', 'catalog_ref', 'selected_source_ref'):
            row[key] = str(row[key])
        row.update(row_ref=row['item_ref'], saved_item_ref=row['item_ref'], row_kind='existing')
        return {key: shared._plain(value) for key, value in row.items()}

    def encode(value, limit=None):
        # Observe the real encoder, not a replacement success or weaker bound.
        admission = (type(value) is list and len(value) == 2 and type(value[0]) is dict
                     and 'item_ref' in value[0] and 'selected_source_ref' in value[0])
        manifest_row = type(value) is dict and 'current_cover_path' in value
        if manifest_row:
            assert ledger['budget'][0] == ledger['admitted'] + ledger['header'] + sum(row_charges)
            assert limit == shared._MAX_SNAPSHOT - ledger['budget'][0]
            assert value['position'] == len(row_charges) + 1
            assert value['current_cover_path'] == changed and value['current_cover_valid'] is True
        try:
            result = actual_encode(value) if limit is None else actual_encode(value, limit)
        except AlbumTopError as error:
            assert manifest_row and error.code == 'artwork_validation_limit'
            assert value['position'] == reject_position
            rejected.append(value['position'])
            raise
        if admission:
            admission_charges.append(len(result.encode('utf-8')) + 1)
        if manifest_row:
            row_charges.append(len(result.encode('utf-8')) + 1)
        return result

    def manifest(connection, live, preparation_header, *, start_ack=False, admission_budget=None):
        assert start_ack and admission_budget is not None
        assert len(admission_charges) == 201
        assert admission_budget == [512 + sum(admission_charges)]
        ledger.update(budget=admission_budget, admitted=admission_budget[0],
            header=len(compact(shared._header_values(preparation_header)).encode('utf-8')) + 1)
        return actual_manifest(connection, live, preparation_header,
                               start_ack=True, admission_budget=admission_budget)

    def fetched(sql, params, rows, phase):
        if 'as current_cover_valid' not in sql:
            return
        assert phase == 0 and len(rows) == 101
        offset = params[2]
        fetched_offsets.append(offset)
        assert [row['position'] for row in rows] == list(range(offset + 1, offset + 102))
        assert all(row['current_cover_valid'] is True and row['current_cover_path'] == changed for row in rows)
        if offset == 0:
            # Explicit REDUCED-BUDGET injection at the first genuine SQL page,
            # before any returned row is normalized/retained by manifest().
            # Admission is already charged. Account the exact retained header
            # and normalized manifest objects, including the 16KiB cover text.
            # For position101 the lookahead is measured but must NOT be charged
            # or processed until the next existing 100+1 page.
            charges = [len(compact(normalized_manifest(row)).encode('utf-8')) + 1 for row in rows]
            limit = ledger['admitted'] + ledger['header'] + sum(charges[:reject_position]) - 2
            assert ledger['budget'][0] == ledger['admitted'] + ledger['header']
            assert ledger['budget'][0] < limit < original_limit
            monkeypatch.setattr(shared, '_MAX_SNAPSHOT', limit)
            ledger['limit'] = limit
        else:
            assert offset == 100 and reject_position == 101
            assert len(row_charges) == 100

    def guard(sql, params):
        if 'as current_cover_valid' in sql:
            assert params[2] <= (100 if reject_position == 101 else 0), 'Later manifest page was requested'
        assert not sql.startswith('select item_ref as row_ref,position,'), 'Ready proof query preceded budget rejection'
        assert not sql.startswith('select id, case when octet_length(root_path)'), 'Inventory preceded budget rejection'
        assert not sql.startswith(STATUS_PREFIX), 'Response SQL preceded budget rejection'
        assert not sql.startswith('select app.claim_top_artwork_batch')
        assert not sql.startswith('select app.complete_top_artwork_batch')

    with monkeypatch.context() as guarded:
        guarded.setattr(saved, 'manifest', manifest)
        guarded.setattr(shared, 'bounded_json', encode)
        guarded.setattr(shared, 'finish_snapshot', forbidden)
        guarded.setattr(case.service, '_draft_probe', forbidden)
        guarded.setattr(case.service, 'capture', forbidden)
        guarded.setattr(case.service, '_status', forbidden)
        guarded.setattr(proof, 'saved_ready_binding', forbidden)
        trace = OwnerTrace(case, guarded, fetched=fetched)
        _successor_guard_sql(case, guarded, guard)
        try:
            assert_error(case.start, 'artwork_validation_limit', 409)
        finally:
            monkeypatch.setattr(shared, '_MAX_SNAPSHOT', original_limit)
    assert rejected == [reject_position] and len(row_charges) == reject_position - 1
    assert fetched_offsets == ([0] if reject_position == 1 else [0, 100])
    assert ledger['budget'][0] == ledger['admitted'] + ledger['header'] + sum(row_charges)
    assert ledger['budget'][0] < ledger['limit']
    assert len(trace.phases) == 1 and ('committed', 0) not in trace.events
    categories = snapshot_categories(trace.phases[0])
    assert categories == {'manifest': len(fetched_offsets), 'source': 3, 'locks': 3,
                          'proof': 0, 'inventory': 0, 'status': 0}
    assert sum(sql.startswith('select app.start_top_artwork_preparation') for sql in trace.statements) == 1
    assert not any('cancel_top_artwork' in sql or 'cleanup_top_artwork' in sql for sql in trace.statements)
    assert case.snapshot() == retained and dict(header(case, ready)) == original_header
    assert stored_proof_text(case, ready) == original_proofs and case.payload == original_payload
    record_property('reduced_manifest_rejection_position', reject_position)
    record_property('combined_admission_header_manifest_limit', ledger['limit'])
    # Restore only the changed source values. The original request body/key,
    # generation, lifetime, counters and proofs must recover without recapture.
    for index, path in enumerate(case.cover_paths):
        set_cover(case, index, str(path))
    with monkeypatch.context() as guarded:
        guarded.setattr(case.service, 'capture', forbidden)
        assert case.start() == ready
    assert case.snapshot() == retained and dict(header(case, ready)) == original_header


@pytest.mark.parametrize('operation', ['read', 'empty_read', 'start_replay'])
@requires_posix_artwork
def test_saved_ready_ack_actual_artwork_root_browse_revocation_keeps_forbidden(
        artwork, monkeypatch, operation):
    case = artwork.build(2)
    ready = genuine_ready(case)
    retained = case.snapshot()
    original_header = dict(header(case, ready))
    original_payload = deepcopy(case.payload)
    assert case.artwork_root != case.metadata_root
    actual_probe = case.service._draft_probe
    denied, observations, policy_calls = [False], [], []

    def constraints(context):
        resource = context.resource
        blocked = (denied[0] and context.action == 'library.browse.read'
            and resource is not None and resource.resource_kind == 'library_root'
            and resource.resource_ref == str(case.artwork_root))
        if resource is not None and resource.resource_kind == 'library_root':
            policy_calls.append((context.action, resource.resource_ref, blocked))
            if resource.resource_ref == str(case.metadata_root):
                assert blocked is False
        # The actual authorization evaluator consumes this current constraint;
        # neither its result nor any SQL/native observation is substituted.
        return PolicyEvaluationConstraints(request_origin_allowed=not blocked)

    def probe(snapshot):
        assert not denied[0] and not trace.active and len(trace.phases) == 1
        result = actual_probe(snapshot)
        roots = {observed.root_id for observed, _ in result.values()}
        assert roots == {case.artwork_root} and len(result) == 2
        observations.append(roots)
        denied[0] = True
        return result

    def guard(sql, params):
        assert not sql.startswith(STATUS_PREFIX), 'Revoked actual root reached response SQL'
        assert not sql.startswith('select app.claim_top_artwork_batch')
        assert not sql.startswith('select app.complete_top_artwork_batch')

    with monkeypatch.context() as guarded:
        trace = OwnerTrace(case, guarded)
        _successor_guard_sql(case, guarded, guard)
        guarded.setattr(case.service, '_draft_probe', probe)
        guarded.setattr(case.service, 'capture', forbidden)
        guarded.setattr(case.service, '_status', forbidden)
        # Each operation has only one comparison, after its outside probe. A
        # 409 comparison winning the race would violate the saved 403 boundary.
        guarded.setattr(shared, 'compare', forbidden)
        invoke = (lambda: case.start(constraints=constraints)) if operation == 'start_replay' else lambda: case.read(
            ready, after=5000 if operation == 'empty_read' else 0, limit=1, constraints=constraints)
        assert_error(invoke, 'forbidden', 403)
    assert observations == [{case.artwork_root}] and len(trace.phases) == 2
    assert ('committed', 0) in trace.events and ('committed', 1) not in trace.events
    assert ('library.browse.read', str(case.artwork_root), True) in policy_calls
    assert ('library.browse.read', str(case.metadata_root), False) in policy_calls
    assert sum(sql.startswith('select app.start_top_artwork_preparation') for sql in trace.statements) == int(operation == 'start_replay')
    assert case.snapshot() == retained and dict(header(case, ready)) == original_header
    assert case.payload == original_payload
    # Current policy restoration reuses the original exact start or ready read.
    denied[0] = False
    with monkeypatch.context() as guarded:
        guarded.setattr(case.service, 'capture', forbidden)
        recovered = case.start(constraints=constraints) if operation == 'start_replay' else case.read(ready, constraints=constraints)
        assert recovered == ready
    assert case.snapshot() == retained and dict(header(case, ready)) == original_header


@pytest.mark.parametrize('boundary', ['p1', 'capture', 'p2'])
@requires_posix_artwork
def test_saved_advance_off_batch_actual_root_revocation_precedes_snapshot_comparison(
        artwork, monkeypatch, boundary):
    case = artwork.build(5)
    # Put only the fifth, off-batch album under a different genuine artwork
    # root. Carrying only the four captured roots across the gap is insufficient.
    other_path = case.directory / 'off-batch-artwork'
    alternate = png_file(other_path / 'cover.png', 37)
    with case.db.connect() as connection:
        other_root = case.root(connection, other_path)
    set_cover(case, 4, str(alternate))
    case.cover_paths[4] = alternate
    assert len({other_root, case.artwork_root, case.metadata_root}) == 3
    started = case.start()
    retained = case.durable()
    original_header = dict(header(case, started))
    original_payload = deepcopy(case.payload)
    actual_probe, actual_loop = case.service._draft_probe, case.service._capture_rows
    actual_capture, actual_compare = case.service.capture, shared.compare
    denied, probe_roots, captures, policy_calls = [False], [], [], []
    claim_headers = []

    def constraints(context):
        resource = context.resource
        blocked = (denied[0] and context.action == 'library.browse.read'
            and resource is not None and resource.resource_kind == 'library_root'
            and resource.resource_ref == str(other_root))
        if resource is not None and resource.resource_kind == 'library_root':
            policy_calls.append((context.action, resource.resource_ref, blocked))
            if resource.resource_ref == str(case.metadata_root):
                assert blocked is False
        return PolicyEvaluationConstraints(request_origin_allowed=not blocked)

    def probe(snapshot):
        assert not denied[0] and not trace.active
        result = actual_probe(snapshot)
        roots = {observed.root_id for observed, _ in result.values()}
        assert roots == {case.artwork_root, other_root} and len(result) == 5
        assert result[case.items[4]['item_ref']][0].root_id == other_root
        probe_roots.append(roots)
        if boundary == ('p1' if len(probe_roots) == 1 else 'p2'):
            denied[0] = True
        return result

    def capture(source):
        assert not denied[0] and not trace.active
        assert source.artwork_root_id == case.artwork_root
        result = actual_capture(source)
        captures.append(result.content_digest)
        return result

    def capture_loop(*args, **kwargs):
        assert boundary != 'p1' and not denied[0] and not trace.active
        claim_headers.append(dict(header(case, started)))
        result = actual_loop(*args, **kwargs)
        assert len(result) == 4 and all(value is not None for value in result.values())
        if boundary == 'capture':
            denied[0] = True
        return result

    def compare(*args, **kwargs):
        assert not denied[0], 'Snapshot comparison masked current actual-root Browse denial'
        return actual_compare(*args, **kwargs)

    def guard(sql, params):
        assert not sql.startswith(STATUS_PREFIX), 'Revoked actual root reached response SQL'
        assert not sql.startswith('select app.complete_top_artwork_batch'), 'Revoked actual root reached completion'
        if denied[0]:
            assert not sql.startswith('select app.claim_top_artwork_batch'), 'Revoked actual root reached a new claim'

    with monkeypatch.context() as guarded:
        trace = OwnerTrace(case, guarded)
        _successor_guard_sql(case, guarded, guard)
        guarded.setattr(case.service, '_draft_probe', probe)
        guarded.setattr(case.service, 'capture', capture)
        guarded.setattr(case.service, '_capture_rows', capture_loop)
        guarded.setattr(case.service, '_status', forbidden)
        guarded.setattr(shared, 'compare', compare)
        assert_error(lambda: case.advance(started, constraints=constraints), 'forbidden', 403)
    assert denied[0] is True
    assert len(trace.phases) == {'p1': 2, 'capture': 3, 'p2': 4}[boundary]
    assert len(probe_roots) == (2 if boundary == 'p2' else 1)
    assert len(captures) == (0 if boundary == 'p1' else 4)
    assert ('library.browse.read', str(other_root), True) in policy_calls
    assert ('library.browse.read', str(case.metadata_root), False) in policy_calls
    assert sum(sql.startswith('select app.claim_top_artwork_batch') for sql in trace.statements) == int(boundary != 'p1')
    assert case.durable() == retained and case.payload == original_payload
    current_header = dict(header(case, started))
    if boundary == 'p1':
        assert claim_headers == [] and current_header == original_header
    else:
        # The admitted A2 lease is the only permitted durable difference. It
        # retains the original exact key/rows/deadline and has no new receipt.
        assert len(claim_headers) == 1 and current_header == claim_headers[0]
        assert current_header['lease_ref'] is not None
        assert current_header['completed_request_key'] is None
        assert current_header['expires_at'] == original_header['expires_at']
    gate = preparation._DECODE_REQUESTS
    assert gate.acquire(blocking=False)
    try:
        assert gate.acquire(blocking=False)
        gate.release()
    finally:
        gate.release()


@pytest.mark.parametrize('state', ['pending', 'failed', 'excluded'])
def test_saved_no_ready_status_never_checks_unobserved_artwork_root(artwork, monkeypatch, state):
    case = artwork.build(1, excluded=(0,) if state == 'excluded' else ())
    status = case.start()
    if state == 'failed':
        status = fail_one_batch(case, status)
    retained = case.snapshot()
    policy_calls = []

    def constraints(context):
        resource = context.resource
        if resource is not None and resource.resource_kind == 'library_root':
            policy_calls.append(resource.resource_ref)
            assert resource.resource_ref != str(case.artwork_root), 'No-ready status checked an unobserved artwork root'
        return PolicyEvaluationConstraints()

    trap_image_work(case, monkeypatch)
    trace = OwnerTrace(case, monkeypatch)
    assert case.read(status, constraints=constraints)['ready_count'] == 0
    assert case.start(constraints=constraints)['ready_count'] == 0
    assert str(case.metadata_root) in policy_calls
    assert len(trace.phases) == 2
    for phase in trace.phases:
        categories = snapshot_categories(phase)
        assert categories['inventory'] == categories['proof'] == 0
        assert categories['manifest'] == categories['source'] == categories['locks'] == categories['status'] == 1
    assert case.snapshot() == retained
