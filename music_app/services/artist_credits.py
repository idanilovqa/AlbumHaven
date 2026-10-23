from __future__ import annotations

import re

from music_app.services.music_identity_matching import same_artist_credit_spelling
from music_app.services.utils import repair_display_text


_STABLE_ARTIST_COMPOSITE_RE = re.compile(r"\s+/\s+")
_OWNER_LED_FEATURE_RE = re.compile(
    r"^(?P<owner>.+?)\s+(?:feat\.?|featuring|with|vs|x)\s+(?P<featured>.+)$",
    re.IGNORECASE,
)
_NUMERIC_ARTIST_SLASH_RE = re.compile(r"(?<=\d)\s*/\s*(?=\d)")
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


def track_artist_credit_members(value: object, album_owner: object) -> list[str]:
    text = (repair_display_text(str(value or "")) or str(value or "")).strip()
    if not text:
        return []

    owner = str(album_owner or "").strip()
    members: list[str] = []
    for segment in (part.strip() for part in text.split(";")):
        if not segment:
            continue
        match = _OWNER_LED_FEATURE_RE.match(segment)
        candidates = (
            (owner, match.group("featured"))
            if owner
            and match is not None
            and same_artist_credit_spelling(match.group("owner"), owner)
            else (segment,)
        )
        for candidate in candidates:
            member = _NUMERIC_ARTIST_SLASH_RE.sub("/", candidate.strip())
            if member and not any(
                same_artist_credit_spelling(member, existing) for existing in members
            ):
                members.append(member)

    if owner and any(same_artist_credit_spelling(owner, member) for member in members):
        members = [
            owner,
            *(
                member
                for member in members
                if not same_artist_credit_spelling(owner, member)
            ),
        ]
    return members


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
