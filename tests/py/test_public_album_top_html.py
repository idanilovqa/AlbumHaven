"""Real public router/template composition; service DTO fixtures are not SQL proof."""
import asyncio
import ast
from copy import deepcopy
from html.parser import HTMLParser
import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest

from music_app.services.owned_album_tops import AlbumTopError
from tests.py.test_public_album_top_http import Service, app_for, exchange, actor, SHARE, ITEM, PATH

BROWSER = "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,*/*;q=0.8"
TRACK = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"


def album():
    return {"item_ref": ITEM, "original_position": "9", "curator_position": 1,
        "album_ref": TRACK, "presentation_ref": SHARE, "title": "Approved album", "artist": "Approved artist",
        "year": 2001, "artwork_ref": None, "details_path": PATH + "/items/" + ITEM}


class MetadataService(Service):
    def __init__(self):
        super().__init__()
        self.value = None
    def read_guest(self, **options):
        value = super().read_guest(**options)
        if self.value is not None:
            return deepcopy(self.value)
        if options["item_ref"] is not None:
            value.pop("title"); value.pop("description"); value.pop("items")
            value.update(item=album(), tracks=[{"track_ref": TRACK, "position": 1, "title": "Approved track",
                "artist": "Approved track artist", "duration_ms": None}], track_count=1)
        else:
            value["items"] = [album()]
        return value


class Page(HTMLParser):
    def __init__(self, body):
        super().__init__()
        self.anchors, self.scripts, self.styles, self.data = [], [], [], []
        self.in_payload = False
        self.feed(body.decode())
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "a": self.anchors.append(attrs)
        if tag == "link": self.styles.append(attrs)
        if tag == "script":
            self.scripts.append(attrs)
            self.in_payload = attrs.get("id") == "public-album-top-data"
    def handle_endtag(self, tag):
        if tag == "script": self.in_payload = False
    def handle_data(self, value):
        if self.in_payload: self.data.append(value)
    @property
    def payload(self):
        return json.loads("".join(self.data)) if self.data else None


def html(app, method="GET", path=PATH, **options):
    headers = {"accept": BROWSER, **options.pop("headers", {})}
    return asyncio.run(exchange(app, method, path, headers=headers, **options))


@pytest.mark.parametrize("accept, expected", [
    (None, False), ("*/*", False), ("application/json", False), ("text/*", False),
    (BROWSER, True), ("text/html", True), ("TEXT/HTML;Q=0.7", True),
    ("text/html,application/json", False), ("text/html;q=0.8,application/json;q=0.7", True),
    ("application/json;q=0.9,text/html;q=0.8", False),
    ("text/html;q=0,*/*;q=1", False), ("text/html;q=0.3,*/*;q=0.8", False),
    ("text/html;q=1,application/json;q=0,*/*;q=1", True),
    ("application/*;q=1,text/html;q=1", False),
    ("application/xml", False), ("text/html;q=.8", False), ("text/html;q=1.001", False),
    ("text/html;q=0.1234", False), ("text/html;q=NaN", False), ("text/html;q=1;q=0", False),
    ("text/html;broken", False), ("*/html", False), ("text/html,broken", False),
    ("text/html," * 64 + "text/html", False), ("text/html;extension=" + "a" * 8193, False),
])
def test_bounded_explicit_accept_preserves_json_defaults(accept, expected):
    service = MetadataService()
    status, body, headers = asyncio.run(exchange(app_for(service), headers={} if accept is None else {"accept": accept}))
    assert status == 200 and len(service.calls) == 1
    assert headers[b"content-type"].startswith(b"text/html" if expected else b"application/json")
    assert headers[b"vary"] == b"Accept" and headers[b"cache-control"] == b"private, no-store"
    assert headers[b"x-content-type-options"] == b"nosniff" and headers[b"referrer-policy"] == b"no-referrer"
    if expected:
        assert Page(body).payload["data"]["items"][0] == album()
    else:
        assert json.loads(body)["status"] == "ready"


@pytest.mark.parametrize("suffix", ["", "/items/" + ITEM])
@pytest.mark.parametrize("accept", [BROWSER, "application/json"])
def test_head_reauthorizes_and_retains_get_representation_headers(suffix, accept):
    service = MetadataService(); app = app_for(service)
    get_status, body, get_headers = html(app, path=PATH + suffix, headers={"accept": accept})
    status, head_body, headers = html(app, "HEAD", PATH + suffix, headers={"accept": accept})
    assert status == get_status == 200 and body and head_body == b"" and len(service.calls) == 2
    for key in [b"content-type", b"content-length", b"vary", b"cache-control", b"referrer-policy"]:
        assert headers[key] == get_headers[key]
    assert int(headers[b"content-length"]) == len(body)


