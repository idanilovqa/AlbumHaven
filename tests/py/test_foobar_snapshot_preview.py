"""Synthetic contract tests for the stateless Foobar exact-path preview.

No route, account authority, effective taste, playback or Apply is exercised.
"""
import ast
import builtins
import dataclasses
import inspect
import pathlib
import socket
import sys

import pytest

from music_app.services import foobar_snapshot_parser as parser
from music_app.services import foobar_snapshot_preview as preview


PARSER_VERSION = "foobar_text_tools_snapshot_v1"
CONTRACT_VERSION = "foobar_snapshot_preview_v1"
MATCHER_VERSION = "foobar_exact_path_v1"
FIELD_NAMES = (
    "path", "artist", "album_artist", "album", "date", "discnumber",
    "tracknumber", "title", "rating", "rating_stars", "rating_stars_fixed",
    "play_count", "play_count_enhanced", "first_played", "last_played", "added",
    "first_played_enhanced", "last_played_enhanced", "added_enhanced", "favorite",
    "length", "length_ex", "played_times", "played_times_js", "played_times_raw",
    "lastfm_played_times_js", "lastfm_play_count",
)
DATES = FIELD_NAMES[13:19]
HISTORY = FIELD_NAMES[22:]
TEXT_FIELDS = FIELD_NAMES[:8] + FIELD_NAMES[9:11] + FIELD_NAMES[20:22]
SUMMARY_FIELDS = (
    "rows_total", "exact_unique_rows", "ambiguous_rows", "unmatched_rows",
    "identity_conflict_rows", "duplicate_target_groups", "duplicate_target_rows",
    "rows_with_field_errors", "unsupported_nonempty_field_count",
)


class StringChild(str):
    pass


class IntChild(int):
    pass


class TupleChild(tuple):
    pass


class Poison:
    def __iter__(self):
        raise AssertionError("unexpected iteration")

    def __len__(self):
        raise AssertionError("unexpected length")

    def __str__(self):
        raise AssertionError("unexpected coercion")

    def __eq__(self, other):
        raise AssertionError("unexpected equality")


def parsed(headers=("path",), rows=(("x",),)):
    payload = ("\t".join(headers) + "\n" + "\n".join("\t".join(row) for row in rows)).encode()
    result = parser.parse_foobar_snapshot(payload, mapping_name=PARSER_VERSION)
    assert result.status == "parsed", result
    return result


def entry(file_ref="f1", track="t1", path="x", conflict=False):
    return preview.InventoryEntry(file_ref, track, path, conflict)


def build(source, inventory=(), revision="r1"):
    return preview.build_foobar_preview(source, inventory=inventory, inventory_revision=revision)


def observation(row, name):
    return row.fields[FIELD_NAMES.index(name)]


def replace_row(source, **changes):
    return dataclasses.replace(source, rows=(dataclasses.replace(source.rows[0], **changes),) + source.rows[1:])


def replace_observation(source, name, **changes):
    fields = list(source.rows[0].fields)
    index = FIELD_NAMES.index(name)
    fields[index] = dataclasses.replace(fields[index], **changes)
    return replace_row(source, fields=tuple(fields))


def child_of(value):
    child_type = type("RecordChild", (type(value),), {})
    return child_type(*(getattr(value, f.name) for f in dataclasses.fields(value)))


def reject(source, reason="invalid_input", *, inventory=(), revision="r1"):
    result = build(source, inventory, revision)
    assert type(result) is preview.PreviewReport
    assert (result.contract_version, result.matcher_version, result.status, result.reason) == (
        CONTRACT_VERSION, MATCHER_VERSION, "rejected", reason,
    )
    assert result.parser_version is result.source_sha256 is result.inventory_revision is None
    assert type(result.rows) is tuple and result.rows == ()
    assert type(result.summary) is preview.PreviewSummary
    assert tuple(getattr(result.summary, name) for name in SUMMARY_FIELDS) == (0,) * 9
    assert all(type(getattr(result.summary, name)) is int for name in SUMMARY_FIELDS)
    return result


def row_result(row, status, refs=(), suggested=None, group=None, total=None):
    assert row.match_status == status
    assert type(row.candidate_refs) is tuple and row.candidate_refs == refs
    assert row.suggested_track_ref == suggested
    assert row.duplicate_target_group == group
    count = len(refs) if total is None else total
    assert type(row.candidate_count) is int and row.candidate_count == count
    assert type(row.candidates_truncated) is bool
    assert row.candidates_truncated is (count > 20)


def test_signature_has_only_eager_data_and_keyword_inventory():
    signature = inspect.signature(preview.build_foobar_preview)
    assert tuple(signature.parameters) == ("parsed", "inventory", "inventory_revision")
    assert signature.parameters["parsed"].kind is inspect.Parameter.POSITIONAL_OR_KEYWORD
    for name in ("inventory", "inventory_revision"):
        assert signature.parameters[name].kind is inspect.Parameter.KEYWORD_ONLY
        assert signature.parameters[name].default is inspect.Parameter.empty
    with pytest.raises(TypeError):
        preview.build_foobar_preview(parsed())
    with pytest.raises(TypeError):
        preview.build_foobar_preview(parsed(), (), "r1")
    with pytest.raises(TypeError):
        preview.build_foobar_preview(parsed(), inventory=(), inventory_revision="r1", apply=True)


