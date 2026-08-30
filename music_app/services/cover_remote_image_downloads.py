from __future__ import annotations

import logging
import mimetypes
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass

from music_app.services.cover_provider_http import (
    _http_request_headers,
    _http_ssl_context,
    _sanitize_url_for_log,
)


MAX_REMOTE_IMAGE_BYTES = 32 * 1024 * 1024
IMAGE_ACCEPT_HEADER = "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
_LOGGER = logging.getLogger(__name__)
_FALLBACK_MIME_TYPE = "application/octet-stream"
_EXTENSION_ALLOWED_FALLBACK_TYPES = {"", _FALLBACK_MIME_TYPE}
_OBVIOUS_NON_IMAGE_TYPES = {
    "application/json",
    "application/xhtml+xml",
    "text/html",
    "text/json",
    "text/plain",
    "text/xml",
}
_IMAGE_EXTENSION_MIME_TYPES = {
    ".apng": "image/apng",
    ".avif": "image/avif",
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
}


@dataclass(frozen=True)
class RemoteImageFetchResult:
    payload: bytes | None
    mime_type: str
    reason: str
    final_url: str


def fetch_remote_image(
    url: str,
    *,
    user_agent: str,
    service: str = "manual-remote",
    context: str = "remote-image",
) -> RemoteImageFetchResult:
    normalized_url = str(url or "").strip()
    if not normalized_url:
        return RemoteImageFetchResult(None, _FALLBACK_MIME_TYPE, "missing_image_url", "")

    request = urllib.request.Request(
        normalized_url,
        headers=_http_request_headers(
            normalized_url,
            user_agent,
            IMAGE_ACCEPT_HEADER,
        ),
    )
    try:
        with urllib.request.urlopen(request, timeout=15, context=_http_ssl_context()) as response:
            final_url = str(getattr(response, "url", normalized_url) or normalized_url)
            header_mime = _content_type_mime(_response_header(response, "Content-Type"))
            inferred_mime = _infer_mime_type(header_mime, final_url)
            if _content_type_rejected_before_read(header_mime, final_url):
                _LOGGER.debug(
                    "Remote image rejected service=%s context=%s url=%s content_type=%s",
                    service,
                    context,
                    _sanitize_url_for_log(final_url),
                    header_mime,
                )
                return RemoteImageFetchResult(
                    None,
                    inferred_mime,
                    "unsupported_content_type",
                    final_url,
                )

            content_length = _parse_content_length(_response_header(response, "Content-Length"))
            if content_length is not None and content_length > MAX_REMOTE_IMAGE_BYTES:
                return RemoteImageFetchResult(
                    None,
                    inferred_mime,
                    "remote_image_too_large",
                    final_url,
                )

            payload = response.read(MAX_REMOTE_IMAGE_BYTES + 1)
            if len(payload) > MAX_REMOTE_IMAGE_BYTES:
                return RemoteImageFetchResult(
                    None,
                    inferred_mime,
                    "remote_image_too_large",
                    final_url,
                )
            if not payload:
                return RemoteImageFetchResult(
                    None,
                    inferred_mime,
                    "candidate_download_failed",
                    final_url,
                )
            sniffed_mime = _sniff_image_mime_type(payload)
            if not _payload_allowed(header_mime, final_url, sniffed_mime):
                _LOGGER.debug(
                    "Remote image payload rejected service=%s context=%s url=%s content_type=%s",
                    service,
                    context,
                    _sanitize_url_for_log(final_url),
                    header_mime,
                )
                return RemoteImageFetchResult(
                    None,
                    inferred_mime,
                    "unsupported_content_type",
                    final_url,
                )
            if sniffed_mime and not inferred_mime.startswith("image/"):
                inferred_mime = sniffed_mime
            return RemoteImageFetchResult(payload, inferred_mime, "ok", final_url)
    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as exc:
        _LOGGER.debug(
            "Remote image fetch failed service=%s context=%s url=%s error=%r",
            service,
            context,
            _sanitize_url_for_log(normalized_url),
            exc,
        )
        return RemoteImageFetchResult(None, _FALLBACK_MIME_TYPE, "candidate_download_failed", normalized_url)
    except Exception as exc:
        _LOGGER.debug(
            "Remote image fetch unexpected failure service=%s context=%s url=%s error=%r",
            service,
            context,
            _sanitize_url_for_log(normalized_url),
            exc,
        )
        return RemoteImageFetchResult(None, _FALLBACK_MIME_TYPE, "candidate_download_failed", normalized_url)


def _response_header(response, key: str) -> str:
    getter = getattr(response, "getheader", None)
    if callable(getter):
        return str(getter(key, "") or "").strip()
    headers = getattr(response, "headers", None)
    if hasattr(headers, "get"):
        return str(headers.get(key, "") or "").strip()
    return ""


def _content_type_mime(content_type: str) -> str:
    return str(content_type or "").split(";", 1)[0].strip().casefold()


def _content_type_rejected_before_read(header_mime: str, final_url: str) -> bool:
    if header_mime.startswith("image/"):
        return False
    if header_mime in _EXTENSION_ALLOWED_FALLBACK_TYPES:
        return bool(_extension_mime_type(final_url)) and not _extension_mime_type(final_url).startswith("image/")
    if header_mime in _OBVIOUS_NON_IMAGE_TYPES:
        return True
    return True


def _payload_allowed(header_mime: str, final_url: str, sniffed_mime: str) -> bool:
    if header_mime.startswith("image/"):
        return True
    if _extension_mime_type(final_url).startswith("image/"):
        return True
    if header_mime in _EXTENSION_ALLOWED_FALLBACK_TYPES and sniffed_mime.startswith("image/"):
        return True
    return False


def _infer_mime_type(header_mime: str, final_url: str) -> str:
    if header_mime.startswith("image/"):
        return header_mime
    extension_mime = _extension_mime_type(final_url)
    if header_mime in _EXTENSION_ALLOWED_FALLBACK_TYPES and extension_mime.startswith("image/"):
        return extension_mime
    return header_mime or extension_mime or _FALLBACK_MIME_TYPE


def _extension_mime_type(url: str) -> str:
    path = urllib.parse.urlsplit(str(url or "")).path
    suffix = ""
    if "." in path:
        suffix = f".{path.rsplit('.', 1)[-1].casefold()}"
    if suffix in _IMAGE_EXTENSION_MIME_TYPES:
        return _IMAGE_EXTENSION_MIME_TYPES[suffix]
    mime_type, _encoding = mimetypes.guess_type(path)
    return str(mime_type or "").strip().casefold()


def _sniff_image_mime_type(payload: bytes) -> str:
    if payload.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if payload.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if payload.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(payload) >= 12 and payload[:4] == b"RIFF" and payload[8:12] == b"WEBP":
        return "image/webp"
    if len(payload) >= 12 and payload[4:8] == b"ftyp" and payload[8:12] in {b"avif", b"avis"}:
        return "image/avif"
    return ""


def _parse_content_length(raw_value: str) -> int | None:
    text = str(raw_value or "").strip()
    if not text:
        return None
    try:
        value = int(text)
    except ValueError:
        return None
    return value if value >= 0 else None
