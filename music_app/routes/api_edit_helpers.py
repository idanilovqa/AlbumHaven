from __future__ import annotations

"""Compatibility wrappers for Phase 3 edit-helper extraction.

Route registration and legacy imports still point here, but the durable
owners now live under music_app.services.
"""

from music_app.services.edit_state import (
    apply_repairs_worker as _apply_repairs_worker,
    build_affected_album_dicts as _build_affected_album_dicts,
    rebuild_affected_albums_in_state as _rebuild_affected_albums_in_state,
    rebuild_relation_views,
    refresh_changed_files_in_cache as _refresh_changed_files_in_cache,
    update_cache_entry_after_repairs as _update_cache_entry_after_repairs,
)
from music_app.services.repair_previews import (
    _build_artist_alias_repairs_for_entry,
    _build_disc_marker_repairs_for_entry,
    _collect_track_problem_rows,
    build_problematic_album_detail_payload,
    build_problematic_albums_payload,
    find_problematic_album_by_track_paths as _find_problematic_album_by_track_paths,
)
