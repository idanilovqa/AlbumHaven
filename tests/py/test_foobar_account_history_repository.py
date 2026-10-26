"""AUTHORED ONLY. Real reader, authority, codec and strict driver boundary.

These tests intentionally do not execute SQL and cannot certify native plans.
"""
from copy import deepcopy
from dataclasses import replace
import inspect
import pytest
from tests.py.foobar_account_history_testing import (
    install, seed, listed, all_pages, history, readiness, writer, account_authority,
    authority, read_context, read_only, PolicyEvaluationConstraints, URL,
    SOURCE, OTHER_SOURCE, OBS, FIRST, LAST, projection, bound_row, codec,
)


@pytest.mark.parametrize('mode,count', [('grouped', 43), ('individual', 86)])
@pytest.mark.parametrize('family', ['standard', 'enhanced'])
def test_genuine_reader_all_pages_are_chronological_with_no_gaps_or_duplicates(monkeypatch, mode, count, family):
    db = install(monkeypatch)
    refs = seed(db, 43)
    items, pages = all_pages(db, mode=mode, family=family)
    assert len(items) == count and len({(i.observation_ref, i.kind) for i in items}) == count
    if mode == 'grouped':
        expected = [(ref, 'grouped_aggregate') for ref in reversed(refs)]
    else:
        # Last aggregates sort ahead of earlier first markers. Pagination is NOT
        # observation-card pagination followed by per-card expansion.
        expected = [(ref, 'unknown_dates_bucket') for ref in reversed(refs)]
        expected += [(ref, 'first_boundary') for ref in reversed(refs)]
    assert [(i.observation_ref, i.kind) for i in items] == expected
    assert [len(page.items) for page in pages] == ([20, 20, 3] if mode == 'grouped' else [20, 20, 20, 20, 6])
    for page in pages[:-1]:
        last = page.items[-1]
        assert page.next_cursor.source_revision == 1
        assert (page.next_cursor.sort_key, page.next_cursor.kind, page.next_cursor.observation_ref) == (
            last.sort_key, last.kind, last.observation_ref)
    assert all(c.closed for c in db.cursors)
    assert set(db.fetch_limits) <= {2, 22}
    assert len(db.read_locks) == len(pages)
    assert not db.native_calls and not db.association_calls


@pytest.mark.parametrize('same_time', [FIRST, 'unresolved local date'])
def test_equal_time_rank_and_uuid_ties_are_strict_across_page_boundaries(monkeypatch, same_time):
    db = install(monkeypatch)
    refs = seed(db, 23, first=same_time, last=same_time)
    items, pages = all_pages(db)
    assert [(i.observation_ref, i.kind) for i in items] == (
        [(ref, 'first_boundary') for ref in reversed(refs)] +
        [(ref, 'unknown_dates_bucket') for ref in reversed(refs)])
    assert [len(p.items) for p in pages] == [20, 20, 6]
    assert pages[0].next_cursor.kind == 'first_boundary'
    assert pages[1].next_cursor.kind == 'unknown_dates_bucket'
    assert len({(i.observation_ref, i.kind) for i in items}) == 46
    if same_time.startswith('unresolved'):
        assert all(i.sort_key == codec.MIN_SORT_KEY for i in items)
        assert all(i.projection.standard.first.unix_microseconds is None for i in items)


def test_single_count_marker_has_no_second_zero_remainder_row(monkeypatch):
    db = install(monkeypatch)
    refs = seed(db, 43, first=FIRST, last=FIRST, total=1)
    items, unused = all_pages(db)
    assert [(i.observation_ref, i.kind) for i in items] == [(ref, 'first_boundary') for ref in reversed(refs)]
    grouped, unused = all_pages(db, mode='grouped')
    assert len(grouped) == 43 and all(i.projection.standard.total == 1 for i in grouped)


