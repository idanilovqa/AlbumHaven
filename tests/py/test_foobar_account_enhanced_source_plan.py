"""Authored only. NOT executed or imported during packet construction.

These exercise pure helpers with genuine codecs. Transaction-owner integration
cases are specified separately; no fake callback claims live SQL authority.
"""
from dataclasses import replace
from hashlib import sha256
from struct import pack

import pytest

from music_app.services import foobar_enhanced_source_evidence as evidence
from music_app.services import foobar_account_enhanced_source_plan as planner
from music_app.services.foobar_account_source_postgres import SourceUnavailable, SourceWrite


UPLOAD = 'a' * 64
OTHER_UPLOAD = 'b' * 64
REF = '00000000-0000-4000-8000-000000000001'


def incoming(*, local=(1, 2), cached=(3,), key=17, ordinal=0,
             aliases=('C:\\Music\\track.flac',), upload=UPLOAD):
    raw = pack('<IIIi', 1, len(local), len(cached), 0)
    for tick in local + cached:
        raw += pack('<Q', tick)
    return evidence.EnhancedIncomingEvidence(key, 'parsed', None, raw, len(raw),
        aliases, upload, ordinal)


def make_plan(value, *, ref=REF, retained=()):
    raw = evidence.encode_enhanced_incoming(value)
    identity = evidence.encode_enhanced_identity(value.store_key)
    merged = evidence.merge_enhanced_evidence(raw)
    display = evidence.encode_enhanced_display(evidence.build_enhanced_display(value))
    write = SourceWrite(ref, identity, None, None, None, merged.effective_bytes, display, raw)
    count = planner.enhanced_plan_retained_bytes(retained) + 2 * (
        1024 + len(identity) + len(raw) + len(merged.effective_bytes) + len(display))
    return planner.EnhancedPlannedSource(value.record_ordinal, value.record_ordinal+1,
        write, True, False, None, 0, 0, 0, 0, 0, 0, 1, count)


def test_same_observation_ignores_only_artifact_and_raw_position():
    first = incoming()
    second = replace(first, upload_sha256=OTHER_UPLOAD, record_ordinal=99999)
    assert evidence.encode_enhanced_incoming(first) != evidence.encode_enhanced_incoming(second)
    assert planner._same_incoming(first, second)


@pytest.mark.parametrize('changed', [
    {'store_key': 18},
    {'data_state': 'null'},
    {'raw_reason': 'different_reason'},
    {'raw_size': 999},
    {'raw_blob': b'different raw'},
    {'aliases': ('C:\\Music\\other.flac',)},
])
def test_every_material_typed_member_changes_semantics(changed):
    first = incoming()
    assert not planner._same_incoming(first, replace(first, **changed))


def test_alias_order_is_material_and_never_merges_identity():
    first = incoming(aliases=('a.flac', 'b.flac'))
    second = replace(first, aliases=('b.flac', 'a.flac'))
    assert not planner._same_incoming(first, second)
    assert evidence.encode_enhanced_identity(first.store_key) == evidence.encode_enhanced_identity(second.store_key)
    different_key = replace(first, store_key=18)
    assert evidence.encode_enhanced_identity(first.store_key) != evidence.encode_enhanced_identity(different_key.store_key)


def test_cached_lane_only_change_is_material_raw_evidence():
    first = incoming(local=(1,), cached=(2,))
    second = incoming(local=(1,), cached=(9,))
    assert not planner._same_incoming(first, second)
    a = evidence.decode_enhanced_effective(evidence.merge_enhanced_evidence(
        evidence.encode_enhanced_incoming(first)).effective_bytes)
    b = evidence.decode_enhanced_effective(evidence.merge_enhanced_evidence(
        evidence.encode_enhanced_incoming(second)).effective_bytes)
    assert evidence.enhanced_local_vector_digest(a) == evidence.enhanced_local_vector_digest(b)


def test_invalid_incoming_preserves_exact_prior_available_vector():
    old = evidence.merge_enhanced_evidence(evidence.encode_enhanced_incoming(incoming()))
    absent = evidence.EnhancedIncomingEvidence(17, 'null', 'null_value', None, None,
        (), OTHER_UPLOAD, 0)
    result = evidence.merge_enhanced_evidence(evidence.encode_enhanced_incoming(absent), old.effective_bytes)
    assert result.effective_bytes == old.effective_bytes
    assert result.changed_effective is False
    assert result.usable is True


