from __future__ import annotations

from music_app.services.utils import title_case_tag_value


def fallback_version_album_payload(album_key: object) -> dict[str, object]:
    normalized_key = str(album_key or "").strip()
    artist_name = ""
    album_name = normalized_key or "Unavailable album"
    edition = ""
    year = ""

    if normalized_key:
        parts = [part.strip() for part in normalized_key.split("::")]
        if len(parts) >= 2:
            artist_name = _display_key_part(parts[0])
            album_name = _display_key_part(parts[1])
            extra_parts = parts[2:]
            if extra_parts:
                if extra_parts[0].casefold() != "year":
                    edition = _display_key_part(extra_parts[0])
                    extra_parts = extra_parts[1:]
                if len(extra_parts) >= 2 and extra_parts[0].casefold() == "year":
                    year = extra_parts[1]
        else:
            album_name = _display_key_part(normalized_key)

    return {
        "key": normalized_key,
        "album_ref": normalized_key,
        "name": album_name,
        "album_artist": artist_name,
        "year": year,
        "edition": edition,
        "tracks": [],
    }


def _display_key_part(value: str) -> str:
    text = value.strip()
    if not text:
        return ""
    return title_case_tag_value(text) or text
