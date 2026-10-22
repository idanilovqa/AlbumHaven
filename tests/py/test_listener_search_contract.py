"""Raw listener grammar and its distinct live Search admission contract."""
import pytest
from starlette.datastructures import QueryParams

from music_app.services.private_search_contract import (
    ListenerHistoryCriteria, ListenerSearchCriteria, ListenerSearchRequest,
    PrivateSearchError, normalize_listener_history_query,
    normalize_own_love_query, normalize_private_search_request,
)


@pytest.mark.parametrize('query', [
    '@maya', ' @Maya ', '@maya :tracks listened:all',
    'listened:all @MAYA :tracks', ':TRACKS LISTENED:ALL @Maya',
])
def test_confirmed_forms_share_one_canonical_listener_history_contract(query):
    criteria = normalize_listener_history_query(query)
    assert criteria == ListenerHistoryCriteria('maya')
    assert criteria.as_payload() == {
        'subject': {'kind': 'username', 'username': 'maya'},
        'predicate_domain': 'tracks', 'history': {'period': 'all'},
    }


@pytest.mark.parametrize('query', [
    '@maya :loved', '@maya love:loved', '@maya artist:Something',
    '@maya genre:jazz', '@maya :tracks', '@maya listened:all',
    '@maya :tracks listened:week', '@maya :albums listened:all',
    '@maya @mira', '@maya @maya', '-@maya', ':loved',
    '@maya :tracks :tracks listened:all', '@maya :tracks listened:all listened:all',
    'listener:maya', 'persons:maya', '@maya extra', ':tracks listened:all',
])
def test_unconfirmed_combinations_fail_deterministically(query):
    errors = []
    for _ in range(2):
        with pytest.raises(PrivateSearchError) as caught:
            normalize_listener_history_query(query)
        errors.append((caught.value.code, caught.value.status_code, caught.value.location))
    assert errors[0] == errors[1]
    assert errors[0][:2] == ('unsupported_private_search_combination', 400)


@pytest.mark.parametrize('query', [
    None, 42, '', '  ', '@', '@ma', '@máya', '@ma\u017fya', '@maya@example.com',
    '@"maya"', '@maya\0', '@maya\ud800', '@' + 'm' * 64 + 'x', '@maya' + ' ' * 201,
])
def test_invalid_input_cannot_become_a_person_lookup(query):
    with pytest.raises(PrivateSearchError) as caught:
        normalize_listener_history_query(query)
    assert caught.value.code == 'invalid_private_search_request'
    assert caught.value.status_code == 400


def test_username_boundaries_reuse_existing_account_contract():
    assert normalize_listener_history_query('@a.b-c_9').username == 'a.b-c_9'
    assert normalize_listener_history_query('@' + 'm' * 64).username == 'm' * 64
    with pytest.raises(PrivateSearchError):
        ListenerHistoryCriteria(42)
    with pytest.raises(TypeError):
        ListenerHistoryCriteria(username='maya', account_id=42)


@pytest.mark.parametrize('query', ['@maya', '@maya :tracks listened:all'])
def test_confirmed_history_forms_have_distinct_live_track_admission(query):
    request = normalize_private_search_request(QueryParams({'surface': 'albums', 'q': query}))
    assert type(request) is ListenerSearchRequest
    assert request.criteria == ListenerSearchCriteria('maya')
    assert request.presentation == 'tracks'
    assert request.limit == 100


def test_existing_own_love_contract_is_unchanged():
    assert normalize_own_love_query(':loved -:obsessed').as_payload() == {
        'subject': 'self', 'predicate_domain': 'tracks',
        'love': {'include': ['loved'], 'exclude': ['obsessed']},
        'name_scopes': ['artists', 'albums', 'tracks'],
    }
