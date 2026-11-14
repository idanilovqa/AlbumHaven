"""The edge where local cover paths become opaque references and back.

Server code keeps working with cover paths. Every JSON and HTML response leaves through
`publish_cover_references`, which renames each cover-path field to its reference field, turns
`data-cover-path` into `data-cover-ref`, and rewrites `/cover?path=` URLs to `/cover/<reference>`.
Every JSON request body passes through `resolve_cover_references`, the reverse mapping, so a
client can only name a cover the server named for it. A path the server cannot name for the
actor's library leaves as null (or an unavailable URL), never as itself.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from html import escape, unescape
import json
import re
from urllib.parse import unquote

from music_app.services.cover_references import CANDIDATE, COVER, REFERENCE_PATTERN

# Server field -> (client field, reference kind). Lookup candidates are the only `candidate`s.
OUTBOUND_FIELDS: Mapping[str, tuple[str, str]] = {
    "cover_path": ("cover_ref", COVER),
    "active_cover_path": ("active_cover_ref", COVER),
    "selected_cover_path": ("selected_cover_ref", COVER),
    "duplicate_of_cover_path": ("duplicate_of_cover_ref", COVER),
    "coverPath": ("coverRef", COVER),
    "candidate_cover_path": ("candidate_cover_ref", CANDIDATE),
    "selected_source_cover_path": ("selected_source_cover_ref", CANDIDATE),
}
# Client field -> server field. `source_cover_ref` is the image a cover lookup action names.
INBOUND_FIELDS: Mapping[str, str] = {
    **{client: server for server, (client, _kind) in OUTBOUND_FIELDS.items()},
    "source_cover_ref": "source_path",
}
UNAVAILABLE_COVER_URL = "/cover/unavailable"

_STRING_OR_NULL = r'("(?:[^"\\]|\\.)*"|null)'
_OUTBOUND_JSON = re.compile(r'"(%s)"(\s*:\s*)%s' % ("|".join(map(re.escape, OUTBOUND_FIELDS)), _STRING_OR_NULL))
_INBOUND_JSON = re.compile(r'"(%s)"(\s*:\s*)%s' % ("|".join(map(re.escape, INBOUND_FIELDS)), _STRING_OR_NULL))
_HTML_ATTRIBUTE = re.compile(r'data-cover-path="([^"]*)"')
# Paths in these URLs are percent-encoded; the next parameter follows as `&`, `&amp;` or `&`.
_LEGACY_URL = re.compile(r'/cover\?path=([^"\'\s<>&\\]*)(&amp;|&|\\u0026)?')
_MARKERS = tuple(f'"{field}"' for field in OUTBOUND_FIELDS) + ("data-cover-path=", "/cover?path=")

# `(library_id, {path: kind}) -> {path: reference}`; `(library_id, references) -> {reference: path}`.
NameCovers = Callable[[int, Mapping[str, str]], Mapping[str, str]]
ResolveCovers = Callable[[int, set[str]], Mapping[str, str]]


def carries_cover_paths(text: str) -> bool:
    return any(marker in text for marker in _MARKERS)


def _json_string(raw: str) -> str | None:
    value = json.loads(raw)
    return value.strip() or None if isinstance(value, str) else None


def publish_cover_references(text: str, library_id: int | None, name_covers: NameCovers) -> str:
    """`text` with every cover path replaced by its reference (one naming call per text)."""
    if not carries_cover_paths(text):
        return text
    wanted: dict[str, str] = {}

    def want(path: str | None, kind: str) -> None:
        if path and wanted.get(path) != COVER:
            wanted[path] = kind

    for match in _OUTBOUND_JSON.finditer(text):
        want(_json_string(match.group(3)), OUTBOUND_FIELDS[match.group(1)][1])
    for match in _HTML_ATTRIBUTE.finditer(text):
        want(unescape(match.group(1)).strip() or None, COVER)
    for match in _LEGACY_URL.finditer(text):
        want(unquote(match.group(1)).strip() or None, COVER)
    references = dict(name_covers(library_id, wanted)) if wanted and library_id is not None else {}

    def json_field(match: re.Match) -> str:
        reference = references.get(_json_string(match.group(3)) or "")
        return f'"{OUTBOUND_FIELDS[match.group(1)][0]}"{match.group(2)}{json.dumps(reference)}'

    def html_attribute(match: re.Match) -> str:
        return f'data-cover-ref="{escape(references.get(unescape(match.group(1)).strip(), ""))}"'

    def legacy_url(match: re.Match) -> str:
        reference = references.get(unquote(match.group(1)).strip())
        url = f"/cover/{reference}" if reference else UNAVAILABLE_COVER_URL
        return url + ("?" if match.group(2) else "")

    text = _OUTBOUND_JSON.sub(json_field, text)
    text = _HTML_ATTRIBUTE.sub(html_attribute, text)
    return _LEGACY_URL.sub(legacy_url, text)


def resolve_cover_references(text: str, library_id: int | None, resolve_covers: ResolveCovers) -> str:
    """A JSON request body with every cover reference replaced by its path (or null)."""
    matches = list(_INBOUND_JSON.finditer(text))
    if not matches:
        return text
    wanted = {value for match in matches if (value := _json_string(match.group(3))) and REFERENCE_PATTERN.fullmatch(value)}
    paths = dict(resolve_covers(library_id, wanted)) if wanted and library_id is not None else {}

    def json_field(match: re.Match) -> str:
        path = paths.get(_json_string(match.group(3)) or "")
        return f'"{INBOUND_FIELDS[match.group(1)]}"{match.group(2)}{json.dumps(path)}'

    return _INBOUND_JSON.sub(json_field, text)


_REWRITTEN_CONTENT_TYPES = ("application/json", "text/html")
_BODY_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


def _header(headers: list[tuple[bytes, bytes]], name: bytes) -> str:
    return next((value.decode("latin-1") for key, value in headers if key.lower() == name), "")


def _with_length(headers: list[tuple[bytes, bytes]], length: int) -> list[tuple[bytes, bytes]]:
    return [(key, value) for key, value in headers if key.lower() != b"content-length"] + [
        (b"content-length", str(length).encode("latin-1"))
    ]


class CoverReferenceBoundary:
    """Pure ASGI middleware, installed inside the private route boundary so the actor is known."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        from starlette.concurrency import run_in_threadpool

        state = scope.setdefault("state", {})
        store = getattr(scope["app"].state, "cover_reference_store", None)

        def library_id() -> int | None:
            actor = state.get("current_actor")
            return getattr(actor, "current_library_id", None) if getattr(actor, "is_authenticated", False) else None

        def name_covers(library, wanted):
            return store.references_for(library, wanted) if store is not None else {}

        def resolve_covers(library, references):
            return store.paths_for(library, references) if store is not None else {}

        headers = list(scope.get("headers") or [])
        if scope["method"] in _BODY_METHODS and "application/json" in _header(headers, b"content-type").lower():
            chunks = []
            while True:
                message = await receive()
                if message["type"] != "http.request":
                    break
                chunks.append(message.get("body", b""))
                if not message.get("more_body"):
                    break
            body = b"".join(chunks)
            text = body.decode("utf-8", errors="surrogateescape")
            rewritten = await run_in_threadpool(resolve_cover_references, text, library_id(), resolve_covers)
            if rewritten is not text:
                body = rewritten.encode("utf-8", errors="surrogateescape")
                scope = {**scope, "headers": _with_length(headers, len(body))}
            replayed = False

            async def receive():
                nonlocal replayed
                if replayed:
                    return {"type": "http.disconnect"}
                replayed = True
                return {"type": "http.request", "body": body, "more_body": False}

        start = None
        chunks: list[bytes] = []

        async def send_published(message):
            nonlocal start
            if message["type"] == "http.response.start":
                content_type = _header(list(message.get("headers") or []), b"content-type").lower()
                encoded = _header(list(message.get("headers") or []), b"content-encoding")
                if content_type.startswith(_REWRITTEN_CONTENT_TYPES) and not encoded:
                    start = message
                    return
                await send(message)
                return
            if start is None or message["type"] != "http.response.body":
                await send(message)
                return
            chunks.append(message.get("body", b""))
            if message.get("more_body"):
                return
            text = b"".join(chunks).decode("utf-8", errors="surrogateescape")
            published = await run_in_threadpool(publish_cover_references, text, library_id(), name_covers)
            body = published.encode("utf-8", errors="surrogateescape")
            await send({**start, "headers": _with_length(list(start.get("headers") or []), len(body))})
            await send({"type": "http.response.body", "body": body, "more_body": False})

        await self.app(scope, receive, send_published)
