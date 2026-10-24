"""Synthetic-only contract tests for the pure TSV observation boundary."""
import builtins
import dataclasses
import hashlib
import inspect
import io
import pathlib
import socket
import sys

import pytest

from music_app.services import foobar_snapshot_parser as parser


MAPPING = "foobar_text_tools_snapshot_v1"
KNOWN = (
    "path", "artist", "album_artist", "album", "date", "discnumber",
    "tracknumber", "title", "rating", "rating_stars", "rating_stars_fixed",
    "play_count", "play_count_enhanced", "first_played", "last_played", "added",
    "first_played_enhanced", "last_played_enhanced", "added_enhanced", "favorite",
    "length", "length_ex", "played_times", "played_times_js", "played_times_raw",
    "lastfm_played_times_js", "lastfm_play_count",
)
TEXT = KNOWN[:8] + ("rating_stars", "rating_stars_fixed", "length", "length_ex")
DATES = KNOWN[13:19]
HISTORY = KNOWN[22:]


def parse(payload, mapping=MAPPING):
    return parser.parse_foobar_snapshot(payload, mapping_name=mapping)


def tsv(headers, rows):
    return ("\t".join(headers) + "\n" + "\n".join("\t".join(r) for r in rows)).encode("utf-8")


def field(row, name):
    assert type(row.fields) is tuple
    assert len(row.fields) == len(KNOWN)
    return row.fields[KNOWN.index(name)]


def observation(row, name, state, column, value=None, code=None):
    actual = field(row, name)
    assert (actual.state, actual.column_index, actual.value, actual.code) == (state, column, value, code)


def summary(result, rows, clean, dirty, errors, unsupported, emitted, truncated):
    actual = result.summary
    assert (
        actual.data_rows, actual.rows_without_field_errors, actual.rows_with_field_errors,
        actual.field_error_count, actual.unsupported_nonempty_field_count,
        actual.diagnostic_count, actual.diagnostics_truncated,
    ) == (rows, clean, dirty, errors, unsupported, emitted, truncated)
    assert actual.diagnostic_count == len(result.diagnostics)


def rejected(payload, code, line=None, column=None, *, mapping=MAPPING, digest=True):
    result = parse(payload, mapping)
    assert result.contract_version == MAPPING
    assert result.status == "rejected"
    assert result.headers == () and result.rows == ()
    assert type(result.diagnostics) is tuple and len(result.diagnostics) == 1
    diagnostic = result.diagnostics[0]
    assert (diagnostic.code, diagnostic.line_number, diagnostic.column_index) == (code, line, column)
    assert result.source_sha256 == (hashlib.sha256(payload).hexdigest() if digest else None)
    summary(result, 0, 0, 0, 0, 0, 1, False)
    return result


@pytest.mark.parametrize("payload", [None, "path\nx", bytearray(b"path\nx"), memoryview(b"path\nx"), pathlib.Path("synthetic.tsv"), 1, True, (), iter(())])
def test_payload_is_immutable_bytes_only(payload):
    rejected(payload, "invalid_payload_type", digest=False)


@pytest.mark.parametrize("mapping", [None, 1, True, b"foobar_text_tools_snapshot_v1", "", "FOOBAR_TEXT_TOOLS_SNAPSHOT_V1", "foobar_text_tools_snapshot_v1 "])
def test_mapping_is_explicit_exact_string(mapping):
    rejected(b"path\nx", "unsupported_mapping", mapping=mapping, digest=False)


def test_argument_precedence_and_no_coercion():
    class Poison:
        def __bytes__(self):
            raise AssertionError("must not coerce")
        def __str__(self):
            raise AssertionError("must not stringify")
        def __iter__(self):
            raise AssertionError("must not iterate")
    rejected(Poison(), "invalid_payload_type", mapping=None, digest=False)
    rejected(b"\xff", "unsupported_mapping", mapping=None, digest=False)
    rejected(b"path\nx", "unsupported_mapping", mapping=Poison(), digest=False)


def test_exact_public_signature_has_no_authority_or_io_inputs():
    parameters = tuple(inspect.signature(parser.parse_foobar_snapshot).parameters.values())
    assert [p.name for p in parameters] == ["payload", "mapping_name"]
    assert parameters[1].kind is inspect.Parameter.KEYWORD_ONLY
    assert parameters[1].default is inspect.Parameter.empty


