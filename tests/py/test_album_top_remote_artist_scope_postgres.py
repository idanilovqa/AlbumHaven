"""Independent contract-first Artist admission through actual remote/Top owners."""
from uuid import uuid4
import pytest

from music_app.services.owned_album_tops import normalize_top_command
from tests.py.remote_top_postgres_support import remote, db, urls, evidence
from tests.py.remote_top_retention_postgres_support import retained
from tests.py.test_album_top_remote_membership_postgres import mixed, pending, record_owner_sql
from tests.py.test_album_top_artist_scope_postgres import seed_scope, descriptor, create, deny
from tests.py.test_remote_album_credited_storage_postgres import credit_facts
from tests.py.test_remote_album_credited_evidence import ARTIST, OTHER
from tests.py.test_owned_album_tops_postgres import assert_error

OUTSIDE = '23456789-1234-4234-8234-123456789abc'


def identity(case, index, mbid, state='asserted', source='synthetic_verified_credit'):
    with case.db.connect() as con:
        con.execute('''update library.local_artists set mbid=%s::uuid,
            mbid_assertion_state=%s,evidence_source=%s where library_id=%s and id=%s''',
            (mbid, state, source, case.db.library, case.db.scope_artists[index]))


@pytest.fixture
def artist_remote(mixed):
    mixed.db.scope_artists = seed_scope(mixed.db)
    for index, mbid in enumerate((ARTIST, OTHER, OUTSIDE)):
        identity(mixed, index, mbid)
    return mixed


def acquire(case, top=None, ids=(ARTIST,)):
    case.remote.facts = evidence(mbid=str(uuid4()))
    return case.acquire(top, facts=credit_facts(case.remote, ids))


def scoped_command(case, action='create', *, ids=(ARTIST,), mode='artist', local=False):
    if action == 'create':
        source = acquire(case, ids=ids)
        selections = ([{'kind': 'local_catalog', 'album_ref': case.db.album_refs[0]}] if local else []) + [pending(source)]
        command = case.command('create', title='Explicit Artist Top',
            draft_ref=source['destination']['draft_ref'], artist_scope=descriptor(case.db, mode),
            selections=selections)
    else:
        top, _ = create(case.db, mode=mode, refs=case.db.album_refs[:1] if local else [])
        source = acquire(case, top, ids)
        if action == 'add':
            command = case.command('add', top, selections=[pending(source)])
        else:
            draft = case.read(top)['edit_draft']
            existing = [{'kind': 'existing', 'item_ref': row['item_ref'],
                'album_ref': row['album_ref'], 'source': {'kind': 'unselected'}}
                for row in draft['items']]
            command = case.command('save', top, title='Explicit Artist Top',
                item_selections=[*existing, {'kind': 'new_remote', 'source': pending(source)}])
    return command, source


@pytest.mark.parametrize('action', ['create', 'add', 'save'])
@pytest.mark.parametrize('ids', [(ARTIST,), (OTHER, ARTIST), (ARTIST, ARTIST)])
def test_matching_credits_admit_through_actual_consumption_with_mixed_local_members(artist_remote, action, ids):
    case = artist_remote
    command, source = scoped_command(case, action, ids=ids, local=True)
    calls = list(case.remote.calls)
    result = case.execute(command)
    detail = case.read(result)
    assert detail['artist_scope'] == descriptor(case.db)
    assert len(detail['items']) == 2
    assert any(str(item['catalog_ref']) == case.db.album_refs[0] for item in detail['items'])
    assert case.remote.calls == calls
    assert not any(str(row['ref']) == source['acquisition_ref'] for row in case.remote.rows())
    before = case.snapshot()
    assert case.execute(command) == result
    assert case.snapshot() == before


@pytest.mark.parametrize('mode,credits,allowed', [
    ('family', (OTHER,), True), ('artist', (OTHER,), False), ('family', (OUTSIDE,), False)])
def test_exact_family_toggle_limits_remote_credit_membership(artist_remote, mode, credits, allowed):
    case = artist_remote
    command, _ = scoped_command(case, ids=credits, mode=mode)
    before = case.snapshot()
    if allowed:
        assert len(case.read(case.execute(command))['items']) == 1
    else:
        assert_error(lambda: case.execute(command), 'album_outside_artist_scope', 409)
        assert case.snapshot() == before


@pytest.mark.parametrize('mbid,state,source', [
    (None, 'missing', None), (ARTIST, 'ambiguous', 'synthetic_verified_credit'),
    (ARTIST, 'conflicting', 'synthetic_verified_credit'),
    (ARTIST, 'low_confidence', 'synthetic_verified_credit'),
    (ARTIST, 'asserted', None), ('00000000-0000-0000-0000-000000000000', 'asserted', 'synthetic_verified_credit')])
def test_unknown_local_identity_is_not_a_name_or_credit_match(artist_remote, mbid, state, source):
    case = artist_remote
    identity(case, 0, mbid, state, source)
    command, _ = scoped_command(case)
    before = case.snapshot()
    with record_owner_sql(case.db) as sql:
        assert_error(lambda: case.execute(command), 'artist_scope_unavailable', 409)
    assert case.snapshot() == before
    assert not any('app.retain_top_remote_acquisition(' in text for _, text, _ in sql)
    assert not any(text.startswith('insert into catalog.') for _, text, _ in sql)


def test_known_positive_match_survives_other_unknown_family_identity(artist_remote):
    case = artist_remote
    identity(case, 1, None, 'missing', None)
    command, _ = scoped_command(case, mode='family')
    result = case.execute(command)
    assert len(case.read(result)['items']) == 1


def test_no_match_with_unknown_family_identity_is_unavailable_not_outside(artist_remote):
    case = artist_remote
    identity(case, 1, None, 'missing', None)
    command, _ = scoped_command(case, ids=(OUTSIDE,), mode='family')
    before = case.snapshot()
    assert_error(lambda: case.execute(command), 'artist_scope_unavailable', 409)
    assert case.snapshot() == before


def test_legacy_credit_absence_remains_unknown_even_with_matching_display(artist_remote):
    case = artist_remote
    command, _ = scoped_command(case, ids=None)
    before = case.snapshot()
    assert_error(lambda: case.execute(command), 'artist_scope_unavailable', 409)
    assert case.snapshot() == before


def test_current_artist_browse_denial_cannot_be_replaced_by_valid_remote_credits(artist_remote):
    case = artist_remote
    command, _ = scoped_command(case)
    before = case.snapshot()
    assert_error(lambda: case.execute(command, constraints=deny('artist', case.db.scope_artists[0])),
        'artist_scope_unavailable', 404)
    assert case.snapshot() == before


def test_ordinary_top_uses_no_artist_scope_queries_or_locks(artist_remote):
    case = artist_remote
    identity(case, 0, None, 'missing', None)
    source = acquire(case, ids=None)
    command = case.command('create', title='Ordinary', draft_ref=source['destination']['draft_ref'],
        selections=[pending(source)])
    with record_owner_sql(case.db) as sql:
        result = case.execute(command)
    assert 'artist_scope' not in case.read(result)
    assert not any('library.local_artists' in text for _, text, _ in sql)
