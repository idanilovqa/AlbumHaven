"""The native-script display name MusicBrainz offers for a matched artist.

Matching itself lives in ``musicbrainz_evidence``: names only retrieve
candidates, and an artist is accepted on album evidence.
"""
from __future__ import annotations

import unicodedata

from music_app.services.musicbrainz_client import normalize_name


JsonDict = dict[str, object]


def _values(value: object) -> list[object]:
    return value if isinstance(value, list) else []


def native_name(local: JsonDict, candidate: JsonDict) -> str | None:
    locale = str(local.get("locale") or "").strip().casefold()
    if not locale:
        return None
    canonical = str(candidate.get("canonical_name") or "").strip()
    local_names = {
        normalize_name(local.get("name")),
        *(
            normalize_name(credit.get("credited_artist"))
            for credit in _values(local.get("release_credits"))
            if isinstance(credit, dict)
        ),
    }
    if canonical and any(
        character.isalpha() and "LATIN" not in unicodedata.name(character, "")
        for character in canonical
    ) and normalize_name(canonical) in local_names:
        return canonical
    aliases = [alias for alias in _values(candidate.get("aliases")) if isinstance(alias, dict)]
    matches = [
        alias for alias in aliases
        if str(alias.get("locale") or "").strip().casefold().split("-")[0] == locale.split("-")[0]
        and str(alias.get("name") or "").strip()
        and any(
            character.isalpha() and not character.isascii()
            for character in str(alias.get("name"))
        )
    ]
    matches.sort(key=lambda alias: (not bool(alias.get("primary")), normalize_name(alias.get("name"))))
    return str(matches[0]["name"]).strip() if matches else None


def _letters_of(value: str, script: str) -> bool:
    letters = [character for character in value if character.isalpha()]
    return bool(letters) and all(script in unicodedata.name(character, "") for character in letters)


def _needs_romanized_name(name: str) -> bool:
    """Japanese, Korean, Hebrew and every other script but Latin and Cyrillic (approved J3:
    Cyrillic names get only the hover form)."""
    return any(
        character.isalpha()
        and not any(script in unicodedata.name(character, "") for script in ("LATIN", "CYRILLIC"))
        for character in name
    )


def romanized_name(local_name: object, artist: JsonDict | None) -> str | None:
    """The Latin form of an original-script artist name, from the stored MusicBrainz artist
    (owner 2026-11-15, J3): a primary Latin alias (English first), else a Latin canonical
    name, else another Latin alias with a locale, else the Latin sort name read first name
    first ("Hirasawa, Susumu" is "Susumu Hirasawa"). Search hints never count."""
    name = str(local_name or "").strip()
    if not artist or not _needs_romanized_name(name):
        return None
    aliases = [
        alias for alias in _values(artist.get("aliases"))
        if isinstance(alias, dict) and _letters_of(str(alias.get("name") or ""), "LATIN")
        and str(alias.get("kind") or "").strip().casefold() != "search hint"
    ]
    aliases.sort(key=lambda alias: str(alias.get("locale") or "").casefold().split("-")[0] != "en")
    canonical = str(artist.get("canonical_name") or "").strip()
    sort_name = str(artist.get("sort_name") or "").strip()
    last, separator, first = sort_name.partition(", ")
    candidates = [
        *(alias["name"] for alias in aliases if alias.get("primary")),
        canonical if _letters_of(canonical, "LATIN") else "",
        *(alias["name"] for alias in aliases if not alias.get("primary") and alias.get("locale")),
        (f"{first} {last}" if separator and first else sort_name) if _letters_of(sort_name, "LATIN") else "",
    ]
    return next((str(candidate).strip() for candidate in candidates if str(candidate or "").strip()), None)