@pytest.mark.parametrize("payload,code,line,column", [
    (b"", "empty_input", None, None),
    (b"\xef\xbb\xbf", "empty_input", None, None),
    (b"\n", "invalid_header", 1, 0),
    (b"path", "no_data_rows", None, None),
    (b"path\n", "no_data_rows", None, None),
    (b"path\r\n", "no_data_rows", None, None),
    (b"\xef\xbb\xbf\xef\xbb\xbfpath\nx", "missing_path_header", 1, None),
    (b"path\nx\n\n", "empty_record", 3, None),
    (b"path\ttitle\nx\ty\n\n", "invalid_row_width", 3, None),
    (b"path\nx\ty", "invalid_row_width", 2, None),
    (b"path\ttitle\nx", "invalid_row_width", 2, None),
    (b"path\nx\ry", "invalid_line_ending", 2, None),
    (b"path\r", "invalid_line_ending", 1, None),
    (b"path\nx\r\r\n", "invalid_line_ending", 2, None),
    (b"path\nx\r\x00", "forbidden_nul", 2, None),
    (b"path\x00\nx", "forbidden_nul", 1, None),
    (b"path\tpath\nx\ty", "duplicate_header", 1, 1),
    (b"path\t\nx\ty", "invalid_header", 1, 1),
    (b"Path\nx", "missing_path_header", 1, None),
    (b"path \nx", "invalid_header", 1, 0),
    (b" path\nx", "invalid_header", 1, 0),
    (b"path\tbad\x7f\nx\ty", "invalid_header", 1, 1),
    (b"path\tbad\x01\nx\ty", "invalid_header", 1, 1),
    (b"x\tx\t \na\tb\tc", "duplicate_header", 1, 1),
    (b"x\t \tx\na\tb\tc", "invalid_header", 1, 1),
    (b"x\ty\na\tb", "missing_path_header", 1, None),
    (b"path\nx\n\xff", "invalid_utf8", None, None),
    (b"bad\x00\n\xc0\xaf", "invalid_utf8", None, None),
    (b"path\n\xed\xa0\x80", "invalid_utf8", None, None),
    (b"path\n\xf4\x90\x80\x80", "invalid_utf8", None, None),
])
def test_structural_errors_have_exact_precedence_locations_and_no_prefix(payload, code, line, column):
    rejected(payload, code, line, column)


def test_structural_failure_discards_prior_field_errors():
    rejected(b"path\trating\nprivate-synthetic\tbogus\nwrong-width", "invalid_row_width", 3)


def test_bom_mixed_terminators_literal_quotes_and_raw_digest():
    payload = '\ufefftitle\tpath\tunknown\r\n"quoted"\tC:\\a\\..\\b\t=1+1\n\'single\'\t/../x\t\ufeffx\r\n'.encode()
    result = parse(payload)
    assert result.status == "parsed"
    assert result.headers == ("title", "path", "unknown")
    assert result.source_sha256 == hashlib.sha256(payload).hexdigest()
    assert [r.cells for r in result.rows] == [('"quoted"', 'C:\\a\\..\\b', '=1+1'), ("'single'", '/../x', '\ufeffx')]
    assert [(r.ordinal, r.line_number) for r in result.rows] == [(1, 2), (2, 3)]
    observation(result.rows[0], "path", "valid", 1, 'C:\\a\\..\\b')
    observation(result.rows[0], "title", "valid", 0, '"quoted"')
    summary(result, 2, 2, 0, 0, 0, 0, False)


def test_quotes_do_not_escape_tabs_or_newlines():
    rejected(b'path\ttitle\nx\t"a\tb"', "invalid_row_width", 2)
    rejected(b'path\ttitle\nx\t"a\nb"', "invalid_row_width", 3)


def test_empty_cells_are_rows_not_empty_records_and_known_columns_are_exact():
    result = parse(b"path\tTITLE\n\t")
    assert result.status == "parsed" and result.rows[0].cells == ("", "")
    observation(result.rows[0], "path", "empty", 0)
    for name in KNOWN[1:]:
        observation(result.rows[0], name, "absent", None)