@pytest.mark.parametrize("kind,names", [
    ("InventoryEntry", ("file_ref", "canonical_track_ref", "path", "identity_conflict")),
    ("PreviewReport", ("contract_version", "matcher_version", "status", "reason", "parser_version", "source_sha256", "inventory_revision", "rows", "summary")),
    ("PreviewRow", ("ordinal", "line_number", "source_row", "match_status", "suggested_track_ref", "candidate_refs", "candidate_count", "candidates_truncated", "duplicate_target_group", "evidence_labels")),
    ("PreviewSummary", SUMMARY_FIELDS),
    ("EvidenceLabel", ("field_name", "category", "state")),
], ids=["inventory", "report", "row", "summary", "label"])
def test_exact_frozen_slot_dto_fields(kind, names):
    cls = getattr(preview, kind)
    assert dataclasses.is_dataclass(cls)
    assert cls.__dataclass_params__.frozen is True
    assert tuple(f.name for f in dataclasses.fields(cls)) == names
    assert tuple(cls.__slots__) == names


def test_ready_envelope_empty_complete_inventory_and_immutable_graph():
    source = parsed(("path", "rating"), (("private-synthetic-path", "5"),))
    result = build(source)
    assert (result.contract_version, result.matcher_version, result.status, result.reason) == (
        CONTRACT_VERSION, MATCHER_VERSION, "ready", None,
    )
    assert result.parser_version == PARSER_VERSION
    assert result.source_sha256 == source.source_sha256 and result.inventory_revision == "r1"
    assert type(result.rows) is tuple and len(result.rows) == 1
    row_result(result.rows[0], "unmatched")
    assert result.rows[0].source_row is source.rows[0]
    assert (result.rows[0].ordinal, result.rows[0].line_number) == (1, 2)
    for obj in (entry(), result, result.rows[0], result.summary, result.rows[0].evidence_labels[0]):
        assert not hasattr(obj, "__dict__")
        with pytest.raises(dataclasses.FrozenInstanceError):
            setattr(obj, dataclasses.fields(obj)[0].name, None)
    assert tuple(getattr(result.summary, name) for name in SUMMARY_FIELDS) == (1, 0, 0, 1, 0, 0, 0, 0, 0)
    assert all(type(getattr(result.summary, name)) is int for name in SUMMARY_FIELDS)


@pytest.mark.parametrize("value", [None, {}, (), [], 1, True, Poison()],
                         ids=["none", "mapping", "tuple", "list", "int", "bool", "poison"])
def test_wrong_outer_parser_type_precedes_every_inventory_error(value):
    reject(value, inventory=Poison(), revision=Poison())


def test_parser_and_nested_dataclass_subclasses_are_not_admitted():
    source = parsed(("path", "rating"), (("x", "bad"),))
    for malformed in (
        child_of(source),
        dataclasses.replace(source, summary=child_of(source.summary)),
        dataclasses.replace(source, rows=(child_of(source.rows[0]),)),
        replace_row(source, fields=(child_of(source.rows[0].fields[0]),) + source.rows[0].fields[1:]),
        dataclasses.replace(source, diagnostics=(child_of(source.diagnostics[0]),)),
    ):
        reject(malformed)


@pytest.mark.parametrize("version,reason", [
    (None, "invalid_input"), (1, "invalid_input"), (True, "invalid_input"),
    (StringChild(PARSER_VERSION), "invalid_input"), (Poison(), "invalid_input"),
    ("", "unsupported_parser_version"), ("future", "unsupported_parser_version"),
    (PARSER_VERSION.upper(), "unsupported_parser_version"),
], ids=["none", "int", "bool", "subclass", "poison", "empty", "future", "case"])
def test_version_precedes_malformed_status_rows_and_inventory(version, reason):
    source = dataclasses.replace(parsed(), contract_version=version, status=None, rows=[])
    reject(source, reason, inventory=Poison(), revision=Poison())


@pytest.mark.parametrize("name,value", [
    ("status", None), ("status", "ready"), ("status", StringChild("parsed")),
    ("source_sha256", None), ("source_sha256", "A" * 64), ("source_sha256", "a" * 63),
    ("source_sha256", "a" * 65), ("source_sha256", "g" * 64), ("source_sha256", b"a" * 64),
    ("source_sha256", StringChild("a" * 64)), ("headers", []), ("headers", TupleChild(("path",))),
    ("rows", []), ("rows", TupleChild(())), ("diagnostics", []),
    ("diagnostics", TupleChild(())), ("summary", {}), ("rows", (None,)),
], ids=["status-null", "status-other", "status-child", "digest-null", "digest-upper", "digest-short",
        "digest-long", "digest-not-hex", "digest-bytes", "digest-child", "headers-list", "headers-child",
        "rows-list", "rows-child", "diagnostics-list", "diagnostics-child", "summary-map", "row-null"])
def test_outer_parser_scalar_and_container_validation(name, value):
    reject(dataclasses.replace(parsed(), **{name: value}), inventory=Poison(), revision=Poison())


@pytest.mark.parametrize("name", ["data_rows", "rows_without_field_errors", "rows_with_field_errors",
                                  "field_error_count", "unsupported_nonempty_field_count", "diagnostic_count"])
@pytest.mark.parametrize("value", [-1, True, 1.0, IntChild(1), None],
                         ids=["negative", "bool", "float", "child", "none"])
def test_every_summary_integer_is_exact_nonnegative(name, value):
    source = parsed()
    reject(dataclasses.replace(source, summary=dataclasses.replace(source.summary, **{name: value})))


