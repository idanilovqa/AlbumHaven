"""Synthetic record-contract tests; no database or private fixture assets."""
from dataclasses import FrozenInstanceError
import struct

import pytest

from music_app.services import foobar_enhanced_record_decoder as decoder

STORE_GUID = "0C1BD000-43E7-4078-B885-48EE4249DEC3"
CONTRACT = "foobar_enhanced_playcount_record_v1"
EPOCH_OFFSET = 116444736000000000
UINT64_MAX = (1 << 64) - 1
UINT32_MAX = (1 << 32) - 1


class BytesSubclass(bytes):
    pass


class StringSubclass(str):
    pass


class IntSubclass(int):
    pass


def header(local_count=0, cached_count=0, *, version=1, reserved=0):
    return struct.pack("<IIIi", version, local_count, cached_count, reserved)


def payload(local=(), cached=()):
    return header(len(local), len(cached)) + b"".join(
        struct.pack("<Q", ticks) for ticks in (*local, *cached)
    )


def assert_rejected(result, category, code):
    assert result.contract_version == CONTRACT
    assert result.status == "rejected"
    assert result.record is None
    assert result.diagnostics == (decoder.RecordDiagnostic(category, code),)


def test_public_contract_constants():
    assert decoder.ENHANCED_PLAYCOUNT_STORE_GUID == STORE_GUID
    assert decoder.MAX_RECORD_BYTES == 262144
    assert decoder.MAX_TIMESTAMPS == 32766
    assert decoder.MAX_TIMESTAMPS == (decoder.MAX_RECORD_BYTES - 16) // 8
    assert decoder.FILETIME_UNIX_EPOCH_OFFSET == EPOCH_OFFSET


@pytest.mark.parametrize("local,cached", [
    ((), ()),
    ((0,), ()),
    ((), (42,)),
    ((), (0, UINT64_MAX, 0)),
    ((17, 17, 4), (17, 3, 17)),
    ((UINT64_MAX, (1 << 53) + 1, 0, UINT64_MAX),
     ((1 << 53) + 3, (1 << 53) + 1, 2)),
])
def test_preserves_local_and_cached_histories_without_merging(local, cached):
    result = decoder.decode_enhanced_playcount_record(
        payload(local, cached), store_guid=STORE_GUID
    )
    assert result.contract_version == CONTRACT
    assert result.status == "parsed"
    assert result.diagnostics == ()
    assert result.record == decoder.EnhancedRecord(1, local, cached)
    assert result.record.local_provenance == "incomplete_possibly_seeded"
    assert type(result.record.local_filetime_ticks) is tuple
    assert type(result.record.cached_lastfm_filetime_ticks) is tuple
    assert all(type(ticks) is int for ticks in (
        *result.record.local_filetime_ticks,
        *result.record.cached_lastfm_filetime_ticks,
    ))


def test_literal_wire_record_uses_little_endian_header_and_unsigned_ticks():
    # Deliberately independent of the fixture builder's struct format.
    raw = bytes.fromhex(
        "01000000 02000000 01000000 00000000 "
        "0102030405060708 ffffffffffffffff 2a00000000000000"
    )
    result = decoder.decode_enhanced_playcount_record(raw, store_guid=STORE_GUID)
    assert result.status == "parsed"
    assert result.record == decoder.EnhancedRecord(
        1, (0x0807060504030201, UINT64_MAX), (42,)
    )


@pytest.mark.parametrize("value", [
    None, 1, "", bytearray(), memoryview(b""), BytesSubclass(b""),
])
def test_rejects_non_builtin_bytes_payloads(value):
    result = decoder.decode_enhanced_playcount_record(value, store_guid=STORE_GUID)
    assert_rejected(result, "malformed", "invalid_payload_type")


@pytest.mark.parametrize("store_guid", [
    None,
    1,
    STORE_GUID.encode("ascii"),
    StringSubclass(STORE_GUID),
    "",
    STORE_GUID.lower(),
    " " + STORE_GUID,
    STORE_GUID + " ",
    "{" + STORE_GUID + "}",
    "not-the-enhanced-store",
    "foo_enhanced_playcount",
    "metadb.sqlite",
    "0C1BD000-43E7-4078-B885-48EE4249DED0",
    "0C1BD000-43E7-4078-B885-48EE4249DEC2",
])
def test_store_must_be_explicit_exact_builtin_string(store_guid):
    result = decoder.decode_enhanced_playcount_record(
        payload((1,), (2,)), store_guid=store_guid
    )
    assert_rejected(result, "unsupported", "unsupported_store")