@pytest.mark.parametrize("name", TEXT)
@pytest.mark.parametrize("raw", ["N/A", " \v\f ", "=1+1", "  é\u0301  ", "0", "not-a-date"])
def test_matching_star_and_duration_text_is_lossless(name, raw):
    headers = ("path",) if name == "path" else ("path", name)
    cells = (raw,) if name == "path" else ("synthetic", raw)
    result = parse(tsv(headers, [cells]))
    assert result.status == "parsed"
    observation(result.rows[0], name, "valid", len(headers) - 1, raw)
    assert result.rows[0].cells == cells


@pytest.mark.parametrize("name", KNOWN)
def test_exact_empty_known_cells(name):
    headers = ("path",) if name == "path" else ("path", name)
    cells = ("",) if name == "path" else ("x", "")
    # A lone empty path is an empty physical record, so supply an opaque column.
    if name == "path":
        headers, cells = ("path", "opaque"), ("", "")
    result = parse(tsv(headers, [cells]))
    assert result.status == "parsed"
    observation(result.rows[0], name, "empty", headers.index(name))


@pytest.mark.parametrize("name", ("rating", "play_count", "play_count_enhanced", "favorite") + DATES + HISTORY)
@pytest.mark.parametrize("raw,state", [(" \v\f ", "empty"), (" \vN/A\f ", "unavailable")])
def test_ascii_only_empty_and_unavailable_handling(name, raw, state):
    result = parse(tsv(("path", name), [("x", raw)]))
    observation(result.rows[0], name, state, 1)
    assert result.rows[0].cells[1] == raw
    summary(result, 1, 1, 0, 0, 0, 0, False)


@pytest.mark.parametrize("name", DATES)
@pytest.mark.parametrize("raw", ["not a timestamp", " 2024-99-99  ", "0", "\u00a0N/A\u00a0", "n/a", "=NOW()"])
def test_dates_are_raw_evidence_not_validated_timestamps(name, raw):
    result = parse(tsv((name, "path"), [(raw, "x")]))
    observation(result.rows[0], name, "valid", 0, raw)


@pytest.mark.parametrize("raw,expected", [("1", 1), ("5", 5), (" \v3\f ", 3)])
def test_rating_normalization(raw, expected):
    result = parse(tsv(("path", "rating"), [("x", raw)]))
    observation(result.rows[0], "rating", "valid", 1, expected)
    assert type(field(result.rows[0], "rating").value) is int


@pytest.mark.parametrize("name,code,raw", [
    *(('rating', 'invalid_rating', value) for value in ('0', '6', '+1', '01', '1.0', 'true', '★★★★★', '=5', '１', '\u00a05\u00a0', 'n/a')),
    *((name, 'invalid_count', value) for name in ('play_count', 'play_count_enhanced') for value in ('-1', '+1', '1.0', '1e2', '²', '１', '=1', '9223372036854775808', '9' * 16384, '\u00a01\u00a0', 'n/a')),
    *(('favorite', 'invalid_favorite', value) for value in ('true', 'false', 'yes', '2', '01', '$if(x,1,0)', '=1', '\u00a01\u00a0', 'n/a')),
], ids=[f"{name}-invalid-{index}" for name, size in (("rating", 11), ("standard-count", 11), ("enhanced-count", 11), ("favorite", 9)) for index in range(size)])
def test_invalid_fields_preserve_valid_neighbors_and_raw(name, code, raw):
    result = parse(tsv(("path", name, "title"), [("x", raw, "valid-neighbor")]))
    assert result.status == "parsed"
    observation(result.rows[0], name, "invalid", 1, code=code)
    observation(result.rows[0], "title", "valid", 2, "valid-neighbor")
    assert result.rows[0].cells[1] == raw
    assert [(d.code, d.line_number, d.column_index) for d in result.diagnostics] == [(code, 2, 1)]
    assert result.rows[0].field_error_count == 1
    summary(result, 1, 0, 1, 1, 0, 1, False)


@pytest.mark.parametrize("name", ("play_count", "play_count_enhanced"))
@pytest.mark.parametrize("raw,expected", [("0", 0), ("00001", 1), (" \v42\f ", 42), ("9223372036854775807", 9223372036854775807), ("0" * 16384, 0), ("0" * 16365 + "9223372036854775807", 9223372036854775807)],
                         ids=["zero", "leading-zeroes", "ascii-trim", "max-int64", "cell-limit-zeroes", "cell-limit-prefixed-max"])
