"""Keyed lookups into the published in-memory album list.

Publishers index the album list they publish, on their own (background)
thread, so a request that needs a few selected albums reads them by key or by
track path instead of walking every album in the library. A request that
rebuilds a few albums republishes the list through `replace_library_albums`,
which derives the new index from the current one instead of re-walking every
album.
"""

from __future__ import annotations

from bisect import bisect_left, bisect_right
from collections.abc import Callable, Iterable, Mapping

_INDEX_STATE_KEY = "_album_index"
_YEAR_KEY_SEPARATOR = "::year::"


def _field(album: object, name: str) -> object:
    return album.get(name) if isinstance(album, Mapping) else getattr(album, name, None)


def _album_key(album: object) -> str:
    return str(_field(album, "key") or "").strip()


def _release_key(album_key: str) -> str:
    """The release an album key belongs to: a per-year split of a separate
    release (`<release>::year::<year>`) belongs to `<release>`."""
    return album_key.split(_YEAR_KEY_SEPARATOR, 1)[0]


class LibraryAlbumIndex:
    """Albums by key, release key, and track path for one published list.

    Each album has a rank that increases along the list, so matches are
    returned in published order and a derived index keeps the old ranks.
    """

    __slots__ = ("albums", "_ranks", "_by_key", "_by_release_key", "_by_track_path")

    def __init__(self, albums: list[object]):
        self.albums = albums
        self._ranks: dict[int, float] = {}
        self._by_key: dict[str, list[object]] = {}
        self._by_release_key: dict[str, list[object]] = {}
        self._by_track_path: dict[str, list[object]] = {}
        for rank, album in enumerate(albums):
            self._ranks[id(album)] = float(rank)
            for mapping, lookup_keys in self._lookups(album):
                for lookup_key in lookup_keys:
                    mapping.setdefault(lookup_key, []).append(album)

    def _lookups(self, album: object) -> tuple[tuple[dict[str, list[object]], Iterable[str]], ...]:
        key = _album_key(album)
        paths = {str(_field(track, "path") or "") for track in _field(album, "tracks") or ()}
        paths.discard("")
        return (
            (self._by_key, (key,) if key else ()),
            (self._by_release_key, (_release_key(key),) if key else ()),
            (self._by_track_path, paths),
        )

    def _rank(self, album: object) -> float:
        return self._ranks[id(album)]

    def _in_list_order(self, albums: Iterable[object]) -> list[object]:
        return sorted({id(album): album for album in albums}.values(), key=self._rank)

    def album(self, key: object) -> object | None:
        # The first album with a key wins, as in the album-detail lookup.
        matches = self._by_key.get(str(key or "").strip())
        return matches[0] if matches else None

    def albums_with_keys(self, album_keys: Iterable[object]) -> list[object]:
        """Albums whose key is one of `album_keys`, in published order."""
        return self._in_list_order(
            album
            for key in {str(key or "").strip() for key in album_keys}
            for album in self._by_key.get(key, ())
        )

    def albums_with_any_track(self, track_paths: Iterable[str]) -> list[object]:
        """Albums holding any of `track_paths`, in published order."""
        return self._in_list_order(
            album for path in track_paths for album in self._by_track_path.get(str(path), ())
        )

    def albums_of_releases(self, album_keys: Iterable[str]) -> list[object]:
        """Albums whose key is one of `album_keys` or a per-year split of one,
        in published order."""
        wanted = {str(key) for key in album_keys if str(key)}
        return self._in_list_order(
            album
            for base_key in {_release_key(key) for key in wanted}
            for album in self._by_release_key.get(base_key, ())
            if any(
                _album_key(album) == key or _album_key(album).startswith(f"{key}{_YEAR_KEY_SEPARATOR}")
                for key in wanted
            )
        )

    def replaced(
        self,
        removed: Iterable[object],
        added: Iterable[object],
        *,
        sort_key: Callable[[object], object],
    ) -> LibraryAlbumIndex:
        """A new index over this list with `removed` taken out and `added`
        inserted where `sort_key` places them; only their entries change."""
        removed = [album for album in {id(album): album for album in removed}.values() if id(album) in self._ranks]
        added = sorted(added, key=sort_key)
        albums = self.albums
        cuts = sorted(bisect_left(albums, self._rank(album), key=self._rank) for album in removed)
        kept: list[object] = []
        start = 0
        for cut in cuts:
            kept += albums[start:cut]
            start = cut + 1
        kept += albums[start:]

        derived = object.__new__(LibraryAlbumIndex)
        derived._ranks = dict(self._ranks)
        for album in removed:
            del derived._ranks[id(album)]
        exhausted = False
        for album in added:
            at = bisect_right(kept, sort_key(album), key=sort_key)
            kept.insert(at, album)
            if exhausted:
                continue
            before = derived._ranks[id(kept[at - 1])] if at else None
            after = derived._ranks[id(kept[at + 1])] if at + 1 < len(kept) else None
            if before is None or after is None:
                rank = 0.0 if before is None and after is None else (after - 1.0 if before is None else before + 1.0)
            else:
                rank = (before + after) / 2
                # Ranks between these neighbours are exhausted: index afresh.
                exhausted = not before < rank < after
            derived._ranks[id(album)] = rank
        if exhausted:
            return LibraryAlbumIndex(kept)
        derived.albums = kept
        derived._by_key = dict(self._by_key)
        derived._by_release_key = dict(self._by_release_key)
        derived._by_track_path = dict(self._by_track_path)
        # Replace only the touched entries, never mutating lists this index shares.
        for album in removed:
            for mapping, lookup_keys in derived._lookups(album):
                for lookup_key in lookup_keys:
                    remaining = [other for other in mapping.get(lookup_key, ()) if other is not album]
                    if remaining:
                        mapping[lookup_key] = remaining
                    else:
                        mapping.pop(lookup_key, None)
        for album in added:
            for mapping, lookup_keys in derived._lookups(album):
                for lookup_key in lookup_keys:
                    mapping[lookup_key] = sorted((*mapping.get(lookup_key, ()), album), key=derived._rank)
        return derived


def publish_library_albums(library_state: dict[str, object], albums: list[object]) -> None:
    """Publish `albums` together with its index."""
    library_state[_INDEX_STATE_KEY] = LibraryAlbumIndex(albums)
    library_state["albums"] = albums


def replace_library_albums(
    library_state: dict[str, object],
    removed: Iterable[object],
    added: Iterable[object],
    *,
    sort_key: Callable[[object], object],
) -> None:
    """Republish the current list with `removed` replaced by `added`, deriving
    the index from the current one."""
    index = library_album_index(library_state).replaced(removed, added, sort_key=sort_key)
    library_state[_INDEX_STATE_KEY] = index
    library_state["albums"] = index.albums


def library_album_index(library_state: Mapping[str, object]) -> LibraryAlbumIndex:
    """The index of the currently published album list.

    Every library publisher indexes the list it publishes. A list assigned
    without `publish_library_albums` is indexed here once and the index kept,
    so later lookups stay keyed.
    """
    albums = library_state.get("albums")
    if not isinstance(albums, list):
        albums = []
    index = library_state.get(_INDEX_STATE_KEY)
    if isinstance(index, LibraryAlbumIndex) and index.albums is albums:
        return index
    index = LibraryAlbumIndex(albums)
    if isinstance(library_state, dict):
        library_state[_INDEX_STATE_KEY] = index
    return index
