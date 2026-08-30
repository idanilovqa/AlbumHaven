from __future__ import annotations

from music_app.services.library import album_to_dict, strip_private_album_preference_overlays
from music_app.services.metadata import normalize_exception_value
from music_app.services.non_album_view_payloads import (
    build_non_album_album_groups,
    has_meaningful_album_name,
    is_loose_track_album_value,
)
from music_app.services.opinion_read_seams import resolve_viewer_opinion_preferences
from music_app.services.track_stats import (
    build_scrobbled_play_count_lookup,
    normalize_track_ref,
)
from music_app.services.track_rows import build_album_gallery_list_block, build_track_rows
from music_app.services.track_preferences import (
    build_track_preference_overlay_lookup,
    normalize_track_preference_overlay,
)


def _attach_album_detail_track_rows(
    album_payload: dict[str, object],
    *,
    public_safe: bool = False,
    client_surface_class: object = None,
    config: object = None,
    viewer_opinion_preferences: object = None,
) -> dict[str, object]:
    tracks = list(album_payload.get("tracks") or [])
    viewer_opinion_preferences = resolve_viewer_opinion_preferences(viewer_opinion_preferences)
    resolved_config = config
    prehydrated_track_rows = bool(tracks) and all(
        isinstance(track, dict)
        and "track_scrobble_count" in track
        and "track_preference_overlay" in track
        for track in tracks
    )
    if resolved_config is not None:
        track_refs = [
            track.get("path") if isinstance(track, dict) else getattr(track, "path", "")
            for track in tracks
        ]
        scrobble_count_lookup = _safe_scrobble_count_lookup(
            resolved_config,
            track_refs,
        )
        track_preference_lookup = build_track_preference_overlay_lookup(
            resolved_config,
            client_surface_class=client_surface_class,
            track_refs=track_refs,
        )
    elif prehydrated_track_rows:
        scrobble_count_lookup = {
            normalize_track_ref(track.get("path")): int(track.get("track_scrobble_count") or 0)
            for track in tracks
            if isinstance(track, dict) and normalize_track_ref(track.get("path"))
        }
        track_preference_lookup = {
            normalize_track_ref(track.get("path")): normalize_track_preference_overlay(
                {
                    **dict(track.get("track_preference_overlay") or {}),
                    "allowed_actions": {
                        "client_surface_class": client_surface_class,
                        "can_rate": True,
                        "can_set_love_tier": True,
                    },
                },
                client_surface_class=client_surface_class,
            )
            for track in tracks
            if isinstance(track, dict)
            and normalize_track_ref(track.get("path"))
        }
    else:
        scrobble_count_lookup = {}
        track_preference_lookup = {}

    track_rows = build_track_rows(
        tracks,
        album=album_payload,
        scrobble_count_resolver=lambda track: scrobble_count_lookup.get(
            normalize_track_ref(track.get("path") if isinstance(track, dict) else getattr(track, "path", "")),
            0,
        ),
        track_preference_resolver=lambda track: track_preference_lookup.get(
            normalize_track_ref(track.get("path") if isinstance(track, dict) else getattr(track, "path", "")),
        ),
        client_surface_class=client_surface_class,
        viewer_opinion_preferences=viewer_opinion_preferences,
    )
    album_payload["track_rows"] = track_rows
    album_payload["gallery_list_block"] = build_album_gallery_list_block(
        album_key=album_payload.get("key"),
        album_name=album_payload.get("name"),
        album_artist=album_payload.get("album_artist"),
        album_year=album_payload.get("year"),
        album_rating=album_payload.get("album_rating", 0),
        total_duration_seconds=album_payload.get("total_duration_seconds"),
        track_count=len(track_rows),
        track_rows=track_rows,
        track_rows_source="inline",
        album_preference=album_payload.get("album_preference"),
        tag_album_rating=album_payload.get("tag_album_rating"),
        tag_album_rating_source=album_payload.get("tag_album_rating_source"),
    )
    summary = album_payload["gallery_list_block"].setdefault("summary", {})
    summary["crowd_opinion"] = album_payload.get("crowd_opinion", {
        "is_visible": False,
        "blended_score_10": None,
        "display_stars": None,
        "source_count_used": None,
        "source_count_total": None,
        "freshness_state": "missing",
    })
    summary["friends_opinion"] = album_payload.get("friends_opinion", {
        "is_visible": False,
        "average_rating": None,
        "rating_count": None,
        "freshness_state": "missing",
    })
    summary["album_popularity"] = album_payload.get("album_popularity", {
        "is_visible": False,
        "scrobble_count": None,
        "listener_count": None,
        "matched_track_count": None,
        "total_track_count": None,
        "available_sort_metrics": [],
        "freshness_state": "missing",
    })
    if public_safe:
        return strip_private_album_preference_overlays(album_payload)
    return album_payload


