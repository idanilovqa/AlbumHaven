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
