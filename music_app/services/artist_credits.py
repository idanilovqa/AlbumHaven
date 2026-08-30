from __future__ import annotations

import re

from music_app.services.utils import repair_display_text


_STABLE_ARTIST_COMPOSITE_RE = re.compile(r"\s+/\s+")
_ARTIST_PUNCT_TRANSLATION = str.maketrans(
    {
        "\u2018": "'",
        "\u2019": "'",
        "\u201b": "'",
        "\u2032": "'",
        "\u02bc": "'",
        "\u00b4": "'",
        "`": "'",
    }
)


def _normalize_artist_key(value: object) -> str:
    text = " ".join(str(value or "").strip().split())
    return text.translate(_ARTIST_PUNCT_TRANSLATION).casefold()


def deduplicate_repeated_album_artist_members(value: object) -> list[str]:
    text = (repair_display_text(str(value or "")) or str(value or "")).strip()
    if not text:
        return []
    parts = [part.strip() for part in _STABLE_ARTIST_COMPOSITE_RE.split(text) if part.strip()]
    if len(parts) < 2:
        return []
    unique_parts: list[str] = []
    seen: set[str] = set()
    found_duplicate = False
    for part in parts:
        normalized = _normalize_artist_key(part)
        if normalized in seen:
            found_duplicate = True
            continue
        seen.add(normalized)
        unique_parts.append(part)
    return unique_parts if found_duplicate else []
