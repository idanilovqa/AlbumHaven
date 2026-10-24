"""Authored only: genuine policy/native/current-projection owners, controlled DB IO."""
from copy import deepcopy
from hashlib import sha256
import json

import pytest
from music_app.services import foobar_account_history_evidence as evidence_reader
from music_app.services import foobar_account_matched_evidence as matched
from tests.py.foobar_account_history_native_testing import *
from tests.py.foobar_enhanced_history_v4_testing import materialize, codec, BASE


def enhanced_row(*, ticks=(BASE,), cached=(), unavailable=False):
    header, _ = materialize(ticks, cached, unavailable=unavailable)
    body = codec.encode_enhanced_history_header(header)
    return dict(source_revision=1, projection_bytes=body, projection_sha256=sha256(body).hexdigest(),
        effective_evidence_sha256=header.effective_evidence_sha256, display_sha256=header.display_sha256,
        standard_first=None, enhanced_first=None, standard_last=codec.UNKNOWN_TIME,
        enhanced_last=codec.UNKNOWN_TIME, standard_last_present=False, enhanced_last_present=False,
        current_revision=1, current_effective_sha256=header.effective_evidence_sha256,
        current_display_sha256=header.display_sha256, evidence_kind='enhanced_store',
        local_entry_count=header.local_entry_count, local_vector_sha256=header.local_vector_sha256)


def test_genuine_enhanced_native_eligibility_then_play_uses_current_binding(monkeypatch):
    db = install(monkeypatch)
    db.projections[OBS] = enhanced_row()
    hints = invoke(db)
    assert hints[0].can_attempt_play is True and not db.physical
    target = invoke(db, play=True)
    assert target.inventory_track_ref == 'inventory-track:7:21'
    assert target.path == '/native/song.flac' and db.physical
    assert db.calls.count(native._BINDING) == 2


@pytest.mark.parametrize('change', ['kind', 'count', 'vector', 'sentinel', 'hash', 'current', 'binding'])
def test_enhanced_native_stale_or_corrupt_proof_never_resolves_private_target(monkeypatch, change):
    db = install(monkeypatch); db.projections[OBS] = enhanced_row()
    row = db.projections[OBS]
    if change == 'kind': row['evidence_kind'] = 'tsv_snapshot'
    elif change == 'count': row['local_entry_count'] = 2
    elif change == 'vector': row['local_vector_sha256'] = '0'*64
    elif change == 'sentinel': row['standard_last'] = 0
    elif change == 'hash': row['projection_sha256'] = '0'*64
    elif change == 'current': row['current_revision'] = 2
    else: db.binding['head_track_id'] = 22
    with pytest.raises((native.SourceUnavailable, native.SourceStale, native.NativeTargetError)):
        invoke(db, play=True)
    assert not db.physical and native._NATIVE_TRACK_LOCK not in db.calls


def stat_driver(monkeypatch, db, rows, *, expected_tracks=(21,)):
    execute = db.execute
    def call(sql, params=None, **kwargs):
        if sql == matched._CANDIDATES:
            frame = json.loads(params[0])
            assert frame[:2] == [1, 7]
            assert 1 <= len(frame[2]) <= 3
            assert all(track in expected_tracks for track in frame[2])
            db.calls.append(sql)
            selected = rows(frame[2]) if callable(rows) else rows
            cursor = Cursor(db, sql, selected)
            db.cursors.append(cursor)
            return cursor
        return execute(sql, params, **kwargs)
    monkeypatch.setattr(db, 'execute', call)
    monkeypatch.setattr(matched, 'datetime', native.datetime)


def joined(db, projection, ordinal=1):
    return dict(projection, **db.binding, requested_track_id=21, source_ref=SOURCE,
        observation_ref='00000000-0000-4000-8000-%012x' % ordinal)


def stats(db, *, family='standard', constraints=read_constraints, tracks=(21,)):
    with authority.current_library_transaction(URL, context(), constraints=constraints,
            read_only=True, inventory_publication_first=True) as (connection, live, now):
        return matched.read_matched_foobar_evidence_on_connection(connection, live,
            track_ids=tracks, count_family=family, constraints=constraints)


@pytest.mark.parametrize('ticks,cached,unavailable,positive', [
    ((BASE,), (), False, True), ((), (BASE,), False, False),
    ((), (), False, False), ((BASE,), (), True, False),
])
def test_has_plays_uses_only_positive_current_local_vector_not_cached_lifetime(monkeypatch, ticks, cached, unavailable, positive):
    db = install(monkeypatch)
    stat_driver(monkeypatch, db, [joined(db, enhanced_row(ticks=ticks,cached=cached,unavailable=unavailable))])
    result = stats(db)
    assert result.positive_track_ids == ((21,) if positive else ())
    assert result.incomplete_track_ids == ((21,) if unavailable else ())
    assert result.provenance == 'own_account_foobar_reported_evidence'
    assert not db.physical
    assert db.calls.count(matched._CANDIDATES) == 1


@pytest.mark.parametrize('positive', [False, True])
def test_overflow_never_becomes_false_and_positive_is_boolean_union(monkeypatch, positive):
    db = install(monkeypatch)
    rows = [joined(db, enhanced_row(ticks=()), i+1) for i in range(33)]
    if positive: rows[0] = joined(db, enhanced_row(), 1)
    stat_driver(monkeypatch, db, rows)
    result = stats(db)
    assert result.positive_track_ids == ((21,) if positive else ())
    assert result.incomplete_track_ids == (() if positive else (21,))
    assert not db.physical


def test_tsv_count_family_is_explicit_and_never_summed(monkeypatch):
    db = install(monkeypatch)
    row = bound_row(projection(play_count=0, play_count_enhanced=7))
    stat_driver(monkeypatch, db, [joined(db, row)])
    assert stats(db, family='standard').positive_track_ids == ()
    assert stats(db, family='enhanced').positive_track_ids == (21,)
    assert not db.physical


