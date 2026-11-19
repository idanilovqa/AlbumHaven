"""Serve compressible static assets gzip-encoded from a content-checked cache."""
from __future__ import annotations

import gzip
import hashlib
import mimetypes
import os
import threading
from pathlib import Path

from starlette.concurrency import run_in_threadpool
from starlette.datastructures import Headers
from starlette.responses import FileResponse, Response
from starlette.staticfiles import NotModifiedResponse, StaticFiles

from music_app.services.http_compression import accepts_gzip

_COMPRESSIBLE_MEDIA_TYPES = (
    "text/",
    "application/javascript",
    "application/json",
    "image/svg+xml",
)
_MIN_COMPRESS_BYTES = 1024
WARMUP_THREAD_NAME = "static-gzip-warmup"


def _is_compressible(media_type: str | None, size: int) -> bool:
    return size >= _MIN_COMPRESS_BYTES and (media_type or "").startswith(
        _COMPRESSIBLE_MEDIA_TYPES
    )


class _GzipCache:
    """Per-process gzip bodies, reused only while the file content is unchanged.

    The key is the file's content digest, not its size or timestamp, so
    same-size edits and restored timestamps still invalidate the entry.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._bodies: dict[str, tuple[bytes, bytes]] = {}
        self._warmed_roots: set[str] = set()

    def body(self, path: str) -> bytes:
        key = os.path.normcase(os.path.realpath(path))
        raw = Path(key).read_bytes()
        digest = hashlib.blake2b(raw, digest_size=16).digest()
        with self._lock:
            cached = self._bodies.get(key)
        if cached is not None and cached[0] == digest:
            return cached[1]
        body = gzip.compress(raw, compresslevel=6, mtime=0)
        with self._lock:
            self._bodies[key] = (digest, body)
        return body

    def warm(self, root: Path) -> None:
        for path in sorted(root.rglob("*")):
            try:
                if path.is_file() and _is_compressible(
                    mimetypes.guess_type(path.name)[0], path.stat().st_size
                ):
                    self.body(str(path))
            except OSError:
                continue

    def warm_in_background(self, root: Path) -> None:
        """Compress once per process so a cold first load never waits on gzip."""
        key = os.path.normcase(os.path.realpath(root))
        with self._lock:
            if key in self._warmed_roots:
                return
            self._warmed_roots.add(key)
        threading.Thread(
            target=self.warm,
            args=(root,),
            name=WARMUP_THREAD_NAME,
            daemon=True,
        ).start()


static_gzip_cache = _GzipCache()


class CompressedStaticFiles(StaticFiles):
    """StaticFiles that gzip-encodes text assets for clients that accept it.

    Range requests, HEAD requests and already-compressed media keep the plain
    file response.
    """

    async def get_response(self, path: str, scope) -> Response:
        response = await super().get_response(path, scope)
        if not isinstance(response, FileResponse) or response.status_code != 200:
            return response
        if not _is_compressible(
            response.media_type, int(response.headers["content-length"])
        ):
            return response
        response.headers["Vary"] = "Accept-Encoding"
        request_headers = Headers(scope=scope)
        if (
            scope["method"] != "GET"
            or "range" in request_headers
            or not accepts_gzip(request_headers.get("accept-encoding", ""))
        ):
            return response
        body = await run_in_threadpool(static_gzip_cache.body, str(response.path))
        headers = {
            key: value
            for key, value in response.headers.items()
            if key not in {"content-length", "accept-ranges"}
        }
        headers["content-encoding"] = "gzip"
        if "etag" in headers:
            headers["etag"] = headers["etag"][:-1] + '-gzip"'
            if self.is_not_modified(Headers(headers), request_headers):
                return NotModifiedResponse(Headers(headers))
        return Response(body, headers=headers)
