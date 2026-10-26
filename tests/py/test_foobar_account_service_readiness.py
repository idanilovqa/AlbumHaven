"""AUTHORED ONLY. Actual readiness/lifecycle gates, synthetic catalog rows."""
import inspect
import pytest
from tests.py.foobar_account_service_readiness_testing import install_catalog,readiness
from tests.py.foobar_account_service_testing import s,handles,dispatch_prepare,p


@pytest.mark.parametrize('rows',[
    [],[{'structural_ready':False}],[{'structural_ready':1}],
    [{'structural_ready':True,'extra':True}],[{'structural_ready':True}]*2,
    ({'structural_ready':True},),
])
def test_readiness_rejects_every_nonexact_database_result(monkeypatch,rows):
    db=install_catalog(monkeypatch,rows)
    with pytest.raises(s.SourceUnavailable):
        readiness.require_account_import_schema('synthetic:no-network')
    assert all(cursor.closed for cursor in db.cursors) and db.exits==1


def test_readiness_is_actual_read_only_catalog_query_and_not_cached(monkeypatch):
    db=install_catalog(monkeypatch)
    assert readiness.require_account_import_schema('synthetic:no-network') is None
    db.rows=[{'structural_ready':False}]
    with pytest.raises(s.SourceUnavailable):
        readiness.require_account_import_schema('synthetic:no-network')
    assert db.calls.count(readiness._SCHEMA_SQL)==2
    assert db.calls[0]=='set transaction read only'
    assert all(cursor.closed for cursor in db.cursors)


def test_actual_worker_startup_failure_faults_owner_without_replacement(monkeypatch):
    catalog=install_catalog(monkeypatch,[{'structural_ready':False}])
    handle,=handles(monkeypatch,open=False)
    handle.owner.state=s._State.STARTING  # Scheduled startup, no real thread.
    handle.owner.start_attempted=True
    handle.owner._worker()  # Finite: actual startup gate fails before worker loop.
    assert handle.owner.state is s._State.FAULTED
    assert handle.owner.exited.is_set() and not handle.available
    assert catalog.calls.count(readiness._SCHEMA_SQL)==1
    assert handle.start(0) is False


def test_per_operation_schema_failure_never_reaches_business_chain(monkeypatch):
    catalog=install_catalog(monkeypatch,[{'structural_ready':False}])
    handle,=handles(monkeypatch)
    ticket=dispatch_prepare(handle)
    operation=handle.owner.current
    s._invoke(handle.owner)
    assert operation.delivery.outcome is s._Outcome.UNAVAILABLE
    assert operation.delivery.receipt is None
    assert operation.command is operation.intake is operation.context is operation.constraints is None
    assert not operation.cleanup_failed and operation.ticket is ticket
    assert catalog.calls.count(readiness._SCHEMA_SQL)==1


def test_catalog_statement_is_structural_inspection_not_migration_or_grant():
    sql=readiness._SCHEMA_SQL.lower()
    for fragment in ('pg_catalog','structural_ready','pg_get_expr','has_column_privilege'):
        assert fragment in sql
    assert 'create table' not in sql and 'alter table' not in sql and 'grant ' not in sql
    source=inspect.getsource(readiness.require_account_import_schema)
    assert 'pooled_connection(database_url,timeout=1.0)' in source
    assert "rows[0]['structural_ready'] is not True" in source


@pytest.mark.parametrize('rows', [[], [{'structural_ready':False}], [{'structural_ready':1}],
    [{'structural_ready':True,'extra':True}], [{'structural_ready':True}]*2,
    ({'structural_ready':True},)])
def test_mandatory_job_schema_rejects_nonexact_catalog_rows(monkeypatch, rows):
    from tests.py.foobar_account_service_readiness_testing import job_readiness
    catalog = install_catalog(monkeypatch)
    catalog.job_rows = rows
    with pytest.raises(s.SourceUnavailable):
        job_readiness.require_foobar_job_schema('synthetic:no-network')
    assert catalog.calls.count(job_readiness._SCHEMA_SQL) == 1
    assert all(cursor.closed for cursor in catalog.cursors) and catalog.exits == 1


def test_actual_worker_startup_checks_mandatory_jobs_after_account_schema(monkeypatch):
    from tests.py.foobar_account_service_readiness_testing import job_readiness
    catalog = install_catalog(monkeypatch)
    catalog.job_rows = [{'structural_ready':False}]
    handle, = handles(monkeypatch, open=False)
    handle.owner.state = s._State.STARTING
    handle.owner.start_attempted = True
    handle.owner._worker()  # Finite real startup failure; no worker replacement.
    assert handle.owner.state is s._State.FAULTED and handle.owner.exited.is_set()
    assert catalog.calls.index(readiness._SCHEMA_SQL) < catalog.calls.index(job_readiness._SCHEMA_SQL)
    assert handle.start(0) is False


