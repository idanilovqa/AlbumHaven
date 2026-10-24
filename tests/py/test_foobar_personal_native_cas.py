"""AUTHORED ONLY: genuine same-connection CAS on independent SQL-result rows."""
from copy import deepcopy
from dataclasses import replace

import pytest

from tests.py.foobar_account_personal_testing import (
    install, seed, native_review, native_apply, personal_snapshot, p, SOURCE,
    FOREIGN_SOURCE, OBSERVATION,
)


def choice(fence, field='rating', value=4):
    return p.taste.FoobarPersonalChoice(fence.state, fence.fence_sha256, field, value)


def test_real_native_two_field_change_is_one_update_and_preserves_full_metadata(monkeypatch):
    db = install(monkeypatch)
    metadata = dict(rating_explicit=True, love_tier_explicit=True,
        foobar_import_v1={'rating': [SOURCE, OBSERVATION, 1, 2]},
        unrelated={'nested': ['keep', 0, False]}, legacy='preserve')
    seed(db, metadata=metadata)
    fence, = native_review(db)
    before = deepcopy(db.full_row(21))
    result = native_apply(db, (choice(fence, 'favorite', 'loved'), choice(fence)))
    assert type(result) is p.taste.FoobarPersonalWriteResult
    assert [(x.track_id, x.field, x.proposed) for x in result.outcomes] == [
        (21, 'favorite', 'loved'), (21, 'rating', 4)]
    assert len(db.personal_frames) == 1 and db.personal_frames[0][6:] == [True, 4, True]
    after = db.full_row(21)
    expected_metadata = dict(metadata, foobar_import_v1={})
    assert after['metadata'] == expected_metadata
    assert after['rating'] == 4 and after['love_tier'] == 'loved'
    assert after['updated_at'] != before['updated_at']
    assert {k: v for k, v in after.items() if k not in ('rating', 'love_tier', 'metadata', 'updated_at')} == {
        k: v for k, v in before.items() if k not in ('rating', 'love_tier', 'metadata', 'updated_at')}
    assert result.postimages[0].rating_protected and result.postimages[0].favorite_protected
    assert result.postimages[0].rating_marker is result.postimages[0].favorite_marker is None
    assert db.personal_savepoints[-1] == 'release'
    assert not db.source_rows and not db.receipts and not db.job_rows


def test_rating_only_preserves_unselected_favorite_marker_and_tier(monkeypatch):
    db = install(monkeypatch)
    marker = [FOREIGN_SOURCE, OBSERVATION, 9, 'loved']
    seed(db, love='loved', metadata=dict(rating_explicit=True,
        foobar_import_v1={'favorite': marker}, unrelated={'keep': 1}))
    fence, = native_review(db)
    native_apply(db, (choice(fence),))
    assert db.full_row(21)['metadata'] == dict(rating_explicit=True,
        foobar_import_v1={'favorite': marker}, unrelated={'keep': 1})
    assert db.tastes[21]['love_tier'] == 'loved'


@pytest.mark.parametrize('change', ['metadata', 'timestamp', 'custom_column', 'identity', 'rating', 'selection'])
def test_real_native_current_fence_rejects_every_selected_preimage_drift(monkeypatch, change):
    db = install(monkeypatch)
    seed(db)
    fence, = native_review(db)
    if change == 'metadata':
        db.native_rows[21]['metadata']['unrelated'] = 'changed'
    elif change == 'timestamp':
        db.native_rows[21]['updated_at'] = 'synthetic-timestamp-external'
    elif change == 'custom_column':
        db.native_rows[21]['custom_column'] = 'changed'
    elif change == 'identity':
        db.tastes[21]['identity_seal'] = 'd' * 64
    elif change == 'rating':
        db.tastes[21]['rating'] = 3
    else:
        db.tastes[21]['selection_status'] = 'conflict'
    before = personal_snapshot(db)
    with pytest.raises(p.taste.FoobarTasteStale):
        native_apply(db, (choice(fence),))
    assert personal_snapshot(db) == before
    assert not db.personal_frames


