"""AUTHORED ONLY. Genuine Enhanced reader/authority composition, not a test pass.

Only controlled connection results and time are substituted. Native SQL/schema,
query plans, migrations, live data and deployment remain separately gated.
"""
from copy import deepcopy
from dataclasses import asdict, replace
import pytest

from tests.py.foobar_enhanced_history_v4_testing import checked_enhanced_driver
from tests.py.foobar_enhanced_history_v4_testing import (
    install, invoke, context, read_only, materialize, bound_row, entry_rows,
    position, reference, assert_no_side_effects, reader, readiness, entry_readiness,
    account_authority, PolicyEvaluationConstraints, SOURCE, OTHER_SOURCE, OBS,
    EPOCH, BASE, UNRESOLVED,
)


def test_forward_three_pages_keep_equal_timestamp_ordinals_without_overlap(monkeypatch):
    db = install(monkeypatch)
    # Independent expected SQL rowsets: the same genuine instant occurs 43
    # times, but each original position is retained rather than deduplicated.
    rows = entry_rows((BASE,) * 43)
    db.page(list(reversed(rows[22:43])))
    first = invoke()
    assert [i.entry.ordinal for i in first.items] == list(range(42, 22, -1))
    assert first.next_cursor == position(rows[23]) and first.previous_cursor is None
    db.page(list(reversed(rows[2:23])), anchor=first.next_cursor)
    middle = invoke(anchor=first.next_cursor)
    assert [i.entry.ordinal for i in middle.items] == list(range(22, 2, -1))
    assert middle.next_cursor == position(rows[3])
    assert middle.previous_cursor == position(rows[22], way='newer')
    db.page(list(reversed(rows[:3])), anchor=middle.next_cursor)
    last = invoke(anchor=middle.next_cursor)
    assert [i.entry.ordinal for i in last.items] == [2, 1, 0]
    assert last.next_cursor is None and last.previous_cursor == position(rows[2], way='newer')
    all_items = first.items + middle.items + last.items
    assert len({(i.observation_ref, i.entry.ordinal) for i in all_items}) == 43
    assert {i.entry.raw_filetime_ticks for i in all_items} == {str(BASE)}
    assert db.checkouts == db.commits == db.exits == 3
    assert db.calls.count(readiness._SCHEMA_SQL) == db.calls.count(entry_readiness._SQL) == 3
    assert_no_side_effects(db)


def test_reverse_uses_nearest_ascending_selection_drops_distant_sentinel(monkeypatch):
    db = install(monkeypatch)
    rows = entry_rows(tuple(BASE + i for i in range(63)))
    anchor = position(rows[2], way='newer')
    # Ascending selection picks ordinals 3..23, outer query displays 23..3.
    # The farthest/newest sentinel (23) must be dropped, not the nearest (3).
    db.page(list(reversed(rows[3:24])), anchor=anchor)
    page = invoke(anchor=anchor)
    assert [i.entry.ordinal for i in page.items] == list(range(22, 2, -1))
    assert page.previous_cursor == position(rows[22], way='newer')
    assert page.next_cursor == position(rows[3])
    db.page(list(reversed(rows[23:44])), anchor=page.previous_cursor)
    newer = invoke(anchor=page.previous_cursor)
    assert [i.entry.ordinal for i in newer.items] == list(range(42, 22, -1))
    db.page(list(reversed(rows[43:63])), anchor=newer.previous_cursor)
    newest = invoke(anchor=newer.previous_cursor)
    assert [i.entry.ordinal for i in newest.items] == list(range(62, 42, -1))
    assert newest.previous_cursor is None and newest.next_cursor == position(rows[43])
    assert_no_side_effects(db)


def test_equal_timestamp_across_observations_and_unresolved_undated_tail(monkeypatch):
    db = install(monkeypatch)
    rows = entry_rows((UNRESOLVED, BASE, BASE, 0), observation=reference(2))
    other = entry_rows((BASE,), observation=reference(1))[0]
    # Literal expected tuple order, not the reader's own sorting algorithm.
    db.page([rows[2], rows[1], other, rows[3], rows[0]])
    page = invoke()
    assert [(i.observation_ref, i.entry.ordinal) for i in page.items] == [
        (reference(2), 2), (reference(2), 1), (reference(1), 0),
        (reference(2), 3), (reference(2), 0)]
    assert [i.entry.state for i in page.items] == ['resolved'] * 3 + ['unresolved'] * 2
    assert [i.entry.sort_key for i in page.items[-2:]] == [reader.MIN_KEY] * 2
    assert page.items[-1].entry.raw_filetime_ticks == str(UNRESOLVED)
    assert page.items[-2].entry.iso_utc is None and page.items[-2].entry.code is not None
    assert page.items[-2].entry.raw_filetime_ticks == '0'
    assert all(i.entry.local_provenance == 'incomplete_possibly_seeded' for i in page.items)