def test_zero_and_unavailable_rows_are_diagnostics_not_listens(monkeypatch):
    db = install(monkeypatch)
    seed(db, 1, first=None, last=None, total=0)
    page = listed(db)
    assert len(page.items) == 1 and page.items[0].kind == 'unknown_dates_bucket'
    assert page.items[0].projection.standard.total == 0
    db.history_projections.clear(); db.read_current.clear()
    seed(db, 1, first=None, last=None, total=None)
    page = listed(db)
    assert len(page.items) == 1 and page.items[0].projection.standard.status == 'unavailable'
    assert page.items[0].projection.standard.aggregate_remainder is None


@pytest.mark.parametrize('mutation', ['account', 'source', 'family', 'mode', 'revision'])
def test_cursor_cannot_change_authority_source_family_mode_or_snapshot(monkeypatch, mutation):
    db = install(monkeypatch); seed(db)
    cursor = listed(db).next_cursor
    start = len(db.calls)
    request = history.FoobarHistoryRequest(SOURCE, 'standard', 'individual', cursor)
    if mutation == 'account': request = replace(request, cursor=replace(cursor, account_id=2))
    if mutation == 'source': request = replace(request, cursor=replace(cursor, source_ref=OTHER_SOURCE))
    if mutation == 'family': request = replace(request, cursor=replace(cursor, family='enhanced'))
    if mutation == 'mode': request = replace(request, cursor=replace(cursor, mode='grouped'))
    if mutation == 'revision': db.revision += 1
    expected = history.FoobarHistoryStale if mutation in ('account', 'revision') else history.FoobarHistoryInvalid
    with pytest.raises(expected):
        history.read_foobar_history(URL, read_context(), request, constraints=read_only)
    assert not any(sql in history._LIST_SQL.values() for sql in db.calls[start:])
    if mutation in ('source', 'family', 'mode'):
        assert len(db.calls) == start


def test_account_and_source_filters_remain_independent_without_library(monkeypatch):
    db = install(monkeypatch)
    seed(db, 2, account_id=1, source_ref=SOURCE, total=2)
    seed(db, 3, account_id=1, source_ref=OTHER_SOURCE, total=7)
    seed(db, 4, account_id=2, source_ref=OTHER_SOURCE, total=9)
    assert len(listed(db, mode='grouped').items) == 2
    assert [i.projection.standard.total for i in listed(db, mode='grouped', source_ref=OTHER_SOURCE).items] == [7] * 3
    assert [i.projection.standard.total for i in listed(db, mode='grouped', source_ref=OTHER_SOURCE,
        context=read_context(2, 5)).items] == [9] * 4
    with pytest.raises(history.FoobarHistoryStale):
        listed(db, source_ref=SOURCE, context=read_context(2, 5))
    assert not db.native_calls and not db.association_calls


def test_observation_revision_can_precede_source_snapshot_revision(monkeypatch):
    db = install(monkeypatch); seed(db, 1); db.revision = 19
    page = listed(db)
    assert page.source_revision == 19 and all(i.projection.source_revision == 1 for i in page.items)
    db.revision = 0
    with pytest.raises(history.SourceUnavailable):
        listed(db)


@pytest.mark.parametrize('mutation', ['digest', 'current_revision', 'current_hash', 'indexed_key', 'indexed_flag', 'extra', 'bool_revision'])
def test_current_binding_corruption_is_unavailable_not_empty_history(monkeypatch, mutation):
    db = install(monkeypatch); seed(db, 1)
    key = next(iter(db.history_projections)); row = db.history_projections[key]
    if mutation == 'digest': row['projection_sha256'] = '0' * 64
    if mutation == 'current_revision': db.read_current[key] = (2, row['effective_evidence_sha256'], row['display_sha256'])
    if mutation == 'current_hash': db.read_current[key] = (1, '0' * 64, row['display_sha256'])
    if mutation == 'indexed_key': row['standard_last'] += 1
    if mutation == 'indexed_flag': row['standard_last_present'] = 1
    if mutation == 'extra': row['extra'] = 'private-value-must-not-leak'
    if mutation == 'bool_revision': row['source_revision'] = True
    with pytest.raises(history.SourceUnavailable) as failure:
        listed(db)
    assert 'private-value' not in str(failure.value) and all(c.closed for c in db.cursors)


