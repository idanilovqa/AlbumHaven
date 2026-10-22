"""Real SQL finalization, source locks, rollback, Copy and deliberate Unlock."""
from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4
import pytest

from music_app.services.album_top_source_imports import TopSourceImports
from music_app.services.album_top_source_finalization import read_source
from music_app.services.owned_album_tops import AlbumTopError, normalize_top_command
from test_owned_album_tops_postgres import db, urls, assert_error
from tests.py.test_album_top_collaboration_postgres import member, write

CONTEXT = 'a' * 64


def prepare(db, *, content='3. Third\n2. Second\n1. First'):
    return TopSourceImports(db.service).submit(db.context(), dict(request_key=str(uuid4()),
        title='Imported', description='', kind='text', filename=None, content=content))


def command(db, job, matches=None, order=None):
    matches = matches if matches is not None else {'3': db.album_refs[0], '1': db.album_refs[1]}
    rows = [{'row_ref': ref, 'selection': {'kind': 'local_catalog', 'album_ref': matches[ref]}
             if matches.get(ref) else None} for ref in (order or ['3', '2', '1'])]
    return normalize_top_command('create', {'request_key': job['job_ref'], 'title': 'Imported',
        'description': 'Reviewed', 'source_review': {'job_ref': job['job_ref'], 'revision': job['revision'], 'rows': rows}})


def finalize(db, job=None, **kwargs):
    job = job or prepare(db)
    selected = command(db, job, **kwargs)
    return db.service.execute(db.context(), selected, context_ref=CONTEXT), selected, job


def execute(db, action, top, **changes):
    selected = normalize_top_command(action, {'request_key': str(uuid4()), 'revision': top['revision'], **changes},
                                     top_ref=top['top_ref'])
    return db.service.execute(db.context(), selected, context_ref=CONTEXT), selected


def test_finalization_is_atomic_rank_preserving_locked_and_idempotent(db):
    top, selected, job = finalize(db)
    read = db.service.read(db.context(), top_ref=top['top_ref'])
    assert read['source_locked'] and read['source_derived']
    assert [row['original_position'] for row in read['items']] == [1, 3]
    assert [row['curator_position'] for row in read['items']] == [1, 2]
    assert [row['catalog_ref'] for row in read['items']] == db.album_refs[:2]
    assert read['allowed_actions']['can_edit'] and read['allowed_actions']['can_unlock_source']
    assert not any(read['allowed_actions'][name] for name in ('can_add', 'can_remove', 'can_reorder'))
    before = db.snapshot()
    assert db.service.execute(db.context(), selected, context_ref=CONTEXT) == top
    assert db.snapshot() == before
    result = TopSourceImports(db.service).read(db.context(), job['job_ref'])
    assert result['top_ref'] == top['top_ref'] and result['phase'] == 'top_created'
    assert_error(lambda: TopSourceImports(db.service).cancel(db.context(), job['job_ref']),
                 'source_already_finalized', 409)


def test_explicit_duplicate_reports_first_normalized_source_occurrence(db):
    top, _, _ = finalize(db, matches={'3': db.album_refs[0], '2': db.album_refs[0], '1': db.album_refs[1]})
    report = top['source_report']
    assert [row['outcome'] for row in report] == ['matched', 'duplicate', 'matched']
    assert report[1]['retained_row_ref'] == '3'
    assert [row['original_explicit_rank'] for row in report] == [1, 2, 3]
    assert len(db.service.read(db.context(), top_ref=top['top_ref'])['items']) == 2


@pytest.mark.parametrize('case', ['none', 'missing_row', 'wrong_order', 'stale', 'canceled', 'unavailable'])
def test_review_errors_create_no_top_and_preserve_recoverable_source(db, case):
    job = prepare(db)
    selected = command(db, job)
    if case == 'none': selected = command(db, job, matches={})
    elif case == 'missing_row': selected = command(db, job, order=['3', '1'])
    elif case == 'wrong_order': selected = command(db, job, order=['1', '2', '3'])
    elif case == 'stale': selected = command(db, {**job, 'revision': '1'})
    elif case == 'canceled': TopSourceImports(db.service).cancel(db.context(), job['job_ref'])
    elif case == 'unavailable': selected = command(db, job, matches={'3': str(uuid4())})
    before = db.snapshot()
    with pytest.raises(AlbumTopError):
        db.service.execute(db.context(), selected, context_ref=CONTEXT)
    assert db.snapshot() == before
    assert TopSourceImports(db.service).read(db.context(), job['job_ref'])['top_ref'] is None


@pytest.mark.parametrize('action', ['add', 'remove', 'reorder', 'save'])
def test_every_structural_command_rejects_locked_changes_without_side_effects(db, action):
    top, _, _ = finalize(db)
    items = db.service.read(db.context(), top_ref=top['top_ref'])['items']
    changes = {'add': {'album_refs': [db.album_refs[2]]},
        'remove': {'item_refs': [items[0]['ref']]},
        'reorder': {'item_order': [row['ref'] for row in reversed(items)]},
        'save': {'title': 'Must roll back', 'items': [
            {'item_ref': row['ref'], 'album_ref': row['catalog_ref']} for row in reversed(items)]}}[action]
    before = db.snapshot()
    assert_error(lambda: execute(db, action, top, **changes), 'source_locked', 409)
    assert db.snapshot() == before


