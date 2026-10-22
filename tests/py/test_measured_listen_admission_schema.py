"""Source-only migration contracts; these do not apply or execute PostgreSQL."""
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[2]
MIGRATION = ROOT / "migrations/postgres/0125_measured_listen_admission.sql"


def sql_text():
    # Comments are deliberately excluded from assertions about executable SQL.
    source = re.sub(r"--[^\n]*", "", MIGRATION.read_text(encoding="utf-8"))
    return " ".join(source.lower().split())


def test_private_sidecar_has_one_globally_nonrebindable_decoder_identity():
    sql = sql_text()
    assert "create table integration.measured_listen_admission (" in sql
    assert "decoder_instance_id uuid primary key" in sql
    for field in ("decoder_instance_id", "device_id", "session_id"):
        assert f"{field} <> '00000000-0000-0000-0000-000000000000'::uuid" in sql
    assert "evidence_version = 'rendered-position-histogram-v1'" in sql
    assert "sample_rate between 8000 and 192000" in sql
    assert "admitted_at timestamptz not null" in sql
    assert "create index measured_listen_admission_group_idx" in sql
    assert "(account_id, original_library_id, device_id, session_id, admitted_at, decoder_instance_id)" in sql


def test_only_owner_deletion_cascades_and_live_source_deletion_retains_original_scope():
    sql = sql_text()
    assert "account_id bigint not null references app.accounts(id) on delete cascade" in sql
    for field, table in (("live_library_id", "library.libraries"),
                         ("live_track_id", "library.local_tracks"),
                         ("live_file_id", "library.local_track_files")):
        assert f"{field} bigint references {table}(id) on delete set null" in sql
    for field in ("original_library_id", "original_track_id", "original_file_id"):
        assert f"{field} bigint not null check ({field} > 0)" in sql
        assert not re.search(rf"\b{field}\s+bigint[^,]*\breferences\b", sql)
    assert sql.count("on delete cascade") == 1
    assert sql.count("on delete set null") == 3
    assert "integration.listen_history" not in sql
    assert "alter table" not in sql


def test_receipt_checkpoint_and_acceptance_snapshot_are_absent_or_present_together():
    sql = sql_text()
    shape = sql.split("constraint admission_accepted_shape check (", 1)[1].split(
        "constraint admission_json_size", 1)[0]
    fields = ("accepted_checkpoint", "accepted_admission", "accepted_digest", "accepted_sequence",
              "receipt_body", "receipt_status", "accepted_at")
    for field in fields:
        assert f"{field} is null" in shape
        assert f"{field} is not null" in shape
    assert "jsonb_typeof(accepted_checkpoint) = 'object'" in shape
    assert "jsonb_typeof(accepted_admission) = 'object'" in shape
    assert "accepted_digest ~ '^[0-9a-f]{64}$'" in shape
    assert "accepted_sequence between 0 and 9007199254740991" in sql
    assert "receipt_status = 200" in shape
    assert "receipt_body text" in sql  # Preserve exact representation, not JSONB reformatting.
    assert "octet_length(receipt_body) <= 8192" in shape


def test_metadata_and_checkpoint_json_are_bounded_without_client_derived_total_columns():
    sql = sql_text()
    assert "current_admission jsonb not null check (jsonb_typeof(current_admission) = 'object')" in sql
    for field in ("current_admission", "accepted_admission", "accepted_checkpoint"):
        assert f"octet_length({field}::text) <= 262144" in sql
    for forbidden in ("duration_seconds", "song_complete", "whole_track_percentage", "scrobbled",
                      "lastfm", "delivery_complete", "content_signature"):
        assert forbidden not in sql