def test_bounded_count_conversion_without_interpreter_global_mutation(name, raw, expected, monkeypatch):
    def forbidden(*args):
        raise AssertionError("must not alter interpreter integer limits")
    if hasattr(sys, "set_int_max_str_digits"):
        monkeypatch.setattr(sys, "set_int_max_str_digits", forbidden)
    before = sys.get_int_max_str_digits() if hasattr(sys, "get_int_max_str_digits") else None
    result = parse(tsv(("path", name), [("x", raw)]))
    observation(result.rows[0], name, "valid", 1, expected)
    assert type(field(result.rows[0], name).value) is int
    if before is not None:
        assert sys.get_int_max_str_digits() == before


@pytest.mark.parametrize("raw,expected", [("1", True), ("0", False), (" \v0\f ", False)])
def test_favorite_boolean_observation_only(raw, expected):
    result = parse(tsv(("path", "favorite"), [("x", raw)]))
    observation(result.rows[0], "favorite", "valid", 1, expected)
    assert field(result.rows[0], "favorite").value is expected


@pytest.mark.parametrize("name", HISTORY)
@pytest.mark.parametrize("raw", ["0", "1", "[]", '["2020-01-01"]', "garbage", "\u00a0N/A\u00a0"])
def test_history_and_lastfm_fields_are_unsupported_without_parsing(name, raw):
    result = parse(tsv(("path", name), [("x", raw)]))
    observation(result.rows[0], name, "unsupported", 1, code="unsupported_history_field")
    summary(result, 1, 0, 1, 1, 1, 1, False)


def test_counters_remain_independent_and_no_precedence_or_combined_value_exists():
    result = parse(tsv(("path", "play_count_enhanced", "play_count", "rating_stars", "favorite"), [("x", "2", "9", "★★★★★", "0"), ("x", "9", "2", "★", "1")]))
    for row, standard, enhanced in zip(result.rows, (9, 2), (2, 9)):
        observation(row, "play_count", "valid", 2, standard)
        observation(row, "play_count_enhanced", "valid", 1, enhanced)
        observation(row, "rating", "absent", None)
    assert len(result.rows) == 2


def test_duplicate_casefold_and_unicode_collision_rows_are_preserved():
    paths = ("/A", "/a", "/A", "/é", "/e\u0301", "/x/../A")
    result = parse(tsv(("path", "title"), [(p, "same") for p in paths]))
    assert tuple(r.cells[0] for r in result.rows) == paths
    assert tuple(r.ordinal for r in result.rows) == tuple(range(1, 7))
    assert all(len(r.fields) == 27 for r in result.rows)