def test_full_current_state_restoration_is_not_claimed_to_be_universal_aba_proof(monkeypatch):
    db = install(monkeypatch)
    seed(db)
    fence, = native_review(db)
    before = deepcopy(db.native_rows[21])
    db.native_rows[21]['metadata']['temporary'] = True
    db.native_rows[21] = before
    # The protocol compares current semantic/full-row state, not a persistent
    # nonce or monotonic version that remembers an equivalent restored state.
    result = native_apply(db, (choice(fence),))
    assert result.postimages[0].rating == 4 and len(db.personal_frames) == 1


@pytest.mark.parametrize('metadata', [None, [], 'bad', {'rating_explicit': 1},
    {'love_tier_explicit': 'true'}, {'foobar_import_v1': 7},
    {'foobar_import_v1': {'unknown': []}}, {'foobar_import_v1': {'rating': []}},
    {'foobar_import_v1': {'rating': [SOURCE, OBSERVATION, True, 2]}},
    {'foobar_import_v1': {'rating': [SOURCE, OBSERVATION, 0, 2]}},
    {'foobar_import_v1': {'rating': [SOURCE, OBSERVATION, 9223372036854775808, 2]}},
    {'foobar_import_v1': {'rating': [SOURCE, OBSERVATION, 1, 3]}},
    {'foobar_import_v1': {'rating': ['BAD-UUID', OBSERVATION, 1, 2]}}])
def test_malformed_provenance_is_readable_but_never_editable(monkeypatch, metadata):
    db = install(monkeypatch)
    seed(db)
    db.native_rows[21]['metadata'] = deepcopy(metadata)
    db.project_native(21)
    fence, = native_review(db)
    assert not fence.eligible_rating and not fence.eligible_favorite
    before = personal_snapshot(db)
    with pytest.raises(p.taste.FoobarTasteStale):
        native_apply(db, (choice(fence),))
    assert personal_snapshot(db) == before and not db.personal_frames


def test_well_formed_foreign_source_provenance_is_not_misclassified_as_malformed(monkeypatch):
    db = install(monkeypatch)
    seed(db, metadata=dict(foobar_import_v1={'rating': [FOREIGN_SOURCE, OBSERVATION, 4, 2]},
        unrelated={'preserve': True}))
    fence, = native_review(db)
    assert fence.eligible_rating and fence.state.rating_marker is None
    result = native_apply(db, (choice(fence),))
    assert result.postimages[0].rating == 4
    assert db.full_row(21)['metadata'] == dict(foobar_import_v1={},
        unrelated={'preserve': True}, rating_explicit=True)


@pytest.mark.parametrize('field,value', [('rating', None), ('rating', 0), ('rating', False),
    ('rating', 6), ('rating', '4'), ('favorite', 'off'), ('favorite', 'obsessed'),
    ('favorite', True), ('favorite', False), ('other', 4)])
def test_no_rating_clears_favorite_demotions_or_generic_override(monkeypatch, field, value):
    db = install(monkeypatch)
    seed(db)
    fence, = native_review(db)
    before = personal_snapshot(db)
    with pytest.raises(p.taste.FoobarTasteUnavailable):
        native_apply(db, (choice(fence, field, value),))
    assert personal_snapshot(db) == before and not db.personal_frames


@pytest.mark.parametrize('love', ['loved', 'obsessed'])
def test_existing_favorite_never_becomes_an_override_target(monkeypatch, love):
    db = install(monkeypatch)
    seed(db, love=love)
    fence, = native_review(db)
    assert not fence.eligible_favorite
    before = personal_snapshot(db)
    with pytest.raises(p.taste.FoobarTasteStale):
        native_apply(db, (choice(fence, 'favorite', 'loved'),))
    assert personal_snapshot(db) == before


