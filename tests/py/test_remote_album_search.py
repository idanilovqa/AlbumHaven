"""Literal candidate search through the existing strict transport, never live IO."""
import json
from urllib.parse import parse_qs, urlsplit

import pytest

from music_app.services import musicbrainz_http as transport
from music_app.services.remote_album_evidence import RemoteAlbumEvidenceError
from music_app.services.remote_album_provider import fetch_release_group_evidence
from music_app.services.remote_album_search import (
    normalize_album_search, release_group_search_url, search_release_group_candidates,
)
from tests.py.test_musicbrainz_strict_evidence_transport import (
    wire, WireResponse, provider_payload, GROUP, AGENT, URL as LOOKUP_URL,
)


def search_payload():
    return {'release-groups': [provider_payload()], 'count': 1, 'offset': 0}


def test_literal_unicode_artist_and_title_cannot_inject_lucene_or_url_fields():
    title, artist = 'Björk "OR" title:*', 'AC/DC & Friends'
    url = release_group_search_url(title, artist)
    parts = urlsplit(url)
    assert (parts.scheme, parts.netloc, parts.path, parts.fragment) == (
        'https', 'musicbrainz.org', '/ws/2/release-group/', '')
    assert parse_qs(parts.query) == {
        'query': [r'releasegroup:"Björk \"OR\" title\:\*" AND artist:"AC\/DC \& Friends"'],
        'fmt': ['json'], 'limit': ['10'],
    }
    assert transport._strict_release_group_search_url(url)
    assert normalize_album_search('  Album  ', '  ') == ('Album', '')
    assert parse_qs(urlsplit(release_group_search_url('Album', '')).query)['query'] == ['releasegroup:"Album"']


@pytest.mark.parametrize('title,artist', [('', ''), ('   ', ''), (None, ''), ('Album', None),
    ('x'*101, ''), ('Album', 'x'*101), ('bad\nquery', ''), ('Album', '\ud800'),
    ('Album', '\x00'), (True, ''), ('Album', [])])
def test_invalid_input_never_calls_transport(title, artist):
    def forbidden(*args, **kwargs):
        raise AssertionError('Invalid search must not perform IO')
    with pytest.raises(RemoteAlbumEvidenceError, match='invalid_search_query'):
        search_release_group_candidates(title, artist, user_agent=AGENT, get_json=forbidden)


@pytest.mark.parametrize('text', ['x'*100, '😀'*100, '\\'*100])
def test_maximum_title_and_artist_are_accepted_by_fixed_transport_shape(text):
    assert transport._strict_release_group_search_url(release_group_search_url(text, text))


def test_bounded_detached_candidates_ignore_unknown_provider_fields():
    payload = search_payload()
    payload['release-groups'][0]['private_path'] = '/not-returned'
    calls = []
    def getter(url, agent, **options):
        calls.append((url, agent, options))
        return payload, {'status': 'network', 'evidence_policy': transport.STRICT_EVIDENCE_POLICY}
    result = search_release_group_candidates('Example', '', user_agent=AGENT, get_json=getter)
    assert type(result) is tuple and result[0].release_group_id == GROUP
    payload['release-groups'][0]['title'] = 'Mutated'
    assert result[0].title == 'Example Album'
    assert len(calls) == 1 and calls[0][2]['strict_evidence'] is True
    assert calls[0][2]['context'] == 'remote-album-release-group-search'


@pytest.mark.parametrize('payload', [{}, {'releases': []}, {'release-groups': None},
    {'release-groups': [None]}, {'release-groups': [provider_payload()]*11},
    {'release-groups': [provider_payload(), provider_payload()]}])
def test_invalid_entity_shape_count_or_duplicate_identity_fails_closed(payload):
    with pytest.raises(RemoteAlbumEvidenceError):
        search_release_group_candidates('Example', '', user_agent=AGENT,
            get_json=lambda *args, **kwargs: (payload, {
                'status': 'network', 'evidence_policy': transport.STRICT_EVIDENCE_POLICY}))


def test_real_transport_search_and_exact_lookup_have_distinct_cache_entries(wire):
    search = search_payload()
    search['release-groups'][0]['title'] = 'Search preview'
    verified = provider_payload()
    verified['title'] = 'Exact verified title'
    wire.responses.extend([WireResponse(json.dumps(search).encode()),
                           WireResponse(json.dumps(verified).encode())])
    candidate = search_release_group_candidates('Example', '', user_agent=AGENT)[0]
    facts = fetch_release_group_evidence(candidate.release_group_id, user_agent=AGENT)
    assert candidate.title == 'Search preview' and facts.title == 'Exact verified title'
    assert [item[0] for item in wire.requests] == [release_group_search_url('Example', ''), LOOKUP_URL]
    assert len(transport._STRICT_EVIDENCE_URL_CACHE) == 2 and not transport._URL_CACHE
    assert search_release_group_candidates('Example', '', user_agent=AGENT) == (candidate,)
    assert len(wire.requests) == 2


