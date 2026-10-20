"""Actual caller/source binding and saved-copy scope regressions."""
from uuid import uuid4
import pytest
from tests.py.remote_top_postgres_support import remote, db, urls, CONTEXT, evidence
from tests.py.remote_top_retention_postgres_support import retained
from tests.py.test_album_top_remote_membership_postgres import mixed, pending
from tests.py.test_album_top_collaboration_postgres import member, new_session
from tests.py.test_album_top_remote_artist_scope_postgres import (
    artist_remote, identity, scoped_command, acquire, descriptor, deny, ARTIST, OTHER, OUTSIDE,
)
from tests.py.test_remote_album_credited_storage_postgres import credit_facts
from tests.py.test_owned_album_tops_postgres import assert_error
from music_app.services.owned_album_tops import BROWSE, CREATE


def test_foreign_library_artist_identity_cannot_match_current_scope(artist_remote):
    case = artist_remote
    identity(case, 0, OTHER)
    with case.db.connect() as con:
        library = case.db.library_for(con, case.db.owner)
        con.execute('''insert into library.local_artists(library_id,artist_key,name,mbid,
            mbid_assertion_state,evidence_source) values(%s,%s,'Unrelated Artist',%s::uuid,'asserted','synthetic_verified_credit')''',
            (library, str(uuid4()), ARTIST))
    command, _ = scoped_command(case)
    before = case.snapshot()
    assert_error(lambda: case.execute(command), 'album_outside_artist_scope', 409)
    assert case.snapshot() == before


def test_denied_family_artist_does_not_supply_matching_credit_identity(artist_remote):
    case = artist_remote
    command, _ = scoped_command(case, ids=(OTHER,), mode='family')
    before = case.snapshot()
    assert_error(lambda: case.execute(command, constraints=deny('artist', case.db.scope_artists[1])),
        'album_outside_artist_scope', 409)
    assert case.snapshot() == before


@pytest.mark.parametrize('change', ['context', 'session', 'retired'])
def test_valid_scope_credits_do_not_replace_pending_source_binding(artist_remote, change):
    case = artist_remote
    command, source = scoped_command(case)
    context, actor = CONTEXT, case.db.owner
    if change == 'context':
        context = 'b' * 64
    elif change == 'session':
        actor = new_session(case.db, actor)
    else:
        case.remote.retire_pending(source['acquisition_ref'])
    before = case.snapshot()
    assert_error(lambda: case.db.service.execute(case.db.context(actor), command, context_ref=context),
        'remote_evidence_unavailable', 409)
    assert case.snapshot() == before


def test_scope_credit_match_cannot_override_revoked_current_session(artist_remote):
    case = artist_remote
    command, _ = scoped_command(case)
    with case.db.connect() as con:
        con.execute('update app.account_sessions set revoked_at=clock_timestamp() where id=%s',
            (case.db.owner.session_id,))
    before = case.snapshot()
    assert_error(lambda: case.execute(command), 'forbidden', 403)
    assert case.snapshot() == before


def test_copy_preserves_scope_but_future_addition_uses_actual_copier_authority(artist_remote):
    case = artist_remote
    command, _ = scoped_command(case)
    top = case.execute(command)
    top = case.execute(case.command('visibility', top, visibility='server_shared'))
    copier = member(case.db, grants=(BROWSE, CREATE))
    copied = case.execute(case.command('copy', top), actor=copier)
    assert case.read(copied, copier)['artist_scope'] == descriptor(case.db)
    case.remote.facts = evidence(mbid=str(uuid4()))
    source = case.acquire(copied, actor=copier, facts=credit_facts(case.remote))
    add = case.command('add', copied, selections=[pending(source)])
    before = case.snapshot()
    assert_error(lambda: case.execute(add, actor=copier,
        constraints=deny('artist', case.db.scope_artists[0])), 'artist_scope_unavailable', 404)
    assert case.snapshot() == before


def test_visible_family_change_after_receipt_rolls_back_new_remote_member(artist_remote):
    case = artist_remote
    command, _ = scoped_command(case, mode='family', ids=(OTHER,))
    before = case.snapshot()
    seen = []
    def after(sql, connection):
        if sql.startswith('insert into app.album_list_operations '):
            # Deliberate privileged fixture mutation without normal library
            # publication, proving visible final recheck, not writer serialization.
            with case.db.connect() as writer:
                writer.execute("set local lock_timeout='1s'")
                writer.execute("set local statement_timeout='3s'")
                writer.execute('delete from library.local_artist_family_links where library_id=%s and artist_id=%s',
                    (case.db.library, case.db.scope_artists[0]))
            seen.append(True)
    case.remote.after_statement = after
    try:
        assert_error(lambda: case.execute(command), 'artist_scope_changed', 409)
    finally:
        case.remote.after_statement = None
    assert seen == [True]
    assert case.snapshot() == before