@pytest.mark.parametrize('failure', ['second_update_cas', 'postimage_metadata', 'preserved_false', 'bad_return'])
def test_partial_selected_fields_roll_back_the_entire_native_savepoint(monkeypatch, failure):
    db = install(monkeypatch)
    seed(db, 21)
    seed(db, 22)
    one, two = native_review(db, (21, 22))
    before = personal_snapshot(db)
    if failure == 'second_update_cas':
        def drift(database, frame):
            if frame[3] == 22:
                database.native_rows[22]['metadata']['raced'] = True
        db.before_personal_write = drift
    elif failure == 'postimage_metadata':
        db.after_personal_write = lambda database, frame: database.native_rows[frame[3]]['metadata'].update(raced=True)
    elif failure == 'preserved_false':
        db.corrupt_personal_return = lambda row: row.update(preserved=False)
    else:
        db.corrupt_personal_return = lambda row: row.update(fence_sha256='not-a-sha')
    with pytest.raises((p.taste.FoobarTasteStale, p.taste.FoobarTasteUnavailable)):
        native_apply(db, (choice(two), choice(one)))
    assert personal_snapshot(db) == before
    assert db.personal_frames[0][3] == 21  # stable lock order, not choice order
    assert db.personal_savepoints[-1] == 'rollback'
    assert not db.receipts and not db.job_rows


def test_duplicate_fields_or_disagreeing_same_target_preimages_are_rejected_before_write(monkeypatch):
    db = install(monkeypatch)
    seed(db)
    fence, = native_review(db)
    cases = ((choice(fence), choice(fence)),
        (choice(fence), choice(replace(fence, fence_sha256='e' * 64), 'favorite', 'loved')))
    before = personal_snapshot(db)
    for choices in cases:
        with pytest.raises(p.taste.FoobarTasteUnavailable):
            native_apply(db, choices)
    assert personal_snapshot(db) == before and not db.personal_frames


@pytest.mark.parametrize('grant', ['library.browse.read', 'library.track_preferences.manage', 'all'])
def test_current_native_permission_revocation_is_not_replaced_by_import_authority(monkeypatch, grant):
    db = install(monkeypatch)
    seed(db)
    fence, = native_review(db)
    db.grants = () if grant == 'all' else tuple(item for item in db.grants if item != grant)
    before = personal_snapshot(db)
    with pytest.raises((p.taste.FoobarTasteStale, p.taste.FoobarTasteUnavailable, p.SourceStale, p.SourceUnavailable)):
        from music_app.services.policy_evaluator import PolicyEvaluationConstraints
        # Browse intentionally aliases own taste. Exercise a genuine supported
        # taste-only narrowing constraint while that browse grant remains.
        narrow = lambda context: PolicyEvaluationConstraints(
            deployment_allowed=context.action != 'library.track_preferences.manage')
        native_apply(db, (choice(fence),), constraints=narrow if grant == 'library.track_preferences.manage' else None)
    assert personal_snapshot(db) == before and not db.personal_frames


def test_generated_sql_has_full_row_cas_guarded_provenance_and_no_insert_fallback():
    native = p.taste
    read, write = native._foobar_personal_read_sql(), native._foobar_personal_write_sql()
    assert len(read) <= 32768 and len(write) <= 32768 and read.isascii() and write.isascii()
    assert 'to_jsonb(p)' in read and 'to_jsonb(p)' in write
    assert write.count('to_jsonb(current_preference)') >= 3
    assert 'for update of p' in write.lower()
    assert 'insert into' not in write.lower() and 'on conflict' not in write.lower()
    assert "array['rating','love_tier','metadata','updated_at']" in write
    assert 'as preserved' in write and 'fence_sha256' in write
    assert "case when jsonb_typeof(p.metadata->'foobar_import_v1')='object'" in read
    for field in ('rating', 'favorite'):
        marker = native._foobar_personal_marker_sql(field)
        assert 'case when jsonb_typeof' in marker and 'then jsonb_array_length' in marker
        assert 'own.source_ref' not in marker  # foreign is not malformed
        assert '9223372036854775807' in marker
    assert native._foobar_personal_phase_bytes(32) == 2097152
    for invalid in (True, -1, 33, None):
        with pytest.raises(native.FoobarTasteUnavailable):
            native._foobar_personal_phase_bytes(invalid)


def test_current_browse_alias_allows_own_taste_without_redundant_direct_grant(monkeypatch):
    db = install(monkeypatch); seed(db)
    fence, = native_review(db)
    db.grants = ('library.browse.read',)
    result = native_apply(db, (choice(fence),))
    assert len(result.outcomes) == 1 and db.tastes[21]['rating'] == 4
    assert len(db.personal_frames) == 1
