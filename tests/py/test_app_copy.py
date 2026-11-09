"""The cacheable-response contract behind the Android app's instant return (IAR-009).

Only the app page fetched by the app-copy service worker, which asks with the
X-Album-Haven-App-Copy request header, is marked as a copy for one account. Every
other response, and the same page fetched normally, keeps its no-store contract.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tests.py.asgi_testing import decode_json, run_asgi_request

COPY_REQUEST = {"x-album-haven-app-copy": "1"}


@pytest.fixture(autouse=True)
def postgres_root_startup_view(asgi_app, monkeypatch):
    from music_app.routes import web_asgi

    def fake_build_postgres_root_startup_view(*, config, query_args, library_state):
        album = {"key": "album-1", "name": "Tender Buttons", "tracks": []}
        group = {"artist": "Broadcast", "artist_display": "Broadcast", "albums": [album], "sections": []}
        sidebar = [{"artist": "Broadcast", "artist_display": "Broadcast", "count": 1}]
        return (
            {
                "surface": {"active": "albums"},
                "artist_groups": [group],
                "primary_artist_groups": [group],
                "family_artist_groups": [],
                "artists_sidebar": sidebar,
                "artist_count": 1,
                "album_count": 1,
                "music_dir": str(config["MUSIC_DIR"]),
                "initial_view_partial": True,
            },
            {"artists_sidebar": sidebar, "artist_count": 1, "album_count": 1, "payload_tier": "sidebar"},
            0.0,
        )

    monkeypatch.setattr(web_asgi, "library_browse_postgres_is_effective", lambda _config: True)
    monkeypatch.setattr(web_asgi, "_build_postgres_root_startup_view", fake_build_postgres_root_startup_view)


def _bootstrap(body: bytes) -> dict:
    marker = "window.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__ = "
    text = body.decode("utf-8")
    start = text.index(marker) + len(marker)
    return json.loads(text[start:text.index(";\n", start)])


def test_app_page_fetched_normally_keeps_no_store_and_no_copy_marker(asgi_app):
    status, headers, body = run_asgi_request(asgi_app, "GET", "/")

    assert status == 200
    assert headers["cache-control"] == "no-store, max-age=0"
    assert "x-album-haven-app-copy" not in headers
    assert b'name="album-haven-app-copy"' not in body


def test_app_page_fetched_as_a_copy_is_marked_for_its_account_only(asgi_app):
    status, headers, body = run_asgi_request(asgi_app, "GET", "/", headers=COPY_REQUEST)
    _account_status, _account_headers, account_body = run_asgi_request(asgi_app, "GET", "/app-copy/account")

    assert status == 200
    assert headers["cache-control"] == "private, no-cache"
    assert "pragma" not in headers
    assert headers["x-album-haven-app-copy"] == decode_json(account_body)["account"]
    assert f'<meta name="album-haven-app-copy" content="network" data-account="{headers["x-album-haven-app-copy"]}">'.encode() in body
    assert headers["x-album-haven-asset-version"] == asgi_app.state.runtime_asset_version
    # The copy is the page as rendered, minus the server's library path.
    assert _bootstrap(body)["initial_view"]["music_dir"] == ""
    assert str(Path(asgi_app.state.config["MUSIC_DIR"])).encode("utf-8") not in body


def test_copy_account_key_is_opaque_and_stable(asgi_app):
    status, headers, body = run_asgi_request(asgi_app, "GET", "/app-copy/account")
    _status, _headers, again = run_asgi_request(asgi_app, "GET", "/app-copy/account")

    assert status == 200
    assert headers["cache-control"] == "no-store, max-age=0"
    key = decode_json(body)["account"]
    assert key == decode_json(again)["account"]
    assert len(key) == 32 and set(key) <= set("0123456789abcdef")
    assert key != "1"


def test_copy_account_is_private(asgi_app):
    from music_app.services.current_actor import ActorState, CurrentActor

    class SignedOut:
        def resolve(self, _raw_token):
            return CurrentActor(state=ActorState.ANONYMOUS)

    asgi_app.state.current_actor_resolver = SignedOut()

    status, headers, _body = run_asgi_request(asgi_app, "GET", "/app-copy/account")

    assert status in {401, 403}
    assert "x-album-haven-app-copy" not in headers


@pytest.mark.parametrize("path", ["/bootstrap-data", "/status", "/account", "/admin/members"])
def test_other_responses_are_never_marked_as_copies(asgi_app, path):
    _status, headers, _body = run_asgi_request(asgi_app, "GET", path, headers=COPY_REQUEST)

    assert "x-album-haven-app-copy" not in headers
    if path in {"/account", "/admin/members"}:
        assert headers["cache-control"] == "no-store, max-age=0"


def test_copy_worker_is_served_from_the_origin_root_and_always_revalidated(asgi_app):
    status, headers, body = run_asgi_request(asgi_app, "GET", "/app-copy-worker.js")

    assert status == 200
    assert headers["content-type"].startswith("text/javascript")
    assert headers["cache-control"] == "no-cache"
    assert b"album-haven-app-copy" in body


def test_capability_script_uses_the_exact_runtime_asset_version(asgi_app):
    version = asgi_app.state.runtime_asset_version
    _status, _headers, body = run_asgi_request(asgi_app, "GET", "/")

    assert f'/static/js/capability-ui.js?v={version}"'.encode("ascii") in body
    status, headers, _body = run_asgi_request(
        asgi_app, "GET", "/static/js/capability-ui.js", query={"v": version},
    )
    assert status == 200
    assert headers["cache-control"] == "public, max-age=31536000, immutable"


def test_index_template_loads_the_app_copy_client_before_the_app(asgi_app):
    version = asgi_app.state.runtime_asset_version
    _status, _headers, body = run_asgi_request(asgi_app, "GET", "/")
    text = body.decode("utf-8")

    client = text.index(f'<script src="/static/js/app-copy.js?v={version}"></script>')
    assert client < text.index("/static/app.js?v=")
    assert 'id="app-copy-offline-notice"' in text
