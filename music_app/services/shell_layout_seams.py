from __future__ import annotations


_SUPPORTED_CONTEXTUAL_PANES = (
    "local_tree",
    "playlists",
    "album_tops",
    "artist_gallery",
)
_SUPPORTED_LOCAL_TREE_SUBMODES = (
    "folders",
    "artists",
    "albums",
    "broad_genres",
    "subtle_genres",
)


def _build_splitter_payload(*, placement: str, mobile_fallback: str) -> dict[str, object]:
    return {
        "desktop_only": True,
        "axis": "inline",
        "placement": placement,
        "state_scope": "local_first",
        "mobile_fallback": mobile_fallback,
    }


def _normalize_local_tree_submode(value: object) -> str:
    normalized = str(value or "").strip().casefold()
    if normalized in _SUPPORTED_LOCAL_TREE_SUBMODES:
        return normalized
    return "folders"


def build_shell_layout_payload(
    *,
    active_surface: object,
    selected_artist: object = None,
    has_playlist_detail: bool = False,
    local_tree_submode: object = None,
) -> dict[str, object]:
    normalized_surface = str(active_surface or "").strip().casefold() or "albums"
    has_selected_artist = bool(str(selected_artist or "").strip())
    resolved_local_tree_submode = _normalize_local_tree_submode(local_tree_submode)

    navigation_content_kind = (
        "playlist_sidebar"
        if normalized_surface == "playlists"
        else "artists_sidebar"
    )
    main_content_kind = "gallery"
    if normalized_surface == "playlists":
        main_content_kind = "playlist_detail" if has_playlist_detail else "playlist_index"
    active_contextual_pane = (
        "playlists"
        if normalized_surface == "playlists"
        else "artist_gallery"
        if has_selected_artist
        else "local_tree"
    )
    header_surfaces = {
        "shared_badge_primitives": True,
        "shared_drawer_primitives": True,
        "notifications": {
            "entry_kind": "operational_drawer",
            "badge_kind": "operational_notifications",
            "drawer_slot": "info_drawer",
            "default_drawer_content_kind": "cover_lookup_drawer",
            "supported_drawer_content_kinds": ["cover_lookup_drawer"],
            "drawer_content_kind": "cover_lookup_drawer",
            "page_route": None,
        },
        "discovery_center": {
            "entry_kind": "drawer_plus_page",
            "badge_kind": "discovery_center",
            "drawer_content_kind": "discovery_center_preview",
            "page_route": "/news",
        },
    }

    return {
        "kind": "shared_media_shell",
        "slots": {
            "app_bar": {
                "content_kind": "global_search_toolbar",
                "header_surfaces": header_surfaces,
            },
            "navigation_rail": {
                "content_kind": navigation_content_kind,
                "default_collapsed": True,
            },
            "contextual_pane": {
                "content_kind": "contextual_navigation",
                "is_visible": has_selected_artist and normalized_surface != "playlists",
                "active_pane": active_contextual_pane,
                "supported_panes": list(_SUPPORTED_CONTEXTUAL_PANES),
                "splitter": _build_splitter_payload(
                    placement="left",
                    mobile_fallback="drawer",
                ),
                "local_tree": {
                    "default_submode": "folders",
                    "active_submode": resolved_local_tree_submode,
                    "supported_submodes": list(_SUPPORTED_LOCAL_TREE_SUBMODES),
                },
            },
            "main_content": {
                "surface_ref": normalized_surface,
                "content_kind": main_content_kind,
            },
            "info_drawer": {
                "component_kind": "notification_drawer",
                "content_kind": "cover_lookup_drawer",
                "default_content_kind": "cover_lookup_drawer",
                "supported_content_kinds": ["cover_lookup_drawer"],
                "surface_family": "notifications",
                "default_surface_family": "notifications",
                "placement": "right",
                "is_optional": True,
                "splitter": _build_splitter_payload(
                    placement="right",
                    mobile_fallback="sheet_or_drawer",
                ),
            },
            "bottom_player": {
                "content_kind": "global_player",
                "is_persistent": True,
            },
        },
    }
