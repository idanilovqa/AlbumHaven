"""AUTHORED ONLY: genuine repository with typed, bounded SQL-result driver."""
from copy import deepcopy
from dataclasses import replace
from datetime import timedelta

import pytest

from tests.py.foobar_account_job_discovery_testing import (
    install, seed, listed, discovery as d, readiness as r, requested_context,
    account_authority, SOURCE, JOB, STAMP,
)


def test_all_four_fixed_queries_paginate_twenty_plus_one_without_source_or_library_authority(monkeypatch):
    db = install(monkeypatch)
    seed(db)
    seed(db, 8, account_id=2)
    db.discovery_rows[0]['confirmed_rows'] = 100000
    for unfinished in (False, True):
        cursor, seen, sizes = None, [], []
        while True:
            page = listed(db, unfinished=unfinished, cursor=cursor, context=requested_context(7))
            sizes.append(len(page.items))
            seen.extend(item.job_ref for item in page.items)
            cursor = page.next_cursor
            if cursor is None:
                break
        assert sizes == ([20, 20, 2] if unfinished else [20, 20, 3])
        assert len(seen) == len(set(seen)) == (42 if unfinished else 43)
    assert set(sql for sql, frame in db.discovery_frames) == set(d._LIST_SQL.values())
    assert all(frame['account_id'] == 1 for sql, frame in db.discovery_frames)
    assert d.current_foobar_account_transaction is account_authority.current_foobar_account_transaction
    assert not db.locked_sources and not db.job_rows and not db.attempts
    assert not any('library_membership' in sql or 'track_preferences' in sql for sql in db.calls)
    for sql in d._LIST_SQL.values():
        assert 'where j.account_id=(select account_id from x)' in sql
        assert 'order by j.updated_at desc,j.source_ref desc,j.job_ref desc limit 21' in sql
        assert 'offset' not in sql.lower() and 'select *' not in sql.lower()


def test_foreign_cursor_is_position_not_existence_or_ownership_oracle(monkeypatch):
    db = install(monkeypatch)
    seed(db, 25)
    foreign = d.FoobarJobListCursor(STAMP, SOURCE, JOB)
    without = listed(db, cursor=foreign)
    seed(db, 1, account_id=2)
    db.discovery_rows[-1].update(source_ref=SOURCE, job_ref=JOB)
    assert listed(db, cursor=foreign) == without
    assert all(frame['account_id'] == 1 for sql, frame in db.discovery_frames)


def test_keyset_ties_use_source_then_job_and_updates_do_not_claim_frozen_history(monkeypatch):
    db = install(monkeypatch)
    seed(db, 25)
    db.discovery_rows[0]['source_ref'] = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
    first = listed(db)
    assert first.items[0].source_ref == db.discovery_rows[0]['source_ref']
    moved = db.discovery_rows[1]
    moved['updated_at'] += timedelta(seconds=1)
    second = listed(db, cursor=first.next_cursor)
    assert moved['job_ref'] not in {item.job_ref for item in second.items}
    assert listed(db).items[0].job_ref == moved['job_ref']
    assert not set(item.job_ref for item in first.items) & set(item.job_ref for item in second.items)


@pytest.mark.parametrize('stamp', [None, True, '', '2026-10-23T00:00:00Z',
    '2026-10-23T00:00:00.000000+00:00', '2026-10-23T00:00:00.00000Z',
    '2026-02-30T00:00:00.000000Z', '2026-10-23T24:00:00.000000Z',
    '2026-10-23T00:00:60.000000Z', '２０２６-10-23T00:00:00.000000Z'])
def test_noncanonical_timestamp_rejected_before_database(monkeypatch, stamp):
    db = install(monkeypatch)
    with pytest.raises(d.FoobarJobListInvalid):
        listed(db, cursor=d.FoobarJobListCursor(stamp, SOURCE, JOB))
    assert not db.calls


