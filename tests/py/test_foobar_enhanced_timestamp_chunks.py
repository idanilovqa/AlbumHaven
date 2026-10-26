"""Additive synthetic streaming contract tests; authored, not executed."""
from dataclasses import FrozenInstanceError, replace
import struct

import pytest

from music_app.services import foobar_enhanced_record_decoder as decoder
from music_app.services import foobar_enhanced_timestamp_normalization as normal

OFFSET = 116_444_736_000_000_000


def parsed(local=(), cached=()):
    payload = struct.pack('<IIIi', 1, len(local), len(cached), 0)
    payload += b''.join(struct.pack('<Q', value) for lane in (local, cached) for value in lane)
    result = decoder.decode_enhanced_playcount_record(payload, store_guid=decoder.ENHANCED_PLAYCOUNT_STORE_GUID)
    assert result.status == 'parsed'
    return result


def test_small_stream_equals_existing_genuine_normalizer_without_lane_merge():
    decoded = parsed((0, OFFSET-1, OFFSET, OFFSET, 2**64-1), (OFFSET, 2_650_467_744_000_000_000))
    expected = normal.normalize_enhanced_record_timestamps(decoded)
    stream = normal.iter_enhanced_record_timestamp_chunks(decoded)
    local = next(stream)
    cached = next(stream)
    summary = next(stream)
    assert local.timestamps == expected.local_timestamps
    assert cached.timestamps == expected.cached_lastfm_timestamps
    assert local.source_field == 'local_filetime_ticks'
    assert cached.source_field == 'cached_lastfm_filetime_ticks'
    assert local.timestamps[1].unix_100ns == '-1'
    assert local.timestamps[1].iso_utc == '1969-12-31T23:59:59.9999999Z'
    assert local.timestamps[2] != local.timestamps[3]  # Distinct source indexes, not deduplication.
    assert summary.local_provenance == 'incomplete_possibly_seeded'
    assert (summary.local_timestamp_count, summary.cached_lastfm_timestamp_count) == (5, 2)
    assert summary.chunk_count == 2
    assert summary.total_emitted_logical_charge_bytes == normal.enhanced_timestamp_total_emitted_logical_charge(decoded)
    with pytest.raises(StopIteration):
        next(stream)


def test_empty_lanes_emit_only_terminal_summary():
    stream = normal.iter_enhanced_record_timestamp_chunks(parsed())
    summary = next(stream)
    assert type(summary) is normal.EnhancedTimestampStreamSummary
    assert (summary.local_timestamp_count, summary.cached_lastfm_timestamp_count, summary.chunk_count) == (0, 0, 0)
    assert summary.total_emitted_logical_charge_bytes == 512
    with pytest.raises(StopIteration):
        next(stream)


def test_maximum_record_streams_bounded_single_lane_chunks_with_absolute_indexes():
    decoded = parsed((OFFSET,) * 16_383, (OFFSET+1,) * 16_383)
    stream = normal.iter_enhanced_record_timestamp_chunks(decoded)
    counts = {'local_filetime_ticks': 0, 'cached_lastfm_filetime_ticks': 0}
    chunks = 0
    saw_cached = False
    while True:
        item = next(stream)
        if type(item) is normal.EnhancedTimestampStreamSummary:
            summary = item
            del item
            break
        assert type(item) is normal.EnhancedTimestampChunk
        assert 1 <= len(item.timestamps) <= 128
        if item.source_field == 'cached_lastfm_filetime_ticks':
            saw_cached = True
        else:
            assert not saw_cached
        assert item.start_index == counts[item.source_field]
        assert tuple(entry.source_index for entry in item.timestamps) == tuple(range(item.start_index, item.start_index+len(item.timestamps)))
        assert all(entry.source_field == item.source_field for entry in item.timestamps)
        counts[item.source_field] += len(item.timestamps)
        chunks += 1
        del item  # Release the previous expanded output before requesting another.
    assert counts == {'local_filetime_ticks': 16_383, 'cached_lastfm_filetime_ticks': 16_383}
    assert chunks == summary.chunk_count == 256
    assert summary.total_emitted_logical_charge_bytes == 32_766*512 + 256*512 + 512
    assert normal.MAX_TIMESTAMP_STREAM_RETAINED_LOGICAL_CHARGE_BYTES == 66_048
    assert summary.total_emitted_logical_charge_bytes > normal.MAX_TIMESTAMP_STREAM_RETAINED_LOGICAL_CHARGE_BYTES
    with pytest.raises(StopIteration):
        next(stream)


@pytest.mark.parametrize('bad', [True, -1, 2**64, '1'])
def test_invalid_cached_tail_rejected_before_any_local_output(bad):
    decoded = parsed((OFFSET,) * 128, ())
    decoded = replace(decoded, record=replace(decoded.record, cached_lastfm_filetime_ticks=(bad,)))
    stream = normal.iter_enhanced_record_timestamp_chunks(decoded)
    with pytest.raises(normal.TimestampNormalizationError):
        next(stream)
    with pytest.raises(normal.TimestampNormalizationError):
        normal.enhanced_timestamp_total_emitted_logical_charge(decoded)


def test_over_limit_combined_lanes_rejected_before_expansion():
    decoded = parsed()
    decoded = replace(decoded, record=replace(decoded.record, local_filetime_ticks=(OFFSET,)*32_766, cached_lastfm_filetime_ticks=(OFFSET,)))
    with pytest.raises(normal.TimestampNormalizationError):
        next(normal.iter_enhanced_record_timestamp_chunks(decoded))


def test_quote_does_not_expand_timestamp_objects(monkeypatch):
    def forbidden(*args):
        raise AssertionError('quote expanded a timestamp')
    monkeypatch.setattr(normal, '_timestamp', forbidden)
    assert normal.enhanced_timestamp_total_emitted_logical_charge(parsed((OFFSET,)*129, (OFFSET,))) == 130*512+3*512+512


def test_early_close_has_no_terminal_and_cannot_establish_complete_conversion():
    stream = normal.iter_enhanced_record_timestamp_chunks(parsed((OFFSET,)*129))
    first = next(stream)
    assert type(first) is normal.EnhancedTimestampChunk
    del first
    stream.close()
    with pytest.raises(StopIteration):
        next(stream)
    # The actual review owner must reject absence of terminal evidence; this
    # test does not invent a production consumer or claim outer SQLite completion.


def test_chunks_and_terminal_are_immutable():
    stream = normal.iter_enhanced_record_timestamp_chunks(parsed((OFFSET,)))
    chunk = next(stream)
    with pytest.raises(FrozenInstanceError):
        chunk.start_index = 1
    summary = next(stream)
    with pytest.raises(FrozenInstanceError):
        summary.local_timestamp_count = 2


def test_invalid_second_lane_never_invokes_conversion(monkeypatch):
    decoded = parsed((OFFSET,), ())
    decoded = replace(decoded, record=replace(decoded.record, cached_lastfm_filetime_ticks=(False,)))
    def forbidden(*args):
        raise AssertionError('conversion occurred before full validation')
    monkeypatch.setattr(normal, '_timestamp', forbidden)
    with pytest.raises(normal.TimestampNormalizationError):
        next(normal.iter_enhanced_record_timestamp_chunks(decoded))