@pytest.mark.parametrize('failure', ['reversed', 'duplicate', 'too_many', 'wrong_rank', 'bad_shape'])
def test_driver_results_are_strict_not_trusted_as_success(monkeypatch, failure):
    db = install(monkeypatch); seed(db, 2)
    row = bound_row(projection(play_count=2, first_played=FIRST, last_played=LAST))
    candidate = dict(row, observation_ref=OBS, sort_key=row['standard_last'], arm_rank=0)
    second = dict(candidate, observation_ref='33333333-3333-4333-8333-333333333333')
    if failure == 'reversed': db.page_override = [candidate, second]
    if failure == 'duplicate': db.page_override = [candidate, candidate]
    if failure == 'too_many': db.page_override = [candidate] * 22
    if failure == 'wrong_rank': db.page_override = [dict(candidate, arm_rank=True)]
    if failure == 'bad_shape': db.page_override = [dict(candidate, private_path='/not-for-wire')]
    with pytest.raises(history.SourceUnavailable):
        listed(db)
    assert all(c.closed for c in db.cursors)


@pytest.mark.parametrize('checkpoint', ['entry', 'exit'])
def test_real_session_owner_revocation_prevents_read_delivery(monkeypatch, checkpoint):
    db = install(monkeypatch); seed(db, 1)
    if checkpoint == 'entry': db.sessions[(1, 3)] = False
    else: db.after_page = lambda current: current.sessions.__setitem__((1, 3), False)
    with pytest.raises(history.SourceStale):
        listed(db)
    assert db.commits == 0 and db.rollbacks
    session_queries = [sql for sql in db.calls if 'from app.account_sessions' in sql]
    assert len(session_queries) == (1 if checkpoint == 'entry' else 2)


def test_real_read_authority_strips_ambient_library_and_cannot_borrow_write(monkeypatch):
    db = install(monkeypatch); seed(db, 1)
    context = read_context()
    with pytest.raises(history.SourceStale):
        account_authority.require_account_foobar(context, read_only)
    live = account_authority.require_account_foobar_read(context, read_only)
    assert live.action == 'account.self.foobar.read' and live.library_id is None
    assert live.actor.current_library_id is None and live.actor.library_relationships == ()
    assert live.actor.capability_grants == () and not live.actor.is_bootstrap_owner
    page = listed(db, context=context)
    assert page.items and not db.native_calls
    positions = [db.calls.index('select id,is_active,disabled_at from app.accounts where id=%s for update'),
        next(i for i, sql in enumerate(db.calls) if 'from app.account_sessions' in sql), db.calls.index(history._LOCK_SQL)]
    assert positions == sorted(positions)
    assert not any('insert ' in sql.lower() or 'update integration.' in sql.lower() for sql in db.calls)
    assert 'action' not in inspect.signature(account_authority.current_foobar_account_read_transaction).parameters


@pytest.mark.parametrize('deny_at', [1, 2, 3])
def test_real_read_policy_is_rechecked_at_every_transaction_boundary(monkeypatch, deny_at):
    db = install(monkeypatch); seed(db, 1)
    calls = []
    def narrowing(context):
        calls.append(context.action)
        return PolicyEvaluationConstraints(request_origin_allowed=len(calls) != deny_at)
    with pytest.raises(history.SourceStale):
        listed(db, constraints=narrowing)
    assert calls == ['account.self.foobar.read'] * deny_at and not db.commits


