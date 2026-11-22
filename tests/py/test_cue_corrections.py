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
        self.order = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def execute(self, sql, params=()):
        if "cue_correction_target" in sql:
            return Cursor(row={
                "track_id": 42,
                "program_id": 7,
                "source_kind": "external",
                "revision_sha256": REVISION,
                "program_ordinal": 1,
                "start_frame": 900,
                "end_frame": 1800,
            })
        if "cue_lock_program" in sql:
            return Cursor()
        if "cue_boundary_neighbours" in sql:
            return Cursor(rows=[
                {"program_ordinal": 0, "start_frame": 0, "end_frame": 900, "corrected_start": None},
                {"program_ordinal": 2, "start_frame": 1800, "end_frame": 2700, "corrected_start": None},
            ])
        if "cue_editor_tracks" in sql:
            return Cursor(rows=[{
                "cue_segment_ref": "cue:track-2",
                "title": "Track Two",
                "program_id": 7,
                "source_kind": "external",
                "revision_sha256": REVISION,
                "start_frame": 1050,
                "end_frame": 1800,
                "internal_indexes": [],
                "media_path": "/music/Album/image.flac",
                "metadata_correction": {"title": "Corrected title"},
            }])
        if "cue_retire_correction" in sql:
            self.order.append("retire")
            return Cursor()
        if "cue_restore_correction" in sql or "cue_store_correction" in sql:
            self.order.append("store" if "cue_store_correction" in sql else "restore")
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


def test_owner_cue_editor_state_names_only_the_image_and_includes_active_overlays():
    service = CueCorrectionService(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"},
        connect=lambda _url: Connection(),
        write_enabled=lambda _library_id: False,
    )

    state = service.load_editor(actor=actor(), cue_segment_ref="cue:track-2")

    assert state == {
        "base_revision_sha256": REVISION,
        "can_edit_structure": True,
        "can_restore_source": False,
        "writes_source": False,
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
                # Owner 2026-11-17: Edit Tags shows the image path beside the artbox, as it does a file's folder.
                "media_path": "/music/Album/image.flac",
            },
        }],
    }


def test_non_owner_cue_editor_gets_metadata_without_structural_controls():
    service = CueCorrectionService(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"},
        connect=lambda _url: Connection(),
        write_enabled=lambda _library_id: False,
    )

    state = service.load_editor(actor=actor(owner=False), cue_segment_ref="cue:track-2")

    assert state["can_edit_structure"] is False
    assert state["tracks"][0]["title"] == "Corrected title"
    assert "cue_structure" not in state["tracks"][0]
    assert "path" not in repr(state).lower()


def test_cue_editor_reports_retained_source_restore_without_exposing_a_path():
    calls = []

    class Writer:
        def has_retained_revision(self, *, library_id, program_id):
            calls.append((library_id, program_id))
            return True

    service = CueCorrectionService(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"},
        connect=lambda _url: Connection(),
        external_writer=Writer(),
        write_enabled=lambda _library_id: True,
    )

    state = service.load_editor(actor=actor(owner=False), cue_segment_ref="cue:track-2")

    assert state["can_restore_source"] is True
    assert state["writes_source"] is True
    assert calls == [(5, 7)]
    assert "path" not in repr(state).lower()


def test_cue_editor_stays_available_when_retained_revision_check_is_stale():
    from music_app.services.cue_external_writer import CueExternalWriteConflict

    class Writer:
        def has_retained_revision(self, **_kwargs):
            raise CueExternalWriteConflict("The CUE program changed.")

    service = CueCorrectionService(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"},
        connect=lambda _url: Connection(),
        external_writer=Writer(),
        write_enabled=lambda _library_id: True,
    )

    state = service.load_editor(actor=actor(owner=False), cue_segment_ref="cue:track-2")

    assert state["can_restore_source"] is False
    assert state["writes_source"] is True


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
        write_enabled=lambda _library_id: False,
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
        write_enabled=lambda _library_id: False,
    )

    result = service.apply(actor=actor(owner=False), payload={
        "cue_segment_ref": "cue:track-2",
        "base_revision_sha256": REVISION,
        "kind": "metadata",
        "fields": {"title": "Corrected title", "artist": "Corrected artist"},
    })

    assert result == {"ok": True, "correction_id": 9}
    assert len(connection.writes) == 1


