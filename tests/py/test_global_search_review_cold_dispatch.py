"""Review B4 and cold admission gaps through real HTML and hydration dispatch.

The full application fixture, middleware, template, context owner, bootstrap,
normalizer and /view-data route stay active. Only external ordinary browse and
appearance persistence are doubled. No proposed Search service is imported or
replaced. Valid requests deliberately omit the hydration context header, so a
409 proves native admission without pretending to test SQL membership.

The raw ASGI driver intentionally does not call the existing HTTP helper's
pre-request CSRF signer: malformed signing must reach the real app, including
its template's issue_session_csrf call, rather than fail in the test harness.
"""
import asyncio
from dataclasses import replace
import json
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qsl, urlencode, urlsplit

import pytest

from music_app.routes import api_read_asgi_routes as read_routes
from music_app.routes import web_asgi
from music_app.services.policy_evaluator import PolicyEvaluationConstraints


ARTIST = "Requested Artist"
ORDINARY_ARTIST = "Review Ordinary Artist Sentinel"
ORDINARY_ALBUM = "Review Ordinary Family Album Sentinel"
ROW_FIELDS = ("artist_groups", "primary_artist_groups", "family_artist_groups",
              "artists_sidebar", "non_album_tracks", "tracks", "sidebar")


def raw_get(app, path, pairs, *, context=None):
    """Issue a GET without generating credentials or replacing app middleware."""
    async def request():
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

        headers = [(b"host", b"testserver"),
                   (b"cookie", ("__Host-album_haven_session=" + "s" * 43).encode("ascii"))]
        if context is not None:
            headers.append((b"x-albumhaven-context", context.encode("ascii")))
        await app({"type": "http", "asgi": {"version": "3.0"},
                   "http_version": "1.1", "method": "GET", "scheme": "http",
                   "path": path, "raw_path": path.encode("ascii"),
                   "query_string": urlencode(pairs).encode("ascii"), "headers": headers,
                   "client": ("192.0.2.10", 50000), "server": ("testserver", 80)},
                  receive, send)
        start = next(message for message in messages if message["type"] == "http.response.start")
        body = b"".join(message.get("body", b"") for message in messages
                        if message["type"] == "http.response.body")
        response_headers = {key.decode("latin1").lower(): value.decode("latin1")
                            for key, value in start.get("headers", [])}
        return int(start["status"]), response_headers, body

    return asyncio.run(request())


@pytest.fixture
def cold_dispatch(asgi_app, monkeypatch):
    calls = []
    private_root = str(asgi_app.state.config["MUSIC_DIR"])

    class OrdinaryRepository:
        def __init__(self, config):
            self.config = config

        def _payload(self, *, query_params, library_state=None):
            calls.append(list(query_params.multi_items()))
            payload = web_asgi._build_empty_initial_view(
                config=self.config, query_raw=query_params.get("q", ""),
                selected_artist=query_params.get("artist", ""), active_surface="albums")
            group = {"artist": ORDINARY_ARTIST, "artist_display": ORDINARY_ARTIST,
                     "albums": [{"key": "review-ordinary-album", "name": ORDINARY_ALBUM,
                                 "album_artist": ORDINARY_ARTIST, "artists": [ORDINARY_ARTIST],
                                 "year": 2020, "edition": "", "tracks": []}]}
            payload.update(artist_groups=[group], family_artist_groups=[group],
                           artists_sidebar=[{"artist": ORDINARY_ARTIST,
                                             "artist_display": ORDINARY_ARTIST, "count": 1}],
                           artist_count=1, album_count=1)
            return payload

        build_selected_artist_payload = _payload
        build_search_payload = _payload
        build_root_startup_preview_payload = _payload
        build_root_album_browse_payload = _payload
        build_root_sidebar_payload = _payload

    monkeypatch.setattr(web_asgi, "library_browse_postgres_is_effective", lambda _config: True)
    monkeypatch.setattr(web_asgi, "get_primary_music_root", lambda _config: Path(private_root))
    monkeypatch.setattr(web_asgi, "PostgresLibraryBrowseRepository", OrdinaryRepository)
    monkeypatch.setattr(read_routes, "PostgresLibraryBrowseRepository", OrdinaryRepository)
    asgi_app.state.appearance_preferences_repository = SimpleNamespace(load_preferences=lambda **_kwargs: {})
    asgi_app.state.client_layout_preferences_repository = SimpleNamespace(load_profiles=lambda **_kwargs: {})
    return SimpleNamespace(app=asgi_app, calls=calls, private_root=private_root)


