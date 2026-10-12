"""Named private Top access: pure authority and transaction seams, no runtime."""
from contextlib import contextmanager
from dataclasses import replace
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from music_app.services import album_top_viewer_actions as viewers
from music_app.services import album_top_progress as progress
from music_app.services.owned_album_tops import (
    ACCESS, BROWSE, CREATE, ITEMS, MANAGE, PROGRESS, AlbumTopError,
    command_actions, normalize_top_command, require_top_authority,
)
from music_app.services.owned_album_tops_postgres import PostgresOwnedAlbumTopsService as Service
from music_app.services.policy import ResourceScope
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.test_owned_album_tops import _context, REQUEST, TOP, OTHER, ALBUM


def top(**changes):
    return dict(ref=TOP, owner_account_id=99, visibility='private', deleted_at=None,
                revision=4, title='Source', description='Description',
                next_original_position=2, viewer_grant=True, editor_grant=False, **changes)


def context():
    return _context('capability.view', resource=ResourceScope('album_top', TOP))


def command(action='grant_viewer', **changes):
    data = {'revision': '4', 'request_key': REQUEST}
    if action.startswith('grant_'):
        data.update(account_id=44, role=action.removeprefix('grant_'))
    data.update(changes)
    return normalize_top_command(action, data, top_ref=TOP)


@pytest.mark.parametrize('account_id', [1, 9007199254740993, 9223372036854775807])
def test_viewer_command_has_exact_role_action_digest_and_bigint_identity(account_id):
    parsed = command(account_id=account_id)
    assert parsed.data == {'revision': '4', 'account_id': account_id, 'role': 'viewer'}
    assert command_actions(parsed) == (BROWSE, ACCESS)
    assert parsed.digest != command('grant_editor', account_id=account_id).digest
    assert parsed.digest != command(account_id=account_id, revision='5').digest


@pytest.mark.parametrize('field,value', [
    ('role', 'editor'), ('role', 'owner'), ('role', True), ('role', []),
    ('account_id', True), ('account_id', '44'), ('account_id', 0),
    ('account_id', 9223372036854775808), ('revision', '04'),
    ('viewer_grant', True), ('owner_account_id', 41), ('library_id', 7),
    ('allowed_actions', {'can_edit': True}), ('local_path', '/private'),
])
def test_viewer_grant_rejects_wrong_roles_and_injected_authority(field, value):
    with pytest.raises(AlbumTopError, match='invalid_command'):
        command(**{field: value})


def test_editor_command_still_rejects_viewer_role():
    with pytest.raises(AlbumTopError, match='invalid_command'):
        command('grant_editor', role='viewer')


@pytest.mark.parametrize('actions', [(BROWSE,), (BROWSE, PROGRESS)])
def test_named_viewer_reads_private_source_and_writes_only_own_progress(actions):
    require_top_authority(context(), required_actions=actions, owner_account_id=99,
                          viewer_grant=True)


@pytest.mark.parametrize('actions', [(BROWSE, MANAGE), (BROWSE, ITEMS), (BROWSE, ACCESS)])
def test_named_viewer_never_edits_source_or_manages_access(actions):
    with pytest.raises(AlbumTopError, match='forbidden'):
        require_top_authority(context(), required_actions=actions, owner_account_id=99,
                              viewer_grant=True)


@pytest.mark.parametrize('viewer_grant', [False, 1, 'viewer', {}, []])
def test_only_a_server_boolean_viewer_grant_admits_private_read(viewer_grant):
    with pytest.raises(AlbumTopError, match='forbidden'):
        require_top_authority(context(), required_actions=(BROWSE,), owner_account_id=99,
                              viewer_grant=viewer_grant)


@pytest.mark.parametrize('change', ['library', 'target', 'session', 'membership', 'capability'])
def test_named_viewer_does_not_bypass_current_actor_scope(change):
    ctx = context()
    if change == 'library':
        ctx = replace(ctx, library_id=8)
    elif change == 'target':
        ctx = replace(ctx, target_account_id=99)
    elif change == 'session':
        ctx = replace(ctx, actor=replace(ctx.actor, session_id=None))
    elif change == 'membership':
        ctx = replace(ctx, actor=replace(ctx.actor, library_relationships=()))
    else:
        ctx = replace(ctx, actor=replace(ctx.actor, capability_grants=()))
    with pytest.raises(AlbumTopError, match='forbidden'):
        require_top_authority(ctx, required_actions=(BROWSE,), owner_account_id=99,
                              viewer_grant=True)


def test_named_viewer_still_obeys_resource_constraints():
    observed = []
    def constraints(ctx):
        observed.append(ctx.resource)
        return PolicyEvaluationConstraints(request_origin_allowed=False)
    with pytest.raises(AlbumTopError, match='forbidden'):
        require_top_authority(context(), required_actions=(BROWSE,), owner_account_id=99,
                              viewer_grant=True, constraints=constraints)
    assert observed == [ResourceScope('album_top', TOP)]


