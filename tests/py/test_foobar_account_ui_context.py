"""AUTHORED ONLY: server-issued account/session marker, no stored config read."""
from types import SimpleNamespace

import pytest

from music_app.services.foobar_account_ui_context import (
    FOOBAR_ACCOUNT_CONTEXT_SCOPE, FoobarAccountUIContextError, foobar_account_ui_context_ref,
)


def request(*, account=41, session=73, library=None, authenticated=True, hmac=None):
    actor = SimpleNamespace(is_authenticated=authenticated, account_id=account,
        session_id=session, current_library_id=library)
    signing = {'secret': 's' * 32, 'key_version': 1} if hmac is None else hmac
    return SimpleNamespace(state=SimpleNamespace(current_actor=actor),
        app=SimpleNamespace(state=SimpleNamespace(auth_policy_config={'hmac': signing})))


def test_context_marker_is_deterministic_account_session_bound_and_library_independent():
    original = foobar_account_ui_context_ref(request())
    assert len(original) == 64 and original == foobar_account_ui_context_ref(request())
    assert FOOBAR_ACCOUNT_CONTEXT_SCOPE == 'account-foobar-v1'
    assert original == foobar_account_ui_context_ref(request(library=7))
    assert original == foobar_account_ui_context_ref(request(library=900))
    for other in (request(account=42), request(session=74),
                  request(hmac={'secret': 't' * 32, 'key_version': 1}),
                  request(hmac={'secret': 's' * 32, 'key_version': 2})):
        assert foobar_account_ui_context_ref(other) != original
    assert foobar_account_ui_context_ref(request(authenticated=False)) is None


@pytest.mark.parametrize('field', ['account', 'session'])
@pytest.mark.parametrize('value', [True, None, 0, -1, 2**63, '41'])
def test_context_marker_fails_closed_for_noncanonical_authenticated_identity(field, value):
    with pytest.raises(FoobarAccountUIContextError) as caught:
        foobar_account_ui_context_ref(request(**{field: value}))
    assert caught.value.status_code == 503
    assert caught.value.code == 'foobar_account_context_unavailable'


@pytest.mark.parametrize('signing', [{}, {'secret': 'short'},
    {'secret': b's' * 32}, {'secret': 's' * 32, 'key_version': True},
    {'secret': 's' * 32, 'key_version': 0}])
def test_context_marker_never_falls_back_to_unsigned_identity(signing):
    with pytest.raises(FoobarAccountUIContextError):
        foobar_account_ui_context_ref(request(hmac=signing))