def test_metadata_save_keeps_lock_and_original_evidence_then_unlock_is_deliberate(db):
    top, _, _ = finalize(db)
    original = read_source(db.service, db.context(), top['top_ref'], top['revision'])
    renamed, _ = execute(db, 'save', top, title='New title')
    read = db.service.read(db.context(), top_ref=top['top_ref'])
    assert read['source_locked'] and read['title'] == 'New title'
    unlocked, unlock_command = execute(db, 'unlock_source', renamed)
    assert db.service.execute(db.context(), unlock_command, context_ref=CONTEXT) == unlocked
    read = db.service.read(db.context(), top_ref=top['top_ref'])
    assert not read['source_locked'] and read['source_derived']
    assert read['allowed_actions']['can_add'] and not read['allowed_actions']['can_unlock_source']
    evidence = read_source(db.service, db.context(), top['top_ref'], unlocked['revision'])
    assert evidence['source'] == original['source'] and evidence['review_report'] == original['review_report']
    execute(db, 'add', unlocked, album_refs=[db.album_refs[2]])
    assert [row['original_position'] for row in db.service.read(db.context(), top_ref=top['top_ref'])['items']] == [1, 3, 4]


def test_copy_preserves_only_catalog_rank_identity_and_lock(db):
    top, _, _ = finalize(db)
    copied, _ = execute(db, 'copy', top)
    read = db.service.read(db.context(), top_ref=copied['top_ref'])
    assert read['source_locked'] and read['source_derived']
    assert [row['original_position'] for row in read['items']] == [1, 3]
    evidence = read_source(db.service, db.context(), copied['top_ref'], copied['revision'])
    assert not evidence['evidence_available'] and evidence['source'] is None and evidence['review_report'] is None
    with db.connect() as connection:
        assert connection.execute('select 1 from app.album_top_source_finalizations where top_ref=%s',
                                  (copied['top_ref'],)).fetchone() is None
    execute(db, 'unlock_source', copied)


def test_database_guard_rejects_structural_sql_even_outside_command_dispatch(db):
    top, _, _ = finalize(db)
    with pytest.raises(Exception) as error:
        with db.connect() as connection:
            connection.execute('delete from app.album_list_items where top_ref=%s', (top['top_ref'],))
    assert getattr(error.value, 'sqlstate', None) == '55000'
    assert error.value.diag.constraint_name == 'album_top_source_locked'
    assert len(db.service.read(db.context(), top_ref=top['top_ref'])['items']) == 2


def test_concurrent_finalization_has_one_top(db):
    job = prepare(db)
    selected = command(db, job)
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(db.service.execute, db.context(), selected, context_ref=CONTEXT) for _ in range(2)]
        results = [future.result(timeout=15) for future in futures]
    assert results[0] == results[1]
    assert len(db.snapshot()['tops']) == 1


def test_viewer_copy_never_grants_private_source_and_editor_cannot_unlock(db):
    top, _, _ = finalize(db)
    viewer = member(db)
    shared, _ = write(db, 'grant_viewer', top, account_id=viewer.account_id, role='viewer')
    assert_error(lambda: read_source(db.service, db.context(viewer), top['top_ref'], shared['revision']),
                 'source_evidence_unavailable', 403)
    copied, _ = write(db, 'copy', shared, actor=viewer)
    copy_read = db.service.read(db.context(viewer), top_ref=copied['top_ref'])
    assert copy_read['source_locked'] and copy_read['source_derived']
    assert read_source(db.service, db.context(viewer), copied['top_ref'], copied['revision'])['source'] is None
    promoted, _ = write(db, 'grant_editor', shared, account_id=viewer.account_id, role='editor')
    assert read_source(db.service, db.context(viewer), top['top_ref'], promoted['revision'])['source']['content']
    unlock = normalize_top_command('unlock_source', {'request_key': str(uuid4()), 'revision': promoted['revision']},
                                   top_ref=top['top_ref'])
    assert_error(lambda: db.service.execute(db.context(viewer), unlock, context_ref=CONTEXT), 'forbidden', 403)
    assert db.service.read(db.context(viewer), top_ref=top['top_ref'])['source_locked']


def test_source_owner_and_current_row_scope_are_rechecked(db):
    job = prepare(db)
    other = member(db)
    selected = command(db, job)
    before = db.snapshot()
    with pytest.raises(AlbumTopError):
        db.service.execute(db.context(other), selected, context_ref=CONTEXT)
    assert db.snapshot() == before


def test_ambiguous_plain_order_is_an_explicit_complete_choice(db):
    job = prepare(db, content='A\nB\nC')
    top, _, _ = finalize(db, job, matches={'1': db.album_refs[0], '3': db.album_refs[1]}, order=['1', '3', '2'])
    assert [row['row_ref'] for row in top['source_report']] == ['1', '3', '2']
    assert all(row['original_explicit_rank'] is None for row in top['source_report'])


def test_stale_unlock_cannot_override_newer_metadata_or_revoked_role(db):
    top, _, _ = finalize(db)
    renamed, _ = execute(db, 'save', top, title='Later metadata')
    assert_error(lambda: execute(db, 'unlock_source', top), 'revision_conflict', 409)
    assert db.service.read(db.context(), top_ref=renamed['top_ref'])['source_locked']


def test_final_session_fence_rolls_back_creation_lock_and_source_binding(db, monkeypatch):
    from datetime import timedelta
    from music_app.services import album_top_source_finalization as source
    job = prepare(db)
    selected = command(db, job)
    before = db.snapshot()
    original = source.finish
    def late(*args, **kwargs):
        original(*args, **kwargs)
        monkeypatch.setattr(db.service, '_clock', lambda: db.now + timedelta(days=2))
    monkeypatch.setattr(source, 'finish', late)
    assert_error(lambda: db.service.execute(db.context(), selected, context_ref=CONTEXT), 'forbidden', 403)
    assert db.snapshot() == before
    with db.connect() as connection:
        assert connection.execute('select top_ref from app.album_top_source_finalizations where job_ref=%s',
                                  (job['job_ref'],)).fetchone() is None
