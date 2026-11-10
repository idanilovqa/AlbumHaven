"""The app page as a copy the Android app keeps for instant return.

The app-copy service worker (static/js/app-copy-worker.js) asks for the app page with
``X-Album-Haven-App-Copy: 1``. Only that page, for a signed-in account, is answered as a copy:
marked with the account it belongs to and the asset version it loads, and revalidated instead of
no-store. Every other response keeps its own policy, so the worker never keeps admin, account or
no-store pages. The worker removes every file path before it stores the page.
"""

from __future__ import annotations

import hashlib
from typing import Any

APP_COPY_HEADER = "X-Album-Haven-App-Copy"
ASSET_VERSION_HEADER = "X-Album-Haven-Asset-Version"
APP_COPY_CACHE_CONTROL = "private, no-cache"


def app_copy_requested(request: Any) -> bool:
    return request.method == "GET" and request.headers.get(APP_COPY_HEADER) == "1"


def app_copy_account(actor: Any) -> str:
    """The copy's owner: stable for one account, and not the account's ID itself."""
    return hashlib.sha256(f"album-haven-app-copy:{actor.account_id}".encode("ascii")).hexdigest()[:32]


def mark_app_copy(response: Any, account: str, asset_version: str) -> None:
    response.headers["Cache-Control"] = APP_COPY_CACHE_CONTROL
    response.headers[APP_COPY_HEADER] = account
    response.headers[ASSET_VERSION_HEADER] = asset_version
