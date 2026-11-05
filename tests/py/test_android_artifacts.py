import asyncio
import hashlib
from urllib.parse import quote

import pytest
from fastapi import FastAPI

from music_app.routes.android_artifacts_asgi import ARTIFACTS_DIR_ENV, router
from music_app.services.current_actor import CurrentActor
from music_app.services.private_route_boundary import _is_public, install_private_route_boundary


class _Resolver:
    def __init__(self):
        self.calls = []

    def resolve(self, token):
        self.calls.append(token)
        return CurrentActor.anonymous()


@pytest.fixture
def artifacts(tmp_path, monkeypatch):
    root = tmp_path / "android-artifacts"
    for channel in ("stable", "sandbox"):
        (root / channel).mkdir(parents=True)
    (root / "sandbox" / "manifest.json").write_text('{"schemaVersion":1}', encoding="utf-8")
    (root / "sandbox" / "album-haven-2.apk").write_bytes(b"PK\x03\x04apk-bytes")
    (root / "private.txt").write_text("not an artifact", encoding="utf-8")
    monkeypatch.setenv(ARTIFACTS_DIR_ENV, str(root))
    return root


def _app():
    app = FastAPI()
    resolver = _Resolver()
    app.state.current_actor_resolver = resolver
    app.state.config = {"ALBUM_HAVEN_DEPLOYMENT_MODE": "self_hosted"}
    app.state.auth_policy_config = {"hmac": {"secret": "0123456789abcdef0123456789abcdef", "key_version": 7}}
    install_private_route_boundary(app)
    app.include_router(router)
    return app, resolver


def _request(app, path, method="GET"):
    messages = []
    sent = False

    async def receive():
        nonlocal sent
        if sent:
            return {"type": "http.disconnect"}
        sent = True
        return {"type": "http.request", "body": b"", "more_body": False}

    async def send(message):
        messages.append(message)

    asyncio.run(app(
        {
            "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1", "method": method,
            "scheme": "https", "path": path, "raw_path": quote(path).encode("ascii"), "query_string": b"",
            "headers": [(b"host", b"albumhaven.test")], "client": ("127.0.0.1", 50000),
            "server": ("albumhaven.test", 443),
        },
        receive,
        send,
    ))
    start = next(item for item in messages if item["type"] == "http.response.start")
    body = b"".join(item.get("body", b"") for item in messages if item["type"] == "http.response.body")
    headers = {key.decode("latin-1").lower(): value.decode("latin-1") for key, value in start["headers"]}
    return start["status"], headers, body


def test_manifest_is_public_json_that_is_always_revalidated(artifacts):
    app, resolver = _app()
    status, headers, body = _request(app, "/artifacts/android/sandbox/manifest.json")
    assert status == 200
    assert body == b'{"schemaVersion":1}'
    assert headers["content-type"] == "application/json"
    assert headers["cache-control"] == "no-cache"
    assert headers["x-content-type-options"] == "nosniff"
    assert resolver.calls == []


def test_apk_is_public_immutable_and_has_the_package_content_type(artifacts):
    app, resolver = _app()
    status, headers, body = _request(app, "/artifacts/android/sandbox/album-haven-2.apk")
    assert status == 200
    assert hashlib.sha256(body).hexdigest() == hashlib.sha256(b"PK\x03\x04apk-bytes").hexdigest()
    assert headers["content-type"] == "application/vnd.android.package-archive"
    assert headers["cache-control"] == "public, max-age=31536000, immutable"
    assert headers["content-length"] == str(len(b"PK\x03\x04apk-bytes"))
    assert "content-disposition" not in headers
    assert resolver.calls == []


def test_head_reports_the_apk_length_without_a_body(artifacts):
    app, _ = _app()
    status, headers, body = _request(app, "/artifacts/android/sandbox/album-haven-2.apk", method="HEAD")
    assert status == 200
    assert headers["content-length"] == str(len(b"PK\x03\x04apk-bytes"))
    assert body == b""


@pytest.mark.parametrize(
    "path",
    [
        "/artifacts/android/stable/manifest.json",
        "/artifacts/android/other/manifest.json",
        "/artifacts/android/sandbox/",
        "/artifacts/android/sandbox",
        "/artifacts/android/sandbox/missing.apk",
        "/artifacts/android/sandbox/manifest.txt",
        "/artifacts/android/sandbox/..%2Fprivate.txt",
        "/artifacts/android/sandbox/.hidden.apk",
        "/artifacts/android/private.txt",
        "/artifacts/android/",
    ],
)
def test_nothing_else_is_served_and_nothing_reveals_the_directory(artifacts, path):
    app, _ = _app()
    status, _, body = _request(app, path)
    assert status == 404
    assert str(artifacts).encode() not in body
    assert b"android-artifacts" not in body


def test_an_apk_symlink_out_of_the_channel_is_refused(artifacts):
    target = artifacts / "outside.apk"
    target.write_bytes(b"outside")
    link = artifacts / "sandbox" / "linked.apk"
    try:
        link.symlink_to(target)
    except OSError:
        pytest.skip("symlinks are unavailable to this account")
    app, _ = _app()
    status, _, _ = _request(app, "/artifacts/android/sandbox/linked.apk")
    assert status == 404


def test_without_a_configured_directory_everything_is_not_found(monkeypatch):
    monkeypatch.delenv(ARTIFACTS_DIR_ENV, raising=False)
    app, _ = _app()
    status, headers, _ = _request(app, "/artifacts/android/sandbox/manifest.json")
    assert status == 404
    assert headers["cache-control"] == "no-store"


@pytest.mark.parametrize(
    ("method", "path", "public"),
    [
        ("GET", "/artifacts/android/sandbox/manifest.json", True),
        ("HEAD", "/artifacts/android/stable/album-haven-2.apk", True),
        ("POST", "/artifacts/android/sandbox/manifest.json", False),
        ("PUT", "/artifacts/android/sandbox/album-haven-2.apk", False),
        ("GET", "/artifacts/other/manifest.json", False),
        ("GET", "/artifacts", False),
    ],
)
def test_only_reads_under_the_android_artifact_prefix_are_public(method, path, public):
    assert _is_public(method, path) is public
