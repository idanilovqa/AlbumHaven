from __future__ import annotations

DEFAULT_GALLERY_DISPLAY_MODE = "cards"
ALLOWED_GALLERY_DISPLAY_MODES = frozenset({"cards", "covers", "list"})
DEFAULT_GALLERY_SCALE_PERCENT = 100
MIN_GALLERY_SCALE_PERCENT = 80
MAX_GALLERY_SCALE_PERCENT = 140


def normalize_gallery_display_mode(value: object) -> str:
    normalized = str(value or "").strip().casefold()
    if normalized in ALLOWED_GALLERY_DISPLAY_MODES:
        return normalized
    return DEFAULT_GALLERY_DISPLAY_MODE


def normalize_gallery_scale_percent(value: object) -> int:
    if value is None:
        return DEFAULT_GALLERY_SCALE_PERCENT
    text = str(value).strip()
    if not text:
        return DEFAULT_GALLERY_SCALE_PERCENT
    try:
        normalized = int(float(text))
    except (TypeError, ValueError):
        return DEFAULT_GALLERY_SCALE_PERCENT
    if normalized < MIN_GALLERY_SCALE_PERCENT or normalized > MAX_GALLERY_SCALE_PERCENT:
        return DEFAULT_GALLERY_SCALE_PERCENT
    return normalized
