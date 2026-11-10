from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from music_app.services.cover_lookup_action_repair import (
    _CANDIDATE_SQL,
    proven_post_search_cover,
)


def test_candidate_query_requires_terminal_explicit_non_unknown_album() -> None:
    assert "status in ('completed', 'failed', 'canceled')" in _CANDIDATE_SQL
    assert "cover_selection_origin' = 'user'" in _CANDIDATE_SQL
    assert "cover_selection_provenance' = 'explicit'" in _CANDIDATE_SQL
    assert "'unknown album'" in _CANDIDATE_SQL
    assert (
        "resolved_tasks.requested_path_count = resolved_tasks.resolved_path_count"
        in _CANDIDATE_SQL
    )
    assert "resolved_tasks.resolved_album_count = 1" in _CANDIDATE_SQL


def test_proven_post_search_cover_requires_matching_current_bytes_after_completion(
    tmp_path: Path,
) -> None:
    cover = tmp_path / "cover.jpg"
    cover.write_bytes(b"chosen cover")
    completed_at = datetime(2026, 10, 20, tzinfo=timezone.utc)
    selected_at = datetime(2026, 10, 21, tzinfo=timezone.utc)

    assert proven_post_search_cover(
        {
            "completed_at": completed_at,
            "cover_path": str(cover),
            "cover_revision": "8b435fd358be125ac9baba05b3beb4eaf7a645628721c310a719302c87e6d3b7",
        },
        modified_at=lambda _path: selected_at,
    )
    assert not proven_post_search_cover(
        {
            "completed_at": completed_at,
            "cover_path": str(cover),
            "cover_revision": "wrong",
        },
        modified_at=lambda _path: selected_at,
    )
    assert not proven_post_search_cover(
        {
            "completed_at": completed_at,
            "cover_path": str(cover),
            "cover_revision": "8b435fd358be125ac9baba05b3beb4eaf7a645628721c310a719302c87e6d3b7",
        },
        modified_at=lambda _path: completed_at,
    )