@pytest.mark.parametrize("value", [0, 1, None, "false"], ids=["zero", "one", "none", "text"])
def test_summary_truncation_is_exact_bool(value):
    source = parsed()
    reject(dataclasses.replace(source, summary=dataclasses.replace(source.summary, diagnostics_truncated=value)))


def test_genuine_shaped_parser_rejection_precedes_all_inventory_arguments():
    source = parser.parse_foobar_snapshot(b"", mapping_name=PARSER_VERSION)
    reject(source, "parser_rejected", inventory=Poison(), revision=Poison())
    reject(dataclasses.replace(source, source_sha256=None), "parser_rejected", inventory=[], revision=None)
    diagnostic = parser.Diagnostic("synthetic_rejection", 1, 0)
    reject(dataclasses.replace(source, diagnostics=(diagnostic,)), "parser_rejected")


@pytest.mark.parametrize("mutation", [
    lambda s: dataclasses.replace(s, headers=("path",)),
    lambda s: dataclasses.replace(s, rows=parsed().rows),
    lambda s: dataclasses.replace(s, diagnostics=()),
    lambda s: dataclasses.replace(s, diagnostics=s.diagnostics * 2),
    lambda s: dataclasses.replace(s, diagnostics=(None,)),
    lambda s: dataclasses.replace(s, summary=dataclasses.replace(s.summary, data_rows=1)),
    lambda s: dataclasses.replace(s, summary=dataclasses.replace(s.summary, diagnostics_truncated=True)),
], ids=["headers", "rows", "no-diagnostic", "two-diagnostics", "wrong-diagnostic", "summary", "truncation"])
def test_malformed_parser_rejection_is_invalid_input_not_parser_rejected(mutation):
    source = parser.parse_foobar_snapshot(b"", mapping_name=PARSER_VERSION)
    reject(mutation(source), inventory=Poison(), revision=Poison())


@pytest.mark.parametrize("code", ["", "x" * 129, "é" * 65, "\ud800", 1, StringChild("bad")],
                         ids=["empty", "long", "multibyte-long", "surrogate", "int", "child"])
def test_rejected_diagnostic_codes_are_strict_bounded_utf8(code):
    source = parser.parse_foobar_snapshot(b"", mapping_name=PARSER_VERSION)
    reject(dataclasses.replace(source, diagnostics=(parser.Diagnostic(code, None, None),)))


@pytest.mark.parametrize("line,column", [(0, None), (-1, None), (True, None), (IntChild(1), None),
                                         (None, -1), (None, True), (None, IntChild(0)), ("1", 0)],
                         ids=["line-zero", "line-negative", "line-bool", "line-child", "column-negative", "column-bool", "column-child", "line-text"])
def test_rejected_diagnostic_locations_exclude_bool_and_subclasses(line, column):
    source = parser.parse_foobar_snapshot(b"", mapping_name=PARSER_VERSION)
    reject(dataclasses.replace(source, diagnostics=(parser.Diagnostic("bad", line, column),)))


@pytest.mark.parametrize("headers", [(), ("title",), ("path", "path"), ("path", ""),
                                    ("path", " bad"), ("path", "bad "), ("path", "bad\t"),
                                    ("path", 1), (StringChild("path"),), ("path", "\ud800")],
                         ids=["empty", "missing-path", "duplicate", "empty-name", "leading-space", "trailing-space", "tab", "int", "child", "surrogate"])
def test_invalid_header_shapes_fail_before_inventory(headers):
    reject(dataclasses.replace(parsed(), headers=headers), inventory=Poison())


@pytest.mark.parametrize("codepoint", tuple(range(32)) + (127,), ids=[f"c{i}" for i in (*range(32), 127)])
def test_all_c0_and_del_header_characters_are_invalid(codepoint):
    source = parsed(("path", "other"), (("x", "y"),))
    reject(dataclasses.replace(source, headers=("path", "bad" + chr(codepoint))))


@pytest.mark.parametrize("name,value", [
    ("ordinal", True), ("ordinal", IntChild(1)), ("ordinal", 0), ("ordinal", 2),
    ("line_number", True), ("line_number", IntChild(2)), ("line_number", 1),
    ("cells", ["x"]), ("cells", TupleChild(("x",))), ("cells", ()), ("cells", ("x", "y")),
    ("cells", (1,)), ("cells", (StringChild("x"),)), ("cells", ("\ud800",)),
    ("fields", []), ("fields", TupleChild(())), ("fields", ()),
    ("field_error_count", True), ("field_error_count", IntChild(0)), ("field_error_count", -1),
], ids=["ordinal-bool", "ordinal-child", "ordinal-zero", "ordinal-other", "line-bool", "line-child", "line-other",
        "cells-list", "cells-child", "cells-empty", "cells-wide", "cell-int", "cell-child", "cell-surrogate",
        "fields-list", "fields-child", "fields-empty", "errors-bool", "errors-child", "errors-negative"])
def test_row_scalar_container_and_cell_types_are_exact(name, value):
    reject(replace_row(parsed(), **{name: value}))


def test_row_order_requires_all_ordinals_and_line_numbers():
    source = parsed(rows=(("x",), ("y",)))
    reject(dataclasses.replace(source, rows=tuple(reversed(source.rows))))
    reject(dataclasses.replace(source, rows=(source.rows[0], dataclasses.replace(source.rows[1], line_number=99))))


