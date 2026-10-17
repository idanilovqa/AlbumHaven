"""Full native GET / must not render ordinary rows for personal cold Search.

Uses the repository's full-app fixture, actor injection and HTTP driver. Only
external browse/appearance persistence is doubled; middleware, context owner,
index, bootstrap/preview builders and the real index template remain active.
This is HTTP projection coverage, not authentication-persistence coverage.
"""
from dataclasses import replace
import json
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import parse_qs, urlsplit

import pytest

from music_app.routes import web_asgi
from music_app.services.policy_evaluator import PolicyEvaluationConstraints
from tests.py.asgi_testing import run_asgi_request


PERSONAL_QUERIES = (
    ":loved", "love:loved", ":obsessed", "love:obsessed",
    ":loved ordinary text", ":loved @someone", ":loved :tracks",
)
ARTIST = "Requested Artist"
ORDINARY_ARTIST = "Ordinary Unfiltered Artist Sentinel"
ORDINARY_ALBUM = "Ordinary Unfiltered Family Album Sentinel"


def bootstrap_from_html(body):
    # The existing shell's assignment, also used by test_web_asgi_routes.py.
    text = body.decode("utf-8")
    marker = "window.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__ = "
    start = text.index(marker) + len(marker)
    payload, _end = json.JSONDecoder().raw_decode(text[start:])
    assert isinstance(payload, dict)
    return payload


@pytest.fixture
def cold_http(asgi_app, monkeypatch):
    calls = []
    private_root = str(asgi_app.state.config["MUSIC_DIR"])

    class OrdinaryRepository:
        def __init__(self, config):
            self.config = config

        def build_selected_artist_payload(self, *, query_params, library_state):
            calls.append(dict(query_params))
            payload = web_asgi._build_empty_initial_view(
                config=self.config, query_raw=query_params.get("q", ""),
                selected_artist=query_params.get("artist", ""), active_surface="albums",
            )
            group = {
                "artist": ORDINARY_ARTIST, "artist_display": ORDINARY_ARTIST,
                "albums": [{"key": "ordinary-cold-http-album", "name": ORDINARY_ALBUM,
                    "album_artist": ORDINARY_ARTIST, "artists": [ORDINARY_ARTIST],
                    "year": 2020, "edition": "", "tracks": []}],
            }
            payload.update(
                artist_groups=[group], family_artist_groups=[group],
                artists_sidebar=[{"artist": ORDINARY_ARTIST,
                                  "artist_display": ORDINARY_ARTIST, "count": 1}],
                artist_count=1, album_count=1,
            )
            return payload

    monkeypatch.setattr(web_asgi, "library_browse_postgres_is_effective", lambda _config: True)
    monkeypatch.setattr(web_asgi, "get_primary_music_root", lambda _config: Path(private_root))
    monkeypatch.setattr(web_asgi, "PostgresLibraryBrowseRepository", OrdinaryRepository)
    # Existing state injection points, not replacement shell/context builders.
    asgi_app.state.appearance_preferences_repository = SimpleNamespace(
        load_preferences=lambda **_kwargs: {})
    asgi_app.state.client_layout_preferences_repository = SimpleNamespace(
        load_profiles=lambda **_kwargs: {})
    return SimpleNamespace(app=asgi_app, calls=calls, private_root=private_root)


def configure_context(fixture, condition):
    if condition == "no_current_library":
        # Reuse the fixture's existing authenticated owner; only remove its
        # current library. The real context owner then cannot issue a context.
        owner = fixture.app.state.current_actor_resolver.resolve(None)
        actor = replace(owner, current_library_id=None, library_relationships=())
        fixture.app.state.current_actor_resolver = SimpleNamespace(resolve=lambda _token: actor)
    elif condition == "browse_denied":
        # Keep shell admission while denying the actual current-library read.
        # The production evaluator and middleware still enforce this constraint.
        fixture.app.state.policy_constraint_resolver = lambda context: PolicyEvaluationConstraints(
            deployment_allowed=context.action != "library.browse.read")
        status, _headers, _body = run_asgi_request(fixture.app, "GET", "/view-data",
                                                  query={"surface": "albums", "q": ":loved"})
        assert status == 403, "The fixture must actually deny current-library browse"
        assert fixture.calls == []
    else:
        raise AssertionError(f"Unknown fixture condition: {condition}")


@pytest.mark.parametrize("condition", ["no_current_library", "browse_denied"])
@pytest.mark.parametrize("query", PERSONAL_QUERIES)
@pytest.mark.parametrize("presentation", ["albums", "tracks"])
def test_full_personal_cold_html_has_no_unprotected_artist_preview(
        cold_http, condition, query, presentation):
    configure_context(cold_http, condition)
    status, headers, body = run_asgi_request(cold_http.app, "GET", "/", query={
        "surface": "albums", "q": query, "artist": ARTIST,
        "search_presentation": presentation,
    })
    assert status == 200, "Unavailable personal context must retain the safe HTML shell"
    assert headers["content-type"].startswith("text/html")
    assert "no-store" in headers["cache-control"]
    html = body.decode("utf-8")
    assert ORDINARY_ALBUM not in html, "Ordinary album escaped into personal cold HTML"
    assert ORDINARY_ARTIST not in html, "Ordinary sidebar/family escaped into personal cold HTML"
    assert cold_http.private_root not in html, "Private music root escaped into cold HTML"
    assert cold_http.calls == [], "Personal cold entry queried the ordinary artist repository"
    payload = bootstrap_from_html(body)
    initial = payload["initial_view"]
    assert initial["query"] == query
    assert initial["selected_artist"] == ARTIST
    assert "music_dir" not in initial
    for field in ("artist_groups", "primary_artist_groups", "family_artist_groups",
                  "artists_sidebar", "non_album_tracks"):
        assert not initial.get(field), f"Unprotected initial-view rows in {field}"
    if condition == "no_current_library":
        assert initial.get("context_ref") is None
    assert payload["bootstrap"]["startupPreview"]["renderedGalleryMarkup"] is False
    hydration = payload["bootstrap"]["startupHydration"]
    assert hydration["required"] is True
    assert hydration.get("embeddedViewPatch") is None
    endpoint = urlsplit(hydration["endpoint"])
    assert endpoint.path == "/view-data"
    params = parse_qs(endpoint.query)
    assert params["q"] == [query]
    assert params["artist"] == [ARTIST]
    assert params.get("search_presentation", ["albums"]) == [presentation]
    assert params.get("payload_tier", ["full"]) == ["full"]


def test_full_ordinary_selected_artist_html_keeps_existing_preview(cold_http):
    status, headers, body = run_asgi_request(cold_http.app, "GET", "/", query={
        "surface": "albums", "q": "ordinary text", "artist": ARTIST,
    })
    assert status == 200
    assert headers["content-type"].startswith("text/html")
    payload = bootstrap_from_html(body)
    assert len(cold_http.calls) == 1
    assert payload["initial_view"]["artist_groups"][0]["albums"][0]["name"] == ORDINARY_ALBUM
    assert payload["bootstrap"]["startupPreview"]["renderedGalleryMarkup"] is True
    # Inspect the rendered DOM as well as embedded JSON, without a browser.
    html_before_bootstrap = body.decode("utf-8").split(
        "window.__ALBUM_HAVEN_BOOTSTRAP_PAYLOAD__ = ", 1)[0]
    assert ORDINARY_ALBUM in html_before_bootstrap
    assert ORDINARY_ARTIST in html_before_bootstrap
