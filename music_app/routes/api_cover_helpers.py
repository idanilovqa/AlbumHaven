from __future__ import annotations

from collections.abc import Mapping
from pathlib import Path

from music_app.services.cache import (
    persist_cover_selection_for_tracks_for_config,
    schedule_cache_updates_save_for_config,
)
from music_app.services.cover_lookup_tasks import (
    clear_completed_cover_lookup_tasks,
    list_cover_lookup_task_summaries,
    mark_cover_lookup_notifications_action_taken_for_track_paths,
    mark_cover_lookup_task_notification_action_taken,
)
from music_app.services.cover_state import (
    apply_cover_selection_for_tracks as apply_cover_selection_service,
    find_albums_by_track_paths as find_albums_by_track_paths_in_albums,
)
from music_app.services.covers import image_dimensions
from music_app.services.repair_previews import build_problematic_album_detail_payload


def serialize_ordered_cover_selection_for_read(
    config: dict[str, object], track_paths: set[str], selection: dict[str, object],
    *, remote_read: bool,
) -> list[dict[str, object]]:
    """Use existing gallery source authority without dropping unavailable slots."""
    from music_app.services.cover_workflow import (
        resolve_album_write_root_from_track_paths, restrict_album_root_to_represented_disc,
    )
    from music_app.services.library_roots import iter_library_root_paths, resolve_configured_media_path
    from music_app.services.ordered_cover_references import project_selected_cover_metadata

    references = project_selected_cover_metadata(selection).get("selected_covers", [])
    album_root = None
    roots = ()
    if any(item["kind"] == "local" for item in references):
        album_root = resolve_album_write_root_from_track_paths(config, track_paths)
        if album_root is not None:
            album_root = restrict_album_root_to_represented_disc(album_root, track_paths)
            roots = tuple(iter_library_root_paths(config))
    result = []
    for reference in references:
        public = {"selection_id": reference["selection_id"], "kind": reference["kind"]}
        if reference["kind"] == "remote":
            if remote_read:
                public = dict(reference)
        else:
            path = resolve_configured_media_path(
                config, reference["path"], require_file=False, require_exists=False,
                configured_root_paths=roots,
            )
            if (path is not None and album_root is not None and path.is_relative_to(album_root)
                    and path == Path(reference["path"])):
                public = dict(reference)
            else:
                public["unavailable"] = True
        result.append(public)
    return result


def publish_ordered_cover_selection_for_tracks(
    library_state: dict[str, object], track_paths: set[str], selection: list[dict[str, object]],
) -> None:
    """Publish a committed primary under the caller's runtime/source locks.

    No image inspection or persistence occurs here, including for a saved source
    that is currently missing. The database remains the ordered-list authority.
    """
    primary = selection[0]
    remote = primary if primary["kind"] == "remote" else {}
    apply_cover_selection_service(
        library_state=library_state, track_paths=track_paths,
        cover_path=Path(primary["path"]) if primary["kind"] == "local" else None,
        **{"remote_cover_" + field: remote.get(field) for field in (
            "url", "thumbnail_url", "source", "source_label", "album_url", "width", "height",
        )},
        cover_revision=None, manual_selection=True, local_cover_dimensions=(None, None),
        persist_cache_update=False, cache_path=None, schedule_cache_updates_save=None,
        find_updated_albums=lambda paths: [], find_problematic_album=lambda paths: None,
    )


def apply_cover_path_for_tracks(
    track_paths: set[str],
    cover_path: Path | None,
    *,
    config: Mapping[str, object] | None = None,
    logger=None,
    library_state: dict[str, object] | None = None,
    cover_revision: str | None = None,
    remote_cover_url: str | None = None,
    remote_cover_thumbnail_url: str | None = None,
    remote_cover_source: str | None = None,
    remote_cover_source_label: str | None = None,
    remote_cover_album_url: str | None = None,
    remote_cover_width: int | None = None,
    remote_cover_height: int | None = None,
    schedule_cache_update: bool = True,
    include_problematic_album: bool = True,
    local_cover_dimensions: tuple[int | None, int | None] | None = None,
) -> tuple[list[dict[str, object]], dict[str, object] | None]:
    return apply_cover_selection_for_tracks(
        track_paths,
        cover_path=cover_path,
        config=config,
        logger=logger,
        library_state=library_state,
        cover_revision=cover_revision,
        remote_cover_url=remote_cover_url,
        remote_cover_thumbnail_url=remote_cover_thumbnail_url,
        remote_cover_source=remote_cover_source,
        remote_cover_source_label=remote_cover_source_label,
        remote_cover_album_url=remote_cover_album_url,
        remote_cover_width=remote_cover_width,
        remote_cover_height=remote_cover_height,
        schedule_cache_update=schedule_cache_update,
        include_problematic_album=include_problematic_album,
        local_cover_dimensions=local_cover_dimensions,
        manual_selection=True,
    )


