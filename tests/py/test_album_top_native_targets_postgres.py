"""Saved Top native Details contracts on the admitted synthetic PostgreSQL lane."""
from datetime import timedelta
from uuid import uuid4

import pytest

from music_app.services.album_top_native_targets import AlbumTopNativeTargets
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from music_app.services.private_native_targets import PrivateNativeTargets
from tests.py.postgres_runtime_role_contract import assert_runtime_role
from tests.py.test_owned_album_tops_postgres import db, urls, assert_error
from tests.py.test_album_top_collaboration_postgres import member, write


CONTEXT = 'a' * 64
LOCK = 'app.lock_top_native_catalog_binding(uuid,uuid,bigint,bigint,uuid)'


@pytest.fixture
def bound(db):
    receipt, _ = db.create()
    return receipt, db.read(receipt)['items'][0]


def resolve(db, bound, *, actor=None, **changes):
    receipt, item = bound
    options = {'top_ref': receipt['top_ref'], 'item_ref': item['ref'],
        'revision': receipt['revision'], 'inventory_album_ref': f'inventory-album:{db.library}:{db.album_ids[0]}',
        'context_ref': CONTEXT, **changes}
    return AlbumTopNativeTargets(db.service).resolve(db.context(actor), **options)


def album_key(db, album_id):
    with db.connect() as connection:
        return connection.execute('select album_key from library.local_albums where id=%s',
                                  (album_id,)).fetchone()['album_key']


def edition(db, *, key=None, catalog_ref=None, library=None):
    library = db.library if library is None else library
    with db.connect() as connection:
        identity = connection.execute("""insert into library.local_albums(library_id,album_key,title)
            values(%s,%s,'Synthetic alternate edition') returning id""",
            (library, uuid4().hex if key is None else key)).fetchone()['id']
        if catalog_ref is not None:
            connection.execute('insert into library.catalog_album_links(library_id,local_album_id,catalog_ref) '
                'values(%s,%s,%s)', (library, identity, catalog_ref))
    return identity


@pytest.mark.parametrize('role', ['owner', 'viewer'])
def test_owner_and_explicit_viewer_open_details_without_tracks_or_media_grant(db, bound, role):
    current = db.owner
    if role == 'viewer':
        current = member(db)
        receipt, _ = write(db, 'grant_viewer', bound[0], account_id=current.account_id, role='viewer')
        bound = receipt, bound[1]
        assert db.service.read(db.context(current), top_ref=receipt['top_ref'])['allowed_actions']['can_edit'] is False
    with db.service._connect(db.app_url) as connection:
        assert_runtime_role(connection, db)
        assert connection.execute('select count(*) as n from library.local_tracks where library_id=%s',
                                  (db.library,)).fetchone()['n'] == 0
        privileges = connection.execute("""select
            has_table_privilege(current_user,'catalog.release_groups','UPDATE') as catalog_update,
            has_table_privilege(current_user,'library.catalog_album_links','UPDATE') as links_update""").fetchone()
        assert privileges == {'catalog_update': False, 'links_update': False}
    before = db.snapshot()
    result = resolve(db, bound, actor=current)
    assert result == {'top_ref': bound[0]['top_ref'], 'revision': bound[0]['revision'],
        'item_ref': bound[1]['ref'], 'catalog_ref': db.album_refs[0],
        'inventory_album_ref': f'inventory-album:{db.library}:{db.album_ids[0]}',
        'native_target': {'album_ref': album_key(db, db.album_ids[0]),
            'allowed_actions': {'can_view_details': True, 'can_play_album': False}}}
    assert resolve(db, bound, actor=current) == result
    assert db.snapshot() == before


def test_unrelated_member_cannot_resolve_a_private_top(db, bound):
    unrelated = member(db)
    before = db.snapshot()
    assert_error(lambda: resolve(db, bound, actor=unrelated), 'top_unavailable', 404)
    assert db.snapshot() == before


@pytest.mark.parametrize('scope', ['library', 'album_top', 'album'])
def test_actual_caller_browse_denial_prevents_native_identity(db, bound, scope):
    viewer = member(db)
    receipt, _ = write(db, 'grant_viewer', bound[0], account_id=viewer.account_id, role='viewer')
    bound = receipt, bound[1]

    def constraints(context):
        resource = context.resource
        targeted = resource is None if scope == 'library' else resource is not None and resource.resource_kind == scope
        denied = context.actor.account_id == viewer.account_id and context.action == 'library.browse.read' and targeted
        return PolicyEvaluationConstraints(request_origin_allowed=not denied)

    assert resolve(db, bound, constraints=constraints)['native_target']['album_ref'] == album_key(db, db.album_ids[0])
    assert_error(lambda: resolve(db, bound, actor=viewer, constraints=constraints), 'forbidden', 403)