@pytest.mark.parametrize("suffix", ["", "/items/" + ITEM])
def test_gallery_and_track_payloads_are_positive_and_navigation_is_real_same_origin(suffix):
    service = MetadataService(); app = app_for(service)
    service.value = service.read_guest(item_ref=ITEM if suffix else None)
    service.calls.clear(); service.value["next_cursor"] = "opaque +/&?=cursor"
    service.value["private_future_field"] = "never-serialize-private"
    row = service.value["item"] if suffix else service.value["items"][0]
    row["private_path"] = "never-serialize-private"
    if suffix:
        service.value["tracks"][0]["media_url"] = "never-serialize-private"
        service.value["track_count"] = 2
    status, body, headers = html(app, path=PATH + suffix, query=b"limit=1")
    assert status == 200 and b"never-serialize-private" not in body
    page = Page(body); payload = page.payload
    assert set(payload) == {"kind", "share_ref", "item_ref", "limit", "data"}
    assert payload["kind"] == ("item" if suffix else "top") and payload["limit"] == 1
    assert payload["data"]["allowed_actions"] == {"can_read": True, "can_open_item": True}
    assert all(link["href"].startswith(PATH) and not urlsplit(link["href"]).netloc for link in page.anchors)
    assert all("ui-button--small" in link["class"] and "ui-button--secondary" in link["class"] for link in page.anchors)
    next_link = next(link for link in page.anchors if "cursor=" in link["href"])
    assert urlsplit(next_link["href"]).path == PATH + suffix
    assert parse_qs(urlsplit(next_link["href"]).query) == {"cursor": ["opaque +/&?=cursor"], "limit": ["1"]}
    if suffix:
        assert any(link["href"] == PATH for link in page.anchors), "Back to Top does not reuse an item-only limit"
        assert payload["data"]["tracks"][0]["duration_ms"] is None


def test_safe_template_and_json_escaping_uses_only_the_approved_public_payload():
    service = MetadataService(); service.value = service.read_guest(item_ref=None); service.calls.clear()
    hostile = '</script><img src="https://foreign.example/" onerror="bad()"> & <script>bad()</script>'
    service.value["title"] = hostile; service.value["description"] = hostile
    service.value["items"][0]["title"] = hostile
    app = app_for(service); app.state.runtime_asset_version = "approved-assets"
    status, body, _ = html(app); assert status == 200
    page = Page(body)
    assert page.payload["data"]["title"] == hostile
    assert b'<img src="https://foreign.example/"' not in body and b'<script>bad()' not in body
    assert b'\\u003c/script\\u003e' in body
    external = [script["src"] for script in page.scripts if "src" in script]
    assert len(external) == 8 and all(path.startswith("/static/js/") and path.endswith("?v=approved-assets") for path in external)
    assert external[0] == "/static/js/public-album-tops/page.js?v=approved-assets"
    assert "defer" not in page.scripts[0]
    assert all("defer" in row for row in page.scripts[1:] if "src" in row)
    assert b'aria-live="polite" hidden' in body
    assert len(page.styles) == 9 and all(row["href"].startswith("/static/css/") for row in page.styles)
    for private in [b"runtime-bundle", b"/static/app.js", b"appearance-bootstrap", b"capability-bootstrap",
                    b"private_ui_context", b"csrf", b"current_account_name", b"index-native"]:
        assert private not in body


@pytest.mark.parametrize("code,status", [("invalid_query", 400), ("invalid_cursor", 400), ("unavailable", 404), ("forbidden", 403)])
def test_typed_failures_have_generic_html_without_previous_metadata(code, status):
    service = MetadataService(); service.error = AlbumTopError(code, status)
    result, body, headers = html(app_for(service))
    assert result == status and Page(body).payload is None and b"Approved album" not in body
    assert headers[b"vary"] == b"Accept" and headers[b"cache-control"] == b"private, no-store"
    assert b"first page" in body if code.startswith("invalid_") else b"unavailable" in body


@pytest.mark.parametrize("query", [b"format=html", b"limit=1&limit=2", b"cursor=", b"limit=251", b"cursor=a&limit=1&q=x"])
def test_html_does_not_expand_existing_query_grammar(query):
    service = MetadataService(); status, body, _ = html(app_for(service), query=query)
    assert status == 400 and not service.calls and Page(body).payload is None


@pytest.mark.parametrize("change", ["disabled", "foreign_origin", "retired_after_read"])
def test_html_cannot_bypass_current_deployment_origin_or_post_read_fence(change):
    service = MetadataService(); app = app_for(service)
    options = {}
    if change == "disabled": app.state.config["ALBUM_HAVEN_PUBLIC_SHARING_ENABLED"] = False
    elif change == "foreign_origin": options["host"] = "foreign.example.test"
    else: service.after = lambda: app.state.config.update(ALBUM_HAVEN_PUBLIC_SHARING_ENABLED=False)
    status, body, _ = html(app, **options)
    assert status in {401, 403, 404} and b"Approved album" not in body and Page(body).payload is None
    assert len(service.calls) == (1 if change == "retired_after_read" else 0)