def test_sub_microsecond_precision_survives_without_number_coercion(monkeypatch):
    db = install(monkeypatch)
    rows = entry_rows((EPOCH + 1, EPOCH + 2))
    db.page([rows[1], rows[0]])
    page = invoke()
    assert [i.entry.unix_100ns for i in page.items] == ['2', '1']
    assert [i.entry.iso_utc for i in page.items] == [
        '1970-01-01T00:00:00.0000002Z', '1970-01-01T00:00:00.0000001Z']


def test_cached_lastfm_is_preserved_only_in_evidence_not_local_history(monkeypatch):
    db = install(monkeypatch)
    rows = entry_rows((BASE, BASE), cached=(BASE + 99, BASE + 99, UNRESOLVED))
    db.page([rows[1], rows[0]])
    page = invoke()
    assert len(page.items) == 2
    assert [i.entry.ordinal for i in page.items] == [1, 0]
    assert all(i.header.local_entry_count == 2 for i in page.items)
    assert all(i.entry.raw_filetime_ticks == str(BASE) for i in page.items)
    assert 'cached_lastfm' not in repr(asdict(page))
    assert all('cached_lastfm' not in sql.lower() for sql in db.page_calls)
    local_header, unused = materialize((BASE, BASE))
    assert page.items[0].header.local_vector_sha256 == local_header.local_vector_sha256
    assert page.items[0].header.effective_evidence_sha256 != local_header.effective_evidence_sha256


def test_records_include_empty_unavailable_and_cached_only_without_local_entries(monkeypatch):
    db = install(monkeypatch)
    records = []
    for index, arguments in enumerate((dict(ticks=()), dict(unavailable=True),
            dict(ticks=(), cached=(BASE,)), dict(ticks=(BASE,))), start=1):
        header, unused = materialize(store_key=index, **arguments)
        records.append(bound_row(header, observation=reference(index)))
    db.page(list(reversed(records)), view='records')
    page = invoke(view='records')
    assert [i.observation_ref for i in page.items] == [reference(i) for i in (4, 3, 2, 1)]
    assert [i.header.local_entry_count for i in page.items] == [1, 0, None, 0]
    assert all(i.entry is None for i in page.items)
    assert page.next_cursor is None and page.previous_cursor is None
    assert db.calls.index(entry_readiness._SQL) < db.calls.index(reader._RECORDS_INDEX_SQL)
    assert db.calls.index(reader._RECORDS_INDEX_SQL) < db.calls.index(reader._LOCK)
    assert_no_side_effects(db)


def test_records_keysets_both_directions_use_identity_not_event_time(monkeypatch):
    db = install(monkeypatch)
    header, unused = materialize(())
    rows = [bound_row(header, observation=reference(i)) for i in range(1, 44)]
    db.page(list(reversed(rows[22:43])), view='records')
    first = invoke(view='records')
    assert first.next_cursor == position(rows[23], view='records')
    db.page(list(reversed(rows[2:23])), view='records', anchor=first.next_cursor)
    second = invoke(view='records', anchor=first.next_cursor)
    assert second.previous_cursor == position(rows[22], view='records', way='newer')
    db.page(list(reversed(rows[23:43])), view='records', anchor=second.previous_cursor)
    back = invoke(view='records', anchor=second.previous_cursor)
    assert back.items == first.items and back.previous_cursor is None
    assert all(i.entry is None for i in back.items)


@pytest.mark.parametrize('change', ['foreign_account', 'foreign_source', 'revision'])
def test_cursor_scope_and_revision_fence_reject_before_page_query(monkeypatch, change):
    db = install(monkeypatch)
    row = entry_rows((BASE,))[0]
    anchor = position(row)
    if change == 'foreign_account': anchor = replace(anchor, account_id=2)
    if change == 'foreign_source': db.sources.clear()
    if change == 'revision': db.sources[(1, SOURCE)] = 2
    with pytest.raises(reader.SourceStale):
        invoke(anchor=anchor)
    assert not db.page_calls and db.commits == 0
    if change == 'foreign_account': assert reader._LOCK not in db.calls


def test_changed_revision_invalidates_previous_cursor_even_with_unchanged_rows(monkeypatch):
    db = install(monkeypatch)
    rows = entry_rows((BASE,) * 21)
    db.page(list(reversed(rows)))
    page = invoke()
    db.sources[(1, SOURCE)] = 2
    with pytest.raises(reader.SourceStale): invoke(anchor=page.next_cursor)
    assert len(db.page_calls) == 1 and db.checkouts == db.exits == 2 and db.commits == 1


