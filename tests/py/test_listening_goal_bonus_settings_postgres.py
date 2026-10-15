"""Real account/session/receipt/SQL contracts for durable bonus preferences."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import replace
from threading import Barrier
from uuid import uuid4

import pytest

from music_app.services.listening_goals_commands import GoalsError
from music_app.services.listening_goals_postgres import PostgresListeningGoalsService
from music_app.services.listening_goal_bonus_settings import normalize_bonus_settings
from tests.py.test_listening_goal_bonus_settings import payload
from tests.py.test_listening_goals_postgres import db, urls, assert_error


@pytest.fixture
def bonus_db(db):
    try:
        yield db
    finally:
        # Existing fixture retains ownership of all account/domain teardown.
        # Remove only this suite's new preference rows using its setup role.
        with db.connect() as connection:
            connection.execute('delete from app.listening_goal_bonus_settings where account_id=any(%s)',
                               (db.account_ids,))


def rows(database):
    with database.connect() as connection:
        return connection.execute('select * from app.listening_goal_bonus_settings where account_id=any(%s)',
                                  (database.account_ids,)).fetchall()


def test_read_defaults_no_storage_and_save_replay_without_library(bonus_db):
    db = bonus_db
    before = db.snapshot()
    assert db.owner.current_library_id is None
    assert db.service.read_bonus_settings(db.context())['enabled'] is False
    assert rows(db) == [] and db.snapshot() == before
    ref = str(uuid4())  # Intent only; no Top/access is fabricated by saving it.
    command = normalize_bonus_settings(payload(enabled=True, preferred_top_refs=[ref]))
    receipt = db.service.save_bonus_settings(db.context(), command)
    assert receipt['changed'] and receipt['settings']['settings_revision'] == '2'
    assert receipt['settings']['preferred_top_refs'] == [ref]
    assert db.service.save_bonus_settings(db.context(), command) == receipt
    assert db.service.read_operation(db.context(), command.request_key) == {'status': 'committed', 'receipt': receipt}
    assert len(rows(db)) == 1
    assert db.service.read(db.context())['goal_ref'] is None and db.provider_calls == []


def test_unchanged_save_records_receipt_without_materializing_settings(bonus_db):
    db = bonus_db
    command = normalize_bonus_settings(payload())
    receipt = db.service.save_bonus_settings(db.context(), command)
    assert receipt['changed'] is False and receipt['settings']['settings_revision'] == '1'
    assert rows(db) == []
    assert db.service.save_bonus_settings(db.context(), command) == receipt


def test_disable_and_preference_changes_do_not_reset_goals_or_history(bonus_db):
    db = bonus_db
    db.add(db.acquire())
    state = db.service.read(db.context())
    db.service.execute(db.context(), db.reset_command(state))
    goal_before, history_before = db.service.read(db.context()), db.history()
    first = db.service.save_bonus_settings(db.context(), normalize_bonus_settings(payload(enabled=True)))
    second = db.service.save_bonus_settings(db.context(), normalize_bonus_settings(payload(
        settings_revision='2', enabled=False, album_mode='next')))
    assert first['changed'] and second['changed'] and not second['settings']['enabled']
    assert db.service.read(db.context()) == goal_before and db.history() == history_before


def test_conflict_account_session_and_same_key_digest_fences(bonus_db):
    db = bonus_db
    command = normalize_bonus_settings(payload(enabled=True))
    first = db.service.save_bonus_settings(db.context(), command)
    stale = normalize_bonus_settings(payload(enabled=False))
    assert_error(lambda: db.service.save_bonus_settings(db.context(), stale), 'settings_revision_conflict', 409)
    changed = normalize_bonus_settings({**command.payload(), 'album_mode': 'next'})
    assert_error(lambda: db.service.save_bonus_settings(db.context(), changed), 'idempotency_key_reused', 409)
    other = db.other_actor()
    assert db.service.read_bonus_settings(db.context(other))['settings_revision'] == '1'
    forged = replace(db.owner, session_id=other.session_id)
    assert_error(lambda: db.service.save_bonus_settings(db.context(forged), command), 'forbidden', 403)
    assert_error(lambda: db.service.read_bonus_settings(db.context(forged)), 'forbidden', 403)
    with db.connect() as connection:
        session = db.session(connection, db.owner.account_id)
    actor = replace(db.owner, session_id=session)
    assert_error(lambda: db.service.save_bonus_settings(db.context(actor), command), 'operation_unavailable', 404)
    assert db.service.save_bonus_settings(db.context(), command) == first


@pytest.mark.parametrize('same_key', [True, False])
def test_concurrent_saves_are_serialized_by_real_account_lock(bonus_db, same_key):
    db = bonus_db
    first = normalize_bonus_settings(payload(enabled=True))
    second = first if same_key else normalize_bonus_settings(payload(enabled=True, album_mode='next'))
    barrier = Barrier(2)
    @contextmanager
    def bounded_connect(url):
        with db.connector()(url) as connection:
            connection.execute("set local lock_timeout='5s'")
            connection.execute("set local statement_timeout='10s'")
            yield connection
    service = PostgresListeningGoalsService({'ALBUM_HAVEN_APP_DATABASE_URL': db.app_url},
        connect=bounded_connect, clock=lambda: db.now)
    def save(command):
        barrier.wait(timeout=10)
        try:
            return service.save_bonus_settings(db.context(), command)
        except GoalsError as error:
            return error.code
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(save, item) for item in (first, second)]
        outcomes = [future.result(timeout=20) for future in futures]
    if same_key:
        assert outcomes[0] == outcomes[1] and outcomes[0]['changed']
    else:
        assert sum(isinstance(value, dict) for value in outcomes) == 1
        assert 'settings_revision_conflict' in outcomes
    assert len(rows(db)) == 1 and rows(db)[0]['revision'] == 2


@pytest.mark.parametrize('checkpoint', ['receipt', 'final_session'])
def test_real_sql_failures_roll_back_preferences_and_receipt(bonus_db, checkpoint):
    db = bonus_db
    inserted = []
    def after(sql, params):
        if sql.startswith('insert into app.listening_goal_bonus_settings'):
            inserted.append(True)
        if inserted and ((checkpoint == 'receipt' and sql.startswith('insert into app.listening_goal_operations'))
                or (checkpoint == 'final_session' and 'from app.account_sessions' in sql and 'for update' in sql)):
            raise RuntimeError('injected post-SQL failure')
    service = db.service_for(after=after)
    before = db.snapshot()
    with pytest.raises(RuntimeError, match='injected post-SQL failure'):
        service.save_bonus_settings(db.context(), normalize_bonus_settings(payload(enabled=True)))
    assert inserted == [True] and rows(db) == [] and db.snapshot() == before


def test_runtime_has_no_delete_or_identity_update_and_revision_guard_is_real(bonus_db):
    db = bonus_db
    db.service.save_bonus_settings(db.context(), normalize_bonus_settings(payload(enabled=True)))
    import psycopg
    for sql, params, code in [
        ('delete from app.listening_goal_bonus_settings where account_id=%s', (db.owner.account_id,), '42501'),
        ('update app.listening_goal_bonus_settings set account_id=account_id where account_id=%s', (db.owner.account_id,), '42501'),
        ('update app.listening_goal_bonus_settings set revision=revision where account_id=%s', (db.owner.account_id,), '23514'),
    ]:
        with pytest.raises(psycopg.Error) as caught:
            with db.connector()(db.app_url) as connection:
                connection.execute(sql, params)
        assert caught.value.sqlstate == code
    assert rows(db)[0]['revision'] == 2


def test_expiry_after_actual_final_session_select_rolls_back_settings(bonus_db):
    from datetime import timedelta
    db = bonus_db
    inserted = []
    def after(sql, params):
        if sql.startswith('insert into app.listening_goal_bonus_settings'):
            inserted.append(True)
        if inserted and 'from app.account_sessions' in sql and 'for update' in sql:
            db.now += timedelta(days=2)
    before = db.snapshot()
    service = db.service_for(after=after)
    assert_error(lambda: service.save_bonus_settings(db.context(), normalize_bonus_settings(payload(enabled=True))),
                 'forbidden', 403)
    assert inserted == [True] and rows(db) == [] and db.snapshot() == before


def test_preferences_current_goals_and_history_survive_actual_library_removal(bonus_db):
    from music_app.services.current_actor import LibraryRelationship
    db = bonus_db
    with db.connect() as connection:
        library = connection.execute('''insert into library.libraries(owner_account_id,name)
            values(%s,%s) returning id''', (db.owner.account_id, 'Bonus preferences '+db.token)).fetchone()['id']
        db.library_ids.append(library)
        connection.execute('''insert into library.library_memberships(account_id,library_id,membership_role)
            values(%s,%s,'member')''', (db.owner.account_id, library))
    linked = replace(db.owner, current_library_id=library,
                     library_relationships=(LibraryRelationship(library, 'member', False),))
    db.add(actor=linked)
    db.service.execute(db.context(linked), db.reset_command(db.service.read(db.context(linked))))
    preferences = db.service.save_bonus_settings(db.context(linked), normalize_bonus_settings(payload(
        enabled=True, preferred_top_refs=[str(uuid4())])))['settings']
    current, history = db.service.read(db.context(linked)), db.history(actor=linked)
    with db.connect() as connection:
        connection.execute('delete from library.library_memberships where account_id=%s and library_id=%s',
                           (db.owner.account_id, library))
        connection.execute('delete from library.libraries where id=%s', (library,))
    for context in (db.context(), db.context(linked)):
        assert db.service.read_bonus_settings(context) == preferences
        assert db.service.read(context) == current
    assert db.history() == history


def test_effective_readonly_and_runtime_privileges_are_narrow(bonus_db):
    db = bonus_db
    with db.connect() as connection:
        for privilege in ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'):
            result = connection.execute('''select
                has_table_privilege('album_haven_readonly','app.listening_goal_bonus_settings',%s) as readonly,
                has_table_privilege('album_haven_app','app.listening_goal_bonus_settings',%s) as runtime''',
                (privilege, privilege)).fetchone()
            assert result == {'readonly': False, 'runtime': privilege in {'SELECT', 'INSERT'}}
        for column in ('enabled', 'revision', 'source_mode', 'selected_top_refs', 'preferred_top_refs',
                       'album_mode', 'unfinished_policy', 'updated_at'):
            assert connection.execute('''select has_column_privilege('album_haven_app',
                'app.listening_goal_bonus_settings',%s,'UPDATE') as allowed''', (column,)).fetchone()['allowed']
        for column in ('account_id', 'created_at'):
            assert not connection.execute('''select has_column_privilege('album_haven_app',
                'app.listening_goal_bonus_settings',%s,'UPDATE') as allowed''', (column,)).fetchone()['allowed']