def test_opaque_standard_record_is_not_auto_detected_from_its_40_byte_length():
    # Even enhanced-looking bytes are not accepted from an unrelated store.
    raw = payload((1, 2), (3,))
    assert len(raw) == 40
    result = decoder.decode_enhanced_playcount_record(
        raw, store_guid="foo_playcount"
    )
    assert_rejected(result, "unsupported", "unsupported_store")


def test_store_selection_is_required_and_keyword_only():
    with pytest.raises(TypeError):
        decoder.decode_enhanced_playcount_record(payload())
    with pytest.raises(TypeError):
        decoder.decode_enhanced_playcount_record(payload(), STORE_GUID)


@pytest.mark.parametrize("length", range(16))
def test_every_truncated_header_is_rejected(length):
    result = decoder.decode_enhanced_playcount_record(
        header()[:length], store_guid=STORE_GUID
    )
    assert_rejected(result, "malformed", "truncated_header")


@pytest.mark.parametrize("version", [0, 2, UINT32_MAX])
def test_unknown_record_versions_are_not_guessed(version):
    result = decoder.decode_enhanced_playcount_record(
        header(version=version), store_guid=STORE_GUID
    )
    assert_rejected(result, "unsupported", "unsupported_version")


@pytest.mark.parametrize("reserved", [1, -1, (1 << 31) - 1, -(1 << 31)])
def test_nonzero_signed_reserved_field_is_unsupported(reserved):
    result = decoder.decode_enhanced_playcount_record(
        header(reserved=reserved), store_guid=STORE_GUID
    )
    assert_rejected(result, "unsupported", "unsupported_reserved")


@pytest.mark.parametrize("local_count,cached_count,body", [
    (0, 0, b"\x00"),
    (0, 0, b"\x00" * 8),
    (1, 0, b""),
    (1, 0, b"\x00" * 7),
    (0, 1, b"\x00" * 7),
    (1, 1, b"\x00" * 8),
    (1, 1, b"\x00" * 15),
    (1, 1, b"\x00" * 17),
    (1, 1, b"\x00" * 24),
])
def test_declared_counts_require_exact_record_length(local_count, cached_count, body):
    result = decoder.decode_enhanced_playcount_record(
        header(local_count, cached_count) + body, store_guid=STORE_GUID
    )
    assert_rejected(result, "malformed", "invalid_record_length")


@pytest.mark.parametrize("missing_bytes", range(1, 8))
def test_truncated_final_cached_timestamp_never_returns_partial_local_history(missing_bytes):
    raw = payload((10, 20), (30, 40))
    result = decoder.decode_enhanced_playcount_record(
        raw[:-missing_bytes], store_guid=STORE_GUID
    )
    assert_rejected(result, "malformed", "invalid_record_length")


@pytest.mark.parametrize("trailing_bytes", [b"\x00", b"\x00" * 8, header()])
def test_trailing_bytes_are_not_ignored_or_decoded_as_another_record(trailing_bytes):
    result = decoder.decode_enhanced_playcount_record(
        payload((10,), (20,)) + trailing_bytes, store_guid=STORE_GUID
    )
    assert_rejected(result, "malformed", "invalid_record_length")


@pytest.mark.parametrize("local_count,cached_count", [
    (UINT32_MAX, 0),
    (0, UINT32_MAX),
    (UINT32_MAX, UINT32_MAX),
    (32767, 0),
    (0, 32767),
    (32766, 1),
    (16383, 16384),
])
def test_huge_declared_counts_are_rejected_from_header_alone(local_count, cached_count):
    # No timestamp-sized allocation is needed to exercise hostile uint32 counts.
    result = decoder.decode_enhanced_playcount_record(
        header(local_count, cached_count), store_guid=STORE_GUID
    )
    assert_rejected(result, "too_large", "too_many_timestamps")


