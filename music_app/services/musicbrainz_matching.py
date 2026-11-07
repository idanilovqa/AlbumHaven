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
