from __future__ import annotations

from music_app.services.utils import safe_int

_PROGRESS_STATES = {"not_started", "active", "completed"}
_FOLLOW_UP_STATES = {"none", "needs_rating", "needs_relisten_clear"}


def default_album_preference_overlay() -> dict[str, object]:
    return {
        "rating": None,
        "favorite_override": None,
        "is_favorite": False,
        "favorite_source": None,
        "can_edit": False,
        "to_listen": False,
        "is_relisten": False,
        "can_toggle_to_listen": False,
    }


def apply_album_preference_overlay(
    album_payload: dict[str, object],
    overlay: dict[str, object],
    *,
    ensure_gallery_summary: bool = False,
) -> None:
    album_payload["album_preference"] = overlay
    gallery_list_block = album_payload.get("gallery_list_block")
    if not isinstance(gallery_list_block, dict):
        if ensure_gallery_summary:
            album_payload["gallery_list_block"] = {
                "summary": {
                    "album_preference": dict(overlay),
                },
            }
        return
    summary = gallery_list_block.get("summary")
    if isinstance(summary, dict):
        summary["album_preference"] = dict(overlay)
    elif ensure_gallery_summary:
        gallery_list_block["summary"] = {
            "album_preference": dict(overlay),
        }


def normalize_album_preference_overlay(value: object) -> dict[str, object]:
    overlay = default_album_preference_overlay()
    if not isinstance(value, dict):
        return overlay

    overlay["rating"] = safe_int(value.get("rating"))
    favorite_override = value.get("favorite_override")
    overlay["favorite_override"] = favorite_override if favorite_override is not None else None
    overlay["is_favorite"] = bool(value.get("is_favorite"))
    favorite_source = value.get("favorite_source")
    overlay["favorite_source"] = favorite_source if favorite_source is not None else None
    overlay["can_edit"] = bool(value.get("can_edit"))
    overlay["to_listen"] = bool(value.get("to_listen"))
    overlay["is_relisten"] = bool(value.get("is_relisten"))
    overlay["can_toggle_to_listen"] = bool(value.get("can_toggle_to_listen"))
    return overlay


def default_top_viewer_overlay() -> dict[str, object]:
    return {
        "item_progress": {
            "effective_baseline_at": None,
            "baseline_rating": None,
            "progress_state": "not_started",
            "follow_up_state": "none",
        },
        "viewer_filters": {
            "hide_rated_albums": False,
            "hide_listened_albums": False,
            "action_needed_focus": False,
        },
        "can_edit_viewer_filters": False,
    }


def normalize_top_viewer_overlay(value: object) -> dict[str, object]:
    overlay = default_top_viewer_overlay()
    if not isinstance(value, dict):
        return overlay

    item_progress = value.get("item_progress")
    if isinstance(item_progress, dict):
        effective_baseline_at = str(item_progress.get("effective_baseline_at") or "").strip()
        overlay["item_progress"]["effective_baseline_at"] = effective_baseline_at or None
        overlay["item_progress"]["baseline_rating"] = safe_int(item_progress.get("baseline_rating"))
        progress_state = str(item_progress.get("progress_state") or "").strip().casefold()
        if progress_state in _PROGRESS_STATES:
            overlay["item_progress"]["progress_state"] = progress_state
        follow_up_state = str(item_progress.get("follow_up_state") or "").strip().casefold()
        if follow_up_state in _FOLLOW_UP_STATES:
            overlay["item_progress"]["follow_up_state"] = follow_up_state

    viewer_filters = value.get("viewer_filters")
    if isinstance(viewer_filters, dict):
        overlay["viewer_filters"]["hide_rated_albums"] = bool(viewer_filters.get("hide_rated_albums"))
        overlay["viewer_filters"]["hide_listened_albums"] = bool(viewer_filters.get("hide_listened_albums"))
        overlay["viewer_filters"]["action_needed_focus"] = bool(viewer_filters.get("action_needed_focus"))

    overlay["can_edit_viewer_filters"] = bool(value.get("can_edit_viewer_filters"))
    return overlay


def _top_item_app_rating(album_payload: dict[str, object]) -> int | None:
    return safe_int(normalize_album_preference_overlay(album_payload.get("album_preference")).get("rating"))


def _top_item_progress(album_payload: dict[str, object]) -> dict[str, object]:
    return normalize_top_viewer_overlay(album_payload.get("top_viewer_overlay")).get("item_progress", {})


def _top_item_viewer_filters(album_payload: dict[str, object]) -> dict[str, object]:
    return normalize_top_viewer_overlay(album_payload.get("top_viewer_overlay")).get("viewer_filters", {})


def _top_item_is_action_needed(album_payload: dict[str, object]) -> bool:
    progress = _top_item_progress(album_payload)
    progress_state = str(progress.get("progress_state") or "").strip().casefold()
    follow_up_state = str(progress.get("follow_up_state") or "").strip().casefold()
    return progress_state == "active" and follow_up_state in {"needs_rating", "needs_relisten_clear"}


def album_top_item_visible_for_viewer(album_payload: dict[str, object]) -> bool:
    viewer_filters = _top_item_viewer_filters(album_payload)
    action_needed_focus = bool(viewer_filters.get("action_needed_focus"))
    is_action_needed = _top_item_is_action_needed(album_payload)
    if action_needed_focus and not is_action_needed:
        return False

    if bool(viewer_filters.get("hide_rated_albums")) and _top_item_app_rating(album_payload) is not None:
        if not is_action_needed:
            return False

    if bool(viewer_filters.get("hide_listened_albums")):
        progress_state = str(_top_item_progress(album_payload).get("progress_state") or "").strip().casefold()
        if progress_state == "completed":
            return False

    return True


def filter_album_top_items_for_viewer(album_payloads: list[dict[str, object]]) -> list[dict[str, object]]:
    return [
        album_payload
        for album_payload in album_payloads
        if isinstance(album_payload, dict) and album_top_item_visible_for_viewer(album_payload)
    ]
