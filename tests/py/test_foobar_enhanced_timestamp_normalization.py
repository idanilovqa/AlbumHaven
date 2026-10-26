"""Synthetic timestamp-evidence contract tests, authored without execution.

No database, app startup, authentication, personal fixture, or event importer
is involved. Calendar resolution is not proof of an independently observed play.
"""
from dataclasses import FrozenInstanceError, asdict, fields, replace
import json
import struct

import pytest

from music_app.services import foobar_enhanced_record_decoder as decoder
from music_app.services import foobar_enhanced_timestamp_normalization as normalization


STORE_GUID = "0C1BD000-43E7-4078-B885-48EE4249DEC3"
CONTRACT = "foobar_enhanced_timestamp_evidence_v1"
PROVENANCE = "incomplete_possibly_seeded"
EPOCH_OFFSET = 116_444_736_000_000_000
UINT64_MAX = 18_446_744_073_709_551_615
LAST_CALENDAR_TICK = 2_650_467_743_999_999_999
MAX_TIMESTAMPS = 32_766


class IntSubclass(int):
    pass


class StringSubclass(str):
    pass


class TupleSubclass(tuple):
    pass


class RecordSubclass(decoder.EnhancedRecord):
    pass


class DecodeResultSubclass(decoder.EnhancedRecordDecodeResult):
    pass


def parsed(local=(), cached=()):
    """Use the real decoder with exclusively synthetic little-endian bytes."""
    payload = struct.pack("<IIIi", 1, len(local), len(cached), 0)
    payload += b"".join(struct.pack("<Q", ticks) for ticks in (*local, *cached))
    result = decoder.decode_enhanced_playcount_record(payload, store_guid=STORE_GUID)
    assert result.status == "parsed"
    return result


def normalize(local=(), cached=()):
    return normalization.normalize_enhanced_record_timestamps(parsed(local, cached))


def assert_invalid(decoded):
    with pytest.raises(normalization.TimestampNormalizationError) as raised:
        normalization.normalize_enhanced_record_timestamps(decoded)
    assert raised.value.code == "invalid_enhanced_timestamp_input"


def assert_evidence(item, *, field, index, raw, unix, iso, code=None):
    assert type(item) is normalization.TimestampEvidence
    assert item.source_field == field
    assert item.source_index == index
    assert type(item.source_index) is int
    assert item.raw_filetime_ticks == raw
    assert item.unix_100ns == unix
    assert type(item.raw_filetime_ticks) is str
    assert type(item.unix_100ns) is str
    assert item.iso_utc == iso
    assert item.state == ("resolved" if code is None else "unresolved")
    assert item.code == code
    assert item.precision == "100ns"
    assert item.timezone_provenance == "filetime_utc"
    assert item.conversion == "filetime_1601_to_unix_1970_exact"


def test_empty_record_has_evidence_contract_not_event_or_count_contract():
    result = normalize()
    assert type(result) is normalization.EnhancedTimestampEvidence
    assert result.contract_version == CONTRACT
    assert result.record_version == 1
    assert result.local_provenance == PROVENANCE
    assert type(result.local_timestamps) is tuple
    assert type(result.cached_lastfm_timestamps) is tuple
    assert result.local_timestamps == ()
    assert result.cached_lastfm_timestamps == ()
    assert {field.name for field in fields(result)} == {
        "contract_version", "record_version", "local_provenance",
        "local_timestamps", "cached_lastfm_timestamps",
    }