def test_write_in_tags_mode_uses_the_same_apply_action_for_external_cue():
    connection = Connection()
    calls = []
    enabled_for = []

    class Writer:
        def write_program(self, *, library_id, program_id):
            calls.append((library_id, program_id))
            return {"written_to_tags": True, "program_id": 8}

    service = CueCorrectionService(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"},
        connect=lambda _url: connection,
        external_writer=Writer(),
        write_enabled=lambda library_id: enabled_for.append(library_id) or True,
    )

    result = service.apply(actor=actor(owner=False), payload={
        "kind": "metadata",
        "cue_segment_ref": "cue:track-2",
        "base_revision_sha256": REVISION,
        "fields": {"title": "Written title"},
    })

    assert result == {
        "ok": True,
        "correction_id": 9,
        "written_to_tags": True,
        "program_id": 8,
    }
    assert enabled_for == [5]
    assert calls == [(5, 7)]


def test_metadata_batch_can_defer_source_write_until_its_final_correction():
    class Writer:
        def write_program(self, **_kwargs):
            pytest.fail("an intermediate batch correction must not write the source")

    service = CueCorrectionService(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"},
        connect=lambda _url: Connection(),
        external_writer=Writer(),
        write_enabled=lambda _library_id: True,
    )

    result = service.apply(actor=actor(owner=False), payload={
        "kind": "metadata",
        "cue_segment_ref": "cue:track-2",
        "base_revision_sha256": REVISION,
        "fields": {"title": "First batch row"},
        "write_source": False,
    })

    assert result == {"ok": True, "correction_id": 9}


def test_restore_action_restores_the_retained_external_cue_revision():
    calls = []

    class Writer:
        def restore_program(self, *, library_id, program_id):
            calls.append((library_id, program_id))
            return {"restored_source": True, "program_id": 8}

    service = CueCorrectionService(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"},
        connect=lambda _url: Connection(),
        external_writer=Writer(),
        write_enabled=lambda _library_id: True,
    )

    result = service.restore(
        actor=actor(owner=False),
        cue_segment_ref="cue:track-2",
        kind="source",
    )

    assert result == {"ok": True, "restored_source": True, "program_id": 8}
    assert calls == [(5, 7)]


def test_default_write_check_reads_the_media_host_settings(monkeypatch):
    # Owner 2026-11-17: opening a CUE album's Edit Tags failed with "Library is not the configured media
    # host", so the Tags / CUE structure views never appeared. The default check passed only library_id,
    # which takes the scoped path that also needs the media host id.
    from music_app.services import library_roots

    calls = []

    def load(config, **kwargs):
        calls.append(kwargs)
        return {"metadata_corrections": library_roots.METADATA_CORRECTIONS_WRITE_TAGS}

    monkeypatch.setattr(library_roots, "load_library_root_settings", load)
    service = CueCorrectionService({"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"}, connect=lambda _url: None)

    assert service._write_enabled(1) is True
    assert calls == [{}]


def test_a_second_correction_retires_the_active_one_before_storing():
    # Owner 2026-11-21 ("Cannot edit CUE"): in one statement the retiring CTE need not run before the insert, so a
    # second boundary edit of a track violated cue_corrections_active_kind_idx.
    connection = Connection()
    service = CueCorrectionService(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"},
        connect=lambda _url: connection,
        write_enabled=lambda _library_id: False,
    )
    for start_frame in (1050, 1100):
        service.apply(actor=actor(), payload={
            "cue_segment_ref": "cue:track-2",
            "base_revision_sha256": REVISION,
            "kind": "boundary",
            "start_frame": start_frame,
        })
    assert connection.order == ["retire", "store", "retire", "store"]
    assert all("with restored" not in sql for sql, _params in connection.writes)


class ProgramConnection:
    """Four ten-second tracks of one CUE program, with their active boundary corrections."""

    SHEET = ((0, 750), (750, 1500), (1500, 2250), (2250, 3000))

    def __init__(self, corrected=None):
        self.corrected = dict(corrected or {})
        self.statements = []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def execute(self, sql, params=()):
        self.statements.append(sql)
        if "cue_correction_target" in sql:
            ordinal = int(params[1].rsplit("-", 1)[1])
            start, end = self.SHEET[ordinal]
            return Cursor(row={
                "track_id": ordinal, "program_id": 7, "program_ordinal": ordinal,
                "revision_sha256": REVISION, "start_frame": start, "end_frame": end,
            })
        if "cue_lock_program" in sql:
            return Cursor()
        if "cue_boundary_neighbours" in sql:
            return Cursor(rows=[{
                "program_ordinal": ordinal,
                "start_frame": self.SHEET[ordinal][0],
                "end_frame": self.SHEET[ordinal][1],
                "corrected_start": self.corrected.get(ordinal),
            } for ordinal in params[-1] if 0 <= ordinal < len(self.SHEET)])
        if "cue_retire_correction" in sql:
            self.corrected.pop(params[1], None)
            return Cursor()
        if "cue_store_correction" in sql:
            self.corrected[params[1]] = params[5].obj["start_frame"]
            return Cursor(row={"id": 9})
        if "cue_restore_correction" in sql:
            restored = self.corrected.pop(int(params[2].rsplit("-", 1)[1]), None)
            return Cursor(row=None if restored is None else {"id": 9})
        raise AssertionError(sql)

    def playable(self):
        # The span playback issues: a track's own corrected start, up to the next track's corrected start.
        return all(
            self.corrected.get(ordinal, start) < self.corrected.get(ordinal + 1, end)
            for ordinal, (start, end) in enumerate(self.SHEET)
        )


