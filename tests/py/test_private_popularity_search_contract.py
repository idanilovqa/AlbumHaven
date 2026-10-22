"""Popularity C1 grammar, semantic predicates, encrypted families and commands.

Authored against the R1 contract, R2 amendment and canonical-terms clarification.
This owner needs no database fixture, provider, browser, player or production
configuration. Source authoring/AST inspection is not evidence of a test run.
"""
import base64
from copy import deepcopy
from dataclasses import FrozenInstanceError
import hashlib
import hmac
import json
from types import SimpleNamespace

from cryptography.fernet import Fernet
import pytest
from starlette.datastructures import QueryParams

from music_app.services.library_roots import library_category_slugs
from music_app.services.private_search_contract import (
    ListenerSearchRequest, PopularitySearchRequest, PrivateSearchError,
    PrivateSearchRequest, _popularity_tokens, is_private_search_request,
    normalize_popularity_search_query, normalize_private_search_request,
)
from music_app.services.private_popularity_search_cursor import PopularitySearchCodec
from music_app.services.private_popularity_search_inventory import _matches
from music_app.services.private_popularity_search_postgres import (
    PostgresPopularitySearch, normalize_popularity_native_command,
)
from music_app.services.view_search import normalize_search_text, split_search_terms


@pytest.mark.parametrize('query,artist,genre,cap', [
    (':tracks :popular genre:"progressive rock"', (), ('progressive rock',), None),
    (':tracks :popular artist:"Rush"', ('Rush',), (), None),
    (':popular genre:jazz per_artist:2', (), ('jazz',), 2),
    ('sort:popular artist:"Rush" per_artist:3', ('Rush',), (), 3),
    (':popular per_artist:3', (), (), 3),
    (' :POPULAR SORT:POPULAR :TRACKS :tracks PER_ARTIST:0001 ', (), (), 1),
    ('per_artist:5000 :popular', (), (), 5000),
])
def test_supported_forms_default_tracks_and_exact_wire(query, artist, genre, cap):
    request = normalize_private_search_request(QueryParams({'q': query}))
    assert type(request) is PopularitySearchRequest
    assert request.query == query
    assert request.presentation == 'tracks'
    assert request.limit == 100 and request.cursor is None
    assert request.criteria.as_payload() == {
        'predicate_domain': 'tracks',
        'sort': {'provider': 'lastfm', 'metric': 'overall_scrobbles', 'direction': 'desc'},
        'artist': {'include': list(artist), 'exclude': []},
        'genre': {'include': list(genre), 'exclude': []}, 'per_artist': cap,
    }
    with pytest.raises(FrozenInstanceError):
        request.criteria.per_artist = 1


@pytest.mark.parametrize('suffix', [
    '@maya', 'listened:all', ':loved', ':obsessed', 'love:loved', 'rating:5',
    'date:2026', 'mood:calm', 'style:rock', 'duration:100', 'persons:maya',
    'plain', 'unknown:value', 'sort:recent', ':albums', ':artists',
    '-:popular', '-sort:popular', '-per_artist:2', '--genre:jazz',
    '- genre:jazz', '-', '–genre:jazz', ':POPULARITY', 'popular:true',
    'artist>Rush', 'genre=jazz', 'per_artist:>2', 'per_artist:<2',
    'per_artist:0', 'per_artist:-1', 'per_artist:+1', 'per_artist:1.0',
    'per_artist:1e2', 'per_artist:١', 'per_artist:１', 'per_artist:5001',
    'per_artist:', 'per_artist:"2"', 'per_artist:2 per_artist:2',
    'per_artist:2 per_artist:3',
])
def test_unsupported_groups_are_located_and_never_become_other_modes(suffix):
    query = ':popular ' + suffix
    with pytest.raises(PrivateSearchError) as caught:
        normalize_private_search_request(QueryParams({'q': query}))
    assert (caught.value.code, caught.value.status_code) == ('unsupported_private_search_combination', 400)
    location = caught.value.location
    assert set(location) == {'start', 'end'}
    assert 9 <= location['start'] < location['end'] <= len(query.encode('utf-16-le')) // 2


