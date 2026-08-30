from __future__ import annotations

from music_app.services.library_roots import library_category_slug, library_category_slugs


_DEFAULT_GALLERY_SCOPE = "all"
_NEW_ARRIVALS_SCOPE = "new_arrivals"


def normalize_gallery_scope(raw_scope: object) -> str:
    scope = str(raw_scope or "").strip().casefold()
    if scope == _NEW_ARRIVALS_SCOPE:
        return _NEW_ARRIVALS_SCOPE
    return _DEFAULT_GALLERY_SCOPE


def normalize_visible_categories(raw_categories: list[object] | tuple[object, ...], gallery_scope: object) -> list[str]:
    scope = normalize_gallery_scope(gallery_scope)
    if scope == _NEW_ARRIVALS_SCOPE:
        return [_NEW_ARRIVALS_SCOPE]

    allowed = library_category_slugs()
    requested = [
        library_category_slug(value)
        for value in (raw_categories or [])
        if str(value or "").strip()
    ]
    if not requested:
        return allowed

    visible: list[str] = []
    seen: set[str] = set()
    for category in requested:
        if category not in allowed or category in seen:
            continue
        seen.add(category)
        visible.append(category)
    return visible or allowed


def album_visible_in_categories(album: object, visible_categories: list[str]) -> bool:
    allowed = set(visible_categories or [])
    if not allowed:
        return True

    provenance = getattr(album, "root_provenance", None)
    categories = []
    if isinstance(provenance, dict):
        categories = [
            library_category_slug(value)
            for value in list(provenance.get("categories") or [])
            if str(value or "").strip()
        ]
    if not categories:
        primary_category = getattr(album, "library_root_category", None)
        if primary_category is not None:
            categories = [library_category_slug(primary_category)]
    if not categories:
        categories = [library_category_slug(None)]
    return any(category in allowed for category in categories)


def entry_visible_in_categories(entry: dict[str, object], visible_categories: list[str]) -> bool:
    allowed = set(visible_categories or [])
    if not allowed:
        return True
    return library_category_slug(entry.get("library_root_category")) in allowed
