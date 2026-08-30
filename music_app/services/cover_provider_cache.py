from __future__ import annotations

import json
import logging
import re
import threading
import time
import unicodedata
from pathlib import Path

from config import Config

_LOGGER = logging.getLogger(__name__)

_NEGATIVE_CACHE_TTL_SECONDS = 60 * 60 * 24 * 30
_BULK_NEGATIVE_CACHE_TTL_SECONDS = 60 * 60 * 12
_CAA_RESULTS_CACHE_TTL_SECONDS = 60 * 60 * 6

_MUSICBRAINZ_RELEASE_DISK_CACHE_LOCK = threading.Lock()
_CAA_RESULTS_CACHE_LOCK = threading.Lock()

_CYRILLIC_TO_LATIN = {
    "а": "a",
    "б": "b",
    "в": "v",
    "г": "g",
    "д": "d",
    "е": "e",
    "ё": "yo",
    "ж": "zh",
    "з": "z",
    "и": "i",
    "й": "y",
    "к": "k",
    "л": "l",
    "м": "m",
    "н": "n",
    "о": "o",
    "п": "p",
    "р": "r",
    "с": "s",
    "т": "t",
    "у": "u",
    "ф": "f",
    "х": "kh",
    "ц": "ts",
    "ч": "ch",
    "ш": "sh",
    "щ": "shch",
    "ъ": "",
    "ы": "y",
    "ь": "",
    "э": "e",
    "ю": "yu",
    "я": "ya",
}
_SEARCH_SYMBOL_WORDS = {
    "?": "question mark",
    "!": "exclamation mark",
    "&": "and",
    "+": "plus",
    "@": "at",
    "#": "number",
    "%": "percent",
    "$": "dollar",
    "*": "star",
}


class CoverSearchCache:
    def __init__(self, cache_path: Path):
        self.cache_path = cache_path
        self._payload = self._read()
        self._dirty = False
        self._lock = threading.Lock()

    def _log_permission_error(self, action: str, exc: PermissionError) -> None:
        _LOGGER.warning(
            "Cover search cache %s skipped path=%r error=%r",
            action,
            str(self.cache_path),
            exc,
        )

    def _read(self) -> dict[str, dict[str, object]]:
        try:
            if not self.cache_path.exists():
                return {"queries": {}}
            payload = json.loads(self.cache_path.read_text(encoding="utf-8"))
            if isinstance(payload, dict) and isinstance(payload.get("queries"), dict):
                return payload
        except PermissionError as exc:
            self._log_permission_error("read", exc)
        except Exception:
            pass
        return {"queries": {}}

    def get(self, key: str) -> dict[str, object] | None:
        with self._lock:
            queries = self._payload.get("queries")
            if not isinstance(queries, dict):
                return None
            entry = queries.get(key)
            return dict(entry) if isinstance(entry, dict) else None

    def set(self, key: str, value: dict[str, object]) -> None:
        with self._lock:
            queries = self._payload.setdefault("queries", {})
            if isinstance(queries, dict):
                queries[key] = dict(value)
                self._dirty = True

    def save(self) -> None:
        with self._lock:
            if not self._dirty:
                return
            try:
                self.cache_path.parent.mkdir(parents=True, exist_ok=True)
                self.cache_path.write_text(json.dumps(self._payload, indent=2), encoding="utf-8")
            except PermissionError as exc:
                self._log_permission_error("write", exc)
                return
            self._dirty = False


_MUSICBRAINZ_RELEASE_DISK_CACHE = CoverSearchCache(Config.COVER_CACHE_PATH)


def _replace_search_symbols(value: str) -> str:
    result: list[str] = []
    for char in value or "":
        replacement = _SEARCH_SYMBOL_WORDS.get(char)
        if replacement is None:
            result.append(char)
            continue
        result.append(f" {replacement} ")
    return "".join(result)