@pytest.mark.parametrize('query', ['@maya :popular', '@maya sort:popular', 'per_artist:2', ':tracks artist:Rush'])
def test_mixed_handle_and_missing_popularity_are_rejected(query):
    with pytest.raises(PrivateSearchError) as caught:
        normalize_popularity_search_query(query)
    assert caught.value.code == 'unsupported_private_search_combination'
    assert caught.value.location is not None
    if '@' in query or 'per_artist:' in query:
        with pytest.raises(PrivateSearchError):
            normalize_private_search_request(QueryParams({'q': query}))


@pytest.mark.parametrize('query', [None, 1, True, '', ' \t\n', ':popular\0', ':popular artist:\ud800', ':popular artist:\udfff', ':popular' + ' ' * 193])
def test_invalid_input_and_codepoint_bound(query):
    with pytest.raises(PrivateSearchError) as caught:
        normalize_popularity_search_query(query)
    assert (caught.value.code, caught.value.status_code) == ('invalid_private_search_request', 400)


def test_200_codepoints_are_admitted_even_with_more_utf16_units():
    query = ':popular artist:"' + '😀' * 180 + 'a"'
    assert len(query) == 199
    assert len(query.encode('utf-16-le')) // 2 > 200
    assert normalize_popularity_search_query(query).artist_include == ('😀' * 180 + 'a',)
    assert normalize_popularity_search_query(query + ' ').artist_include == ('😀' * 180 + 'a',)
    with pytest.raises(PrivateSearchError):
        normalize_popularity_search_query(query + '  ')


@pytest.mark.parametrize('fragment,decoded', [
    ('genre:"progressive rock"', 'genre:progressive rock'),
    ("genre:'progressive rock'", 'genre:progressive rock'),
    ('genre:progressive\\ rock', 'genre:progressive rock'),
    ('genre:pro"gressive "rock', 'genre:progressive rock'),
    (r'artist:"A\"B\\C"', 'artist:A"B\\C'),
    (r'artist:"A\qB"', r'artist:A\qB'),
    (r"artist:'A\qB'", r'artist:A\qB'),
    (r"artist:'A\'B", 'artist:A\\B'),
    (r'artist:A\:B', 'artist:A:B'),
    (r'artist:A\\B', 'artist:A\\B'),
])
def test_quote_escape_and_fragment_lexing_preserves_original_spelling(fragment, decoded):
    query = ':popular ' + fragment
    tokens = list(_popularity_tokens(query))
    assert tokens[1] == (decoded, fragment, {'start': 9, 'end': len(query)})
    criteria = normalize_popularity_search_query(query)
    field = 'genre' if fragment.startswith('genre:') else 'artist'
    value = decoded.split(':', 1)[1]
    assert getattr(criteria, field + '_include') == (value.strip(),)
    assert getattr(criteria, field + '_include_terms') == (tuple(split_search_terms(value)),)


@pytest.mark.parametrize('suffix,start_delta', [('artist:"Rush', 7), ("genre:'jazz", 6), ('artist:Rush\\', 11)])
def test_unterminated_quote_and_escape_mark_opening_through_original_end(suffix, start_delta):
    prefix = ':popular artist:"😀 Rush" '
    query = prefix + suffix
    with pytest.raises(PrivateSearchError) as caught:
        normalize_popularity_search_query(query)
    start = len(prefix) + start_delta
    assert caught.value.code == 'invalid_private_search_request'
    assert caught.value.location == {
        'start': len(query[:start].encode('utf-16-le')) // 2,
        'end': len(query.encode('utf-16-le')) // 2,
    }


@pytest.mark.parametrize('fragment', ['artist:', 'artist:""', "genre:''", 'genre:"  "', 'artist:"---"'])
def test_empty_decoded_or_empty_normalized_terms_fail_at_field_span(fragment):
    query = ':popular ' + fragment
    with pytest.raises(PrivateSearchError) as caught:
        normalize_popularity_search_query(query)
    assert caught.value.code == 'invalid_private_search_request'
    assert caught.value.location == {'start': 9, 'end': len(query)}


def test_utf16_error_span_uses_original_whitespace_quotes_and_astral_prefix():
    query = '  :popular artist:"😀 Glass"   mood:calm'
    with pytest.raises(PrivateSearchError) as caught:
        normalize_popularity_search_query(query)
    start = query.index('mood:')
    assert caught.value.location == {'start': start + 1, 'end': len(query) + 1}
    units = query.encode('utf-16-le')
    location = caught.value.location
    assert units[2 * location['start']:2 * location['end']].decode('utf-16-le') == 'mood:calm'