@pytest.mark.parametrize("raw,unix,iso", [
    (1, "-116444735999999999", "1601-01-01T00:00:00.0000001Z"),
    (116_444_735_989_999_999, "-10000001", "1969-12-31T23:59:58.9999999Z"),
    (116_444_735_999_999_999, "-1", "1969-12-31T23:59:59.9999999Z"),
    (116_444_736_000_000_000, "0", "1970-01-01T00:00:00.0000000Z"),
    (116_444_736_000_000_001, "1", "1970-01-01T00:00:00.0000001Z"),
    (116_444_736_001_234_567, "1234567", "1970-01-01T00:00:00.1234567Z"),
    (116_444_736_009_999_999, "9999999", "1970-01-01T00:00:00.9999999Z"),
    (116_444_736_010_000_001, "10000001", "1970-01-01T00:00:01.0000001Z"),
    (125_962_560_000_000_000, "9517824000000000", "2000-02-29T00:00:00.0000000Z"),
    (2_650_467_743_999_999_999, "2534023007999999999", "9999-12-31T23:59:59.9999999Z"),
])
def test_exact_calendar_vectors_preserve_seven_fraction_digits(raw, unix, iso):
    # Literal expected instants avoid deriving the oracle with adapter helpers.
    result = normalize((raw,), (raw,))
    for field, lane in (
        ("local_filetime_ticks", result.local_timestamps),
        ("cached_lastfm_filetime_ticks", result.cached_lastfm_timestamps),
    ):
        assert_evidence(lane[0], field=field, index=0, raw=str(raw), unix=unix, iso=iso)
    assert result.local_provenance == PROVENANCE


@pytest.mark.parametrize("raw,unix,code", [
    (0, "-116444736000000000", "zero_or_unavailable"),
    (2_650_467_744_000_000_000, "2534023008000000000", "outside_supported_calendar"),
    (18_446_744_073_709_551_614, "18330299337709551614", "outside_supported_calendar"),
    (18_446_744_073_709_551_615, "18330299337709551615", "sentinel_like"),
])
def test_unresolved_values_survive_exactly_without_calendar_guesses(raw, unix, code):
    result = normalize((raw,), (raw,))
    for field, lane in (
        ("local_filetime_ticks", result.local_timestamps),
        ("cached_lastfm_filetime_ticks", result.cached_lastfm_timestamps),
    ):
        assert_evidence(lane[0], field=field, index=0, raw=str(raw), unix=unix,
                        iso=None, code=code)


def test_order_duplicates_and_source_indexes_are_preserved_in_separate_lanes():
    local = (EPOCH_OFFSET + 1, 0, EPOCH_OFFSET - 1, EPOCH_OFFSET + 1, UINT64_MAX)
    cached = (EPOCH_OFFSET - 1, EPOCH_OFFSET + 1, EPOCH_OFFSET - 1)
    decoded = parsed(local, cached)
    result = normalization.normalize_enhanced_record_timestamps(decoded)
    assert tuple(item.raw_filetime_ticks for item in result.local_timestamps) == tuple(map(str, local))
    assert tuple(item.raw_filetime_ticks for item in result.cached_lastfm_timestamps) == tuple(map(str, cached))
    assert tuple(item.source_index for item in result.local_timestamps) == (0, 1, 2, 3, 4)
    assert tuple(item.source_index for item in result.cached_lastfm_timestamps) == (0, 1, 2)
    assert {item.source_field for item in result.local_timestamps} == {"local_filetime_ticks"}
    assert {item.source_field for item in result.cached_lastfm_timestamps} == {"cached_lastfm_filetime_ticks"}
    assert result.local_provenance == PROVENANCE
    assert decoded.record.local_filetime_ticks == local
    assert decoded.record.cached_lastfm_filetime_ticks == cached
    assert decoded.record.local_provenance == PROVENANCE


def test_cached_only_timestamps_never_become_local_history():
    result = normalize((), (EPOCH_OFFSET, EPOCH_OFFSET, EPOCH_OFFSET + 1))
    assert result.local_timestamps == ()
    assert len(result.cached_lastfm_timestamps) == 3
    assert result.local_provenance == PROVENANCE
    assert all(item.state == "resolved" for item in result.cached_lastfm_timestamps)


def test_changing_cached_history_cannot_change_local_evidence():
    local = (EPOCH_OFFSET + 1, EPOCH_OFFSET - 1, EPOCH_OFFSET + 1)
    without_cache = normalize(local)
    with_cache = normalize(local, (UINT64_MAX, 0, LAST_CALENDAR_TICK, EPOCH_OFFSET))
    assert with_cache.local_timestamps == without_cache.local_timestamps
    assert with_cache.local_provenance == without_cache.local_provenance == PROVENANCE


