from __future__ import annotations

from types import SimpleNamespace

import pytest

from music_app.services.cue_corrections import CueCorrectionError, CueCorrectionService


REVISION = "a" * 64


class Cursor:
    def __init__(self, *, row=None, rows=()):
        self._row = row
        self._rows = list(rows)

    def fetchone(self):
        return self._row

    def fetchall(self):
        return self._rows


class Connection:
    def __init__(self):
        self.writes = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def execute(self, sql, params=()):
        if "cue_correction_target" in sql:
            return Cursor(row={
                "track_id": 42,
                "program_id": 7,
                "revision_sha256": REVISION,
                "start_frame": 900,
                "end_frame": 1800,
                "previous_start_frame": 0,
            })
        if "cue_editor_tracks" in sql:
            return Cursor(rows=[{
                "cue_segment_ref": "cue:track-2",
                "title": "Track Two",
                "program_id": 7,
                "revision_sha256": REVISION,
                "start_frame": 1050,
                "end_frame": 1800,
                "internal_indexes": [],
                "metadata_correction": {"title": "Corrected title"},
            }])
        if "cue_restore_correction" in sql or "cue_store_correction" in sql:
            self.writes.append((sql, params))
            return Cursor(row={"id": 9})
        raise AssertionError(sql)


def actor(*, owner=True):
    return SimpleNamespace(
        account_id=3,
        current_library_id=5,
        library_relationships=(
            SimpleNamespace(library_id=5, is_primary_owner=owner),
        ),
    )


def test_cue_editor_state_is_path_free_and_includes_active_overlays():
    service = CueCorrectionService(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"},
        connect=lambda _url: Connection(),
    )

    state = service.load_editor(actor=actor(), cue_segment_ref="cue:track-2")

    assert state == {
        "base_revision_sha256": REVISION,
        "can_edit_structure": True,
        "tracks": [{
            "cue_segment_ref": "cue:track-2",
            "title": "Corrected title",
            "cue_boundary_corrected": False,
            "cue_metadata_corrected": False,
            "cue_structure": {
                "base_revision_sha256": REVISION,
                "start_frame": 1050,
                "end_frame": 1800,
                "internal_indexes": [],
            },
        }],
    }
    assert "path" not in repr(state).lower()


def test_non_owner_cue_editor_gets_metadata_without_structural_controls():
    service = CueCorrectionService(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"},
        connect=lambda _url: Connection(),
    )

    state = service.load_editor(actor=actor(owner=False), cue_segment_ref="cue:track-2")

    assert state["can_edit_structure"] is False
    assert state["tracks"][0]["title"] == "Corrected title"
    assert "cue_structure" not in state["tracks"][0]


def test_boundary_correction_requires_owner_and_current_revision():
    service = CueCorrectionService(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"},
        connect=lambda _url: Connection(),
    )

    with pytest.raises(CueCorrectionError, match="owner"):
        service.apply(actor=actor(owner=False), payload={
            "cue_segment_ref": "cue:track-2",
            "base_revision_sha256": REVISION,
            "kind": "boundary",
            "start_frame": 1050,
        })
    with pytest.raises(CueCorrectionError, match="changed"):
        service.apply(actor=actor(), payload={
            "cue_segment_ref": "cue:track-2",
            "base_revision_sha256": "b" * 64,
            "kind": "boundary",
            "start_frame": 1050,
        })


def test_boundary_correction_and_restore_are_reversible_database_overlays():
    connection = Connection()
    service = CueCorrectionService(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"},
        connect=lambda _url: connection,
    )

    applied = service.apply(actor=actor(), payload={
        "cue_segment_ref": "cue:track-2",
        "base_revision_sha256": REVISION,
        "kind": "boundary",
        "start_frame": 1050,
    })
    restored = service.restore(
        actor=actor(),
        cue_segment_ref="cue:track-2",
        kind="boundary",
    )

    assert applied == {"ok": True, "correction_id": 9}
    assert restored == {"ok": True, "restored": True}
    assert len(connection.writes) == 2


def test_metadata_correction_uses_the_shared_editable_fields_without_owner_only_structure():
    connection = Connection()
    service = CueCorrectionService(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"},
        connect=lambda _url: connection,
    )

    result = service.apply(actor=actor(owner=False), payload={
        "cue_segment_ref": "cue:track-2",
        "base_revision_sha256": REVISION,
        "kind": "metadata",
        "fields": {"title": "Corrected title", "artist": "Corrected artist"},
    })

    assert result == {"ok": True, "correction_id": 9}
    assert len(connection.writes) == 1
