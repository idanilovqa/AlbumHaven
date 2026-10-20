"""Earlier review-admission coverage, additive to the frozen saved-scope suite."""
from music_app.services import album_top_publication_evidence as evidence
from tests.py.test_owned_album_tops_postgres import db, urls, assert_error
from tests.py.test_album_top_artist_scope_postgres import seed_scope, create, refs
from tests.py.test_top_artwork_publication_retention_postgres import publication_case, durable_snapshot
from tests.py.test_top_artwork_publication_postgres import c2_case, CONTEXT
from tests.py.test_top_artwork_draft_preparation_postgres import command as draft_command


def proposed(case, index):
    case.build(3, excluded=(0, 1, 2))
    case.db.scope_artists = seed_scope(case.db)
    case.top, _ = create(case.db, refs=[])
    case.items = [{**case.items[index], 'item_ref': None}]
    case.payload = {**case.payload, 'revision': case.top['revision'], 'items': case.items}
    return case


def test_metadata_publication_preview_rejects_outside_member_before_capture(c2_case, monkeypatch):
    case = proposed(c2_case, 2)
    payload = {'revision': case.top['revision'], 'items': [
        {key: value for key, value in row.items() if key != 'include_artwork'} for row in case.items]}
    before = durable_snapshot(case)
    def forbidden(*args, **kwargs):
        raise AssertionError('Out-of-scope metadata must not enter publication evidence')
    monkeypatch.setattr(evidence, 'capture', forbidden)
    assert_error(lambda: case.db.service.publication_preview(case.db.context(),
        top_ref=case.top['top_ref'], payload=payload), 'album_outside_artist_scope', 409)
    assert durable_snapshot(case) == before and refs(case.db, case.top) == []


def test_metadata_publication_preview_accepts_in_scope_source_without_saving_it(c2_case):
    case = proposed(c2_case, 0)
    payload = {'revision': case.top['revision'], 'items': [
        {key: value for key, value in row.items() if key != 'include_artwork'} for row in case.items]}
    before = case.db.snapshot()
    result = case.db.service.publication_preview(case.db.context(), top_ref=case.top['top_ref'], payload=payload)
    assert result['top_ref'] == case.top['top_ref'] and result['revision'] == case.top['revision']
    assert [row['album_ref'] for row in result['items']] == [case.catalog_refs[0]]
    assert len(result['evidence_revision']) == 64
    assert case.db.snapshot() == before and refs(case.db, case.top) == []


def test_artwork_start_draft_rejects_outside_member_before_source_observation_or_insert(c2_case, monkeypatch):
    case = proposed(c2_case, 2)
    payload = draft_command(case, new=(0,))
    before = durable_snapshot(case)
    def forbidden(*args, **kwargs):
        raise AssertionError('Out-of-scope artwork candidate must not reach source observation')
    monkeypatch.setattr(evidence, 'selection_source', forbidden)
    assert_error(lambda: case.service.start_draft(case.db.context(), top_ref=case.top['top_ref'],
        payload=payload, context_ref=CONTEXT), 'album_outside_artist_scope', 409)
    assert durable_snapshot(case) == before and refs(case.db, case.top) == []


def test_artwork_start_draft_accepts_in_scope_source_without_creating_saved_member(c2_case):
    case = proposed(c2_case, 0)
    payload = draft_command(case, new=(0,))
    before = case.db.snapshot()
    result = case.service.start_draft(case.db.context(), top_ref=case.top['top_ref'], payload=payload, context_ref=CONTEXT)
    assert result['preparation_kind'] == 'draft' and result['item_count'] == 1
    assert result['included_count'] == 0 and result['saved_top_revision'] == case.top['revision']
    assert case.db.snapshot() == before and refs(case.db, case.top) == []
