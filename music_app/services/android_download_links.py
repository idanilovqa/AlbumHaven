"""Cookie-less links for downloads the Android app hands to ``DownloadManager`` (owner decision 1B).

``DownloadManager`` keeps every request, headers included, in its own database, so the app never
gives it the session cookie. The page asks for a link instead, and the app enqueues
``/downloads/<token>``: a five-minute HMAC token naming one same-origin path and the account.
Tokens are never stored or logged; ``download_links_asgi`` authorizes each issue and each fetch.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from music_app.services.signed_links import LinkSigner

LINK_PREFIX = "/downloads/"
LINK_SECONDS = 300
_CONTEXT = b"album-haven-download-link-v1\0"


class DownloadLinks:
    def __init__(self, auth_policy_config, *, clock=None):
        self._signer = LinkSigner(auth_policy_config, _CONTEXT)
        self._clock = clock or (lambda: datetime.now(timezone.utc))

    @property
    def available(self) -> bool:
        return self._signer.available

    def issue(self, account_id: int, path: str) -> dict:
        expires = self._clock() + timedelta(seconds=LINK_SECONDS)
        token = self._signer.sign({"v": 1, "a": account_id, "p": path, "e": int(expires.timestamp())})
        return {"url": f"{LINK_PREFIX}{token}", "expiresAt": expires.isoformat()}

    def resolve(self, token) -> tuple[int, str] | None:
        """The account and path a genuine, current token names; None for anything else."""
        claims = self._signer.verify(token)
        if claims is None or claims.get("v") != 1:
            return None
        account_id, path, expires = claims.get("a"), claims.get("p"), claims.get("e")
        if (type(account_id) is not int or type(expires) is not int or not isinstance(path, str)
                or expires <= self._clock().timestamp()):
            return None
        return account_id, path
