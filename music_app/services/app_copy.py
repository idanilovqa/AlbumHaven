"""The app page as a copy the Android app keeps for instant return.

The app-copy service worker (static/js/app-copy-worker.js) asks for the app page with
``X-Album-Haven-App-Copy: 1``. Only that page, for a signed-in account, is answered as a copy:
marked with the account it belongs to and the asset version it loads, revalidated instead of
no-store, and without the server's library path. Every other response keeps its own policy, so the
worker never keeps admin, account or no-store pages.
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


def without_library_path(value: Any) -> Any:
    """[value] with every view's ``music_dir`` emptied; the page refreshes it from the server."""
    if isinstance(value, dict):
        return {key: "" if key == "music_dir" else without_library_path(item) for key, item in value.items()}
    if isinstance(value, list):
        return [without_library_path(item) for item in value]
    return value


def mark_app_copy(response: Any, account: str, asset_version: str) -> None:
    response.headers["Cache-Control"] = APP_COPY_CACHE_CONTROL
    response.headers[APP_COPY_HEADER] = account
    response.headers[ASSET_VERSION_HEADER] = asset_version
