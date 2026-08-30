from music_app.services.shell_layout_seams import build_shell_layout_payload


def test_build_shell_layout_payload_exposes_future_contextual_pane_contract_for_local_tree():
    payload = build_shell_layout_payload(
        active_surface="albums",
        local_tree_submode="artists",
    )

    assert payload["kind"] == "shared_media_shell"
    assert payload["slots"]["contextual_pane"] == {
        "content_kind": "contextual_navigation",
        "is_visible": False,
        "active_pane": "local_tree",
        "supported_panes": [
            "local_tree",
            "playlists",
            "album_tops",
            "artist_gallery",
        ],
        "local_tree": {
            "default_submode": "folders",
            "active_submode": "artists",
            "supported_submodes": [
                "folders",
                "artists",
                "albums",
                "broad_genres",
                "subtle_genres",
            ],
        },
        "splitter": {
            "desktop_only": True,
            "axis": "inline",
            "placement": "left",
            "state_scope": "local_first",
            "mobile_fallback": "drawer",
        },
    }


def test_build_shell_layout_payload_switches_contextual_pane_without_new_top_level_surfaces():
    playlist_payload = build_shell_layout_payload(active_surface="playlists")
    selected_artist_payload = build_shell_layout_payload(
        active_surface="albums",
        selected_artist="Broadcast",
        local_tree_submode="subtle_genres",
    )

    assert playlist_payload["slots"]["contextual_pane"]["active_pane"] == "playlists"
    assert playlist_payload["slots"]["contextual_pane"]["local_tree"]["active_submode"] == "folders"
    assert selected_artist_payload["slots"]["contextual_pane"]["active_pane"] == "artist_gallery"
    assert selected_artist_payload["slots"]["contextual_pane"]["local_tree"]["active_submode"] == "subtle_genres"


def test_build_shell_layout_payload_keeps_notifications_and_discovery_center_separate():
    payload = build_shell_layout_payload(active_surface="home")

    assert payload["slots"]["app_bar"]["header_surfaces"] == {
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
    assert payload["slots"]["info_drawer"]["surface_family"] == "notifications"


def test_build_shell_layout_payload_exposes_generic_notification_drawer_contract():
    payload = build_shell_layout_payload(active_surface="home")

    assert payload["slots"]["app_bar"]["header_surfaces"]["notifications"] == {
        "entry_kind": "operational_drawer",
        "badge_kind": "operational_notifications",
        "drawer_slot": "info_drawer",
        "default_drawer_content_kind": "cover_lookup_drawer",
        "supported_drawer_content_kinds": ["cover_lookup_drawer"],
        "drawer_content_kind": "cover_lookup_drawer",
        "page_route": None,
    }
    assert payload["slots"]["info_drawer"] == {
        "component_kind": "notification_drawer",
        "content_kind": "cover_lookup_drawer",
        "default_content_kind": "cover_lookup_drawer",
        "supported_content_kinds": ["cover_lookup_drawer"],
        "surface_family": "notifications",
        "default_surface_family": "notifications",
        "placement": "right",
        "is_optional": True,
        "splitter": {
            "desktop_only": True,
            "axis": "inline",
            "placement": "right",
            "state_scope": "local_first",
            "mobile_fallback": "sheet_or_drawer",
        },
    }


def test_build_shell_layout_payload_limits_splitter_prep_to_key_desktop_panes():
    payload = build_shell_layout_payload(active_surface="albums")

    assert payload["slots"]["contextual_pane"]["splitter"] == {
        "desktop_only": True,
        "axis": "inline",
        "placement": "left",
        "state_scope": "local_first",
        "mobile_fallback": "drawer",
    }
    assert payload["slots"]["info_drawer"]["splitter"] == {
        "desktop_only": True,
        "axis": "inline",
        "placement": "right",
        "state_scope": "local_first",
        "mobile_fallback": "sheet_or_drawer",
    }
    assert "splitter" not in payload["slots"]["app_bar"]
    assert "splitter" not in payload["slots"]["navigation_rail"]
    assert "splitter" not in payload["slots"]["main_content"]
    assert "splitter" not in payload["slots"]["bottom_player"]
