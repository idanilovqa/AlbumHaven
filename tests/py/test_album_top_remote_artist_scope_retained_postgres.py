"""Explicit saved membership survives later identity changes; new admissions do not."""
from tests.py.remote_top_postgres_support import remote, db, urls
from tests.py.remote_top_retention_postgres_support import retained
from tests.py.test_album_top_remote_membership_postgres import mixed, pending
from tests.py.test_album_top_remote_artist_scope_postgres import (
    artist_remote, identity, scoped_command, acquire, descriptor, ARTIST, OTHER,
)
from tests.py.test_owned_album_tops_postgres import assert_error


def saved(case):
    command, _ = scoped_command(case, local=True)
    return case.execute(command)


def test_retained_reorder_metadata_and_copy_ignore_later_identity_changes(artist_remote):
    case = artist_remote
    top = saved(case)
    original = case.read(top)
    identity(case, 0, OTHER)
    rows = original['items']
    top = case.execute(case.command('reorder', top, item_order=[row['ref'] for row in reversed(rows)]))
    draft = case.read(top)['edit_draft']['item_selections']
    top = case.execute(case.command('save', top, title='Still explicit', item_selections=draft))
    copy = case.execute(case.command('copy', top))
    source_rows = case.read(top)['items']
    assert [row['catalog_ref'] for row in case.read(copy)['items']] == [row['catalog_ref'] for row in source_rows]
    assert case.read(copy)['artist_scope'] == descriptor(case.db)
    top = case.execute(case.command('remove', top, item_refs=[source_rows[0]['ref']]))
    assert len(case.read(top)['items']) == 1
    assert len(case.read(copy)['items']) == 2


def test_removed_retained_history_requires_current_scope_before_readdition(artist_remote):
    case = artist_remote
    top = saved(case)
    draft = case.read(top)['edit_draft']['item_selections']
    remote_row = next(row for row in draft if row['source']['kind'] == 'remote_retained')
    selector = remote_row['source']
    top = case.execute(case.command('remove', top, item_refs=[remote_row['item_ref']]))
    identity(case, 0, OTHER)
    command = case.command('add', top, selections=[selector])
    before = case.snapshot()
    assert_error(lambda: case.execute(command), 'album_outside_artist_scope', 409)
    assert case.snapshot() == before
    identity(case, 0, ARTIST)
    result = case.execute(command)
    assert len(case.read(result)['items']) == 2


def test_current_member_new_acquisition_for_same_catalog_keeps_retained_exemption(artist_remote):
    case = artist_remote
    top = saved(case)
    original_facts = case.remote.facts
    identity(case, 0, OTHER)
    fresh = case.acquire(top, facts=original_facts)
    draft = case.read(top)['edit_draft']['item_selections']
    changed = [{**row, 'source': pending(fresh)} if row['source']['kind'] == 'remote_retained' else row for row in draft]
    result = case.execute(case.command('save', top, title='Same members', item_selections=changed))
    assert [row['catalog_ref'] for row in case.read(result)['items']] == [row['album_ref'] for row in draft]
    assert not any(str(row['ref']) == fresh['acquisition_ref'] for row in case.remote.rows())


def test_existing_item_source_cannot_change_catalog_under_scope_exemption(artist_remote):
    case = artist_remote
    top = saved(case)
    fresh = acquire(case, top, ids=(ARTIST,))
    draft = case.read(top)['edit_draft']['item_selections']
    changed = [{**row, 'source': pending(fresh)} if row['source']['kind'] == 'remote_retained' else row for row in draft]
    command = case.command('save', top, title='Must roll back', item_selections=changed)
    before = case.snapshot()
    assert_error(lambda: case.execute(command), 'items_changed', 409)
    assert case.snapshot() == before