@pytest.mark.parametrize('cursor', [{}, (STAMP, SOURCE, JOB),
    d.FoobarJobListCursor(STAMP, 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', JOB),
    d.FoobarJobListCursor(STAMP, SOURCE, JOB.replace('-', ''))])
def test_cursor_type_and_uuid_are_strict_before_database(monkeypatch, cursor):
    db = install(monkeypatch)
    with pytest.raises(d.FoobarJobListInvalid):
        listed(db, cursor=cursor)
    assert not db.calls


@pytest.mark.parametrize('value', [None, 0, 1, '', 'true', [], float('nan')])
def test_selector_is_boolean_not_truthiness(monkeypatch, value):
    db = install(monkeypatch)
    with pytest.raises(d.FoobarJobListInvalid):
        listed(db, unfinished=value)
    assert not db.calls


@pytest.mark.parametrize('failure', ['revoked_before', 'inactive', 'revoked_after', 'foreign_target'])
def test_real_current_account_and_native_session_reject_before_result_return(monkeypatch, failure):
    db = install(monkeypatch)
    seed(db, 1)
    context = requested_context(None)
    if failure == 'revoked_before': db.sessions[(1, 3)] = False
    if failure == 'inactive': db.accounts[1] = False
    if failure == 'revoked_after': db.discovery_after = lambda owner: owner.sessions.update({(1, 3): False})
    if failure == 'foreign_target': context = replace(context, target_account_id=2)
    with pytest.raises(account_authority.SourceStale):
        listed(db, context=context)
    assert db.commits == 0
    if failure != 'revoked_after': assert not db.discovery_frames


@pytest.mark.parametrize('bad', ['too_many', 'duplicate', 'extra', 'nan', 'bool_count',
    'negative', 'over_total', 'non_bool_pause', 'naive', 'reverse_dates', 'string_date'])
def test_typed_driver_and_projection_refuse_unbounded_nonfinite_or_inconsistent_rows(monkeypatch, bad):
    db = install(monkeypatch)
    seed(db, 1)
    row = {key: value for key, value in db.discovery_rows[0].items() if key != 'account_id'}
    rows = [row]
    if bad == 'too_many': rows *= 22
    elif bad == 'duplicate': rows *= 2
    elif bad == 'extra': row['private_payload'] = 'must not escape'
    elif bad == 'nan': row['confirmed_rows'] = float('nan')
    elif bad == 'bool_count': row['confirmed_rows'] = True
    elif bad == 'negative': row['confirmed_rows'] = -1
    elif bad == 'over_total': row['confirmed_rows'] = 100001
    elif bad == 'non_bool_pause': row['cancel_requested'] = 1
    elif bad == 'naive': row['updated_at'] = db.now.replace(tzinfo=None)
    elif bad == 'reverse_dates': row['created_at'] = db.now + timedelta(seconds=1)
    elif bad == 'string_date': row['updated_at'] = STAMP
    db.discovery_result_override = rows
    with pytest.raises(d.SourceUnavailable): listed(db)
    assert db.commits == 0


@pytest.mark.parametrize('rows', [[], [{'discovery_ready': False}], [{'discovery_ready': 1}],
    [{'discovery_ready': True, 'extra': True}], [{'discovery_ready': True}] * 2])
def test_discovery_readiness_failures_refuse_list_before_query(monkeypatch, rows):
    db = install(monkeypatch)
    db.discovery_catalog = rows
    with pytest.raises(d.SourceUnavailable): listed(db)
    assert not db.discovery_frames


def test_exact_catalog_predicates_are_present_without_claiming_catalog_execution():
    sql = r._SCHEMA_SQL
    for fragment in ("'foobar_import_jobs_recent_v1',NULL::text", "'foobar_import_jobs_unfinished_v1'",
        "'(confirmed_through < total_rows)'", 'i.indisvalid AND i.indisready AND i.indislive',
        'i.indnkeyatts=4 AND i.indnatts=4', 'i.indexprs IS NULL',
        'pg_catalog.pg_get_expr(i.indpred,i.indrelid) IS NOT DISTINCT FROM e.predicate',
        "ARRAY['account_id','updated_at','source_ref','job_ref']", 'ARRAY[0,3,3,3]',
        "ARRAY['int8_ops','timestamptz_ops','uuid_ops','uuid_ops']", 'op.opcdefault',
        "n.nspname='pg_catalog'", 'op.opcmethod=am.oid', 'pg_catalog.pg_inherits'):
        assert fragment in sql
    assert 'CREATE INDEX' not in sql.upper() and 'EXPLAIN' not in sql.upper()


def test_cursor_uses_twentieth_not_sentinel_and_all_sentinel_fields_are_validated(monkeypatch):
    db = install(monkeypatch)
    seed(db, 21)
    page = listed(db)
    assert page.next_cursor == d.FoobarJobListCursor(page.items[-1].updated_at,
        page.items[-1].source_ref, page.items[-1].job_ref)
    assert page.next_cursor.job_ref != db.discovery_rows[0]['job_ref']
    db.discovery_rows[0]['total_rows'] = 100001
    with pytest.raises(d.SourceUnavailable): listed(db)


def test_aware_non_utc_driver_dates_are_normalized_without_changing_instant(monkeypatch):
    from datetime import timezone
    db = install(monkeypatch)
    seed(db, 1)
    original = listed(db)
    for field in ('created_at', 'updated_at'):
        db.discovery_rows[0][field] = db.discovery_rows[0][field].astimezone(timezone(timedelta(hours=5, minutes=30)))
    assert listed(db) == original