def configure_condition(fixture, condition):
    if condition == "ready":
        return
    if condition == "no_current_library":
        owner = fixture.app.state.current_actor_resolver.resolve(None)
        actor = replace(owner, current_library_id=None, library_relationships=())
        fixture.app.state.current_actor_resolver = SimpleNamespace(resolve=lambda _token: actor)
    elif condition == "browse_denied":
        fixture.app.state.policy_constraint_resolver = lambda context: PolicyEvaluationConstraints(
            deployment_allowed=context.action != "library.browse.read")
    elif condition == "invalid_signing":
        # A valid-length existing synthetic secret allows policy-origin admission.
        # The invalid version reaches the real context owner and template signer.
        policy = fixture.app.state.auth_policy_config
        fixture.app.state.auth_policy_config = {**policy, "hmac": {**policy["hmac"], "key_version": 0}}
    else:
        raise AssertionError(condition)


def empty_shell(fixture, incoming):
    status, headers, body = raw_get(fixture.app, "/", incoming)
    assert status == 200, "Classified personal entry must retain the safe HTML shell"
    assert headers["content-type"].startswith("text/html")
    assert "no-store" in headers["cache-control"]
    html = body.decode("utf-8")
    assert ORDINARY_ARTIST not in html
    assert ORDINARY_ALBUM not in html
    assert fixture.private_root not in html, "Outer HTML leaked MUSIC_DIR despite empty bootstrap"
    assert fixture.calls == [], "Classified personal entry entered ordinary browse"
    marker = "window.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__ = "
    payload, _end = json.JSONDecoder().raw_decode(html.split(marker, 1)[1])
    initial = payload["initial_view"]
    assert "music_dir" not in initial
    for field in ROW_FIELDS:
        assert not initial.get(field), f"Unprotected initial data: {field}"
    assert initial["selected_artist"] == ARTIST
    assert payload["bootstrap"]["startupPreview"]["renderedGalleryMarkup"] is False
    hydration = payload["bootstrap"]["startupHydration"]
    assert hydration["required"] is True
    assert hydration.get("embeddedViewPatch") is None
    endpoint = urlsplit(hydration["endpoint"])
    assert endpoint.path == "/view-data"
    outgoing = parse_qsl(endpoint.query, keep_blank_values=True)
    # Preserve every requested key, raw value, multiplicity and per-key order.
    # Only transport defaults may be added. In particular, an unsupported
    # restriction must survive until the single native request normalizer.
    expected = list(incoming)
    if not any(key == "surface" for key, _value in expected):
        expected.append(("surface", "albums"))
    if not any(key == "payload_tier" for key, _value in expected):
        expected.append(("payload_tier", "full"))
    keys = {key for key, _value in expected}
    assert {key for key, _value in outgoing} == keys
    for key in keys:
        assert [value for name, value in outgoing if name == key] == [
            value for name, value in expected if name == key], key
    return payload, endpoint.path, outgoing


