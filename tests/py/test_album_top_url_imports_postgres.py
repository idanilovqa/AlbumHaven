"""Actual source-job transactions with deterministic credential-free fetch results."""
import base64
from uuid import uuid4
import pytest

from music_app.services.album_top_source_imports import TopSourceImports
from music_app.services.album_top_source_parse import source_command
from music_app.services.album_top_source_finalization import read_source
from music_app.services.owned_album_tops import normalize_top_command
from test_owned_album_tops_postgres import db, urls, assert_error


def payload():
    return {'request_key': str(uuid4()), 'title': 'URL source', 'description': '',
            'kind': 'url', 'filename': None, 'content': 'https://example.org/list?private=yes#albums'}


def evidence(url, **kwargs):
    assert kwargs['observe']() is True
    body = b'1. First\n2. Second'
    return {'final_url': 'https://example.org/list?private=yes', 'redirect_chain': [url],
            'mime': 'text/plain', 'charset': 'utf-8', 'body': base64.b64encode(body).decode(),
            'content': body.decode()}


def test_url_job_retains_private_original_and_immutable_acquisition_without_creating_top(db):
    service = TopSourceImports(db.service, source_origins=('app.example.org',), fetch=evidence)
    command = payload(); before = db.snapshot()
    first = service.submit(db.context(), command)
    assert first['source'] == command and first['status'] == 'completed'
    assert first['acquisition']['redirect_chain'] == [command['content']]
    assert first['review']['ordered_row_refs'] == ['1', '2']
    assert first['top_ref'] is None and db.snapshot() == before
    assert service.submit(db.context(), command) == first
    assert service.process(db.context(), first['job_ref']) == first
    assert 'acquisition' not in service.list(db.context())['jobs'][0]
    assert 'source' not in service.list(db.context())['jobs'][0]
    with db.connect() as connection:
        with pytest.raises(Exception):
            connection.execute("update app.album_top_source_jobs set url_acquisition='{}'::jsonb,revision=revision+1 where ref=%s",
                               (first['job_ref'],))


def test_fragment_is_part_of_idempotency_identity_not_transport(db):
    command = payload()
    first, digest = source_command(command)
    _, other = source_command({**command, 'content': command['content'].replace('#albums', '#next')})
    assert digest != other and first['content'].endswith('#albums')


def test_cancel_during_url_work_blocks_late_evidence(db):
    service = TopSourceImports(db.service, source_origins=('app.example.org',))
    def canceled(url, **kwargs):
        ref = service.list(db.context())['jobs'][0]['job_ref']
        service.cancel(db.context(), ref)
        assert kwargs['observe']() is False
        return {**evidence(url, observe=lambda: True), 'content': '1. Late'}
    service._fetch = canceled
    result = service.submit(db.context(), payload())
    assert result['status'] == 'canceled' and result['acquisition'] is None and result['review'] is None


def test_failed_url_is_recoverable_and_errors_have_no_url_or_body(db):
    def failed(*args, **kwargs):
        raise ValueError('https://private.example/secret')
    service = TopSourceImports(db.service, source_origins=('app.example.org',), fetch=failed)
    result = service.submit(db.context(), payload())
    assert result['status'] == 'failed' and result['error'] == 'source_processing_failed'
    assert result['acquisition'] is None
    service._fetch = evidence
    recovered = service.process(db.context(), result['job_ref'])
    assert recovered['status'] == 'completed' and recovered['acquisition'] is not None


def test_url_finalization_and_copy_never_transfer_private_acquisition(db):
    service = TopSourceImports(db.service, source_origins=('app.example.org',), fetch=evidence)
    job = service.submit(db.context(), payload())
    command = normalize_top_command('create', {'request_key': job['job_ref'], 'title': 'Imported',
        'source_review': {'job_ref': job['job_ref'], 'revision': job['revision'], 'rows': [
            {'row_ref': '1', 'selection': {'kind': 'local_catalog', 'album_ref': db.album_refs[0]}},
            {'row_ref': '2', 'selection': None}]}})
    top = db.service.execute(db.context(), command, context_ref='a' * 64)
    private = read_source(db.service, db.context(), top['top_ref'], top['revision'])
    assert private['source']['content'] == job['source']['content']
    assert private['acquisition'] == job['acquisition']
    copied = db.service.execute(db.context(), normalize_top_command('copy', {
        'request_key': str(uuid4()), 'revision': top['revision'], 'title': 'Copy'}, top_ref=top['top_ref']))
    copied_evidence = read_source(db.service, db.context(), copied['top_ref'], copied['revision'])
    assert copied_evidence['source'] is None and 'acquisition' not in copied_evidence


def test_session_expiry_during_fetch_cannot_publish_evidence(db, monkeypatch):
    from datetime import timedelta
    def expire(url, **kwargs):
        value = evidence(url, **kwargs)
        monkeypatch.setattr(db.service, '_clock', lambda: db.now + timedelta(days=2))
        return value
    service = TopSourceImports(db.service, source_origins=('app.example.org',), fetch=expire)
    assert_error(lambda: service.submit(db.context(), payload()), 'forbidden', 403)
    with db.connect() as connection:
        rows = connection.execute('select status,url_acquisition,review_result from app.album_top_source_jobs where actor_account_id=%s',
                                  (db.context().actor.account_id,)).fetchall()
    assert len(rows) == 1 and rows[0]['status'] == 'running'
    assert rows[0]['url_acquisition'] is None and rows[0]['review_result'] is None


def test_other_account_cannot_read_private_url_or_acquisition(db):
    service = TopSourceImports(db.service, source_origins=('app.example.org',), fetch=evidence)
    job = service.submit(db.context(), payload())
    with db.connect() as connection:
        other = db.member(connection, db.actor(connection), db.library)
    assert_error(lambda: service.read(db.context(other), job['job_ref']), 'source_job_unavailable', 404)
    assert service.list(db.context(other))['jobs'] == []


def test_expired_claim_cannot_publish_old_url_result(db, monkeypatch):
    from datetime import timedelta
    def expire(url, **kwargs):
        value = evidence(url, **kwargs)
        monkeypatch.setattr(db.service, '_clock', lambda: db.now + timedelta(minutes=2))
        return value
    service = TopSourceImports(db.service, source_origins=('app.example.org',), fetch=expire)
    job = service.submit(db.context(), payload())
    assert job['status'] == 'running' and job['acquisition'] is None and job['review'] is None


def test_escaped_evidence_overrun_is_recoverable_before_sql_publication(db):
    def large(url, **kwargs):
        assert kwargs['observe']() is True
        body = b'\x01' * (512 * 1024)
        return {'final_url': 'https://example.org/', 'redirect_chain': [url], 'mime': 'text/plain',
                'charset': 'utf-8', 'body': base64.b64encode(body).decode(), 'content': body.decode()}
    service = TopSourceImports(db.service, source_origins=('app.example.org',), fetch=large)
    job = service.submit(db.context(), payload())
    assert job['status'] == 'failed' and job['error'] == 'source_processing_failed'
    assert job['acquisition'] is None and job['review'] is None and job['top_ref'] is None
    service._fetch = evidence
    assert service.process(db.context(), job['job_ref'])['status'] == 'completed'
