from __future__ import annotations

import gzip
import json

import pytest
from starlette.applications import Starlette
from starlette.middleware import Middleware
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from music_app.services.http_compression import JSON_GZIP_MIN_BYTES, JsonGzipMiddleware
from tests.py.asgi_testing import run_asgi_request

LARGE = {"albums": [{"artist": "Neal Morse", "title": f"Album {n}"} for n in range(2000)]}
LARGE_BODY = JSONResponse(LARGE).body
AUDIO = bytes(range(256)) * 400


def _app():
    async def encoded(_request):
        return Response(gzip.compress(LARGE_BODY), media_type="application/json",
                        headers={"content-encoding": "gzip"})

    routes = [
        Route("/large", lambda _r: JSONResponse(LARGE)),
        Route("/small", lambda _r: JSONResponse({"ok": True})),
        Route("/missing", lambda _r: JSONResponse(LARGE, status_code=404)),
        Route("/audio", lambda _r: Response(AUDIO, media_type="audio/mpeg")),
        Route("/partial", lambda _r: Response(AUDIO[:1000], status_code=206, media_type="audio/mpeg",
                                              headers={"content-range": f"bytes 0-999/{len(AUDIO)}"})),
        Route("/html", lambda _r: Response("<p>x</p>" * 5000, media_type="text/html")),
        Route("/encoded", encoded),
    ]
    return JsonGzipMiddleware(Starlette(routes=routes))


def _get(path, method="GET", **headers):
    return run_asgi_request(_app(), method, path, headers=headers)


def test_large_json_is_gzip_encoded_for_clients_that_accept_it():
    assert len(LARGE_BODY) >= JSON_GZIP_MIN_BYTES
    status, headers, body = _get("/large", **{"accept-encoding": "br, gzip"})

    assert status == 200
    assert headers["content-encoding"] == "gzip"
    assert headers["vary"] == "Accept-Encoding"
    assert headers["content-type"] == "application/json"
    assert int(headers["content-length"]) == len(body) < len(LARGE_BODY) / 4
    assert gzip.decompress(body) == LARGE_BODY


@pytest.mark.parametrize("accept_encoding", [None, "identity", "br", "gzip;q=0"])
def test_large_json_stays_identity_without_gzip_but_still_varies(accept_encoding):
    headers = {"accept-encoding": accept_encoding} if accept_encoding else {}
    status, response_headers, body = _get("/large", **headers)

    assert status == 200
    assert "content-encoding" not in response_headers
    assert response_headers["vary"] == "Accept-Encoding"
    assert body == LARGE_BODY


def test_small_json_is_not_compressed():
    _status, headers, body = _get("/small", **{"accept-encoding": "gzip"})

    assert "content-encoding" not in headers
    assert headers["vary"] == "Accept-Encoding"
    assert json.loads(body) == {"ok": True}


@pytest.mark.parametrize("path", ["/audio", "/partial", "/html", "/missing", "/encoded"])
def test_other_responses_pass_through_unchanged(path):
    _status, plain_headers, plain_body = _get(path)
    status, headers, body = _get(path, **{"accept-encoding": "gzip"})

    assert (status, headers, body) == (_status, plain_headers, plain_body)
    assert "vary" not in headers


def test_json_rechunked_by_http_middleware_is_compressed_whole():
    async def passthrough(request, call_next):
        return await call_next(request)

    inner = Starlette(
        routes=[Route("/large", lambda _r: JSONResponse(LARGE))],
        middleware=[Middleware(BaseHTTPMiddleware, dispatch=passthrough)],
    )
    status, headers, body = run_asgi_request(
        JsonGzipMiddleware(inner), "GET", "/large", headers={"accept-encoding": "gzip"}
    )

    assert status == 200
    assert headers["content-encoding"] == "gzip"
    assert int(headers["content-length"]) == len(body)
    assert gzip.decompress(body) == LARGE_BODY


def test_head_requests_are_not_compressed():
    status, headers, _body = _get("/large", method="HEAD", **{"accept-encoding": "gzip"})

    assert status == 200
    assert "content-encoding" not in headers
