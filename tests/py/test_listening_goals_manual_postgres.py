"""Actual SQL/domain transitions. Requires 0118 plus the forward membership schema.

Imports the existing isolated, tracked synthetic database fixture. No whole-state
JSON substitute, fake authorization, local library requirement or live provider.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier
from uuid import uuid4

import pytest

from music_app.services import listening_goals as domain
from music_app.services.listening_goals_commands import GoalsError, normalize_goal_command
from tests.py.test_listening_goals_postgres import db, urls, PERIODS


def command(db, action, album, *, period='week', actor=None, completed=True, **changes):
    state = db.service.read(db.context(actor))
    cycle = state['periods'][period]['cycle']
    value = {'request_key': str(uuid4()), 'revision': state['revision'], 'period': period,
             'expected_cycle_id': cycle['cycle_id'] if cycle else None, 'catalog_ref': album}
    if action == 'completion':
        value['completed'] = completed
    return normalize_goal_command(action, {**value, **changes})


def execute(db, action, album, **options):
    actor = options.pop('actor', None)
    value = command(db, action, album, actor=actor, **options)
    return db.service.execute(db.context(actor), value), value


def load(db):
    with db.connect() as connection:
        return db.service._load(connection, db.owner.account_id)[1]


def test_completion_and_clear_round_trip_exact_existing_domain(db):
    receipt, _ = db.add()
    album = receipt['catalog_ref']
    before = load(db)
    db.now += timedelta(seconds=1)
    selected = before['periods']['week']['current']['cycle_id']
    expected = domain.set_goal_completion(before, period='week', expected_cycle_id=selected,
        album_ref=album, viewer_ref=str(db.owner.account_id), completed=True, occurred_at=db.now)
    marked, first = execute(db, 'completion', album)
    assert marked['changed'] and load(db) == expected['state']
    assert all(view['completed'] == 1 for view in db.service.read(db.context())['periods'].values())
    snapshot = db.snapshot()
    assert db.service.execute(db.context(), first) == marked and db.snapshot() == snapshot
    duplicate, _ = execute(db, 'completion', album)
    assert not duplicate['changed'] and duplicate['revision'] == marked['revision']
    before = load(db)
    db.now += timedelta(seconds=1)
    expected = domain.set_goal_completion(before, period='month',
        expected_cycle_id=before['periods']['month']['current']['cycle_id'], album_ref=album,
        viewer_ref=str(db.owner.account_id), completed=False, occurred_at=db.now)
    cleared, _ = execute(db, 'completion', album, period='month', completed=False)
    assert cleared['changed'] and load(db) == expected['state']
    current = db.service.read(db.context())
    assert current['periods']['month']['completed'] == 0
    assert all(current['periods'][period]['completed'] == 1 for period in ('week','six-months','year'))
    assert current['periods']['week']['manual_completed_at'][album] == (db.now-timedelta(seconds=1)).isoformat()


def test_selected_removal_matches_domain_and_preserves_larger_cycles_and_history(db):
    receipt, _ = db.add()
    album = receipt['catalog_ref']
    execute(db, 'completion', album)
    db.now += timedelta(seconds=1)
    db.service.execute(db.context(), db.reset_command(db.service.read(db.context())))
    history = db.history()
    before = load(db)
    expected = domain.remove_goal_album(before, period='week',
        expected_cycle_id=before['periods']['week']['current']['cycle_id'], album_ref=album)
    removed, key = execute(db, 'remove', album)
    assert removed['changed'] and load(db) == expected['state']
    assert db.history() == history
    after = load(db)
    for period in PERIODS[1:]:
        assert after['periods'][period] == before['periods'][period]
    assert after['album_refs'] == before['album_refs']
    snapshot = db.snapshot()
    assert db.service.execute(db.context(), key) == removed and db.snapshot() == snapshot
    again, _ = execute(db, 'remove', album)
    assert not again['changed'] and again['reason'] == 'not_member'
    assert again['revision'] == removed['revision']


def test_remove_last_current_then_readd_appends_without_rewriting_admission_or_archive(db):
    provider_ref = db.group()
    evidence = db.acquire(provider_ref)
    a, _ = db.add(evidence)
    b, _ = db.add()
    album = a['catalog_ref']
    execute(db, 'completion', album)
    db.now += timedelta(seconds=1)
    for period in PERIODS:
        db.service.execute(db.context(), db.reset_command(db.service.read(db.context()), period=period))
    archives = {period: db.history(period=period) for period in PERIODS}
    prior = db.snapshot()
    admission = next(row for row in prior['listening_goal_albums'] if str(row['catalog_ref']) == album)
    for period in PERIODS:
        execute(db, 'remove', album, period=period)
    state = db.service.read(db.context())
    assert [row['catalog_ref'] for row in state['albums']] == [b['catalog_ref']]
    removed = db.snapshot()
    retained = next(row for row in removed['listening_goal_albums'] if str(row['catalog_ref']) == album)
    assert retained['current_position'] is None
    assert {k:v for k,v in retained.items() if k != 'current_position'} == {k:v for k,v in admission.items() if k != 'current_position'}
    assert {period: db.history(period=period) for period in PERIODS} == archives
    db.now += timedelta(seconds=1)
    db.payloads[provider_ref]['title'] = 'Changed provider title after removal'
    db.payloads[provider_ref]['artist-credit'][0]['name'] = 'Changed provider artist'
    fresh_evidence = db.acquire(provider_ref)
    assert fresh_evidence['evidence_ref'] != evidence['evidence_ref']
    assert fresh_evidence['evidence_version'] != evidence['evidence_version']
    assert fresh_evidence['album']['title'] == 'Changed provider title after removal'
    assert fresh_evidence['album']['artist_display'] == 'Changed provider artist'
    readded, _ = db.add(fresh_evidence)
    assert readded['catalog_ref'] == album and readded['goal_ref'] == a['goal_ref']
    current = db.service.read(db.context())
    assert [row['catalog_ref'] for row in current['albums']] == [b['catalog_ref'], album]
    active_album = next(row for row in current['albums'] if row['catalog_ref'] == album)
    assert active_album['title'] == admission['title']
    assert active_album['artist_display'] == admission['artist_display']
    for period in PERIODS:
        assert current['periods'][period]['album_refs'] == [b['catalog_ref'], album]
        assert current['periods'][period]['manual_completed_at'][album] is None
    final = db.snapshot()
    assert len(final['listening_goal_albums']) == 2
    after_admission = next(row for row in final['listening_goal_albums'] if str(row['catalog_ref']) == album)
    assert {k:v for k,v in after_admission.items() if k != 'current_position'} == {k:v for k,v in admission.items() if k != 'current_position'}
    assignments = [row for row in final['listening_goal_assignments'] if str(row['catalog_ref']) == album]
    assert len(assignments) == 2 and sum(row['removed_at'] is None for row in assignments) == 1
    assert {period: db.history(period=period) for period in PERIODS} == archives


def test_same_cycle_remove_readd_uses_new_assignment_and_order_but_keeps_larger_marks(db):
    evidence = db.acquire()
    a, _ = db.add(evidence)
    b, _ = db.add()
    execute(db, 'completion', a['catalog_ref'])
    old = load(db)
    execute(db, 'remove', a['catalog_ref'])
    db.now += timedelta(seconds=1)
    db.add(evidence)
    new = load(db)
    assert new['periods']['week']['current']['cycle_id'] == old['periods']['week']['current']['cycle_id']
    assert new['periods']['week']['current']['album_refs'] == [b['catalog_ref'], a['catalog_ref']]
    assert a['catalog_ref'] not in new['periods']['week']['current']['completion'].get(str(db.owner.account_id), {})
    for period in PERIODS[1:]:
        assert new['periods'][period] == old['periods'][period]
    assert new['album_refs'] == old['album_refs']  # Still present in larger periods.
    assert new['assignments'][-1]['assignment_id'] != old['assignments'][0]['assignment_id']


@pytest.mark.parametrize('action', ['completion','remove'])
def test_stale_revision_cycle_foreign_account_and_session_are_fail_closed(db, action):
    receipt, _ = db.add()
    value = command(db, action, receipt['catalog_ref'])
    for change, expected in [({'revision':'1'}, 'revision_conflict'),
                             ({'expected_cycle_id':str(uuid4())}, 'cycle_conflict')]:
        bad = normalize_goal_command(action, {**value.data, 'request_key':str(uuid4()), **change})
        before = db.snapshot()
        with pytest.raises(GoalsError, match=expected):
            db.service.execute(db.context(), bad)
        assert db.snapshot() == before
    foreign = db.other_actor()
    foreign_command = command(db, action, receipt['catalog_ref'], actor=foreign,
                              expected_cycle_id=value.data['expected_cycle_id'])
    before = db.snapshot()
    with pytest.raises(GoalsError, match='cycle_conflict'):
        db.service.execute(db.context(foreign), foreign_command)
    assert db.snapshot() == before
    committed = db.service.execute(db.context(), value)
    renewed = db.renewed_actor()
    with pytest.raises(GoalsError, match='operation_unavailable'):
        db.service.execute(db.context(renewed), value)
    assert db.service.read_operation(db.context(), value.request_key)['receipt'] == committed
    assert db.service.read_operation(db.context(renewed), value.request_key) == {'status':'unknown'}


@pytest.mark.parametrize('action', ['completion','remove'])
def test_failure_after_real_item_update_rolls_back_revision_items_assignment_and_receipt(db, action):
    receipt, _ = db.add()
    value = command(db, action, receipt['catalog_ref'])
    before = db.snapshot()
    hits = []
    def after(sql, params):
        if sql.startswith('update app.listening_goal_cycle_items'):
            hits.append(1)
            raise RuntimeError('synthetic rollback after actual item update')
    with pytest.raises(RuntimeError, match='synthetic rollback'):
        db.service_for(after=after).execute(db.context(), value)
    assert hits == [1] and db.snapshot() == before
    assert db.service.execute(db.context(), value)['changed'] is True


@pytest.mark.parametrize('action', ['completion','remove'])
def test_live_session_expiry_after_item_update_rolls_back(db, action):
    receipt, _ = db.add()
    value = command(db, action, receipt['catalog_ref'])
    before = db.snapshot()
    hit = []
    def after(sql, params):
        if sql.startswith('update app.listening_goal_cycle_items') and not hit:
            hit.append(1)
            db.now += timedelta(days=2)
    with pytest.raises(GoalsError, match='forbidden'):
        db.service_for(after=after).execute(db.context(), value)
    assert hit == [1] and db.snapshot() == before


def test_completion_remove_revision_race_has_one_atomic_winner(db):
    receipt, _ = db.add()
    values = [command(db, action, receipt['catalog_ref']) for action in ('completion','remove')]
    barrier = Barrier(2)
    def run(value):
        barrier.wait(timeout=10)
        try:
            return db.service.execute(db.context(), value)
        except GoalsError as error:
            return error.code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(run, values))
    assert sum(isinstance(value, dict) and value['changed'] for value in results) == 1
    assert results.count('revision_conflict') == 1
    assert len(db.snapshot()['listening_goal_operations']) == 2  # Add and sole winner.
    load(db)  # The authentic domain validates the resulting hydrated aggregate.


def test_removing_weekly_slot_then_readding_obeys_capacity_and_stable_catalog(db):
    evidence = db.acquire()
    first, _ = db.add(evidence)
    for _ in range(4):
        db.add()
    execute(db, 'remove', first['catalog_ref'])
    assert db.service.read(db.context())['periods']['week']['total'] == 4
    result, _ = db.add(evidence)
    assert result['catalog_ref'] == first['catalog_ref']
    assert db.service.read(db.context())['periods']['week']['total'] == 5
    with pytest.raises(GoalsError, match='weekly_capacity'):
        db.add()


def test_forward_privileges_are_columns_only_and_closed_rows_still_reject_updates(db):
    import psycopg
    receipt, _ = db.add()
    db.service.execute(db.context(), db.reset_command(db.service.read(db.context())))
    for sql in [
        'update app.listening_goal_cycle_items set manual_completed_at=now() where cycle_id=%s',
        'update app.listening_goal_cycle_items set removed_at=now(),manual_completed_at=null where cycle_id=%s',
        'update app.listening_goal_cycle_items set position=position+100 where cycle_id=%s',
    ]:
        before = db.snapshot()
        with pytest.raises(psycopg.Error) as caught:
            with db.connector()(db.app_url) as connection:
                connection.execute(sql, (receipt['cycle_id'],))
        assert caught.value.sqlstate == '23514'
        assert db.snapshot() == before
    with db.connect() as connection:
        for table in ['listening_goal_albums','listening_goal_assignments','listening_goal_cycle_items']:
            for privilege in ('UPDATE','DELETE','TRUNCATE'):
                assert connection.execute("select has_table_privilege('album_haven_app',%s,%s) as allowed",
                    ('app.'+table,privilege)).fetchone()['allowed'] is False
        for table,column in [('listening_goal_albums','current_position'),
                             ('listening_goal_assignments','removed_at'),
                             ('listening_goal_cycle_items','manual_completed_at'),
                             ('listening_goal_cycle_items','removed_at'),
                             ('listening_goal_cycle_items','position')]:
            assert connection.execute("select has_column_privilege('album_haven_app',%s,%s,'UPDATE') as allowed",
                ('app.'+table,column)).fetchone()['allowed'] is True


def test_reset_archives_only_survivors_and_readd_never_revives_the_old_cycle(db):
    evidence = db.acquire()
    first, _ = db.add(evidence)
    second, _ = db.add()
    execute(db, 'remove', first['catalog_ref'])
    state = db.service.read(db.context())
    old_cycle = state['periods']['week']['cycle']['cycle_id']
    db.now += timedelta(seconds=1)
    db.service.execute(db.context(), db.reset_command(state))
    archive = db.history()['cycles'][0]
    assert archive['cycle_id'] == old_cycle
    assert [row['catalog_ref'] for row in archive['albums']] == [second['catalog_ref']]
    db.add(evidence)
    assert db.history()['cycles'][0] == archive
    assert first['catalog_ref'] in db.service.read(db.context())['periods']['week']['album_refs']
    with db.connect() as connection:
        row = connection.execute('''select removed_at from app.listening_goal_cycle_items
            where account_id=%s and cycle_id=%s and catalog_ref=%s''',
            (db.owner.account_id,old_cycle,first['catalog_ref'])).fetchone()
    assert row['removed_at'] is not None


@pytest.mark.parametrize('action', ['completion','remove'])
def test_changed_request_payload_cannot_reuse_acknowledged_key(db, action):
    receipt, _ = db.add()
    value = command(db, action, receipt['catalog_ref'])
    db.service.execute(db.context(), value)
    changed = normalize_goal_command(action, {**value.data,'request_key':value.request_key,'period':'month'})
    before = db.snapshot()
    with pytest.raises(GoalsError, match='idempotency_key_reused'):
        db.service.execute(db.context(), changed)
    assert db.snapshot() == before


def test_empty_removal_is_acknowledged_without_creating_aggregate_and_completion_rejects(db):
    album = str(uuid4())
    result, value = execute(db,'remove',album)
    assert not result['changed'] and result['goal_ref'] is None and result['cycle_id'] is None
    assert result['revision'] == '1' and result['reason'] == 'not_member'
    assert db.snapshot()['listening_goals'] == []
    assert db.service.execute(db.context(),value) == result
    before = db.snapshot()
    with pytest.raises(GoalsError, match='album_not_in_period'):
        execute(db,'completion',album)
    assert db.snapshot() == before


def test_retired_assignment_and_active_order_cannot_be_rewritten_by_runtime(db):
    import psycopg
    receipt, _ = db.add()
    execute(db,'remove',receipt['catalog_ref'])
    retired = next(row for row in db.snapshot()['listening_goal_assignments'] if row['removed_at'] is not None)
    with pytest.raises(psycopg.Error) as caught:
        with db.connector()(db.app_url) as connection:
            connection.execute('update app.listening_goal_assignments set removed_at=null where assignment_id=%s',
                               (retired['assignment_id'],))
    assert caught.value.sqlstate == '23514'
    assert caught.value.diag.constraint_name == 'listening_goal_assignment_retained'
    with pytest.raises(psycopg.Error) as caught:
        with db.connector()(db.app_url) as connection:
            connection.execute('update app.listening_goal_albums set current_position=current_position+10 where account_id=%s',
                               (db.owner.account_id,))
    assert caught.value.sqlstate == '23514'
    assert caught.value.diag.constraint_name == 'listening_goal_active_order_immutable'