def test_source_specific_duplicates_do_not_multiply_positive_predicate(monkeypatch):
    db = install(monkeypatch)
    stat_driver(monkeypatch, db, [joined(db, enhanced_row(), i+1) for i in range(32)])
    assert stats(db).positive_track_ids == (21,)
    assert db.calls.count(matched._CANDIDATES) == 1


def test_reader_rejects_malformed_current_header_and_per_track_read_denial(monkeypatch):
    db = install(monkeypatch)
    row = enhanced_row(); row['current_effective_sha256'] = '0'*64
    stat_driver(monkeypatch, db, [joined(db, row)])
    with pytest.raises(native.SourceUnavailable): stats(db)
    def denied(target):
        return PolicyEvaluationConstraints(client_surface_allowed=not (
            target.action == BROWSE and target.resource is not None))
    before = db.calls.count(matched._CANDIDATES)
    with pytest.raises(authority.PrivateLibraryAuthorityError): stats(db, constraints=denied)
    assert db.calls.count(matched._CANDIDATES) == before


def test_three_target_batches_keep_all_hundred_targets_and_release_payload_views(monkeypatch):
    db = install(monkeypatch)
    tracks = tuple(range(21, 121))
    batches = []
    def rows(batch):
        batches.append(tuple(batch))
        result = []
        for track in batch:
            row = joined(db, enhanced_row())
            row['requested_track_id'] = track
            for key in ('binding_track_id', 'saved_track_id', 'head_track_id'):
                row[key] = track
            result.append(row)
        return result
    stat_driver(monkeypatch, db, rows, expected_tracks=tracks)
    result = stats(db, tracks=tracks)
    assert result.positive_track_ids == tracks and result.incomplete_track_ids == ()
    assert len(batches) == 34 and tuple(x for batch in batches for x in batch) == tracks
    assert all(len(batch) <= 3 for batch in batches)
    assert matched.CONTROL_BYTES + 3 * 99 * (8192 + 2048) + matched.PROJECTION_PHASE_BYTES == 3368960
    assert matched.MAX_PHASE_BYTES == 4194304
    assert not db.physical


def test_batch_rejects_foreign_target_and_per_target_overflow_before_decoding(monkeypatch):
    db = install(monkeypatch)
    row = joined(db, enhanced_row()); row['requested_track_id'] = 22
    stat_driver(monkeypatch, db, [row])
    with pytest.raises(native.SourceUnavailable): stats(db)


def test_unavailable_evidence_is_unknown_unless_other_source_proves_positive(monkeypatch):
    db = install(monkeypatch)
    rows = [joined(db, enhanced_row(unavailable=True), 1)]
    stat_driver(monkeypatch, db, rows)
    assert stats(db).incomplete_track_ids == (21,)
    rows.append(joined(db, enhanced_row(), 2))
    result = stats(db)
    assert result.positive_track_ids == (21,) and result.incomplete_track_ids == ()


def test_projection_body_is_sql_capped_before_driver_materialization():
    assert 'octet_length(p.projection_bytes) between 1 and 8192' in matched._CANDIDATES
    assert 'cross join lateral' in matched._CANDIDATES
    assert 'limit 33) m)' in matched._CANDIDATES
    assert 'raw_bytes' not in matched._CANDIDATES and 'entry_bytes' not in matched._CANDIDATES


def test_optional_projection_rolls_back_savepoint_then_revalidates_session(monkeypatch):
    db = install(monkeypatch)
    events = []
    from contextlib import contextmanager
    @contextmanager
    def transaction():
        events.append('savepoint')
        try:
            yield
        except Exception:
            events.append('rollback')
            raise
        else:
            events.append('release')
    monkeypatch.setattr(db, 'transaction', transaction, raising=False)
    row = enhanced_row(); row['projection_sha256'] = '0'*64
    stat_driver(monkeypatch, db, [joined(db, row)])
    with authority.current_library_transaction(URL, context(), constraints=read_constraints,
            read_only=True, inventory_publication_first=True) as (connection, live, now):
        result = matched.optional_matched_foobar_evidence_on_connection(connection, live,
            track_ids=(21,), count_family='standard', constraints=read_constraints)
    assert events == ['savepoint', 'rollback']
    assert result.availability == 'unavailable' and result.incomplete_track_ids == (21,)
    assert result.positive_track_ids == () and not db.physical


def test_optional_projection_never_suppresses_track_authority_denial(monkeypatch):
    db = install(monkeypatch)
    monkeypatch.setattr(matched, "datetime", native.datetime)
    from contextlib import contextmanager
    @contextmanager
    def transaction():
        yield
    monkeypatch.setattr(db, 'transaction', transaction, raising=False)
    def denied(target):
        return PolicyEvaluationConstraints(client_surface_allowed=not (
            target.action == BROWSE and target.resource is not None))
    with authority.current_library_transaction(URL, context(), constraints=denied,
            read_only=True, inventory_publication_first=True) as (connection, live, now):
        with pytest.raises(authority.PrivateLibraryAuthorityError):
            matched.optional_matched_foobar_evidence_on_connection(connection, live,
                track_ids=(21,), count_family='standard', constraints=denied)
    assert matched._CANDIDATES not in db.calls


def test_existing_binding_without_current_decision_proof_is_unknown_not_absent(monkeypatch):
    db = install(monkeypatch)
    row = joined(db, enhanced_row()); row['head_track_id'] = 22
    stat_driver(monkeypatch, db, [row])
    result = stats(db)
    assert result.positive_track_ids == () and result.incomplete_track_ids == (21,)
    assert not db.physical
