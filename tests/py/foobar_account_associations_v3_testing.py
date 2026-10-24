"""Authored-only v3 SQL-result fixture. Actual chain and policy owners retained.

No SQL executes. Source and association state below emulate driver result rows,
not the import resolver, merge algorithm, seal validator, writer or finalizer.
"""
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import replace
import hashlib
import json
from uuid import uuid4

from music_app.services import foobar_account_import_associations as associations
from music_app.services import foobar_account_match_readiness as readiness
from tests.py.foobar_account_matching_composed_boundary import (
    ComposedBoundary, requested_context, authority, p, a, f, bridge, scalars,
    BROWSE, TASTE, SOURCE, GEN, PAYLOAD, CAPACITY, command as old_command,
)


def digest(raw): return hashlib.sha256(raw).hexdigest()
def raw(row,index): return bytes.fromhex(row[index])


class V3Boundary(ComposedBoundary):
    def __init__(self,library=7):
        super().__init__(library)
        self.source_rows={}
        self.source_versions={}
        self.history={}
        self.bindings={}
        self.association_calls=[]
        self.files={21:'/synthetic.flac',22:'/other.flac'}
        self.tastes={21:dict(self.taste_row),22:dict(self.taste_row,track_id=22)}
        self.external_conflicts=set()

    @contextmanager
    def outer(self,url,live,*,matching_library_id,constraints=None):
        assert url=='synthetic:no-network'
        live=authority.require_account_foobar(live,constraints)
        before=deepcopy((self.receipt,self.keys,self.revision,self.source_rows,
            self.source_versions,self.history,self.bindings,self.tastes,self.history_projections))
        try:
            yield self,live,self.now
            authority.require_account_foobar(live,constraints)
        except BaseException:
            (self.receipt,self.keys,self.revision,self.source_rows,self.source_versions,
             self.history,self.bindings,self.tastes,self.history_projections)=before
            raise
        self.commits+=1
        if self.lose_ack:
            self.lose_ack=False
            raise OSError('synthetic committed acknowledgement lost')

    def execute(self,sql,params=None,**kwargs):
        if sql==readiness._SCHEMA_SQL:
            self.calls.append(sql)
            return self.cursor([{'structural_ready':True}])
        if sql==scalars._foobar_inventory_scalar_sql():
            self.calls.append(sql); self.native_calls.append(sql)
            assert params=={'account_id':1,'library_id':self.library}
            return self.cursor([dict(admitted=True,file_id=track+10,track_id=track,
                path_bytes=len(path.encode()),path_sha256=digest(path.encode()),
                selection_status='ok',file_available=True) for track,path in sorted(self.files.items())])
        if sql==bridge._path_projection_sql():
            self.calls.append(sql); self.native_calls.append(sql)
            frame=json.loads(params[0]); assert frame[:2]==[1,self.library]
            return self.cursor([dict(file_id=file,track_id=track,private_path=self.files[track])
                for file,track,size,sha in frame[2]])
        if sql in (p.taste._foobar_taste_read_sql(),p.taste._foobar_taste_write_sql()):
            self.calls.append(sql); self.native_calls.append(sql)
            v=json.loads(params[0]); assert v[:3]==[1,self.library,SOURCE]
            if sql==p.taste._foobar_taste_read_sql():
                return self.cursor([dict(self.tastes[track]) for track in v[3]])
            track,ref,revision=v[3:6]
            assert ref in self.source_rows and self.source_versions[ref]==revision
            row=self.tastes[track]; row['preference_id']=track+30
            if v[7]: row.update(rating=v[6],rating_observation_ref=ref,rating_source_revision=revision)
            if v[8]: row.update(love_tier='loved',favorite_observation_ref=ref,favorite_source_revision=revision)
            row['state_seal']='c'*64
            return self.cursor([dict(id=row['preference_id'])])
        return super().execute(sql,params,**kwargs)

    def by_identity(self,hex_value):
        return next((r for r in self.source_rows.values() if r[2]==hex_value),None)

    def dispatch(self,sql,params):
        v=json.loads(params[0]); w=p.source
        if sql in (associations._READ,associations._TARGETS,associations._CONFLICTS,associations._WRITE):
            self.association_calls.append(sql)
            account,source,library,items=v[:4]
            assert account==1 and source==SOURCE and library==self.library
            if sql==associations._READ:
                result=[]
                for ordinal,ref,*unused in items:
                    key=(library,ref); current=self.bindings.get(key); history=self.history.get(key,[])
                    head=max(history,key=lambda row:row['version']) if history else None
                    result.append(dict(ordinal=ordinal,
                        binding_decision=None if current is None else current['decision'],
                        binding_version=None if current is None else current['version'],
                        binding_track_id=None if current is None else current['track'],
                        head_decision=None if head is None else head['decision'],
                        head_version=None if head is None else head['version'],
                        head_action=None if head is None else head['action'],
                        head_track_id=None if head is None else head['track']))
                return result
            if sql==associations._CONFLICTS:
                refs={i[1] for i in items}
                occupied={r['track'] for (lib,ref),r in self.bindings.items() if lib==library and ref not in refs}
                return [dict(track_id=t) for t in sorted(set(v[4]) & (occupied | self.external_conflicts))]
            if sql==associations._TARGETS:
                return [dict(ordinal=i[0],track_id=i[2],library_id=library) for i in items if i[2] in self.files]
            result=[]
            for ordinal,ref,track,operation,decision in items:
                assert ref in self.source_rows and (library,ref) not in self.bindings
                assert not self.history.get((library,ref))
                row=dict(decision=decision,version=1,action='match',track=track,operation=operation)
                self.history[(library,ref)]=[row]; self.bindings[(library,ref)]=dict(row)
                result.append(dict(ordinal=ordinal,operation_ref=operation,decision_ref=decision,match_version=1,track_id=track))
            return result
        if sql in (p.original_sources._SCALAR_SQL, p.original_sources._RAW_SQL):
            assert v[0] == 1 and v[1] in (None, self.library) and v[2] == SOURCE
            row = self.source_rows.get(v[3])
            if (row is None or self.source_versions[row[0]] != v[4]
                    or digest(raw(row, 6)) != v[5] or digest(raw(row, 7)) != v[6]):
                return []
            if sql == p.original_sources._RAW_SQL:
                expected = [len(raw(row, 2)), len(raw(row, 6)), len(raw(row, 7)),
                    digest(raw(row, 2)), row[1], len(raw(row, 8)), digest(raw(row, 8))]
                if v[7:] != expected:
                    return []
                return [dict(identity_bytes=raw(row, 2), evidence_bytes=raw(row, 6),
                    display_bytes=raw(row, 7), incoming_evidence_bytes=raw(row, 8))]
            return [dict(identity_bytes_size=len(raw(row, 2)), evidence_bytes_size=len(raw(row, 6)),
                display_bytes_size=len(raw(row, 7)), identity_sha256=digest(raw(row, 2)),
                identity_kind=row[1], incoming_evidence_bytes_size=len(raw(row, 8)),
                incoming_evidence_sha256=digest(raw(row, 8)))]
        if sql==p.lookup._CARDINALITY_SQL:
            out=[]
            for ordinal,(kind,sha) in enumerate(v[3],1):
                rows=[r for r in self.source_rows.values() if r[1]==kind and digest(raw(r,2))==sha]
                out.append(dict(ordinal=ordinal,candidate_count=len(rows),comparison_bytes=sum(
                    sum(len(raw(r,i)) for i in (2,6,7,8)) for r in rows),candidates_valid=True))
            return out
        if sql==p.lookup._COMPARE_SQL:
            row=self.by_identity(v[5])
            if row is None:
                return [dict(matching_count=0,observation_ref=None,source_revision=None,evidence_sha256=None,
                    display_sha256=None,identity_bytes=None,evidence_bytes=None,display_bytes=None,
                    incoming_evidence_sha256=None,incoming_evidence_bytes=None)]
            return [dict(matching_count=1,observation_ref=row[0],source_revision=self.source_versions[row[0]],
                evidence_sha256=digest(raw(row,6)),display_sha256=digest(raw(row,7)),identity_bytes=len(raw(row,2)),
                evidence_bytes=len(raw(row,6)),display_bytes=len(raw(row,7)),incoming_evidence_sha256=digest(raw(row,8)),
                incoming_evidence_bytes=len(raw(row,8)))]
        if sql==p.sizing._MERGED_SIZE_SQL:
            incoming=bytes.fromhex(v[13]); previous=self.source_rows.get(v[3])
            # Model the scalar SQL result for changed originals too. The real
            # caller still verifies sizes against its later genuine merge.
            from tests.py.foobar_account_existing_chain_synthetic import observation_equal
            # Job fixtures can register a second account/source for genuine
            # account-bound review seals. No registration means no SQL row.
            registered = getattr(self, 'sources', {(1, SOURCE)})
            assert (v[0], v[2]) in registered and v[1] in (None, self.library)
            if previous is not None:
                # Existing source_rows in this legacy fixture belong to its
                # original account/source only; registration cannot share them.
                assert (v[0], v[2]) == (1, SOURCE)
                assert v[4] == self.source_versions[previous[0]]
                assert v[5:9] == [digest(raw(previous,6)), digest(raw(previous,7)),
                    len(raw(previous,6)), len(raw(previous,7))]
                assert v[16:18] == [digest(raw(previous,8)), len(raw(previous,8))]
            fields = p.evidence.decode_evidence(incoming)
            old = None if previous is None else p.evidence.decode_evidence(raw(previous,6))
            merged = p.evidence.merge_fields(old, fields)
            effective = p.evidence.encode_evidence(merged)
            same = previous is not None and effective == raw(previous,6) and observation_equal(raw(previous,8), incoming)
            return [dict(limits_valid=True,association_valid=True,shape_valid=True,origin_unique=True,
                evidence_unchanged=same,evidence_bytes=len(effective),display_bytes=w.display.display_size(merged))]
        if sql==p.prior_merge._PRIOR_SQL:
            row=self.source_rows[v[3]]
            return [dict(evidence_bytes=raw(row,6),display_bytes=raw(row,7),incoming_evidence_bytes=raw(row,8))]
        if sql==p._CURRENT_SOURCE_SQL:
            out=[]
            for ordinal,(ref,version,evidence,display) in enumerate(v[4],1):
                row=self.source_rows.get(ref)
                valid=(row is None if version is None else row is not None and self.source_versions[ref]==version
                    and digest(raw(row,6))==evidence and digest(raw(row,7))==display)
                out.append(dict(ordinal=ordinal,valid=valid))
            return out
        if sql==p._CAPACITY_SQL:
            return [dict(observation_count=len(self.source_rows),revision_count=len(self.source_rows),
                source_bytes=sum(sum(len(raw(r,i)) for i in (2,6,7,8)) for r in self.source_rows.values())
                    +sum(len(row["projection_bytes"]) for row in self.history_projections.values()))]
        if sql in (w._stream_sql(),w._stream_sql(touch=True)):
            assert v[:3]==[1,SOURCE,GEN] and v[3]==self.revision
            return [dict(revision=self.revision,current_generation=GEN,retired_through=0,isolation='read committed')]
        if sql in (w._cardinality_sql(),w._current_incoming_sql(),w._current_sql()):
            out=[]
            for ordinal,incoming in enumerate(v[4],1):
                row=self.by_identity(incoming[2]); exists=row is not None
                if sql==w._cardinality_sql():
                    out.append(dict(ordinal=ordinal,candidate_count=int(exists),comparison_bytes=0 if row is None else sum(len(raw(row,i)) for i in (2,6,7,8))))
                    continue
                result=dict(ordinal=ordinal,matching_count=int(exists),observation_ref=None if row is None else row[0],
                    current_revision=None if row is None else self.source_versions[row[0]],
                    incoming_evidence_sha256=None if row is None else digest(raw(row,8)))
                if sql==w._current_incoming_sql(): result['incoming_evidence_bytes']=None if row is None else raw(row,8)
                else: result.update(evidence_sha256=None if row is None else digest(raw(row,6)),
                    display_sha256=None if row is None else digest(raw(row,7)),
                    incoming_exact=None if row is None else row[8]==incoming[8],
                    same_bytes=None if row is None else all(row[i]==incoming[i] for i in (6,7,8)))
                out.append(result)
            return out
        if sql==w._insert_observations_sql():
            return [dict(observation_ref=r[0]) for r in v[4] if r[3] is None]
        if sql==w._insert_revisions_sql():
            out=[]
            for row in v[4]:
                previous=self.source_rows.get(row[0])
                if previous is None or any(previous[i]!=row[i] for i in (6,7,8)):
                    self.source_rows[row[0]]=row; self.source_versions[row[0]]=v[3]+1
                    out.append(dict(observation_ref=row[0]))
            return out
        if sql==w._advance_pointers_sql():
            return [dict(observation_ref=r[0]) for r in v[4] if r[3] is not None and self.source_versions[r[0]]==v[3]+1]
        return super().dispatch(sql,params)


