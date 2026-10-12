from __future__ import annotations

from collections.abc import Callable
from copy import deepcopy

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
    default_track_preference_overlay,
    track_preference_can_edit,
)


def _attach_album_detail_track_rows(
    album_payload: dict[str, object],
    *,
    public_safe: bool = False,
    client_surface_class: object = None,
    config: object = None,
    viewer_opinion_preferences: object = None,
    account_id: int | None = None,
    library_id: int | None = None,
    inventory_library_id: int | None = None,
    preference_action_resolver: Callable[[int], bool] | None = None,
) -> dict[str, object]:
    # album_to_dict and duplicate-source serializers can return shared caches.
    # No private lookup result or mutation may be written into those objects.
    album_payload = deepcopy(album_payload)
    containers = [album_payload]
    for container in containers:
        containers.extend(
            source for source in (container.get("duplicate_sources") or [])
            if isinstance(source, dict)
        )
    all_tracks = [
        track for container in containers for track in (container.get("tracks") or [])
        if isinstance(track, dict)
    ]
    track_refs = list(dict.fromkeys(
        normalize_track_ref(track.get("path")) for track in all_tracks
        if normalize_track_ref(track.get("path"))
    ))
    expected_track_ids = {}
    for track in all_tracks:
        if "track_id" in track:
            ref = normalize_track_ref(track.get("path"))
            value = track["track_id"]
            if ref in expected_track_ids and (
                type(expected_track_ids[ref]) is not int
                or type(value) is not int
                or expected_track_ids[ref] != value
            ):
                value = None  # Conflicting source IDs cannot confer identity.
            expected_track_ids[ref] = value
    viewer_opinion_preferences = resolve_viewer_opinion_preferences(viewer_opinion_preferences)
    track_preference_lookup = {}
    scrobble_count_lookup = {}
    if (
        not public_safe and config is not None
        and type(account_id) is int and account_id > 0
        and type(library_id) is int and library_id > 0
        and type(inventory_library_id) is int and inventory_library_id == library_id
    ):
        track_preference_lookup = build_track_preference_overlay_lookup(
            config, account_id=account_id, library_id=library_id,
            client_surface_class=client_surface_class, track_refs=track_refs,
            preference_action_resolver=preference_action_resolver,
            expected_track_ids=expected_track_ids, require_active_paths=True,
        )

        scrobble_count_lookup = _safe_scrobble_count_lookup(
            config, track_refs, account_id=account_id, library_id=library_id,
            expected_track_ids=expected_track_ids,
        )

    for track in all_tracks:
        ref = normalize_track_ref(track.get("path"))
        count = scrobble_count_lookup.get(ref)
        # Inventory caches never establish personal listening authority.
        track["track_scrobble_count"] = count
        track["track_stats"] = {"scrobble_count": count}
        if "scrobble_count" in track:
            track["scrobble_count"] = count
        overlay = deepcopy(track_preference_lookup.get(ref))
        if overlay is None:
            overlay = default_track_preference_overlay(client_surface_class=client_surface_class)
        track["track_preference_overlay"] = overlay
        track["track_preference"] = deepcopy(overlay)
        track["can_edit_preferences"] = track_preference_can_edit(overlay)
        identity = track.get("track_id")
        # This is scoped inventory identity, never musical canonical identity or
        # permission. Playlist writers still validate current inventory/grants.
        track["inventory_track_ref"] = (
            f"inventory-track:{library_id}:{identity}"
            if (not public_safe and config is not None
                and type(account_id) is int and account_id > 0
                and type(library_id) is int and library_id > 0
                and type(inventory_library_id) is int and inventory_library_id == library_id
                and type(identity) is int and identity > 0
                and expected_track_ids.get(ref) == identity)
            else None
        )

    for container in containers:
        tracks = list(container.get("tracks") or [])
        rows = build_track_rows(
            tracks, album=container,
            scrobble_count_resolver=lambda track: scrobble_count_lookup.get(
                normalize_track_ref(track.get("path")),
            ),
            # Always return an explicit overlay, including a neutral miss.
            track_preference_resolver=lambda track: track["track_preference_overlay"],
            client_surface_class=client_surface_class,
            viewer_opinion_preferences=viewer_opinion_preferences,
        )
        for track, row in zip(tracks, rows):
            row["inventory_track_ref"] = track.get("inventory_track_ref")
        if container is album_payload or "track_rows" in container:
            container["track_rows"] = rows
        if container is album_payload or "gallery_list_block" in container:
            container["gallery_list_block"] = build_album_gallery_list_block(
                album_key=container.get("key"), album_name=container.get("name"),
                album_artist=container.get("album_artist"), album_year=container.get("year"),
                album_rating=container.get("album_rating", 0),
                total_duration_seconds=container.get("total_duration_seconds"),
                track_count=len(rows), track_rows=rows, track_rows_source="inline",
                album_preference=container.get("album_preference"),
                tag_album_rating=container.get("tag_album_rating"),
                tag_album_rating_source=container.get("tag_album_rating_source"),
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
        # Strip nested existing rows/gallery blocks too, not only raw tracks.
        for container in reversed(containers):
            sanitized = strip_private_album_preference_overlays(container)
            container.clear()
            container.update(sanitized)
    return album_payload


def _safe_scrobble_count_lookup(
    config: dict[str, object],
    track_refs: list[object],
    *,
    account_id: int,
    library_id: int,
    expected_track_ids: dict[str, object],
) -> dict[str, int]:
    try:
        return build_scrobbled_play_count_lookup(
            config, track_refs, account_id=account_id, library_id=library_id,
            expected_track_ids=expected_track_ids, require_active_paths=True,
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
    account_id: int | None = None,
    library_id: int | None = None,
    inventory_library_id: int | None = None,
    preference_action_resolver: Callable[[int], bool] | None = None,
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
                account_id=account_id, library_id=library_id,
                inventory_library_id=inventory_library_id,
                preference_action_resolver=preference_action_resolver,
            )

    return _build_non_album_detail_payload(
        normalized_album_key,
        public_safe=public_safe,
        client_surface_class=client_surface_class,
        config=config,
        library_state=st,
        viewer_opinion_preferences=viewer_opinion_preferences,
    )
