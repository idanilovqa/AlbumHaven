from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from config import Config


@dataclass(frozen=True)
class ProviderPolicy:
    name: str
    requires_credentials: bool = False
    optional_credentials: tuple[str, ...] = ()


@dataclass(frozen=True)
class ProviderAvailability:
    name: str
    available: bool
    requires_credentials: bool = False
    credentials_present: bool = False
    missing_requirements: tuple[str, ...] = ()


PROVIDER_REGISTRY: dict[str, ProviderPolicy] = {
    "amazon": ProviderPolicy("amazon"),
    "apple": ProviderPolicy("apple"),
    "artist_website": ProviderPolicy("artist_website"),
    "bandcamp": ProviderPolicy("bandcamp"),
    "cover_art_archive": ProviderPolicy("cover_art_archive"),
    "deezer": ProviderPolicy("deezer"),
    "discogs": ProviderPolicy(
        "discogs",
        optional_credentials=("DISCOGS_CONSUMER_KEY", "DISCOGS_CONSUMER_SECRET"),
    ),
    "fallback_web": ProviderPolicy("fallback_web"),
    "genius": ProviderPolicy("genius"),
    "manual_urls": ProviderPolicy("manual_urls"),
    "musicbrainz": ProviderPolicy("musicbrainz"),
    "spotify": ProviderPolicy("spotify", requires_credentials=True),
    "youtube_music": ProviderPolicy("youtube_music"),
}


def _config_value(config: Any, name: str) -> object:
    return getattr(config, name, None)


def _has_config_value(config: Any, name: str) -> bool:
    return bool(_config_value(config, name))


def provider_availability(
    provider_name: str,
    *,
    config: Any = Config,
    youtube_music_client_class: object | None = None,
) -> ProviderAvailability:
    normalized_name = str(provider_name or "").strip()
    policy = PROVIDER_REGISTRY.get(normalized_name, ProviderPolicy(normalized_name))

    if normalized_name == "spotify":
        missing = tuple(
            field_name
            for field_name in ("SPOTIFY_API_ENABLED", "SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET")
            if not _has_config_value(config, field_name)
        )
        return ProviderAvailability(
            name=normalized_name,
            available=not missing,
            requires_credentials=True,
            credentials_present=not missing,
            missing_requirements=missing,
        )

    if normalized_name == "youtube_music":
        missing = () if youtube_music_client_class is not None else ("ytmusicapi",)
        return ProviderAvailability(
            name=normalized_name,
            available=not missing,
            missing_requirements=missing,
        )

    credentials_present = bool(policy.optional_credentials) and all(
        _has_config_value(config, field_name)
        for field_name in policy.optional_credentials
    )
    return ProviderAvailability(
        name=normalized_name,
        available=True,
        requires_credentials=policy.requires_credentials,
        credentials_present=credentials_present,
    )