def install(monkeypatch,library=7):
    db=V3Boundary(library)
    monkeypatch.setattr(p,'current_foobar_import_transaction',db.outer)
    return db


def make_command(db,*,library=7,payload=PAYLOAD):
    ctx=requested_context(library)
    if library is None:
        revision=p.NO_LIBRARY_INVENTORY_SHA256
    else:
        live=authority.lock_foobar_matching_context(db,authority.require_account_foobar(ctx),ctx,library)
        revision=bridge.read_foobar_preview_inventory_on_connection(db,live).revision
    cmd=replace(old_command(payload),request_key=str(uuid4()),expected_revision=db.revision,
        matching_library_id=library,inventory_sha256=revision)
    return cmd


def prepare(db,*,library=7,payload=PAYLOAD):
    cmd=make_command(db,library=library,payload=payload)
    ctx=requested_context(library)
    # Previous committed receipt is retained elsewhere by PostgreSQL; this fixture
    # retains its source/history but models one current receipt at a time.
    if db.receipt is not None and db.receipt['state']=='committed': db.receipt=None
    receipt=p.prepare_foobar_import('synthetic:no-network',ctx,command=cmd,payload=payload,
        intake_capacity=CAPACITY)
    return cmd,receipt


def apply(db,cmd,receipt):
    apply_cmd=a.apply_command.FoobarApplyCommand(SOURCE,GEN,str(uuid4()),receipt.receipt_ref,
        receipt.decision_sha256,cmd.matching_library_id)
    result=a.apply_foobar_import('synthetic:no-network',requested_context(cmd.matching_library_id),
        command=apply_cmd,intake_capacity=CAPACITY)
    return apply_cmd,result


def prepared(db):
    return json.loads(db.receipt['prepared'])


def history(db,ref,*,track=22,action='rematch',version=1,binding=True):
    row=dict(decision=str(uuid4()),version=version,action=action,track=None if action=='detach' else track,
        operation=str(uuid4()))
    db.history.setdefault((db.library,ref),[]).append(row)
    if binding: db.bindings[(db.library,ref)]=dict(row)
    else: db.bindings.pop((db.library,ref),None)
    return row
