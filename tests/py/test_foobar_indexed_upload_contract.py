"""Source-only contract tests for the genuine ephemeral indexed TSV owner.

Authored, NOT executed. Compose both indexed-upload afterimages and the accepted
account-v3 dependencies into the canonical tree before a separately authorized
run. No stand-in parser, fabricated validated index, or application/DB fixtures.
"""
from copy import copy, deepcopy
from dataclasses import FrozenInstanceError
from hashlib import sha256
import pickle
from types import SimpleNamespace

import pytest

from music_app.services import foobar_snapshot_parser as parser
from music_app.services import foobar_source_window as window
from music_app.services.foobar_import_preparation import (
    FoobarIntakeCapacity, FoobarPreparationRejected,
)
from music_app.services.foobar_preview_inventory_postgres import FoobarInventoryUnavailable


def consume(stream):
    rows = []
    try:
        while True:
            try:
                rows.append(next(stream))
            except StopIteration as done:
                return tuple(rows), done.value
    finally:
        stream.close()


def build(payload, **kwargs):
    return window.build_foobar_upload_index(
        payload,
        intake_capacity=FoobarIntakeCapacity(window.indexed_upload_intake_bytes(len(payload))),
        **kwargs,
    )


def indexed_proof(upload, offset=0):
    return window.prove_indexed_foobar_source_window(
        upload, offset=offset,
        intake_capacity=FoobarIntakeCapacity(
            window.indexed_upload_intake_bytes(upload.payload_bytes) + window.WINDOW_WORK_BYTES
        ),
    )


def forbidden(*args, **kwargs):
    raise AssertionError("Unexpected full scanner, hasher, validator, or legacy proof")


@pytest.mark.parametrize("bom", [b"", b"\xef\xbb\xbf"])
@pytest.mark.parametrize("ending", ["\n", "\r\n"])
@pytest.mark.parametrize("trailing", [False, True])
@pytest.mark.parametrize("headers", [
    ("path", "title", "rating", "play_count", "favorite", "played_times"),
    ("played_times", "favorite", "title", "play_count", "path", "rating"),
])
def test_exact_genuine_parser_parity_bom_crlf_utf8_reordered_headers(bom, ending, trailing, headers):
    observations = [
        {"path": "/音楽/é.flac", "title": "雪 ☃", "rating": " 5 ",
         "play_count": "00042", "favorite": "1", "played_times": "N/A"},
        {"path": "", "title": "empty path", "rating": "9", "play_count": "-1",
         "favorite": "yes", "played_times": "[not imported history]"},
        {"path": "/last", "title": "café", "rating": "", "play_count": "N/A",
         "favorite": "0", "played_times": ""},
    ]
    text = ending.join(["\t".join(headers)] + [
        "\t".join(row[name] for name in headers) for row in observations
    ]) + (ending if trailing else "")
    payload = bom + text.encode("utf-8")
    expected_rows, expected_terminal = consume(
        parser.iter_foobar_snapshot_rows(payload, mapping_name=window.MAPPING)
    )
    assert expected_terminal.status == "parsed"
    with build(payload) as upload:
        actual_rows, terminal = consume(upload.iter_window())
        assert actual_rows == expected_rows
        assert terminal == expected_terminal
        assert terminal is upload.terminal
        assert terminal.headers == headers
        assert terminal.source_sha256 == sha256(payload).hexdigest()
        assert terminal.contract_version == window.MAPPING
        assert tuple(row.ordinal for row in actual_rows) == (1, 2, 3)
        assert tuple(row.line_number for row in actual_rows) == (2, 3, 4)
        assert terminal.summary.rows_with_field_errors == 1
        assert terminal.summary.field_error_count == 4
        assert terminal.summary.unsupported_nonempty_field_count == 1
        assert upload.path_counts() == (1, 0, 1)
        assert len(terminal.diagnostics) == 4


def test_field_invalid_and_unsupported_are_observations_not_structural_failure():
    payload = b"path\trating\tplay_count\tfavorite\tplayed_times\n/a\t9\t-1\tyes\t[1]\n"
    with build(payload) as upload:
        rows, terminal = consume(upload.iter_window())
        fields = dict(zip(parser.FIELD_NAMES, rows[0].fields))
        assert terminal.status == "parsed"
        assert fields["rating"].state == fields["play_count"].state == fields["favorite"].state == "invalid"
        assert fields["played_times"].state == "unsupported"
        assert rows[0].field_error_count == 4
        assert all(fields[name].value is None for name in ("rating", "play_count", "favorite", "played_times"))


