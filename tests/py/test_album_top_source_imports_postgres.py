"""Real PostgreSQL source-job authority, recovery and immutable evidence contracts."""
from datetime import timedelta
from uuid import uuid4

import pytest
from concurrent.futures import ThreadPoolExecutor

from music_app.services import album_top_source_imports as jobs
from music_app.services.album_top_source_parse import parse_source
from music_app.services.owned_album_tops import AlbumTopError
from test_owned_album_tops_postgres import db, urls, assert_error


def payload():
    return dict(request_key=str(uuid4()), title='Source Top', description='Evidence',
                kind='text', filename=None, content='2. Artist B - Album B\n1. Artist A - Album A')


def test_submit_replay_and_explicit_review_never_create_top(db):
    service = jobs.TopSourceImports(db.service)
    before = db.snapshot()
    command = payload()
    first = service.submit(db.context(), command)
    assert first['status'] == 'completed' and first['phase'] == 'review_evidence'
    assert first['top_ref'] is None and first['source'] == command
    assert first['review']['ordered_row_refs'] == ['2', '1']
    assert all(row['catalog_ref'] is None for row in first['review']['rows'])
    assert service.submit(db.context(), command) == first
    assert service.process(db.context(), first['job_ref']) == first
    assert service.read(db.context(), first['job_ref']) == first
    assert db.snapshot() == before
    assert_error(lambda: service.submit(db.context(), {**command, 'content': '1. Different'}),
                 'request_key_conflict', 409)


def test_cancel_is_monotonic_even_for_completed_review(db):
    service = jobs.TopSourceImports(db.service)
    command = payload()
    first = service.submit(db.context(), command)
    canceled = service.cancel(db.context(), first['job_ref'])
    assert canceled['status'] == 'canceled'
    assert canceled['review'] == first['review']
    assert service.cancel(db.context(), first['job_ref']) == canceled
    assert service.process(db.context(), first['job_ref']) == canceled
    assert service.submit(db.context(), command) == canceled


def test_cancellation_during_worker_fences_late_result(db, monkeypatch):
    service = jobs.TopSourceImports(db.service)
    def work(command):
        listed = service.list(db.context())['jobs']
        assert len(listed) == 1 and listed[0]['status'] == 'running'
        service.cancel(db.context(), listed[0]['job_ref'])
        return parse_source(command)
    monkeypatch.setattr(jobs, 'parse_source', work)
    result = service.submit(db.context(), payload())
    assert result['status'] == 'canceled' and result['review'] is None


def test_failed_worker_can_retry_without_new_source(db, monkeypatch):
    service = jobs.TopSourceImports(db.service)
    def failure(command):
        raise ValueError('private details must not escape')
    monkeypatch.setattr(jobs, 'parse_source', failure)
    failed = service.submit(db.context(), payload())
    assert failed['status'] == 'failed' and failed['error'] == 'source_processing_failed'
    assert failed['review'] is None
    monkeypatch.setattr(jobs, 'parse_source', parse_source)
    result = service.process(db.context(), failed['job_ref'])
    assert result['status'] == 'completed' and result['error'] is None
    assert result['source'] == failed['source']
    assert len(service.list(db.context())['jobs']) == 1


def test_expired_attempt_cannot_publish_and_explicit_retry_recovers(db, monkeypatch):
    service = jobs.TopSourceImports(db.service)
    clock = [db.now]
    monkeypatch.setattr(db.service, '_clock', lambda: clock[0])
    def delayed(command):
        clock[0] += timedelta(seconds=61)
        return parse_source(command)
    monkeypatch.setattr(jobs, 'parse_source', delayed)
    running = service.submit(db.context(), payload())
    assert running['status'] == 'running' and running['review'] is None
    assert service.read(db.context(), running['job_ref']) == running
    monkeypatch.setattr(jobs, 'parse_source', parse_source)
    assert service.process(db.context(), running['job_ref'])['status'] == 'completed'


def test_replaced_attempt_never_overwrites_new_generation(db, monkeypatch):
    service = jobs.TopSourceImports(db.service)
    clock = [db.now]
    monkeypatch.setattr(db.service, '_clock', lambda: clock[0])
    nested = []
    def delayed(command):
        ref = service.list(db.context())['jobs'][0]['job_ref']
        clock[0] += timedelta(seconds=61)
        monkeypatch.setattr(jobs, 'parse_source', parse_source)
        nested.append(service.process(db.context(), ref))
        return {'untrusted_late_result': True}
    monkeypatch.setattr(jobs, 'parse_source', delayed)
    result = service.submit(db.context(), payload())
    assert result == nested[0]
    assert 'untrusted_late_result' not in result['review']


