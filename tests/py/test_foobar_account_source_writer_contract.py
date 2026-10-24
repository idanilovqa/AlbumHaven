"""New pure/SQL-shape tests. No successful database or service doubles."""
import json
import inspect
from dataclasses import replace

import pytest

from music_app.services import foobar_snapshot_parser as parser
from music_app.services import foobar_source_evidence as evidence
from music_app.services import foobar_source_display as display
from music_app.services import foobar_account_source_postgres as writer


SOURCE = "11111111-1111-4111-8111-111111111111"
OBSERVATION = "22222222-2222-4222-8222-222222222222"


def make_fields(payload):
    parsed = parser.parse_foobar_snapshot(payload, mapping_name=evidence.PARSER_VERSION)
    assert parsed.status == "parsed"
    return evidence.fields_from_row(parsed.rows[0], upload_sha256=parsed.source_sha256), parsed


def make_item(payload=b"path\ttitle\n/private/song\tSong\n"):
    fields, parsed = make_fields(payload)
    return writer.SourceWrite(OBSERVATION, evidence.source_identity(fields,
        upload_sha256=parsed.source_sha256, ordinal=1, identity_conflict=False),
        None, None, None, evidence.encode_evidence(fields), display.encode_display(fields), evidence.encode_evidence(fields))


def test_display_has_only_seven_metadata_fields_and_preserves_absent_empty():
    fields, _ = make_fields(b"path\tartist\ttitle\tplay_count\tlast_played\n/secret\t\t<script>x</script>\t99\tnaive date\n")
    raw = display.encode_display(fields)
    root = json.loads(raw)
    assert root[0] == display.VERSION
    assert len(root[1]) == 7
    assert root[1][0] == ["empty", ""]
    assert root[1][1] == ["absent", None]
    assert root[1][3] == ["valid", "<script>x</script>"]
    assert b"/secret" not in raw and b"naive date" not in raw and b"99" not in raw
    assert display.display_size(fields) == len(raw)
    display.check_display(raw, fields)


def test_display_is_not_html_trusted_or_an_alternate_identity():
    fields, _ = make_fields(b"path\ttitle\n/a\t../../<img src=x>\n")
    assert json.loads(display.encode_display(fields))[1][3][1] == "../../<img src=x>"
    with pytest.raises(evidence.SourceEvidenceError):
        display.check_display(b'["foobar_source_display_v1",[]]', fields)
    with pytest.raises(evidence.SourceEvidenceError):
        display.check_display(display.encode_display(fields) + b" ", fields)


def test_control_character_label_size_and_phase_are_exact_and_bounded():
    fields, _ = make_fields(b"path\ttitle\n/a\t" + b"\x0b" * 16384 + b"\n")
    raw = display.encode_display(fields)
    assert len(raw) == display.display_size(fields)
    assert b"\\u000b" in raw
    assert display.display_phase_bytes(fields) == evidence.evidence_size(fields) + 5 * len(raw) + 229380


def test_source_frame_scalar_counter_matches_real_encoding_without_guessing_hex():
    item = make_item()
    phase, frame_size, base, result_size = writer.source_write_phase_bytes((item,),
        account_id=1, source_ref=SOURCE, generation=20747, expected_revision=0)
    frame = writer._frame((item,), 1, SOURCE, 20747, 0)
    assert len(frame) == frame_size
    assert json.loads(frame)[4][0][2] == item.identity_bytes.hex()
    assert phase >= base + 5 * frame_size + 2 + 2 * result_size
    assert phase <= writer.MAX_PHASE_BYTES


def test_source_plan_rejects_duplicate_observation_and_identity_before_frame():
    item = make_item()
    with pytest.raises(writer.SourceUnavailable):
        writer.source_write_phase_bytes((item, item), account_id=1,
            source_ref=SOURCE, generation=20747, expected_revision=0)


def test_malformed_returning_is_unavailable_but_missing_cas_is_stale():
    with pytest.raises(writer.SourceUnavailable) as failure:
        writer._returning([{"not_observation_ref": OBSERVATION}], (OBSERVATION,))
    assert failure.value.status_code == 503
    with pytest.raises(writer.SourceStale) as stale:
        writer._returning([], (OBSERVATION,))
    assert stale.value.status_code == 409


