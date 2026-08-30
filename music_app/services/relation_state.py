from __future__ import annotations

import time

from music_app.services.relations import build_relation_views


def empty_relation_views() -> dict[str, object]:
    return {
        "artists": [],
        "family_to_artists": {},
        "folder_related": {},
        "sidebar_families": [],
    }


def refresh_relation_views_in_state(
    library_state: dict[str, object],
    config: dict[str, object],
) -> dict[str, object]:
    library_state["relations_in_progress"] = True
    library_state["relations_processed"] = 0
    library_state["relations_total"] = max(len(library_state.get("albums", [])), 1)
    library_state["relations_phase"] = "Preparing Artist Family build"
    library_state["relations_source"] = "local"
    try:
        def _progress(processed: int, total: int, phase: str, source: str) -> None:
            library_state["relations_processed"] = processed
            library_state["relations_total"] = max(total, 1)
            library_state["relations_phase"] = phase
            library_state["relations_source"] = source

        relation_views = build_relation_views(
            list(library_state.get("albums", [])),
            config,
            progress_callback=_progress,
        )
        library_state["relation_views"] = relation_views
        library_state["relations_last_built"] = time.time()
        library_state["relations_processed"] = library_state["relations_total"]
        library_state["relations_phase"] = "Artist Family ready"
        library_state["relations_source"] = "local"
        return relation_views
    finally:
        library_state["relations_in_progress"] = False


def ensure_relation_views(
    library_state: dict[str, object],
    config: dict[str, object],
) -> bool:
    relation_views = library_state.get("relation_views", {}) or {}
    if not library_state.get("albums"):
        return False
    artists = relation_views.get("artists") or []
    folder_related = relation_views.get("folder_related") or {}
    if artists and folder_related and len(folder_related) >= len(artists):
        return False
    refresh_relation_views_in_state(library_state, config)
    return True
