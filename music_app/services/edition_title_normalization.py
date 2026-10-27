from __future__ import annotations

import re


_TERMINAL_DESCRIPTOR = re.compile(
    r"^(?P<title>.+?)\s*(?:\((?P<paren>[^()]+)\)|\[(?P<bracket>[^\[\]]+)\])\s*$"
)
_EDITION_QUALIFIER = re.compile(
    r"\b(?:anniversary|collector(?:'s)?|definitive|deluxe|expanded|limited|special|tour)\b",
    re.IGNORECASE,
)


def parse_edition_title(value: object) -> dict[str, str] | None:
    title = str(value or "").strip()
    match = _TERMINAL_DESCRIPTOR.fullmatch(title)
    if match is None:
        return None
    canonical_title = match.group("title").strip()
    edition = (match.group("paren") or match.group("bracket")).strip()
    if not canonical_title or not edition:
        return None
    edition_folded = edition.casefold()
    if re.search(r"\bsoundtrack\b", edition_folded):
        return None
    is_named_edition = "edition" in edition_folded and _EDITION_QUALIFIER.search(edition)
    is_expanded_remaster = (
        "expanded" in edition_folded and "remaster" in edition_folded
    )
    if not is_named_edition and not is_expanded_remaster:
        return None
    return {"title": canonical_title, "edition": edition}


def reviewable_edition_title(
    local_title: object,
    current_edition: object,
) -> dict[str, str] | None:
    candidate = parse_edition_title(local_title)
    if candidate is None:
        return None
    existing = str(current_edition or "").strip()
    if existing and existing.casefold() != candidate["edition"].casefold():
        return None
    return candidate


def match_official_edition_title(
    local_title: object,
    *,
    official_title: object,
    source_id: object,
) -> dict[str, str] | None:
    source = str(source_id or "").strip()
    candidate = parse_edition_title(local_title)
    if not source or candidate is None:
        return None
    if str(official_title or "").strip() != candidate["title"]:
        return None
    return {**candidate, "source_id": source}

