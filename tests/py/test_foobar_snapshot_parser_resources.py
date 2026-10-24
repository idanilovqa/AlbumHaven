"""Real-envelope synthetic cases; each node can run in its own bounded process.

No shared test ordering, private fixtures, lowered constants or runtime dataset
rewrites. Large returned trees are local to each test and released on return.
"""
import hashlib

import pytest

from music_app.services import foobar_snapshot_parser as parser


MAPPING = "foobar_text_tools_snapshot_v1"


def parse(payload):
    return parser.parse_foobar_snapshot(payload, mapping_name=MAPPING)


def reject(payload, code, line=None, *, digest=True):
    result = parse(payload)
    assert result.status == "rejected"
    assert result.headers == result.rows == ()
    assert len(result.diagnostics) == 1
    diagnostic = result.diagnostics[0]
    assert (diagnostic.code, diagnostic.line_number, diagnostic.column_index) == (code, line, None)
    assert result.source_sha256 == (hashlib.sha256(payload).hexdigest() if digest else None)
    assert (result.summary.data_rows, result.summary.rows_without_field_errors,
            result.summary.rows_with_field_errors, result.summary.field_error_count,
            result.summary.unsupported_nonempty_field_count,
            result.summary.diagnostic_count, result.summary.diagnostics_truncated) == (0, 0, 0, 0, 0, 1, False)


def test_input_at_64_mib_reaches_record_checks_not_input_limit():
    # Exact size is valid UTF-8 but its first record exceeds the record bound.
    reject(b"x" * 67108864, "record_too_large", 1)


def test_input_over_64_mib_rejects_before_utf8_or_hashing():
    reject(b"\xff" * 67108865, "input_too_large", digest=False)


def test_exact_100000_rows_are_retained_without_deduplication():
    payload = b"path\n" + b"x\n" * 100000
    result = parse(payload)
    assert result.status == "parsed"
    assert len(result.rows) == result.summary.data_rows == 100000
    assert result.rows[0].ordinal == 1 and result.rows[-1].ordinal == 100000
    assert result.rows[-1].line_number == 100001
    assert result.summary.rows_without_field_errors == 100000
    assert result.rows[-1].cells == ("x",)
    assert len(result.rows[-1].fields) == 27


@pytest.mark.parametrize("last,code", [(b"x\ty", "too_many_rows"), (b"\x00", "forbidden_nul"), (b"\r", "invalid_line_ending"), (b"x" * 262145, "record_too_large")],
                         ids=["row-limit", "nul-before-row-limit", "cr-before-row-limit", "record-before-row-limit"])
def test_row_overflow_precedence(last, code):
    payload = b"path\n" + b"x\n" * 100000 + last
    reject(payload, code, 100002)


def test_exact_three_million_total_cells_includes_header():
    # 30 cells * (99999 data rows + one header) = 3000000.
    header = b"path\t" + b"\t".join(f"opaque{i}".encode() for i in range(29))
    row = b"x" + b"\t" * 29 + b"\n"
    result = parse(header + b"\n" + row * 99999)
    assert result.status == "parsed" and len(result.rows) == 99999
    assert sum(len(row.cells) for row in result.rows) + len(result.headers) == 3000000
    assert result.summary.rows_without_field_errors == 99999


@pytest.mark.parametrize("last,code", [
    (b"x" + b"\t" * 29, "too_many_cells"),
    (b"x" * 16385 + b"\t" * 29, "too_many_cells"),
    (b"x" + b"\t" * 28, "invalid_row_width"),
    (b"x" + b"\t" * 64, "too_many_columns"),
], ids=["total-cell-limit", "total-cells-before-cell-size", "width-before-total-cells", "columns-before-width"])
def test_total_cell_overflow_after_width_before_cell_size(last, code):
    header = b"path\t" + b"\t".join(f"opaque{i}".encode() for i in range(29))
    row = b"x" + b"\t" * 29 + b"\n"
    reject(header + b"\n" + row * 99999 + last, code, 100001)


def test_documented_59645_by_42_synthetic_shape_fits():
    header = b"path\t" + b"\t".join(f"opaque{i}".encode() for i in range(41))
    row = b"synthetic" + b"\t" * 41 + b"\n"
    result = parse(header + b"\n" + row * 59645)
    assert result.status == "parsed" and result.summary.data_rows == 59645
    assert len(result.headers) + sum(len(row.cells) for row in result.rows) == 2505132
    assert result.summary.field_error_count == result.summary.diagnostic_count == 0
