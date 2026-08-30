from __future__ import annotations

from collections.abc import Mapping
import inspect
from pathlib import Path

from music_app.services.cache import (
    persist_cover_selection_for_tracks_for_config,
    schedule_cache_updates_save_for_config,
)
from music_app.services.cover_lookup_tasks import (
    clear_completed_cover_lookup_tasks,
    list_cover_lookup_tasks,
    mark_cover_lookup_task_notification_action_taken,
)
from music_app.services.cover_state import (
    apply_cover_selection_for_tracks as apply_cover_selection_service,
    find_albums_by_track_paths as find_albums_by_track_paths_in_albums,
)
from music_app.services.problematic_albums import (
    find_problematic_album_by_track_paths as find_problematic_album_by_track_paths_in_payload,
)
from music_app.services.repair_previews import build_problematic_albums_payload


def _builder_accepts_explicit_dependencies(builder) -> bool:
    try:
        signature = inspect.signature(builder)
    except (TypeError, ValueError):
        return True
    return "config" in signature.parameters or any(
        parameter.kind == inspect.Parameter.VAR_KEYWORD
        for parameter in signature.parameters.values()
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
    reject_if_user_controlled: bool = False,
    clear_selection: bool = False,
    commit_guard=None,
) -> dict[str, int]:
    if config is None:
        raise ValueError("persist_cover_selection_for_tracks requires explicit config")
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
        if not _builder_accepts_explicit_dependencies(build_problematic_albums_payload):
            build_payload = build_problematic_albums_payload
        else:
            build_payload = lambda: build_problematic_albums_payload(
                config=resolved_config,
                library_state=resolved_state,
                logger=resolved_logger,
            )
        return find_problematic_album_by_track_paths_in_payload(
            updated_track_paths,
            build_problematic_albums_payload=build_payload,
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
    )