@pytest.mark.parametrize("errors", [2047, 2048, 2049, 2053])
def test_full_counts_continue_after_diagnostic_cap(errors):
    rows = [("x", "bad", "[]")] * (errors // 2)
    if errors % 2:
        rows.append(("x", "bad", "N/A"))
    rows.append(("x", "5", ""))
    result = parse(tsv(("path", "rating", "played_times"), rows))
    assert result.status == "parsed"
    count = min(errors, 2048)
    summary(result, len(rows), 1, len(rows) - 1, errors, errors // 2, count, errors > 2048)
    assert sum(r.field_error_count for r in result.rows) == errors
    expected = []
    for index in range(errors // 2):
        expected.extend([("invalid_rating", index + 2, 1), ("unsupported_history_field", index + 2, 2)])
    if errors % 2:
        expected.append(("invalid_rating", errors // 2 + 2, 1))
    assert [(d.code, d.line_number, d.column_index) for d in result.diagnostics] == expected[:2048]


def test_field_diagnostics_follow_fixed_known_order_not_column_order():
    headers = ("lastfm_play_count", "favorite", "play_count_enhanced", "rating", "path", "play_count")
    result = parse(tsv(headers, [("[]", "bad", "bad", "bad", "x", "bad")]))
    assert [(d.code, d.line_number, d.column_index) for d in result.diagnostics] == [
        ("invalid_rating", 2, 3), ("invalid_count", 2, 5), ("invalid_count", 2, 2),
        ("invalid_favorite", 2, 1), ("unsupported_history_field", 2, 0),
    ]
    summary(result, 1, 0, 1, 5, 1, 5, False)


def test_result_tree_is_immutable_and_has_no_apply_authority():
    result = parse(b"path\trating\nx\tbad")
    assert type(result.headers) is tuple and type(result.rows) is tuple
    assert type(result.rows[0].cells) is tuple and type(result.diagnostics) is tuple
    objects = [(result, "status"), (result.summary, "data_rows"), (result.rows[0], "ordinal"), (field(result.rows[0], "rating"), "state"), (result.diagnostics[0], "code")]
    for obj, attribute in objects:
        with pytest.raises((AttributeError, TypeError)):
            setattr(obj, attribute, "changed")
    assert not any(hasattr(result, name) for name in ("apply", "eligible", "track_id", "actor", "accepted", "matched", "combined_count"))
    assert not any(hasattr(result.rows[0], name) for name in ("apply", "eligible", "track_id", "canonical_key", "combined_count", "events"))


def test_parse_never_opens_paths_network_or_logs_input(monkeypatch, caplog, capsys):
    def forbidden(*args, **kwargs):
        raise AssertionError("pure parsing must not perform I/O")
    payload = b'path\trating\n/never/read/synthetic.tsv\tbad'
    with monkeypatch.context() as patch:
        patch.setattr(builtins, "open", forbidden)
        patch.setattr(io, "open", forbidden)
        patch.setattr(pathlib.Path, "open", forbidden)
        patch.setattr(socket, "socket", forbidden)
        result = parse(payload)
    assert result.status == "parsed"
    assert not caplog.records
    assert capsys.readouterr() == ("", "")


def test_named_frozen_slot_dataclasses_have_only_contract_fields():
    expected = {
        "ParseResult": ("contract_version", "status", "source_sha256", "headers", "rows", "summary", "diagnostics"),
        "ParseSummary": ("data_rows", "rows_without_field_errors", "rows_with_field_errors", "field_error_count", "unsupported_nonempty_field_count", "diagnostic_count", "diagnostics_truncated"),
        "ParsedRow": ("ordinal", "line_number", "cells", "fields", "field_error_count"),
        "FieldObservation": ("state", "column_index", "value", "code"),
        "Diagnostic": ("code", "line_number", "column_index"),
    }
    result = parse(b"path\trating\nx\tbad")
    values = (result, result.summary, result.rows[0], field(result.rows[0], "rating"), result.diagnostics[0])
    for value in values:
        cls = type(value)
        assert cls is getattr(parser, cls.__name__)
        assert dataclasses.is_dataclass(value)
        assert cls.__dataclass_params__.frozen is True
        assert tuple(f.name for f in dataclasses.fields(value)) == expected[cls.__name__]
        assert not hasattr(value, "__dict__")
        assert all(not isinstance(getattr(value, f.name), (dict, list, set)) for f in dataclasses.fields(value))
    assert parser.FIELD_NAMES == KNOWN and type(parser.FIELD_NAMES) is tuple


def test_fixed_resource_constants_are_not_test_scaled():
    expected = dict(MAX_INPUT_BYTES=67108864, MAX_DATA_ROWS=100000, MAX_COLUMNS=64,
                    MAX_TOTAL_CELLS=3000000, MAX_CELL_UTF8_BYTES=16384,
                    MAX_RECORD_UTF8_BYTES=262144, MAX_DIAGNOSTICS=2048)
    for name, value in expected.items():
        assert getattr(parser, name) == value
        assert type(getattr(parser, name)) is int


@pytest.mark.parametrize("terminator", [b"", b"\n", b"\r\n"])
def test_exact_cell_utf8_byte_boundary(terminator):
    raw = "é" * 8192
    result = parse(b"path\n" + raw.encode() + terminator)
    assert result.status == "parsed"
    assert result.rows[0].cells == (raw,)
    rejected(b"path\n" + raw.encode() + b"x" + terminator, "cell_too_large", 2, 0)


def test_cell_scan_is_left_to_right_and_header_cell_bound_precedes_syntax():
    rejected(tsv(("path", "title"), [("a" * 16385, "b" * 16385)]), "cell_too_large", 2, 0)
    rejected(tsv(("path", "title"), [("x", "b" * 16385)]), "cell_too_large", 2, 1)
    rejected((" " * 16385 + "\nx").encode(), "cell_too_large", 1, 0)


def test_columns_boundary_and_columns_before_width_or_cells():
    headers = ("path",) + tuple(f"opaque{i}" for i in range(63))
    result = parse(tsv(headers, [("x",) * 64]))
    assert result.status == "parsed" and len(result.headers) == 64
    rejected(tsv(("path",), [("x",) * 65]), "too_many_columns", 2)
    rejected(tsv(headers + ("extra",), [("x",) * 65]), "too_many_columns", 1)
    rejected(tsv(("path",), [("a" * 16385, "b")]), "invalid_row_width", 2)


@pytest.mark.parametrize("terminator", [b"", b"\n", b"\r\n"])
def test_record_byte_boundary_excludes_terminator(terminator):
    headers = ("path",) + tuple(f"opaque{i}" for i in range(16))
    # 15 full cells, one shortened cell, one empty cell and 16 delimiters.
    cells = ("x" * 16384,) * 15 + ("x" * 16368, "")
    record = "\t".join(cells).encode()
    assert len(record) == 262144
    result = parse("\t".join(headers).encode() + b"\n" + record + terminator)
    assert result.status == "parsed" and result.rows[0].cells == cells
    rejected("\t".join(headers).encode() + b"\n" + record + b"x" + terminator, "record_too_large", 2)


def test_record_size_wins_over_nul_cr_column_width_and_cell_errors():
    rejected(b"path\n" + b"\x00\r\t" + b"x" * 262142, "record_too_large", 2)
    rejected(b"\x00\r" + b"x" * 262143, "record_too_large", 1)


def test_nul_and_cr_precede_width_and_oversized_cells():
    rejected(b"path\n" + b"x" * 16385 + b"\t\x00\r", "forbidden_nul", 2)
    rejected(b"path\n" + b"x" * 16385 + b"\t\r", "invalid_line_ending", 2)


def test_header_validation_is_exact_not_unicode_trim_or_casefold():
    result = parse(tsv(("path", "Path", "\u00a0opaque\u00a0", "é", "e\u0301"), [("x", "y", "z", "a", "b")]))
    assert result.status == "parsed"
    assert result.headers == ("path", "Path", "\u00a0opaque\u00a0", "é", "e\u0301")


def test_digest_is_exact_bytes_and_parser_is_stateless():
    payload = b"path\tplay_count\nx\t3"
    first = parse(payload)
    assert parse(payload) == first
    assert parse(payload + b"\n").source_sha256 != first.source_sha256
    assert parse(b"\xef\xbb\xbf" + payload).source_sha256 != first.source_sha256
    assert parse(payload.replace(b"\n", b"\r\n")).source_sha256 != first.source_sha256
    observation(parse(payload).rows[0], "play_count", "valid", 1, 3)


@pytest.mark.parametrize("control", [chr(i) for i in range(1, 32) if i not in (9, 10, 13)] + [chr(127)])
def test_every_non_delimiter_header_control_is_invalid(control):
    rejected(tsv(("path", "name" + control), [("x", "y")]), "invalid_header", 1, 1)


def test_missing_extra_and_positional_mapping_arguments_use_python_typeerror():
    with pytest.raises(TypeError):
        parser.parse_foobar_snapshot(b"path\nx")
    with pytest.raises(TypeError):
        parser.parse_foobar_snapshot(b"path\nx", MAPPING)
    with pytest.raises(TypeError):
        parser.parse_foobar_snapshot(b"path\nx", mapping_name=MAPPING, actor="synthetic")


@pytest.mark.parametrize("standard,enhanced,state1,state2,value1,value2", [
    ("bad", "9", "invalid", "valid", None, 9),
    ("0", "bad", "valid", "invalid", 0, None),
    ("N/A", "7", "unavailable", "valid", None, 7),
    ("", "0", "empty", "valid", None, 0),
])
def test_one_counter_never_fills_or_invalidates_the_other(standard, enhanced, state1, state2, value1, value2):
    result = parse(tsv(("path", "play_count", "play_count_enhanced"), [("x", standard, enhanced)]))
    observation(result.rows[0], "play_count", state1, 1, value1, "invalid_count" if state1 == "invalid" else None)
    observation(result.rows[0], "play_count_enhanced", state2, 2, value2, "invalid_count" if state2 == "invalid" else None)


def test_later_structural_failure_discards_even_a_capped_diagnostic_prefix():
    payload = b"path\trating\n" + b"x\tbad\n" * 2049 + b"wrong-width"
    rejected(payload, "invalid_row_width", 2051)