@pytest.mark.parametrize("local,cached", [
    ((EPOCH_OFFSET,), ()),
    ((), (EPOCH_OFFSET,)),
    ((EPOCH_OFFSET,), (EPOCH_OFFSET,)),
])
def test_result_and_each_evidence_item_are_immutable(local, cached):
    result = normalize(local, cached)
    with pytest.raises(FrozenInstanceError):
        result.local_provenance = "complete"
    with pytest.raises(FrozenInstanceError):
        result.local_timestamps = ()
    for item in (*result.local_timestamps, *result.cached_lastfm_timestamps):
        with pytest.raises(FrozenInstanceError):
            item.source_field = "local_filetime_ticks"
        with pytest.raises(FrozenInstanceError):
            item.raw_filetime_ticks = "0"
    lane = result.local_timestamps or result.cached_lastfm_timestamps
    with pytest.raises(TypeError):
        lane[0] = lane[0]


def test_decimal_strings_round_trip_json_without_js_number_precision_loss():
    # FILETIME values already exceed 2**53 near the Unix epoch. Adjacent 100 ns
    # values, extreme raw ticks, and signed converted ticks must stay distinct.
    raw = (EPOCH_OFFSET - 1, EPOCH_OFFSET, EPOCH_OFFSET + 1, LAST_CALENDAR_TICK, UINT64_MAX)
    result = normalize(raw, raw[::-1])
    restored = json.loads(json.dumps(asdict(result)))
    for key, expected in (("local_timestamps", raw), ("cached_lastfm_timestamps", raw[::-1])):
        assert [item["raw_filetime_ticks"] for item in restored[key]] == list(map(str, expected))
        assert [item["unix_100ns"] for item in restored[key]] == [str(value - EPOCH_OFFSET) for value in expected]
        assert all(type(item["raw_filetime_ticks"]) is str for item in restored[key])
        assert all(type(item["unix_100ns"]) is str for item in restored[key])


@pytest.mark.parametrize("raw,iso", [
    (133_545_275_990_000_000, "2024-03-10T06:59:59.0000000Z"),
    (133_545_276_000_000_000, "2024-03-10T07:00:00.0000000Z"),
    (133_750_871_990_000_000, "2024-11-03T05:59:59.0000000Z"),
    (133_750_872_000_000_000, "2024-11-03T06:00:00.0000000Z"),
])
def test_dst_boundary_instants_are_utc_not_wall_clock_guesses(raw, iso):
    # These UTC instants straddle US DST transitions. No local timezone or
    # ambiguous wall-clock interpretation is supplied by numeric FILETIME.
    item = normalize((raw,)).local_timestamps[0]
    assert item.iso_utc == iso
    assert item.timezone_provenance == "filetime_utc"
    assert item.state == "resolved"


@pytest.mark.parametrize("value", [None, {}, (), b"", "parsed", 1, True])
def test_non_decoder_result_inputs_are_rejected(value):
    assert_invalid(value)


def test_actual_decoder_rejection_is_not_normalized():
    rejected = decoder.decode_enhanced_playcount_record(b"", store_guid=STORE_GUID)
    assert rejected.status == "rejected"
    assert_invalid(rejected)


@pytest.mark.parametrize("field,value", [
    ("contract_version", None),
    ("contract_version", "foobar_enhanced_playcount_record_v2"),
    ("contract_version", StringSubclass("foobar_enhanced_playcount_record_v1")),
    ("status", None),
    ("status", "rejected"),
    ("status", "accepted"),
    ("status", StringSubclass("parsed")),
    ("diagnostics", []),
    ("diagnostics", TupleSubclass()),
    ("diagnostics", (decoder.RecordDiagnostic("malformed", "test_only"),)),
    ("record", None),
    ("record", {}),
])
def test_malformed_result_fields_fail_closed(field, value):
    assert_invalid(replace(parsed((EPOCH_OFFSET,)), **{field: value}))


@pytest.mark.parametrize("field,value", [
    ("record_version", 0),
    ("record_version", 2),
    ("record_version", 1.0),
    ("record_version", True),
    ("record_version", IntSubclass(1)),
    ("local_provenance", None),
    ("local_provenance", "complete"),
    ("local_provenance", "independently_observed"),
    ("local_provenance", StringSubclass(PROVENANCE)),
    ("local_filetime_ticks", []),
    ("local_filetime_ticks", TupleSubclass((EPOCH_OFFSET,))),
    ("local_filetime_ticks", None),
    ("cached_lastfm_filetime_ticks", []),
    ("cached_lastfm_filetime_ticks", TupleSubclass((EPOCH_OFFSET,))),
    ("cached_lastfm_filetime_ticks", None),
])
def test_malformed_record_fields_fail_closed(field, value):
    decoded = parsed((EPOCH_OFFSET,), (EPOCH_OFFSET,))
    record = replace(decoded.record, **{field: value})
    assert_invalid(replace(decoded, record=record))