def test_terms_are_normalized_once_glass_and_delimiters_keep_semantics(monkeypatch):
    import music_app.services.view_search as matching
    original = matching.split_search_terms
    calls = []

    def recording_split(value):
        calls.append(value)
        return original(value)

    monkeypatch.setattr(matching, 'split_search_terms', recording_split)
    criteria = normalize_popularity_search_query(':popular artist:Glass genre:"jazz/rock"')
    assert calls == ['Glass', 'jazz/rock']
    assert normalize_search_text('Glass') == 'glas'
    assert normalize_search_text('glas') == 'gla'
    assert criteria.artist_include_terms == (('glas',),)
    assert criteria.genre_include_terms == (('jazz rock', 'jazz', 'rock'),)
    assert criteria.as_payload()['artist']['include'] == ['Glass']
    semantic = criteria.semantic_payload()
    assert semantic['artist']['include'] == [['glas']]
    assert semantic['genre']['include'] == [['jazz rock', 'jazz', 'rock']]
    semantic['artist']['include'][0][0] = 'mutated'
    assert criteria.artist_include_terms == (('glas',),)


def test_equivalent_repeats_deduplicate_by_full_tuple_and_pick_smallest_spelling():
    first = normalize_popularity_search_query(':popular artist:glass artist:Glass artist:GLASS genre:rock genre:jazz genre:rock')
    second = normalize_popularity_search_query('genre:jazz genre:rock artist:GLASS :popular')
    assert first == second
    assert first.artist_include == ('GLASS',)
    assert first.genre_include == ('jazz', 'rock')
    assert normalize_popularity_search_query(':popular artist:Glass').semantic_payload() != normalize_popularity_search_query(':popular artist:glas').semantic_payload()
    assert normalize_popularity_search_query(':popular genre:"jazz/rock"').semantic_payload() != normalize_popularity_search_query(':popular genre:"jazz rock"').semantic_payload()


@pytest.mark.parametrize('query,artist,aliases,genres,expected', [
    (':popular genre:"progressive rock"', 'Rush', [], ['Progressive Rock'], True),
    (':popular genre:"progressive rock"', 'Rush', [], ['rock'], True),
    (':popular artist:Glass', 'Glass', [], ['jazz'], True),
    (':popular artist:Glass', 'Other', ['Glass'], ['jazz'], True),
    (':popular artist:Rush artist:Yes genre:jazz genre:rock', 'Yes', [], ['rock'], True),
    (':popular artist:Rush genre:jazz', 'Other', [], ['jazz'], False),
    (':popular artist:Rush genre:jazz', 'Rush', [], ['metal'], False),
    (':popular -artist:Rush -artist:Yes', 'Yes', [], ['jazz'], False),
    (':popular -genre:jazz -genre:rock', 'Rush', [], ['jazz'], False),
    (':popular genre:jazz -genre:rock', 'Rush', [], ['jazz', 'rock'], False),
    (':popular genre:jazz', 'Rush', [], [None], False),
    (':popular -genre:jazz', 'Rush', [], [None], True),
    (':popular', 'Rush', [], [None], True),
    (':popular genre:jazz', 'Rush', [], [None, 'jazz'], True),
    (':popular -genre:jazz', 'Rush', [], [None, 'jazz'], False),
    (':popular genre:"jazz/rock"', 'Rush', [], ['jazz rock'], True),
    (':popular genre:"jazz/rock"', 'Rush', [], ['jazz'], False),
    (':popular genre:"volume 2"', 'Rush', [], ['volume 2'], True),
    (':popular genre:"volume 2"', 'Rush', [], ['volume 99'], True),
    (':popular genre:2112', 'Rush', [], ['2113'], True),
    (':popular genre:2112', 'Rush', [], ['99'], False),
])
def test_actual_matching_helpers_apply_or_and_negative_and_missing_values(query, artist, aliases, genres, expected):
    # Preserve the existing substring/edit-distance matcher, including numeric
    # near matches and component words; do not invent a stricter Search DSL.
    row = {'visible': True, 'identity': {'availability': 'local', 'artist': artist},
           'aliases': aliases, 'genres': [{'value': value} for value in genres]}
    assert _matches(row, normalize_popularity_search_query(query)) is expected


