"""The app page as a copy kept on the device for instant return (Android app and browsers).

The app-copy service worker (static/js/app-copy-worker.js) asks for the app page with
``X-Album-Haven-App-Copy: 1``. Only that page, for a signed-in account, is answered as a copy:
marked with the account it belongs to, the asset version it loads and the time it may be shown
until. It is no-store like every other private answer: the worker keeps it by its mark alone, so it
never keeps admin or account pages. The worker empties cover paths and the music directory; a page
with any other file path is not marked (fits_app_copy).

``ALBUM_HAVEN_APP_COPY=off`` switches the copy off: pages stop loading its client, and the worker
URL serves a worker that deletes every copy and unregisters itself.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from datetime import datetime, timedelta
import hashlib
import os
import re
from typing import Any

from music_app.services.auth_config import SESSION_ABSOLUTE_SECONDS, SESSION_IDLE_SECONDS
from music_app.services.cover_reference_boundary import OUTBOUND_FIELDS

APP_COPY_HEADER = "X-Album-Haven-App-Copy"
ASSET_VERSION_HEADER = "X-Album-Haven-Asset-Version"
EXPIRES_HEADER = "X-Album-Haven-App-Copy-Expires"
APP_COPY_CACHE_CONTROL = "private, no-store"
MAX_COPY_AGE = timedelta(days=7)
# Leave the server as cover references (cover_reference_boundary.py) or are emptied by the worker.
_HANDLED_FIELDS = frozenset({*OUTBOUND_FIELDS, "cover_preview_url", "music_dir"})
_PATH_FIELDS = frozenset({
    "path", "paths", "track_path", "trackPath", "track_paths", "file_paths", "problematic_track_paths",
    "open_directory_paths", "display_path", "folder", "folder_path", "source_path", "file_private_path",
    "scan_current_path",
})
# A path as a whole value, one named in an address, or a Windows one inside a sentence.
_PATH_VALUE = re.compile(
    r"^(?:[A-Za-z]:/(?!/)"
    r"|/(?:home|mnt|media|Users|Volumes|srv|data|music|var|opt|tmp|run|net|nas|share|storage|library)/[^/?#\s]+/)"
    r"|[?&](?:track_)?path=[^&]"
    r"|(?:^|[\s(\"'=])(?:[A-Za-z]:\\|\\\\[\w.$-]+\\)"
)

RETIRED_WORKER = """// Album Haven's device copy is switched off: delete every copy and stop.
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(caches.keys()
  .then(names => Promise.all(names.filter(name => name.startsWith('album-haven-app-copy-')).map(name => caches.delete(name))))
  .then(() => self.registration.unregister())));
"""


def app_copy_enabled() -> bool:
    return os.environ.get("ALBUM_HAVEN_APP_COPY", "").strip().casefold() != "off"


def app_copy_requested(request: Any) -> bool:
    return request.method == "GET" and request.headers.get(APP_COPY_HEADER) == "1"


def _names_path(text: str) -> bool:
    # Most of a page is names, with no separator: they never reach the pattern.
    return ("/" in text or "\\" in text or "path=" in text) and _PATH_VALUE.search(text) is not None


def fits_app_copy(payload: object, address_values: Iterable[str]) -> bool:
    """Whether the page starting with this payload, at this address, may be kept on the device."""
    if any(map(_names_path, address_values)):
        return False
    # Containers only, each with the field it is under: a library's artist list is most of the page.
    pending: list[tuple[str, object]] = [("", [payload])]
    while pending:
        field, container = pending.pop()
        named = isinstance(container, dict)
        for key, item in container.items() if named else enumerate(container):
            if named:
                field = str(key)
                if field in _HANDLED_FIELDS:
                    continue
                if _names_path(field):
                    return False
            if isinstance(item, str):
                if item and (field in _PATH_FIELDS or _names_path(item)):
                    return False
            elif isinstance(item, (dict, list, tuple)):
                pending.append((field, item))
    return True


def app_copy_account(actor: Any) -> str:
    """The copy's owner: stable for one account, and not the account's ID itself."""
    return hashlib.sha256(f"album-haven-app-copy:{actor.account_id}".encode("ascii")).hexdigest()[:32]


def app_copy_expires(actor: Any, session_policy: Mapping[str, Any], now: datetime) -> datetime:
    """Seven days from now, but never past the session's idle or absolute end."""
    idle = timedelta(seconds=int(session_policy.get("idle_seconds", SESSION_IDLE_SECONDS)))
    ends = [now + min(MAX_COPY_AGE, idle)]
    if actor.authenticated_at is not None:
        absolute = timedelta(seconds=int(session_policy.get("absolute_seconds", SESSION_ABSOLUTE_SECONDS)))
        ends.append(actor.authenticated_at + absolute)
    return min(ends)


def mark_app_copy(response: Any, account: str, asset_version: str, expires: datetime) -> None:
    response.headers["Cache-Control"] = APP_COPY_CACHE_CONTROL
    response.headers[APP_COPY_HEADER] = account
    response.headers[ASSET_VERSION_HEADER] = asset_version
    response.headers[EXPIRES_HEADER] = str(int(expires.timestamp() * 1000))