def test_signed_in_visitor_has_identical_public_html_and_no_private_handoff():
    guest = html(app_for(MetadataService()))
    signed_in = html(app_for(MetadataService(), current=actor()))
    assert guest == signed_in
    assert b"context_ref" not in guest[1] and b"top_ref" not in guest[1]


def test_conditional_headers_never_skip_authorization_or_return_304():
    service = MetadataService(); app = app_for(service)
    headers = {"if-none-match": "*", "if-modified-since": "Wed, 21 Oct 2037 07:28:00 GMT"}
    assert html(app, headers=headers)[0] == 200
    service.error = AlbumTopError("unavailable", 404)
    status, body, _ = html(app, headers=headers)
    assert status == 404 and len(service.calls) == 2 and Page(body).payload is None


def test_unexpected_service_and_template_failures_are_sanitized_and_head_safe():
    service = MetadataService(); service.error = RuntimeError("private-service-secret")
    status, body, _ = html(app_for(service))
    assert status == 503 and b"private-service-secret" not in body and Page(body).payload is None
    service = MetadataService(); app = app_for(service)
    class BrokenTemplates:
        def TemplateResponse(self, *args, **kwargs): raise RuntimeError("private-template-secret")
    app.state.templates = BrokenTemplates()
    status, body, headers = html(app)
    assert status == 503 and b"private-template-secret" not in body and b"Approved album" not in body
    head_status, head, head_headers = html(app, "HEAD")
    assert head_status == 503 and head == b"" and head_headers[b"content-length"] == headers[b"content-length"]
    assert len(service.calls) == 2


def test_zero_track_projection_is_renderable_without_claiming_a_capture_source():
    service = MetadataService(); service.value = service.read_guest(item_ref=ITEM); service.calls.clear()
    service.value["tracks"] = []; service.value["track_count"] = 0
    status, body, _ = html(app_for(service), path=PATH + "/items/" + ITEM)
    assert status == 200 and Page(body).payload["data"]["track_count"] == 0
    assert Page(body).payload["data"]["tracks"] == []


@pytest.mark.parametrize("suffix, query, limit", [("", b"", 50), ("", b"limit=100", 100),
    ("/items/" + ITEM, b"", 100), ("/items/" + ITEM, b"limit=250", 250)])
def test_html_keeps_actual_gallery_and_track_page_defaults_and_bounds(suffix, query, limit):
    service = MetadataService()
    status, body, _ = html(app_for(service), path=PATH + suffix, query=query)
    assert status == 200 and Page(body).payload["limit"] == service.calls[0]["limit"] == limit


@pytest.mark.parametrize("failure", ["subject", "actions", "missing_field", "too_many_rows", "cursor"])
def test_invalid_service_projection_is_sanitized_before_template_output(failure):
    service = MetadataService(); service.value = service.read_guest(item_ref=None); service.calls.clear()
    if failure == "subject": service.value["share_ref"] = ITEM
    elif failure == "actions": service.value["allowed_actions"]["can_read"] = False
    elif failure == "missing_field": del service.value["items"][0]["artist"]
    elif failure == "too_many_rows": service.value["items"] *= 51
    else: service.value["next_cursor"] = "x" * 4097
    status, body, _ = html(app_for(service))
    assert status == 503 and Page(body).payload is None and b"Approved album" not in body


def test_existing_html_cache_middleware_normalizes_the_real_guest_response():
    # Execute only the unchanged nested middleware owner against the real router.
    # This is not a full app/config bootstrap or browser acceptance claim.
    source = Path(__file__).resolve().parents[2] / "music_app" / "__init__.py"
    module = ast.parse(source.read_text(encoding="utf-8"))
    configure = next(node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == "_configure_asgi_app")
    middleware = next(node for node in configure.body if isinstance(node, ast.AsyncFunctionDef)
                      and node.name == "require_runtime_javascript_revalidation")
    app = app_for(MetadataService())
    isolated = ast.fix_missing_locations(ast.Module(body=[middleware], type_ignores=[]))
    exec(compile(isolated, str(source), "exec"), {"app": app})
    status, body, headers = html(app)
    assert status == 200 and Page(body).payload is not None
    assert headers[b"cache-control"] == b"no-store, max-age=0" and headers[b"pragma"] == b"no-cache" and headers[b"expires"] == b"0"
    assert headers[b"vary"] == b"Accept" and headers[b"referrer-policy"] == b"no-referrer"