def persist_cover_selection_for_tracks(
    track_paths: set[str],
    cover_path: Path | None,
    *,
    config: Mapping[str, object] | None = None,
    logger=None,
    cover_revision: str | None = None,
    remote_cover_url: str | None = None,
    remote_cover_thumbnail_url: str | None = None,
    remote_cover_source: str | None = None,
    remote_cover_source_label: str | None = None,
    remote_cover_album_url: str | None = None,
    remote_cover_width: int | None = None,
    remote_cover_height: int | None = None,
    cover_selection_origin: str | None = "user",
    explicit_selection: bool = False,
    reject_if_user_controlled: bool = False,
    clear_selection: bool = False,
    commit_guard=None,
) -> dict[str, int]:
    if config is None:
        raise ValueError("persist_cover_selection_for_tracks requires explicit config")
    width, height = image_dimensions(cover_path) if cover_path else (None, None)
    dimensions = {"local_cover_width": width, "local_cover_height": height} if width and height else {}
    return persist_cover_selection_for_tracks_for_config(
        dict(config),
        track_paths,
        cover_path,
        cover_revision=cover_revision,
        remote_cover_url=remote_cover_url,
        remote_cover_thumbnail_url=remote_cover_thumbnail_url,
        remote_cover_source=remote_cover_source,
        remote_cover_source_label=remote_cover_source_label,
        remote_cover_album_url=remote_cover_album_url,
        remote_cover_width=remote_cover_width,
        remote_cover_height=remote_cover_height,
        cover_selection_origin=cover_selection_origin,
        explicit_selection=explicit_selection,
        **dimensions,
        reject_if_user_controlled=reject_if_user_controlled,
        clear_selection=clear_selection,
        commit_guard=commit_guard,
        logger=logger,
    )


def apply_cover_selection_for_tracks(
    track_paths: set[str],
    *,
    cover_path: Path | None = None,
    remote_cover_url: str | None = None,
    remote_cover_thumbnail_url: str | None = None,
    remote_cover_source: str | None = None,
    remote_cover_source_label: str | None = None,
    remote_cover_album_url: str | None = None,
    remote_cover_width: int | None = None,
    remote_cover_height: int | None = None,
    config: Mapping[str, object] | None = None,
    logger=None,
    library_state: dict[str, object] | None = None,
    cover_revision: str | None = None,
    schedule_cache_update: bool = True,
    manual_selection: bool = False,
    include_problematic_album: bool = True,
    local_cover_dimensions: tuple[int | None, int | None] | None = None,
) -> tuple[list[dict[str, object]], dict[str, object] | None]:
    if config is None or logger is None or library_state is None:
        raise ValueError("apply_cover_selection_for_tracks requires explicit config, logger, and library_state")

    resolved_config = config
    resolved_logger = logger
    resolved_state = library_state

    def find_updated_albums(updated_track_paths: set[str]) -> list[dict[str, object]]:
        return find_albums_by_track_paths_in_albums(
            resolved_state.get("albums", []) if isinstance(resolved_state, dict) else [],
            updated_track_paths,
        )

    def find_problematic_album(updated_track_paths: set[str]) -> dict[str, object] | None:
        if not include_problematic_album:
            return None
        updated_albums = find_updated_albums(updated_track_paths)
        album_key = str(updated_albums[0].get("key") or "") if updated_albums else ""
        if not album_key:
            return None
        return build_problematic_album_detail_payload(
            album_key,
            config=resolved_config,
            library_state=resolved_state,
            logger=resolved_logger,
        )

    return apply_cover_selection_service(
        library_state=resolved_state,
        track_paths=track_paths,
        schedule_cache_updates_save=lambda cache_path, payload: schedule_cache_updates_save_for_config(
            resolved_config,
            cache_path,
            payload,
        ),
        cache_path=resolved_config["CACHE_PATH"],
        find_updated_albums=find_updated_albums,
        find_problematic_album=find_problematic_album,
        cover_path=cover_path,
        remote_cover_url=remote_cover_url,
        remote_cover_thumbnail_url=remote_cover_thumbnail_url,
        remote_cover_source=remote_cover_source,
        remote_cover_source_label=remote_cover_source_label,
        remote_cover_album_url=remote_cover_album_url,
        remote_cover_width=remote_cover_width,
        remote_cover_height=remote_cover_height,
        cover_revision=cover_revision,
        persist_cache_update=schedule_cache_update,
        manual_selection=manual_selection,
        local_cover_dimensions=local_cover_dimensions,
    )
