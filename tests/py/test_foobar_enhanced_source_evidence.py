"""Synthetic source contracts; never opens SQLite or a user artifact."""
from dataclasses import replace
from hashlib import sha256
import json
import struct

import pytest
from music_app.services import foobar_enhanced_source_evidence as codec


def payload(local=(), cached=()):
    return struct.pack('<IIIi', 1, len(local), len(cached), 0) + b''.join(
        struct.pack('<Q', n) for n in (*local, *cached))


def incoming(key=-7, local=(9, 9, 2), cached=(9, 3), aliases=('C:\\Music\\song.flac',)):
    raw = payload(local, cached)
    return codec.EnhancedIncomingEvidence(key, 'parsed', None, raw, len(raw), aliases, 'a'*64, 0)


def wire(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()


@pytest.mark.parametrize('key', [-(1 << 63), -1, 0, (1 << 63)-1])
def test_signed_store_identity_is_exact_and_not_alias_identity(key):
    encoded = codec.encode_enhanced_identity(key)
    assert json.loads(encoded) == ['store_key', codec.ENHANCED_PLAYCOUNT_STORE_GUID, str(key)]
    assert codec.decode_enhanced_identity(encoded) == key
    assert codec.decode_enhanced_incoming(codec.encode_enhanced_incoming(incoming(key))).store_key == key


@pytest.mark.parametrize('key', [True, False, 1.0, '1', -(1 << 63)-1, 1 << 63])
def test_identity_rejects_bool_coercion_and_out_of_range(key):
    with pytest.raises(codec.EnhancedEvidenceInvalid):
        codec.encode_enhanced_identity(key)


def test_raw_provenance_and_ordered_lanes_are_not_combined_or_deduplicated():
    value = incoming()
    encoded = codec.encode_enhanced_incoming(value)
    root = json.loads(encoded)
    assert root[4:7] == [str(len(value.raw_blob)), sha256(value.raw_blob).hexdigest(), value.raw_blob.hex()]
    assert codec.decode_enhanced_incoming(encoded) == value
    merged = codec.merge_enhanced_evidence(encoded)
    effective = codec.decode_enhanced_effective(merged.effective_bytes)
    assert effective.local_filetime_ticks == (9, 9, 2)
    assert effective.cached_lastfm_filetime_ticks == (9, 3)
    assert effective.local_provenance == 'incomplete_possibly_seeded'
    assert merged.incoming_sha256 == sha256(encoded).hexdigest()
    assert merged.effective_sha256 == sha256(merged.effective_bytes).hexdigest()
    assert merged.usable and merged.changed_effective
    assert not codec.merge_enhanced_evidence(encoded, merged.effective_bytes).changed_effective


@pytest.mark.parametrize('index,value', [(2,'null'), (3,'invented'), (4,'999'), (5,'0'*64), (6,'00'), (8,'A'*64), (9,'00')])
def test_raw_wire_cannot_lie_about_state_reason_size_hash_or_ordinal(index, value):
    root = json.loads(codec.encode_enhanced_incoming(incoming()))
    root[index] = value
    with pytest.raises(codec.EnhancedEvidenceInvalid):
        codec.decode_enhanced_incoming(wire(root))


@pytest.mark.parametrize('change', [lambda b: b' '+b, lambda b: b+b'\n', lambda b: b.replace(b',', b', ', 1),
    lambda b: b.replace(b'"-7"', b'-7', 1), lambda b: b.replace(b'"-7"', b'true', 1)])
def test_noncanonical_or_numeric_json_is_rejected(change):
    with pytest.raises(codec.EnhancedEvidenceInvalid):
        codec.decode_enhanced_incoming(change(codec.encode_enhanced_incoming(incoming())))


@pytest.mark.parametrize('encoded', [b'{}', b'[[[[]]]]', b'[true]', b'[NaN]', b'[Infinity]', b'"\xff"', b'['*1000+b']'*1000])
def test_json_shape_depth_and_encoding_fail_closed(encoded):
    with pytest.raises(codec.EnhancedEvidenceInvalid):
        codec.decode_enhanced_incoming(encoded)


def test_empty_parsed_is_available_and_distinct_from_missing():
    empty = codec.merge_enhanced_evidence(codec.encode_enhanced_incoming(incoming(local=(), cached=())))
    missing = replace(incoming(), data_state='unavailable', raw_reason='missing_data', raw_blob=None, raw_size=None)
    unavailable = codec.merge_enhanced_evidence(codec.encode_enhanced_incoming(missing))
    assert empty.usable and not unavailable.usable
    assert codec.decode_enhanced_effective(empty.effective_bytes).local_filetime_ticks == ()
    assert codec.decode_enhanced_effective(unavailable.effective_bytes).local_filetime_ticks is None
    assert empty.effective_bytes != unavailable.effective_bytes
    retained = codec.merge_enhanced_evidence(codec.encode_enhanced_incoming(missing), empty.effective_bytes)
    assert retained.effective_bytes == empty.effective_bytes and not retained.changed_effective


@pytest.mark.parametrize('state,reason,size', [('null','null_value',None), ('unavailable','missing_data',None),
    ('malformed','invalid_value_type',None), ('oversized','record_too_large',262145)])
def test_absent_raw_diagnostics_roundtrip_without_invented_vectors(state, reason, size):
    value = replace(incoming(), data_state=state, raw_reason=reason, raw_blob=None, raw_size=size)
    encoded = codec.encode_enhanced_incoming(value)
    assert codec.decode_enhanced_incoming(encoded) == value
    assert not codec.merge_enhanced_evidence(encoded).usable
    with pytest.raises(codec.EnhancedEvidenceInvalid):
        codec.encode_enhanced_incoming(replace(value, raw_reason='wrong'))


def test_effective_limits_and_local_digest_isolation():
    value = codec.EnhancedEffectiveEvidence(-7, 'available', (0, (1 << 64)-1, 0), (4,), codec.LOCAL_PROVENANCE)
    assert codec.decode_enhanced_effective(codec.encode_enhanced_effective(value)) == value
    assert codec.enhanced_local_vector_digest(value) == codec.enhanced_local_vector_digest(replace(value, cached_lastfm_filetime_ticks=(7,7)))
    assert codec.enhanced_local_vector_digest(value) != codec.enhanced_local_vector_digest(replace(value, local_filetime_ticks=(0,0,(1 << 64)-1)))
    for bad in [(True,), (-1,), (1 << 64,), (0,)*(codec.MAX_TIMESTAMPS+1)]:
        with pytest.raises(codec.EnhancedEvidenceInvalid):
            codec.encode_enhanced_effective(replace(value, local_filetime_ticks=bad))
    with pytest.raises(codec.EnhancedEvidenceInvalid):
        codec.merge_enhanced_evidence(codec.encode_enhanced_incoming(incoming(8)), codec.encode_enhanced_effective(value))


@pytest.mark.parametrize('aliases', [('same','same'), ('',), ('x\x00y',), ('\ud800',), ('x'*49153,)])
def test_alias_validation(aliases):
    with pytest.raises(codec.EnhancedEvidenceInvalid):
        codec.encode_enhanced_incoming(replace(incoming(), aliases=aliases))


def test_display_uses_safe_filename_only_with_explicit_fallback_and_bound():
    value = incoming(aliases=('https://host/private?q=secret', 'C:\\private\\music\\so\x00ng.flac'))
    # NUL is not valid incoming evidence; category-C sanitization uses a valid non-NUL control.
    value = replace(value, aliases=('https://host/private?q=secret', 'C:\\private\\music\\so\tng.flac'))
    display = codec.build_enhanced_display(value)
    assert display.label == 'song.flac' and display.label_kind == 'source_filename'
    encoded = codec.encode_enhanced_display(display)
    assert codec.decode_enhanced_display(encoded) == display
    codec.check_enhanced_display(encoded, value)
    assert json.loads(encoded)[5:] == [None, None, None]
    assert b'private' not in encoded and b'https' not in encoded
    fallback = codec.build_enhanced_display(incoming(aliases=('https://host/a',)))
    assert fallback.label == 'Foobar record -7' and fallback.label_kind == 'source_record'
    long = codec.build_enhanced_display(incoming(aliases=('界'*100,)))
    assert long.truncated and len(long.label.encode()) <= 256
    with pytest.raises(codec.EnhancedEvidenceInvalid):
        codec.check_enhanced_display(encoded, incoming(aliases=('other.flac',)))


def test_phase_quotes_are_explicit_and_size_sensitive_not_whole_dataset_reservations():
    assert codec.codec_phase_bytes(1) == 65600
    assert codec.codec_phase_bytes(100, 200) == 84736
    assert codec.incoming_encode_phase_bytes(retained_raw_length=16, alias_count=0, alias_utf8_bytes=0) == 133120
    assert codec.effective_encode_phase_bytes(0, 0) == 98304
    with pytest.raises(codec.EnhancedEvidenceInvalid):
        codec.incoming_encode_phase_bytes(retained_raw_length=0, alias_count=1, alias_utf8_bytes=0)
    with pytest.raises(codec.EnhancedEvidenceInvalid):
        codec.decode_enhanced_incoming(b' '* (codec.MAX_EVIDENCE_BYTES+1))


def test_maximum_record_vector_roundtrips_without_count_semantic_invention():
    value = incoming(local=(5,)*codec.MAX_TIMESTAMPS, cached=())
    assert len(value.raw_blob) == codec.MAX_RECORD_BYTES
    merged = codec.merge_enhanced_evidence(codec.encode_enhanced_incoming(value))
    effective = codec.decode_enhanced_effective(merged.effective_bytes)
    assert effective.local_filetime_ticks == (5,)*32766
    assert effective.cached_lastfm_filetime_ticks == ()
    assert len(json.loads(merged.effective_bytes)) == 6  # No lifetime-play-count member.


def test_retained_malformed_and_unsupported_raw_preserve_previous_effective():
    from music_app.services import foobar_enhanced_record_decoder as decoder
    previous = codec.merge_enhanced_evidence(codec.encode_enhanced_incoming(incoming())).effective_bytes
    for raw in (b'\x01', struct.pack('<IIIi', 99, 0, 0, 0)):
        decoded = decoder.decode_enhanced_playcount_record(raw, store_guid=codec.ENHANCED_PLAYCOUNT_STORE_GUID)
        diagnostic = decoded.diagnostics[0]
        value = replace(incoming(), data_state=diagnostic.category, raw_reason=diagnostic.code,
            raw_blob=raw, raw_size=len(raw))
        encoded = codec.encode_enhanced_incoming(value)
        assert codec.decode_enhanced_incoming(encoded).raw_blob == raw
        merged = codec.merge_enhanced_evidence(encoded, previous)
        assert merged.effective_bytes == previous and not merged.changed_effective