@pytest.mark.parametrize("value", [None, {}, (), "valid"], ids=["none", "mapping", "tuple", "text"])
def test_observation_record_is_exact(value):
    source = parsed()
    reject(replace_row(source, fields=(value,) + source.rows[0].fields[1:]))


@pytest.mark.parametrize("changes", [
    {"state": None}, {"state": "unknown"}, {"state": StringChild("valid")},
    {"column_index": None}, {"column_index": True}, {"column_index": IntChild(0)},
    {"column_index": 1}, {"state": "absent", "value": None},
    {"state": "empty", "value": None}, {"state": "invalid", "value": None, "code": "bad"},
    {"value": "wrong"}, {"value": StringChild("x")}, {"code": "bad"},
], ids=["null-state", "unknown-state", "state-child", "column-none", "column-bool", "column-child", "column-other",
        "present-absent", "forged-empty-path", "forged-invalid-path", "raw-mismatch", "value-child", "valid-code"])
def test_named_path_observation_must_agree_with_raw_cell(changes):
    reject(replace_observation(parsed(), "path", **changes))


@pytest.mark.parametrize("changes", [{"column_index": 0}, {"state": "empty"}, {"value": "invented"}, {"code": "bad"}],
                         ids=["column", "state", "value", "code"])
def test_absent_observation_has_no_column_value_or_code(changes):
    reject(replace_observation(parsed(), "rating", **changes))


@pytest.mark.parametrize("state,raw", [("empty", ""), ("unavailable", "N/A")])
@pytest.mark.parametrize("changes", [{"value": 0}, {"code": "bad"}, {"column_index": None}, {"state": "absent"}],
                         ids=["value", "code", "column", "absent"])
def test_present_empty_and_unavailable_special_states_are_null(state, raw, changes):
    source = parsed(("path", "play_count"), (("x", raw),))
    assert observation(source.rows[0], "play_count").state == state
    reject(replace_observation(source, "play_count", **changes))


@pytest.mark.parametrize("name,raw", [("rating", "bad"), ("played_times", "[]")], ids=["invalid", "unsupported"])
@pytest.mark.parametrize("changes", [{"value": 1}, {"code": None}, {"code": ""}, {"code": "x" * 129},
                                     {"code": "é" * 65}, {"code": "\ud800"}, {"code": StringChild("bad")}],
                         ids=["value", "null-code", "empty-code", "long-code", "multibyte-code", "surrogate-code", "child-code"])
def test_error_observations_require_null_values_and_bounded_exact_codes(name, raw, changes):
    source = replace_observation(parsed(("path", name), (("x", raw),)), name, **changes)
    if "code" in changes:
        source = dataclasses.replace(source, diagnostics=(
            dataclasses.replace(source.diagnostics[0], code=changes["code"]),
        ))
    reject(source)


@pytest.mark.parametrize("name,raw,value", [
    ("rating", "5", True), ("rating", "5", 0), ("rating", "5", 6), ("rating", "5", 5.0), ("rating", "5", IntChild(5)),
    ("favorite", "1", 1), ("favorite", "1", "true"),
    ("play_count", "0", False), ("play_count", "0", -1), ("play_count", "0", 9223372036854775808),
    ("play_count_enhanced", "1", IntChild(1)), ("play_count_enhanced", "1", 1.0),
    ("first_played", "raw date", "different"), ("first_played", "raw date", 1),
], ids=["rating-bool", "rating-low", "rating-high", "rating-float", "rating-child", "favorite-int", "favorite-str",
        "count-bool", "count-low", "count-high", "enhanced-child", "enhanced-float", "date-converted", "date-int"])
def test_valid_observation_types_and_count_bounds(name, raw, value):
    reject(replace_observation(parsed(("path", name), (("x", raw),)), name, value=value))


@pytest.mark.parametrize("name", HISTORY)
def test_history_cannot_be_promoted_to_valid_even_with_consistent_accounting(name):
    source = parsed(("path", name), (("x", "[]"),))
    forged = replace_observation(source, name, state="valid", value="[]", code=None)
    forged = replace_row(forged, field_error_count=0)
    forged = dataclasses.replace(forged, diagnostics=(), summary=parser.ParseSummary(1, 1, 0, 0, 0, 0, False))
    reject(forged)


@pytest.mark.parametrize("name", TEXT_FIELDS)
def test_ordinary_text_never_turns_literal_na_or_whitespace_into_unavailable(name):
    headers = ("path",) if name == "path" else ("path", name)
    raw_rows = (("N/A",),) if name == "path" else (("x", "N/A"),)
    source = parsed(headers, raw_rows)
    result = build(source)
    assert observation(result.rows[0].source_row, name).value == "N/A"
    reject(replace_observation(source, name, state="unavailable", value=None))
    reject(replace_observation(source, name, value="other"))


@pytest.mark.parametrize("name", DATES)
def test_raw_date_values_are_preserved_without_time_conversion(name):
    source = parsed(("path", name), (("x", " 2025-11-02 01:30:00 "),))
    result = build(source)
    assert observation(result.rows[0].source_row, name).value == " 2025-11-02 01:30:00 "
    reject(replace_observation(source, name, value="2025-11-02T01:30:00Z"))


