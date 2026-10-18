"""Strict, domain-separated encrypted popularity Search token families."""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re

from cryptography.fernet import Fernet, InvalidToken

from music_app.services.gallery_scope import normalize_gallery_scope, normalize_visible_categories
from music_app.services.private_search_contract import PrivateSearchError, normalize_popularity_search_query

_MAX_UINT = 9007199254740991
_KEYS = {'version', 'kind', 'scope_digest', 'evidence_digest', 'offset', 'limit',
         'issued_at', 'expires_at', 'query', 'visibility'}
_LABELS = {'page': b'album-haven-popularity-search-page-v1',
           'publication': b'album-haven-popularity-search-publication-v1',
           'album-page': b'album-haven-popularity-search-album-page-v2',
           'album-publication': b'album-haven-popularity-search-album-publication-v2'}


def _uint(value):
    return type(value) is int and 0 <= value <= _MAX_UINT


def _text(value, maximum):
    return (type(value) is str and len(value) <= maximum and '\0' not in value
            and not any('\ud800' <= ch <= '\udfff' for ch in value))


def _digest(value):
    return type(value) is str and re.fullmatch(r'[0-9a-f]{64}', value) is not None


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate token field.')
        result[key] = value
    return result


def _validate(payload, kind, now_seconds):
    album = type(kind) is str and kind in {'album-page', 'album-publication'}
    keys = _KEYS | {'presentation'} if album else _KEYS
    if type(kind) is not str or kind not in _LABELS or type(payload) is not dict or set(payload) != keys:
        raise PrivateSearchError()
    if (type(payload['version']) is not int or payload['version'] != (2 if album else 1)
            or album and payload['presentation'] != 'albums'
            or payload['kind'] != kind or not _digest(payload['scope_digest'])
            or not _digest(payload['evidence_digest']) or not _uint(payload['offset'])
            or type(payload['limit']) is not int or not 1 <= payload['limit'] <= 100
            or not _uint(payload['issued_at']) or not _uint(payload['expires_at'])
            or not _text(payload['query'], 200)):
        raise PrivateSearchError()
    normalize_popularity_search_query(payload['query'])
    visibility = payload['visibility']
    if (type(visibility) is not dict or set(visibility) != {'gallery_scope', 'categories'}
            or type(visibility['gallery_scope']) is not str
            or visibility['gallery_scope'] not in {'all', 'new_arrivals'}
            or type(visibility['categories']) is not list or len(visibility['categories']) > 32
            or any(not _text(value, 100) for value in visibility['categories'])):
        raise PrivateSearchError()
    scope = normalize_gallery_scope(visibility['gallery_scope'])
    categories = sorted(normalize_visible_categories(visibility['categories'], scope))
    if visibility != {'gallery_scope': scope, 'categories': categories}:
        raise PrivateSearchError()
    if not _uint(now_seconds):
        raise PrivateSearchError('private_search_unavailable', 503)
    if (payload['expires_at'] != payload['issued_at'] + 1800
            or payload['issued_at'] > now_seconds or now_seconds >= payload['expires_at']
            or kind in {'page', 'album-page'} and payload['offset'] < 1):
        raise PrivateSearchError('search_cursor_restart_required', 409)
    return payload


class PopularitySearchCodec:
    def __init__(self, secret):
        if (type(secret) is not str or any('\ud800' <= ch <= '\udfff' for ch in secret)
                or len(secret.encode('utf-8')) < 32):
            raise PrivateSearchError('private_search_unavailable', 503)
        self._secret = secret.encode('utf-8')

    def _cipher(self, kind):
        if type(kind) is not str or kind not in _LABELS:
            raise PrivateSearchError()
        key = hashlib.sha256(_LABELS[kind] + b'\0' + self._secret).digest()
        return Fernet(base64.urlsafe_b64encode(key))

    def encode(self, payload, kind, now_seconds):
        _validate(payload, kind, now_seconds)
        # UTF-8 avoids needless astral expansion; never shorten query/visibility.
        raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(',', ':'),
                         allow_nan=False).encode('utf-8')
        # Fernet overhead is 57 bytes plus PKCS7 padded ciphertext, base64 encoded.
        ciphertext_size = 57 + 16 * (len(raw) // 16 + 1)
        if 4 * ((ciphertext_size + 2) // 3) > 4096:
            raise PrivateSearchError()
        token = self._cipher(kind).encrypt(raw).decode('ascii')
        if len(token) > 4096:
            raise PrivateSearchError()
        return token

    def decode(self, token, kind, now_seconds):
        if (type(token) is not str or not token or len(token) > 4096
                or not token.isascii() or re.fullmatch(r'[A-Za-z0-9_-]+={0,2}', token) is None):
            raise PrivateSearchError()
        try:
            encoded = token.encode('ascii')
            if base64.urlsafe_b64encode(base64.b64decode(encoded, altchars=b'-_', validate=True)) != encoded:
                raise ValueError('Noncanonical token.')
            raw = self._cipher(kind).decrypt(encoded)
            payload = json.loads(raw.decode('utf-8'), object_pairs_hook=_object,
                                 parse_constant=lambda value: (_ for _ in ()).throw(ValueError()))
        except (InvalidToken, ValueError, TypeError, UnicodeError, RecursionError):
            raise PrivateSearchError() from None
        return _validate(payload, kind, now_seconds)

    def row_ref(self, evidence_digest, library_id, track_id):
        if (not _digest(evidence_digest) or type(library_id) is not int
                or type(track_id) is not int or not 1 <= library_id <= 9223372036854775807
                or not 1 <= track_id <= 9223372036854775807):
            raise PrivateSearchError('private_search_unavailable', 503)
        key = hmac.new(self._secret, b'album-haven-popularity-search-row-v1', hashlib.sha256).digest()
        value = json.dumps([evidence_digest, library_id, track_id], separators=(',', ':')).encode('ascii')
        return 'popular_' + hmac.new(key, value, hashlib.sha256).hexdigest()

    def album_ref(self, evidence_digest, library_id, album_id):
        if (not _digest(evidence_digest) or type(library_id) is not int
                or type(album_id) is not int or not 1 <= library_id <= 9223372036854775807
                or not 1 <= album_id <= 9223372036854775807):
            raise PrivateSearchError('private_search_unavailable', 503)
        key = hmac.new(self._secret, b'album-haven-popularity-search-album-row-v2', hashlib.sha256).digest()
        value = json.dumps([evidence_digest, library_id, album_id], separators=(',', ':')).encode('ascii')
        return 'popular_album_' + hmac.new(key, value, hashlib.sha256).hexdigest()
