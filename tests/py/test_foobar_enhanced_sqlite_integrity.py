"""Authored-only controlled SQLite driver tests; never opened a database here."""
import inspect
import sqlite3
import pytest
from music_app.services import foobar_enhanced_sqlite_reader as reader

class Cursor:
    def __init__(self,rows): self.rows=iter(rows); self.closed=False; self.fetches=0
    def fetchone(self): self.fetches+=1; return next(self.rows,None)
    def close(self): self.closed=True

class Connection:
    def __init__(self,rows): self.cursor=Cursor(rows); self.sql=[]
    def execute(self,sql): self.sql.append(sql); return self.cursor

@pytest.mark.parametrize('rows',[[('ok',)],[],[('bad secret path',)],[('ok',),('ok',)], [('OK',)], [('ok','extra')]])
def test_fixed_whole_main_integrity_requires_single_exact_success(rows):
    db=Connection(rows); budget=reader._Budget(None)
    if rows==[('ok',)]: reader._validate_integrity(db,budget)
    else:
        with pytest.raises(reader._Stopped) as error: reader._validate_integrity(db,budget)
        assert str(error.value)=='database_integrity_failed' and 'secret' not in str(error.value)
    assert db.sql==['PRAGMA main.integrity_check(1)'] and db.cursor.closed
    assert db.cursor.fetches<=2

@pytest.mark.parametrize('name,arg,database,source,allowed',[
    ('integrity_check','1','main',None,True),('integrity_check','2','main',None,False),
    ('integrity_check','1','temp',None,False),('integrity_check',None,'main',None,False),
    ('integrity_check','1','main','view',False),('quick_check','1','main',None,False)])
def test_authorizer_addition_is_exact_not_general_pragma_permission(name,arg,database,source,allowed):
    value=reader._authorizer(sqlite3.SQLITE_PRAGMA,name,arg,database,source)
    assert value==(sqlite3.SQLITE_OK if allowed else sqlite3.SQLITE_DENY)

def test_cancellation_closes_integrity_cursor_and_no_record_can_precede_check():
    calls=[0]
    def cancel(): calls[0]+=1; return calls[0]>1
    db=Connection([('ok',)])
    with pytest.raises(reader._Stopped): reader._validate_integrity(db,reader._Budget(cancel))
    assert db.cursor.closed
    source=inspect.getsource(reader._scan)
    assert source.index('_validate_integrity(connection, budget)')<source.index('yield')
    assert 'setlimit(sqlite3.SQLITE_LIMIT_LENGTH' in source