def test_structural_validation_does_not_reparse_well_shaped_special_values():
    source = parsed(("path", "play_count", "rating", "favorite"), (("x", "12", "5", "1"),))
    # Structural validation is not authentication of source semantics or digest.
    source = replace_observation(source, "play_count", value=13)
    source = replace_observation(source, "rating", value=4)
    source = replace_observation(source, "favorite", value=False)
    source = dataclasses.replace(source, source_sha256="0" * 64)
    result = build(source)
    assert result.status == "ready" and result.source_sha256 == "0" * 64
    assert result.rows[0].source_row is source.rows[0]


@pytest.mark.parametrize("mutation", [
    lambda s: replace_row(s, field_error_count=1),
    lambda s: dataclasses.replace(s, summary=dataclasses.replace(s.summary, data_rows=2)),
    lambda s: dataclasses.replace(s, summary=dataclasses.replace(s.summary, rows_without_field_errors=1)),
    lambda s: dataclasses.replace(s, summary=dataclasses.replace(s.summary, rows_with_field_errors=0)),
    lambda s: dataclasses.replace(s, summary=dataclasses.replace(s.summary, field_error_count=1)),
    lambda s: dataclasses.replace(s, summary=dataclasses.replace(s.summary, unsupported_nonempty_field_count=0)),
    lambda s: dataclasses.replace(s, summary=dataclasses.replace(s.summary, diagnostic_count=1)),
    lambda s: dataclasses.replace(s, summary=dataclasses.replace(s.summary, diagnostics_truncated=True)),
    lambda s: dataclasses.replace(s, diagnostics=tuple(reversed(s.diagnostics))),
    lambda s: dataclasses.replace(s, diagnostics=s.diagnostics[:1]),
], ids=["row-errors", "row-count", "clean-count", "dirty-count", "errors", "unsupported", "diagnostic-count", "truncated", "diagnostic-order", "missing-diagnostic"])
def test_error_accounting_and_first_diagnostic_sequence_are_exact(mutation):
    # Reordered headers deliberately disagree with FIELD_NAMES order.
    source = parsed(("played_times", "path", "rating"), (("[]", "x", "bad"),))
    reject(mutation(source))


@pytest.mark.parametrize("changes", [{"code": StringChild("invalid_rating")}, {"code": None}, {"code": "other"},
                                     {"line_number": True}, {"line_number": IntChild(2)}, {"line_number": None},
                                     {"column_index": True}, {"column_index": IntChild(1)}, {"column_index": None}],
                         ids=["code-child", "code-none", "code-other", "line-bool", "line-child", "line-none", "column-bool", "column-child", "column-none"])
def test_parsed_diagnostics_validate_types_before_dataclass_equality(changes):
    source = parsed(("path", "rating"), (("x", "bad"),))
    reject(dataclasses.replace(source, diagnostics=(dataclasses.replace(source.diagnostics[0], **changes),)))


@pytest.mark.parametrize("inventory", [None, [], {}, iter(()), TupleChild(()), Poison()],
                         ids=["none", "list", "mapping", "iterator", "child", "poison"])
def test_inventory_requires_exact_tuple_before_revision(inventory):
    reject(parsed(), "invalid_inventory", inventory=inventory, revision=Poison())


@pytest.mark.parametrize("revision", [None, 1, True, b"r1", "", "a" * 129, "é" * 65, "\ud800", StringChild("r1"), Poison()],
                         ids=["none", "int", "bool", "bytes", "empty", "ascii-long", "utf8-long", "surrogate", "child", "poison"])
def test_revision_invalid_before_entry_validation(revision):
    reject(parsed(), "invalid_inventory_revision", inventory=(Poison(),), revision=revision)


@pytest.mark.parametrize("revision", ["a" * 128, "é" * 64, "r1", "0", " ", "../opaque"],
                         ids=["ascii-boundary", "utf8-boundary", "opaque", "zero-text", "space", "pathlike"])
def test_revision_is_opaque_bounded_text_not_a_numeric_counter(revision):
    result = build(parsed(), revision=revision)
    assert result.status == "ready" and result.inventory_revision == revision


@pytest.mark.parametrize("value", [None, {}, (), Poison()], ids=["none", "mapping", "tuple", "poison"])
def test_inventory_entries_require_exact_dto(value):
    reject(parsed(), "invalid_inventory", inventory=(value,))


def test_inventory_entry_subclass_and_identical_duplicate_refs_are_invalid():
    reject(parsed(), "invalid_inventory", inventory=(child_of(entry()),))
    for second in (entry(), entry(path="elsewhere"), entry(track="other")):
        reject(parsed(), "invalid_inventory", inventory=(entry(), second))


@pytest.mark.parametrize("name", ["file_ref", "canonical_track_ref", "path"])
@pytest.mark.parametrize("value", [None, 1, True, b"x", "", StringChild("x"), "\ud800", Poison()],
                         ids=["none", "int", "bool", "bytes", "empty", "child", "surrogate", "poison"])
def test_inventory_text_fields_are_nonempty_exact_strict_utf8(name, value):
    reject(parsed(), "invalid_inventory", inventory=(dataclasses.replace(entry(), **{name: value}),))


@pytest.mark.parametrize("value", [None, 0, 1, "false", Poison()], ids=["none", "zero", "one", "text", "poison"])
def test_inventory_conflict_is_exact_bool(value):
    reject(parsed(), "invalid_inventory", inventory=(entry(conflict=value),))