def test_url_defaults_and_existing_gallery_normalization():
    request = normalize_private_search_request(QueryParams({'q': ':popular'}))
    assert request.gallery_scope == 'all'
    assert request.categories == tuple(sorted(library_category_slugs()))
    assert request.visibility_payload() == {'gallery_scope': 'all', 'categories': sorted(library_category_slugs())}
    category = library_category_slugs()[0]
    request = normalize_private_search_request(QueryParams([
        ('q', ':popular'), ('category', category), ('category', category),
        ('search_page_size', '001'), ('search_cursor', 'x' * 4096),
    ]))
    assert request.categories == (category,) and request.limit == 1
    assert request.cursor == 'x' * 4096
    request = normalize_private_search_request(QueryParams({'q': ':popular', 'gallery_scope': 'new_arrivals'}))
    assert request.categories == ('new_arrivals',)


@pytest.mark.parametrize('key,value', [
    ('artist', 'Rush'), ('all_artists', '1'), ('omit_sidebar', '1'),
    ('search_sidebar_cursor', 'x'), ('search_detail_album_ref', 'x'),
    ('search_sidebar_only', '1'), ('payload_tier', 'full'), ('gallery_display', 'cards'),
    ('gallery_scale_percent', '100'), ('unknown', 'x'), ('surface', 'tracks'),
    ('gallery_scope', 'ALL'), ('category', 'invented'), ('category', ''),
    ('search_page_size', '0'), ('search_page_size', '101'), ('search_page_size', '+1'),
    ('search_page_size', '1.0'), ('search_page_size', '١'), ('search_page_size', '0001'),
    ('search_cursor', ''), ('search_cursor', 'x' * 4097), ('search_cursor', 'é'),
])
def test_url_closed_keys_and_scalar_bounds(key, value):
    with pytest.raises(PrivateSearchError) as caught:
        normalize_private_search_request(QueryParams({'q': ':popular', key: value}))
    assert caught.value.status_code == 400


@pytest.mark.parametrize('key,value', [('q', ':popular'), ('surface', 'albums'), ('search_page_size', '10'), ('search_presentation', 'tracks'), ('search_cursor', 'x'), ('gallery_scope', 'all')])
def test_url_singletons_reject_even_identical_duplicates(key, value):
    pairs = [('q', ':popular')] if key != 'q' else []
    with pytest.raises(PrivateSearchError):
        normalize_private_search_request(QueryParams(pairs + [(key, value), (key, value)]))


def test_category_repetition_bound_and_supported_presentations_location():
    category = library_category_slugs()[0]
    pairs = [('q', ':popular')] + [('category', category)] * 32
    assert normalize_private_search_request(QueryParams(pairs)).categories == (category,)
    with pytest.raises(PrivateSearchError):
        normalize_private_search_request(QueryParams(pairs + [('category', category)]))
    query = ':popular artist:"😀 Rush"'
    for presentation in ('tracks', 'albums'):
        assert normalize_private_search_request(QueryParams(
            {'q': query, 'search_presentation': presentation})).presentation == presentation
    with pytest.raises(PrivateSearchError) as caught:
        normalize_private_search_request(QueryParams({'q': query, 'search_presentation': 'artists'}))
    assert caught.value.code == 'unsupported_private_search_combination'
    assert caught.value.location == {'start': 0, 'end': len(query) + 1}


def test_existing_dispatch_remains_discriminated():
    assert type(normalize_private_search_request(QueryParams({'q': ':loved'}))) is PrivateSearchRequest
    assert type(normalize_private_search_request(QueryParams({'q': '@maya'}))) is ListenerSearchRequest
    assert type(normalize_private_search_request(QueryParams({'q': ':popular'}))) is PopularitySearchRequest
    assert is_private_search_request(QueryParams({'q': ':popular'})) is True
    for surface in ('playlists', 'album_tops'):
        assert is_private_search_request(QueryParams({'surface': surface, 'q': ':popular'})) is False


@pytest.fixture
def codec_payload():
    return {'version': 1, 'kind': 'page', 'scope_digest': '1' * 64, 'evidence_digest': '2' * 64,
            'offset': 1, 'limit': 100, 'issued_at': 1000, 'expires_at': 2800,
            'query': ':popular artist:Glass',
            'visibility': {'gallery_scope': 'all', 'categories': sorted(library_category_slugs())}}


@pytest.fixture
def codec():
    return PopularitySearchCodec('a' * 32)