def _transliterate_cyrillic(value: str) -> str:
    result: list[str] = []
    for char in value or "":
        lower = char.lower()
        replacement = _CYRILLIC_TO_LATIN.get(lower)
        if replacement is None:
            result.append(char)
            continue
        if char.isupper():
            if len(replacement) > 1:
                result.append(replacement[:1].upper() + replacement[1:])
            else:
                result.append(replacement.upper())
        else:
            result.append(replacement)
    return "".join(result)


def _normalize(value: str) -> str:
    symbol_expanded = _replace_search_symbols(value or "")
    transliterated = _transliterate_cyrillic(symbol_expanded)
    ascii_text = unicodedata.normalize("NFKD", transliterated).encode("ascii", "ignore").decode("ascii")
    return re.sub(r"[^a-z0-9]+", " ", ascii_text.casefold()).strip()


def _query_key(artist: str, album: str, edition: str | None, year: int | None) -> str:
    return f"{_normalize(artist)}::{_normalize(album)}::{_normalize(edition or '')}::{year or ''}"


def cover_query_key(artist: str, album: str, edition: str | None, year: int | None) -> str:
    return _query_key(artist, album, edition, year)


def _musicbrainz_release_disk_cache_key(cache_key: str) -> str:
    return f"musicbrainz-release::{cache_key}"


def _get_musicbrainz_release_disk_cache(
    cache_key: str,
    *,
    cache: CoverSearchCache | None = None,
) -> list[dict] | None:
    disk_cache = cache or _MUSICBRAINZ_RELEASE_DISK_CACHE
    with _MUSICBRAINZ_RELEASE_DISK_CACHE_LOCK:
        cached = disk_cache.get(_musicbrainz_release_disk_cache_key(cache_key))
    releases = cached.get("releases") if isinstance(cached, dict) else None
    if not isinstance(releases, list):
        return None
    return [item for item in releases if isinstance(item, dict)]


def _set_musicbrainz_release_disk_cache(
    cache_key: str,
    releases: list[dict],
    *,
    cache: CoverSearchCache | None = None,
) -> None:
    sanitized_releases = [dict(item) for item in releases if isinstance(item, dict)]
    if not sanitized_releases:
        return
    disk_cache = cache or _MUSICBRAINZ_RELEASE_DISK_CACHE
    with _MUSICBRAINZ_RELEASE_DISK_CACHE_LOCK:
        disk_cache.set(
            _musicbrainz_release_disk_cache_key(cache_key),
            {
                "updated_at": time.time(),
                "releases": sanitized_releases,
            },
        )
        disk_cache.save()


def _caa_results_disk_cache_key(cache_key: str) -> str:
    return f"caa-results::{cache_key}"


def _get_caa_results_disk_cache(
    cache_key: str,
    *,
    cache: CoverSearchCache | None = None,
) -> list[dict] | None:
    disk_cache = cache or _MUSICBRAINZ_RELEASE_DISK_CACHE
    with _CAA_RESULTS_CACHE_LOCK:
        cached = disk_cache.get(_caa_results_disk_cache_key(cache_key))
    if not isinstance(cached, dict):
        return None
    updated_at = float(cached.get("updated_at") or 0.0)
    if not updated_at or (time.time() - updated_at) > _CAA_RESULTS_CACHE_TTL_SECONDS:
        return None
    candidates = cached.get("candidates")
    if not isinstance(candidates, list):
        return None
    return [item for item in candidates if isinstance(item, dict)]


def _set_caa_results_disk_cache(
    cache_key: str,
    candidates: list[dict],
    *,
    cache: CoverSearchCache | None = None,
) -> None:
    sanitized_candidates = [dict(item) for item in candidates if isinstance(item, dict)]
    if not sanitized_candidates:
        return
    disk_cache = cache or _MUSICBRAINZ_RELEASE_DISK_CACHE
    with _CAA_RESULTS_CACHE_LOCK:
        disk_cache.set(
            _caa_results_disk_cache_key(cache_key),
            {
                "updated_at": time.time(),
                "ttl_seconds": _CAA_RESULTS_CACHE_TTL_SECONDS,
                "candidates": sanitized_candidates,
            },
        )
        disk_cache.save()
