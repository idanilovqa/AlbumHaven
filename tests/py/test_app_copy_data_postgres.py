"""IAR-W20..IAR-W22: library data kept on the device for views already seen holds no file path.

The copy's worker keeps the data answers the server marks for it after replacing every value of
the fields the server lists (and every other value equal to one of them, as a track's `key` is its
path). Real answers, from an isolated migrated Postgres library under a distinctive folder, must
name the library root only in those places; anything else would be a path kept on the device.
"""

import json
from urllib.parse import unquote

from music_app.services.app_copy import APP_COPY_REDACTED_KEYS
from tests.py.asgi_testing import run_asgi_request
from tests.py.test_cover_references_postgres import as_actor
from tests.py.test_isolated_postgres_live import watcher_repair_inventory  # noqa: F401 (fixture)
from tests.py.test_live_payloads_carry_no_paths import library_app  # noqa: F401 (fixture)
from tests.py.test_playback_native_postgres import playback_inventory  # noqa: F401 (fixture)

COPY_REQUEST = {"x-album-haven-app-copy": "1"}
REDACTED = frozenset(APP_COPY_REDACTED_KEYS)


def _redacted_values(value, field: str = "") -> set[str]:
    if isinstance(value, dict):
        return {found for key, item in value.items() for found in _redacted_values(item, str(key))}
    if isinstance(value, list):
        return {found for item in value for found in _redacted_values(item, field)}
    return {value} if isinstance(value, str) and value and field in REDACTED else set()


def kept_leaks(payload, root: str) -> list[str]:
    """Each `field: value` naming the library root that the worker would still keep."""
    replaced = _redacted_values(payload)

    def walk(value, field: str = "") -> list[str]:
        if isinstance(value, dict):
            return [leak for key, item in value.items() for leak in walk(item, str(key))]
        if isinstance(value, list):
            return [leak for item in value for leak in walk(item, field)]
        if isinstance(value, str) and value not in replaced and root in unquote(value).replace("\\\\", "\\"):
            return [f"{field}: {value[:160]}"]
        return []

    return walk(payload)


def test_marked_library_data_names_the_library_only_in_fields_the_worker_replaces(library_app):  # noqa: F811
    asgi_app, fixture, root = library_app
    as_actor(asgi_app, fixture.actor)
    surfaces = (
        ("/view-data", {"surface": "albums", "gallery_page_size": "50"}),
        ("/view-data", {"surface": "albums", "artist": "Owner", "payload_tier": "gallery_summary"}),
        ("/home-data", {}),
        ("/album-details", {"album_key": fixture.album_key}),
    )
    found = {}
    for route, query in surfaces:
        status, headers, body = run_asgi_request(asgi_app, "GET", route, query=query, headers=COPY_REQUEST)
        assert status == 200, (route, query, status, body[:300])
        assert headers.get("x-album-haven-app-copy"), (route, "marked as a copy for the account")
        assert headers["x-album-haven-app-copy-redact"].split(",") == list(APP_COPY_REDACTED_KEYS)
        payload = json.loads(body)
        found[f"{route}?{query}"] = kept_leaks(payload, root)
        if route == "/album-details":
            # The album's tracks really do carry their paths; the list is what keeps them off the device.
            assert _redacted_values(payload), "album details name their track files in listed fields"

    assert {surface: leaks for surface, leaks in found.items() if leaks} == {}

