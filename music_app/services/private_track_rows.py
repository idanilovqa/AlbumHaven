from __future__ import annotations

from collections.abc import Iterable

from music_app.services.private_track_search import filter_private_track_sources
from music_app.services.track_rows import (
    build_favorite_song_track_rows,
    build_playlist_track_rows,
    build_track_rows,
)
from music_app.services.source_helpers import field_from_source
from music_app.services.track_stats import (
    build_scrobbled_play_count_lookup,
    normalize_track_ref,
)


_field = field_from_source


def _track_ref(source: object) -> str:
    return normalize_track_ref(_field(source, "path", ""))


def _build_scrobble_count_resolver(
    config: dict[str, object] | None,
    sources: Iterable[object],
):
    if config is None:
        return None
    track_refs = [_track_ref(source) for source in sources if _track_ref(source)]
    if not track_refs:
        return None
    scrobble_count_lookup = build_scrobbled_play_count_lookup(config, track_refs)
    return lambda track: scrobble_count_lookup.get(_track_ref(track), 0)


def build_private_track_row_read(
    sources: Iterable[object],
    *,
    query: object = None,
    surface: str,
    authorized_private: bool,
    config: dict[str, object] | None = None,
    client_surface_class: object = None,
) -> dict[str, object]:
    filtered = filter_private_track_sources(
        sources,
        query=query,
        surface=surface,
        authorized_private=authorized_private,
    )
    matched_sources = list(filtered["matched_sources"])
    scrobble_count_resolver = _build_scrobble_count_resolver(config, matched_sources)
    result_kind = str(filtered["result_kind"])
    if result_kind == "favorite_song_rows":
        track_rows = build_favorite_song_track_rows(
            matched_sources,
            scrobble_count_resolver=scrobble_count_resolver,
            client_surface_class=client_surface_class,
        )
    elif result_kind == "playlist_rows":
        track_rows = build_playlist_track_rows(
            matched_sources,
            scrobble_count_resolver=scrobble_count_resolver,
            client_surface_class=client_surface_class,
        )
    else:
        track_rows = build_track_rows(
            matched_sources,
            scrobble_count_resolver=scrobble_count_resolver,
            client_surface_class=client_surface_class,
        )
    return {
        "surface": filtered["surface"],
        "result_kind": result_kind,
        "query": filtered["query"],
        "unsupported_filters": list(filtered["unsupported_filters"]),
        "track_rows": track_rows,
    }