def test_ordinary_prepare_rechecks_mandatory_job_schema_before_real_chain(monkeypatch):
    from tests.py.foobar_account_service_readiness_testing import job_readiness
    catalog = install_catalog(monkeypatch)
    catalog.job_rows = [{'structural_ready':False}]
    handle, = handles(monkeypatch)
    ticket = dispatch_prepare(handle)
    operation = handle.owner.current
    s._invoke(handle.owner)
    assert operation.delivery.outcome is s._Outcome.UNAVAILABLE
    assert operation.delivery.receipt is None and operation.ticket is ticket
    assert operation.command is operation.intake is operation.context is operation.constraints is None
    assert not operation.cleanup_failed
    assert catalog.calls.count(readiness._SCHEMA_SQL) == catalog.calls.count(job_readiness._SCHEMA_SQL) == 1


def test_job_schema_catalog_is_not_cached_across_operations(monkeypatch):
    from tests.py.foobar_account_service_readiness_testing import job_readiness
    catalog = install_catalog(monkeypatch)
    assert job_readiness.require_foobar_job_schema('synthetic:no-network') is None
    catalog.raise_job_query = True
    with pytest.raises(s.SourceUnavailable):
        job_readiness.require_foobar_job_schema('synthetic:no-network')
    assert catalog.calls.count(job_readiness._SCHEMA_SQL) == 2 and catalog.exits == 2


@pytest.mark.parametrize('failure', ['false_read', 'false_write', 'malformed', 'query'])
def test_actual_worker_startup_requires_history_after_both_prior_schemas(monkeypatch, failure):
    from tests.py.foobar_account_service_readiness_testing import job_readiness, history_readiness
    catalog = install_catalog(monkeypatch)
    if failure == 'false_read': catalog.history_rows[0]['history_ready'] = False
    if failure == 'false_write': catalog.history_rows[0]['history_writer_ready'] = False
    if failure == 'malformed': catalog.history_rows[0]['extra'] = True
    if failure == 'query': catalog.raise_history_query = True
    handle, = handles(monkeypatch, open=False)
    handle.owner.state = s._State.STARTING
    handle.owner.start_attempted = True
    handle.owner._worker()
    assert handle.owner.state is s._State.FAULTED and handle.owner.exited.is_set()
    assert catalog.calls.index(readiness._SCHEMA_SQL) < catalog.calls.index(job_readiness._SCHEMA_SQL)
    assert catalog.calls.index(job_readiness._SCHEMA_SQL) < catalog.calls.index(history_readiness._SCHEMA_SQL)
    assert handle.start(0) is False


def test_ordinary_prepare_requires_history_schema_without_consuming_chain(monkeypatch):
    from tests.py.foobar_account_service_readiness_testing import job_readiness, history_readiness
    catalog = install_catalog(monkeypatch)
    catalog.history_rows[0]['history_writer_ready'] = False
    handle, = handles(monkeypatch)
    ticket = dispatch_prepare(handle)
    operation = handle.owner.current
    s._invoke(handle.owner)
    assert operation.delivery.outcome is s._Outcome.UNAVAILABLE and operation.delivery.receipt is None
    assert operation.ticket is ticket and not operation.cleanup_failed
    assert operation.command is operation.context is operation.constraints is operation.intake is None
    assert catalog.calls.count(readiness._SCHEMA_SQL) == catalog.calls.count(job_readiness._SCHEMA_SQL) == 1
    assert catalog.calls.count(history_readiness._SCHEMA_SQL) == 1


def test_history_startup_schema_is_uncached_and_closes_every_cursor(monkeypatch):
    from tests.py.foobar_account_service_readiness_testing import history_readiness
    catalog = install_catalog(monkeypatch)
    assert history_readiness.require_foobar_history_schema('synthetic:no-network') is None
    catalog.history_rows[0]['history_ready'] = False
    with pytest.raises(s.SourceUnavailable):
        history_readiness.require_foobar_history_schema('synthetic:no-network')
    assert catalog.calls.count(history_readiness._SCHEMA_SQL) == catalog.exits == 2
    assert all(cursor.closed for cursor in catalog.cursors)