def dispatch_hydration(fixture, shell, *, status, code=None, context=False):
    payload, path, pairs = shell
    supplied = payload["initial_view"].get("context_ref") if context else None
    if context:
        assert isinstance(supplied, str) and len(supplied) == 64
    actual, headers, body = raw_get(fixture.app, path, pairs, context=supplied)
    result = json.loads(body)
    assert actual == status, (actual, result)
    assert {"private", "no-store"} <= {part.strip().lower() for part in headers["cache-control"].split(",")}
    if code is not None:
        assert result.get("error_code", result.get("error")) == code
    assert not set(ROW_FIELDS) & result.keys()
    assert ORDINARY_ARTIST not in body.decode("utf-8")
    assert ORDINARY_ALBUM not in body.decode("utf-8")
    assert fixture.private_root not in body.decode("utf-8")
    assert fixture.calls == []
    return result


@pytest.mark.parametrize("field,value", [
    ("unknown_filter", "only-this-subset"), ("gallery_cursor", "old-root-cursor"),
    ("gallery_page_size", "1"), ("related_artist", "Unrelated Family Member"),
    ("primary_filter", "1"), ("family_display", "grouped"),
    ("root_sidebar", "1"), ("album_key", "requested-private-key"),
    ("owner_account_id", "999"),
])
@pytest.mark.parametrize("presentation", ["albums", "tracks"])
def test_cold_constraints_survive_html_and_native_hydration_rejects_them(
        cold_dispatch, field, value, presentation):
    incoming = [("q", ":loved"), ("artist", ARTIST),
                ("search_presentation", presentation), (field, value)]
    shell = empty_shell(cold_dispatch, incoming)
    dispatch_hydration(cold_dispatch, shell, status=400,
                       code="invalid_private_search_request", context=True)


@pytest.mark.parametrize("field,value", [
    ("q", ":loved"), ("surface", "albums"), ("artist", ARTIST),
    ("search_presentation", "tracks"), ("search_page_size", "50"),
    ("search_cursor", "opaque"), ("search_sidebar_cursor", "opaque"),
    ("omit_sidebar", "1"), ("all_artists", "0"), ("gallery_scope", "all"),
    ("gallery_display", "cards"), ("gallery_display_mode", "cards"),
    ("gallery_scale_percent", "100"), ("payload_tier", "full"),
    ("search_detail_album_ref", "inventory-album:73:1"),
])
@pytest.mark.parametrize("presentation", ["albums", "tracks"])
def test_duplicate_scalars_remain_duplicate_through_real_cold_dispatch(
        cold_dispatch, field, value, presentation):
    incoming = [("surface", "albums"), ("q", ":loved"), ("artist", ARTIST),
                ("search_presentation", presentation)]
    incoming = [(key, item) for key, item in incoming if key != field]
    incoming.extend([(field, value), (field, value)])
    shell = empty_shell(cold_dispatch, incoming)
    dispatch_hydration(cold_dispatch, shell, status=400,
                       code="invalid_private_search_request", context=True)


@pytest.mark.parametrize("presentation", ["albums", "tracks"])
def test_repeated_categories_retain_the_complete_raw_multivalue_request(cold_dispatch, presentation):
    incoming = [("q", ":loved"), ("artist", ARTIST), ("search_presentation", presentation),
                ("category", " main_library "), ("category", "new_arrivals"), ("category", "main_library")]
    shell = empty_shell(cold_dispatch, incoming)
    # The real normalizer accepts repeated categories; the intentionally absent
    # header, not duplicate-scalar validation, is the next admission boundary.
    dispatch_hydration(cold_dispatch, shell, status=409, code="stale_context")


@pytest.mark.parametrize("presentation", ["albums", "tracks"])
def test_excess_repeated_categories_are_not_deduplicated_before_native_validation(cold_dispatch, presentation):
    incoming = [("q", ":loved"), ("artist", ARTIST), ("search_presentation", presentation)]
    incoming.extend(("category", "main_library") for _index in range(33))
    shell = empty_shell(cold_dispatch, incoming)
    dispatch_hydration(cold_dispatch, shell, status=400,
                       code="invalid_private_search_request", context=True)


