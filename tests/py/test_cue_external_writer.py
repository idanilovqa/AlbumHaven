from __future__ import annotations

from pathlib import Path

import pytest


SOURCE = b'''REM GENRE Rock\nPERFORMER "Old Album Artist"\nTITLE "Old Album"\nFILE "image.flac" WAVE\n  TRACK 01 AUDIO\n    TITLE "Old One"\n    PERFORMER "Old Artist"\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    TITLE "Old Two"\n    INDEX 01 03:00:00\n'''


def test_render_external_cue_preserves_unknown_text_and_writes_supported_overrides():
    from music_app.services.cue_external_writer import render_external_cue

    rendered = render_external_cue(SOURCE, (
        {"id": 1, "program_ordinal": 0, "kind": "metadata", "payload": {"fields": {
            "title": "New One", "artist": "New Artist", "album": "New Album",
            "album_artist": "New Album Artist", "genre": "Jazz",
        }}},
        {"id": 2, "program_ordinal": 1, "kind": "boundary", "payload": {"start_frame": 14000}},
    ))

    assert rendered.source_bytes == b'''REM GENRE Rock\nPERFORMER "New Album Artist"\nTITLE "New Album"\nFILE "image.flac" WAVE\n  TRACK 01 AUDIO\n    TITLE "New One"\n    PERFORMER "New Artist"\n    INDEX 01 00:00:00\n  TRACK 02 AUDIO\n    TITLE "Old Two"\n    INDEX 01 03:06:50\n'''
    assert rendered.persisted_fields == {1: frozenset({"title", "artist", "album", "album_artist"}), 2: None}


def test_render_external_cue_inserts_missing_track_directives_and_leaves_unsafe_text_unwritten():
    from music_app.services.cue_external_writer import render_external_cue

    rendered = render_external_cue(
        b'FILE "image.flac" WAVE\r\n  TRACK 01 AUDIO\r\n    INDEX 01 00:00:00\r\n',
        ({"id": 3, "program_ordinal": 0, "kind": "metadata", "payload": {"fields": {
            "title": "Safe", "artist": 'Unsafe "artist"',
        }}},),
    )

    assert b'    TITLE "Safe"\r\n' in rendered.source_bytes
    assert b"PERFORMER" not in rendered.source_bytes
    assert rendered.persisted_fields == {3: frozenset({"title"})}


def test_render_external_cue_uses_track_number_when_htoa_shifts_program_ordinal():
    from music_app.services.cue_external_writer import render_external_cue

    rendered = render_external_cue(
        SOURCE,
        ({
            "id": 4,
            "program_ordinal": 1,
            "track_number": 1,
            "kind": "metadata",
            "payload": {"fields": {"title": "First after HTOA"}},
        },),
    )

    assert b'TRACK 01 AUDIO\n    TITLE "First after HTOA"' in rendered.source_bytes
    assert b'TRACK 02 AUDIO\n    TITLE "Old Two"' in rendered.source_bytes


def test_atomic_external_cue_write_keeps_one_prior_revision_and_restores_on_failure(tmp_path, monkeypatch):
    from music_app.services import cue_external_writer as writer

    source = tmp_path / "album.cue"
    source.write_bytes(SOURCE)
    writer.atomic_replace_external_cue(source, expected_source=SOURCE, replacement=b"revision two\n")
    backup = Path(f"{source}.albumhaven-backup")
    assert source.read_bytes() == b"revision two\n"
    assert backup.read_bytes() == SOURCE

    writer.atomic_replace_external_cue(source, expected_source=b"revision two\n", replacement=b"revision three\n")
    assert source.read_bytes() == b"revision three\n"
    assert backup.read_bytes() == b"revision two\n"

    monkeypatch.setattr(writer.os, "replace", lambda *_args: (_ for _ in ()).throw(OSError("replace failed")))
    with pytest.raises(OSError, match="replace failed"):
        writer.atomic_replace_external_cue(source, expected_source=b"revision three\n", replacement=b"revision four\n")
    assert source.read_bytes() == b"revision three\n"


def test_atomic_external_cue_write_rejects_changed_source(tmp_path):
    from music_app.services.cue_external_writer import CueExternalWriteConflict, atomic_replace_external_cue

    source = tmp_path / "album.cue"
    source.write_bytes(b"newer\n")
    with pytest.raises(CueExternalWriteConflict, match="changed"):
        atomic_replace_external_cue(source, expected_source=b"older\n", replacement=b"replacement\n")
    assert source.read_bytes() == b"newer\n"


