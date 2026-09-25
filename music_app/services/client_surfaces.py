from __future__ import annotations

import re

VALID_CLIENT_SURFACE_CLASSES = frozenset({
    "cloud_web",
    "private_web",
    "desktop",
    "mobile",
    "tv",
    "node",
})
DEFAULT_CLIENT_SURFACE_CLASS = "private_web"


def normalize_client_surface_class(
    value: object = None,
    *,
    default: str = DEFAULT_CLIENT_SURFACE_CLASS,
) -> str:
    normalized_default = str(default or DEFAULT_CLIENT_SURFACE_CLASS).strip().casefold().replace("-", "_")
    if normalized_default not in VALID_CLIENT_SURFACE_CLASSES:
        normalized_default = DEFAULT_CLIENT_SURFACE_CLASS

    normalized_value = str(value or "").strip().casefold().replace("-", "_")
    if normalized_value in VALID_CLIENT_SURFACE_CLASSES:
        return normalized_value
    return normalized_default


def resolve_client_surface_class(
    value: object = None,
    *,
    default: str = DEFAULT_CLIENT_SURFACE_CLASS,
) -> str:
    if value is not None and str(value).strip():
        return normalize_client_surface_class(value, default=default)
    return normalize_client_surface_class(default, default=default)


_TV_USER_AGENT = re.compile(
    r"smart[- ]?tv|hbbtv|googletv|android tv|appletv|\broku\b|\baft[a-z0-9]+\b|web0s|netcast|viera",
    re.IGNORECASE,
)
_MOBILE_USER_AGENT = re.compile(r"android|iphone|ipad|ipod|mobile", re.IGNORECASE)


def client_surface_from_request(request) -> str:
    """Use server-authenticated native context; HTTP hints may only narrow it.

    Browser query parameters, role names and claimed desktop headers never grant
    native desktop privileges. UA/client hints identify ordinary mobile web/TV;
    they are presentation hints, not device attestation or account authority.
    """
    trusted = request.scope.get("album_haven.authenticated_client_surface")
    surface = normalize_client_surface_class(trusted)
    hint = str(request.headers.get("x-album-haven-client-surface", "")).casefold()
    user_agent = request.headers.get("user-agent", "")
    if surface == "tv" or hint == "tv" or _TV_USER_AGENT.search(user_agent):
        return "tv"
    if (
        surface == "mobile"
        or hint == "mobile"
        or request.headers.get("sec-ch-ua-mobile") == "?1"
        or _MOBILE_USER_AGENT.search(user_agent)
    ):
        return "mobile"
    return surface
