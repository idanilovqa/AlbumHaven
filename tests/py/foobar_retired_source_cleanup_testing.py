"""Finite synthetic worker clock/condition and recording SQL boundary.

No real thread, sleep, pool, SQL or application startup. The SQL adapter models
raw rows/rollback, not PostgreSQL catalog permissions, locks or cascade proof.
"""
from contextlib import contextmanager
from copy import deepcopy
import re
from types import SimpleNamespace

from music_app.services import foobar_account_import_service as service
from music_app.services import foobar_account_temporary_source as temporary
from music_app.services import postgres_connections
from tests.py.foobar_account_service_testing import CONFIG, begin_prepare, PAYLOAD

TABLES={
    'integration.foobar_temporary_sources_v1',
    'integration.foobar_temporary_source_chunks_v1',
    'integration.foobar_temporary_source_guard_v1',
}


class Condition:
    def __init__(self, owner, clock, actions):
        self.owner=owner;self.clock=clock;self.actions=list(actions)
        self.waits=[];self.locked=False;self.errors=[]
    def __enter__(self):
        if self.locked:
            self.errors.append('nested condition acquisition')
            raise AssertionError(self.errors[-1])
        self.locked=True
        return self
    def __exit__(self,*args):self.locked=False
    def notify_all(self):pass
    def wait(self,timeout=None):
        self.waits.append(timeout)
        if not self.locked:self.errors.append('wait outside condition')
        if not self.actions:
            self.errors.append('worker exceeded finite notification script')
            self.owner.state=service._State.FAULTED
            return
        action=self.actions.pop(0)
        self.locked=False
        try:action()
        except BaseException as error:
            self.errors.append('notification callback failed: '+type(error).__name__)
            raise
        finally:self.locked=True


class Worker:
    def __init__(self,monkeypatch,flag=False):
        monkeypatch.setattr(service,'_PROCESS_OWNER',None)
        config=dict(CONFIG)
        if flag is not None:config['ALBUM_HAVEN_FOOBAR_TEMPORARY_SOURCE_ENABLED']=flag
        self.handle=service.create_foobar_import_service(config,database_url='synthetic:no-network')
        self.owner=self.handle.owner;self.owner.state=service._State.OPEN
        self.clock=SimpleNamespace(now=60.0)
        monkeypatch.setattr(service.time,'monotonic',lambda:self.clock.now)
        for name in ('require_account_import_schema','require_foobar_job_schema','require_foobar_history_schema'):
            monkeypatch.setattr(service,name,lambda *args:None)
        self.condition=Condition(self.owner,self.clock,[])
        self.owner.condition=self.condition
        self.events=[]
    def advance(self):self.clock.now+=60
    def stop(self):self.owner.state=service._State.DRAINING
    def script(self,*actions):self.condition.actions=list(actions)
    def run(self):
        self.owner._worker()
        assert not self.condition.errors,self.condition.errors
        assert self.owner.exited.is_set() and self.owner.thread is None
    def admit(self):
        ticket=begin_prepare(self.handle)
        self.handle.append_prepare(ticket,PAYLOAD);self.handle.finish_prepare(ticket)
        self.events.append('admitted')
        return ticket
    def install_dispatch(self,monkeypatch):
        def invoke(owner):
            self.events.append('dispatch')
            # Owned invocation boundary only: exercise the real worker's
            # settlement/abandon path without claiming actual import effects.
            try:
                op=owner.current
                if op.intake is not None:op.intake.discard()
                op.command=op.context=op.constraints=op.intake=None
                op.delivery=service._Delivery(op.kind,None,service._Outcome.SUCCESS,None)
                op.abandoned=True;owner.state=service._State.DRAINING
            except BaseException as error:
                self.condition.errors.append('invocation fixture failed: '+type(error).__name__)
                raise
        monkeypatch.setattr(service,'_invoke',invoke)


class Cursor:
    def __init__(self,rows):self.rows=rows;self.closed=False
    def fetchmany(self,limit):return self.rows[:limit]
    def fetchall(self):return self.rows
    def fetchone(self):return self.rows[0] if self.rows else None
    def close(self):self.closed=True


