from __future__ import annotations

import hashlib
import ipaddress
import math
from collections.abc import Iterable, Mapping
from datetime import datetime, timezone
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


_MAX_CANDIDATES = 24
_SEARCH_KINDS = frozenset({"automatic", "manual"})
_TEXT_FIELDS = (
    "source",
    "source_label",
    "lookup_group",
    "artist",
    "album",
    "art_kind",
    "art_label",
)
_PERSISTED_CANDIDATE_FIELDS = frozenset(
    {
        "id",
        *_TEXT_FIELDS,
        "url",
        "thumbnail_url",
        "album_url",
        "display_only",
        "width",
        "height",
        "score",
        "year",
    }
)
_SECRET_QUERY_KEYS = frozenset(
    {
        "accesskey",
        "accesskeyid",
        "accesstoken",
        "apikey",
        "authorization",
        "auth",
        "clientsecret",
        "credential",
        "key",
        "oauth",
        "password",
        "secret",
        "signature",
        "sig",
        "token",
    }
)


class AlbumCoverCandidatePublisher:
    """Sanitize and publish one bounded candidate generation for an album."""

    def __init__(
        self,
        repository: Any,
        *,
        album_id: int,
        search_generation: str,
        search_kind: str,
    ) -> None:
        normalized_kind = str(search_kind or "").strip().casefold()
        if normalized_kind not in _SEARCH_KINDS:
            raise ValueError("search_kind must be 'automatic' or 'manual'")
        self._repository = repository
        self._album_id = int(album_id)
        self._search_generation = str(search_generation or "").strip()
        if not self._search_generation:
            raise ValueError("search_generation is required")
        self._search_kind = normalized_kind
        self._search_started_at: str | None = None
        self._published_candidates: list[dict[str, object]] = []
        self._has_published = False
        self._automatic_improvement_marked = False

    def begin_candidate_generation(self) -> str:
        if self._search_started_at is None:
            self._search_started_at = datetime.now(timezone.utc).isoformat()
        return self._search_started_at

    def publish_candidates(
        self,
        candidates: Iterable[Mapping[str, object]],
        *,
        automatic_improvement: bool = False,
    ) -> bool:
        started_at = self.begin_candidate_generation()
        incoming = [
            sanitized
            for candidate in candidates
            if isinstance(candidate, Mapping)
            if (sanitized := _sanitize_candidate(candidate)) is not None
        ]
        if not incoming:
            return False

        strongest_by_url = {
            str(candidate["url"]): candidate for candidate in self._published_candidates
        }
        for candidate in incoming:
            url = str(candidate["url"])
            incumbent = strongest_by_url.get(url)
            if incumbent is None or _quality_key(candidate) > _quality_key(incumbent):
                strongest_by_url[url] = candidate

        ranked = sorted(strongest_by_url.values(), key=_ranking_key)[:_MAX_CANDIDATES]
        self._published_candidates = ranked
        accepted = bool(
            self._repository.publish_generation(
                album_id=self._album_id,
                search_generation=self._search_generation,
                search_kind=self._search_kind,
                search_started_at=started_at,
                candidates=ranked,
                best_candidate_id=str(ranked[0]["id"]),
                automatic_improvement=(
                    self._search_kind == "automatic" and bool(automatic_improvement)
                ),
            )
        )
        if accepted:
            self._has_published = True
        return accepted

    def complete(self) -> bool:
        return self._finish("completed")

    @property
    def best_candidate_id(self) -> str | None:
        if not self._published_candidates:
            return None
        return str(self._published_candidates[0].get("id") or "").strip() or None

    def candidate_id_for(self, candidate: Mapping[str, object]) -> str | None:
        sanitized = _sanitize_candidate(candidate)
        if sanitized is None:
            return None
        normalized_url = str(sanitized["url"])
        for published in self._published_candidates:
            if str(published.get("url") or "") == normalized_url:
                return str(published.get("id") or "").strip() or None
        return None

    def mark_automatic_improvement(self, candidate_id: object) -> bool:
        normalized_candidate_id = str(candidate_id or "").strip()
        if (
            self._search_kind != "automatic"
            or not self._has_published
            or self._automatic_improvement_marked
            or not any(
                str(candidate.get("id") or "") == normalized_candidate_id
                for candidate in self._published_candidates
            )
        ):
            return False
        accepted = bool(
            self._repository.mark_automatic_improvement(
                album_id=self._album_id,
                search_generation=self._search_generation,
                candidate_id=normalized_candidate_id,
            )
        )
        if accepted:
            self._automatic_improvement_marked = True
        return accepted

    def fail(self) -> bool:
        return self._finish("failed")

    def _finish(self, status: str) -> bool:
        if not self._has_published:
            return False
        return bool(
            self._repository.finish_generation(
                album_id=self._album_id,
                search_generation=self._search_generation,
                status=status,
            )
        )