def test_atomic_external_cue_write_rejects_symlink_before_reading_target(tmp_path, monkeypatch):
    from music_app.services import cue_external_writer as writer

    target = tmp_path / "target.cue"
    source = tmp_path / "album.cue"
    target.write_bytes(b"private target\n")
    try:
        source.symlink_to(target)
    except OSError:
        pytest.skip("symlink creation is unavailable")
    real_read_bytes = Path.read_bytes

    def reject_target_read(path):
        if path == source:
            raise AssertionError("symlink target was read")
        return real_read_bytes(path)

    monkeypatch.setattr(Path, "read_bytes", reject_target_read)

    with pytest.raises(writer.CueExternalWriteConflict, match="regular file"):
        writer.atomic_replace_external_cue(
            source,
            expected_source=b"private target\n",
            replacement=b"replacement\n",
        )


def test_atomic_external_cue_write_preserves_prior_backup_when_source_replace_fails(tmp_path, monkeypatch):
    from music_app.services import cue_external_writer as writer

    source = tmp_path / "album.cue"
    backup = Path(f"{source}.albumhaven-backup")
    source.write_bytes(b"current\n")
    backup.write_bytes(b"prior\n")
    real_replace = writer.os.replace
    calls = 0

    def fail_source_replace(source_path, destination_path):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("source replace failed")
        return real_replace(source_path, destination_path)

    monkeypatch.setattr(writer.os, "replace", fail_source_replace)

    with pytest.raises(OSError, match="source replace failed"):
        writer.atomic_replace_external_cue(
            source,
            expected_source=b"current\n",
            replacement=b"replacement\n",
        )

    assert source.read_bytes() == b"current\n"
    assert backup.read_bytes() == b"prior\n"


def test_external_write_service_reconciles_then_rebases_only_unwritten_fields(tmp_path):
    from music_app.services.cue_external_writer import CueExternalWritePlan, CueExternalWriteService

    source = tmp_path / "album.cue"
    source.write_bytes(SOURCE)
    (tmp_path / "image.flac").write_bytes(b"synthetic audio")
    finalized = []
    service = CueExternalWriteService(
        {"SUPPORTED_EXTENSIONS": {".flac"}},
        load_plan=lambda _library_id, _program_id: CueExternalWritePlan(
            program_id=7,
            source_kind="external",
            root_id="main",
            root_path=tmp_path,
            source_path=source,
            source_bytes=SOURCE,
            corrections=({"id": 1, "program_ordinal": 0, "kind": "metadata", "payload": {
                "fields": {"title": "Written", "genre": "Database only"},
            }},),
            media_durations={str(tmp_path / "image.flac"): 180.0},
        ),
        reconcile=lambda plan: 8,
        finalize=lambda old, new, persisted: finalized.append((old, new, persisted)),
    )

    result = service.write_program(library_id=5, program_id=7)

    assert result == {"written_to_tags": True, "program_id": 8}
    assert Path(f"{source}.albumhaven-backup").read_bytes() == SOURCE
    assert b'TITLE "Written"' in source.read_bytes()
    assert finalized == [(7, 8, {1: frozenset({"title"})})]


def test_external_write_service_restores_source_when_reconciliation_fails(tmp_path):
    from music_app.services.cue_external_writer import (
        CueExternalWriteConflict,
        CueExternalWritePlan,
        CueExternalWriteService,
    )

    source = tmp_path / "album.cue"
    source.write_bytes(SOURCE)
    service = CueExternalWriteService(
        {},
        load_plan=lambda _library_id, _program_id: CueExternalWritePlan(
            program_id=7,
            source_kind="external",
            root_id="main",
            root_path=tmp_path,
            source_path=source,
            source_bytes=SOURCE,
            corrections=({
                "id": 1,
                "program_ordinal": 0,
                "kind": "metadata",
                "payload": {"fields": {"title": "Written"}},
            },),
            media_durations={},
        ),
        reconcile=lambda _plan: (_ for _ in ()).throw(
            CueExternalWriteConflict("Reconciliation failed.")
        ),
    )

    with pytest.raises(CueExternalWriteConflict, match="Reconciliation failed"):
        service.write_program(library_id=5, program_id=7)

    assert source.read_bytes() == SOURCE
    assert Path(f"{source}.albumhaven-backup").read_bytes() == SOURCE