@pytest.mark.parametrize("local_count", [0, 1, 16383, 32766])
def test_exact_resource_boundary_preserves_every_timestamp(local_count):
    local = tuple(range(local_count))
    cached = tuple((1 << 53) + index for index in range(32766 - local_count))
    raw = payload(local, cached)
    assert len(raw) == 262144
    result = decoder.decode_enhanced_playcount_record(raw, store_guid=STORE_GUID)
    assert result.status == "parsed"
    assert result.diagnostics == ()
    assert result.record == decoder.EnhancedRecord(1, local, cached)


def test_one_byte_over_resource_boundary_is_rejected_without_truncation():
    raw = header() + b"\x00" * (262144 - 16 + 1)
    assert len(raw) == 262145
    result = decoder.decode_enhanced_playcount_record(raw, store_guid=STORE_GUID)
    assert_rejected(result, "too_large", "record_too_large")


def test_guard_precedence_is_deterministic():
    oversized = header(version=2) + b"\x00" * (262144 - 16 + 1)
    cases = (
        (bytearray(oversized), "wrong", "malformed", "invalid_payload_type"),
        (oversized, "wrong", "unsupported", "unsupported_store"),
        (oversized, STORE_GUID, "too_large", "record_too_large"),
        (header(version=2)[:4], STORE_GUID, "malformed", "truncated_header"),
        (header(UINT32_MAX, UINT32_MAX, version=2, reserved=-1),
         STORE_GUID, "unsupported", "unsupported_version"),
        (header(UINT32_MAX, UINT32_MAX, reserved=-1),
         STORE_GUID, "unsupported", "unsupported_reserved"),
        (header(32766, 1), STORE_GUID, "too_large", "too_many_timestamps"),
    )
    for raw, store_guid, category, code in cases:
        result = decoder.decode_enhanced_playcount_record(raw, store_guid=store_guid)
        assert_rejected(result, category, code)


def test_decoded_results_records_and_diagnostics_are_immutable():
    parsed = decoder.decode_enhanced_playcount_record(
        payload((1, 2), (3,)), store_guid=STORE_GUID
    )
    rejected = decoder.decode_enhanced_playcount_record(b"", store_guid=STORE_GUID)
    with pytest.raises(FrozenInstanceError):
        parsed.status = "rejected"
    with pytest.raises(FrozenInstanceError):
        parsed.record.local_filetime_ticks = ()
    with pytest.raises(FrozenInstanceError):
        parsed.record.cached_lastfm_filetime_ticks = ()
    with pytest.raises(FrozenInstanceError):
        rejected.diagnostics[0].code = "changed"
    with pytest.raises(TypeError):
        parsed.record.local_filetime_ticks[0] = 99
    for value in (parsed, parsed.record, rejected, rejected.diagnostics[0]):
        assert not hasattr(value, "__dict__")


@pytest.mark.parametrize("ticks,expected", [
    (0, -116444736000000000),
    (EPOCH_OFFSET - 10000001, -10000001),
    (EPOCH_OFFSET - 1, -1),
    (EPOCH_OFFSET, 0),
    (EPOCH_OFFSET + 1, 1),
    (EPOCH_OFFSET + 10000001, 10000001),
    (EPOCH_OFFSET + (1 << 53) + 1, (1 << 53) + 1),
    (UINT64_MAX, 18330299337709551615),
])
def test_filetime_conversion_preserves_exact_signed_100ns_units(ticks, expected):
    actual = decoder.filetime_to_unix_100ns(ticks)
    assert type(actual) is int
    assert actual == expected


@pytest.mark.parametrize("ticks", [True, False, IntSubclass(1), 0.0, "0", None])
def test_filetime_conversion_rejects_non_builtin_integers(ticks):
    with pytest.raises(TypeError):
        decoder.filetime_to_unix_100ns(ticks)


@pytest.mark.parametrize("ticks", [-1, -(1 << 100), 1 << 64, 1 << 100])
def test_filetime_conversion_rejects_out_of_uint64_range(ticks):
    with pytest.raises(ValueError):
        decoder.filetime_to_unix_100ns(ticks)