@pytest.mark.parametrize('condition', ['inactive', 'revoked', 'foreign_target', 'policy_denied'])
def test_current_authority_not_ambient_library_grants_controls_reader(monkeypatch, condition):
    db = install(monkeypatch)
    ctx = context()
    constraints = read_only
    if condition == 'inactive': db.active = False
    if condition == 'revoked': db.session_live = False
    if condition == 'foreign_target': ctx = replace(ctx, target_account_id=2)
    if condition == 'policy_denied':
        constraints = PolicyEvaluationConstraints(request_origin_allowed=False)
    with pytest.raises(reader.SourceStale): invoke(ctx=ctx, constraints=constraints)
    assert not db.page_calls and db.commits == 0
    assert reader._LOCK not in db.calls
    assert_no_side_effects(db)


@pytest.mark.parametrize('condition', ['revoked', 'final_policy_denied', 'uncertain_exit'])
def test_fully_decoded_page_never_escapes_failed_exit_authority(monkeypatch, condition):
    db = install(monkeypatch)
    db.page(entry_rows((BASE,)))
    if condition == 'revoked':
        def after(driver, sql):
            if 'chosen as materialized' in sql: driver.session_live = False
        db.after = after
    if condition == 'uncertain_exit': db.lose_ack = True
    policy_calls = []
    def constraints(target):
        policy_calls.append(target)
        read_only(target)
        return PolicyEvaluationConstraints(request_origin_allowed=not (
            condition == 'final_policy_denied' and len(policy_calls) == 3))
    expected = reader.SourceUnavailable if condition == 'uncertain_exit' else reader.SourceStale
    with pytest.raises(expected): invoke(constraints=constraints)
    assert len(db.page_calls) == 1 and db.commits == 0 and db.exits == 1
    assert_no_side_effects(db)


@pytest.mark.parametrize('view', ['entries', 'records'])
@pytest.mark.parametrize('schema', ['history', 'entries'])
def test_partial_schema_refuses_before_source_lock_no_startup_repair(monkeypatch, view, schema):
    db = install(monkeypatch)
    sql = readiness._SCHEMA_SQL if schema == 'history' else entry_readiness._SQL
    db.overrides[sql] = ([dict(history_ready=False, history_writer_ready=True)] if schema == 'history'
        else [dict(entries_ready=False, entries_writer_ready=True)])
    with pytest.raises(reader.SourceUnavailable): invoke(view=view)
    assert reader._LOCK not in db.calls and not db.page_calls and not db.commits
    assert_no_side_effects(db)


@pytest.mark.parametrize('rows', [[], [dict(ready=False)], [dict(ready=1)],
    [dict(ready=True), dict(ready=True)], [dict(ready=True, extra=True)]])
def test_records_partial_index_probe_is_exact_fail_closed(monkeypatch, rows):
    db = install(monkeypatch)
    db.overrides[reader._RECORDS_INDEX_SQL] = rows
    with pytest.raises(reader.SourceUnavailable): invoke(view='records')
    assert reader._LOCK not in db.calls and not db.page_calls
    assert db.cursors[-1].closed


@pytest.mark.parametrize('field,value', [
    ('source_revision', 2), ('header_revision', 2), ('current_revision', 2),
    ('evidence_kind', 'tsv_snapshot'), ('header_sha256', '0' * 64),
    ('entry_sha256', '0' * 64), ('effective_sha256', '0' * 64),
    ('current_effective_sha256', '0' * 64), ('display_sha256', '0' * 64),
    ('current_display_sha256', '0' * 64), ('local_vector_sha256', '0' * 64),
    ('local_entry_count', 0), ('ordinal', True), ('ordinal', 1),
    ('sort_key', True), ('sort_key', 0), ('resolved', 1),
    ('raw_filetime_le', b'\0' * 8), ('header_bytes', None), ('entry_bytes', None),
])
def test_durable_scalar_codec_and_current_revision_disagreements_fail(monkeypatch, field, value):
    db = install(monkeypatch)
    row = entry_rows((BASE,))[0]
    row[field] = value
    db.page([row])
    with pytest.raises(reader.SourceUnavailable): invoke()
    assert db.commits == 0 and db.exits == 1


@pytest.mark.parametrize('damage', ['duplicate', 'ascending', 'anchor_equal', 'wrong_side'])
@pytest.mark.parametrize('direction', ['older', 'newer'])
def test_malformed_driver_order_and_cursor_membership_are_rejected(monkeypatch, damage, direction):
    db = install(monkeypatch)
    rows = entry_rows(tuple(BASE + i for i in range(5)))
    anchor = position(rows[2], way=direction)
    selected = [rows[1], rows[0]] if direction == 'older' else [rows[4], rows[3]]
    if damage == 'duplicate': selected = [selected[0], deepcopy(selected[0])]
    if damage == 'ascending': selected.reverse()
    if damage == 'anchor_equal': selected = [rows[2]]
    if damage == 'wrong_side': selected = [rows[4] if direction == 'older' else rows[0]]
    db.page(selected, anchor=anchor)
    with pytest.raises(reader.SourceUnavailable): invoke(anchor=anchor)
    assert db.commits == 0