def test_external_write_service_restores_retained_revision_and_keeps_current_as_backup(tmp_path):
    from music_app.services.cue_external_writer import CueExternalWritePlan, CueExternalWriteService

    source = tmp_path / "album.cue"
    backup = Path(f"{source}.albumhaven-backup")
    current = SOURCE.replace(b"Old One", b"Current")
    prior = SOURCE.replace(b"Old One", b"Prior")
    source.write_bytes(current)
    backup.write_bytes(prior)
    reconciled = []
    service = CueExternalWriteService(
        {},
        load_plan=lambda _library_id, _program_id: CueExternalWritePlan(
            program_id=8,
            source_kind="external",
            root_id="main",
            root_path=tmp_path,
            source_path=source,
            source_bytes=current,
            corrections=(),
            media_durations={},
        ),
        reconcile=lambda plan: reconciled.append(plan.source_path.read_bytes()) or 9,
    )

    result = service.restore_program(library_id=5, program_id=8)

    assert result == {"restored_source": True, "program_id": 9}
    assert source.read_bytes() == prior
    assert backup.read_bytes() == current
    assert reconciled == [prior]


def test_external_write_service_keeps_embedded_cue_database_only(tmp_path):
    from music_app.services.cue_external_writer import CueExternalWritePlan, CueExternalWriteService

    service = CueExternalWriteService(
        {},
        load_plan=lambda _library_id, _program_id: CueExternalWritePlan(
            program_id=7, source_kind="embedded", root_id="main", root_path=tmp_path,
            source_path=tmp_path / "image.flac", source_bytes=SOURCE, corrections=(), media_durations={},
        ),
        reconcile=lambda _plan: pytest.fail("embedded CUE must not reconcile a file write"),
        finalize=lambda *_args: pytest.fail("embedded CUE corrections remain database-only"),
    )

    assert service.write_program(library_id=5, program_id=7) == {
        "written_to_tags": False,
        "write_reason": "embedded",
    }


def test_external_write_service_reports_missing_external_source_without_a_path(tmp_path):
    from music_app.services.cue_external_writer import (
        CueExternalWriteConflict,
        CueExternalWritePlan,
        CueExternalWriteService,
    )

    service = CueExternalWriteService(
        {},
        load_plan=lambda _library_id, _program_id: CueExternalWritePlan(
            program_id=7,
            source_kind="external",
            root_id="main",
            root_path=tmp_path,
            source_path=tmp_path / "missing.cue",
            source_bytes=SOURCE,
            corrections=({
                "id": 1,
                "program_ordinal": 0,
                "kind": "metadata",
                "payload": {"fields": {"title": "Written"}},
            },),
            media_durations={},
        ),
    )

    with pytest.raises(CueExternalWriteConflict) as raised:
        service.write_program(library_id=5, program_id=7)

    assert str(tmp_path) not in str(raised.value)


def test_external_write_service_converts_atomic_io_failure_to_readable_conflict(tmp_path, monkeypatch):
    from music_app.services import cue_external_writer as writer

    source = tmp_path / "album.cue"
    source.write_bytes(SOURCE)
    service = writer.CueExternalWriteService(
        {},
        load_plan=lambda _library_id, _program_id: writer.CueExternalWritePlan(
            program_id=7,
            source_kind="external",
            root_id="main",
            root_path=tmp_path,
            source_path=source,
            source_bytes=SOURCE,
            corrections=({
                "id": 1,
                "program_ordinal": 0,
                "kind": "metadata",
                "payload": {"fields": {"title": "Written"}},
            },),
            media_durations={},
        ),
    )
    monkeypatch.setattr(
        writer,
        "atomic_replace_external_cue",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError("private path")),
    )

    with pytest.raises(writer.CueExternalWriteConflict) as raised:
        service.write_program(library_id=5, program_id=7)

    assert str(tmp_path) not in str(raised.value)


def test_external_write_service_loads_embedded_identity_without_treating_marker_as_path(tmp_path):
    from music_app.services.cue_external_writer import CueExternalWriteService

    class Cursor:
        def __init__(self, *, row=None, rows=()):
            self._row = row
            self._rows = rows

        def fetchone(self):
            return self._row

        def fetchall(self):
            return self._rows

    class Connection:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def execute(self, sql, _params=()):
            if "cue_external_write_program" in sql:
                return Cursor(row={
                    "id": 7,
                    "source_kind": "embedded",
                    "source_identity": "image.flac#embedded-cue",
                    "source_bytes": SOURCE,
                    "root_path": str(tmp_path),
                    "root_id": "main",
                })
            if "cue_external_write_corrections" in sql:
                return Cursor()
            if "cue_external_write_media" in sql:
                return Cursor()
            raise AssertionError(sql)

    service = CueExternalWriteService(
        {"ALBUM_HAVEN_APP_DATABASE_URL": "postgresql://unused"},
        connect=lambda _url: Connection(),
    )

    assert service.write_program(library_id=5, program_id=7) == {
        "written_to_tags": False,
        "write_reason": "embedded",
    }
