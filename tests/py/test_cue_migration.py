from pathlib import Path


MIGRATION = (
    Path(__file__).resolve().parents[2]
    / "migrations"
    / "postgres"
    / "0181_add_cue_virtual_tracks.sql"
)


def _sql() -> str:
    return " ".join(MIGRATION.read_text(encoding="utf-8").casefold().split())


def test_cue_migration_creates_revision_source_segment_and_correction_tables():
    sql = _sql()

    for table in (
        "library.cue_programs",
        "library.cue_media_sources",
        "library.cue_track_segments",
        "library.cue_corrections",
    ):
        assert f"create table if not exists {table}" in sql

    required = (
        "source_kind in ('external', 'embedded')",
        "revision_sha256 ~ '^[0-9a-f]{64}$'",
        "start_frame bigint not null",
        "end_frame bigint not null",
        "end_frame > start_frame",
        "jsonb_typeof(internal_indexes) = 'array'",
        "status in ('active', 'restored')",
        "jsonb_typeof(payload) = 'object'",
    )
    for fragment in required:
        assert fragment in sql


def test_cue_migration_indexes_every_foreign_key_and_active_identity():
    sql = _sql()

    for index in (
        "cue_programs_library_root_id_idx",
        "cue_programs_last_valid_program_id_idx",
        "cue_programs_active_source_idx",
        "cue_media_sources_library_root_id_idx",
        "cue_track_segments_program_id_idx",
        "cue_track_segments_media_source_id_idx",
        "cue_corrections_library_id_idx",
        "cue_corrections_track_id_idx",
        "cue_corrections_account_id_idx",
        "cue_corrections_base_program_id_idx",
        "cue_corrections_active_kind_idx",
    ):
        assert f"create " in sql and index in sql

    assert "where is_active is true" in sql
    assert "where status = 'active'" in sql


def test_cue_migration_grants_only_required_runtime_writes():
    sql = _sql()

    assert "grant select, insert, update on table library.cue_programs" in sql
    assert "grant select, insert, update on table library.cue_media_sources" in sql
    assert "grant select, insert, update, delete on table library.cue_track_segments" in sql
    assert "grant select, insert, update on table library.cue_corrections" in sql
    assert "grant delete on table library.cue_programs" not in sql
    assert "grant delete on table library.cue_media_sources" not in sql
    assert "grant delete on table library.cue_corrections" not in sql
    assert "revoke all on table library.cue_programs" in sql
    assert "from album_haven_readonly" in sql
    assert "grant all" not in sql