def test_other_actor_and_library_cannot_read_cancel_or_process(db):
    service = jobs.TopSourceImports(db.service)
    ref = service.submit(db.context(), payload())['job_ref']
    with db.connect() as connection:
        other = db.member(connection, db.actor(connection), db.library)
    for method in (service.read, service.cancel, service.process):
        assert_error(lambda: method(db.context(other), ref), 'source_job_unavailable', 404)
    assert service.list(db.context(other))['jobs'] == []
    with db.connect() as connection:
        library = db.library_for(connection, db.owner)
        switched = db.member(connection, db.owner, library)
    assert_error(lambda: service.read(db.context(switched), ref), 'source_job_unavailable', 404)


def test_membership_revoked_during_worker_prevents_publication(db, monkeypatch):
    service = jobs.TopSourceImports(db.service)
    def revoked(command):
        with db.connect() as connection:
            connection.execute('delete from library.library_memberships where account_id=%s and library_id=%s',
                               (db.owner.account_id, db.library))
        return parse_source(command)
    monkeypatch.setattr(jobs, 'parse_source', revoked)
    with pytest.raises(AlbumTopError) as error:
        service.submit(db.context(), payload())
    assert error.value.status_code == 403
    with db.connect() as connection:
        row = connection.execute('select status,review_result from app.album_top_source_jobs where library_id=%s',
                                 (db.library,)).fetchone()
    assert row['status'] == 'running' and row['review_result'] is None


def test_immutable_evidence_guard_and_owned_list_projection(db):
    service = jobs.TopSourceImports(db.service)
    first = service.submit(db.context(), payload())
    listing = service.list(db.context())
    assert listing['next_cursor'] is None and len(listing['jobs']) == 1
    assert 'source' not in listing['jobs'][0] and 'review' not in listing['jobs'][0]
    with pytest.raises(Exception) as error:
        with db.connect() as connection:
            connection.execute("update app.album_top_source_jobs set source='{}',revision=revision+1 where ref=%s",
                               (first['job_ref'],))
    assert getattr(error.value, 'sqlstate', None) == '23514'
    assert service.read(db.context(), first['job_ref']) == first


def test_concurrent_same_key_has_one_durable_source(db):
    service = jobs.TopSourceImports(db.service)
    command = payload()
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(service.submit, db.context(), command) for _ in range(2)]
        results = [future.result(timeout=15) for future in futures]
    assert results[0]['job_ref'] == results[1]['job_ref']
    assert service.read(db.context(), results[0]['job_ref'])['status'] == 'completed'
    assert len(service.list(db.context())['jobs']) == 1


def test_session_expiring_in_worker_rejects_result(db, monkeypatch):
    service = jobs.TopSourceImports(db.service)
    clock = [db.now]
    monkeypatch.setattr(db.service, '_clock', lambda: clock[0])
    def expired(command):
        clock[0] += timedelta(days=2)
        return parse_source(command)
    monkeypatch.setattr(jobs, 'parse_source', expired)
    assert_error(lambda: service.submit(db.context(), payload()), 'forbidden', 403)
    with db.connect() as connection:
        row = connection.execute('select status,review_result from app.album_top_source_jobs where library_id=%s',
                                 (db.library,)).fetchone()
    assert row['status'] == 'running' and row['review_result'] is None


def test_list_and_cursor_queries_never_materialize_evidence_blobs(db, monkeypatch):
    from contextlib import contextmanager
    import psycopg
    from psycopg.rows import dict_row

    service = jobs.TopSourceImports(db.service)
    service.submit(db.context(), payload())
    service.submit(db.context(), payload())
    projections = []

    class Connection:
        def __init__(self, real):
            self.real = real

        def execute(self, sql, params=None):
            result = self.real.execute(sql, params)
            if 'from app.album_top_source_jobs' in sql:
                columns = {column.name for column in result.description}
                projections.append(columns)
                assert 'source' not in columns and 'review_result' not in columns
            return result

    @contextmanager
    def connect(url):
        with psycopg.connect(url, row_factory=dict_row) as real:
            yield Connection(real)

    monkeypatch.setattr(db.service, '_connect', connect)
    first = service.list(db.context())
    assert len(first['jobs']) == 2
    assert all(row['title'] == 'Source Top' and row['kind'] == 'text' for row in first['jobs'])
    second = service.list(db.context(), cursor=first['jobs'][0]['job_ref'])
    assert second['jobs'] == first['jobs'][1:]
    assert len(projections) == 3
    assert projections[1] == {'created_at', 'ref'}
