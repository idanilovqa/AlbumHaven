from __future__ import annotations

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
