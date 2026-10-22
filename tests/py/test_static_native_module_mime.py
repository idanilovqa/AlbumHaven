"""Exercise the actual static owner with hostile host MIME classifications."""
import asyncio
from pathlib import Path
from urllib.parse import urlencode

import pytest
from starlette.applications import Starlette
from starlette.routing import Mount
import starlette.responses

from music_app.services.static_assets import NativeModuleStaticFiles


def run_asgi_request(app, method, path, *, query=None, headers=None):
    """Keep the static client connected until the entire response is sent."""
    async def request():
        complete = asyncio.Event()
        messages = []
        request_sent = False

        async def receive():
            nonlocal request_sent
            if not request_sent:
                request_sent = True
                return {"type": "http.request", "body": b"", "more_body": False}
            await complete.wait()
            return {"type": "http.disconnect"}

        async def send(message):
            messages.append(message)
            if message["type"] == "http.response.body" and not message.get("more_body", False):
                complete.set()

        scope = {
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
            "method": method, "scheme": "http", "path": path,
            "raw_path": path.encode("ascii"),
            "query_string": urlencode(query or {}, doseq=True).encode("ascii"),
            "headers": [(b"host", b"testserver"), *[
                (key.lower().encode("latin1"), value.encode("latin1"))
                for key, value in (headers or {}).items()
            ]],
            "client": ("testclient", 50000), "server": ("testserver", 80),
        }
        # A deadline reports a stalled response; it never substitutes for settlement.
        await asyncio.wait_for(app(scope, receive, send), timeout=10)
        assert complete.is_set(), "static response did not finish its body"
        start = next(message for message in messages if message["type"] == "http.response.start")
        return int(start["status"]), {
            key.decode("latin1").lower(): value.decode("latin1")
            for key, value in start.get("headers", [])
        }, b"".join(message.get("body", b"") for message in messages
                     if message["type"] == "http.response.body")

    return asyncio.run(request())


@pytest.fixture
def static_app(tmp_path):
    root = tmp_path / "static"
    root.mkdir()
    for relative, body in {
        "js/home-friends/index-native.mjs": b"export const entry = true;\n",
        "js/playlists/nested/owner.mjs": b"export const owner = true;\n",
        "js/plain.js": b"window.plain = true;\n",
        "css/plain.css": b"body { color: black; }\n",
    }.items():
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(body)
    (tmp_path / "outside.mjs").write_bytes(b"export const private = true;\n")
    return Starlette(routes=[Mount("/static", NativeModuleStaticFiles(directory=root))])


def force_module_mime(monkeypatch, mime):
    original = starlette.responses.guess_type
    def guess(path, *args, **kwargs):
        if Path(path).suffix.lower() == ".mjs":
            return mime, None
        return original(path, *args, **kwargs)
    monkeypatch.setattr(starlette.responses, "guess_type", guess)


@pytest.mark.parametrize("mime", [None, "text/plain", "application/octet-stream"])
@pytest.mark.parametrize("method", ["GET", "HEAD"])
@pytest.mark.parametrize("path", [
    "/static/js/home-friends/index-native.mjs",
    "/static/js/playlists/nested/owner.mjs",
])
def test_module_mime_is_explicit_despite_host_guess(static_app, monkeypatch, mime, method, path):
    force_module_mime(monkeypatch, mime)
    status, headers, body = run_asgi_request(static_app, method, path, query={"v": "current"})
    assert status == 200
    assert headers["content-type"] == "text/javascript; charset=utf-8"
    assert int(headers["content-length"]) > 0
    assert "etag" in headers and "last-modified" in headers
    assert body.startswith(b"export ") if method == "GET" else body == b""


def test_module_conditional_and_range_delivery_are_retained(static_app, monkeypatch):
    force_module_mime(monkeypatch, "text/plain")
    path = "/static/js/home-friends/index-native.mjs"
    status, headers, body = run_asgi_request(static_app, "GET", path)
    assert status == 200
    status, cached, cached_body = run_asgi_request(static_app, "GET", path,
        headers={"if-none-match": headers["etag"]})
    assert status == 304
    assert cached_body == b""
    assert cached["etag"] == headers["etag"]
    status, partial, partial_body = run_asgi_request(static_app, "GET", path,
        headers={"range": "bytes=0-5"})
    assert status == 206
    assert partial["content-type"] == "text/javascript; charset=utf-8"
    assert partial["content-range"] == f"bytes 0-5/{len(body)}"
    assert partial_body == body[:6]


@pytest.mark.parametrize("path", ["/static/missing.mjs", "/static/../outside.mjs"])
def test_missing_or_escaping_module_is_not_promoted(static_app, path):
    status, headers, body = run_asgi_request(static_app, "GET", path)
    assert status == 404
    assert not headers.get("content-type", "").startswith("text/javascript")
    assert b"private" not in body


@pytest.mark.parametrize("path", ["/static/js/plain.js", "/static/css/plain.css"])
def test_nonmodule_mime_is_unchanged(static_app, path):
    status, headers, body = run_asgi_request(static_app, "GET", path)
    expected = starlette.responses.guess_type(path)[0] or "text/plain"
    assert status == 200
    assert headers["content-type"].split(";", 1)[0] == expected
    assert body



def test_production_mount_uses_native_module_owner(asgi_app, monkeypatch):
    force_module_mime(monkeypatch, "text/plain")
    mount = next(route for route in asgi_app.routes if getattr(route, "path", None) == "/static")
    assert isinstance(mount.app, NativeModuleStaticFiles)
    for path in ("/static/js/home-friends/index-native.mjs",
                 "/static/js/playlists/native-track-table.mjs"):
        status, headers, body = run_asgi_request(asgi_app, "GET", path,
            query={"v": asgi_app.state.runtime_asset_version})
        assert status == 200
        assert headers["content-type"] == "text/javascript; charset=utf-8"
        assert headers["cache-control"] == "no-store, max-age=0"
        assert b"export " in body
