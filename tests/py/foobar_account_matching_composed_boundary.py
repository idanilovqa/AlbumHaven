"""Authored-only composed driver fixture. Never executes SQL.

Extends the frozen account SQL-result dispatcher, not the source protocol.
Only the outer transaction and DB result boundary are replaced. The genuine
matching authority owner reconstructs membership/grants from these DB rows.
"""
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import replace
import hashlib
import json

from tests.py.foobar_account_matching_synthetic import (
    Boundary, Cursor as AccountCursor, p, a, f, authority, context, command,
    SOURCE, KEY, APPLY_KEY, GEN, PAYLOAD, CAPACITY,
)
from music_app.services import foobar_preview_inventory_postgres as scalars
from music_app.services import foobar_preview_inventory_bridge as bridge

PATH = '/synthetic.flac'
BROWSE = 'library.browse.read'
TASTE = 'library.track_preferences.manage'


class Cursor(AccountCursor):
    def fetchall(self):
        assert not self.closed
        return self.rows


class ComposedBoundary(Boundary):
    def __init__(self, library=7, *, rating=None, love='off', protected=False,
                 selection='ok'):
        super().__init__()
        self.library = library
        self.membership = True
        self.grants = (BROWSE,TASTE)
        self.selection = selection
        self.native_calls = []
        self.taste_row = dict(track_id=21,selection_status=selection,
            preference_id=51 if rating is not None or protected or love!='off' else None,
            identity_seal='a'*64,rating=rating,love_tier=love,
            rating_protected=protected,favorite_protected=protected,
            rating_observation_ref=None,rating_source_revision=None,
            favorite_observation_ref=None,favorite_source_revision=None,state_seal='b'*64)

    @contextmanager
    def outer(self,url,live,*,matching_library_id,constraints=None):
        assert url=='synthetic:no-network'
        live=authority.require_account_foobar(live,constraints)
        before=deepcopy((self.receipt,self.keys,self.source_row,self.revision,self.taste_row,self.history_projections))
        try:
            yield self,live,self.now
            authority.require_account_foobar(live,constraints)
        except BaseException:
            self.receipt,self.keys,self.source_row,self.revision,self.taste_row,self.history_projections=before
            raise
        self.commits+=1
        if self.lose_ack:
            self.lose_ack=False
            raise OSError('synthetic lost acknowledgement after commit')

    def cursor(self,rows):
        cursor=Cursor(rows)
        self.cursors.append(cursor)
        return cursor

    def execute(self,sql,params=None,**kwargs):
        if sql.startswith("select set_config('statement_timeout'"):
            return super().execute(sql,params,**kwargs)
        native=(sql==scalars._foobar_inventory_scalar_sql()
            or sql==bridge._path_projection_sql()
            or sql in (p.taste._foobar_taste_read_sql(),p.taste._foobar_taste_write_sql())
            or 'from app.bootstrap_owners' in sql
            or 'from library.library_memberships m join library.libraries l' in sql
            or 'from app.capabilities' in sql)
        if not native:
            return super().execute(sql,params,**kwargs)
        self.calls.append(sql)
        self.native_calls.append(sql)
        if not self.membership and 'from library.library_memberships' not in sql and 'from app.bootstrap_owners' not in sql:
            raise AssertionError('Deleted library must not be read')
        if 'from app.bootstrap_owners' in sql:
            assert params==(1,) and not kwargs
            return self.cursor([])
        if 'from library.library_memberships m join library.libraries l' in sql:
            assert params==(1,1,self.library) and not kwargs
            return self.cursor([dict(membership_role='member',is_primary_owner=False)] if self.membership else [])
        if 'from app.capabilities' in sql:
            assert params==(1,) and not kwargs
            return self.cursor([dict(capability_key=key,scope_kind='library',scope_id=self.library)
                                for key in self.grants])
        if sql==scalars._foobar_inventory_scalar_sql():
            assert params=={'account_id':1,'library_id':self.library} and not kwargs
            return self.cursor([dict(admitted=True,file_id=31,track_id=21,
                path_bytes=len(PATH.encode()),path_sha256=hashlib.sha256(PATH.encode()).hexdigest(),
                selection_status=self.selection,file_available=True)])
        assert kwargs=={'binary':True}
        frame=json.loads(params[0])
        assert frame[:2]==[1,self.library]
        if sql==bridge._path_projection_sql():
            assert frame[2]==[[31,21,len(PATH.encode()),hashlib.sha256(PATH.encode()).hexdigest()]]
            return self.cursor([dict(file_id=31,track_id=21,private_path=PATH)])
        assert frame[2]==SOURCE
        if sql==p.taste._foobar_taste_read_sql():
            assert frame[3]==[21]
            return self.cursor([dict(self.taste_row)])
        if sql==p.taste._foobar_taste_write_sql():
            assert frame[3]==21 and frame[5]==1
            assert self.source_row is not None and frame[4]==self.source_row[0]
            self.taste_row['preference_id']=51
            if frame[7]:
                self.taste_row.update(rating=frame[6],rating_observation_ref=frame[4],rating_source_revision=frame[5])
            if frame[8]:
                self.taste_row.update(love_tier='loved',favorite_observation_ref=frame[4],favorite_source_revision=frame[5])
            self.taste_row['state_seal']='c'*64
            return self.cursor([dict(id=51)])
        raise AssertionError('Unknown native boundary SQL')

    def dispatch(self,sql,params):
        if sql in (p.gate._LOCK_SQL,p.gate._ROLL_SQL):
            values=json.loads(params[0])
            assert values[0]==1 and values[1] in (None,self.library) and values[3]==SOURCE
            return [self.stream()]
        return super().dispatch(sql,params)


