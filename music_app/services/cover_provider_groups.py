from __future__ import annotations


COVER_LOOKUP_PROVIDER_GROUP_NAMES = (
    "music_services",
    "manual_urls",
    "bandcamp",
    "cover_art_archive",
    "discogs",
    "artist_website_fallback",
)

COVER_LOOKUP_MUSIC_SERVICE_NAMES = (
    "apple",
    "deezer",
    "youtube_music",
    "spotify",
    "genius",
)

_COVER_PROVIDER_GROUP_ALIASES = {
    "all": frozenset(COVER_LOOKUP_PROVIDER_GROUP_NAMES),
    "manual-only": frozenset({"manual_urls"}),
    "manual_only": frozenset({"manual_urls"}),
    "offline": frozenset({"manual_urls"}),
}


def normalize_cover_provider_groups(value: object = None) -> frozenset[str]:
    if value is None or (isinstance(value, str) and not value.strip()):
        return frozenset(COVER_LOOKUP_PROVIDER_GROUP_NAMES)
    if isinstance(value, str):
        requested = {item.strip().lower() for item in value.split(",") if item.strip()}
    elif isinstance(value, (list, tuple, set, frozenset)):
        requested = {str(item or "").strip().lower() for item in value if str(item or "").strip()}
    else:
        raise ValueError("Cover provider groups must be a comma-separated string or collection.")
    if len(requested) == 1:
        alias = _COVER_PROVIDER_GROUP_ALIASES.get(next(iter(requested)))
        if alias is not None:
            return alias
    unknown = requested - set(COVER_LOOKUP_PROVIDER_GROUP_NAMES)
    if unknown:
        allowed = ", ".join(COVER_LOOKUP_PROVIDER_GROUP_NAMES)
        raise ValueError(
            f"Unknown cover provider group(s): {', '.join(sorted(unknown))}. Allowed groups: {allowed}."
        )
    return frozenset(requested)


def normalize_enabled_music_services(value: object = None) -> frozenset[str]:
    if value is None or (isinstance(value, str) and not value.strip()):
        return frozenset(COVER_LOOKUP_MUSIC_SERVICE_NAMES)
    if isinstance(value, str):
        requested = {item.strip().lower() for item in value.split(",") if item.strip()}
    elif isinstance(value, (list, tuple, set, frozenset)):
        requested = {str(item or "").strip().lower() for item in value if str(item or "").strip()}
    else:
        raise ValueError("Enabled music services must be a comma-separated string or collection.")
    unknown = requested - set(COVER_LOOKUP_MUSIC_SERVICE_NAMES)
    if unknown:
        allowed = ", ".join(COVER_LOOKUP_MUSIC_SERVICE_NAMES)
        raise ValueError(
            f"Unknown music service(s): {', '.join(sorted(unknown))}. Allowed services: {allowed}."
        )
    return frozenset(requested)


def cover_provider_group_enabled(value: object, group_name: str) -> bool:
    return str(group_name or "").strip().lower() in normalize_cover_provider_groups(value)
