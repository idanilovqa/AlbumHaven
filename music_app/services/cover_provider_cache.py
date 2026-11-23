from __future__ import annotations

import json
import logging
import re
import threading
import time
import unicodedata
from pathlib import Path

from psycopg.types.json import Jsonb

from config import Config
from music_app.services.postgres_connections import leased_connection

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
    """Cover provider answers, one `library.cover_provider_cache_entries` row per query key (migration 0293).

    `get` reads one row by its primary key; `set` stages an answer and `save` upserts only the staged keys, so
    no lookup or save loads or rewrites the whole cache. Without a database URL, or in a browse-only app
    (`writable=False`), new answers live in this process only: nothing is written to a file or the database."""

    def __init__(self, database_url: str | None = None, *, connect=None, writable: bool = True):
        self.database_url = str(database_url or "").strip()
        self.writable = writable
        self._connect = connect or leased_connection
        self._staged: dict[str, dict[str, object]] = {}
        self._lock = threading.Lock()

    def get(self, key: str) -> dict[str, object] | None:
        with self._lock:
            staged = self._staged.get(key)
        if staged is not None:
            return dict(staged)
        if not self.database_url:
            return None
        try:
            with self._connect(self.database_url) as connection:
                row = connection.execute(_SELECT_ENTRY_SQL, (key,)).fetchone()
        except Exception:
            _LOGGER.warning("Cover provider cache read failed key=%r", key, exc_info=True)
            return None
        payload = _row_payload(row)
        return dict(payload) if isinstance(payload, dict) else None

    def set(self, key: str, value: dict[str, object]) -> None:
        with self._lock:
            self._staged[key] = dict(value)

    def save(self) -> None:
        if not self.database_url or not self.writable:
            return
        with self._lock:
            staged = dict(self._staged)
        if not staged:
            return
        try:
            with self._connect(self.database_url) as connection:
                connection.execute(_UPSERT_ENTRIES_SQL, (Jsonb(staged),))
        except Exception:
            _LOGGER.warning("Cover provider cache write failed entries=%d", len(staged), exc_info=True)
            return
        with self._lock:
            for key, value in staged.items():
                if self._staged.get(key) == value:
                    del self._staged[key]


_SELECT_ENTRY_SQL = "select payload from library.cover_provider_cache_entries where cache_key = %s"
_UPSERT_ENTRIES_SQL = """
    insert into library.cover_provider_cache_entries (cache_key, payload, updated_at)
    select entry.key, entry.value, now() from jsonb_each(%s::jsonb) as entry
    on conflict (cache_key) do update set payload = excluded.payload, updated_at = excluded.updated_at
"""
_IMPORT_ENTRIES_SQL = """
    insert into library.cover_provider_cache_entries (cache_key, payload)
    select entry.key, entry.value from jsonb_each(%s::jsonb) as entry
    where btrim(entry.key) <> '' and jsonb_typeof(entry.value) = 'object'
    on conflict (cache_key) do nothing
"""
_IMPORT_SOURCE = "cover_search_cache_json"
_IMPORT_BATCH_SIZE = 500


def _row_payload(row: object) -> object:
    if row is None:
        return None
    if isinstance(row, dict):
        return row.get("payload")
    return row[0]


def cover_cache_writable(config) -> bool:
    """A browse-only app reads provider answers but never writes them (the shared-database writer rule)."""
    return config.get("SHARED_LIBRARY_BROWSE_ONLY") is not True


def configure_shared_cover_search_cache(config) -> None:
    """Points the process cache that provider helpers use at this app's database and writer role."""
    _MUSICBRAINZ_RELEASE_DISK_CACHE.database_url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
    _MUSICBRAINZ_RELEASE_DISK_CACHE.writable = cover_cache_writable(config)


def import_cover_search_cache_file(config, *, connect=None, stop_requested=None) -> dict[str, object]:
    """One-time startup backfill of an existing cover_search_cache.json into Postgres, in logged batches.

    Rows already in Postgres win. A finished import is recorded, so later startups read only that one row.
    The file is left in place and no longer read."""
    database_url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "").strip()
    if not database_url or not cover_cache_writable(config):
        return {"status": "skipped"}
    connector = connect or leased_connection
    with connector(database_url) as connection:
        if connection.execute(
            "select 1 from library.cover_provider_cache_imports where source = %s", (_IMPORT_SOURCE,)
        ).fetchone() is not None:
            return {"status": "done"}
    source = Path(config.get("COVER_CACHE_PATH") or "")
    queries: dict[str, object] = {}
    if source.is_file():
        try:
            payload = json.loads(source.read_text(encoding="utf-8"))
        except Exception:
            _LOGGER.warning("Cover provider cache import could not read the old cache file", exc_info=True)
            return {"status": "failed"}
        if isinstance(payload, dict) and isinstance(payload.get("queries"), dict):
            queries = {str(key): value for key, value in payload["queries"].items() if isinstance(value, dict)}
    keys = list(queries)
    total = len(keys)
    if total:
        _LOGGER.info("Cover provider cache import started entries=%d", total)
    for start in range(0, total, _IMPORT_BATCH_SIZE):
        if stop_requested is not None and stop_requested.is_set():
            _LOGGER.info("Cover provider cache import paused imported=%d of %d", start, total)
            return {"status": "stopped", "imported": start, "total": total}
        batch = {key: queries[key] for key in keys[start:start + _IMPORT_BATCH_SIZE]}
        with connector(database_url) as connection:
            connection.execute(_IMPORT_ENTRIES_SQL, (Jsonb(batch),))
        _LOGGER.info("Cover provider cache import progress imported=%d of %d", start + len(batch), total)
    with connector(database_url) as connection:
        connection.execute(
            "insert into library.cover_provider_cache_imports (source, entry_count) values (%s, %s)"
            " on conflict (source) do nothing",
            (_IMPORT_SOURCE, total),
        )
    _LOGGER.info("Cover provider cache import finished entries=%d", total)
    return {"status": "imported", "total": total}


_MUSICBRAINZ_RELEASE_DISK_CACHE = CoverSearchCache(Config.ALBUM_HAVEN_APP_DATABASE_URL)


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
