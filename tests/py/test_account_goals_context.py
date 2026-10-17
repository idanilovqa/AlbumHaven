"""Real continuity primitives, without application bootstrap or source mocks."""
from dataclasses import replace
import json

import pytest
from fastapi import FastAPI
from starlette.requests import Request

from music_app.services.account_goals_context import (
    ACCOUNT_GOALS_CONTEXT_SCOPE, AccountGoalsContextError, account_goals_context_ref,
)
from music_app.services.auth_tokens import keyed_bucket_digest
from music_app.services.current_actor import ActorState, CurrentActor
from music_app.services.private_ui_context import private_ui_context_ref, PrivateUIContextError


SECRET = 'synthetic-account-goals-continuity-secret-32-bytes'


def incoming(actor=None, config=None):
    app = FastAPI()
    app.state.auth_policy_config = config if config is not None else {
        'hmac': {'secret': SECRET, 'key_version': 7}}
    request = Request({'type': 'http', 'app': app, 'headers': [
        (b'x-albumhaven-account-context', b'0' * 64)]})
    if actor is not None:
        request.state.current_actor = actor
    return request


def active(**changes):
    return replace(CurrentActor(state=ActorState.ACTIVE, account_id=41, session_id=8), **changes)


def test_marker_is_exact_domain_separated_account_session_digest():
    marker = account_goals_context_ref(incoming(active()))
    expected = keyed_bucket_digest(secret=SECRET.encode(), key_version=7,
        domain='account-goals-context-v1', normalized_value='[41,8]').digest.hex()
    assert marker == expected and len(marker) == 64
    assert ACCOUNT_GOALS_CONTEXT_SCOPE == 'account-goals-v1'
    assert marker != '0' * 64
    # Even the same tuple under Home's existing domain has a different digest.
    other_domain = keyed_bucket_digest(secret=SECRET.encode(), key_version=7,
        domain='private-ui-context', normalized_value='[41,8]').digest.hex()
    assert marker != other_domain
    with pytest.raises(PrivateUIContextError):
        private_ui_context_ref(incoming(active()))


def test_marker_ignores_library_but_retires_for_account_session_key_or_version():
    actor = active()
    original = account_goals_context_ref(incoming(actor))
    assert original == account_goals_context_ref(incoming(replace(actor, current_library_id=53)))
    assert original != private_ui_context_ref(incoming(replace(actor, current_library_id=53)))
    changed = [
        account_goals_context_ref(incoming(replace(actor, account_id=42))),
        account_goals_context_ref(incoming(replace(actor, session_id=9))),
        account_goals_context_ref(incoming(actor, {'hmac': {'secret': SECRET + '-rotated', 'key_version': 7}})),
        account_goals_context_ref(incoming(actor, {'hmac': {'secret': SECRET, 'key_version': 8}})),
    ]
    assert len(set([original, *changed])) == 5


@pytest.mark.parametrize('actor', [None, CurrentActor.anonymous(), active(state=ActorState.INACTIVE)])
def test_anonymous_or_inactive_context_never_gets_marker(actor):
    assert account_goals_context_ref(incoming(actor)) is None


@pytest.mark.parametrize('field', ['account_id', 'session_id'])
@pytest.mark.parametrize('value', [None, False, True, 0, -1, '41'])
def test_authenticated_scope_rejects_invalid_identity_types(field, value):
    with pytest.raises(AccountGoalsContextError) as error:
        account_goals_context_ref(incoming(active(**{field: value})))
    assert error.value.code == 'account_goals_context_unavailable'
    assert error.value.status_code == 503


@pytest.mark.parametrize('config', [
    {}, {'hmac': None}, {'hmac': {}}, {'hmac': {'secret': b'x' * 32}},
    {'hmac': {'secret': 'x' * 31}}, {'hmac': {'secret': '\ud800' * 32}},
    *({'hmac': {'secret': SECRET, 'key_version': value}} for value in [None, False, True, 0, -1, '7']),
])
def test_bad_signing_configuration_has_only_safe_error(config):
    with pytest.raises(AccountGoalsContextError) as error:
        account_goals_context_ref(incoming(active(), config))
    assert str(error.value) == 'Account Goals context is unavailable.'
    assert SECRET not in str(error.value)


def test_utf8_secret_uses_byte_strength_and_default_key_version():
    secret = 'é' * 16
    marker = account_goals_context_ref(incoming(active(), {'hmac': {'secret': secret}}))
    assert marker == keyed_bucket_digest(secret=secret.encode(), key_version=1,
        domain='account-goals-context-v1', normalized_value=json.dumps([41, 8], separators=(',', ':'))).digest.hex()
