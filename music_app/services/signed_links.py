"""Short-lived HMAC tokens for links fetched without cookies, such as by Android's ``DownloadManager``.

A token is ``<payload>.<mac>``: base64url compact JSON claims and their HMAC-SHA256 under a key
derived from the auth policy's HMAC secret for one ``context``, so each kind of link is
domain-separated from every other use of that secret. Tokens are never stored or logged; callers
check the claims, including their expiry.
"""

from __future__ import annotations

import base64
import binascii
from collections.abc import Mapping
import hashlib
import hmac
import json
import re

_TOKEN = re.compile(r"[A-Za-z0-9_-]{1,512}\.[A-Za-z0-9_-]{43}")


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode("ascii")


def unb64url(text: str) -> bytes:
    if not isinstance(text, str) or not re.fullmatch(r"[A-Za-z0-9_-]*", text):
        raise ValueError()
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


class LinkSigner:
    def __init__(self, auth_policy_config, context: bytes):
        hmac_config = auth_policy_config.get("hmac") if isinstance(auth_policy_config, Mapping) else None
        secret = hmac_config.get("secret") if isinstance(hmac_config, Mapping) else None
        self._key = (
            hmac.new(secret.encode("utf-8"), context, hashlib.sha256).digest()
            if isinstance(secret, str) and len(secret.encode("utf-8")) >= 32 else None
        )

    @property
    def available(self) -> bool:
        """False without a usable policy secret: nothing is signed and every token is refused."""
        return self._key is not None

    def _mac(self, payload: str) -> str:
        return b64url(hmac.new(self._key, payload.encode("ascii"), hashlib.sha256).digest())

    def sign(self, claims: dict) -> str:
        payload = b64url(json.dumps(claims, separators=(",", ":"), sort_keys=True).encode("utf-8"))
        return f"{payload}.{self._mac(payload)}"

    def verify(self, token) -> dict | None:
        """The claims of a genuine token, or None when it is malformed or forged."""
        if self._key is None or not isinstance(token, str) or not _TOKEN.fullmatch(token):
            return None
        payload, signature = token.split(".")
        if not hmac.compare_digest(signature, self._mac(payload)):
            return None
        try:
            claims = json.loads(unb64url(payload))
        except (ValueError, binascii.Error):
            return None
        return claims if isinstance(claims, dict) else None
