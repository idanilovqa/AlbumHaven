"""Keyed lookups into the published in-memory album list.

Publishers index the album list they publish, on their own (background)
thread, so a request that needs a few selected albums reads them by key or by
track path instead of walking every album in the library.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping

_INDEX_STATE_KEY = "_album_index"


def _field(album: object, name: str) -> object:
    return album.get(name) if isinstance(album, Mapping) else getattr(album, name, None)


class LibraryAlbumIndex:
    """Albums by key and by track path for one published album list."""

    __slots__ = ("albums", "_by_key", "_by_track_path", "_positions")

    def __init__(self, albums: list[object]):
        self.albums = albums
        self._by_key: dict[str, object] = {}
        self._by_track_path: dict[str, list[object]] = {}
        self._positions: dict[int, int] = {}
        for position, album in enumerate(albums):
            self._positions[id(album)] = position
            key = str(_field(album, "key") or "").strip()
            if key:
                # The first album with a key wins, as in the album-detail lookup.
                self._by_key.setdefault(key, album)
            for track in _field(album, "tracks") or ():
                path = str(_field(track, "path") or "")
                if path:
                    self._by_track_path.setdefault(path, []).append(album)

    def album(self, key: object) -> object | None:
        return self._by_key.get(str(key or "").strip())

    def albums_with_any_track(self, track_paths: Iterable[str]) -> list[object]:
        """Albums holding any of `track_paths`, in published order."""
        matches = {
            id(album): album
            for path in track_paths
            for album in self._by_track_path.get(str(path), ())
        }
        return sorted(matches.values(), key=lambda album: self._positions[id(album)])


def publish_library_albums(library_state: dict[str, object], albums: list[object]) -> None:
    """Publish `albums` together with its index."""
    library_state[_INDEX_STATE_KEY] = LibraryAlbumIndex(albums)
    library_state["albums"] = albums


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
