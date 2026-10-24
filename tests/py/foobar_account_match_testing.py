"""Authored-only SQL-result fixtures; no shadow command/CAS/replay protocol.

History stores values INSERTed by the genuine repository. The only simulated
semantics are SQL selection, aggregation, binding rows and outer commit/rollback.
"""
from contextlib import contextmanager
from copy import deepcopy
import json
from datetime import datetime

from music_app.services import foobar_account_match_decisions as m
from music_app.services import foobar_account_match_readiness as readiness
from tests.py.foobar_account_matching_composed_boundary import (
    ComposedBoundary, requested_context, authority, p, BROWSE, TASTE,
)
from tests.py.foobar_account_service_readiness_testing import CatalogBoundary, CatalogCursor
from tests.py.test_foobar_match_decision_commands import mapping, SOURCE, OBS, OP


class MatchCatalog(CatalogBoundary):
    def execute(self,sql):
        if sql==readiness._SCHEMA_SQL:
            self.calls.append(sql)
            if self.raise_query:
                raise OSError('synthetic catalog failure')
            cursor=CatalogCursor(self.rows)
            self.cursors.append(cursor)
            return cursor
        return super().execute(sql)


class MatchBoundary(ComposedBoundary):
    def __init__(self):
        super().__init__()
        self.history={}
        self.bindings={}
        self.subjects={(1,SOURCE,OBS)}
        self.scopes={(1,SOURCE)}
        self.targets={(7,21):'synthetic-key', (7,22):'other-key'}
        self.overrides={}
        self.outer_scopes=[]
        self.updated_at=self.now
        self.clock_high_water=self.now

    @contextmanager
    def outer(self,url,live,*,matching_library_id,constraints=None):
        assert url=='synthetic:no-network'
        live=authority.require_account_foobar(live,constraints)
        self.outer_scopes.append(matching_library_id)
        before=deepcopy((self.history,self.bindings,self.revision,self.updated_at,self.clock_high_water))
        try:
            yield self,live,self.now
            authority.require_account_foobar(live,constraints)
        except BaseException:
            self.history,self.bindings,self.revision,self.updated_at,self.clock_high_water=before
            raise
        self.commits+=1
        if self.lose_ack:
            self.lose_ack=False
            raise OSError('synthetic commit acknowledgement lost')

    def execute(self,sql,params=None,**kwargs):
        assert sql not in (p.taste._foobar_taste_read_sql(),p.taste._foobar_taste_write_sql())
        assert 'track_preferences' not in sql.lower()
        return super().execute(sql,params,**kwargs)

    def dispatch(self,sql,params):
        v=json.loads(params[0])
        if sql==m.gate._LOCK_SQL:
            assert v[1] is None
            return [self.stream()] if (v[0],v[3]) in self.scopes else []
        if sql in self.overrides:
            return deepcopy(self.overrides[sql])
        if sql==m._ADVANCE_ASSOCIATION_REVISION:
            # Model the SQL WHERE/CAS/clock predicates from independent stored
            # state; never manufacture a success row from the request alone.
            assert len(v)==11
            account,source=v[:2]
            expected=v[9]
            earlier=datetime.fromisoformat(v[10].replace('Z','+00:00'))
            if ((account,source)!=(1,SOURCE) or (account,source) not in self.scopes
                    or self.revision!=expected or self.revision>=9223372036854775807
                    or self.updated_at>self.clock_high_water
                    or self.clock_high_water>self.now or self.now<earlier):
                return []
            self.revision+=1
            self.updated_at=self.clock_high_water=self.now
            return [dict(revision=self.revision,updated_at=self.updated_at,
                clock_high_water=self.clock_high_water)]
        account,source,obs,op,action,library,target,expected,version=v[:9]
        operation=(account,source,op)
        subject=(account,source,obs)
        binding=(*subject,library)
        if sql==m._REPLAY:
            return [dict(self.history[operation])] if operation in self.history else []
        if sql==m._F+m._SUBJECT:
            return [{'observation_ref':obs}] if subject in self.subjects else []
        if sql==m._CURRENT:
            row=self.bindings.get(binding)
            return [] if row is None else [dict(decision_ref=row['decision_ref'],
                match_version=row['match_version'],action=row['action'])]
        if sql==m._MAXIMUM:
            versions=[row['match_version'] for (owner,src,_),row in self.history.items()
                if (owner,src,row['observation_ref'],row['library_id'])==binding]
            return [dict(maximum_version=max(versions,default=0))]
        if sql==m._TARGET:
            self.native_calls.append(sql)
            key=self.targets.get((library,target))
            return [] if key is None else [dict(track_id=target,library_id=library,
                key_bytes=len(key.encode('utf8')),track_key=key)]
        if sql==m._INSERT:
            assert operation not in self.history
            row=dict(zip(m._FIELDS,v[1:9]))
            row.update(decision_ref=v[9],match_version=v[10],created_at=self.now)
            self.history[operation]=row
            return [dict(row)]
        if sql==m._BIND:
            self.bindings[binding]=dict(decision_ref=v[9],match_version=v[10],
                action=action,track_key=v[11])
            return [dict(decision_ref=v[9],match_version=v[10])]
        if sql==m._DETACH:
            old=self.bindings.pop(binding,None)
            return [] if old is None else [dict(decision_ref=old['decision_ref'],
                match_version=old['match_version'])]
        raise AssertionError('Unknown association query')


def install(monkeypatch):
    db=MatchBoundary()
    catalog=MatchCatalog([{'structural_ready':True}])
    monkeypatch.setattr(m,'current_foobar_import_transaction',db.outer)
    monkeypatch.setattr(readiness,'pooled_connection',catalog.pooled)
    return db,catalog


def command(**changes):
    return m.command_from_mapping(mapping(**changes))


def preview(cmd=None,*,context=None,constraints=None):
    return m.preview_foobar_match_decision('synthetic:no-network',context or requested_context(7),
        command=cmd or command(),constraints=constraints)


def apply(cmd=None,*,context=None,constraints=None):
    return m.apply_foobar_match_decision('synthetic:no-network',context or requested_context(7),
        command=cmd or command(),constraints=constraints)
