"""Explicit operational-log export grant authoring, with no default expansion."""
from music_app.services.admin_account_creation import AdminAccountCreationService
from music_app.routes import admin_asgi
from tests.py.test_admin_account_creation import Repository, _owner


def create_with(capabilities):
    repository = Repository()
    service = AdminAccountCreationService(repository=repository, invitation_token_seconds=3600)
    service.create_account(actor=_owner(), username='history-reader', contact_email='reader@example.test',
        capability_keys=capabilities, send_invitation=False, request_ref='grant-test')
    return repository.calls[0]['capability_keys']


def test_administrator_can_explicitly_author_both_log_grants():
    assert set(create_with(('library.logs.read', 'library.logs.export'))) == {'library.logs.read', 'library.logs.export'}


def test_read_grant_does_not_implicitly_author_export():
    assert create_with(('library.logs.read',)) == ('library.logs.read',)
    assert 'library.logs.export' not in admin_asgi._LISTENER_DEFAULTS


def test_managed_account_grant_surface_lists_export_separately():
    capabilities = {key: label for _, group in admin_asgi._CAPABILITY_GROUPS for key, label in group}
    assert capabilities['library.logs.export'] == 'Export operational logs'
    assert capabilities['library.logs.read'] == 'View operational logs'
