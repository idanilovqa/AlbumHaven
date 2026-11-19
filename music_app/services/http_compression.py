"""Gzip negotiation shared by static assets and large dynamic JSON responses."""
from __future__ import annotations

import gzip

from starlette.concurrency import run_in_threadpool
from starlette.datastructures import Headers, MutableHeaders
from starlette.types import ASGIApp, Message, Receive, Scope, Send

# Below this, gzip saves too little to pay for its CPU time (measured in 6.6).
JSON_GZIP_MIN_BYTES = 16 * 1024


def accepts_gzip(accept_encoding: str) -> bool:
    for coding in accept_encoding.split(","):
        name, _, params = coding.partition(";")
        if name.strip().lower() != "gzip":
            continue
        quality = params.strip().lower()
        if not quality.startswith("q="):
            return True
        try:
            return float(quality[2:]) > 0
        except ValueError:
            return False
    return False


class JsonGzipMiddleware:
    """Gzip ``application/json`` bodies of at least ``JSON_GZIP_MIN_BYTES``.

    JSON bodies are buffered whole, as ``CoverReferenceBoundary`` already does
    for every JSON response, because the ``http`` middlewares re-stream each
    response in chunks. Every other response passes through untouched: media,
    files, HTML, partial content and already-encoded bodies. WebSockets never
    reach this middleware.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        gzip_allowed = scope["method"] == "GET" and accepts_gzip(
            Headers(scope=scope).get("accept-encoding", "")
        )
        start: Message | None = None
        chunks: list[bytes] = []

        async def send_json_gzip(message: Message) -> None:
            nonlocal start
            if message["type"] == "http.response.start":
                headers = Headers(raw=message["headers"])
                if (
                    message["status"] == 200
                    and headers.get("content-type", "").startswith("application/json")
                    and "content-encoding" not in headers
                ):
                    MutableHeaders(raw=message["headers"]).add_vary_header("Accept-Encoding")
                    if gzip_allowed:
                        start = message
                        return
                await send(message)
                return
            if start is None or message["type"] != "http.response.body":
                await send(message)
                return
            chunks.append(message.get("body", b""))
            if message.get("more_body", False):
                return
            body = b"".join(chunks)
            headers = MutableHeaders(raw=start["headers"])
            if len(body) >= JSON_GZIP_MIN_BYTES:
                body = await run_in_threadpool(gzip.compress, body, 6, mtime=0)
                headers["content-encoding"] = "gzip"
            headers["content-length"] = str(len(body))
            await send(start)
            await send({"type": "http.response.body", "body": body})

        await self.app(scope, receive, send_json_gzip)
