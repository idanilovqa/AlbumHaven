from __future__ import annotations

import unicodedata
from copy import deepcopy

from music_app.services.musicbrainz_client import artist_url, normalize_name, release_title_key


JsonDict = dict[str, object]


def _values(value: object) -> list[object]:
    return value if isinstance(value, list) else []


def candidate_names(candidate: JsonDict) -> set[str]:
    names = {normalize_name(candidate.get("canonical_name"))}
    names.update(
        normalize_name(alias.get("name"))
        for alias in _values(candidate.get("aliases"))
        if isinstance(alias, dict)
    )
    names.discard("")
    return names


def _release_titles(local: JsonDict) -> set[str]:
    return {
        release_title_key(credit.get("title"))
        for credit in _values(local.get("release_credits"))
        if isinstance(credit, dict) and release_title_key(credit.get("title"))
    }


def _native_name(local: JsonDict, candidate: JsonDict) -> str | None:
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


def _evidence(local: JsonDict, candidate: JsonDict) -> tuple[int, list[str]]:
    reasons: list[str] = []
    local_type = normalize_name(local.get("artist_type"))
    candidate_type = normalize_name(candidate.get("artist_type"))
    if local_type and candidate_type and local_type != candidate_type:
        reasons.append("artist_type_conflict")

    local_titles = _release_titles(local)
    candidate_titles = {
        release_title_key(title)
        for title in _values(candidate.get("release_titles"))
        if release_title_key(title)
    }
    release_match = bool(local_titles and candidate_titles and local_titles.intersection(candidate_titles))
    if local_titles and candidate_titles and not release_match:
        reasons.append("release_evidence_conflict")

    names = candidate_names(candidate)
    name_match = normalize_name(local.get("name")) in names
    credited_names = {
        normalize_name(credit.get("credited_artist"))
        for credit in _values(local.get("release_credits"))
        if isinstance(credit, dict) and normalize_name(credit.get("credited_artist"))
    }
    credit_match = bool(credited_names) and all(name in names for name in credited_names)
    if not name_match:
        reasons.append("name_conflict")
    if credited_names and not credit_match:
        reasons.append("release_credit_conflict")

    strength = 0
    if not reasons and name_match and credit_match and release_match:
        strength = 3
    return strength, reasons


def _trusted_mbid(local: JsonDict) -> tuple[str, str]:
    embedded = str(local.get("embedded_mbid") or "").strip().lower()
    if artist_url(embedded):
        return embedded, "embedded"
    assertion = local.get("existing_assertion")
    assertion = assertion if isinstance(assertion, dict) else {}
    asserted = str(
        local.get("existing_assertion_mbid")
        or local.get("asserted_mbid")
        or assertion.get("mbid")
        or ""
    ).strip().lower()
    confidence = str(
        local.get("assertion_confidence")
        or local.get("existing_assertion_confidence")
        or assertion.get("confidence")
        or ""
    ).strip().casefold()
    if artist_url(asserted) and confidence in {"high", "high_confidence", "trusted"}:
        return asserted, "assertion"
    return "", ""


def match_artist(local_evidence: object, candidates: object) -> JsonDict:
    local = local_evidence if isinstance(local_evidence, dict) else {}
    raw_candidates = (
        [candidate for candidate in candidates if isinstance(candidate, dict)]
        if isinstance(candidates, list)
        else []
    )
    assessed: list[tuple[JsonDict, int, list[str], int]] = []
    for index, raw_candidate in enumerate(raw_candidates):
        candidate = deepcopy(raw_candidate)
        strength, reasons = _evidence(local, candidate)
        if reasons:
            candidate["rejection_reasons"] = reasons
        assessed.append((candidate, strength, reasons, index))

    def score(candidate: JsonDict) -> int:
        try:
            return int(candidate.get("score") or 0)
        except (TypeError, ValueError):
            return 0

    assessed.sort(
        key=lambda item: (-item[1], -score(item[0]), str(item[0].get("mbid") or ""), item[3])
    )
    ordered = [item[0] for item in assessed]

    trusted_mbid, trusted_path = _trusted_mbid(local)
    if trusted_mbid:
        trusted = next(
            (item for item in assessed if str(item[0].get("mbid") or "").lower() == trusted_mbid),
            None,
        )
        requires_release_match = trusted_path == "assertion"
        if trusted is None or trusted[2] or (requires_release_match and trusted[1] == 0):
            return {"classification": "permanent_mismatch", "candidates": ordered}
        selected = trusted[0]
    else:
        strongest = [item for item in assessed if item[1] == 3]
        if len(strongest) != 1:
            classification = "not_found" if not assessed else "ambiguous"
            return {"classification": classification, "candidates": ordered}
        selected = strongest[0][0]
        trusted_path = "search"

    return {
        "classification": "matched",
        "selected_mbid": selected.get("mbid"),
        "preferred_native_name": _native_name(local, selected),
        "evidence_path": trusted_path,
        "candidates": ordered,
    }