@pytest.mark.parametrize("query", [" \t:loved \n", "  love:obsessed  "])
@pytest.mark.parametrize("presentation", ["albums", "tracks"])
def test_valid_raw_query_whitespace_survives_html_hydration_and_native_admission(cold_dispatch, query, presentation):
    shell = empty_shell(cold_dispatch, [("q", query), ("artist", ARTIST),
                                       ("search_presentation", presentation)])
    assert shell[0]["initial_view"]["query"] == query
    dispatch_hydration(cold_dispatch, shell, status=409, code="stale_context")


@pytest.mark.parametrize("query", [" " * 195 + ":loved", ":loved" + " " * 195])
def test_raw_oversized_query_cannot_be_trimmed_into_an_admitted_cold_request(cold_dispatch, query):
    shell = empty_shell(cold_dispatch, [("q", query), ("artist", ARTIST)])
    assert shell[0]["initial_view"]["query"] == query
    dispatch_hydration(cold_dispatch, shell, status=400,
                       code="invalid_private_search_request", context=True)


@pytest.mark.parametrize("query", ["  :loved ordinary text  ", "\t:obsessed @other\n"])
def test_cold_unsupported_query_location_uses_the_untrimmed_query(cold_dispatch, query):
    shell = empty_shell(cold_dispatch, [("q", query), ("artist", ARTIST)])
    assert shell[0]["initial_view"]["query"] == query
    result = dispatch_hydration(cold_dispatch, shell, status=400,
                                code="unsupported_private_search_combination", context=True)
    word = "ordinary" if "ordinary" in query else "@other"
    assert result["location"] == {"start": query.index(word), "end": query.index(word) + len(word)}


CLASSIFIED_SHAPES = [
    pytest.param([("search_presentation", "tracks")], "invalid_private_search_request", id="search-without-q"),
    pytest.param([("q", "ordinary text"), ("search_page_size", "50")],
                 "unsupported_private_search_combination", id="search-with-ordinary-q"),
    pytest.param([("search_future_filter", "only-this-subset")],
                 "invalid_private_search_request", id="unknown-search-without-q"),
    pytest.param([("q", ":loved"), ("q", "ordinary text")],
                 "invalid_private_search_request", id="personal-q-first"),
    pytest.param([("q", "ordinary text"), ("q", ":loved")],
                 "invalid_private_search_request", id="personal-q-last"),
]


@pytest.mark.parametrize("shape,code", CLASSIFIED_SHAPES)
@pytest.mark.parametrize("condition", ["ready", "no_current_library", "browse_denied", "invalid_signing"])
def test_all_personal_classification_shapes_remain_empty_through_html_and_native_dispatch(
        cold_dispatch, shape, code, condition):
    configure_condition(cold_dispatch, condition)
    shell = empty_shell(cold_dispatch, [("surface", "albums"), ("artist", ARTIST), *shape])
    if condition in {"no_current_library", "invalid_signing"}:
        assert shell[0]["initial_view"].get("context_ref") is None
    if condition == "browse_denied":
        dispatch_hydration(cold_dispatch, shell, status=403)
    else:
        # Syntax/duplicate rejection precedes context verification even when
        # the HTML context is unavailable. The existing bootstrap-owner actor
        # retains coarse route admission with no current library; no durable
        # private read is allowed to occur after this normalizer rejection.
        dispatch_hydration(cold_dispatch, shell, status=400, code=code,
                           context=condition == "ready")


@pytest.mark.parametrize("query", [":loved", "love:obsessed"])
@pytest.mark.parametrize("version", [0, True], ids=["zero-version", "boolean-version"])
def test_real_context_signing_failure_and_template_csrf_keep_empty_html_then_safe_503(
        cold_dispatch, query, version):
    policy = cold_dispatch.app.state.auth_policy_config
    cold_dispatch.app.state.auth_policy_config = {**policy, "hmac": {**policy["hmac"], "key_version": version}}
    shell = empty_shell(cold_dispatch, [("q", query), ("artist", ARTIST)])
    assert shell[0]["initial_view"].get("context_ref") is None
    dispatch_hydration(cold_dispatch, shell, status=503, code="private_ui_context_unavailable")
