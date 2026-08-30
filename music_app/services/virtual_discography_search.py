from __future__ import annotations

import urllib.parse

from config import Config
from music_app.services.music_identity_matching import (
    artist_identity_similarity,
    same_artist_identity,
)
from music_app.services.musicbrainz_http import get_json as musicbrainz_get_json


JsonDict = dict[str, object]

_DEFAULT_SEARCH_LIMIT = 8
_PROVIDER_NAME = "musicbrainz"
_CANDIDATE_REF_PREFIX = "musicbrainz:artist:"


def _normalize_query(value: object) -> str:
    return " ".join(str(value or "").split()).strip()


def _normalize_limit(value: object) -> int:
    try:
        limit = int(value)
    except (TypeError, ValueError):
        return _DEFAULT_SEARCH_LIMIT
    return max(1, min(limit, 10))


def _build_artist_search_url(query: str, *, limit: int) -> str:
    quoted_query = urllib.parse.quote(f'artist:"{query}"')
    return (
        f"{Config.MUSICBRAINZ_BASE_URL}/artist/"
        f"?query={quoted_query}&fmt=json&limit={limit}"
    )


def _build_life_span_text(item: JsonDict) -> str:
    life_span = item.get("life-span")
    if not isinstance(life_span, dict):
        return ""
    begin = str(life_span.get("begin") or "").strip()
    end = str(life_span.get("end") or "").strip()
    ended = bool(life_span.get("ended"))
    if begin and end:
        return f"{begin} to {end}"
    if begin and ended:
        return f"{begin} to ?"
    if begin:
        return f"{begin} to present"
    if end:
        return f"? to {end}"
    return ""


def _build_disambiguation_text(item: JsonDict) -> str:
    parts: list[str] = []
    artist_type = str(item.get("type") or "").strip()
    if artist_type:
        parts.append(artist_type)
    area = item.get("area")
    if isinstance(area, dict):
        area_name = str(area.get("name") or "").strip()
        if area_name:
            parts.append(area_name)
    country = str(item.get("country") or "").strip()
    if country and country not in parts:
        parts.append(country)
    life_span_text = _build_life_span_text(item)
    if life_span_text:
        parts.append(life_span_text)
    disambiguation = str(item.get("disambiguation") or "").strip()
    if disambiguation:
        parts.append(disambiguation)
    return " | ".join(part for part in parts if part)


def _build_candidate(item: JsonDict) -> JsonDict | None:
    artist_id = str(item.get("id") or "").strip()
    display_name = str(item.get("name") or "").strip()
    if not artist_id or not display_name:
        return None
    try:
        match_score = int(item.get("score") or 0)
    except (TypeError, ValueError):
        match_score = 0
    candidate: JsonDict = {
        "candidate_ref": f"{_CANDIDATE_REF_PREFIX}{artist_id}",
        "provider": _PROVIDER_NAME,
        "provider_artist_id": artist_id,
        "display_name": display_name,
        "sort_name": str(item.get("sort-name") or display_name).strip(),
        "disambiguation_text": _build_disambiguation_text(item),
        "match_score": match_score,
    }
    if isinstance(item.get("aliases"), list):
        aliases = [
            str(alias.get("name") or "").strip()
            for alias in item["aliases"]
            if isinstance(alias, dict) and str(alias.get("name") or "").strip()
        ]
        if aliases:
            candidate["aliases"] = aliases[:5]
    return candidate


def _build_candidate_contract() -> JsonDict:
    return {
        "identity_field": "candidate_ref",
        "submit_route": "/virtual-artists",
        "display_name_field": "display_name",
        "disambiguation_text_field": "disambiguation_text",
        "provider_artist_id_field": "provider_artist_id",
    }


def search_virtual_artist_candidates(
    query: object,
    *,
    limit: object = _DEFAULT_SEARCH_LIMIT,
) -> JsonDict:
    normalized_query = _normalize_query(query)
    normalized_limit = _normalize_limit(limit)
    payload: JsonDict = {
        "ok": True,
        "query": normalized_query,
        "provider_state": {
            "provider": _PROVIDER_NAME,
            "query_performed": False,
            "status": "idle",
        },
        "candidate_contract": _build_candidate_contract(),
        "candidates": [],
    }
    if not normalized_query:
        return payload

    result, meta = musicbrainz_get_json(
        _build_artist_search_url(normalized_query, limit=normalized_limit),
        Config.MUSICBRAINZ_USER_AGENT,
        timeout=15.0,
        context=f"virtual-discography-candidate-search:{normalized_query}",
    )
    provider_state = {
        "provider": _PROVIDER_NAME,
        "query_performed": True,
        "status": str(meta.get("status") or "unknown"),
        "cache_hit": bool(meta.get("cache_hit")),
    }
    if meta.get("blocked_reason"):
        provider_state["blocked_reason"] = str(meta.get("blocked_reason"))
    if meta.get("retry_after_seconds") is not None:
        provider_state["retry_after_seconds"] = meta.get("retry_after_seconds")
    payload["provider_state"] = provider_state

    artist_items = result.get("artists") if isinstance(result, dict) else []
    if not isinstance(artist_items, list):
        artist_items = []

    candidates = [
        candidate
        for candidate in (
            _build_candidate(item)
            for item in artist_items
            if isinstance(item, dict)
        )
        if isinstance(candidate, dict)
    ]
    for candidate in candidates:
        display_name = candidate.get("display_name")
        candidate["identity_match_score"] = (
            1.0
            if same_artist_identity(normalized_query, display_name)
            else artist_identity_similarity(normalized_query, display_name)
        )
    candidates.sort(
        key=lambda candidate: (
            -int(same_artist_identity(normalized_query, candidate.get("display_name"))),
            -float(candidate.get("identity_match_score") or 0.0),
            -int(candidate.get("match_score") or 0),
            str(candidate.get("display_name") or "").casefold(),
        )
    )
    payload["candidates"] = candidates[:normalized_limit]

    if result is None:
        payload["ok"] = False
        payload["error"] = (
            "Virtual Discography candidate search is temporarily unavailable."
        )
        return payload

    payload["ok"] = True
    return payload
