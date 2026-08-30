from __future__ import annotations

from collections.abc import Iterable

from music_app.services.private_track_rows import build_private_track_row_read
from music_app.services.private_track_search import build_private_track_search_contract
from music_app.services.source_helpers import field_from_source
from music_app.services.track_preferences import strip_private_track_rows
from music_app.services.view_search import normalize_search_text


_field = field_from_source
_IMPLEMENTED_VIEW_SURFACES = ("home", "albums", "playlists")
_RESERVED_VIEW_SURFACES = ("album_tops",)
_DEFAULT_VIEW_SURFACE = "home"
_DEFAULT_BROWSE_VIEW_SURFACE = "albums"
_DEFAULT_PLAYLIST_ALLOWED_ACTIONS = {
    "can_open": True,
    "can_play": False,
    "can_edit": False,
    "can_rename": False,
    "can_delete": False,
    "can_reorder": False,
}


def resolve_active_view_surface(value: object = None) -> str:
    normalized = str(value or "").strip().casefold()
    if normalized in _IMPLEMENTED_VIEW_SURFACES:
        return normalized
    return _DEFAULT_BROWSE_VIEW_SURFACE


def build_view_surface_payload(active_surface: str) -> dict[str, object]:
    return {
        "active": resolve_active_view_surface(active_surface),
        "default": _DEFAULT_VIEW_SURFACE,
        "supported": list(_IMPLEMENTED_VIEW_SURFACES),
        "reserved": list(_RESERVED_VIEW_SURFACES),
    }


def _playlist_id(playlist: object) -> str:
    return str(
        _field(playlist, "playlist_id", _field(playlist, "id", ""))
        or ""
    ).strip()


def _playlist_title(playlist: object) -> str:
    return str(_field(playlist, "title", _field(playlist, "name", "")) or "").strip()


def _playlist_description(playlist: object) -> str:
    return str(_field(playlist, "description", "") or "").strip()


def _playlist_visibility(playlist: object) -> str:
    return str(_field(playlist, "visibility", "private") or "private").strip()


def _playlist_tracks(playlist: object) -> list[object]:
    tracks = _field(playlist, "tracks", [])
    if isinstance(tracks, list):
        return list(tracks)
    return list(tracks or [])


def _playlist_allowed_actions(playlist: object) -> dict[str, bool]:
    source = _field(playlist, "allowed_actions", {})
    actions = source if isinstance(source, dict) else {}
    normalized_actions = {
        key: bool(actions.get(key, default))
        for key, default in _DEFAULT_PLAYLIST_ALLOWED_ACTIONS.items()
    }
    if not _playlist_id(playlist):
        normalized_actions["can_open"] = False
    return normalized_actions


def _matches_playlist_query(playlist: object, normalized_query: str) -> bool:
    if not normalized_query:
        return True
    return normalized_query in normalize_search_text(_playlist_title(playlist))


def _tracks_have_explicit_scrobble_counts(tracks: Iterable[object]) -> bool:
    return any(_field(track, "track_scrobble_count", None) is not None for track in tracks or [])


def _quote_track_filter_value(value: object) -> str:
    text = " ".join(str(value or "").strip().split())
    if not text:
        return ""
    escaped = text.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _append_filter_tokens(tokens: list[str], field_name: str, values: object) -> None:
    if not isinstance(values, list):
        return
    for value in values:
        quoted_value = _quote_track_filter_value(value)
        if quoted_value:
            tokens.append(f"{field_name}:{quoted_value}")


def _build_playlist_track_query(
    query: object,
    *,
    search_filters: dict[str, object] | None = None,
) -> str:
    tokens: list[str] = []
    normalized_query = " ".join(str(query or "").strip().split())
    if normalized_query:
        tokens.append(normalized_query)

    filters = search_filters if isinstance(search_filters, dict) else {}
    _append_filter_tokens(tokens, "genre", filters.get("genre"))
    _append_filter_tokens(tokens, "mood", filters.get("mood"))
    _append_filter_tokens(tokens, "style", filters.get("style"))

    duration_filters = filters.get("duration")
    if isinstance(duration_filters, dict):
        min_seconds = duration_filters.get("min_seconds")
        max_seconds = duration_filters.get("max_seconds")
        if isinstance(min_seconds, int):
            tokens.append(f"duration:>={min_seconds}s")
        if isinstance(max_seconds, int):
            tokens.append(f"duration:<={max_seconds}s")

    return " ".join(token for token in tokens if token)


