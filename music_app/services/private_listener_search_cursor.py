"""Encrypted listener-history continuation syntax, never live authority.

The caller must compare the decoded actor/session/library/context/username,
then recheck the current subject, account reference and relationship revision
under Home's history guard. This module performs no database or policy read.
"""
from __future__ import annotations

import base64
import json
import re
from uuid import UUID

from cryptography.fernet import InvalidToken

from music_app.services.auth_tokens import hash_opaque_token, normalize_login_identifier
from music_app.services.social_cursors import _cipher


_VERSION = 'listener-history-v1'
_MAX_BIGINT = 9223372036854775807
_MAX_PAGE = 10**18
_MAX_TOKEN_LENGTH = 4096
_PAYLOAD_KEYS = {'version', 'scope', 'snapshot_ref', 'page'}
_SCOPE_KEYS = {
    'actor_account_id', 'actor_session_id', 'library_id', 'context_ref',
    'username', 'account_ref', 'audience', 'relationship_revision',
}
_CONTEXT_REF = re.compile(r'[0-9a-f]{64}', re.ASCII)
_SNAPSHOT_REF = re.compile(r'[A-Za-z0-9_-]{43}', re.ASCII)
_CIPHERTEXT = re.compile(r'[A-Za-z0-9_-]+={0,2}', re.ASCII)


def _positive_bigint(value):
    return type(value) is int and 0 < value <= _MAX_BIGINT


def _valid_scope(scope):
    if not isinstance(scope, dict) or set(scope) != _SCOPE_KEYS:
        return False
    if not all(_positive_bigint(scope[key]) for key in
            ('actor_account_id', 'actor_session_id', 'library_id')):
        return False
    context_ref = scope['context_ref']
    if not isinstance(context_ref, str) or not _CONTEXT_REF.fullmatch(context_ref):
        return False
    username = scope['username']
    account_ref = scope['account_ref']
    if not isinstance(account_ref, str) or len(account_ref) != 36:
        return False
    try:
        if normalize_login_identifier(username) != username or str(UUID(account_ref)) != account_ref:
            return False
    except (ValueError, TypeError, AttributeError):
        return False
    audience = scope['audience']
    revision = scope['relationship_revision']
    return ((audience == 'own' and revision is None)
            or (audience == 'friend' and _positive_bigint(revision)))


def _valid_payload(payload):
    if not isinstance(payload, dict) or set(payload) != _PAYLOAD_KEYS:
        return False
    if (payload['version'] != _VERSION or not _valid_scope(payload['scope'])
            or type(payload['page']) is not int or not 2 <= payload['page'] <= _MAX_PAGE):
        return False
    snapshot_ref = payload['snapshot_ref']
    if not isinstance(snapshot_ref, str) or not _SNAPSHOT_REF.fullmatch(snapshot_ref):
        return False
    try:
        hash_opaque_token(snapshot_ref)
    except (ValueError, TypeError):
        return False
    return True


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('Duplicate cursor field.')
        result[key] = value
    return result


def encode_listener_cursor(snapshot_ref, page, *, secret, scope) -> str:
    """Encode only this exact dialect; reject invalid server-side inputs too."""
    payload = {'version': _VERSION, 'scope': scope, 'snapshot_ref': snapshot_ref, 'page': page}
    if not _valid_payload(payload):
        raise ValueError('Invalid Listener cursor.')
    return _cipher(secret).encrypt(json.dumps(payload, separators=(',', ':')).encode()).decode('ascii')


def decode_listener_cursor(token, *, secret):
    """None starts a query; an invalid continuation always raises ValueError.

    Shared encryption key derivation is intentional. Exact payload keys and
    the string version keep Social and own-love Search dialects separate.
    Snapshot expiry and every current authority check belong to the reader.
    """
    if token is None:
        return None
    if (not isinstance(token, str) or not token or len(token) > _MAX_TOKEN_LENGTH
            or not _CIPHERTEXT.fullmatch(token)):
        raise ValueError('Invalid Listener cursor.')
    try:
        encoded = token.encode('ascii')
        decoded = base64.b64decode(encoded, altchars=b'-_', validate=True)
        if base64.urlsafe_b64encode(decoded) != encoded:
            raise ValueError
        payload = json.loads(_cipher(secret).decrypt(encoded), object_pairs_hook=_unique_object)
        if not _valid_payload(payload):
            raise ValueError
    except (InvalidToken, ValueError, TypeError, UnicodeError, RecursionError):
        raise ValueError('Invalid Listener cursor.') from None
    return payload