def move_start(connection, ordinal, start_frame):
    return CueCorrectionService(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"},
        connect=lambda _url: connection,
        write_enabled=lambda _library_id: False,
    ).apply(actor=actor(), payload={
        "cue_segment_ref": f"cue:track-{ordinal}",
        "base_revision_sha256": REVISION,
        "kind": "boundary",
        "start_frame": start_frame,
    })


def restore_start(connection, ordinal):
    return CueCorrectionService(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"},
        connect=lambda _url: connection,
    ).restore(actor=actor(), cue_segment_ref=f"cue:track-{ordinal}", kind="boundary")


def test_a_correction_cannot_start_after_the_next_tracks_corrected_start():
    # Owner 2026-11-21 ("why is playback unavailable"): saves were checked against the sheet's times only,
    # so a track could end before it started and every attempt to play it was refused.
    connection = ProgramConnection()
    move_start(connection, 2, 12 * 75)

    with pytest.raises(CueCorrectionError, match="after 00:00:00 and before 00:12:00"):
        move_start(connection, 1, 15 * 75)

    assert connection.corrected == {2: 12 * 75}


def test_a_correction_cannot_start_before_the_previous_tracks_corrected_start():
    connection = ProgramConnection({1: 15 * 75})

    with pytest.raises(CueCorrectionError, match="after 00:15:00 and before 00:30:00"):
        move_start(connection, 2, 12 * 75)

    assert connection.corrected == {1: 15 * 75}


def test_a_correction_may_follow_a_neighbour_that_made_room_for_it():
    connection = ProgramConnection({2: 25 * 75})

    move_start(connection, 1, 22 * 75)

    assert connection.playable()


@pytest.mark.parametrize(("corrected", "ordinal", "neighbour"), [
    ({1: 22 * 75, 2: 25 * 75}, 2, "before"),
    ({1: 5 * 75, 2: 8 * 75}, 1, "after"),
])
def test_restoring_a_start_cannot_overlap_a_corrected_neighbour(corrected, ordinal, neighbour):
    connection = ProgramConnection(corrected)

    with pytest.raises(CueCorrectionError, match=f"overlap the track {neighbour} it"):
        restore_start(connection, ordinal)

    assert connection.corrected == corrected


@pytest.mark.parametrize("ordinal", [1, 2])
def test_either_side_of_an_already_overlapping_pair_can_be_restored(ordinal):
    connection = ProgramConnection({1: 15 * 75, 2: 12 * 75})

    assert restore_start(connection, ordinal)["restored"] is True
    assert connection.playable()


def test_no_accepted_sequence_of_corrections_and_restores_leaves_an_unplayable_track():
    changes = [(ordinal, start) for ordinal in range(4) for start in (*range(0, 3000, 225), None)]
    reached = {()}
    pending = [()]
    for _depth in range(3):
        following = []
        for before in pending:
            for ordinal, start in changes:
                connection = ProgramConnection(before)
                try:
                    if start is None:
                        restore_start(connection, ordinal)
                    else:
                        move_start(connection, ordinal, start)
                except CueCorrectionError:
                    continue
                assert connection.playable(), (before, ordinal, start)
                after = tuple(sorted(connection.corrected.items()))
                if after not in reached:
                    reached.add(after)
                    following.append(after)
        pending = following


def test_a_boundary_check_locks_the_program_then_reads_only_the_two_neighbours():
    connection = ProgramConnection()

    move_start(connection, 2, 22 * 75)

    reads = [sql for sql in connection.statements if "cue_boundary_neighbours" in sql]
    assert len(reads) == 1 and "program_ordinal = any" in reads[0]
    target = next(sql for sql in connection.statements if "cue_correction_target" in sql)
    assert "over (" not in target, "the target lookup must not window every program in the library"
    lock = next(index for index, sql in enumerate(connection.statements) if "cue_lock_program" in sql)
    assert lock < connection.statements.index(reads[0])