def _safe_scrobble_count_lookup(
    config: dict[str, object],
    track_refs: list[object],
) -> dict[str, int]:
    try:
        return build_scrobbled_play_count_lookup(
            config,
            track_refs,
        )
    except Exception:
        return {}


def _attach_shared_track_rows(
    album_payload: dict[str, object],
    *,
    public_safe: bool = False,
    client_surface_class: object = None,
    config: object = None,
    viewer_opinion_preferences: object = None,
) -> dict[str, object]:
    return _attach_album_detail_track_rows(
        album_payload,
        public_safe=public_safe,
        client_surface_class=client_surface_class,
        config=config,
        viewer_opinion_preferences=viewer_opinion_preferences,
    )


def _build_non_album_detail_payload(
    album_key: str,
    *,
    public_safe: bool = False,
    client_surface_class: object = None,
    config: object = None,
    library_state: dict[str, object] | None = None,
    viewer_opinion_preferences: object = None,
) -> dict[str, object] | None:
    if not album_key.startswith("non-album::"):
        return None

    if library_state is None:
        raise ValueError("library_state is required")

    st = library_state
    file_cache = st.get("file_cache", {}) or {}
    non_album_entries: list[dict[str, object]] = []
    for entry in file_cache.values():
        if not isinstance(entry, dict):
            continue
        exception_type = normalize_exception_value(entry.get("exception_type"))
        if (
            not exception_type
            and has_meaningful_album_name(entry.get("album"))
            and not is_loose_track_album_value(entry.get("album"))
        ):
            continue
        normalized_entry = dict(entry)
        normalized_entry["exception_type"] = exception_type
        non_album_entries.append(normalized_entry)

    for group in build_non_album_album_groups(non_album_entries):
        for album in list(group.get("albums") or []):
            if str(album.get("key") or "").strip() == album_key:
                return _attach_shared_track_rows(
                    dict(album),
                    public_safe=public_safe,
                    client_surface_class=client_surface_class,
                    config=config,
                    viewer_opinion_preferences=viewer_opinion_preferences,
                )
    return None


def build_album_detail_payload(
    album_key: str,
    *,
    public_safe: bool = False,
    client_surface_class: object = None,
    config: object = None,
    library_state: dict[str, object] | None = None,
) -> dict[str, object] | None:
    normalized_album_key = str(album_key or "").strip()
    if not normalized_album_key:
        return None

    if library_state is None:
        raise ValueError("library_state is required")

    st = library_state
    viewer_opinion_preferences = resolve_viewer_opinion_preferences(st.get("viewer_opinion_preferences", {}))
    for album in list(st.get("albums", []) or []):
        if str(getattr(album, "key", "") or "").strip() == normalized_album_key:
            return _attach_album_detail_track_rows(
                album_to_dict(
                    album,
                    public_safe=public_safe,
                    client_surface_class=client_surface_class,
                    config=config,
                    viewer_opinion_preferences=viewer_opinion_preferences,
                ),
                public_safe=public_safe,
                client_surface_class=client_surface_class,
                config=config,
                viewer_opinion_preferences=viewer_opinion_preferences,
            )

    return _build_non_album_detail_payload(
        normalized_album_key,
        public_safe=public_safe,
        client_surface_class=client_surface_class,
        config=config,
        library_state=st,
        viewer_opinion_preferences=viewer_opinion_preferences,
    )