def _strip_public_playlist_track_rows(
    track_rows: object,
    *,
    client_surface_class: object = None,
) -> list[dict[str, object]]:
    sanitized_rows = strip_private_track_rows(
        track_rows,
        client_surface_class=client_surface_class,
    )
    for sanitized_row in sanitized_rows:
        sanitized_row.pop("track_ref", None)
        sanitized_row.pop("path", None)
        sanitized_row["track_stats"] = {"scrobble_count": None}
        sanitized_row["playback_state"] = None
    return sanitized_rows


def build_playlist_surface_payload(
    playlists: Iterable[object],
    *,
    requested_playlist_id: object = None,
    query: object = None,
    search_filters: dict[str, object] | None = None,
    authorized_private: bool,
    config: dict[str, object] | None = None,
    client_surface_class: object = None,
) -> dict[str, object]:
    ordered_playlists = [playlist for playlist in playlists or [] if _playlist_id(playlist)]
    active_playlist_id = str(requested_playlist_id or "").strip()
    normalized_query = normalize_search_text(query)

    playlist_sidebar_items = [
        {
            "playlist_id": _playlist_id(playlist),
            "title": _playlist_title(playlist),
            "item_count": len(_playlist_tracks(playlist)),
            "is_active": _playlist_id(playlist) == active_playlist_id,
            "allowed_actions": {
                "can_open": _playlist_allowed_actions(playlist)["can_open"],
            },
        }
        for playlist in ordered_playlists
    ]

    payload: dict[str, object] = {
        "playlist_sidebar": {
            "active_playlist_id": active_playlist_id,
            "items": playlist_sidebar_items,
        },
    }

    selected_playlist = next(
        (playlist for playlist in ordered_playlists if _playlist_id(playlist) == active_playlist_id),
        None,
    )
    if selected_playlist is None:
        filtered_playlists = [
            playlist for playlist in ordered_playlists if _matches_playlist_query(playlist, normalized_query)
        ]
        payload["playlist_index"] = {
            "query": str(query or "").strip(),
            "playlists": [
                {
                    "allowed_actions": {
                        "can_open": _playlist_allowed_actions(playlist)["can_open"],
                        "can_play": _playlist_allowed_actions(playlist)["can_play"],
                        "can_edit": _playlist_allowed_actions(playlist)["can_edit"],
                    },
                    "playlist_id": _playlist_id(playlist),
                    "title": _playlist_title(playlist),
                    "description": _playlist_description(playlist),
                    "visibility": _playlist_visibility(playlist),
                    "item_count": len(_playlist_tracks(playlist)),
                }
                for playlist in filtered_playlists
            ],
        }
        return payload

    private_track_read = build_private_track_row_read(
        _playlist_tracks(selected_playlist),
        query=_build_playlist_track_query(query, search_filters=search_filters),
        surface="playlist_detail",
        authorized_private=authorized_private,
        config=None if _tracks_have_explicit_scrobble_counts(_playlist_tracks(selected_playlist)) else config,
        client_surface_class=client_surface_class,
    )
    track_rows = list(private_track_read["track_rows"])
    if not authorized_private:
        track_rows = _strip_public_playlist_track_rows(
            track_rows,
            client_surface_class=client_surface_class,
        )
    selected_playlist_actions = _playlist_allowed_actions(selected_playlist)
    payload["playlist_detail"] = {
        "playlist_id": _playlist_id(selected_playlist),
        "title": _playlist_title(selected_playlist),
        "description": _playlist_description(selected_playlist),
        "visibility": _playlist_visibility(selected_playlist),
        "playlist_kind": str(_field(selected_playlist, "playlist_kind", "manual") or "manual"),
        "query": str(query or "").strip(),
        "search_query_contract": build_private_track_search_contract(),
        "unsupported_filters": list(private_track_read["unsupported_filters"]),
        "track_rows": track_rows,
        "active_sort": {
            "key": "playlist_position",
            "direction": "asc",
        },
        "saved_default_sort": {
            "key": "playlist_position",
            "direction": "asc",
        },
        "playback_mode": str(_field(selected_playlist, "playback_mode", "regular") or "regular"),
        "listen_to_suggestions_after_playlist": bool(
            _field(selected_playlist, "listen_to_suggestions_after_playlist", False)
        ),
        "allowed_actions": {
            "can_play": selected_playlist_actions["can_play"],
            "can_edit": selected_playlist_actions["can_edit"],
            "can_rename": selected_playlist_actions["can_rename"],
            "can_delete": selected_playlist_actions["can_delete"],
            "can_reorder": selected_playlist_actions["can_reorder"],
        },
    }
    return payload
