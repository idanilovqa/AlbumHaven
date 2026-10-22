"""Exact LS-B1 grammar; authored, not executed by the authoring task."""
from itertools import product
import pytest
from starlette.datastructures import QueryParams
from music_app.services.private_search_contract import (
    ListenerSearchCriteria, ListenerSearchRequest, OwnLoveCriteria, PrivateSearchError,
    normalize_listener_search_query as parse, normalize_listener_history_query,
    normalize_private_search_request, normalize_own_love_query,
)


@pytest.mark.parametrize('query', ['@maya', '@MAYA', ' @maya  ', '@maya :tracks',
    '@maya listened:all', '@maya :tracks listened:all', 'LISTENED:ALL @MAYA :TRACKS', '@maya @MAYA'])
def test_bare_explicit_defaults_and_repeated_handle_are_equivalent(query):
    actual = parse(query)
    assert actual == ListenerSearchCriteria('maya') and actual.filtered is False
    assert actual.as_payload() == {'subject': {'kind':'username','username':'maya'},
        'predicate_domain':'tracks','history':{'period':'all'},'love':{'include':[],'exclude':[]}}


@pytest.mark.parametrize('query,include,exclude,tiers', [
    ('@maya :loved', ('loved',), (), ('loved','obsessed')),
    ('@maya :obsessed', ('obsessed',), (), ('obsessed',)),
    ('@maya -:loved', (), ('loved',), ('off',)),
    ('@maya -love:obsessed', (), ('obsessed',), ('loved','off')),
    ('@maya :loved -:obsessed', ('loved',), ('obsessed',), ('loved',)),
    ('@maya :loved -love:loved', ('loved',), ('loved',), ()),
    ('@maya :obsessed love:loved :loved love:obsessed', ('loved','obsessed'), (), ('loved','obsessed')),
])
def test_love_uses_existing_expansion_subtraction(query, include, exclude, tiers):
    parsed = parse(query)
    assert (parsed.love_include, parsed.love_exclude, parsed.tiers()) == (include, exclude, tiers)
    assert parsed.tiers() == OwnLoveCriteria(include, exclude).tiers()
    assert parsed.filtered is True


@pytest.mark.parametrize('bad', ['@liam', ':tracks', 'listened:all', ':albums', ':artists',
    'listened:week', 'artist:abc', 'genre:rock', 'rating:5', ':favorites', 'listener:maya',
    'hello', '"quoted"', r'escaped\word', '-@maya', ':', 'love:', '@ｍaya'])
def test_invalid_token_has_original_source_span(bad):
    prefix = '@maya :tracks listened:all  '
    with pytest.raises(PrivateSearchError) as caught:
        parse(prefix + bad)
    assert caught.value.status_code == 400
    assert caught.value.location == {'start':len(prefix), 'end':len(prefix)+len(bad)}


@pytest.mark.parametrize('query', ['', None, 5, '\0', '@maya\0', '@maya\ud800', '@maya ' + 'x'*200, ':loved'])
def test_invalid_expression_never_silently_falls_back(query):
    with pytest.raises(PrivateSearchError):
        parse(query)


@pytest.mark.parametrize('field', ['artist','all_artists','omit_sidebar','payload_tier','category',
    'gallery_scope','gallery_display','gallery_scale_percent','search_sidebar_cursor',
    'search_detail_album_ref','search_sidebar_only','target_account_id','context','listener'])
def test_listener_rejects_every_own_love_or_authority_override(field):
    with pytest.raises(PrivateSearchError):
        normalize_private_search_request(QueryParams({'q':'@maya', field:'1'}))


@pytest.mark.parametrize('field,value', [('surface','albums'),('q','@maya'),
    ('search_presentation','tracks'),('search_page_size','1'),('search_cursor','opaque')])
def test_duplicate_listener_parameters_are_rejected_even_if_identical(field, value):
    pairs = [('q','@maya')] if field != 'q' else []
    with pytest.raises(PrivateSearchError):
        normalize_private_search_request(QueryParams(pairs + [(field,value),(field,value)]))


@pytest.mark.parametrize('field,value', [('surface','tracks'),('surface','Albums'),
    ('search_presentation','albums'),('search_page_size','0'),('search_page_size','101'),
    ('search_page_size','True'),('search_page_size','１'),('search_page_size','1.0'),
    ('search_cursor',''),('search_cursor','x'*4097)])
def test_exact_listener_request_values(field,value):
    with pytest.raises(PrivateSearchError):
        normalize_private_search_request(QueryParams({'q':'@maya', field:value}))


def test_typed_query_whitespace_and_spelling_are_preserved():
    query = '  @MAYA :TRACKS  listened:all  '
    actual = normalize_private_search_request(QueryParams({'q':query}))
    assert type(actual) is ListenerSearchRequest
    assert actual == ListenerSearchRequest(query, ListenerSearchCriteria('maya'))


@pytest.mark.parametrize('include,exclude', product([(),('loved',),('obsessed',),('loved','obsessed')], repeat=2))
def test_all_canonical_love_sets_match_own_love_semantics(include,exclude):
    criteria = ListenerSearchCriteria('maya',include,exclude)
    assert criteria.tiers() == OwnLoveCriteria(include,exclude).tiers()


@pytest.mark.parametrize('bad', [('obsessed','loved'),('loved','loved'),('off',),['loved'],('invalid',)])
def test_direct_criteria_cannot_admit_noncanonical_sets(bad):
    with pytest.raises(PrivateSearchError):
        ListenerSearchCriteria('maya',bad,())


def test_raw_foundation_and_own_love_remain_separate():
    assert normalize_listener_history_query('@maya').as_payload() == {
        'subject':{'kind':'username','username':'maya'},'predicate_domain':'tracks','history':{'period':'all'}}
    for query in ('@maya :loved','@maya :tracks','@maya listened:all','@maya @maya'):
        with pytest.raises(PrivateSearchError):
            normalize_listener_history_query(query)
    own = normalize_private_search_request(QueryParams({'q':':loved','artist':'A','search_presentation':'albums'}))
    assert type(own.criteria) is OwnLoveCriteria and own.artist == 'A'
    assert normalize_own_love_query(':loved').tiers() == ('loved','obsessed')
