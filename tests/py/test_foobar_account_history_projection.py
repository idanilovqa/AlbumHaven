"""Independent pure codec regressions, AUTHORED ONLY, not executed.

Both count families are intentionally separate. A boundary marker plus one
aggregate is not an event list, measured duration, session or Last.fm history.
"""
from copy import deepcopy
from dataclasses import replace
import json
import pytest
from tests.py.foobar_account_history_values import (
    codec, evidence, display, parser, projection, materialize, payload, digest, FIRST, LAST,
)


def encode_json(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


@pytest.mark.parametrize('family,suffix', [('standard', ''), ('enhanced', '_enhanced')])
@pytest.mark.parametrize('count,marker,remainder', [(0, 0, 0), (1, 1, 0), (2, 1, 1),
    (9007199254740993, 1, 9007199254740992), (9223372036854775807, 1, 9223372036854775806)])
def test_count_partition_is_exact_without_expanding_events(family, suffix, count, marker, remainder):
    cells = {'play_count' + suffix: count}
    if count:
        cells.update({'first_played' + suffix: FIRST, 'last_played' + suffix: FIRST if count == 1 else LAST})
    value = projection(**cells)
    selected = getattr(value, family)
    assert (selected.status, selected.total, selected.first_marker_weight, selected.aggregate_remainder) == (
        'ready', count, marker, remainder)
    assert selected.first_marker_weight + selected.aggregate_remainder == count
    wire = codec.public_family_projection(value, family=family)
    assert wire['total'] == str(count) and wire['aggregate_remainder'] == str(remainder)
    assert wire['show_grouped_count'] is (count > 1)
    assert wire['show_remainder_count'] is (remainder > 1)
    assert len(codec.encode_account_history_projection(value)) <= codec.MAX_PROJECTION_BYTES
    assert not set(wire).intersection({'events', 'plays', 'duration', 'duration_seconds', 'session', 'lastfm', 'track_id', 'path'})


def test_families_never_prefer_sum_or_replace_each_other():
    value = projection(play_count=2, first_played=FIRST, last_played=LAST,
        play_count_enhanced=9007199254740993, first_played_enhanced=LAST, last_played_enhanced=LAST)
    standard = codec.public_family_projection(value, family='standard')
    enhanced = codec.public_family_projection(value, family='enhanced')
    assert standard['total'] == '2' and enhanced['total'] == '9007199254740993'
    assert standard['aggregate_remainder'] == '1' and enhanced['aggregate_remainder'] == '9007199254740992'
    assert standard['first']['label'] == FIRST and enhanced['first']['label'] == LAST
    assert standard['source_kind'] == enhanced['source_kind'] == 'foobar_local'
    for family in ('lastfm', 'auto', 'combined', '', True, None):
        with pytest.raises(codec.AccountHistoryProjectionError):
            codec.public_family_projection(value, family=family)


@pytest.mark.parametrize('first,last,marker,remainder', [(None, None, 0, 2), (None, LAST, 0, 2),
    (FIRST, None, 1, 1), (FIRST, FIRST, 1, 1)])
def test_equal_and_missing_boundaries_preserve_aggregate_semantics(first, last, marker, remainder):
    value = projection(play_count=2, first_played=first, last_played=last).standard
    assert value.status == 'ready'
    assert (value.first_marker_weight, value.aggregate_remainder) == (marker, remainder)
    assert value.remainder_sort_key == (codec.MIN_SORT_KEY if last is None else value.last.unix_microseconds)
    assert (value.first_sort_key is None) is (marker == 0)


@pytest.mark.parametrize('count,first,last,reason', [
    (0, FIRST, None, 'zero_count_with_boundaries'),
    (0, None, LAST, 'zero_count_with_boundaries'),
    (2, LAST, FIRST, 'boundary_order_conflict'),
    (1, FIRST, LAST, 'single_count_boundary_conflict'),
    (1, 'unknown first', 'unknown last', 'single_count_boundary_conflict'),
])
def test_conflicting_boundaries_are_diagnostics_not_fabricated_listens(count, first, last, reason):
    selected = projection(play_count=count, first_played=first, last_played=last).standard
    assert (selected.status, selected.reason) == ('needs_reconciliation', reason)
    assert selected.first_marker_weight == 0 and selected.aggregate_remainder is None
    assert selected.first_sort_key is None


@pytest.mark.parametrize('count,state,status,reason', [(None, 'absent', 'unavailable', 'count_unavailable'),
    ('', 'empty', 'unavailable', 'count_unavailable'), ('N/A', 'unavailable', 'unavailable', 'count_unavailable'),
    ('bad count', 'invalid', 'needs_reconciliation', 'invalid_count'),
    ('-1', 'invalid', 'needs_reconciliation', 'invalid_count')])
def test_unknown_invalid_counts_do_not_imply_zero(count, state, status, reason):
    value = projection(play_count=count, first_played=FIRST).standard
    assert (value.count_state, value.status, value.reason) == (state, status, reason)
    assert value.total is None and value.aggregate_remainder is None and value.first_marker_weight == 0


@pytest.mark.parametrize('first,last', [
    ('2026-01-01T00:00:00Z', '2026-01-01T00:00:00.500000Z'),
    ('2026-01-01T00:00:00.5Z', '2026-01-01T00:00:00.500001Z'),
    ('2026-01-01T01:00:00+01:00', '2026-01-01T00:00:00Z'),
    ('unresolved local label', 'unresolved local label'),
])
def test_single_count_compatible_precision_intervals_or_identical_unresolved_labels(first, last):
    selected = projection(play_count=1, first_played=first, last_played=last).standard
    assert selected.status == 'ready' and selected.first_marker_weight == 1 and selected.aggregate_remainder == 0


def test_mixed_precision_order_uses_interval_not_rounded_float():
    overlap = projection(play_count=2, first_played='2026-01-01T00:00:00.900000Z', last_played=FIRST).standard
    assert overlap.status == 'ready'
    disjoint = projection(play_count=2, first_played='2026-01-01T00:00:01.000000Z', last_played=FIRST).standard
    assert (disjoint.status, disjoint.reason) == ('needs_reconciliation', 'boundary_order_conflict')
    left = projection(play_count=2, first_played='2026-01-01T00:00:00.000001Z', last_played=LAST).standard
    right = projection(play_count=2, first_played='2026-01-01T00:00:00.000002Z', last_played=LAST).standard
    assert right.first_sort_key - left.first_sort_key == 1


@pytest.mark.parametrize('raw', [
    '2026-01-01', '2026-01-01T00:00:00', '2026-01-01t00:00:00z',
    ' 2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z ', '2026-01-01T00:00:60Z',
    '2026-02-30T00:00:00Z', '2026-01-01T00:00:00.1234567Z',
    '2026-01-01T00:00:00-00:00', '2026-01-01T00:00:00+14:01',
    '2026-01-01T00:00:00-14:01', '2026-01-01T00:00:00+15:00',
    '2026-01-01T00:00:00+01:60', '0000-01-01T00:00:00Z',
    '0001-01-01T00:00:00+14:00', '9999-12-31T23:59:59-14:00',
])
def test_unresolved_timestamp_grammar_and_bounds_never_claim_utc(raw):
    selected = projection(play_count=2, first_played=raw, last_played=raw).standard
    assert selected.status == 'ready' and selected.first_marker_weight == 1
    assert selected.first.resolution == selected.last.resolution == 'unresolved'
    assert selected.first.unix_microseconds is selected.last.unix_microseconds is None
    assert selected.first.fraction_digits is None
    assert selected.first_sort_key == selected.remainder_sort_key == codec.MIN_SORT_KEY
    public = codec.public_family_projection(projection(play_count=2, first_played=raw), family='standard')
    assert public['first']['unix_microseconds'] is None and public['timestamp_coverage'] == 'boundary_evidence'


@pytest.mark.parametrize('raw,key,digits', [
    ('1970-01-01T00:00:00Z', 0, 0), ('1970-01-01T00:00:00.000001Z', 1, 6),
    ('1969-12-31T23:59:59.999999Z', -1, 6), ('1970-01-01T14:00:00+14:00', 0, 0),
    ('1969-12-31T10:00:00-14:00', 0, 0), ('1970-01-01T00:00:00+00:00', 0, 0),
    ('0001-01-01T00:00:00Z', -62135596800000000, 0),
    ('9999-12-31T23:59:59.999999Z', 253402300799999999, 6),
])
def test_exact_iso_microseconds_and_legal_extreme_offsets(raw, key, digits):
    selected = projection(play_count=1, first_played=raw, last_played=raw).standard
    assert selected.first.resolution == 'resolved'
    assert selected.first.unix_microseconds == key and selected.first.fraction_digits == digits
    assert selected.first_sort_key == selected.grouped_sort_key == key


def test_corrected_count_replaces_current_projection_never_appends_or_accumulates():
    old = projection(revision=1, play_count=19, first_played=FIRST, last_played=LAST)
    lower = projection(revision=2, play_count=2, first_played=FIRST, last_played=LAST)
    zero = projection(revision=3, play_count=0)
    assert (old.standard.total, lower.standard.total, zero.standard.total) == (19, 2, 0)
    assert lower.standard.aggregate_remainder == 1 and zero.standard.aggregate_remainder == 0
    assert len(codec.encode_account_history_projection(lower)) < codec.MAX_PROJECTION_BYTES


def test_unsupported_history_arrays_and_lastfm_cells_do_not_contribute():
    value = projection(play_count=2, first_played=FIRST, last_played=LAST,
        played_times='[100,200,300]', lastfm_play_count=999, lastfm_played_times='[400,500]')
    wire = codec.public_family_projection(value, family='standard')
    assert wire['total'] == '2' and wire['aggregate_remainder'] == '1'
    assert value.enhanced.total is None
    assert not any('lastfm' in key or 'duration' in key or key == 'events' for key in wire)


def test_bounded_utf8_labels_are_prefixes_not_partial_multibyte_sequences():
    value = projection(artist='😀' * 100, title='é' * 100, album='漢' * 100,
        play_count=2, first_played='😀' * 100)
    for label, maximum in zip((value.artist, value.title, value.album), (48, 96, 48)):
        assert label.truncated and len(label.text.encode('utf-8')) <= maximum
    assert value.standard.first.truncated and len(value.standard.first.label.encode('utf-8')) == 128
    assert value.standard.first.source_sha256 == digest(('😀' * 100).encode())
    assert value.standard.first.resolution == 'unresolved'
    raw = codec.encode_account_history_projection(value)
    assert codec.decode_account_history_projection(raw) == value and len(raw) <= 8192


def test_codec_canonical_roundtrip_and_complete_source_association():
    effective, labels = materialize(play_count=2, first_played=FIRST, last_played=LAST)
    value = codec.build_account_history_projection(effective_evidence_bytes=effective, display_bytes=labels, source_revision=3)
    raw = codec.encode_account_history_projection(value)
    assert codec.decode_account_history_projection(raw) == value
    assert codec.check_account_history_projection(raw, effective_evidence_bytes=effective,
        display_bytes=labels, source_revision=3) == value
    for changes in (dict(source_revision=4), dict(effective_evidence_bytes=effective + b' '),
        dict(display_bytes=labels + b' '), dict(display_bytes=materialize(title='Other')[1])):
        args = dict(effective_evidence_bytes=effective, display_bytes=labels, source_revision=3)
        args.update(changes)
        with pytest.raises(codec.AccountHistoryProjectionError):
            codec.check_account_history_projection(raw, **args)


@pytest.mark.parametrize('malformed', [b'', b'{}', b'[]', b'[' * 5 + b']' * 5,
    b'[' + b'[],' * 13 + b'[]]', b'[' + b'0,' * 71 + b'0]', b'null', b'NaN', b'Infinity',
    b'1.0', b'7', b'\xff', b'"unterminated', b']', b' ' * 8193])
def test_strict_codec_rejects_shape_depth_width_objects_numbers_and_bounds(malformed):
    with pytest.raises(codec.AccountHistoryProjectionError):
        codec.decode_account_history_projection(malformed)


@pytest.mark.parametrize('decimal', ['01', '+1', '-0', ' 1', '1 ', '1.0', '1e0', '١',
    '9223372036854775808', '-9223372036854775809', '', None, True, 1])
def test_decimal_revision_is_canonical_string_and_in_range(decimal):
    tree = json.loads(codec.encode_account_history_projection(projection(play_count=2)))
    tree[1] = decimal
    with pytest.raises(codec.AccountHistoryProjectionError):
        codec.decode_account_history_projection(encode_json(tree))


@pytest.mark.parametrize('mutation', [
    lambda v: replace(v, source_revision=True),
    lambda v: replace(v, version='foobar_account_history_projection_v0'),
    lambda v: replace(v, effective_evidence_sha256='A' * 64),
    lambda v: replace(v, artist=replace(v.artist, truncated=1)),
    lambda v: replace(v, standard=replace(v.standard, total=True)),
    lambda v: replace(v, standard=replace(v.standard, first_marker_weight=True)),
    lambda v: replace(v, standard=replace(v.standard, aggregate_remainder=2)),
    lambda v: replace(v, standard=replace(v.standard, first_sort_key=0)),
    lambda v: replace(v, standard=replace(v.standard, first=replace(v.standard.first, unix_microseconds=0))),
    lambda v: replace(v, standard=replace(v.standard, first=replace(v.standard.first, fraction_digits=True))),
    lambda v: replace(v, standard=replace(v.standard, first=replace(v.standard.first, source_sha256='0' * 64))),
])
def test_encoder_recomputes_contract_not_caller_status_or_sort_flags(mutation):
    value = projection(play_count=2, first_played=FIRST, last_played=LAST)
    with pytest.raises(codec.AccountHistoryProjectionError):
        codec.encode_account_history_projection(mutation(value))


def test_noncanonical_whitespace_and_json_unicode_escapes_are_rejected():
    raw = codec.encode_account_history_projection(projection(title='é', play_count=2))
    for altered in (b' ' + raw, raw + b'\n', raw.replace('é'.encode(), b'\\u00e9')):
        with pytest.raises(codec.AccountHistoryProjectionError):
            codec.decode_account_history_projection(altered)


@pytest.mark.parametrize('bad', [0, -1, True, '1', None, 9223372036854775808])
def test_revision_rejects_non_exact_positive_integer(bad):
    effective, labels = materialize(play_count=1)
    with pytest.raises(codec.AccountHistoryProjectionError):
        codec.build_account_history_projection(effective_evidence_bytes=effective, display_bytes=labels, source_revision=bad)


def test_admission_charges_actual_source_sizes_and_bounded_serial_codec():
    effective, labels = materialize(play_count=2)
    expected = evidence.decode_phase_bytes(len(effective)) + 5 * len(labels) + 2 * parser.MAX_CELL_UTF8_BYTES + 8 * 8192
    assert codec.projection_phase_bytes(len(effective), len(labels)) == expected
    assert codec.projection_decode_phase_bytes(1) == codec.projection_decode_phase_bytes(8192) == 65536
    for value in (True, 0, -1, 8193):
        with pytest.raises(codec.AccountHistoryProjectionError):
            codec.projection_decode_phase_bytes(value)
    for sizes in ((0, 1), (1, 0), (True, 1), (evidence.MAX_EVIDENCE_BYTES + 1, 1), (1, display.MAX_BYTES + 1)):
        with pytest.raises(codec.AccountHistoryProjectionError):
            codec.projection_phase_bytes(*sizes)


def test_truncated_equal_labels_do_not_hide_distinct_full_single_count_boundaries():
    prefix = '😀' * 32
    conflict = projection(play_count=1, first_played=prefix + 'first', last_played=prefix + 'last').standard
    assert conflict.first.label == conflict.last.label == prefix
    assert conflict.first.truncated and conflict.last.truncated
    assert conflict.first.source_sha256 != conflict.last.source_sha256
    assert (conflict.status, conflict.reason) == ('needs_reconciliation', 'single_count_boundary_conflict')
    assert conflict.first_marker_weight == 0 and conflict.aggregate_remainder is None
    compatible = projection(play_count=1, first_played=prefix + 'same', last_played=prefix + 'same').standard
    assert compatible.status == 'ready' and compatible.first_marker_weight == 1 and compatible.aggregate_remainder == 0