@pytest.mark.parametrize("suffix,code", [
    (b"/bad\textra\n", "invalid_row_width"),
    (b"/bad\x00\n", "forbidden_nul"),
    (b"/bad\rinside\n", "invalid_line_ending"),
    (b"\n", "empty_record"),
    (b"/bad\xff\n", "invalid_utf8"),
    (b"x" * (parser.MAX_CELL_UTF8_BYTES + 1) + b"\n", "cell_too_large"),
    (b"x" * (parser.MAX_RECORD_UTF8_BYTES + 1) + b"\n", "record_too_large"),
])
def test_late_structural_failure_never_publishes_partial_index(suffix, code, monkeypatch):
    payload = b"path\n" + b"/valid\n" * 105 + suffix
    _, terminal = consume(parser.iter_foobar_snapshot_rows(payload, mapping_name=window.MAPPING))
    assert terminal.status == "rejected"
    assert terminal.diagnostics[0].code == code
    # A partial index constructor must not even be reached on a rejected scan.
    monkeypatch.setattr(parser.FoobarIndexedUpload, "__init__", forbidden)
    with pytest.raises(FoobarPreparationRejected):
        build(payload)


@pytest.mark.parametrize("payload,code", [
    (b"\xef\xbb\xbf", "empty_input"),
    (b"path\n", "no_data_rows"),
    (b"title\nhello\n", "missing_path_header"),
    (b"path\tpath\n/a\t/b\n", "duplicate_header"),
    (b" path\n/a\n", "invalid_header"),
])
def test_header_failures_have_no_index(payload, code):
    _, terminal = consume(parser.iter_foobar_snapshot_rows(payload, mapping_name=window.MAPPING))
    assert terminal.diagnostics[0].code == code
    with pytest.raises(FoobarPreparationRejected):
        build(payload)


@pytest.mark.parametrize("constant,bound,payload,code", [
    ("MAX_DATA_ROWS", 2, b"path\n/a\n/b\n/c\n", "too_many_rows"),
    ("MAX_TOTAL_CELLS", 5, b"path\ttitle\n/a\ta\n/b\tb\n", "too_many_cells"),
    ("MAX_COLUMNS", 2, b"path\n/a\n/b\tx\ty\n", "too_many_columns"),
])
def test_genuine_parser_structural_limits_fail_atomically(monkeypatch, constant, bound, payload, code):
    # Lower only the real parser limit to keep fixtures tiny; no scanner substitute.
    monkeypatch.setattr(parser, constant, bound)
    _, terminal = consume(parser.iter_foobar_snapshot_rows(payload, mapping_name=window.MAPPING))
    assert terminal.diagnostics[0].code == code
    with pytest.raises(FoobarPreparationRejected):
        build(payload)


def multi_window_payload():
    paths = ["/unique/" + str(i) for i in range(205)]
    for i in (0, 100, 204):
        paths[i] = "/exact/shared"
    paths[1] = paths[101] = ""
    paths[2:7] = ["/Case", "/case", "/é", "/e\u0301", "/exact/shared "]
    payload = ("title\tpath\trating\n" + "".join(
        str(i) + "\t" + path + "\t" + ("9" if i == 204 else "5") + "\n"
        for i, path in enumerate(paths)
    )).encode("utf-8")
    return payload, tuple(paths)


def test_full_upload_exact_raw_counts_cross_windows_empty_paths_and_legacy_parity():
    payload, paths = multi_window_payload()
    with build(payload) as upload:
        for offset in (0, 100, 200, 204):
            proof = indexed_proof(upload, offset)
            legacy = window.prove_foobar_source_window(
                payload, offset=offset,
                intake_capacity=FoobarIntakeCapacity(window.source_window_intake_bytes(len(payload))),
            )
            assert proof == legacy
            selected = paths[offset:offset + 100]
            assert proof.paths == selected
            assert proof.raw_path_row_counts == tuple(0 if p == "" else paths.count(p) for p in selected)
            assert proof.total_rows == 205
            assert proof.offset == offset
            assert proof.source_sha256 == sha256(payload).hexdigest()
        assert upload.path_counts(offset=0, limit=7) == (3, 0, 1, 1, 1, 1, 1)
        assert upload.path_counts(offset=100, limit=2) == (3, 0)
        assert upload.path_counts(offset=204) == (3,)