def test_viewer_editor_and_owner_action_projection_preserves_product_boundary():
    service = Service({'ALBUM_HAVEN_APP_DATABASE_URL': 'unused'})
    viewer = service._actions(context(), None, top())
    assert all(viewer[key] for key in ('can_read', 'can_view_sharing', 'can_request_edit',
                                     'can_copy', 'can_manage_own_progress'))
    assert not any(viewer[key] for key in ('can_edit', 'can_rename', 'can_add', 'can_remove',
                                         'can_reorder', 'can_delete', 'can_share'))
    editor = service._actions(context(), None, {**top(), 'editor_grant': True, 'viewer_grant': False})
    assert all(editor[key] for key in ('can_edit', 'can_rename', 'can_add', 'can_remove', 'can_reorder'))
    assert not any(editor[key] for key in ('can_delete', 'can_share', 'can_request_edit'))
    owner = service._actions(context(), None, {**top(), 'owner_account_id': 41})
    assert owner['can_delete'] and owner['can_share'] and not owner['can_request_edit']
    assert not any('play' in key or 'download' in key for key in viewer)


class Rows:
    def __init__(self, rows):
        self.rows = rows
    def fetchone(self):
        return self.rows[0] if self.rows else None
    def fetchall(self):
        return self.rows


class Steps:
    """Scripted transaction seam; unexpected SQL or scope is always a failure."""
    def __init__(self, *steps):
        self.steps = list(steps)
        self.calls = []
    def execute(self, sql, params=()):
        normalized = ' '.join(sql.lower().split())
        self.calls.append((normalized, params))
        assert self.steps, f'Unexpected query: {normalized}'
        fragment, rows = self.steps.pop(0)
        assert fragment in normalized, (fragment, normalized)
        return Rows(rows)
    def done(self):
        assert not self.steps


@pytest.mark.parametrize('write', [False, True])
@pytest.mark.parametrize('role', ['viewer', 'editor', None])
def test_acl_is_reloaded_after_parent_lock_not_cached_across_downgrade_or_revoke(write, role):
    # The role returned here is the state AFTER a waiting parent lock completes.
    connection = Steps(('from app.album_lists', [top()]),
                       ('from app.album_list_access_grants', [] if role is None else [{'ref': OTHER, 'role': role}]))
    if role is None:
        with pytest.raises(AlbumTopError, match='top_unavailable'):
            Service._top(connection, context(), TOP, write=write)
    else:
        loaded = Service._top(connection, context(), TOP, write=write)
        assert loaded['viewer_grant'] is (role == 'viewer')
        assert loaded['editor_grant'] is (role == 'editor')
        if role == 'viewer':
            with pytest.raises(AlbumTopError, match='forbidden'):
                Service._require(context(), (BROWSE, MANAGE), None, loaded)
    assert connection.calls[0][0].endswith('for update' if write else 'for share')
    assert connection.calls[1][1] == (TOP, 7, 41)
    assert "role='editor'" not in connection.calls[1][0]
    connection.done()


def test_list_read_and_sharing_dtos_agree_for_private_named_viewer(monkeypatch):
    service = Service({'ALBUM_HAVEN_APP_DATABASE_URL': 'unused'})
    connection = Steps(
        ('select p.ref,p.id', [{'ref': TOP, 'id': 1}]),
        ('from app.album_lists', [top()]),
        ('from app.album_list_access_grants', [{'ref': OTHER, 'role': 'viewer'}]),
        ('from app.album_lists', [top()]),
        ('from app.album_list_access_grants', [{'ref': OTHER, 'role': 'viewer'}]),
        ('from app.album_list_items', []),
        ('left join app.album_list_item_progress', []),
        ('from app.album_lists', [top()]),
        ('from app.album_list_access_grants', [{'ref': OTHER, 'role': 'viewer'}]),
        ('select status from app.album_list_edit_requests', []),
    )
    @contextmanager
    def authorized(*args, **kwargs):
        yield connection, context(), datetime.now(timezone.utc)
    monkeypatch.setattr(service, '_authorized', authorized)
    listed = service.list(context(), cursor_secret='s' * 32)['tops']
    detail = service.read(context(), top_ref=TOP)
    sharing = service.read_sharing(context(), TOP, cursor_secret='s' * 32)
    assert len(listed) == 1 and listed[0]['top_ref'] == detail['top_ref'] == TOP
    assert listed[0]['allowed_actions'] == detail['allowed_actions']
    assert sharing['can_request_edit'] and sharing['can_copy'] and not sharing['can_manage']
    assert sharing['pending_requests'] == []
    assert "g.role='editor'" not in connection.calls[0][0]
    connection.done()


def test_own_progress_query_uses_current_actor_and_never_source_owner():
    connection = Steps(('left join app.album_list_item_progress', []))
    assert progress.read_overlay(connection, context(), top()) == {'item_progress': {}}
    assert connection.calls[0][1] == (41, TOP, 7)
    connection.done()


