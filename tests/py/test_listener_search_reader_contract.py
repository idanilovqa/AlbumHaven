"""Pure input boundaries only; no simulated session or database acceptance."""
from dataclasses import replace

import pytest
from starlette.datastructures import QueryParams

from music_app.services.current_actor import ActorState, CapabilityGrant, CurrentActor, LibraryRelationship
from music_app.services.policy import PolicyContext, RequestOrigin
from music_app.services.private_listener_search_cursor import encode_listener_cursor
from music_app.services.private_listener_search_postgres import PostgresListenerSearch
from music_app.services.private_search_contract import (
    ListenerSearchCriteria, ListenerSearchRequest, PrivateSearchError, normalize_private_search_request,
)
from music_app.services.private_search_subject import ListenerHistoryExpectation

SECRET = 'listener-search-pure-request-boundary-secret'
REF = '20000000-0000-4000-8000-000000000042'


def context():
    return PolicyContext.build(actor=CurrentActor(state=ActorState.ACTIVE,
        account_id=41, session_id=81, current_library_id=73,
        library_relationships=(LibraryRelationship(73, 'member', False),),
        capability_grants=(CapabilityGrant('capability.view', 'library', 73),)),
        action='library.browse.read', library_id=73, deployment_mode='self_hosted',
        request_origin=RequestOrigin('network', 'hmac:listener-reader-pure'),
        client_surface_class='private_web')


def never_connect(_url):
    raise AssertionError('Invalid inputs must not open a database connection.')


def rejected(*, expected=400, **changes):
    arguments = dict(query='@maya', context_ref='a' * 64, cursor_secret=SECRET)
    arguments.update(changes)
    with pytest.raises(PrivateSearchError) as caught:
        PostgresListenerSearch({'ALBUM_HAVEN_APP_DATABASE_URL': 'unused'},
            connect=never_connect).read(arguments.pop('context', context()), **arguments)
    assert caught.value.status_code == expected
    return caught.value


@pytest.mark.parametrize('query', ['@maya loved', '@maya :albums listened:all',
    '@maya listened:week', '@maya :tracks', '@maya @mira', '@maya listened:all',
    '@maya :tracks listened:all loved', '@maya name:example', '@maya :tracks :tracks listened:all'])
def test_unsupported_grammar_is_not_a_broader_backend_query(query):
    error = rejected(query=query)
    assert error.code == 'unsupported_private_search_combination'
    assert error.location is not None


@pytest.mark.parametrize('cursor', ['', False, {}, 'not-a-cursor', 'a' * 4097])
def test_invalid_continuation_never_becomes_a_fresh_capture(cursor):
    rejected(cursor=cursor)


@pytest.mark.parametrize('context_ref', [None, True, '', 'a' * 63, 'A' * 64, 'a' * 64 + '\n'])
def test_private_context_requires_exact_current_reference_shape(context_ref):
    rejected(context_ref=context_ref)


@pytest.mark.parametrize('secret', [None, '', 'short', '\ud800' * 32])
def test_missing_cursor_key_fails_before_even_page_one_capture(secret):
    assert rejected(cursor_secret=secret, expected=503).code == 'private_search_unavailable'


@pytest.mark.parametrize('target', [41, 42])
def test_even_a_valid_policy_context_cannot_supply_subject_identity(target):
    rejected(context=replace(context(), target_account_id=target), expected=403)


@pytest.mark.parametrize('key,value', [
    ('actor_account_id', 42), ('actor_session_id', 82), ('library_id', 74),
    ('context_ref', 'b' * 64), ('username', 'mira'),
])
def test_valid_signed_other_scope_cursor_fails_before_identity_lookup(key, value):
    scope = {'actor_account_id': 41, 'actor_session_id': 81, 'library_id': 73,
             'context_ref': 'a' * 64, 'username': 'maya', 'account_ref': REF,
             'audience': 'friend', 'relationship_revision': 1, key: value}
    cursor = encode_listener_cursor('A' * 43, 2, secret=SECRET, scope=scope)
    assert rejected(cursor=cursor, expected=409).code == 'search_cursor_restart_required'


@pytest.mark.parametrize('username,reference,revision', [
    ('Maya', None, None), ('@maya', None, None), ('ma', None, None),
    ('maya', 'invalid', None), ('maya', 'ABCDEF00-0000-4000-8000-000000000042', None),
    ('maya', None, 1), ('maya', REF, True), ('maya', REF, 0),
    ('maya', REF, -1), ('maya', REF, 9223372036854775808),
])
def test_home_listener_expectation_has_no_coercing_identity_inputs(username, reference, revision):
    with pytest.raises(PrivateSearchError):
        ListenerHistoryExpectation(username, reference, revision)


def test_home_listener_expectation_distinguishes_initial_and_continuation():
    assert ListenerHistoryExpectation('maya').account_ref is None
    assert ListenerHistoryExpectation('maya', REF).relationship_revision is None
    assert ListenerHistoryExpectation('maya', REF, 1).relationship_revision == 1


@pytest.mark.parametrize('query', ['@maya', '@maya :tracks listened:all'])
def test_http_uses_a_distinct_live_request_without_widening_the_raw_reader(query):
    request = normalize_private_search_request(QueryParams({'q': query}))
    assert type(request) is ListenerSearchRequest
    assert request.criteria == ListenerSearchCriteria('maya')
    assert request.presentation == 'tracks'