def test_repeated_windows_never_scan_hash_validate_utf8_or_use_legacy_proof(monkeypatch):
    payload, _ = multi_window_payload()
    expected_rows, expected_terminal = consume(parser.iter_foobar_snapshot_rows(payload, mapping_name=window.MAPPING))
    genuine_scanner = parser.iter_foobar_snapshot_rows
    calls = []

    def counted_scanner(*args, **kwargs):
        calls.append((args, kwargs))
        return genuine_scanner(*args, **kwargs)

    monkeypatch.setattr(parser, "iter_foobar_snapshot_rows", counted_scanner)
    upload = build(payload)
    assert len(calls) == 1
    assert calls[0] == ((payload,), {"mapping_name": window.MAPPING})
    try:
        # Install traps only AFTER genuine complete construction, not a fake index.
        for name in ("iter_foobar_snapshot_rows", "parse_foobar_snapshot", "_valid_utf8", "sha256"):
            monkeypatch.setattr(parser, name, forbidden)
        for name in ("prove_foobar_source_window", "_first_scan", "_second_scan"):
            monkeypatch.setattr(window, name, forbidden)
        for offset in (100, 0, 204, 200, 100, 0):
            rows, terminal = consume(upload.iter_window(offset=offset))
            assert rows == expected_rows[offset:offset + 100]
            assert len(rows) <= 100
            assert terminal is upload.terminal
            assert terminal == expected_terminal
            assert terminal.summary.data_rows == 205
            assert terminal.summary.field_error_count == 1  # Late row, even in first window.
            assert terminal.diagnostics[0].line_number == 206
            proof = indexed_proof(upload, offset)
            assert proof.total_rows == 205
            assert proof.source_sha256 == expected_terminal.source_sha256
    finally:
        upload.close()


def test_window_decoder_work_is_bounded_to_selected_rows(monkeypatch):
    payload, _ = multi_window_payload()
    with build(payload) as upload:
        genuine_observation = parser._observation
        calls = []

        def observed(*args):
            calls.append(args)
            return genuine_observation(*args)

        monkeypatch.setattr(parser, "_observation", observed)
        rows, terminal = consume(upload.iter_window(offset=100, limit=3))
        assert len(calls) == 3 * len(parser.FIELD_NAMES)
        assert tuple(row.ordinal for row in rows) == (101, 102, 103)
        assert tuple(row.line_number for row in rows) == (102, 103, 104)
        assert terminal.summary.data_rows == 205


@pytest.mark.parametrize("offset,limit", [
    (-1, 100), (205, 100), (206, 100), (True, 100), (0.0, 100),
    ("0", 100), (None, 100), (0, 0), (0, 101), (0, -1),
    (0, True), (0, 1.0), (0, None),
])
def test_invalid_window_bounds_rejected_for_rows_and_counts(offset, limit):
    payload, _ = multi_window_payload()
    with build(payload) as upload:
        with pytest.raises(ValueError):
            consume(upload.iter_window(offset=offset, limit=limit))
        with pytest.raises(ValueError):
            upload.path_counts(offset=offset, limit=limit)


def test_lifecycle_close_releases_owned_state_and_preserves_already_yielded_rows():
    payload = b"path\n/a\n/b\n"
    upload = build(payload)
    assert upload._payload is payload  # No staged copy of original immutable bytes.
    stream = upload.iter_window()
    row = next(stream)
    upload.close()
    upload.close()
    assert upload._payload is upload._terminal is None
    assert upload._spans == upload._counts == upload._columns == ()
    assert row.cells == ("/a",)  # Close cannot erase another consumer's row.
    assert payload == b"path\n/a\n/b\n"
    for action in (lambda: upload.terminal, lambda: upload.payload_bytes,
                   lambda: upload.path_counts(), lambda: consume(upload.iter_window()),
                   lambda: next(stream), lambda: upload.__enter__(),
                   lambda: indexed_proof(upload)):
        with pytest.raises(parser.FoobarIndexedUploadClosed):
            action()
    stream.close()


def test_context_manager_closes_on_exception():
    upload = build(b"path\n/a\n")
    with pytest.raises(RuntimeError):
        with upload as owned:
            assert owned is upload
            raise RuntimeError("synthetic owner failure")
    with pytest.raises(parser.FoobarIndexedUploadClosed):
        _ = upload.terminal


def test_no_public_construction_mutation_or_serialization():
    with pytest.raises(TypeError):
        parser.FoobarIndexedUpload()
    with pytest.raises(TypeError):
        parser.FoobarIndexedUpload(validated=True)
    with build(b"path\n/a\n") as upload:
        with pytest.raises(FrozenInstanceError):
            upload._payload = b"changed"
        for protocol in range(pickle.HIGHEST_PROTOCOL + 1):
            with pytest.raises(TypeError):
                pickle.dumps(upload, protocol=protocol)
        for copier in (copy, deepcopy):
            with pytest.raises(TypeError):
                copier(upload)


@pytest.mark.parametrize("capacity", [None, 1000000000, True,
    SimpleNamespace(logical_bytes=1000000000), FoobarIntakeCapacity(True),
    FoobarIntakeCapacity(0), FoobarIntakeCapacity(-1)])