def requested_context(library):
    ctx=context()
    # This is selected scope only: deliberately NO caller membership or grants.
    return replace(ctx,library_id=library,actor=replace(ctx.actor,current_library_id=library))


def install(monkeypatch,*,library=7,rating=None,love='off',protected=False,selection='ok'):
    # The frozen v3 SQL-result boundary extends ComposedBoundary. Import only
    # after this module has loaded, so its genuine existing base is never
    # replaced and no import-time cycle is introduced. This adapter changes
    # fixture views/results only, never a production protocol owner.
    from tests.py.foobar_account_associations_v3_testing import V3Boundary

    class CandidateBoundary(V3Boundary):
        @property
        def source_row(self):
            rows=getattr(self,'source_rows',None)
            if rows is None:
                return getattr(self,'_source_row',None)
            assert len(rows)<=1
            return next(iter(rows.values()),None)

        @source_row.setter
        def source_row(self,value):
            self._source_row=value

        @property
        def taste_row(self):
            rows=getattr(self,'tastes',None)
            return self._taste_row if rows is None else rows[21]

        @taste_row.setter
        def taste_row(self,value):
            self._taste_row=value

        def execute(self,sql,params=None,**kwargs):
            cursor=super().execute(sql,params,**kwargs)
            if sql==scalars._foobar_inventory_scalar_sql():
                # Retain the old suite's native-selection conflict dimension.
                # Rows still pass through the genuine native inventory owner.
                for row in cursor.rows:
                    row['selection_status']=self.selection
            return cursor

    db=CandidateBoundary(library)
    db.files={21:PATH}
    db.selection=selection
    db.tastes[21].update(selection_status=selection,rating=rating,love_tier=love,
        preference_id=51 if rating is not None or protected or love!='off' else None,
        rating_protected=protected,favorite_protected=protected)
    monkeypatch.setattr(p,'current_foobar_import_transaction',db.outer)
    return db


def preview_command(db):
    # Genuine native matching authority + inventory bridge determine the digest.
    # No trusted inventory hash, policy row or membership object is fabricated.
    ctx=requested_context(db.library)
    account=authority.require_account_foobar(ctx)
    live=authority.lock_foobar_matching_context(db,account,ctx,db.library)
    inventory=bridge.read_foobar_preview_inventory_on_connection(db,live)
    return replace(command(),matching_library_id=db.library,inventory_sha256=inventory.revision)


def prepare(db,cmd=None,*,constraints=None):
    cmd=cmd or preview_command(db)
    receipt=p.prepare_foobar_import('synthetic:no-network',requested_context(db.library),
        command=cmd,payload=PAYLOAD,intake_capacity=CAPACITY,constraints=constraints)
    return cmd,receipt


def apply_command(receipt,library):
    return a.apply_command.FoobarApplyCommand(SOURCE,GEN,APPLY_KEY,
        receipt.receipt_ref,receipt.decision_sha256,library)


def apply(db,cmd,ctx=None,*,constraints=None):
    return a.apply_foobar_import('synthetic:no-network',ctx or requested_context(db.library),
        command=cmd,intake_capacity=CAPACITY,constraints=constraints)