@pytest.mark.parametrize('kind,offset', [('page', 1), ('publication', 0)])
def test_token_roundtrip_exact_schema_and_independent_key_derivation(codec, codec_payload, kind, offset):
    payload = dict(codec_payload, kind=kind, offset=offset)
    token = codec.encode(payload, kind, 1000)
    assert len(token) <= 4096
    label = ('album-haven-popularity-search-' + kind + '-v1').encode('ascii')
    key = base64.urlsafe_b64encode(hashlib.sha256(label + b'\0' + b'a' * 32).digest())
    recovered = json.loads(Fernet(key).decrypt(token.encode('ascii')))
    assert recovered == payload
    assert set(recovered) == {'version', 'kind', 'scope_digest', 'evidence_digest', 'offset', 'limit', 'issued_at', 'expires_at', 'query', 'visibility'}
    assert codec.decode(token, kind, 1000) == payload
    assert codec.decode(token, kind, 2799) == payload
    assert payload['query'] not in token and 'inventory-track:' not in token


@pytest.mark.parametrize('kind', ['page', 'publication'])
def test_wrong_valid_length_secret_and_opposite_family_are_malformed(codec, codec_payload, kind):
    payload = dict(codec_payload, kind=kind)
    token = codec.encode(payload, kind, 1000)
    for other, family in [(PopularitySearchCodec('b' * 32), kind), (codec, 'publication' if kind == 'page' else 'page')]:
        with pytest.raises(PrivateSearchError) as caught:
            other.decode(token, family, 1000)
        assert (caught.value.code, caught.value.status_code) == ('invalid_private_search_request', 400)


@pytest.mark.parametrize('secret', [None, 1, True, '', 'a' * 31, '\ud800' + 'a' * 32])
def test_invalid_server_secret_is_unavailable_not_bad_user_input(secret):
    with pytest.raises(PrivateSearchError) as caught:
        PopularitySearchCodec(secret)
    assert (caught.value.code, caught.value.status_code) == ('private_search_unavailable', 503)


@pytest.mark.parametrize('field,value', [
    ('version', True), ('version', 2), ('version', '1'), ('kind', 'publication'),
    ('scope_digest', 'A' * 64), ('scope_digest', 'a' * 63), ('scope_digest', None),
    ('evidence_digest', 'g' * 64), ('evidence_digest', True),
    ('offset', True), ('offset', -1), ('offset', 1.0), ('offset', 9007199254740992),
    ('limit', True), ('limit', 0), ('limit', 101), ('limit', 1.0),
    ('issued_at', True), ('issued_at', -1), ('issued_at', 1.0),
    ('expires_at', True), ('expires_at', -1), ('expires_at', 9007199254740992),
    ('query', None), ('query', ':popular\0'), ('query', ':popular\ud800'),
    ('query', ':popular' + ' ' * 193), ('query', '@maya'),
    ('visibility', None), ('visibility', []),
    ('visibility', {'gallery_scope': 'all'}),
    ('visibility', {'categories': []}),
    ('visibility', {'gallery_scope': 'all', 'categories': ['new_arrivals', 'new_arrivals']}),
    ('visibility', {'gallery_scope': 'all', 'categories': [], 'extra': True}),
    ('visibility', {'gallery_scope': 'ALL', 'categories': []}),
    ('visibility', {'gallery_scope': 'unknown', 'categories': []}),
    ('visibility', {'gallery_scope': 'all', 'categories': 'main'}),
    ('visibility', {'gallery_scope': 'all', 'categories': [None]}),
    ('visibility', {'gallery_scope': 'all', 'categories': ['x' * 101]}),
    ('visibility', {'gallery_scope': 'all', 'categories': ['invented']}),
    ('visibility', {'gallery_scope': 'all', 'categories': ['new_arrivals'] * 33}),
])
def test_authenticated_malformed_shape_types_and_values_are_400(codec, codec_payload, field, value):
    payload = deepcopy(codec_payload)
    payload[field] = value
    # Encrypt independently, so encode validation cannot mask decode failures.
    key = base64.urlsafe_b64encode(hashlib.sha256(b'album-haven-popularity-search-page-v1\0' + b'a' * 32).digest())
    token = Fernet(key).encrypt(json.dumps(payload).encode('utf-8')).decode('ascii')
    with pytest.raises(PrivateSearchError) as caught:
        codec.decode(token, 'page', 1000)
    assert caught.value.status_code == 400