def test_noop_at_max_revision_does_not_request_successor():
    first = make_item()
    item = writer.SourceWrite(first.observation_ref, first.identity_bytes, writer.MAX_REVISION,
        evidence.evidence_digest(first.evidence_bytes), evidence.evidence_digest(first.display_bytes),
        first.evidence_bytes, first.display_bytes, first.incoming_evidence_bytes)
    row = {"ordinal": 1, "matching_count": 1, "observation_ref": OBSERVATION,
        "current_revision": writer.MAX_REVISION, "evidence_sha256": item.previous_evidence_sha256,
        "display_sha256": item.previous_display_sha256, "same_bytes": True,
        "incoming_evidence_sha256": evidence.evidence_digest(item.incoming_evidence_bytes),
        "incoming_exact": True}
    assert writer._check_current([row], (item,), incoming_digests=(row["incoming_evidence_sha256"],)) == (False,)
    writer._check_current([row], (item,), incoming_digests=(row["incoming_evidence_sha256"],), postcheck=True, changed=(False,), revision=writer.MAX_REVISION)


def test_complete_collision_stage_has_no_candidate_identity_equality():
    sql = writer._cardinality_sql()
    assert "limit 101" in sql
    assert "o.identity_bytes=i.identity_bytes" not in sql
    assert "left join integration.foobar_import_revisions" in sql
    current = writer._current_sql()
    assert "candidates as materialized" in current
    assert "limit 100" in current
    assert "c.identity_bytes=i.identity_bytes" in current
    assert "count(*) over () matching_count" in current


def test_mutation_sql_remains_scoped_source_only_and_revision_rows_immutable():
    statements = (writer._insert_observations_sql(), writer._insert_revisions_sql(), writer._advance_pointers_sql())
    for sql in statements:
        assert sql.count("%b") == 1
        assert "account_id" in sql and "library_id" not in sql and "source_ref" in sql
        assert "track_preferences" not in sql and "lastfm" not in sql.lower()
        assert "play_count" not in sql and "listen" not in sql
        assert "delete " not in sql.lower()
    assert "update integration.foobar_import_revisions" not in " ".join(statements)


def comparison(items, counts):
    _, frame_size, base, result_size = writer.source_write_phase_bytes(items,
        account_id=1, source_ref=SOURCE, generation=20747, expected_revision=1)
    # These are pure counter inputs, not a mocked database execution or proof.
    rows = [{"ordinal": index, "candidate_count": count, "comparison_bytes": count * 2048}
            for index, count in enumerate(counts, 1)]
    return writer.source_comparison_phase_bytes(rows, items,
        base=base, frame_size=frame_size, result_size=result_size)


def test_new_identity_cannot_turn_complete_100_bucket_into_101():
    item = make_item()
    assert comparison((item,), (99,)) < writer.MAX_PHASE_BYTES
    with pytest.raises(writer.SourceUnavailable):
        comparison((item,), (100,))
    body = inspect.getsource(writer.write_foobar_source_on_connection)
    assert body.index("source_comparison_phase_bytes(") < body.index("_current_sql()")
    assert body.index("source_comparison_phase_bytes(") < body.index("_insert_observations_sql()")


def test_same_existing_identity_is_not_counted_as_a_new_candidate():
    item = make_item()
    existing = replace(item, previous_revision=1,
        previous_evidence_sha256=evidence.evidence_digest(item.evidence_bytes),
        previous_display_sha256=evidence.evidence_digest(item.display_bytes))
    assert comparison((existing,), (100,)) < writer.MAX_PHASE_BYTES


def test_distinct_hash_buckets_have_independent_future_cardinalities():
    one = make_item()
    two = replace(make_item(b"path\ttitle\n/other\tOther\n"),
        observation_ref="33333333-3333-4333-8333-333333333333")
    assert evidence.evidence_digest(one.identity_bytes) != evidence.evidence_digest(two.identity_bytes)
    # Both 99-candidate buckets pass cardinality; both raw/effective documents
    # now make this combined phase exceed the unchanged cap, not raise here.
    assert comparison((one, two), (99, 99)) > writer.MAX_PHASE_BYTES


def test_later_101_rejects_entire_requested_lookup_without_truncation():
    one = make_item()
    two = replace(make_item(b"path\ttitle\n/other\tOther\n"),
        observation_ref="33333333-3333-4333-8333-333333333333")
    with pytest.raises(writer.SourceUnavailable):
        comparison((one, two), (0, 101))