@pytest.mark.parametrize("field", ["local_filetime_ticks", "cached_lastfm_filetime_ticks"])
@pytest.mark.parametrize("value", [
    -1, UINT64_MAX + 1, True, False, 1.0, IntSubclass(1), "1", b"1", None,
])
def test_timestamp_elements_require_builtin_uint64_in_each_lane(field, value):
    decoded = parsed((EPOCH_OFFSET,), (EPOCH_OFFSET,))
    record = replace(decoded.record, **{field: (EPOCH_OFFSET, value)})
    assert_invalid(replace(decoded, record=record))


def test_result_and_record_subclasses_cannot_impersonate_decoder_output():
    decoded = parsed((EPOCH_OFFSET,))
    assert_invalid(DecodeResultSubclass(
        decoded.contract_version, decoded.status, decoded.record, decoded.diagnostics,
    ))
    assert_invalid(replace(decoded, record=RecordSubclass(1, (EPOCH_OFFSET,), ())))


def test_uninitialized_dataclass_instances_fail_closed():
    assert_invalid(object.__new__(decoder.EnhancedRecordDecodeResult))
    assert_invalid(replace(parsed(), record=object.__new__(decoder.EnhancedRecord)))


def test_bad_final_cached_element_rejects_before_any_timestamp_conversion(monkeypatch):
    decoded = parsed((EPOCH_OFFSET, EPOCH_OFFSET + 1), (EPOCH_OFFSET,))
    malformed = replace(decoded, record=replace(
        decoded.record, cached_lastfm_filetime_ticks=(EPOCH_OFFSET, "synthetic-invalid-tick"),
    ))

    def unexpected_conversion(_ticks):
        raise AssertionError("Timestamp conversion began before atomic input validation.")

    monkeypatch.setattr(normalization, "filetime_to_unix_100ns", unexpected_conversion)
    with pytest.raises(normalization.TimestampNormalizationError) as raised:
        normalization.normalize_enhanced_record_timestamps(malformed)
    assert raised.value.code == "invalid_enhanced_timestamp_input"
    assert "synthetic-invalid-tick" not in str(raised.value)


@pytest.mark.parametrize("local_count,cached_count", [
    (MAX_TIMESTAMPS, 0), (0, MAX_TIMESTAMPS), (MAX_TIMESTAMPS // 2, MAX_TIMESTAMPS // 2),
])
def test_exact_combined_resource_boundary_preserves_all_positions(local_count, cached_count):
    local = (EPOCH_OFFSET + 1,) * local_count
    cached = (EPOCH_OFFSET - 1,) * cached_count
    result = normalize(local, cached)
    assert len(result.local_timestamps) == local_count
    assert len(result.cached_lastfm_timestamps) == cached_count
    for field, lane, count, raw in (
        ("local_filetime_ticks", result.local_timestamps, local_count, EPOCH_OFFSET + 1),
        ("cached_lastfm_filetime_ticks", result.cached_lastfm_timestamps, cached_count, EPOCH_OFFSET - 1),
    ):
        assert tuple(item.source_index for item in lane) == tuple(range(count))
        assert all(item.source_field == field for item in lane)
        assert all(item.raw_filetime_ticks == str(raw) for item in lane)


@pytest.mark.parametrize("local_count,cached_count", [
    (MAX_TIMESTAMPS + 1, 0), (0, MAX_TIMESTAMPS + 1),
    (MAX_TIMESTAMPS, 1), (1, MAX_TIMESTAMPS),
])
def test_over_combined_resource_boundary_rejects_constructed_decoder_evidence(local_count, cached_count):
    decoded = parsed()
    record = replace(decoded.record,
                     local_filetime_ticks=(EPOCH_OFFSET,) * local_count,
                     cached_lastfm_filetime_ticks=(EPOCH_OFFSET,) * cached_count)
    assert_invalid(replace(decoded, record=record))