@pytest.mark.parametrize('removed', ['version', 'kind', 'scope_digest', 'evidence_digest', 'offset', 'limit', 'issued_at', 'expires_at', 'query', 'visibility', None])
def test_every_payload_key_required_and_surplus_forbidden(codec, codec_payload, removed):
    payload = deepcopy(codec_payload)
    if removed is None:
        payload['extra'] = 'forbidden'
    else:
        del payload[removed]
    key = base64.urlsafe_b64encode(hashlib.sha256(b'album-haven-popularity-search-page-v1\0' + b'a' * 32).digest())
    token = Fernet(key).encrypt(json.dumps(payload).encode()).decode()
    with pytest.raises(PrivateSearchError) as caught:
        codec.decode(token, 'page', 1000)
    assert caught.value.status_code == 400


@pytest.mark.parametrize('raw', [b'[]', b'null', b'{', b'\xff', b'{"version":1,"version":1}', b'{"x":NaN}', b'{"x":Infinity}', b'{"x":-Infinity}'])
def test_authenticated_nonobject_invalid_utf8_duplicate_and_nonfinite_json(codec, raw):
    key = base64.urlsafe_b64encode(hashlib.sha256(b'album-haven-popularity-search-page-v1\0' + b'a' * 32).digest())
    token = Fernet(key).encrypt(raw).decode()
    with pytest.raises(PrivateSearchError) as caught:
        codec.decode(token, 'page', 1000)
    assert caught.value.status_code == 400


@pytest.mark.parametrize('token', [None, True, 1, '', ' ', 'é', 'x' * 4097, 'bad.token', 'abc===', 'abc\n', 'A'])
def test_malformed_ciphertext_has_no_restart_or_browse_fallback(codec, token):
    with pytest.raises(PrivateSearchError) as caught:
        codec.decode(token, 'page', 1000)
    assert (caught.value.code, caught.value.status_code) == ('invalid_private_search_request', 400)


@pytest.mark.parametrize('kind', ['page', 'publication'])
@pytest.mark.parametrize('now', [999, 2800, 2801])
def test_zero_forward_skew_and_exclusive_expiry_are_restart(codec, codec_payload, kind, now):
    payload = dict(codec_payload, kind=kind)
    token = codec.encode(payload, kind, 1000)
    with pytest.raises(PrivateSearchError) as caught:
        codec.decode(token, kind, now)
    assert (caught.value.code, caught.value.status_code) == ('search_cursor_restart_required', 409)


@pytest.mark.parametrize('changes', [{'expires_at': 2799}, {'expires_at': 2801}, {'offset': 0}])
def test_authenticated_impossible_lifetime_or_page_interval_is_restart(codec, codec_payload, changes):
    payload = dict(codec_payload, **changes)
    key = base64.urlsafe_b64encode(hashlib.sha256(b'album-haven-popularity-search-page-v1\0' + b'a' * 32).digest())
    token = Fernet(key).encrypt(json.dumps(payload).encode()).decode()
    with pytest.raises(PrivateSearchError) as caught:
        codec.decode(token, 'page', 1000)
    assert (caught.value.code, caught.value.status_code) == ('search_cursor_restart_required', 409)


def test_family_times_survive_successor_encoding_without_refresh(codec, codec_payload):
    token = codec.encode(codec_payload, 'page', 1000)
    continuation = codec.decode(token, 'page', 2000)
    publication = dict(continuation, kind='publication')
    next_page = dict(continuation, offset=101)
    for kind, payload in [('publication', publication), ('page', next_page)]:
        successor = codec.encode(payload, kind, 2000)
        decoded = codec.decode(successor, kind, 2799)
        assert (decoded['issued_at'], decoded['expires_at']) == (1000, 2800)
        with pytest.raises(PrivateSearchError) as caught:
            codec.decode(successor, kind, 2800)
        assert caught.value.status_code == 409


@pytest.mark.parametrize('now', [None, True, -1, 1000.0, 9007199254740992])
def test_invalid_authoritative_clock_is_unavailable(codec, codec_payload, now):
    token = codec.encode(codec_payload, 'page', 1000)
    with pytest.raises(PrivateSearchError) as caught:
        codec.decode(token, 'page', now)
    assert (caught.value.code, caught.value.status_code) == ('private_search_unavailable', 503)