def test_copy_inserts_only_new_private_artifact_and_catalog_members_not_peer_progress():
    connection = Steps(('select catalog_ref,original_position,curator_position', [
        {'catalog_ref': ALBUM, 'original_position': 1, 'curator_position': 1}]),
        ('insert into app.album_lists', []), ('insert into app.album_list_items', []))
    receipt = viewers.copy_top(connection, context(), command('copy'), top())
    assert receipt['source_top_ref'] == TOP and receipt['top_ref'] != TOP
    assert connection.calls[1][1][1:3] == (41, 7)
    assert all('progress' not in sql and 'access_grants' not in sql and 'listening' not in sql
               for sql, _ in connection.calls)
    connection.done()


@pytest.mark.parametrize('prior_role,next_role', [('editor', 'viewer'), ('viewer', 'editor'),
                                                 ('viewer', 'viewer'), ('editor', 'editor')])
def test_role_upsert_preserves_identity_and_changes_only_on_actual_role_transition(monkeypatch, prior_role, next_role):
    monkeypatch.setattr(viewers, 'eligible_member', lambda *args, **kwargs: True)
    steps = [('select ref', [{'ref': OTHER, 'role': prior_role}])]
    if prior_role != next_role:
        steps.append(('update app.album_list_access_grants', []))
    if next_role == 'editor':
        steps.append(('update app.album_list_edit_requests', []))
    connection = Steps(*steps)
    changed, receipt = viewers.mutate(Service({'ALBUM_HAVEN_APP_DATABASE_URL': 'unused'}),
        connection, context(), command('grant_' + next_role), top(), None)
    assert changed is (prior_role != next_role)
    assert receipt['grant_ref'] == OTHER
    assert all('insert into app.album_list_access_grants' not in sql for sql, _ in connection.calls)
    if next_role == 'viewer':
        assert not any('album_list_edit_requests' in sql for sql, _ in connection.calls)
    connection.done()


@pytest.mark.parametrize('role', ['viewer', 'editor'])
def test_grant_role_requires_current_eligible_target(monkeypatch, role):
    observed = []
    def denied(*args, **kwargs):
        observed.append(kwargs)
        return False
    monkeypatch.setattr(viewers, 'eligible_member', denied)
    connection = Steps()
    with pytest.raises(AlbumTopError, match='grant_target_unavailable'):
        viewers.mutate(Service({'ALBUM_HAVEN_APP_DATABASE_URL': 'unused'}), connection,
            context(), command('grant_' + role), top(), None)
    assert observed == [{'lock': True}]
    connection.done()


@pytest.mark.parametrize('role', ['viewer', 'editor', None])
def test_pending_request_validity_uses_current_private_viewer_role(monkeypatch, role):
    monkeypatch.setattr(viewers, 'eligible_member', lambda *args, **kwargs: True)
    connection = Steps(('from app.album_list_access_grants',
                        [] if role is None else [{'ref': OTHER, 'role': role}]))
    assert viewers.request_valid(Service({'ALBUM_HAVEN_APP_DATABASE_URL': 'unused'}),
        connection, context(), top(), 44, None) is (role == 'viewer')
    connection.done()


@pytest.mark.parametrize('already_pending', [False, True])
def test_private_viewer_request_deduplicates_and_creates_no_access_grant(already_pending):
    steps = [('from app.album_list_edit_requests', [{'ref': OTHER}] if already_pending else [])]
    if not already_pending:
        steps += [('from app.capabilities', [{'id': 73}]),
                  ('insert into app.album_list_edit_requests', [])]
    connection = Steps(*steps)
    changed, receipt = viewers.mutate(Service({'ALBUM_HAVEN_APP_DATABASE_URL': 'unused'}),
        connection, context(), command('request_edit'), top(), None)
    assert changed is False and receipt['request_status'] == 'pending'
    assert receipt['request_created'] is (not already_pending)
    if already_pending:
        assert receipt['request_ref'] == OTHER
    assert not any('album_list_access_grants' in sql for sql, _ in connection.calls)
    connection.done()


def test_owner_notification_feed_includes_pending_named_private_viewer(monkeypatch):
    service = Service({'ALBUM_HAVEN_APP_DATABASE_URL': 'unused'})
    owner_top = {**top(), 'owner_account_id': 41, 'viewer_grant': False}
    request_row = {'id': 1, 'ref': OTHER, 'top_ref': TOP, 'requester_account_id': 44,
        'account_ref': ALBUM, 'display_name': 'Viewer', 'username_display': 'viewer',
        'created_at': datetime(2026, 10, 12, tzinfo=timezone.utc)}
    connection = Steps(('from app.album_list_edit_requests r', [request_row]),
        ('from app.album_lists', [owner_top]),
        ('from app.album_list_access_grants', [{'ref': ALBUM, 'role': 'viewer'}]),
        ('select status from app.album_list_edit_requests', [{'status': 'pending'}]))
    monkeypatch.setattr(viewers, 'eligible_member', lambda *args, **kwargs: True)
    pending, cursor = viewers.pending(service, connection, context(), None)
    assert len(pending) == 1 and pending[0]['request_ref'] == OTHER
    assert cursor is None
    # Private named viewers must survive the initial query, before per-row checks.
    sql = connection.calls[0][0]
    assert "p.visibility='server_shared' and r.status" not in sql
    connection.done()
