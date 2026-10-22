from __future__ import annotations

from music_app.services.utils import safe_int
from music_app.services.album_preferences import (
    AlbumPreferenceError, serialize_own_album_preference, validated_progress_fields,
)

_PROGRESS_STATES = {"not_started", "active", "completed"}
_FOLLOW_UP_STATES = {"none", "needs_rating", "needs_relisten_clear"}


def default_album_preference_overlay() -> dict[str, object]:
    # Generic/legacy producer defaults are not actor taste or progress evidence.
    return {
        "album_ref": None,
        "context_ref": None,
        "rating": None,
        "favorite_override": None,
        "is_favorite": None,
        "favorite_source": None,
        "taste_state": "unavailable",
        "preference_revision": None,
        "can_edit": False,
        "allowed_actions": {"can_manage_album_preferences": False},
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


def normalize_album_preference_overlay(value: object, *, verified_progress=None) -> dict[str, object]:
    """Normalize exact wire taste without promoting legacy defaults to facts.

    Progress must be supplied separately after producer/actor/library/generation/
    context verification. Mere presence in value is deliberately insufficient.
    This is shape normalization, not an authorization or context-binding check.
    """
    overlay = default_album_preference_overlay()
    progress = validated_progress_fields(verified_progress)
    overlay.update(progress)
    if not isinstance(value, dict):
        return overlay
    context_ref = value.get("context_ref")
    if isinstance(context_ref, str) and context_ref:
        overlay["context_ref"] = context_ref
    if value.get("taste_state") != "available":
        return overlay
    from music_app.services.album_preferences import parse_album_preference_command
    ref = value.get("album_ref")
    try:
        if not isinstance(ref, str) or len(ref) > 80:
            return overlay
        parts = ref.split(":")
        if len(parts) != 3:
            return overlay
        library_id = int(parts[1])
        command = parse_album_preference_command({
            "album_ref": ref, "expected_revision": value.get("preference_revision"),
            "patch": {"rating": value.get("rating")},
        }, library_id=library_id)
        actions = value.get("allowed_actions")
        editable = value.get("can_edit")
        if (type(editable) is not bool or not isinstance(actions, dict)
                or set(actions) != {"can_manage_album_preferences"}
                or actions["can_manage_album_preferences"] is not editable):
            return overlay
        return serialize_own_album_preference({
            "album_id": command.album_id, "library_id": library_id,
            "rating": value.get("rating"), "favorite": value.get("is_favorite"),
            "favorite_override": value.get("favorite_override"),
            "favorite_source": value.get("favorite_source"),
            "preference_revision": command.expected_revision, "taste_state": "available",
        }, library_id=library_id, context_ref=context_ref, can_edit=editable,
            verified_progress=progress)
    except (AlbumPreferenceError, ValueError, TypeError):
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
