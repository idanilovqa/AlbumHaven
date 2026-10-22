"""Actual transactions; final-clock return seam is explicitly boundary-only."""
from contextlib import contextmanager
from datetime import timedelta
import psycopg
import pytest
from tests.py.test_album_top_acquired_artist_preview_postgres import preview_case,preparations,db,urls,setup,acquire,expected
from tests.py.test_owned_album_tops_postgres import assert_error


@contextmanager
def intercept(case,*,before=None,read=None):
    connect=case.db.service._connect
    class Cursor:
        def __init__(self,real,sql):self.real,self.sql=real,sql
        def fetchone(self):
            row=self.real.fetchone()
            return read(self.sql,row) if read else row
        def __getattr__(self,name):return getattr(self.real,name)
    class Connection:
        def __init__(self,real):self.real=real
        def execute(self,sql,params=None):
            text=' '.join(sql.lower().split())
            if before:before(text,self.real)
            return Cursor(self.real.execute(sql,params),text)
        def __getattr__(self,name):return getattr(self.real,name)
    @contextmanager
    def wrapped(*args,**kwargs):
        with connect(*args,**kwargs) as connection:yield Connection(connection)
    case.db.service._connect=wrapped
    try:yield
    finally:case.db.service._connect=connect


@pytest.mark.parametrize('replay',[False,True])
def test_artist_nowait_conflict_is_savepoint_null_and_same_key_replay_recovers(preview_case,replay):
    case=preview_case;command,scope=setup(case)
    if replay:acquire(case,command,scope)
    with case.db.connect() as blocker:
        blocker.execute('select id from library.local_artists where id=%s for update',(case.db.scope_artists[0],)).fetchone()
        result=acquire(case,command,scope)
        assert result['state']=='pending' and result['artist_scope_preview'] is None
        assert len(case.rows())==1 and len(case.calls)==1
    recovered=acquire(case,command,scope)
    assert recovered['artist_scope_preview']==expected(scope,recovered,True)
    assert recovered['acquisition_ref']==result['acquisition_ref'] and recovered['expires_at']==result['expires_at']
    assert len(case.calls)==1


@pytest.mark.parametrize('replay',[False,True])
def test_unrelated_sql_error_inside_artist_block_is_not_optional(preview_case,replay):
    case=preview_case;command,scope=setup(case)
    if replay:acquire(case,command,scope)
    injected=[]
    def before(sql,connection):
        if 'library.local_artists' in sql and 'for share nowait' in sql:
            injected.append(True);connection.execute('select 1/0').fetchone()
    with intercept(case,before=before):
        with pytest.raises(psycopg.errors.DivisionByZero):acquire(case,command,scope)
    assert injected==[True] and len(case.rows())==(1 if replay else 0) and len(case.calls)==1


@pytest.mark.parametrize('replay',[False,True])
def test_successful_artist_locks_survive_savepoint_until_outer_commit(preview_case,replay):
    case=preview_case;command,scope=setup(case)
    if replay:acquire(case,command,scope)
    locked=[];probed=[]
    def before(sql,connection):
        if 'library.local_artists' in sql and 'for share nowait' in sql:locked.append(True)
        if locked and sql.startswith('select clock_timestamp()'):
            with case.db.connect() as other:
                with pytest.raises(psycopg.errors.LockNotAvailable):
                    other.execute('select id from library.local_artists where id=%s for update nowait',(case.db.scope_artists[0],)).fetchone()
                other.rollback()
            probed.append(True)
    with intercept(case,before=before):result=acquire(case,command,scope)
    assert result['artist_scope_preview']==expected(scope,result,True) and probed
    with case.db.connect() as other:
        assert other.execute('select id from library.local_artists where id=%s for update nowait',(case.db.scope_artists[0],)).fetchone()


@pytest.mark.parametrize('replay,deadline',[(False,'lease_until'),(False,'accepts_until'),
    (False,'expires_at'),(False,'fully_expires_at'),(True,'expires_at'),(True,'fully_expires_at')])
def test_final_sql_clock_rejects_exact_original_deadline_without_committing_completion(preview_case,replay,deadline):
    # Only the final SQL clock return is advanced. Actual snapshot/deadline facts,
    # SQL owner transitions and rollback are unchanged; no timestamp row rewrite.
    case=preview_case;command,scope=setup(case)
    if replay:acquire(case,command,scope)
    snapshots=[];locked=[];samples=[]
    def before(sql,connection):
        if 'library.local_artists' in sql and 'for share nowait' in sql:locked.append(True)
    def read(sql,row):
        if sql.startswith('select app.reserve_top_remote_attempt(') or sql.startswith('select app.finish_top_remote_attempt('):
            snapshots.append(row['snapshot'])
        if locked and sql.startswith('select clock_timestamp()'):
            assert snapshots
            source=snapshots[0] if deadline in ('lease_until','accepts_until') else snapshots[-1]
            value=source['facts']['expires_at'] if deadline=='expires_at' else source[deadline]
            samples.append(value);return {**row,'checked_at':value}
        return row
    with intercept(case,before=before,read=read):
        assert_error(lambda:acquire(case,command,scope),'remote_preparation_unavailable',409)
    assert samples and len(case.rows())==(1 if replay else 0) and len(case.calls)==1


@pytest.mark.parametrize('elapsed',['lease_until','accepts_until'])
def test_pending_replay_does_not_reapply_fresh_only_deadlines(preview_case,elapsed):
    case=preview_case;command,scope=setup(case);first=acquire(case,command,scope)
    snapshots=[];locked=[];samples=[]
    def before(sql,connection):
        if 'library.local_artists' in sql and 'for share nowait' in sql:locked.append(True)
    def read(sql,row):
        if sql.startswith('select app.reserve_top_remote_attempt('):snapshots.append(row['snapshot'])
        if locked and sql.startswith('select clock_timestamp()'):
            from datetime import datetime
            value=datetime.fromisoformat(snapshots[-1][elapsed])+timedelta(microseconds=1)
            assert value<datetime.fromisoformat(snapshots[-1]['facts']['expires_at'])
            samples.append(True);return {**row,'checked_at':value.isoformat()}
        return row
    with intercept(case,before=before,read=read):result=acquire(case,command,scope)
    assert samples and result==first and len(case.calls)==1


@pytest.mark.parametrize('replay',[False,True])
def test_session_expiry_after_artist_capture_remains_fatal(preview_case,replay):
    case=preview_case;command,scope=setup(case)
    if replay:acquire(case,command,scope)
    observed=[];old=case.db.service._clock
    case.db.service._clock=lambda:old()+(timedelta(days=2) if observed else timedelta())
    def before(sql,connection):
        if 'library.local_artists' in sql and 'for share nowait' in sql:
            observed.append(True)
    try:
        with intercept(case,before=before):assert_error(lambda:acquire(case,command,scope),'forbidden',403)
    finally:case.db.service._clock=old
    assert observed and len(case.rows())==(1 if replay else 0)
