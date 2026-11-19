from __future__ import annotations

import gzip
import os
from pathlib import Path

import pytest

from music_app.services.compressed_static_files import CompressedStaticFiles
from tests.py.asgi_testing import run_asgi_request

SCRIPT = ("const value = 'album haven';\n" * 200).encode("utf-8")


@pytest.fixture
def static_root(tmp_path):
    (tmp_path / "app.js").write_bytes(SCRIPT)
    (tmp_path / "tiny.css").write_bytes(b"body{}")
    (tmp_path / "cover.png").write_bytes(b"\x89PNG" + bytes(4096))
    return tmp_path


def _get(root: Path, path: str, **headers: str):
    return run_asgi_request(
        CompressedStaticFiles(directory=str(root)), "GET", path, headers=headers
    )


def test_text_assets_are_gzip_encoded_with_their_own_etag(static_root):
    _status, plain_headers, plain_body = _get(static_root, "/app.js")
    status, headers, body = _get(static_root, "/app.js", **{"accept-encoding": "br, gzip"})

    assert status == 200
    assert headers["content-encoding"] == "gzip"
    assert headers["vary"] == "Accept-Encoding"
    assert headers["content-type"] == plain_headers["content-type"]
    assert int(headers["content-length"]) == len(body) < len(SCRIPT)
    assert "accept-ranges" not in headers
    assert gzip.decompress(body) == plain_body == SCRIPT
    assert headers["etag"] != plain_headers["etag"]
    assert headers["etag"].endswith('-gzip"')


@pytest.mark.parametrize("accept_encoding", [None, "identity", "gzip;q=0", "br"])
def test_clients_that_refuse_gzip_receive_the_plain_file(static_root, accept_encoding):
    headers = {"accept-encoding": accept_encoding} if accept_encoding else {}

    status, response_headers, body = _get(static_root, "/app.js", **headers)

    assert status == 200
    assert "content-encoding" not in response_headers
    assert response_headers["vary"] == "Accept-Encoding"
    assert body == SCRIPT


@pytest.mark.parametrize("path", ["/cover.png", "/tiny.css"])
def test_media_and_tiny_files_are_never_compressed(static_root, path):
    status, headers, body = _get(static_root, path, **{"accept-encoding": "gzip"})

    assert status == 200
    assert "content-encoding" not in headers
    assert "vary" not in headers
    assert body == (static_root / path.lstrip("/")).read_bytes()


def test_range_requests_keep_the_plain_partial_response(static_root):
    status, headers, body = _get(
        static_root, "/app.js", **{"accept-encoding": "gzip", "range": "bytes=0-9"}
    )

    assert status == 206
    assert "content-encoding" not in headers
    assert body == SCRIPT[:10]


def test_compressed_etag_revalidates_to_not_modified(static_root):
    _status, headers, _body = _get(static_root, "/app.js", **{"accept-encoding": "gzip"})

    status, revalidated, body = _get(
        static_root,
        "/app.js",
        **{"accept-encoding": "gzip", "if-none-match": headers["etag"]},
    )

    assert status == 304
    assert revalidated["etag"] == headers["etag"]
    assert body == b""


def test_same_size_edit_with_restored_timestamp_serves_the_new_content(static_root):
    asset = static_root / "app.js"
    original = asset.stat()
    _get(static_root, "/app.js", **{"accept-encoding": "gzip"})
    edited = SCRIPT.replace(b"album haven", b"ALBUM HAVEN")
    assert len(edited) == len(SCRIPT)
    asset.write_bytes(edited)
    os.utime(asset, ns=(original.st_atime_ns, original.st_mtime_ns))

    _status, _headers, body = _get(static_root, "/app.js", **{"accept-encoding": "gzip"})

    assert gzip.decompress(body) == edited


def test_app_serves_versioned_runtime_bundle_gzip_encoded_and_immutable(asgi_app):
    status, headers, body = run_asgi_request(
        asgi_app,
        "GET",
        "/static/js/runtime-bundle.js",
        query={"v": asgi_app.state.runtime_asset_version},
        headers={"accept-encoding": "gzip, deflate"},
    )
    bundle = Path(__file__).resolve().parents[2] / "music_app/static/js/runtime-bundle.js"

    assert status == 200
    assert headers["content-encoding"] == "gzip"
    assert headers["cache-control"] == "public, max-age=31536000, immutable"
    assert gzip.decompress(body) == bundle.read_bytes()