class MissingTable(RuntimeError):
    sqlstate='42P01'


class Pool:
    def __init__(self,monkeypatch,worker=None):
        self.worker=worker;self.schema=set(TABLES);self.guard=True
        self.rows={1:{'expired':False,'completed':False},2:{'expired':True,'completed':False}}
        self.chunks={1:b'synthetic-one',2:b'synthetic-two'}
        self.facts={'observations':('heard',),'ratings':(4,), 'jobs':('unfinished',),
                    'receipts':('confirmed',),'checkpoints':(2,)}
        self.calls=[];self.sql=[];self.cursors=[];self.errors=[]
        self.commits=0;self.rollbacks=0;self.failure=None;self.after=None
        monkeypatch.setattr(postgres_connections,'pooled_connection',self.acquire)
    def hook(self,phase):
        if self.worker is not None and self.worker.condition.locked:
            self.errors.append('condition lock held during '+phase)
        if self.after is not None:
            try:self.after(phase)
            except BaseException as error:
                self.errors.append('pool phase callback failed: '+type(error).__name__)
                raise
        if self.failure and self.failure[0]==phase:raise self.failure[1]
    @contextmanager
    def acquire(self,url,**kwargs):
        self.calls.append(dict(kwargs))
        if url!='synthetic:no-network':
            self.errors.append('unexpected pool URL')
            raise AssertionError(self.errors[-1])
        self.hook('acquire')
        before=deepcopy((self.rows,self.chunks,self.facts))
        try:
            yield self
        except BaseException:
            self.rows,self.chunks,self.facts=before;self.rollbacks+=1
            raise
        else:self.commits+=1
    def execute(self,sql,params=()):
        normalized=' '.join(sql.lower().split());self.sql.append(normalized)
        rows=[]
        if normalized.startswith('set local '):
            if normalized not in ("set local lock_timeout = '250ms'","set local statement_timeout = '1000ms'"):
                self.errors.append('unexpected SQL budget '+normalized)
        elif 'to_regclass(' in normalized:
            # Named result columns are obtained from the actual SQL, not a
            # future production constant/import. Only the three raw tables are
            # allowed in this single optional-schema probe.
            matches=re.findall(r"to_regclass\(\s*(?:'([^']+)'|(%s))\s*\)\s+(?:as\s+)?([a-z_][a-z_0-9]*)",normalized)
            arguments=iter(params)
            pairs=[(next(arguments) if placeholder else table,alias) for table,placeholder,alias in matches]
            if len(pairs)!=3 or len({alias for table,alias in pairs})!=3 or {table for table,alias in pairs}!=TABLES:
                self.errors.append('unsupported raw-table catalog probe')
                raise AssertionError(self.errors[-1])
            rows=[{alias:table if table in self.schema else None for table,alias in pairs}]
            self.hook('probe')
        elif normalized.startswith('select id from integration.foobar_temporary_source_guard_v1'):
            if 'integration.foobar_temporary_source_guard_v1' not in self.schema:raise MissingTable('synthetic missing table')
            if 'for update' not in normalized:self.errors.append('missing existing guard lock')
            rows=[{'id':1}] if self.guard else []
            self.hook('guard')
        elif normalized.startswith('delete from integration.foobar_temporary_sources_v1 '):
            if not TABLES<=self.schema:raise MissingTable('synthetic missing table')
            if 'limit 1' not in normalized:self.errors.append('unbounded raw parent delete')
            eligible=[key for key,value in self.rows.items()
                if 'expires_at<=' not in normalized and 'expires_at <=' not in normalized
                or value['expired'] or value['completed']]
            if eligible:
                key=min(eligible);self.rows.pop(key);self.chunks.pop(key)
            self.hook('delete')
        else:
            self.errors.append('unexpected SQL or non-raw write '+normalized)
            raise AssertionError(self.errors[-1])
        cursor=Cursor(rows);self.cursors.append(cursor);return cursor
    def check(self):
        assert not self.errors,self.errors
        assert all(cursor.closed for cursor in self.cursors)
    def probes(self):return [sql for sql in self.sql if 'to_regclass(' in sql]
    def deletes(self):return [sql for sql in self.sql if sql.startswith('delete ')]