LIVE_VERSION = 'listener-search-v1'
MAX_SAFE_INTEGER = 9007199254740991
_LIVE_SCOPE_KEYS = _SCOPE_KEYS | {
    'love_include', 'love_exclude', 'page_size', 'love_revision', 'taste_policy_digest',
}


def _valid_live_scope(scope):
    if type(scope) is not dict or set(scope) != _LIVE_SCOPE_KEYS:
        return False
    if not _valid_scope({key: scope[key] for key in _SCOPE_KEYS}):
        return False
    for key in ('love_include', 'love_exclude'):
        values = scope[key]
        if type(values) is not list or values != [v for v in ('loved', 'obsessed') if v in values]:
            return False
    if type(scope['page_size']) is not int or not 1 <= scope['page_size'] <= 100:
        return False
    revision, digest = scope['love_revision'], scope['taste_policy_digest']
    if not (scope['love_include'] or scope['love_exclude']):
        return revision is None and digest is None
    return (type(revision) is int and 0 <= revision <= _MAX_BIGINT
            and isinstance(digest, str) and _CONTEXT_REF.fullmatch(digest) is not None)


def _valid_live_payload(payload, purpose):
    if type(purpose) is not str or purpose not in {'cursor', 'result'} or type(payload) is not dict:
        return False
    keys = {'version', 'purpose', 'scope', 'snapshot_ref'} | ({'position'} if purpose == 'cursor' else set())
    if (set(payload) != keys or payload['version'] != LIVE_VERSION or payload['purpose'] != purpose
            or not _valid_live_scope(payload['scope'])):
        return False
    snapshot = payload['snapshot_ref']
    if not isinstance(snapshot, str) or not _SNAPSHOT_REF.fullmatch(snapshot):
        return False
    try:
        hash_opaque_token(snapshot)
    except (TypeError, ValueError):
        return False
    if purpose == 'cursor':
        position = payload['position']
        if type(position) is not dict or set(position) != {'after_ordinal', 'matched_before'}:
            return False
        after, matched = position['after_ordinal'], position['matched_before']
        if (type(after) is not int or type(matched) is not int
                or not 1 <= after <= MAX_SAFE_INTEGER or not 0 <= matched <= after):
            return False
        if not (payload['scope']['love_include'] or payload['scope']['love_exclude']) and matched != after:
            return False
    return True


def encode_listener_search_token(snapshot_ref, *, secret, scope, purpose, position=None):
    payload = {'version': LIVE_VERSION, 'purpose': purpose, 'scope': scope, 'snapshot_ref': snapshot_ref}
    if purpose == 'cursor':
        payload['position'] = position
    elif position is not None:
        raise ValueError('Invalid Listener Search token.')
    if not _valid_live_payload(payload, purpose):
        raise ValueError('Invalid Listener Search token.')
    token = _cipher(secret).encrypt(json.dumps(payload, separators=(',', ':')).encode()).decode('ascii')
    if len(token) > _MAX_TOKEN_LENGTH:
        raise ValueError('Invalid Listener Search token.')
    return token


def decode_listener_search_token(token, *, secret, purpose):
    if token is None and purpose == 'cursor':
        return None
    if (not isinstance(token, str) or not token or len(token) > _MAX_TOKEN_LENGTH
            or not _CIPHERTEXT.fullmatch(token)):
        raise ValueError('Invalid Listener Search token.')
    try:
        encoded = token.encode('ascii')
        binary = base64.b64decode(encoded, altchars=b'-_', validate=True)
        if base64.urlsafe_b64encode(binary) != encoded:
            raise ValueError
        payload = json.loads(_cipher(secret).decrypt(encoded), object_pairs_hook=_unique_object)
        if not _valid_live_payload(payload, purpose):
            raise ValueError
    except (InvalidToken, ValueError, TypeError, UnicodeError, RecursionError):
        raise ValueError('Invalid Listener Search token.') from None
    return payload
