"""Authored only. Real native taste reader/writer, synthetic SQL result boundary.

Policy evaluation, metadata grammar, mutation decisions and postimage checks are
not mocked. No SQL executes; no native transaction/lock behavior is proven.
"""
from contextlib import contextmanager
from dataclasses import replace
import json
from types import SimpleNamespace

import pytest

from tests.py.foobar_account_matching_synthetic import p, SOURCE, context
from music_app.services.current_actor import CapabilityGrant, LibraryRelationship

OBS = '66666666-6666-4666-8666-666666666666'


def local_context(library=7):
    ctx = context()
    return replace(ctx, library_id=library, actor=replace(ctx.actor,
        current_library_id=library,
        library_relationships=(LibraryRelationship(library, 'member', False),),
        capability_grants=tuple(CapabilityGrant(action, 'library', library)
            for action in ('library.browse.read', 'library.track_preferences.manage'))))


class Cursor:
    def __init__(self, rows):
        self.rows = rows
        self.closed = False

    def fetchall(self):
        assert not self.closed
        return self.rows

    def close(self):
        self.closed = True


class TasteBoundary:
    autocommit = False
    info = SimpleNamespace(transaction_status=2)

    def __init__(self, *, rating=None, love='off', protected=False, owned=False, corrupt=False):
        self.calls, self.cursors = [], []
        self.corrupt = corrupt
        self.row = dict(track_id=21, selection_status='ok', preference_id=51 if rating is not None else None,
            identity_seal='a'*64, rating=rating, love_tier=love,
            rating_protected=protected, favorite_protected=protected,
            rating_observation_ref=OBS if owned else None,
            rating_source_revision=1 if owned else None,
            favorite_observation_ref=None, favorite_source_revision=None, state_seal='b'*64)

    @contextmanager
    def transaction(self):
        yield

    def execute(self, sql, params, **kwargs):
        assert kwargs == {'binary':True}
        frame = json.loads(params[0])
        assert frame[:3] == [1,7,SOURCE]
        self.calls.append((sql, frame))
        if sql == p.taste._foobar_taste_read_sql():
            rows = [dict(self.row)]
        elif sql == p.taste._foobar_taste_write_sql():
            assert frame[3:6] == [21,OBS,2]
            self.row['preference_id'] = 51
            if frame[7]:
                self.row.update(rating=frame[6], rating_observation_ref=OBS, rating_source_revision=2)
            if frame[8]:
                self.row.update(love_tier='loved', favorite_observation_ref=OBS, favorite_source_revision=2)
            if self.corrupt:
                self.row['rating_source_revision'] = 1
            self.row['state_seal'] = 'c'*64
            rows = [dict(id=51)]
        else:
            raise AssertionError('Unknown native taste SQL')
        cursor = Cursor(rows); self.cursors.append(cursor)
        return cursor


@pytest.mark.parametrize('rating,love,protected,owned,expected', [
    (None,'off',False,False,(True,True)),
    (2,'off',False,True,(True,True)),
    (2,'off',False,False,(False,True)),
    (2,'off',True,False,(False,False)),
    (None,'obsessed',False,False,(True,False)),
    (4,'loved',False,True,(False,False)),
])
def test_actual_native_taste_effects_preserve_explicit_and_provenance(rating,love,protected,owned,expected):
    db = TasteBoundary(rating=rating,love=love,protected=protected,owned=owned)
    ctx = local_context()
    before = p.taste.read_foobar_taste_on_connection(db,ctx,source_ref=SOURCE,track_ids=(21,))
    result = p.taste.apply_foobar_taste_with_postimages_on_connection(db,ctx,
        source_ref=SOURCE,items=(p.taste.FoobarTasteChange(21,OBS,2,4,True),),expected=before)
    outcome = result.outcomes[0]
    assert (outcome.rating_written,outcome.favorite_promoted) == expected
    after = result.postimages[0]
    assert after.rating_marker == ((SOURCE,OBS,2,4) if expected[0] else before[0].rating_marker)
    assert after.favorite_marker == ((SOURCE,OBS,2,'loved') if expected[1] else before[0].favorite_marker)
    assert after.rating_protected == protected and after.favorite_protected == protected
    writes = [frame for sql,frame in db.calls if sql == p.taste._foobar_taste_write_sql()]
    assert len(writes) == int(any(expected))
    assert all(cursor.closed for cursor in db.cursors)


def test_native_taste_writer_rejects_wrong_provenance_postimage():
    db = TasteBoundary(corrupt=True)
    ctx = local_context()
    before = p.taste.read_foobar_taste_on_connection(db,ctx,source_ref=SOURCE,track_ids=(21,))
    with pytest.raises(p.taste.FoobarTasteStale):
        p.taste.apply_foobar_taste_with_postimages_on_connection(db,ctx,
            source_ref=SOURCE,items=(p.taste.FoobarTasteChange(21,OBS,2,4,True),),expected=before)


def test_optional_envelope_uses_actual_native_state_marker_validator():
    # Direct canonical owner validates the same typed state called by the envelope.
    state = p.taste.FoobarTasteState(21,'ok',51,'a'*64,4,'loved',False,False,
        (SOURCE,OBS,2,4),(SOURCE,OBS,2,'loved'),'b'*64,True,True)
    p.taste._foobar_taste_check_state(state,SOURCE)
    with pytest.raises(p.taste.FoobarTasteUnavailable):
        p.taste._foobar_taste_check_state(replace(state,
            rating_marker=('77777777-7777-4777-8777-777777777777',OBS,2,4)),SOURCE)