def _sanitize_candidate(candidate: Mapping[str, object]) -> dict[str, object] | None:
    url = _normalize_public_http_url(candidate.get("url"))
    if url is None:
        return None
    thumbnail_url = _normalize_public_http_url(candidate.get("thumbnail_url")) or url
    width = _nonnegative_int(candidate.get("width"))
    height = _nonnegative_int(candidate.get("height"))
    score = _finite_float(candidate.get("score"))
    candidate_id = _bounded_text(candidate.get("id"), 160)
    payload: dict[str, object] = {
        "id": candidate_id or hashlib.sha256(url.encode("utf-8")).hexdigest(),
        "source": _bounded_text(candidate.get("source"), 80),
        "source_label": _bounded_text(candidate.get("source_label"), 160),
        "lookup_group": _bounded_text(candidate.get("lookup_group"), 80),
        "url": url,
        "thumbnail_url": thumbnail_url,
        "width": width,
        "height": height,
        "score": score,
        "artist": _bounded_text(candidate.get("artist"), 500),
        "album": _bounded_text(candidate.get("album"), 500),
        "year": _candidate_year(candidate.get("year")),
        "art_kind": _bounded_text(candidate.get("art_kind"), 80),
        "art_label": _bounded_text(candidate.get("art_label"), 240),
        "album_url": _normalize_public_http_url(candidate.get("album_url")) or "",
        "display_only": bool(candidate.get("display_only")),
    }
    return payload


def sanitize_persisted_candidate_snapshot(
    candidates: object,
) -> tuple[list[dict[str, object]], bool]:
    if not isinstance(candidates, list):
        return [], True
    sanitized_candidates: list[dict[str, object]] = []
    for candidate in candidates:
        if not isinstance(candidate, Mapping):
            return [], True
        if not set(map(str, candidate.keys())).issubset(_PERSISTED_CANDIDATE_FIELDS):
            return [], True
        candidate_id = str(candidate.get("id") or "").strip()
        candidate_url = str(candidate.get("url") or "").strip()
        sanitized = _sanitize_candidate(candidate)
        if (
            sanitized is None
            or not candidate_id
            or str(sanitized.get("id") or "") != candidate_id
            or str(sanitized.get("url") or "") != candidate_url
        ):
            return [], True
        sanitized_candidates.append(sanitized)
    return sanitized_candidates, False


def _normalize_public_http_url(value: object) -> str | None:
    raw_url = str(value or "").strip()
    if not raw_url:
        return None
    try:
        parsed = urlsplit(raw_url)
        scheme = parsed.scheme.casefold()
        hostname = (parsed.hostname or "").casefold().rstrip(".")
        port = parsed.port
    except ValueError:
        return None
    if scheme not in {"http", "https"} or not hostname:
        return None
    if parsed.username is not None or parsed.password is not None:
        return None
    if _host_is_private(hostname):
        return None

    query_items = parse_qsl(parsed.query, keep_blank_values=True)
    if any(_query_key_is_secret(key) for key, _value in query_items):
        return None
    query = urlencode(sorted(query_items), doseq=True)

    rendered_host = f"[{hostname}]" if ":" in hostname else hostname
    if port is not None and not (
        (scheme == "http" and port == 80) or (scheme == "https" and port == 443)
    ):
        rendered_host = f"{rendered_host}:{port}"
    return urlunsplit((scheme, rendered_host, parsed.path or "/", query, ""))


def _host_is_private(hostname: str) -> bool:
    if hostname == "localhost" or hostname.endswith((".localhost", ".local", ".internal")):
        return True
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        return False
    return not address.is_global


def _query_key_is_secret(key: str) -> bool:
    normalized = "".join(character for character in key.casefold() if character.isalnum())
    return normalized in _SECRET_QUERY_KEYS or any(
        marker in normalized
        for marker in ("password", "secret", "credential", "authorization", "token")
    )


def _bounded_text(value: object, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _nonnegative_int(value: object) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError, OverflowError):
        return 0


def _finite_float(value: object) -> float:
    try:
        result = float(value or 0.0)
    except (TypeError, ValueError, OverflowError):
        return 0.0
    return result if math.isfinite(result) else 0.0


def _candidate_year(value: object) -> int | str:
    try:
        return int(value)
    except (TypeError, ValueError, OverflowError):
        return _bounded_text(value, 32)


def _quality_key(candidate: Mapping[str, object]) -> tuple[float, int, int, int, str]:
    width = int(candidate.get("width") or 0)
    height = int(candidate.get("height") or 0)
    return (
        float(candidate.get("score") or 0.0),
        width * height,
        width,
        height,
        str(candidate.get("source") or "").casefold(),
    )


def _ranking_key(candidate: Mapping[str, object]) -> tuple[float, int, int, int, str, str]:
    score, area, width, height, source = _quality_key(candidate)
    return (
        -score,
        -area,
        -width,
        -height,
        str(candidate.get("url") or "").casefold(),
        source,
    )