@pytest.mark.parametrize('field,value', [('id', 'local:123'), ('id', None),
    ('id', '00000000-0000-0000-0000-000000000000'), ('title', 'x'*1001),
    ('primary-type', 'Unrecognized'), ('artist-credit', [])])
def test_search_candidate_identity_and_display_facts_use_existing_strict_projection(field, value):
    payload = search_payload()
    payload['release-groups'][0][field] = value
    with pytest.raises(RemoteAlbumEvidenceError):
        search_release_group_candidates('Example', '', user_agent=AGENT,
            get_json=lambda *args, **options: (payload, {
                'status': 'network', 'evidence_policy': transport.STRICT_EVIDENCE_POLICY}))


@pytest.mark.parametrize('status', [301, 302, 307, 308])
def test_search_never_follows_redirects_or_drains_redirect_body(wire, status):
    response = WireResponse(b'x'*100000, status=status, headers={'Location': LOOKUP_URL})
    wire.responses.append(response)
    with pytest.raises(RemoteAlbumEvidenceError, match='provider_unavailable'):
        search_release_group_candidates('Example', '', user_agent=AGENT)
    assert len(wire.requests) == 1 and response.read_sizes == [] and response.closed


def test_search_body_limit_uses_existing_sentinel_and_no_retry(wire):
    response = WireResponse(b'x'*(transport._STRICT_SUCCESS_MAX_BYTES+10))
    wire.responses.append(response)
    with pytest.raises(RemoteAlbumEvidenceError, match='provider_unavailable'):
        search_release_group_candidates('Example', '', user_agent=AGENT)
    assert response.read_sizes == [transport._STRICT_SUCCESS_MAX_BYTES+1]
    assert len(wire.requests) == 1 and wire.sleeps == []


@pytest.mark.parametrize('suffix', ['&offset=10', '&query=other', '&limit=100', '#fragment'])
def test_search_endpoint_refuses_extra_keys_duplicates_and_fragment(wire, suffix):
    url = release_group_search_url('Example', '') + suffix
    assert transport.get_json(url, AGENT, strict_evidence=True)[1]['status'] == 'invalid_evidence_request'
    assert wire.requests == []


@pytest.mark.parametrize('change', ['host', 'path', 'format', 'limit', 'encoding'])
def test_search_transport_shape_is_fixed(wire, change):
    url = release_group_search_url('Example', '')
    url = {'host': url.replace('musicbrainz.org', 'example.invalid'),
           'path': url.replace('/release-group/', '/release/'),
           'format': url.replace('fmt=json', 'fmt=xml'),
           'limit': url.replace('limit=10', 'limit=100'),
           'encoding': url.replace('%3A', '%FF')}[change]
    assert transport.get_json(url, AGENT, strict_evidence=True)[1]['status'] == 'invalid_evidence_request'
    assert wire.requests == []


@pytest.mark.parametrize('when', ['before', 'after'])
def test_search_cancellation_never_returns_candidates(when):
    cancelled = [when == 'before']
    calls = []
    def getter(*args, **options):
        calls.append(True)
        cancelled[0] = True
        return search_payload(), {'status': 'network', 'evidence_policy': transport.STRICT_EVIDENCE_POLICY}
    with pytest.raises(RemoteAlbumEvidenceError, match='provider_cancelled'):
        search_release_group_candidates('Example', '', user_agent=AGENT,
            should_cancel=lambda: cancelled[0], get_json=getter)
    assert calls == ([] if when == 'before' else [True])


@pytest.mark.parametrize('meta', [{'status':'blocked'}, {'status':'cached_miss'}, {'status':'error'},
    {'status':'network'}, {'status':'cache','evidence_policy':'legacy'}])
def test_failed_or_unverified_transport_never_becomes_valid_empty_search(meta):
    with pytest.raises(RemoteAlbumEvidenceError, match='provider_unavailable'):
        search_release_group_candidates('Example', '', user_agent=AGENT,
            get_json=lambda *args, **options: (search_payload(), meta))


def test_verified_empty_search_is_distinct_from_provider_failure():
    assert search_release_group_candidates('Not found', '', user_agent=AGENT,
        get_json=lambda *args, **options: ({'release-groups': []}, {
            'status':'network', 'evidence_policy':transport.STRICT_EVIDENCE_POLICY})) == ()


def test_legacy_search_cache_cannot_supply_strict_candidates(wire):
    url = release_group_search_url('Example', '')
    legacy = search_payload()
    legacy['release-groups'][0]['title'] = 'Legacy poisoned preview'
    transport._set_cached_value(url,'application/json',legacy)
    wire.responses.append(WireResponse(json.dumps(search_payload()).encode()))
    candidate = search_release_group_candidates('Example','',user_agent=AGENT)[0]
    assert candidate.title == 'Example Album' and len(wire.requests) == 1