@pytest.mark.parametrize('mismatch', ['revision', 'item', 'top', 'hint_library', 'hint_album'])
def test_stale_or_cross_resource_request_cannot_open_a_different_member(db, bound, mismatch):
    changes = {}
    code, status = 'item_unavailable', 404
    if mismatch == 'revision':
        changes['revision'] = str(int(bound[0]['revision']) + 1)
        code, status = 'revision_conflict', 409
    elif mismatch == 'item':
        changes['item_ref'] = str(uuid4())
    elif mismatch == 'top':
        other, _ = db.create()
        changes['top_ref'] = other['top_ref']
    elif mismatch == 'hint_library':
        changes['inventory_album_ref'] = f'inventory-album:{db.library + 1}:{db.album_ids[0]}'
    else:
        changes['inventory_album_ref'] = f'inventory-album:{db.library}:{db.album_ids[1]}'
        code, status = 'native_binding_changed', 409
    assert_error(lambda: resolve(db, bound, **changes), code, status)


@pytest.mark.parametrize('mapping', ['missing', 'moved', 'ambiguous', 'empty_key', 'foreign_only'])
def test_catalog_inventory_change_without_top_revision_invalidates_details(db, bound, mapping):
    if mapping == 'ambiguous':
        edition(db, catalog_ref=db.album_refs[0])
    elif mapping == 'foreign_only':
        with db.connect() as connection:
            foreign = db.library_for(connection, db.owner)
        edition(db, library=foreign, catalog_ref=db.album_refs[0])
    with db.connect() as connection:
        if mapping in {'missing', 'foreign_only'}:
            connection.execute('delete from library.catalog_album_links where local_album_id=%s', (db.album_ids[0],))
        elif mapping == 'moved':
            connection.execute('update library.catalog_album_links set catalog_ref=%s where local_album_id=%s',
                               (db.album_refs[1], db.album_ids[0]))
        elif mapping == 'empty_key':
            # Current schema requires NOT NULL; empty is the schema-valid
            # unbound edition. None is separately covered at the unit seam.
            connection.execute("update library.local_albums set album_key='' where id=%s", (db.album_ids[0],))
        assert connection.execute('select revision from app.album_lists where ref=%s',
                                  (bound[0]['top_ref'],)).fetchone()['revision'] == int(bound[0]['revision'])
    assert_error(lambda: resolve(db, bound), 'native_binding_changed', 409)


@pytest.mark.parametrize('revocation', ['session', 'capabilities', 'membership', 'viewer_grant'])
def test_stale_viewer_snapshot_cannot_survive_current_authority_revocation(db, bound, revocation):
    viewer = member(db)
    receipt, _ = write(db, 'grant_viewer', bound[0], account_id=viewer.account_id, role='viewer')
    bound = receipt, bound[1]
    assert resolve(db, bound, actor=viewer)['native_target']['allowed_actions']['can_view_details']
    with db.connect() as connection:
        if revocation == 'session':
            connection.execute('update app.account_sessions set revoked_at=now() where id=%s', (viewer.session_id,))
        elif revocation == 'capabilities':
            connection.execute('update app.capabilities set revoked_at=now() where account_id=%s', (viewer.account_id,))
        elif revocation == 'membership':
            connection.execute('delete from library.library_memberships where account_id=%s and library_id=%s',
                               (viewer.account_id, db.library))
        else:
            connection.execute('delete from app.album_list_access_grants where ref=%s', (receipt['grant_ref'],))
    assert_error(lambda: resolve(db, bound, actor=viewer),
        'top_unavailable' if revocation == 'viewer_grant' else 'forbidden', 404 if revocation == 'viewer_grant' else 403)


@pytest.mark.parametrize('scope', ['album_top', 'album'])
def test_final_browse_recheck_discards_native_target_after_resolver_returns(db, bound, monkeypatch, scope):
    original = PrivateNativeTargets.resolve_album
    resolved = False

    def after_native(self, *args, **kwargs):
        nonlocal resolved
        value = original(self, *args, **kwargs)
        resolved = True
        return value

    def constraints(context):
        denied = resolved and context.resource is not None and context.resource.resource_kind == scope
        return PolicyEvaluationConstraints(deployment_allowed=not denied)

    monkeypatch.setattr(PrivateNativeTargets, 'resolve_album', after_native)
    assert_error(lambda: resolve(db, bound, constraints=constraints), 'forbidden', 403)
    assert resolved