def test_maximum_query_and_category_input_reconstructs_without_truncation(codec, codec_payload):
    # Astral codepoints expand to four UTF-8 bytes; escaped quotes expand in JSON.
    query = ':popular artist:"' + '😀' * 160 + '\\"' * 10 + 'a" '
    assert len(query) == 200
    categories = library_category_slugs()
    pairs = [('q', query)] + [('category', categories[index % len(categories)]) for index in range(32)]
    request = normalize_private_search_request(QueryParams(pairs))
    payload = dict(codec_payload, query=request.query, visibility=request.visibility_payload())
    for kind in ('page', 'publication'):
        current = dict(payload, kind=kind)
        token = codec.encode(current, kind, 1000)
        assert len(token) <= 4096
        decoded = codec.decode(token, kind, 1000)
        assert decoded == current
        assert normalize_popularity_search_query(decoded['query']).semantic_payload() == request.criteria.semantic_payload()


def test_row_reference_is_keyed_domain_separated_and_bound_to_full_coordinates(codec):
    digest = 'a' * 64
    row_ref = codec.row_ref(digest, 1, 2)
    key = hmac.new(b'a' * 32, b'album-haven-popularity-search-row-v1', hashlib.sha256).digest()
    expected = 'popular_' + hmac.new(key, json.dumps([digest, 1, 2], separators=(',', ':')).encode(), hashlib.sha256).hexdigest()
    assert row_ref == expected and len(row_ref) == 72
    assert len({row_ref, codec.row_ref('b' * 64, 1, 2), codec.row_ref(digest, 2, 2), codec.row_ref(digest, 1, 3), PopularitySearchCodec('b' * 32).row_ref(digest, 1, 2)}) == 5


@pytest.mark.parametrize('library_id,track_id', [(0, 1), (1, 0), (-1, 1), (1, True), (True, 1), (1, 1.0), (9223372036854775808, 1), (1, 9223372036854775808)])
def test_row_reference_rejects_invalid_server_coordinates(codec, library_id, track_id):
    with pytest.raises(PrivateSearchError) as caught:
        codec.row_ref('a' * 64, library_id, track_id)
    assert caught.value.status_code == 503


@pytest.mark.parametrize('operation,intent,target_kind', [
    ('bindings', None, 'absent'), ('batch', 'metadata', 'absent'), ('batch', 'play', 'absent'),
    ('single', 'metadata', 'absent'), ('single', 'play', 'absent'),
    ('single', 'details', 'absent'), ('single', 'details', 'album'),
])
def test_native_commands_accept_only_supported_forms_and_preserve_order(operation, intent, target_kind):
    refs = ['popular_' + 'b' * 64, 'popular_' + 'a' * 64]
    command = {'result_token': 'x' * 4096}
    command['row_ref' if operation == 'single' else 'row_refs'] = refs[0] if operation == 'single' else refs
    if intent is not None:
        command['intent'] = intent
    if target_kind != 'absent':
        command['target_kind'] = target_kind
    before = deepcopy(command)
    assert normalize_popularity_native_command(command, operation=operation) == (refs[:1] if operation == 'single' else refs)
    assert command == before


@pytest.mark.parametrize('intent,target_kind', [
    ('details', 'artist'), ('details', None), ('details', True),
    ('metadata', 'album'), ('play', 'album'), ('metadata', None), ('play', None),
    ('details', 'Album'), ('details', ''),
])
def test_all_explicit_unsupported_target_kind_states_are_422(intent, target_kind):
    command = {'result_token': 'x', 'row_ref': 'popular_' + 'a' * 64, 'intent': intent, 'target_kind': target_kind}
    with pytest.raises(PrivateSearchError) as caught:
        normalize_popularity_native_command(command, operation='single')
    assert (caught.value.code, caught.value.status_code) == ('invalid_command', 422)


@pytest.mark.parametrize('operation,intent', [('batch', 'details'), ('single', None), ('single', True), ('single', 'PLAY'), ('single', 'unknown')])
def test_native_invalid_intent_is_422(operation, intent):
    command = {'result_token': 'x', 'intent': intent}
    command['row_ref' if operation == 'single' else 'row_refs'] = 'popular_' + 'a' * 64 if operation == 'single' else ['popular_' + 'a' * 64]
    with pytest.raises(PrivateSearchError) as caught:
        normalize_popularity_native_command(command, operation=operation)
    assert (caught.value.code, caught.value.status_code) == ('invalid_command', 422)


