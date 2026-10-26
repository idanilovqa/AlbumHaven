"""AUTHORED ONLY. Strict catalog result owner and source-level DDL contracts.

Text assertions are not native FK enforcement, backfill, privileges or plan proof.
"""
import inspect
from pathlib import Path
import pytest
import music_app
from tests.py.foobar_account_history_testing import install, readiness, history


@pytest.mark.parametrize('rows', [[], [{'history_ready': False, 'history_writer_ready': True}],
    [{'history_ready': 1, 'history_writer_ready': True}],
    [{'history_ready': True, 'history_writer_ready': 1}],
    [{'history_ready': True, 'history_writer_ready': True, 'extra': True}],
    [{'history_ready': True, 'history_writer_ready': True}] * 2,
    ({'history_ready': True, 'history_writer_ready': True},)])
def test_exact_catalog_result_shape_is_required(monkeypatch, rows):
    db = install(monkeypatch); db.history_catalog = rows
    with pytest.raises(history.SourceUnavailable):
        readiness.require_foobar_history_on_connection(db)
    assert db.calls.count(readiness._SCHEMA_SQL) == 1
    assert all(cursor.closed for cursor in db.cursors)


def test_read_permission_does_not_require_writer_grant_but_writer_and_startup_do(monkeypatch):
    db = install(monkeypatch)
    db.history_catalog = [{'history_ready': True, 'history_writer_ready': False}]
    assert readiness.require_foobar_history_on_connection(db) is None
    with pytest.raises(history.SourceUnavailable):
        readiness.require_foobar_history_on_connection(db, for_write=True)
    assert db.calls.count(readiness._SCHEMA_SQL) == 2
    db.history_catalog[0]['history_ready'] = False
    with pytest.raises(history.SourceUnavailable):
        readiness.require_foobar_history_on_connection(db)
    assert db.calls.count(readiness._SCHEMA_SQL) == 3


@pytest.mark.parametrize('invalid', [1, None, 'true'])
def test_writer_mode_is_exact_bool_not_trusted_ready_input(monkeypatch, invalid):
    db = install(monkeypatch)
    with pytest.raises(history.SourceUnavailable):
        readiness.require_foobar_history_on_connection(db, for_write=invalid)
    assert not db.calls


def test_catalog_closes_cursor_on_failure_and_never_returns_success_on_query_error(monkeypatch):
    db = install(monkeypatch); db.fail_sql = readiness._SCHEMA_SQL
    with pytest.raises(history.SourceUnavailable):
        readiness.require_foobar_history_on_connection(db)
    assert db.calls == [readiness._SCHEMA_SQL]


def test_source_columns_include_nonnull_current_revision_and_exact_generated_hashes():
    sql = readiness._SCHEMA_SQL
    assert "('foobar_import_observations_v2','current_revision','int8',true,'')" in sql
    assert "('foobar_import_streams_v2','source_bytes','int8',true,'')" in sql
    assert "('foobar_import_streams_v2','source_bytes>=0andsource_bytes<=268435456')" in sql
    assert "('projection_sha256','bytea',false,'sha256(projection_bytes)')" in sql
    assert "('foobar_import_revisions_v2','evidence_sha256','bytea',false,'sha256(evidence_bytes)')" in sql
    assert "('foobar_import_revisions_v2','display_sha256','bytea',false,'sha256(display_bytes)')" in sql
    source = sql[sql.index('AND NOT EXISTS(SELECT 1 FROM source_columns'):sql.index('AND NOT EXISTS(SELECT 1 FROM keys')]
    for condition in ('a.attnotnull=e.required', 'a.attgenerated::text=CASE',
        'pg_catalog.pg_get_expr(d.adbin,d.adrelid)=e.generated', 'a.attidentity=',
        "ns.nspname='pg_catalog'", 't.typname=e.typ', 'a.atttypmod=-1', "'SELECT'"):
        assert condition in source


def test_complete_validated_reverse_fk_and_source_lifecycle_are_mandatory():
    sql = readiness._SCHEMA_SQL
    reverse = "('foobar_import_observations_v2','account_id,source_ref,observation_ref,current_revision','foobar_import_history_projection_v1','account_id,source_ref,observation_ref,source_revision','a',true)"
    forward = "('foobar_import_history_projection_v1','account_id,source_ref,observation_ref,source_revision','foobar_import_revisions_v2','account_id,source_ref,observation_ref,source_revision','c',true)"
    assert reverse in sql and forward in sql
    owner = sql[sql.index('AND NOT EXISTS(SELECT 1 FROM fks'):sql.index('AND NOT EXISTS(SELECT 1 FROM checks')]
    for token in ('c.convalidated', "c.confmatchtype='s'", "c.confupdtype='a'", 'c.condeferrable=e.deferred',
        'c.condeferred=e.deferred', 'c.cols=string_to_array(e.cols', 'c.target_cols=string_to_array(e.target_cols',
        "t.tgenabled NOT IN ('O','A')"):
        assert token in owner
    assert "current_setting('session_replication_role')='origin'" in sql
    assert 'pg_catalog.pg_inherits' in sql and "c.relpersistence='p'" in sql
    assert "('foobar_import_history_projection_v1','octet_lengthprojection_bytes>=1andoctet_lengthprojection_bytes<=8192')" in sql


def test_all_six_exact_indexes_and_eligibility_predicates_are_required():
    sql = readiness._SCHEMA_SQL
    for family in ('standard', 'enhanced'):
        assert "('foobar_history_%s_first_v2','%s_first','((evidence_kind = ''tsv_snapshot''::text) AND (%s_first IS NOT NULL))')" % (family, family, family) in sql
        assert "('foobar_history_%s_last_v2','%s_last','(evidence_kind = ''tsv_snapshot''::text)')" % (family, family) in sql
        assert "('foobar_history_%s_individual_last_v2','%s_last','((evidence_kind = ''tsv_snapshot''::text) AND %s_last_present)')" % (family, family, family) in sql
    for condition in ('i.indisvalid AND i.indisready AND i.indislive AND i.indimmediate',
        'i.indnkeyatts=4 AND i.indnatts=4', 'i.indexprs IS NULL',
        'pg_catalog.pg_get_expr(i.indpred,i.indrelid)=e.predicate',
        "ARRAY['account_id','source_ref',e.key_column,'observation_ref']", 'ARRAY[0,0,3,3]::smallint[]',
        'ARRAY[0,0,0,0]::oid[]', "ARRAY['int8_ops','uuid_ops','int8_ops','uuid_ops']", 'op.opcdefault'):
        assert condition in sql
    assert len(sql) <= readiness._MAX_SCHEMA_SQL_BYTES and sql.isascii()
    for forbidden in ('create table', 'alter table', 'grant ', 'backfill', 'set role'):
        assert forbidden not in sql.lower()


def test_readiness_startup_is_readonly_no_cache_or_ddl_and_bounded():
    body = inspect.getsource(readiness.require_foobar_history_schema)
    assert 'pooled_connection(database_url, timeout=1.0)' in body
    assert "'set transaction read only'" in body and "'set local search_path = pg_catalog'" in body
    assert 'require_foobar_history_on_connection(connection, for_write=True)' in body
    assert readiness.HISTORY_SCHEMA_PHASE_BYTES == 65536
    assert not any(token in body for token in ('commit(', 'create table', 'alter table', 'lru_cache'))
