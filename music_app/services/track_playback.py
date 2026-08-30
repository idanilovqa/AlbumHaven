from __future__ import annotations


def default_track_playback_state() -> dict[str, object]:
    return {
        "is_playing_here": False,
        "is_playing_elsewhere": False,
        "elsewhere_client_kind": None,
        "status_label": "",
        "can_start_here": True,
    }


def normalize_track_playback_state(playback_state: object = None) -> dict[str, object]:
    source = playback_state if isinstance(playback_state, dict) else {}
    default_state = default_track_playback_state()
    elsewhere_client_kind = source.get("elsewhere_client_kind")
    return {
        "is_playing_here": bool(source.get("is_playing_here")),
        "is_playing_elsewhere": bool(source.get("is_playing_elsewhere")),
        "elsewhere_client_kind": (
            str(elsewhere_client_kind).strip()
            if elsewhere_client_kind is not None and str(elsewhere_client_kind).strip()
            else None
        ),
        "status_label": str(source.get("status_label") or "").strip(),
        "can_start_here": bool(source.get("can_start_here", default_state["can_start_here"])),
    }


def track_playback_state_from_source(source: object) -> dict[str, object]:
    if isinstance(source, dict):
        playback_state = source.get("playback_state_overlay", source.get("playback_state"))
    else:
        playback_state = getattr(
            source,
            "playback_state_overlay",
            getattr(source, "playback_state", None),
        )
    return normalize_track_playback_state(playback_state)