def test_server_metadata_has_explicit_keys_types_and_extent_lifecycle_constraints():
    sql = sql_text()
    assert "constraint admission_metadata_shape check (" in sql
    keys = "array['metadata_revision','observed_intervals','extent_state', 'verified_total_frames','extent_provenance','admission_limited']"
    assert f"current_admission ?& {keys}" in sql
    assert f"current_admission - {keys} = '{{}}'::jsonb" in sql
    for field, kind in (("metadata_revision", "number"), ("observed_intervals", "array"),
                        ("admission_limited", "boolean"), ("extent_state", "string")):
        assert f"jsonb_typeof(current_admission->'{field}') = '{kind}'" in sql
    assert "(current_admission->>'metadata_revision')::numeric between 0 and 9007199254740991" in sql
    assert "jsonb_array_length(current_admission->'observed_intervals') between 1 and 4096" in sql
    assert "current_admission->'verified_total_frames' = 'null'::jsonb" in sql
    assert "current_admission->'extent_provenance' = 'null'::jsonb" in sql
    assert "current_admission->>'extent_provenance' = 'successful_from_zero_decode'" in sql
    assert "and lifecycle_state = 'retired' and retirement_reason = 'eos'" in sql


def test_live_links_cannot_rebind_original_identity_and_timestamps_cannot_precede_admission():
    sql = sql_text()
    for live, original in (("live_library_id", "original_library_id"),
                           ("live_track_id", "original_track_id"), ("live_file_id", "original_file_id")):
        assert f"({live} is null or {live} = {original})" in sql
    assert "(retired_at is null or retired_at >= admitted_at)" in sql
    assert "(accepted_at is null or accepted_at >= admitted_at)" in sql


def test_retirement_is_separate_from_client_finalization_and_has_consistent_nullability():
    sql = sql_text()
    assert "lifecycle_state in ('open', 'retired')" in sql
    assert "lifecycle_state = 'open' and retirement_reason is null and retired_at is null" in sql
    assert "lifecycle_state = 'retired' and retirement_reason is not null and retired_at is not null" in sql
    assert "retirement_reason in ('eos', 'cancelled', 'replaced', 'shutdown', 'error', 'source_changed')" in sql
    assert "finalized" not in sql


def test_broad_inherited_privileges_are_revoked_before_narrow_runtime_grants():
    sql = sql_text()
    table = "integration.measured_listen_admission"
    for role in ("public", "album_haven_readonly", "album_haven_app"):
        assert f"revoke all on {table} from {role}" in sql
    assert sql.index(f"revoke all on {table} from album_haven_app") < sql.index(
        f"grant select, insert on {table} to album_haven_app")
    assert not re.search(r"\bgrant\b[^;]*\bto (?:public|album_haven_readonly)\b", sql)
    assert not re.search(r"\bgrant\s+(?:all|update\s+on|delete|truncate|references|trigger)\b", sql)
    grants = re.findall(r"\bgrant\s+[^;]*;", sql)
    assert len(grants) == 2
    assert grants[0] == f"grant select, insert on {table} to album_haven_app;"
    assert not any(re.search(r"\b(?:all|delete|truncate|references|trigger)\b", grant) for grant in grants)
    update_grants = re.findall(r"grant update\s*\(([^)]*)\)\s+on " + re.escape(table)
                              + r" to album_haven_app", sql)
    assert len(update_grants) == 1
    columns = {column.strip() for column in update_grants[0].split(",")}
    assert columns == {"current_admission", "lifecycle_state", "retirement_reason", "retired_at",
                       "accepted_checkpoint", "accepted_admission", "accepted_digest",
                       "accepted_sequence", "receipt_body", "receipt_status", "accepted_at"}
    assert columns.isdisjoint({"account_id", "original_library_id", "original_track_id", "original_file_id",
                               "live_library_id", "live_track_id", "live_file_id", "device_id", "session_id",
                               "decoder_instance_id", "evidence_version", "sample_rate", "admitted_at"})
    assert "delete from" not in sql


def test_dormant_service_is_not_imported_or_called_by_playback_or_completion_owners():
    # This is a wiring guard only, not decoder, route, UI, or database acceptance.
    paths = ("music_app/routes/playback_stream_asgi.py", "music_app/services/playback_pcm.py",
             "music_app/routes/api_wave_b_asgi_routes.py",
             "music_app/static/js/runtime/player-streaming-engine.js",
             "music_app/static/js/runtime/player-listen-session-helpers.js")
    for relative in paths:
        source = (ROOT / relative).read_text(encoding="utf-8")
        assert "measured_listen_admission_postgres" not in source, relative
        assert "PostgresMeasuredListenAdmission" not in source, relative
