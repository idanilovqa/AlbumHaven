from __future__ import annotations

import urllib.error

from music_app.services import cover_remote_image_downloads


JPEG_BYTES = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x01\x00H\x00H\x00\x00\xff\xd9"
PNG_BYTES = b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde"


class FakeResponse:
    status = 200

    def __init__(
        self,
        payload: bytes,
        *,
        url: str = "https://cdn.example/cover.jpg",
        headers: dict[str, str] | None = None,
    ) -> None:
        self.payload = payload
        self.url = url
        self.headers = headers or {}
        self.read_sizes: list[int] = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self, size: int = -1) -> bytes:
        self.read_sizes.append(size)
        if size is None or size < 0:
            return self.payload
        return self.payload[:size]

    def getheader(self, key: str, default=None):
        return self.headers.get(key, default)


def test_missing_url_does_not_fetch(monkeypatch):
    monkeypatch.setattr(
        cover_remote_image_downloads.urllib.request,
        "urlopen",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("Missing URL must not fetch")),
    )

    result = cover_remote_image_downloads.fetch_remote_image("  ", user_agent="AlbumHavenTests/1.0")

    assert result.payload is None
    assert result.mime_type == "application/octet-stream"
    assert result.reason == "missing_image_url"


def test_successful_image_response_returns_bytes_and_content_type(monkeypatch):
    response = FakeResponse(
        b"image-bytes",
        headers={"Content-Type": "image/png; charset=binary", "Content-Length": "11"},
    )
    captured: dict[str, object] = {}

    def fake_urlopen(request, timeout, context):
        captured["request"] = request
        captured["timeout"] = timeout
        captured["context"] = context
        return response

    monkeypatch.setattr(cover_remote_image_downloads.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(cover_remote_image_downloads, "_http_ssl_context", lambda: "ssl-context")

    result = cover_remote_image_downloads.fetch_remote_image(
        "https://cdn.example/cover.png",
        user_agent="AlbumHavenTests/1.0",
    )

    request = captured["request"]
    assert result.payload == b"image-bytes"
    assert result.mime_type == "image/png"
    assert result.reason == "ok"
    assert request.get_header("User-agent") == "AlbumHavenTests/1.0"
    assert request.get_header("Accept") == cover_remote_image_downloads.IMAGE_ACCEPT_HEADER
    assert captured["timeout"] == 15
    assert captured["context"] == "ssl-context"
    assert response.read_sizes == [cover_remote_image_downloads.MAX_REMOTE_IMAGE_BYTES + 1]


def test_progarchives_image_fetch_uses_shared_referer_header_behavior(monkeypatch):
    response = FakeResponse(JPEG_BYTES, headers={"Content-Type": "image/jpeg"})
    captured: dict[str, object] = {}

    def fake_urlopen(request, timeout, context):
        captured["request"] = request
        return response

    monkeypatch.setattr(cover_remote_image_downloads.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(cover_remote_image_downloads, "_http_ssl_context", lambda: "ssl-context")

    result = cover_remote_image_downloads.fetch_remote_image(
        "https://www.progarchives.com/progressive_rock_discography_covers/1/cover",
        user_agent="AlbumHavenTests/1.0",
    )

    request = captured["request"]
    assert result.payload == JPEG_BYTES
    assert result.reason == "ok"
    assert request.get_header("Referer") == "https://www.progarchives.com/"


def test_missing_content_type_falls_back_to_image_extension(monkeypatch):
    response = FakeResponse(b"image-bytes", url="https://cdn.example/final.webp")
    monkeypatch.setattr(
        cover_remote_image_downloads.urllib.request,
        "urlopen",
        lambda request, timeout, context: response,
    )
    monkeypatch.setattr(cover_remote_image_downloads, "_http_ssl_context", lambda: "ssl-context")

    result = cover_remote_image_downloads.fetch_remote_image(
        "https://cdn.example/original",
        user_agent="AlbumHavenTests/1.0",
    )

    assert result.payload == b"image-bytes"
    assert result.mime_type == "image/webp"
    assert result.reason == "ok"


def test_missing_content_type_extensionless_url_allows_valid_image_bytes(monkeypatch):
    response = FakeResponse(JPEG_BYTES, url="https://cdn.example/image/abc123")
    monkeypatch.setattr(
        cover_remote_image_downloads.urllib.request,
        "urlopen",
        lambda request, timeout, context: response,
    )
    monkeypatch.setattr(cover_remote_image_downloads, "_http_ssl_context", lambda: "ssl-context")

    result = cover_remote_image_downloads.fetch_remote_image(
        "https://cdn.example/image/abc123",
        user_agent="AlbumHavenTests/1.0",
    )

    assert result.payload == JPEG_BYTES
    assert result.mime_type == "image/jpeg"
    assert result.reason == "ok"
    assert response.read_sizes == [cover_remote_image_downloads.MAX_REMOTE_IMAGE_BYTES + 1]


def test_octet_stream_extensionless_url_allows_valid_png_bytes(monkeypatch):
    response = FakeResponse(
        PNG_BYTES,
        url="https://cdn.example/image/abc123",
        headers={"Content-Type": "application/octet-stream"},
    )
    monkeypatch.setattr(
        cover_remote_image_downloads.urllib.request,
        "urlopen",
        lambda request, timeout, context: response,
    )
    monkeypatch.setattr(cover_remote_image_downloads, "_http_ssl_context", lambda: "ssl-context")

    result = cover_remote_image_downloads.fetch_remote_image(
        "https://cdn.example/image/abc123",
        user_agent="AlbumHavenTests/1.0",
    )

    assert result.payload == PNG_BYTES
    assert result.mime_type == "image/png"
    assert result.reason == "ok"
    assert response.read_sizes == [cover_remote_image_downloads.MAX_REMOTE_IMAGE_BYTES + 1]


def test_octet_stream_content_type_falls_back_to_image_extension(monkeypatch):
    response = FakeResponse(
        b"image-bytes",
        url="https://cdn.example/final.jpg",
        headers={"Content-Type": "application/octet-stream"},
    )
    monkeypatch.setattr(
        cover_remote_image_downloads.urllib.request,
        "urlopen",
        lambda request, timeout, context: response,
    )
    monkeypatch.setattr(cover_remote_image_downloads, "_http_ssl_context", lambda: "ssl-context")

    result = cover_remote_image_downloads.fetch_remote_image(
        "https://cdn.example/original",
        user_agent="AlbumHavenTests/1.0",
    )

    assert result.payload == b"image-bytes"
    assert result.mime_type == "image/jpeg"
    assert result.reason == "ok"


def test_text_html_content_type_fails_as_unsupported(monkeypatch):
    response = FakeResponse(b"<html></html>", headers={"Content-Type": "text/html"})
    monkeypatch.setattr(
        cover_remote_image_downloads.urllib.request,
        "urlopen",
        lambda request, timeout, context: response,
    )
    monkeypatch.setattr(cover_remote_image_downloads, "_http_ssl_context", lambda: "ssl-context")

    result = cover_remote_image_downloads.fetch_remote_image(
        "https://cdn.example/page.html",
        user_agent="AlbumHavenTests/1.0",
    )

    assert result.payload is None
    assert result.mime_type == "text/html"
    assert result.reason == "unsupported_content_type"
    assert response.read_sizes == []


def test_json_content_type_fails_as_unsupported(monkeypatch):
    response = FakeResponse(b'{"ok": false}', headers={"Content-Type": "application/json"})
    monkeypatch.setattr(
        cover_remote_image_downloads.urllib.request,
        "urlopen",
        lambda request, timeout, context: response,
    )
    monkeypatch.setattr(cover_remote_image_downloads, "_http_ssl_context", lambda: "ssl-context")

    result = cover_remote_image_downloads.fetch_remote_image(
        "https://cdn.example/payload.json",
        user_agent="AlbumHavenTests/1.0",
    )

    assert result.payload is None
    assert result.mime_type == "application/json"
    assert result.reason == "unsupported_content_type"
    assert response.read_sizes == []


def test_content_length_over_cap_fails_before_body_read(monkeypatch):
    response = FakeResponse(
        b"x" * 10,
        headers={
            "Content-Type": "image/jpeg",
            "Content-Length": str(cover_remote_image_downloads.MAX_REMOTE_IMAGE_BYTES + 1),
        },
    )
    monkeypatch.setattr(
        cover_remote_image_downloads.urllib.request,
        "urlopen",
        lambda request, timeout, context: response,
    )
    monkeypatch.setattr(cover_remote_image_downloads, "_http_ssl_context", lambda: "ssl-context")

    result = cover_remote_image_downloads.fetch_remote_image(
        "https://cdn.example/huge.jpg",
        user_agent="AlbumHavenTests/1.0",
    )

    assert result.payload is None
    assert result.mime_type == "image/jpeg"
    assert result.reason == "remote_image_too_large"
    assert response.read_sizes == []


def test_body_over_cap_fails_when_content_length_missing(monkeypatch):
    response = FakeResponse(
        b"x" * (cover_remote_image_downloads.MAX_REMOTE_IMAGE_BYTES + 1),
        headers={"Content-Type": "image/jpeg"},
    )
    monkeypatch.setattr(
        cover_remote_image_downloads.urllib.request,
        "urlopen",
        lambda request, timeout, context: response,
    )
    monkeypatch.setattr(cover_remote_image_downloads, "_http_ssl_context", lambda: "ssl-context")

    result = cover_remote_image_downloads.fetch_remote_image(
        "https://cdn.example/huge.jpg",
        user_agent="AlbumHavenTests/1.0",
    )

    assert result.payload is None
    assert result.mime_type == "image/jpeg"
    assert result.reason == "remote_image_too_large"
    assert response.read_sizes == [cover_remote_image_downloads.MAX_REMOTE_IMAGE_BYTES + 1]


def test_fetch_failure_shapes_candidate_download_failed(monkeypatch):
    monkeypatch.setattr(
        cover_remote_image_downloads.urllib.request,
        "urlopen",
        lambda request, timeout, context: (_ for _ in ()).throw(
            urllib.error.URLError("network down")
        ),
    )
    monkeypatch.setattr(cover_remote_image_downloads, "_http_ssl_context", lambda: "ssl-context")

    result = cover_remote_image_downloads.fetch_remote_image(
        "https://cdn.example/cover.jpg",
        user_agent="AlbumHavenTests/1.0",
    )

    assert result.payload is None
    assert result.mime_type == "application/octet-stream"
    assert result.reason == "candidate_download_failed"