@pytest.mark.parametrize("name,limit", [("file_ref", 128), ("canonical_track_ref", 128), ("path", 16384)])
@pytest.mark.parametrize("character,width", [("a", 1), ("é", 2)], ids=["ascii", "utf8"])
def test_inventory_individual_byte_boundaries(name, limit, character, width):
    at = character * (limit // width)
    result = build(parsed(), inventory=(dataclasses.replace(entry(), **{name: at}),))
    assert result.status == "ready"
    reject(parsed(), "invalid_inventory", inventory=(dataclasses.replace(entry(), **{name: at + "x"}),))


def test_parser_errors_win_over_invalid_inventory_and_revision():
    reject(replace_observation(parsed(), "path", value="forged"), inventory=[], revision=None)
    source = dataclasses.replace(parsed(), contract_version="future")
    reject(source, "unsupported_parser_version", inventory=[], revision=None)


@pytest.mark.parametrize("raw", ["N/A", " ", "..", "file:///synthetic/x", "https://example.invalid/music", "é", "e\u0301", r"C:\\Music\\x"],
                         ids=["literal-na", "space", "dotdot", "file-uri", "web-uri", "composed", "decomposed", "windows"])
def test_nonempty_path_is_literal_and_matches_only_exact_inventory(raw):
    source = parsed(rows=((raw,),))
    result = build(source, (entry(path=raw),))
    row_result(result.rows[0], "exact_unique", ("t1",), "t1")
    assert result.rows[0].source_row is source.rows[0]


@pytest.mark.parametrize("raw,other", [("X", "x"), (r"C:\Music\x", "C:/Music/x"), ("é", "e\u0301"),
                                      ("/a/../x", "/x"), ("/one/x", "/two/x"), ("file:///x", "/x"),
                                      (" x", "x"), ("x ", "x")],
                         ids=["case", "slash", "unicode", "dotdot", "basename", "uri", "leading", "trailing"])
def test_no_path_normalization_resolution_or_basename_fallback(raw, other):
    row_result(build(parsed(rows=((raw,),)), (entry(path=other),)).rows[0], "unmatched")


def test_reordered_path_column_ignores_decoy_first_cell_and_metadata():
    source = parsed(("title", "artist", "path"), (("decoy", "artist", "real"),))
    result = build(source, (entry("f-decoy", "wrong", "decoy"), entry("f-real", "right", "real")))
    row_result(result.rows[0], "exact_unique", ("right",), "right")
    assert result.rows[0].source_row is source.rows[0]
    row_result(build(source, (entry("f-decoy", "wrong", "decoy"),)).rows[0], "unmatched")


def test_empty_path_with_populated_title_stays_unmatched():
    source = parsed(("title", "path"), (("not-a-path", ""),))
    result = build(source, (entry(path="not-a-path"),))
    row_result(result.rows[0], "unmatched")
    assert observation(result.rows[0].source_row, "path").state == "empty"
    assert observation(result.rows[0].source_row, "title").value == "not-a-path"


def test_several_files_with_same_canonical_reference_are_one_candidate():
    result = build(parsed(), (entry("f1"), entry("f2"), entry("f3")))
    row_result(result.rows[0], "exact_unique", ("t1",), "t1")


@pytest.mark.parametrize("count", [1, 2, 20, 21], ids=["one", "two", "twenty", "twenty-one"])
@pytest.mark.parametrize("conflict", [False, True], ids=["clean", "conflict"])
def test_exact_candidate_count_sorting_truncation_and_conflict_precedence(count, conflict):
    refs = tuple(f"track-{i:02}" for i in range(count))
    inventory = tuple(entry(f"file-{i}", refs[i], conflict=(conflict and i == count - 1)) for i in reversed(range(count)))
    result = build(parsed(), inventory)
    status = "identity_conflict" if conflict else ("exact_unique" if count == 1 else "ambiguous")
    row_result(result.rows[0], status, refs[:20], refs[0] if status == "exact_unique" else None, total=count)


def test_conflict_is_path_local_not_inferred_canonical_wide():
    source = parsed(rows=(("x",), ("y",)))
    result = build(source, (entry("fx", "shared", "x", False), entry("fy", "shared", "y", True)))
    row_result(result.rows[0], "exact_unique", ("shared",), "shared")
    row_result(result.rows[1], "identity_conflict", ("shared",))


def test_conflicting_duplicate_canonical_entry_blocks_path_suggestion():
    result = build(parsed(), (entry("a"), entry("b", conflict=True)))
    row_result(result.rows[0], "identity_conflict", ("t1",))


def test_duplicate_groups_count_all_members_and_do_not_select_ambiguous_or_conflicted():
    source = parsed(rows=(("a",), ("a",), ("b",), ("c",), ("c",), ("u",), ("z",), ("z",), ("q",)))
    inventory = (entry("fa", "A", "a"), entry("fb", "A", "b"), entry("fc", "B", "c"),
                 entry("fz1", "A", "z"), entry("fz2", "Z", "z"), entry("fq", "B", "q", True))
    result = build(source, inventory)
    assert len(result.rows) == 9
    assert [r.duplicate_target_group for r in result.rows] == ["A", "A", "A", "B", "B", None, None, None, None]
    assert tuple(getattr(result.summary, n) for n in SUMMARY_FIELDS) == (9, 5, 2, 1, 1, 2, 5, 0, 0)
    for source_row, row in zip(source.rows, result.rows):
        assert row.source_row is source_row and row.ordinal == source_row.ordinal
    assert result.rows[0].source_row.cells == result.rows[1].source_row.cells
    assert result.rows[0].ordinal != result.rows[1].ordinal
    assert result.rows[0].candidate_refs is result.rows[1].candidate_refs


def test_input_order_does_not_change_candidate_projection_or_source_row_order():
    source = parsed(rows=(("x",), ("y",), ("x",)))
    inventory = (entry("f1", "é"), entry("f2", "Z"), entry("f3", "a"), entry("f4", "a"))
    forward = build(source, inventory)
    backward = build(source, tuple(reversed(inventory)))
    assert forward == backward
    assert forward.rows[0].candidate_refs == ("Z", "a", "é")
    assert forward.rows[0].candidate_refs is forward.rows[2].candidate_refs
    assert [row.ordinal for row in forward.rows] == [1, 2, 3]
    assert [row.match_status for row in forward.rows] == ["ambiguous", "unmatched", "ambiguous"]


def test_repeat_equality_revision_provenance_and_no_input_mutation():
    source = parsed(("path", "rating"), (("x", "5"), ("x", "4")))
    inventory = (entry(),)
    before_source, before_inventory = repr(source), repr(inventory)
    first, repeated = build(source, inventory), build(source, inventory)
    changed = build(source, inventory, "r2")
    assert first == repeated and first != changed
    assert first.rows == changed.rows and first.summary == changed.summary
    assert first.inventory_revision == "r1" and changed.inventory_revision == "r2"
    assert repr(source) == before_source and repr(inventory) == before_inventory


def test_absent_empty_unavailable_zero_false_and_invalid_fields_remain_distinct():
    source = parsed(("path", "play_count", "favorite", "rating"),
                    (("a", "", "", ""), ("b", "N/A", "N/A", "bad"), ("c", "0", "0", "5")))
    result = build(source)
    assert [observation(r.source_row, "play_count").state for r in result.rows] == ["empty", "unavailable", "valid"]
    assert observation(result.rows[2].source_row, "play_count").value == 0
    assert type(observation(result.rows[2].source_row, "play_count").value) is int
    assert observation(result.rows[2].source_row, "favorite").value is False
    assert all(observation(r.source_row, "play_count_enhanced").state == "absent" for r in result.rows)
    assert observation(result.rows[1].source_row, "rating").state == "invalid"
    assert result.summary.rows_with_field_errors == 1


def test_independent_standard_enhanced_counts_and_invalid_rating_do_not_remove_row():
    source = parsed(("path", "play_count", "play_count_enhanced", "rating"),
                    (("x", "12", "9007199254740993", "bad"), ("y", "0", "9223372036854775807", "5")))
    result = build(source, (entry(),))
    assert len(result.rows) == 2 and result.summary.rows_with_field_errors == 1
    assert [(observation(r.source_row, "play_count").value,
             observation(r.source_row, "play_count_enhanced").value) for r in result.rows] == [(12, 9007199254740993), (0, 9223372036854775807)]
    row_result(result.rows[0], "exact_unique", ("t1",), "t1")


def test_all_evidence_categories_follow_field_order_not_header_order():
    header = tuple(reversed(FIELD_NAMES))
    values = {name: "raw" for name in FIELD_NAMES}
    values.update(path="x", rating="5", favorite="0", play_count="2", play_count_enhanced="3")
    source = parsed(header, (tuple(values[name] for name in header),))
    labels = build(source).rows[0].evidence_labels
    categories = {"rating": "source_taste_observation", "favorite": "source_taste_observation",
                  "play_count": "aggregate_count", "play_count_enhanced": "aggregate_count",
                  **{name: "raw_date_boundary" for name in DATES},
                  **{name: "local_history_field_unparsed" for name in HISTORY[:3]},
                  "lastfm_played_times_js": "lastfm_history_field_unparsed",
                  "lastfm_play_count": "lastfm_count_field_unparsed"}
    expected = tuple((name, categories[name], observation(source.rows[0], name).state)
                     for name in FIELD_NAMES if name in categories)
    assert type(labels) is tuple
    assert tuple((label.field_name, label.category, label.state) for label in labels) == expected
    for label in labels:
        assert type(label) is preview.EvidenceLabel
        assert all(type(getattr(label, name)) is str for name in ("field_name", "category", "state"))


@pytest.mark.parametrize("raw,state", [("", "empty"), ("N/A", "unavailable"), ("[]", "unsupported"),
                                       ("[1,2,3]", "unsupported"), ("broken json", "unsupported")],
                         ids=["empty", "unavailable", "empty-array", "array", "malformed"])
def test_all_history_fields_keep_parser_state_and_never_become_events(raw, state):
    source = parsed(("path",) + HISTORY, (("x",) + (raw,) * len(HISTORY),))
    result = build(source)
    assert result.rows[0].source_row is source.rows[0]
    assert tuple(label.state for label in result.rows[0].evidence_labels) == (state,) * 5
    assert result.summary.unsupported_nonempty_field_count == (5 if state == "unsupported" else 0)
    assert result.summary.rows_with_field_errors == (1 if state == "unsupported" else 0)
    assert all(observation(result.rows[0].source_row, name).value is None for name in HISTORY)


def test_evidence_only_includes_present_mapped_fields_even_when_empty():
    source = parsed(("title", "path", "favorite", "play_count"), (("N/A", "x", "", "0"),))
    labels = build(source).rows[0].evidence_labels
    assert tuple((l.field_name, l.state) for l in labels) == (("play_count", "valid"), ("favorite", "empty"))
    assert build(parsed()).rows[0].evidence_labels == ()


@pytest.mark.parametrize("mode", ["unmatched", "ambiguous", "identity_conflict"])
def test_unresolved_source_records_keep_metadata_without_fabricated_availability(mode):
    source = parsed(("path", "title", "artist", "album", "unknown"), (("x", "N/A", "", "Album", "opaque"),))
    inventory = () if mode == "unmatched" else (entry(conflict=mode == "identity_conflict"),)
    if mode == "ambiguous":
        inventory += (entry("f2", "t2"),)
    result = build(source, inventory)
    row = result.rows[0]
    assert row.match_status == mode and row.source_row is source.rows[0]
    assert row.source_row.cells == ("x", "N/A", "", "Album", "opaque")
    assert observation(row.source_row, "artist").state == "empty"
    assert observation(row.source_row, "title").value == "N/A"
    assert observation(row.source_row, "album_artist").state == "absent"
    for obj in (result, result.summary, row):
        names = {f.name for f in dataclasses.fields(obj)}
        assert names.isdisjoint({"remote_only", "playable", "url", "authorized", "can_apply", "apply", "events",
                                 "exact_plays", "measured_minutes", "effective_count", "imported", "eligible", "accepted"})


def test_service_imports_only_standard_library_and_accepted_parser():
    tree = ast.parse(pathlib.Path(preview.__file__).read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            assert all(alias.name == "music_app.services.foobar_snapshot_parser"
                       or alias.name.split(".")[0] in sys.stdlib_module_names for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            if node.module in ("music_app.services.foobar_snapshot_parser", "foobar_snapshot_parser"):
                continue
            if node.module == "music_app.services":
                assert all(alias.name == "foobar_snapshot_parser" for alias in node.names)
                continue
            if node.level and node.module is None:
                assert all(alias.name == "foobar_snapshot_parser" for alias in node.names)
                continue
            assert node.level == 0 and node.module.split(".")[0] in sys.stdlib_module_names


def test_build_does_not_open_files_or_network(monkeypatch):
    source, inventory = parsed(), (entry(),)

    def forbidden(*args, **kwargs):
        raise AssertionError("pure preview attempted I/O")

    with monkeypatch.context() as context:
        context.setattr(builtins, "open", forbidden)
        context.setattr(pathlib.Path, "open", forbidden)
        context.setattr(socket, "socket", forbidden)
        context.setattr(socket, "create_connection", forbidden)
        result = build(source, inventory)
    row_result(result.rows[0], "exact_unique", ("t1",), "t1")


def test_path_semantics_fail_even_when_forged_error_accounting_is_consistent():
    source = replace_observation(parsed(), "path", state="invalid", value=None, code="forged_path")
    source = replace_row(source, field_error_count=1)
    source = dataclasses.replace(source, summary=parser.ParseSummary(1, 0, 1, 1, 0, 1, False),
                                 diagnostics=(parser.Diagnostic("forged_path", 2, 0),))
    reject(source)
    empty = parsed(("title", "path"), (("name", ""),))
    reject(replace_observation(empty, "path", state="valid", value=""))
    reject(replace_observation(empty, "title", column_index=1))


@pytest.mark.parametrize("name", HISTORY)
def test_history_invalid_state_is_not_admitted_as_ordinary_field_error(name):
    source = parsed(("path", name), (("x", "[]"),))
    source = replace_observation(source, name, state="invalid")
    source = dataclasses.replace(source, summary=dataclasses.replace(source.summary, unsupported_nonempty_field_count=0))
    reject(source)


@pytest.mark.parametrize("code", ["x" * 128, "é" * 64], ids=["ascii-boundary", "utf8-boundary"])
def test_diagnostic_code_boundaries_do_not_reinterpret_parser_error_codes(code):
    source = parsed(("path", "rating"), (("x", "bad"),))
    source = replace_observation(source, "rating", code=code)
    source = dataclasses.replace(source, diagnostics=(parser.Diagnostic(code, 2, 1),))
    result = build(source)
    assert result.status == "ready" and result.summary.rows_with_field_errors == 1
    rejected_source = parser.parse_foobar_snapshot(b"", mapping_name=PARSER_VERSION)
    rejected_source = dataclasses.replace(rejected_source, diagnostics=(parser.Diagnostic(code, None, None),))
    reject(rejected_source, "parser_rejected")


def test_oversized_nested_dimensions_and_wrong_widths_fail_without_traversing_poison():
    source = parsed()
    reject(dataclasses.replace(source, headers=(Poison(),) * 65))
    reject(dataclasses.replace(source, rows=(Poison(),) * 100001))
    reject(replace_row(source, fields=(Poison(),) * 28))
    reject(replace_row(source, cells=(Poison(), Poison())))
    reject(dataclasses.replace(source, diagnostics=(Poison(),) * 2049))


def test_header_permutation_preserves_each_named_field_and_label_state():
    first = parsed(("path", "rating", "favorite", "play_count"), (("x", "bad", "N/A", "0"),))
    second = parsed(("favorite", "play_count", "path", "rating"), (("N/A", "0", "x", "bad"),))
    reports = [build(s, (entry(),)) for s in (first, second)]
    assert reports[0].rows[0].evidence_labels == reports[1].rows[0].evidence_labels
    assert reports[0].summary == reports[1].summary
    for report, source in zip(reports, (first, second)):
        row_result(report.rows[0], "exact_unique", ("t1",), "t1")
        assert report.rows[0].source_row is source.rows[0]
