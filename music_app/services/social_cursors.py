"""Encrypted Social pagination positions bound to the current authenticated query."""
from __future__ import annotations

import base64
import hashlib
import json

from cryptography.fernet import Fernet, InvalidToken


def _cipher(secret: object) -> Fernet:
    if not isinstance(secret, str) or len(secret.encode()) < 32:
        raise RuntimeError('Social cursor key is unavailable.')
    key = hashlib.sha256(b'album-haven-social-cursor-v1\0' + secret.encode()).digest()
    return Fernet(base64.urlsafe_b64encode(key))


def encode_social_cursor(position: int | None, *, secret, scope: list) -> str | None:
    if position is None:
        return None
    payload = json.dumps({'scope': scope, 'position': position}, separators=(',', ':')).encode()
    return _cipher(secret).encrypt(payload).decode()


def decode_social_cursor(token: str | None, *, secret, scope: list) -> int:
    if token is None:
        return 0
    if not isinstance(token, str) or len(token) > 4096:
        raise ValueError('Invalid Social cursor.')
    try:
        payload = json.loads(_cipher(secret).decrypt(token.encode()))
        position = payload['position']
        if payload['scope'] != scope or type(position) is not int or position < 1:
            raise ValueError
        return position
    except (InvalidToken, ValueError, KeyError, TypeError, UnicodeError):
        raise ValueError('Invalid Social cursor.') from None


class SearchCursorScopeError(ValueError):
    """A decoded Search cursor belongs to another live query or page kind."""


def search_order_digest(value: list, *, secret) -> str:
    """Bind native private ordering without serializing it into any cursor."""
    import hmac
    return hmac.new(secret.encode(), b'album-haven-search-order-v2\0' +
        json.dumps(value, separators=(',', ':'), ensure_ascii=True).encode(), hashlib.sha256).hexdigest()


def _search_identity(value):
    return (isinstance(value, dict) and set(value) == {'id', 'digest', 'readable'}
            and type(value['readable']) is bool
            and type(value['id']) is int and 0 < value['id'] <= 9223372036854775807
            and isinstance(value['digest'], str) and len(value['digest']) == 64
            and all(ch in '0123456789abcdef' for ch in value['digest']))


def _valid_search_position(position, *, kind='sidebar'):
    if not isinstance(position, dict) or set(position) not in (
            {'anchor', 'pending'}, {'anchor', 'pending', 'anchor_witness'}):
        return False
    anchor = position['anchor']
    if anchor is not None and not _search_identity(anchor):
        return False
    if 'anchor_witness' in position:
        hint = position['anchor_witness']
        if (kind not in {'albums', 'sidebar'} or anchor is None or not anchor['readable']
                or not _search_identity(hint) or not hint['readable']):
            return False
    pending = position['pending']
    return (pending is None or isinstance(pending, dict) and set(pending) == {'candidate', 'witness'}
        and _search_identity(pending['candidate'])
        and (pending['witness'] is None or _search_identity(pending['witness'])))


def _valid_search_selection(selection):
    if not isinstance(selection, dict) or set(selection) != {'state', 'artist', 'witness', 'pending'}:
        return False
    if selection['state'] == 'selected':
        if not _search_identity(selection['artist']) or not _search_identity(selection['witness']):
            return False
        position = selection['pending']
        return (position is None or _valid_search_position(position)
            and position['anchor'] is None and position['pending'] is not None
            and position['pending']['candidate'] == selection['artist'])
    if selection['state'] == 'pending_page':
        return (selection['witness'] is None and (selection['artist'] is None or _search_identity(selection['artist']))
                and (selection['pending'] is None or _valid_search_position(selection['pending'])))
    return selection['state'] in {'all_artists', 'empty'} and selection['artist'] is None and selection['witness'] is None and selection['pending'] is None


def encode_search_cursor(position, *, secret, scope: list, kind: str, selection) -> str:
    """v2 is separate from (and cannot change) existing integer Social cursors."""
    if (kind not in {'sidebar', 'albums', 'tracks', 'detail'}
            or not _valid_search_position(position, kind=kind) or not _valid_search_selection(selection)):
        raise ValueError('Invalid Search cursor position.')
    payload = {'version': 2, 'scope': scope, 'kind': kind, 'position': position, 'selection': selection}
    return _cipher(secret).encrypt(json.dumps(payload, separators=(',', ':')).encode()).decode()


def decode_search_cursor(token, *, secret, scope=None, kind=None):
    if token is None:
        return None
    if not isinstance(token, str) or len(token) > 4096 or not token:
        raise ValueError('Invalid Search cursor.')
    try:
        payload = json.loads(_cipher(secret).decrypt(token.encode()))
        if (not isinstance(payload, dict) or set(payload) != {'version', 'scope', 'kind', 'position', 'selection'}
                or type(payload['version']) is not int or not isinstance(payload['scope'], list)
                or payload['kind'] not in {'sidebar', 'albums', 'tracks', 'detail'}
                or not _valid_search_position(payload['position'], kind=payload['kind'])
                or not _valid_search_selection(payload['selection'])):
            raise ValueError
    except (InvalidToken, ValueError, KeyError, TypeError, UnicodeError):
        raise ValueError('Invalid Search cursor.') from None
    if (payload['version'] != 2 or scope is not None and payload['scope'] != scope
            or kind is not None and payload['kind'] != kind):
        raise SearchCursorScopeError('Search cursor context changed.')
    return payload
