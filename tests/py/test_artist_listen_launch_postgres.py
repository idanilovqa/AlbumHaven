"""Real app-role authority/root lock cases; authored without executing PostgreSQL."""
from copy import deepcopy
from datetime import timedelta
import psycopg
import pytest
from music_app.services import library_browse_postgres as browse
from music_app.services import private_library_authority as authority
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.test_artist_loved_browse_projection import (
    canonical_db, loved_db, mix_db, mix_urls, receipt, add_artist, set_aliases, NAME, REF)
from tests.py.test_artist_listen_launch_projection import CREATE, BROWSE, LOVED_CREATE


@pytest.fixture
def launch_db(canonical_db):
    database = canonical_db
    with database.connect() as connection:
        database.launch_actor = database.member(connection, actions=(BROWSE, CREATE))
    return database


def inputs(database, *, identity=None, library=None):
    group = {'artist': NAME, 'albums': []}
    original = {'artist_groups': [group]}
    memo = {}; copied = deepcopy(original, memo)
    captured = receipt(group, inventory_library_id=database.library if library is None else library,
        root_artist_id=database.browse_root if identity is None else identity)
    return original, copied, memo, captured


def live_project(database, *, constraints=None, identity=None, library=None, final_clock=None):
    original, copied, memo, captured = inputs(database, identity=identity, library=library)
    with authority.current_library_transaction(database.app_url, database.context(database.launch_actor),
        constraints=constraints, connect=database.app_connect, clock=lambda: database.clock_time,
        read_only=True) as (connection, live, _):
        staged = browse.project_artist_listen_through_browse_launches(connection, context=live,
            constraints=constraints, context_ref=REF, receipts=(item for item in [captured]),
            payload=copied, copy_memo=memo, clock=final_clock or (lambda: database.clock_time))
        assert copied == original
    return staged


def test_real_top_grants_admit_without_loved_or_media_grants(launch_db):
    database = launch_db
    assert {grant.capability_key for grant in database.launch_actor.capability_grants} == {BROWSE, CREATE}
    staged = live_project(database, constraints=lambda ctx: PolicyEvaluationConstraints(
        request_origin_allowed=ctx.action != LOVED_CREATE))
    assert len(staged) == 1
    assert staged[0][2]['artist_scope'] == {'root_artist_id': str(database.browse_root), 'mode': 'artist'}


@pytest.mark.parametrize('change', ['membership', 'session', 'create_constraint'])
def test_fresh_actual_authority_rejects_revocation(launch_db, change):
    database = launch_db
    with database.connect() as connection:
        if change == 'membership':
            connection.execute('delete from library.library_memberships where account_id=%s and library_id=%s',
                (database.launch_actor.account_id, database.library))
        elif change == 'session':
            connection.execute('update app.account_sessions set revoked_at=%s where id=%s',
                (database.now, database.launch_actor.session_id))
    with pytest.raises(authority.PrivateLibraryAuthorityError):
        live_project(database, constraints=lambda ctx: PolicyEvaluationConstraints(
            request_origin_allowed=not (change == 'create_constraint' and ctx.action == CREATE)))


def test_final_session_expiry_after_root_lock_prevents_staging(launch_db):
    database = launch_db; calls = []
    def expired():
        calls.append(True)
        return database.clock_time + timedelta(days=2)
    with pytest.raises(authority.PrivateLibraryAuthorityError): live_project(database, final_clock=expired)
    assert calls == [True]


def test_deleted_root_cannot_rebind_new_same_name_identity(launch_db):
    database = launch_db; old = database.browse_root
    with database.connect() as connection:
        connection.execute('delete from library.local_artists where id=%s', (old,))
        replacement = add_artist(connection, database, NAME)
    assert replacement != old
    assert live_project(database, identity=old) == []
    assert len(live_project(database, identity=replacement)) == 1


def test_alias_reassignment_prevents_current_launch(launch_db):
    database = launch_db
    with database.connect() as connection:
        add_artist(connection, database, 'Other')
        set_aliases(connection, database, {'Alias': 'Other'}, {'Other': ['Alias']})
    assert live_project(database) == []


def test_foreign_library_same_name_receipt_never_crosses_scope(launch_db):
    database = launch_db
    with database.connect() as connection:
        foreign = add_artist(connection, database, NAME, library=database.foreign_library)
    assert live_project(database, identity=foreign, library=database.foreign_library) == []


def test_root_browse_denial_keeps_metadata_only(launch_db):
    assert live_project(launch_db, constraints=lambda ctx: PolicyEvaluationConstraints(
        request_origin_allowed=ctx.resource is None or ctx.resource.resource_kind != 'artist')) == []


def test_root_share_lock_survives_staging_until_caller_transaction_exits(launch_db):
    database = launch_db
    original, copied, memo, captured = inputs(database)
    with authority.current_library_transaction(database.app_url, database.context(database.launch_actor),
        connect=database.app_connect, clock=lambda: database.clock_time, read_only=True) as (connection, live, _):
        staged = browse.project_artist_listen_through_browse_launches(connection, context=live,
            constraints=None, context_ref=REF, receipts=[captured], payload=copied, copy_memo=memo,
            clock=lambda: database.clock_time)
        assert len(staged) == 1 and copied == original
        with pytest.raises(psycopg.Error) as caught:
            with database.connect() as writer:
                writer.execute("set local lock_timeout='100ms'")
                writer.execute("set local statement_timeout='2s'")
                writer.execute('update library.local_artists set name=name where id=%s', (database.browse_root,))
        assert caught.value.sqlstate == '55P03'
    with database.connect() as writer:
        writer.execute("set local lock_timeout='100ms'")
        writer.execute('update library.local_artists set name=name where id=%s', (database.browse_root,))