def test_twenty_second_row_overflow_closes_bounded_cursor(monkeypatch):
    db = install(monkeypatch)
    db.page(list(reversed(entry_rows((BASE,) * 22))))
    with pytest.raises(reader.SourceUnavailable): invoke()
    assert db.fetches[-1][1:] == ('many', 22) and db.cursors[-1].closed
    assert db.commits == 0


@pytest.mark.parametrize('change', ['dict_request', 'bad_view', 'bad_source', 'bool_account',
    'negative_revision', 'bool_key', 'bad_direction', 'negative_entry_ordinal', 'wrong_view'])
def test_exact_request_types_reject_before_connection(monkeypatch, change):
    db = install(monkeypatch)
    anchor = position(entry_rows((BASE,))[0])
    req = reader.EnhancedHistoryRequest(SOURCE, 'entries', anchor)
    if change == 'dict_request': req = asdict(req)
    if change == 'bad_view': req = replace(req, view='cached_lastfm')
    if change == 'bad_source': req = replace(req, source_ref='not-a-uuid')
    if change == 'bool_account': req = replace(req, cursor=replace(anchor, account_id=True))
    if change == 'negative_revision': req = replace(req, cursor=replace(anchor, source_revision=-1))
    if change == 'bool_key': req = replace(req, cursor=replace(anchor, sort_key=True))
    if change == 'bad_direction': req = replace(req, cursor=replace(anchor, direction='sideways'))
    if change == 'negative_entry_ordinal': req = replace(req, cursor=replace(anchor, ordinal=-1))
    if change == 'wrong_view': req = replace(req, cursor=replace(anchor, view='records'))
    with pytest.raises(reader.history.FoobarHistoryInvalid): invoke(req=req)
    assert not db.calls and db.checkouts == 0


@pytest.mark.parametrize('direction,operator,order', [('older', '<', 'desc'), ('newer', '>', 'asc')])
def test_entry_sql_literal_keyset_contract_not_a_query_plan_claim(direction, operator, order):
    sql = reader._sql('entries', True, direction)
    assert 'from integration.foobar_import_local_entries_v1 e' in sql
    assert 'e.account_id=(select account_id from x) and e.source_ref=(select source_ref from x)' in sql
    assert '(e.sort_key,e.observation_ref,e.source_ordinal)' + operator + '((select sort_key from x),(select observation_ref from x),(select ordinal from x))' in sql
    assert 'order by e.sort_key ' + order + ',e.observation_ref ' + order + ',e.source_ordinal ' + order + ' limit 21' in sql
    assert sql.rstrip().endswith('order by c.sort_key desc,c.observation_ref desc,c.ordinal desc')
    assert 'octet_length(e.projection_bytes) between 1 and 512' in sql
    assert 'octet_length(p.projection_bytes) between 1 and 2048' in sql
    assert '(o.account_id,o.source_ref,o.observation_ref,o.current_revision)' in sql
    assert 'offset' not in sql.lower() and 'cached_lastfm' not in sql.lower()
    assert 'e.resolved=true' not in sql.lower() and 'e.resolved is true' not in sql.lower()
    assert reader._LOCK.rstrip().endswith('for share')


@pytest.mark.parametrize('direction,operator,order', [('older', '<', 'desc'), ('newer', '>', 'asc')])
def test_records_sql_separate_partial_identity_index_contract(direction, operator, order):
    sql = reader._sql('records', True, direction)
    assert "p.evidence_kind='enhanced_store'" in sql
    assert 'p.observation_ref' + operator + '(select observation_ref from x)' in sql
    assert 'order by p.observation_ref ' + order + ' limit 21' in sql
    assert 'foobar_import_local_entries_v1' not in sql
    assert 'cached_lastfm' not in sql.lower() and 'offset' not in sql.lower()
    catalog = reader._RECORDS_INDEX_SQL
    assert "ix.relname='foobar_enhanced_records_v1'" in catalog
    assert "array['account_id','source_ref','observation_ref']::text[]" in catalog
    assert 'i.indisvalid and i.indisready and i.indislive and i.indimmediate' in catalog
    assert "(evidence_kind = ''enhanced_store''::text)" in catalog
    assert 'array[0,0,3]::smallint[]' in catalog
