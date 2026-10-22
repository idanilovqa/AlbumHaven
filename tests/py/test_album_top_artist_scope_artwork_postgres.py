"""Scope admission through the genuine two-transaction artwork publication owner."""
from copy import deepcopy

import pytest

from music_app.services import album_top_artist_scope_postgres as artist_scopes
from music_app.services.album_top_artwork_preparation import TopArtworkPreparationService
from tests.py.test_owned_album_tops_postgres import db, urls, assert_error
from tests.py.test_album_top_artist_scope_postgres import seed_scope, create, refs
from tests.py.test_top_artwork_publication_retention_postgres import publication_case, durable_snapshot, POSIX_CAPTURE
from tests.py.test_top_artwork_publication_postgres import (
    c2_case, ready, review_command, execute, observe,
)
from tests.py.test_top_artwork_draft_preparation_postgres import command as draft_command


def scoped_case(case, *, observe_artwork=False):
    # The existing fixture creates real metadata sources/files and an ordinary
    # Top. A second, genuinely scoped empty Top is created through its service.
    # Only this explicit draft proposes the two local additions.
    case.build(2, excluded=(1,) if observe_artwork else (0, 1))
    case.db.scope_artists = seed_scope(case.db)
    case.top, _ = create(case.db, mode='family', refs=[])
    case.items = [{**row, 'item_ref': None} for row in case.items]
    case.payload = {**case.payload, 'revision': case.top['revision'], 'items': case.items}
    payload = draft_command(case, new=(0, 1))
    state, payload = ready(case, 'draft', payload=payload)
    _, command = review_command(case, state, 'draft', payload)
    return case, command


def remove_family(case, connection=None):
    if connection is None:
        with case.db.connect() as owned:
            owned.execute("set local lock_timeout='2s'")
            owned.execute("set local statement_timeout='5s'")
            return remove_family(case, owned)
    connection.execute('delete from library.local_artist_family_links where library_id=%s', (case.db.library,))


def test_artwork_a1_rejects_new_member_outside_current_saved_scope(c2_case):
    case, command = scoped_case(c2_case)
    remove_family(case)
    before = durable_snapshot(case)
    assert_error(lambda: execute(case, command), 'album_outside_artist_scope', 409)
    assert durable_snapshot(case) == before
    assert refs(case.db, case.top) == []


@POSIX_CAPTURE
def test_artwork_a2_rechecks_scope_after_the_actual_outside_observation_gap(c2_case, monkeypatch):
    case, command = scoped_case(c2_case, observe_artwork=True)
    original = TopArtworkPreparationService._draft_probe
    observed = []
    def probed(snapshot):
        result = original(snapshot)
        observed.append(True)
        remove_family(case)
        return result
    monkeypatch.setattr(TopArtworkPreparationService, '_draft_probe', staticmethod(probed))
    before = durable_snapshot(case)
    assert_error(lambda: execute(case, command), 'album_outside_artist_scope', 409)
    assert observed == [True]
    assert durable_snapshot(case) == before
    assert refs(case.db, case.top) == []


@POSIX_CAPTURE
def test_artwork_finishes_each_actual_transaction_and_preserves_exact_explicit_members(c2_case, monkeypatch):
    case, command = scoped_case(c2_case, observe_artwork=True)
    start, finish = artist_scopes.start, artist_scopes.finish
    starts, finishes = [], []
    def started(connection, live, supplied, top, constraints):
        witness = start(connection, live, supplied, top, constraints)
        assert witness is not None
        starts.append(witness)
        return witness
    def finished(connection, live, witness, constraints):
        result = finish(connection, live, witness, constraints)
        finishes.append(witness)
        return result
    monkeypatch.setattr(artist_scopes, 'start', started)
    monkeypatch.setattr(artist_scopes, 'finish', finished)
    receipt = execute(case, command)
    assert len(starts) == len(finishes) == 2
    assert all(any(witness is captured for captured in starts) for witness in finishes)
    assert refs(case.db, receipt) == case.catalog_refs
    assert case.db.read(receipt)['artist_scope'] == {'root_artist_id': str(case.db.scope_artists[0]), 'mode': 'family'}


def test_artwork_post_receipt_scope_change_rolls_back_final_publication(c2_case):
    case, command = scoped_case(c2_case)
    before = durable_snapshot(case)
    changed = []
    def after(connection, sql, params, trace):
        if sql.startswith('insert into app.album_list_operations '):
            changed.append(True)
            remove_family(case)
    with observe(case, after=after):
        assert_error(lambda: execute(case, command), 'artist_scope_changed', 409)
    assert changed == [True]
    assert durable_snapshot(case) == before
    assert refs(case.db, case.top) == []
