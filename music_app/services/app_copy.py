"""The app page as a copy kept on the device for instant return (Android app and browsers).

The app-copy service worker (static/js/app-copy-worker.js) asks for the app page with
``X-Album-Haven-App-Copy: 1``. Only that page, for a signed-in account, is answered as a copy:
marked with the account it belongs to, the asset version it loads and the time it may be shown
until, and revalidated instead of no-store. Every other response keeps its own policy, so the
worker never keeps admin, account or no-store pages. The worker removes every file path before it
stores the page.

The library data the page reads (``APP_COPY_DATA_PATHS``) is answered the same way when the worker
asks with the same header: a successful JSON answer for a signed-in account is marked as a copy,
and ``X-Album-Haven-App-Copy-Redact`` lists the fields whose values are file paths, which the worker
replaces before it keeps the answer (it keeps nothing that still looks like a path).

``ALBUM_HAVEN_APP_COPY=off`` switches the copy off: pages stop loading its client, and the worker
URL serves a worker that deletes every copy and unregisters itself.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
import hashlib
import os
from typing import Any

from music_app.services.auth_config import SESSION_ABSOLUTE_SECONDS, SESSION_IDLE_SECONDS

APP_COPY_HEADER = "X-Album-Haven-App-Copy"
ASSET_VERSION_HEADER = "X-Album-Haven-Asset-Version"
EXPIRES_HEADER = "X-Album-Haven-App-Copy-Expires"
REDACT_HEADER = "X-Album-Haven-App-Copy-Redact"
APP_COPY_DATA_PATHS = frozenset({"/view-data", "/album-details", "/home-data"})
# Every field of the data answers whose value is a file path, a URL naming one, or a list of them
# (cover paths already leave as references, cover_reference_boundary.py). The worker also replaces
# any other value equal to one of them (a track's `key` is its path). A contract test holds real
# answers to this list.
APP_COPY_REDACTED_KEYS = (
    "path",
    "src",
    "track_path",
    "trackPath",
    "track_ref",
    "track_paths",
    "file_paths",
    "problematic_track_paths",
    "open_directory_paths",
    "folder",
    "music_dir",
    "source_path",
    "file_private_path",
    "scan_current_path",
)
APP_COPY_CACHE_CONTROL = "private, no-cache"
MAX_COPY_AGE = timedelta(days=7)

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


def mark_app_copy_data(request: Any, response: Any) -> None:
    """Marks library data the copy's worker asked for, so it can be kept for the signed-in account."""
    if (
        request.url.path not in APP_COPY_DATA_PATHS
        or response.status_code != 200
        or not app_copy_requested(request)
        or not app_copy_enabled()
        or not str(response.headers.get("content-type") or "").startswith("application/json")
    ):
        return
    actor = getattr(request.state, "current_actor", None)
    if getattr(actor, "account_id", None) is None:
        return
    mark_app_copy(
        response,
        app_copy_account(actor),
        request.app.state.runtime_asset_version,
        app_copy_expires(
            actor,
            (getattr(request.app.state, "auth_policy_config", None) or {}).get("session") or {},
            datetime.now(timezone.utc),
        ),
    )
    response.headers[REDACT_HEADER] = ",".join(APP_COPY_REDACTED_KEYS)