def test_session_expiry_during_native_resolution_discards_computed_target(db, bound, monkeypatch):
    now = [db.now]
    monkeypatch.setattr(db.service, '_clock', lambda: now[0])
    original = PrivateNativeTargets.resolve_album

    def after_native(self, *args, **kwargs):
        value = original(self, *args, **kwargs)
        now[0] += timedelta(hours=2)
        return value

    monkeypatch.setattr(PrivateNativeTargets, 'resolve_album', after_native)
    before = db.snapshot()
    assert_error(lambda: resolve(db, bound), 'forbidden', 403)
    assert db.snapshot() == before


@pytest.mark.parametrize('race', ['incoming_link', 'incoming_remap', 'remove_link', 'move_link', 'enable_empty_edition'])
def test_details_transaction_blocks_mapping_changes_until_target_is_returned(db, bound, monkeypatch, race):
    import psycopg

    extra = edition(db, key='' if race == 'enable_empty_edition' else None,
        catalog_ref=db.album_refs[0] if race == 'enable_empty_edition' else
                    db.album_refs[1] if race == 'incoming_remap' else None)
    original = PrivateNativeTargets.resolve_album
    blocked = []

    def after_native(self, *args, **kwargs):
        value = original(self, *args, **kwargs)
        with pytest.raises(psycopg.errors.LockNotAvailable):
            with db.connect() as contender:
                contender.execute("set local lock_timeout='100ms'")
                if race == 'incoming_link':
                    contender.execute('insert into library.catalog_album_links(library_id,local_album_id,catalog_ref) '
                        'values(%s,%s,%s)', (db.library, extra, db.album_refs[0]))
                elif race == 'incoming_remap':
                    contender.execute('update library.catalog_album_links set catalog_ref=%s where local_album_id=%s',
                                      (db.album_refs[0], extra))
                elif race == 'remove_link':
                    contender.execute('delete from library.catalog_album_links where local_album_id=%s', (db.album_ids[0],))
                elif race == 'move_link':
                    contender.execute('update library.catalog_album_links set catalog_ref=%s where local_album_id=%s',
                                      (db.album_refs[1], db.album_ids[0]))
                else:
                    contender.execute('update library.local_albums set album_key=%s where id=%s', (uuid4().hex, extra))
        blocked.append(race)
        return value

    monkeypatch.setattr(PrivateNativeTargets, 'resolve_album', after_native)
    assert resolve(db, bound)['native_target']['album_ref'] == album_key(db, db.album_ids[0])
    assert blocked == [race]


@pytest.mark.parametrize('mismatch', ['top', 'item', 'library', 'revision', 'catalog', 'deleted', 'null'])
def test_privileged_lock_helper_requires_exact_current_non_deleted_membership(db, bound, mismatch):
    receipt, item = bound
    parameters = [receipt['top_ref'], item['ref'], db.library, int(receipt['revision']), db.album_refs[0]]
    if mismatch == 'deleted':
        with db.connect() as connection:
            connection.execute('update app.album_lists set deleted_at=now() where ref=%s', (receipt['top_ref'],))
    elif mismatch == 'null':
        parameters[0] = None
    else:
        index = {'top': 0, 'item': 1, 'library': 2, 'revision': 3, 'catalog': 4}[mismatch]
        parameters[index] = parameters[index] + 1 if index in {2, 3} else str(uuid4())
    with db.service._connect(db.app_url) as connection:
        assert_runtime_role(connection, db)
        result = connection.execute('select app.lock_top_native_catalog_binding(%s,%s,%s,%s,%s) as locked',
                                    parameters).fetchone()
        assert result == {'locked': False}


def test_lock_helper_exposes_boolean_only_and_preserves_narrow_runtime_privileges(db, bound):
    receipt, item = bound
    with db.service._connect(db.app_url) as connection:
        assert_runtime_role(connection, db)
        assert connection.execute('select app.lock_top_native_catalog_binding(%s,%s,%s,%s,%s) as locked',
            (receipt['top_ref'], item['ref'], db.library, int(receipt['revision']), db.album_refs[0])).fetchone() == {'locked': True}
        metadata = connection.execute("""select p.prosecdef,p.proconfig,
            has_function_privilege(current_user,p.oid,'EXECUTE') as app_execute,
            has_function_privilege('album_haven_readonly',p.oid,'EXECUTE') as readonly_execute,
            exists(select 1 from aclexplode(p.proacl) a where a.grantee=0 and a.privilege_type='EXECUTE') as public_execute
            from pg_proc p where p.oid=%s::regprocedure""", (LOCK,)).fetchone()
        assert metadata == {'prosecdef': True, 'proconfig': ['search_path=pg_catalog'],
                            'app_execute': True, 'readonly_execute': False, 'public_execute': False}