def test_valid_empty_vector_is_a_correction_not_missing():
    old = evidence.merge_enhanced_evidence(evidence.encode_enhanced_incoming(incoming()))
    result = evidence.merge_enhanced_evidence(
        evidence.encode_enhanced_incoming(incoming(local=(), cached=())), old.effective_bytes)
    value = evidence.decode_enhanced_effective(result.effective_bytes)
    assert value.state == 'available'
    assert value.local_filetime_ticks == value.cached_lastfm_filetime_ticks == ()
    assert result.changed_effective is True


def test_actual_utf8_alias_bytes_feed_encoding_quote():
    value = incoming(aliases=('雪🎶.flac',))
    hold, quote = planner._incoming_sizes(value)
    alias_bytes = len(value.aliases[0].encode('utf-8'))
    assert quote == evidence.incoming_encode_phase_bytes(
        retained_raw_length=len(value.raw_blob), alias_count=1, alias_utf8_bytes=alias_bytes)
    assert hold == 2 * (1024 + len(value.raw_blob) + 4 * alias_bytes + 80)


def test_empty_alias_encoding_and_separate_input_holders():
    value = incoming(aliases=())
    hold, quote = planner._incoming_sizes(value)
    assert hold == 2 * (1024 + len(value.raw_blob))
    assert quote == evidence.incoming_encode_phase_bytes(
        retained_raw_length=len(value.raw_blob), alias_count=0, alias_utf8_bytes=0)


@pytest.mark.parametrize('changed', [
    {'store_key': True}, {'record_ordinal': True}, {'record_ordinal': -1},
    {'record_ordinal': 100000}, {'upload_sha256': 'A' * 64},
    {'aliases': ['a.flac']}, {'raw_blob': bytearray(b'bad')},
    {'aliases': ('a\x00b',)}, {'aliases': ('',)},
])
def test_scalar_preflight_rejects_wrong_native_types(changed):
    with pytest.raises(SourceUnavailable):
        planner._incoming_sizes(replace(incoming(), **changed))


def test_retained_quote_recomputes_actual_four_payload_lengths():
    one = make_plan(incoming())
    exact = 2 * (1024 + 1024 + sum(len(p) for p in (
        one.source_write.identity_bytes, one.source_write.incoming_evidence_bytes,
        one.source_write.evidence_bytes, one.source_write.display_bytes)))
    assert planner.enhanced_plan_retained_bytes((one,)) == exact == one.retained_phase_bytes
    # A returned scalar is informative, never authority for a future allocation.
    assert planner.enhanced_plan_retained_bytes((replace(one, retained_phase_bytes=0),)) == exact


def test_retained_ordinal_is_raw_plus_one_and_contiguous():
    one = make_plan(incoming(ordinal=99))
    assert one.raw_ordinal == 99 and one.ordinal == 100
    with pytest.raises(SourceUnavailable):
        planner.enhanced_plan_retained_bytes((replace(one, ordinal=99),))
    two = make_plan(incoming(ordinal=101), ref='00000000-0000-4000-8000-000000000002')
    with pytest.raises(SourceUnavailable):
        planner.enhanced_plan_retained_bytes((one, two))


def test_private_phase_exact_boundary_and_native_integer_only():
    ledger = planner._PhaseLedger()
    ledger.admit(planner.MAX_PRIVATE_BYTES)
    assert ledger.peak == planner.MAX_PRIVATE_BYTES
    with pytest.raises(planner._PrivatePrefixFull):
        ledger.admit(planner.MAX_PRIVATE_BYTES + 1)
    with pytest.raises(SourceUnavailable):
        planner._PhaseLedger().admit(True)


def test_source_prior_query_adds_only_raw_identity_projection():
    assert planner._PRIOR_PROJECTION in planner.prior_merge._PRIOR_SQL
    assert planner._PRIOR_SQL.replace(
        'select o.identity_bytes,r.evidence_bytes,r.display_bytes,r.incoming_evidence_bytes',
        planner._PRIOR_PROJECTION, 1) == planner.prior_merge._PRIOR_SQL
    assert 'o.current_revision=(j->>4)::bigint' in planner._PRIOR_SQL
    assert 'o.identity_bytes=decode(j->>13' in planner._PRIOR_SQL
