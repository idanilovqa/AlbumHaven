"""Import matching reuses actual current remote proof and canonical admission."""
from uuid import uuid4
import pytest

from music_app.services.album_top_source_imports import TopSourceImports
from music_app.services.owned_album_tops import normalize_top_command, AlbumTopError
from tests.py.test_album_top_remote_membership_postgres import mixed, pending, retained, runtime, remote, db, urls, evidence
from tests.py.remote_top_postgres_support import CONTEXT


def source(mixed):
    return TopSourceImports(mixed.db.service).submit(mixed.db.context(), {
        'request_key': str(uuid4()), 'title': 'Source', 'description': '', 'kind': 'text',
        'filename': None, 'content': '1. First\n2. Second\n3. Third'})


def create(mixed, job, choices):
    command = normalize_top_command('create', {'request_key': job['job_ref'], 'title': 'Source',
        'source_review': {'job_ref': job['job_ref'], 'revision': job['revision'], 'rows': [
            {'row_ref': str(index), 'selection': selection} for index, selection in enumerate(choices, 1)]}})
    before = len(mixed.remote.calls)
    result = mixed.db.service.execute(mixed.db.context(), command, context_ref=CONTEXT)
    assert len(mixed.remote.calls) == before
    return result, command


def test_remote_source_finalizes_with_real_retention_and_replays_after_consumption(mixed):
    job = source(mixed)
    acquired = mixed.acquire(target={'kind': 'create', 'draft_ref': job['job_ref']})
    top, command = create(mixed, job, [pending(acquired), None,
        {'kind': 'local_catalog', 'album_ref': mixed.db.album_refs[0]}])
    result = mixed.read(top)
    assert result['source_locked'] and result['items'][0]['source_kind'] == 'remote_summary'
    assert [row['original_position'] for row in result['items']] == [1, 3]
    assert len(mixed.rows('album_top_remote_admissions')) == 1
    assert mixed.db.service.execute(mixed.db.context(), command, context_ref=CONTEXT) == top


def test_remote_local_canonical_duplicate_keeps_first_and_reports_second(mixed):
    job = source(mixed)
    acquired = mixed.acquire(target={'kind': 'create', 'draft_ref': job['job_ref']})
    with mixed.db.connect() as connection:
        connection.execute('''insert into catalog.release_group_provider_identities
            (provider,entity_kind,external_id,catalog_ref) values('musicbrainz','release-group',%s,%s)''',
            (mixed.remote.facts.release_group_id, mixed.db.album_refs[0]))
    top, _ = create(mixed, job, [{'kind': 'local_catalog', 'album_ref': mixed.db.album_refs[0]},
                                pending(acquired), None])
    assert [row['outcome'] for row in top['source_report']] == ['matched', 'duplicate', 'unresolved']
    assert top['source_report'][1]['retained_row_ref'] == '1'
    assert len(mixed.read(top)['items']) == 1
    assert mixed.rows('album_top_remote_admissions') == []


def test_two_remote_selectors_for_one_canonical_album_retain_only_first(mixed):
    job = source(mixed)
    facts = evidence(mbid=str(uuid4()), title='Same explicit provider identity')
    target = {'kind': 'create', 'draft_ref': job['job_ref']}
    first, second = mixed.acquire(target=target, facts=facts), mixed.acquire(target=target, facts=facts)
    top, _ = create(mixed, job, [pending(first), pending(second), None])
    assert len(mixed.read(top)['items']) == 1
    assert [row['outcome'] for row in top['source_report']] == ['matched', 'duplicate', 'unresolved']
    assert len(mixed.rows('album_top_remote_admissions')) == 1


def test_wrong_remote_destination_rolls_back_all_top_and_catalog_writes(mixed):
    job = source(mixed)
    acquired = mixed.acquire()  # Different explicit create draft.
    before = mixed.snapshot()
    with pytest.raises(AlbumTopError) as error:
        create(mixed, job, [pending(acquired), None, None])
    assert error.value.code == 'remote_evidence_unavailable'
    assert mixed.snapshot() == before


def test_remote_copy_keeps_lock_without_private_import_job_access(mixed):
    from music_app.services.album_top_source_finalization import read_source
    job = source(mixed)
    acquired = mixed.acquire(target={'kind': 'create', 'draft_ref': job['job_ref']})
    top, _ = create(mixed, job, [pending(acquired), None, None])
    copied = mixed.execute(mixed.command('copy', top))
    assert mixed.read(copied)['source_locked']
    evidence_result = read_source(mixed.db.service, mixed.db.context(), copied['top_ref'], copied['revision'])
    assert not evidence_result['evidence_available'] and evidence_result['source'] is None