def test_source_selector_is_account_bound_twenty_plus_one_read_only_without_default_creation(monkeypatch):
    db = install(monkeypatch); db.source_catalog.clear()
    refs = ['00000000-0000-4000-8000-%012x' % i for i in range(1, 44)]
    for index, ref in enumerate(refs):
        db.source_catalog[(1, ref)] = dict(source_ref=ref, created_at=db.now, is_default=False, observation_count=index)
    db.source_catalog[(2, OTHER_SOURCE)] = dict(source_ref=OTHER_SOURCE, created_at=db.now, is_default=True, observation_count=7)
    items, cursor, pages = [], None, []
    while True:
        page = history.list_foobar_history_sources(URL, read_context(), cursor=cursor, constraints=read_only)
        items.extend(page.items); pages.append(page)
        if page.next_cursor is None: break
        cursor = page.next_cursor
    assert [i.source_ref for i in items] == refs and [len(p.items) for p in pages] == [20, 20, 3]
    assert pages[0].next_cursor.source_ref == refs[19] and pages[1].next_cursor.source_ref == refs[39]
    assert all(len(i.created_at) == 27 and i.created_at.endswith('Z') for i in items)
    assert not db.read_locks and not db.native_calls and not db.association_calls
    assert not any('insert ' in sql.lower() or 'update integration.' in sql.lower() for sql in db.calls)
    with pytest.raises(history.FoobarHistoryStale):
        history.list_foobar_history_sources(URL, read_context(2, 5), cursor=pages[0].next_cursor, constraints=read_only)
    db.source_catalog.clear()
    page = history.list_foobar_history_sources(URL, read_context(), constraints=read_only)
    assert page.items == () and page.next_cursor is None and not db.source_catalog


@pytest.mark.parametrize('field,value', [('source_ref', SOURCE.upper()), ('is_default', 1),
    ('observation_count', True), ('observation_count', 100001), ('created_at', '2026-01-01')])
def test_source_selector_rejects_untrusted_driver_scalars(monkeypatch, field, value):
    db = install(monkeypatch)
    # An all-digit UUID would not change under upper(); use an explicit A below.
    if field == 'source_ref': value = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
    db.source_catalog[(1, SOURCE)][field] = value
    with pytest.raises(history.SourceUnavailable):
        history.list_foobar_history_sources(URL, read_context(), constraints=read_only)


def test_six_fixed_seek_shapes_merge_before_payload_fetch_and_use_partial_eligibility():
    for family in ('standard', 'enhanced'):
        for kind, rank in (('first_boundary', 1), ('unknown_dates_bucket', 0), ('grouped_aggregate', 0)):
            column = family + ('_first' if rank else '_last')
            for cursor_kind in (None, 'first_boundary', 'unknown_dates_bucket'):
                sql = history._arm_sql(family, kind, cursor_kind)
                assert 'p.account_id=(select account_id from x)' in sql
                assert 'p.source_ref=(select source_ref from x)' in sql
                assert sql.endswith('order by p.' + column + ' desc,p.observation_ref desc limit 21')
                if rank: assert 'p.' + column + ' is not null' in sql
                if kind == 'unknown_dates_bucket': assert 'p.' + family + '_last_present' in sql
                if kind == 'grouped_aggregate': assert '_last_present' not in sql
                if cursor_kind is not None:
                    prior = int(cursor_kind == 'first_boundary')
                    if rank == prior:
                        assert '(p.' + column + ',p.observation_ref)<((select sort_key from x),(select observation_ref from x))' in sql
                    else:
                        operator = '<=' if rank < prior else '<'
                        assert 'p.' + column + operator + '(select sort_key from x)' in sql
                assert ' or ' not in sql.lower() and 'offset' not in sql.lower()
        for mode in ('grouped', 'individual'):
            sql = history._LIST_SQL[(family, mode, None)]
            assert len(sql) <= history.MAX_SQL_BYTES and sql.count('%b') == 1
            assert sql.index('limit 21') < sql.index('p.projection_bytes')
            if mode == 'individual':
                assert sql.count('limit 21') == 3 and 'union all' in sql
                assert 'order by sort_key desc,arm_rank desc,observation_ref desc limit 21' in sql
            assert not any(token in sql.lower() for token in ('library', 'lastfm', 'incoming_evidence_bytes', 'r.evidence_bytes', 'private_path'))
