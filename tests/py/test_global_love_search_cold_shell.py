"""Existing bootstrap must never hydrate ordinary artist rows for private q.

Only the ordinary external repository read is controlled. The real bootstrap,
preview and hydration builders remain active. These tests make no DB claims.
"""
import json
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import pytest
from starlette.datastructures import QueryParams

from music_app.routes import web_asgi

PERSONAL = (":loved", "love:loved", ":obsessed", "love:obsessed",
            ":loved ordinary text", ":loved @someone", ":loved :tracks")
PRIVATE_ROOT = "/synthetic-personal-search-private-root"


@pytest.fixture
def ordinary_artist_repository(monkeypatch):
    monkeypatch.setattr(web_asgi, "library_browse_postgres_is_effective", lambda _config: True)
    monkeypatch.setattr(web_asgi, "get_primary_music_root", lambda _config: Path(PRIVATE_ROOT))

    class OrdinaryRepository:
        def __init__(self, _config):
            pass

        def build_selected_artist_payload(self, *, query_params, library_state):
            # Use the existing complete empty-shell shape, then add ordinary
            # unfiltered artist/family content that must not escape for private q.
            payload = web_asgi._build_empty_initial_view(config={},
                query_raw=query_params.get("q", ""), selected_artist=query_params.get("artist", ""))
            group = {"artist": "Unfiltered Artist", "artist_display": "Unfiltered Artist",
                "albums": [{"key": "ordinary-album-key", "name": "Unfiltered Family Album",
                    "album_artist": "Unfiltered Artist", "artists": ["Unfiltered Artist"],
                    "year": 2020, "edition": "", "tracks": []}]}
            payload.update(artist_groups=[group], family_artist_groups=[group],
                artists_sidebar=[{"artist": "Unfiltered Artist", "artist_display": "Unfiltered Artist"}],
                album_count=1, artist_count=1)
            return payload

    monkeypatch.setattr(web_asgi, "PostgresLibraryBrowseRepository", OrdinaryRepository)


def bootstrap(query, artist="Requested Artist", presentation="albums"):
    return web_asgi._build_bootstrap_payload(
        query_args=QueryParams({"surface": "albums", "q": query, "artist": artist,
            "search_presentation": presentation}),
        config={}, logger=None, library_state={}, query_raw=query, selected_artist=artist,
        refreshed=False, request_started_epoch_ms=1,
    )[0]


@pytest.mark.parametrize("query", PERSONAL)
@pytest.mark.parametrize("presentation", ["albums", "tracks"])
def test_personal_cold_selected_artist_entry_is_empty_and_requires_guarded_hydration(
        ordinary_artist_repository, query, presentation):
    payload = bootstrap(query, presentation=presentation)
    initial = payload["initial_view"]
    for field in ("artist_groups", "primary_artist_groups", "family_artist_groups", "artists_sidebar", "non_album_tracks"):
        assert not initial.get(field), f"Unprotected personal bootstrap field: {field}"
    assert initial["query"] == query
    assert initial["selected_artist"] == "Requested Artist"
    assert payload["bootstrap"]["startupPreview"]["renderedGalleryMarkup"] is False
    hydration = payload["bootstrap"]["startupHydration"]
    assert hydration["required"] is True
    endpoint = urlsplit(hydration["endpoint"])
    params = parse_qs(endpoint.query)
    assert endpoint.path == "/view-data"
    assert params["q"] == [query]
    assert params["artist"] == ["Requested Artist"]
    assert params.get("search_presentation", ["albums"]) == [presentation]
    assert params.get("payload_tier", ["full"]) == ["full"]
    assert hydration.get("embeddedViewPatch") is None
    serialized = json.dumps(payload)
    assert "Unfiltered Family Album" not in serialized
    assert "Unfiltered Artist" not in serialized
    assert PRIVATE_ROOT not in serialized
    assert "music_dir" not in serialized


@pytest.mark.parametrize("query", PERSONAL[:4])
def test_personal_cold_entry_without_artist_does_not_serialize_private_music_root(
        ordinary_artist_repository, query):
    payload = bootstrap(query, artist="")
    assert payload["bootstrap"]["startupHydration"]["required"] is True
    assert payload["bootstrap"]["startupPreview"]["renderedGalleryMarkup"] is False
    serialized = json.dumps(payload)
    assert PRIVATE_ROOT not in serialized
    assert "music_dir" not in payload["initial_view"]


def test_ordinary_selected_artist_entry_preserves_existing_preview(ordinary_artist_repository):
    payload = bootstrap("ordinary text")
    assert payload["initial_view"]["artist_groups"][0]["albums"][0]["name"] == "Unfiltered Family Album"
    assert payload["bootstrap"]["startupPreview"]["renderedGalleryMarkup"] is True
