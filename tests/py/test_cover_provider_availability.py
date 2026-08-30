from __future__ import annotations

from types import SimpleNamespace

import pytest

from music_app.services.cover_provider_availability import (
    PROVIDER_REGISTRY,
    provider_availability,
)


def _config(**overrides: object) -> SimpleNamespace:
    defaults: dict[str, object] = {
        "SPOTIFY_API_ENABLED": True,
        "SPOTIFY_CLIENT_ID": "client-id",
        "SPOTIFY_CLIENT_SECRET": "client-secret",
        "DISCOGS_CONSUMER_KEY": "",
        "DISCOGS_CONSUMER_SECRET": "",
        "MUSICBRAINZ_ENABLED": False,
    }
    defaults.update(overrides)
    return SimpleNamespace(**defaults)


@pytest.mark.parametrize(
    ("config", "missing"),
    [
        (_config(SPOTIFY_API_ENABLED=False), ("SPOTIFY_API_ENABLED",)),
        (_config(SPOTIFY_CLIENT_ID=""), ("SPOTIFY_CLIENT_ID",)),
        (_config(SPOTIFY_CLIENT_SECRET=""), ("SPOTIFY_CLIENT_SECRET",)),
        (
            _config(SPOTIFY_API_ENABLED=False, SPOTIFY_CLIENT_ID="", SPOTIFY_CLIENT_SECRET=""),
            ("SPOTIFY_API_ENABLED", "SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"),
        ),
    ],
)
def test_spotify_requires_enabled_flag_and_client_credentials(config: SimpleNamespace, missing: tuple[str, ...]):
    availability = provider_availability("spotify", config=config, youtube_music_client_class=object)

    assert availability.available is False
    assert availability.requires_credentials is True
    assert availability.missing_requirements == missing


def test_spotify_is_available_when_enabled_and_credentials_are_present():
    availability = provider_availability("spotify", config=_config(), youtube_music_client_class=object)

    assert availability.available is True
    assert availability.missing_requirements == ()


def test_discogs_remains_available_without_optional_credentials():
    availability = provider_availability(
        "discogs",
        config=_config(DISCOGS_CONSUMER_KEY="", DISCOGS_CONSUMER_SECRET=""),
        youtube_music_client_class=object,
    )

    assert availability.available is True
    assert availability.requires_credentials is False
    assert availability.credentials_present is False
    assert availability.missing_requirements == ()


def test_discogs_reports_optional_credentials_when_present():
    availability = provider_availability(
        "discogs",
        config=_config(DISCOGS_CONSUMER_KEY="key", DISCOGS_CONSUMER_SECRET="secret"),
        youtube_music_client_class=object,
    )

    assert availability.available is True
    assert availability.credentials_present is True


def test_youtube_music_client_search_depends_on_optional_dependency():
    unavailable = provider_availability("youtube_music", config=_config(), youtube_music_client_class=None)
    available = provider_availability("youtube_music", config=_config(), youtube_music_client_class=object)

    assert unavailable.available is False
    assert unavailable.missing_requirements == ("ytmusicapi",)
    assert available.available is True
    assert available.missing_requirements == ()


@pytest.mark.parametrize(
    "provider_name",
    [
        "apple",
        "deezer",
        "bandcamp",
        "cover_art_archive",
        "artist_website",
        "manual_urls",
        "genius",
        "amazon",
        "fallback_web",
        "musicbrainz",
    ],
)
def test_public_providers_have_no_credential_gate(provider_name: str):
    availability = provider_availability(
        provider_name,
        config=_config(MUSICBRAINZ_ENABLED=False),
        youtube_music_client_class=None,
    )

    assert availability.available is True
    assert availability.requires_credentials is False
    assert availability.missing_requirements == ()


def test_provider_registry_names_current_policy_surface():
    assert set(PROVIDER_REGISTRY) == {
        "amazon",
        "apple",
        "artist_website",
        "bandcamp",
        "cover_art_archive",
        "deezer",
        "discogs",
        "fallback_web",
        "genius",
        "manual_urls",
        "musicbrainz",
        "spotify",
        "youtube_music",
    }
