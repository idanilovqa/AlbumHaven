"""Bounded release-group candidates, never admission or local equivalence proof.

Each selected ID still requires the existing exact provider lookup, account-owned
evidence and Add transaction. No search snapshot/digest is accepted as evidence.
"""
from urllib.parse import urlencode

from music_app.services.remote_album_evidence import (
    RemoteAlbumEvidenceError, project_release_group_evidence,
)
from music_app.services.remote_album_provider import _fetch_release_group_json


SEARCH_LIMIT = 10
MAX_SEARCH_TEXT = 100
_LUCENE_SPECIAL = frozenset('+-&|!(){}[]^"~*?:\\/')


def normalize_album_search(title, artist):
    """Literal title and optional credited artist, bounded before any lookup."""
    values = []
    for value in (title, artist):
        if (type(value) is not str or len(value) > MAX_SEARCH_TEXT
                or any(ord(char) < 32 or ord(char) == 127 for char in value)):
            raise RemoteAlbumEvidenceError('invalid_search_query')
        try:
            value.encode('utf-8', errors='strict')
        except UnicodeError:
            raise RemoteAlbumEvidenceError('invalid_search_query') from None
        values.append(value.strip())
    if not values[0]:
        raise RemoteAlbumEvidenceError('invalid_search_query')
    return tuple(values)


def _literal(value):
    # MusicBrainz uses Lucene: quote phrases and escape syntax *before* URL
    # encoding. Operators in user text cannot become query fields or clauses.
    return '"' + ''.join('\\' + char if char in _LUCENE_SPECIAL else char for char in value) + '"'


def release_group_search_url(title, artist):
    title, artist = normalize_album_search(title, artist)
    query = 'releasegroup:' + _literal(title)
    if artist:
        query += ' AND artist:' + _literal(artist)
    return 'https://musicbrainz.org/ws/2/release-group/?' + urlencode(
        [('query', query), ('fmt', 'json'), ('limit', str(SEARCH_LIMIT))])


def search_release_group_candidates(title, artist, *, user_agent, should_cancel=None, get_json=None):
    payload = _fetch_release_group_json(release_group_search_url(title, artist),
        user_agent=user_agent, should_cancel=should_cancel, get_json=get_json,
        context='remote-album-release-group-search')
    if type(payload) is not dict or type(payload.get('release-groups')) is not list:
        raise RemoteAlbumEvidenceError('invalid_provider_metadata')
    rows = payload['release-groups']
    if len(rows) > SEARCH_LIMIT:
        raise RemoteAlbumEvidenceError('invalid_provider_metadata')
    candidates, seen = [], set()
    for row in rows:
        if type(row) is not dict:
            raise RemoteAlbumEvidenceError('invalid_provider_metadata')
        # Reuse strict display projection. These detached facts are previews;
        # their digest is deliberately not returned as an evidence version.
        facts = project_release_group_evidence(row, requested_id=row.get('id'))
        if facts.release_group_id in seen:
            raise RemoteAlbumEvidenceError('invalid_provider_metadata')
        seen.add(facts.release_group_id)
        candidates.append(facts)
    return tuple(candidates)