@pytest.mark.parametrize('refs', [[], ['popular_' + 'a' * 64] * 2, ('popular_' + 'a' * 64,), 'popular_' + 'a' * 64, [None], [True], ['popular_' + 'A' * 64], ['popular_' + 'a' * 63], ['popular_' + 'g' * 64], ['inventory-track:1:1']])
def test_native_row_list_shape_duplicates_and_reference_dialect_are_400(refs):
    with pytest.raises(PrivateSearchError) as caught:
        normalize_popularity_native_command({'result_token': 'x', 'row_refs': refs}, operation='bindings')
    assert caught.value.status_code == 400


def test_native_batch_100_boundary_and_no_truncation():
    refs = ['popular_' + format(index, '064x') for index in range(101)]
    assert normalize_popularity_native_command({'result_token': 'x', 'row_refs': refs[:100], 'intent': 'play'}, operation='batch') == refs[:100]
    with pytest.raises(PrivateSearchError) as caught:
        normalize_popularity_native_command({'result_token': 'x', 'row_refs': refs, 'intent': 'play'}, operation='batch')
    assert caught.value.status_code == 400


@pytest.mark.parametrize('operation', ['bindings', 'single', 'batch'])
@pytest.mark.parametrize('mutation', ['missing_token', 'missing_ref', 'extra', 'null_token', 'empty_token', 'oversized_token', 'nonascii_token'])
def test_native_exact_keys_and_token_bounds(operation, mutation):
    ref_key = 'row_ref' if operation == 'single' else 'row_refs'
    command = {'result_token': 'x', ref_key: 'popular_' + 'a' * 64 if operation == 'single' else ['popular_' + 'a' * 64]}
    if operation != 'bindings':
        command['intent'] = 'play'
    if mutation == 'missing_token':
        del command['result_token']
    elif mutation == 'missing_ref':
        del command[ref_key]
    elif mutation == 'extra':
        command['extra'] = 1
    else:
        command['result_token'] = {'null_token': None, 'empty_token': '', 'oversized_token': 'x' * 4097, 'nonascii_token': 'é'}[mutation]
    with pytest.raises(PrivateSearchError) as caught:
        normalize_popularity_native_command(command, operation=operation)
    assert caught.value.status_code == 400


def test_real_scope_binds_semantic_terms_not_raw_representatives_or_second_stemming():
    service = PostgresPopularitySearch({})
    live = SimpleNamespace(actor=SimpleNamespace(account_id=1, session_id=2), library_id=3)
    scopes = []
    for query in (':popular artist:Glass', ':popular artist:GLASS', ':popular artist:glas',
                  ':popular genre:"jazz/rock"', ':popular genre:"jazz rock"'):
        request = normalize_private_search_request(QueryParams({'q': query}))
        scopes.append(service._scope(live, request, 'a' * 64))
    assert scopes[0] == scopes[1]
    assert len(set(scopes)) == 4
    request = normalize_private_search_request(QueryParams({'q': ':popular artist:Glass'}))
    for changed in (
        SimpleNamespace(actor=SimpleNamespace(account_id=4, session_id=2), library_id=3),
        SimpleNamespace(actor=SimpleNamespace(account_id=1, session_id=4), library_id=3),
        SimpleNamespace(actor=SimpleNamespace(account_id=1, session_id=2), library_id=4),
    ):
        assert service._scope(changed, request, 'a' * 64) != scopes[0]
    assert service._scope(live, request, 'b' * 64) != scopes[0]
    for params in ({'search_page_size': '1'}, {'gallery_scope': 'new_arrivals'},
                   {'q': ':popular artist:Glass per_artist:1'}):
        changed = normalize_private_search_request(QueryParams({'q': request.query, **params}))
        assert service._scope(live, changed, 'a' * 64) != scopes[0]


def test_ciphertext_authentication_rejects_a_mutated_valid_alphabet_token(codec, codec_payload):
    token = codec.encode(codec_payload, 'page', 1000)
    index = len(token) // 2
    tampered = token[:index] + ('A' if token[index] != 'A' else 'B') + token[index + 1:]
    with pytest.raises(PrivateSearchError) as caught:
        codec.decode(tampered, 'page', 1000)
    assert (caught.value.code, caught.value.status_code) == ('invalid_private_search_request', 400)
