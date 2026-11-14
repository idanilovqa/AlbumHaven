"""Opaque cover references: the only names for local cover images that leave the server.

A reference names one image file of one library (`library.cover_references`). It is minted the
first time the server names that file and stays the same while the file keeps its path, across
restarts, rescans and database copies. `cover` references may be opened by anyone who may see the
library's artwork; `candidate` references (other images in an album folder, shown only in cover
lookup) also need `library.covers.lookup`. A candidate that becomes a cover widens to `cover`;
a kind never narrows.
"""

from __future__ import annotations

from collections import OrderedDict
from collections.abc import Iterable, Mapping
import re
import threading

from music_app.services.postgres_connections import pooled_connection

COVER = "cover"
CANDIDATE = "candidate"
REFERENCE_PATTERN = re.compile(r"[A-Za-z0-9_-]{22}")
_WORKLOAD = "cover-references"
_CACHE_SIZE = 50_000


def _widens(current_kind: str, wanted_kind: str) -> bool:
    return current_kind == CANDIDATE and wanted_kind == COVER


class CoverReferenceStore:
    """Path <-> reference for one deployment; Postgres is the authority, the maps are caches."""

    def __init__(self, config: Mapping[str, object], *, connect=pooled_connection, cache_size: int = _CACHE_SIZE):
        self._database_url = str(config.get("ALBUM_HAVEN_APP_DATABASE_URL") or "")
        # Browse-only instances on a shared database never write; they name only stored covers.
        self._writable = config.get("SHARED_LIBRARY_BROWSE_ONLY") is not True
        self._connect = connect
        self._cache_size = cache_size
        self._by_path: OrderedDict[tuple[int, str], tuple[str, str]] = OrderedDict()
        self._by_reference: OrderedDict[str, tuple[int, str, str]] = OrderedDict()
        self._lock = threading.Lock()

    def references_for(self, library_id: int, wanted: Mapping[str, str]) -> dict[str, str]:
        """References for `{path: kind}`, minting missing ones; absent only on a browse-only miss."""
        found: dict[str, str] = {}
        missing: dict[str, str] = {}
        with self._lock:
            for path, kind in wanted.items():
                hit = self._by_path.get((library_id, path))
                if hit is None or _widens(hit[1], kind):
                    missing[path] = kind
                else:
                    self._by_path.move_to_end((library_id, path))
                    found[path] = hit[0]
        if missing:
            for path, reference, kind in self._load_or_register(library_id, missing):
                self._remember(library_id, path, reference, kind)
                found[path] = reference
        return found

    def resolve(self, library_id: int, reference: str, *, refresh: bool = False) -> tuple[str, str] | None:
        """`(path, kind)` for a reference of this library, or None."""
        if not REFERENCE_PATTERN.fullmatch(reference or ""):
            return None
        if not refresh:
            with self._lock:
                hit = self._by_reference.get(reference)
                if hit is not None:
                    self._by_reference.move_to_end(reference)
                    return (hit[1], hit[2]) if hit[0] == library_id else None
        with self._connect(self._database_url, workload=_WORKLOAD) as connection:
            row = connection.execute(
                "select library_id, private_path, kind from library.cover_references where reference = %s",
                (reference,),
            ).fetchone()
        if row is None:
            return None
        self._remember(int(row["library_id"]), row["private_path"], reference, row["kind"])
        return (row["private_path"], row["kind"]) if int(row["library_id"]) == library_id else None

    def paths_for(self, library_id: int, references: Iterable[str]) -> dict[str, str]:
        """`{reference: path}` for those of this library; unknown or foreign ones are left out."""
        resolved = {}
        for reference in set(references):
            hit = self.resolve(library_id, reference)
            if hit is not None:
                resolved[reference] = hit[0]
        return resolved

    def _load_or_register(self, library_id: int, wanted: Mapping[str, str]) -> list[tuple[str, str, str]]:
        paths = list(wanted)
        with self._connect(self._database_url, workload=_WORKLOAD) as connection:
            if self._writable:
                connection.execute(
                    """insert into library.cover_references (library_id, private_path, kind)
                       select %s, wanted.path, wanted.kind
                       from unnest(%s::text[], %s::text[]) as wanted (path, kind)
                       on conflict (library_id, private_path) do update set kind = 'cover'
                       where library.cover_references.kind = 'candidate' and excluded.kind = 'cover'""",
                    (library_id, paths, [wanted[path] for path in paths]),
                )
            rows = connection.execute(
                """select private_path, reference, kind from library.cover_references
                   where library_id = %s and private_path = any(%s::text[])""",
                (library_id, paths),
            ).fetchall()
        return [(row["private_path"], row["reference"], row["kind"]) for row in rows]

    def _remember(self, library_id: int, path: str, reference: str, kind: str) -> None:
        with self._lock:
            self._by_path[(library_id, path)] = (reference, kind)
            self._by_path.move_to_end((library_id, path))
            self._by_reference[reference] = (library_id, path, kind)
            self._by_reference.move_to_end(reference)
            for cache in (self._by_path, self._by_reference):
                while len(cache) > self._cache_size:
                    cache.popitem(last=False)

    def is_named_cover(self, library_id: int, path: str) -> bool:
        """Whether this library already names `path` as a cover; never mints (legacy `/cover?path=`)."""
        with self._lock:
            hit = self._by_path.get((library_id, path))
        if hit is not None and hit[1] == COVER:
            return True
        with self._connect(self._database_url, workload=_WORKLOAD) as connection:
            row = connection.execute(
                """select reference, kind from library.cover_references
                   where library_id = %s and private_path = %s""",
                (library_id, path),
            ).fetchone()
        if row is None:
            return False
        self._remember(library_id, path, row["reference"], row["kind"])
        return row["kind"] == COVER