def test_untrusted_or_missing_capacity_rejected_before_index_allocation(monkeypatch, capacity):
    monkeypatch.setattr(parser, "_build_validated_upload_index", forbidden)
    with pytest.raises(FoobarInventoryUnavailable):
        window.build_foobar_upload_index(b"path\n/a\n", intake_capacity=capacity)


def test_exact_construction_and_window_capacity_edges(monkeypatch):
    payload = b"path\n/a\n"
    required = window.indexed_upload_intake_bytes(len(payload))
    assert required == 18 * len(payload) + 512 * parser.MAX_DATA_ROWS + window.PARSER_WORK_BYTES
    with monkeypatch.context() as patch:
        patch.setattr(parser, "_build_validated_upload_index", forbidden)
        with pytest.raises(FoobarInventoryUnavailable):
            window.build_foobar_upload_index(payload, intake_capacity=FoobarIntakeCapacity(required - 1))
    with build(payload) as upload:
        proof_required = required + window.WINDOW_WORK_BYTES
        with monkeypatch.context() as patch:
            patch.setattr(parser.FoobarIndexedUpload, "iter_window", forbidden)
            for capacity in (None, FoobarIntakeCapacity(proof_required - 1)):
                with pytest.raises(FoobarInventoryUnavailable):
                    window.prove_indexed_foobar_source_window(upload, intake_capacity=capacity)
        assert indexed_proof(upload).paths == ("/a",)


@pytest.mark.parametrize("size", [0, -1, True, 1.0, "1", None, parser.MAX_INPUT_BYTES + 1])
def test_intake_size_rejects_noninteger_and_out_of_range(size):
    with pytest.raises(FoobarPreparationRejected):
        window.indexed_upload_intake_bytes(size)


@pytest.mark.parametrize("payload,mapping", [
    (bytearray(b"path\n/a\n"), window.MAPPING),
    (memoryview(b"path\n/a\n"), window.MAPPING),
    ("path\n/a\n", window.MAPPING), (b"", window.MAPPING),
    (b"path\n/a\n", "other_mapping"), (b"path\n/a\n", None),
])
def test_bad_payload_or_mapping_rejected_before_parser(monkeypatch, payload, mapping):
    monkeypatch.setattr(parser, "_build_validated_upload_index", forbidden)
    with pytest.raises(FoobarPreparationRejected):
        window.build_foobar_upload_index(payload, mapping_name=mapping,
                                        intake_capacity=FoobarIntakeCapacity(1000000000))


def test_size_guard_before_parser_without_allocating_oversized_fixture(monkeypatch):
    payload = b"path\n/a\n"
    monkeypatch.setattr(parser, "MAX_INPUT_BYTES", len(payload) - 1)
    monkeypatch.setattr(parser, "_build_validated_upload_index", forbidden)
    with pytest.raises(FoobarPreparationRejected):
        window.build_foobar_upload_index(payload, intake_capacity=FoobarIntakeCapacity(1000000000))


@pytest.mark.parametrize("fake", [None, {}, SimpleNamespace(validated=True), b"path\n/a\n"])
def test_indexed_proof_rejects_caller_fabricated_shapes(fake):
    with pytest.raises(FoobarPreparationRejected):
        window.prove_indexed_foobar_source_window(fake, intake_capacity=FoobarIntakeCapacity(1000000000))


def test_terminal_diagnostic_truncation_is_preserved_even_for_one_row_window():
    payload = b"path\trating\n" + b"/same\t9\n" * (parser.MAX_DIAGNOSTICS + 1)
    expected_rows, expected_terminal = consume(parser.iter_foobar_snapshot_rows(payload, mapping_name=window.MAPPING))
    assert expected_terminal.summary.diagnostics_truncated is True
    assert len(expected_terminal.diagnostics) == parser.MAX_DIAGNOSTICS
    with build(payload) as upload:
        rows, terminal = consume(upload.iter_window(offset=0, limit=1))
        assert rows == expected_rows[:1]
        assert terminal == expected_terminal
        assert terminal.summary.field_error_count == parser.MAX_DIAGNOSTICS + 1
        assert upload.path_counts(limit=1) == (parser.MAX_DIAGNOSTICS + 1,)


def test_mixed_newlines_and_final_bare_cr_follow_genuine_parser():
    payload = b"\xef\xbb\xbftitle\tpath\r\nfirst\t/a\nsecond\t/b\r\nlast\t/c"
    expected = consume(parser.iter_foobar_snapshot_rows(payload, mapping_name=window.MAPPING))
    with build(payload) as upload:
        assert consume(upload.iter_window()) == expected
    malformed = payload + b"\r"
    _, terminal = consume(parser.iter_foobar_snapshot_rows(malformed, mapping_name=window.MAPPING))
    assert terminal.diagnostics[0].code == "invalid_line_ending"
    with pytest.raises(FoobarPreparationRejected):
        build(malformed)
