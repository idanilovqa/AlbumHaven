"""The cacheable-response contract behind the Android app's instant return (IAR-009).

Only the app page fetched by the app-copy service worker, which asks with the
X-Album-Haven-App-Copy request header, is marked as a copy for one account. Every
other response, and the same page fetched normally, keeps its no-store contract.
"""

from __future__ import annotations

import json

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
    # The page is rendered as for any request; the worker removes file paths before storing it.
    assert _bootstrap(body)["initial_view"]["music_dir"] == str(asgi_app.state.config["MUSIC_DIR"])


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

    client = text.index(f'<script src="/static/js/app-copy.js?v={version}" defer></script>')
    assert client < text.index("/static/app.js?v=")
    assert 'id="app-copy-offline-notice"' in text


def test_every_stylesheet_and_script_of_the_app_page_can_be_kept_by_the_copy(asgi_app):
    """Orchestrator round 9: offline, Settings and Account were unstyled. The copy keeps only what
    the server marks immutable, which takes the current version; an unversioned asset is no-store."""
    import re

    version = asgi_app.state.runtime_asset_version
    _status, _headers, body = run_asgi_request(asgi_app, "GET", "/", headers=COPY_REQUEST)
    text = body.decode("utf-8")
    assets = set(re.findall(r'<link rel="stylesheet" href="(/static/[^"]+)"', text))
    assets |= set(re.findall(r'<script src="(/static/[^"]+)"', text))
    assert {"/static/css/account.css", "/static/css/admin-members.css", "/static/css/settings-navigation.css",
            "/static/js/selection-accent.js"} <= {asset.split("?")[0] for asset in assets}

    for asset in sorted(assets):
        path, _, query = asset.partition("?")
        assert query == f"v={version}", asset
        status, headers, _body = run_asgi_request(asgi_app, "GET", path, query={"v": version})
        assert status == 200, asset
        assert headers["cache-control"] == "public, max-age=31536000, immutable", asset


def _signed_in_since(asgi_app, authenticated_at):
    from music_app.services.current_actor import ActorState, CurrentActor, LibraryRelationship

    class Resolver:
        def resolve(self, _raw_token):
            return CurrentActor(
                state=ActorState.ACTIVE,
                account_id=1,
                session_id=1,
                username_display="Rendref",
                authenticated_at=authenticated_at,
                is_bootstrap_owner=True,
                current_library_id=1,
                library_relationships=(LibraryRelationship(1, "owner", True),),
            )

    asgi_app.state.current_actor_resolver = Resolver()


def _expires(headers):
    from datetime import datetime, timezone

    return datetime.fromtimestamp(int(headers["x-album-haven-app-copy-expires"]) / 1000, timezone.utc)


def test_copy_expires_after_seven_days_while_the_session_lasts_longer(asgi_app):
    from datetime import datetime, timedelta, timezone

    now = datetime.now(timezone.utc)
    _signed_in_since(asgi_app, now - timedelta(days=1))

    _status, headers, _body = run_asgi_request(asgi_app, "GET", "/", headers=COPY_REQUEST)

    assert abs(_expires(headers) - (now + timedelta(days=7))) < timedelta(minutes=1)


def test_copy_never_outlives_the_session(asgi_app):
    from datetime import datetime, timedelta, timezone

    now = datetime.now(timezone.utc)
    # The default session ends 90 days after signing in, two days from now.
    _signed_in_since(asgi_app, now - timedelta(days=88))

    _status, headers, _body = run_asgi_request(asgi_app, "GET", "/", headers=COPY_REQUEST)

    assert abs(_expires(headers) - (now + timedelta(days=2))) < timedelta(minutes=1)


def test_copy_never_outlives_a_short_idle_window(asgi_app):
    from datetime import datetime, timedelta, timezone

    now = datetime.now(timezone.utc)
    _signed_in_since(asgi_app, now)
    asgi_app.state.auth_policy_config = {
        **asgi_app.state.auth_policy_config,
        "session": {"idle_seconds": 3 * 3600, "absolute_seconds": 30 * 86400},
    }

    _status, headers, _body = run_asgi_request(asgi_app, "GET", "/", headers=COPY_REQUEST)

    assert abs(_expires(headers) - (now + timedelta(hours=3))) < timedelta(minutes=1)


def test_app_copy_switched_off_retires_the_worker_and_leaves_the_page_without_it(asgi_app, monkeypatch):
    monkeypatch.setenv("ALBUM_HAVEN_APP_COPY", "off")

    status, headers, body = run_asgi_request(asgi_app, "GET", "/app-copy-worker.js")
    _page_status, _page_headers, page = run_asgi_request(asgi_app, "GET", "/")

    assert status == 200
    assert headers["cache-control"] == "no-cache"
    assert b"unregister()" in body and b"album-haven-app-copy-" in body
    assert b"addEventListener('fetch'" not in body
    assert b"/static/js/app-copy.js" not in page
