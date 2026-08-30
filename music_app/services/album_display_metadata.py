from __future__ import annotations

from music_app.services.source_helpers import field_from_source


def _normalize_text(value: object) -> str | None:
    text = str(value or "").strip()
    return text or None


def _normalize_code(value: object) -> str | None:
    text = _normalize_text(value)
    return text.upper() if text else None


def _normalize_display_country(source: object) -> dict[str, object]:
    payload = source if isinstance(source, dict) else {}
    return {
        "name": _normalize_text(payload.get("name")),
        "code": _normalize_code(payload.get("code")),
        "source_kind": _normalize_text(payload.get("source_kind")),
    }


def _normalize_genre_payload(source: object) -> dict[str, object]:
    payload = source if isinstance(source, dict) else {}
    return {
        "name": _normalize_text(payload.get("name")),
        "slug": _normalize_text(payload.get("slug")),
        "source_kind": _normalize_text(payload.get("source_kind")),
    }


def _normalize_exact_genres(source: object) -> list[dict[str, object]]:
    if not isinstance(source, list):
        return []
    normalized: list[dict[str, object]] = []
    for item in source:
        if not isinstance(item, dict):
            continue
        normalized.append(_normalize_genre_payload(item))
    return normalized


def _normalize_source_provenance(source: object) -> dict[str, object]:
    payload = source if isinstance(source, dict) else {}
    return {
        "provider": _normalize_text(payload.get("provider")),
        "provider_record_kind": _normalize_text(payload.get("provider_record_kind")),
        "provider_record_id": _normalize_text(payload.get("provider_record_id")),
        "generalized_genre_algorithm_version": _normalize_text(
            payload.get("generalized_genre_algorithm_version")
        ),
    }


def build_album_display_metadata_payload(source: object) -> dict[str, object]:
    nested = field_from_source(source, "album_display_metadata", None)
    payload = nested if isinstance(nested, dict) else {}
    return {
        "display_country": _normalize_display_country(payload.get("display_country")),
        "generalized_genre": _normalize_genre_payload(payload.get("generalized_genre")),
        "exact_genres": _normalize_exact_genres(payload.get("exact_genres")),
        "source_provenance": _normalize_source_provenance(payload.get("source_provenance")),
        "freshness_state": _normalize_text(payload.get("freshness_state")) or "missing",
    }


def has_album_display_metadata_values(payload: object) -> bool:
    if not isinstance(payload, dict):
        return False
    display_country = payload.get("display_country")
    if isinstance(display_country, dict) and any(display_country.values()):
        return True
    generalized_genre = payload.get("generalized_genre")
    if isinstance(generalized_genre, dict) and any(generalized_genre.values()):
        return True
    exact_genres = payload.get("exact_genres")
    if isinstance(exact_genres, list) and any(
        isinstance(item, dict) and any(item.values()) for item in exact_genres
    ):
        return True
    source_provenance = payload.get("source_provenance")
    if isinstance(source_provenance, dict) and any(source_provenance.values()):
        return True
    return str(payload.get("freshness_state") or "").strip() not in {"", "missing"}
